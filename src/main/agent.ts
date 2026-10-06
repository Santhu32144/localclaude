// Runs Claude Code sessions through the Agent SDK and translates its message
// stream into UI events. One long-lived streaming query per open chat.
import { query, type Options, type PermissionResult, type Query, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { randomUUID } from 'node:crypto'
import { applyEvent, toolResultToText } from '../shared/reducer'
import type {
  AgentEvent,
  AppSettings,
  ChatMessage,
  ContentPart,
  DiffHunk,
  McpStatus,
  MemoryItem,
  Project,
  PermissionDecision,
  PermissionModeUI,
  RewindPreview,
  RewindRequest,
  SendPayload,
  SessionMeta
} from '../shared/types'
import { resolveClaudeBinary, subscriptionEnv } from './claude'
import { ARTIFACT_TOOLS, createArtifactServer } from './artifacts'
import { createComputerServer } from './computer'
import { importedContext } from './exporter'
import { PROJECT_KNOWLEDGE_LIMIT_CHARS } from './limits'
import { MEMORY_TOOLS, createMemoryServer, memoryPrompt } from './memory'
import type { SecureStore } from './store'

/** forkAt value for a chat's first message: rewinding there starts a fresh transcript. */
const FORK_START = 'start'

/** Push-based async iterable used as the streaming prompt for query(). */
class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = []
  private waiters: ((r: IteratorResult<T>) => void)[] = []
  private closed = false
  push(item: T): void {
    const w = this.waiters.shift()
    if (w) w({ value: item, done: false })
    else this.items.push(item)
  }
  close(): void {
    this.closed = true
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true })
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift() as T, done: false })
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((r) => this.waiters.push(r))
      }
    }
  }
}

interface PendingPermission {
  resolve: (r: PermissionResult) => void
  toolName: string
  input: Record<string, unknown>
  suggestions?: unknown[]
}

type Emit = (e: AgentEvent) => void

class AgentSession {
  history: ChatMessage[]
  private q?: Query
  private queue?: AsyncQueue<SDKUserMessage>
  private abort?: AbortController
  running = false
  private interrupted = false
  private startedWithBypass = false
  private restartAfterTurn = false
  /** scope (parent tool id or 'main') -> streaming chat message id */
  private streaming = new Map<string, string>()
  private pending = new Map<string, PendingPermission>()
  private saveTimer?: NodeJS.Timeout
  /** UUID of the latest top-level transcript entry seen in this turn */
  private lastEntry?: string
  /** whether this turn showed anything (assistant text, tools or command output) */
  private turnHadOutput = false

  constructor(
    public meta: SessionMeta,
    private store: SecureStore,
    private emitRaw: Emit,
    private settings: () => AppSettings,
    private onModels: (models: { value: string; displayName: string; description: string }[]) => void
  ) {
    this.history = store.loadHistory(meta.id)
  }

  private emit(e: AgentEvent): void {
    this.history = applyEvent(this.history, e)
    this.emitRaw(e)
    if (e.type === 'turn-done' || e.type === 'message-final' || e.type === 'message-start' || e.type === 'error') this.scheduleSave()
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.store.saveHistory(this.meta.id, this.history), 400)
  }

  private touchMeta(patch: Partial<SessionMeta>): void {
    this.meta = { ...this.meta, ...patch, updatedAt: Date.now() }
    this.store.upsertSession(this.meta)
    this.emitRaw({ type: 'meta', meta: this.meta })
  }

  private setStatus(status: 'idle' | 'running' | 'starting'): void {
    this.running = status !== 'idle'
    this.emitRaw({ type: 'status', sessionId: this.meta.id, status })
  }

  // ---------------------------------------------------------------- lifecycle
  private buildOptions(): Options {
    const s = this.settings()
    const sources: ('user' | 'project' | 'local')[] = []
    if (s.loadUserSettings) sources.push('user')
    if (s.loadProjectSettings) sources.push('project', 'local')

    const mcpServers: Options['mcpServers'] = {}
    for (const [name, cfg] of Object.entries(s.mcpServers)) {
      if (cfg.enabled === false) continue
      if (cfg.type === 'http' || cfg.type === 'sse') {
        mcpServers[name] = { type: cfg.type, url: cfg.url ?? '', headers: cfg.headers }
      } else if (cfg.command) {
        mcpServers[name] = { type: 'stdio', command: cfg.command, args: cfg.args ?? [], env: cfg.env }
      }
    }
    // A fresh in-process server per query: an MCP server instance serves one connection.
    if (s.computerUse) mcpServers['computer-use'] = createComputerServer()
    const project = this.meta.projectId ? this.store.getProject(this.meta.projectId) : undefined
    if (s.artifacts)
      mcpServers['artifacts'] = createArtifactServer({
        sessionId: this.meta.id,
        store: this.store,
        onChange: (artifact, count) => {
          this.emitRaw({ type: 'artifact', sessionId: this.meta.id, artifact })
          if (count !== this.meta.artifactCount) this.touchMeta({ artifactCount: count })
        }
      })
    if (s.memory)
      mcpServers['memory'] = createMemoryServer({
        store: this.store,
        sessionId: this.meta.id,
        projectId: project?.id,
        onChange: (projectId) => {
          const p = projectId ? this.store.getProject(projectId) : undefined
          if (p) this.emitRaw({ type: 'project', project: p })
          else this.emitRaw({ type: 'global-memory', items: this.store.getGlobalMemory() })
        }
      })
    // Artifacts and memory only write to LocalClaude's own storage, so they never need a prompt.
    const autoAllowed = [...(s.artifacts ? ARTIFACT_TOOLS : []), ...(s.memory ? MEMORY_TOOLS : [])]

    this.abort = new AbortController()
    this.startedWithBypass = this.meta.permissionMode === 'bypassPermissions'
    return {
      cwd: this.meta.cwd,
      additionalDirectories: this.meta.additionalDirs,
      model: this.meta.model || s.defaultModel || undefined,
      permissionMode: this.meta.permissionMode,
      // Only passed when you pick "Full access" (Claude Code refuses this flag when running as root).
      allowDangerouslySkipPermissions: this.meta.permissionMode === 'bypassPermissions' || undefined,
      includePartialMessages: true,
      forwardSubagentText: true,
      canUseTool: (toolName, input, opts) => this.canUseTool(toolName, input, opts),
      env: subscriptionEnv(),
      pathToClaudeCodeExecutable: resolveClaudeBinary(),
      settingSources: sources,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: systemAppend(s.appendSystemPrompt, project, this.store, s.memory ? { global: this.store.getGlobalMemory() } : null)
      },
      allowedTools: autoAllowed.length ? autoAllowed : undefined,
      // LocalClaude keeps memory and artifacts itself, encrypted on this machine. Claude Code's own
      // auto-memory files and its Artifact tool (which publishes pages to claude.ai) stay off here.
      settings: { autoMemoryEnabled: false, enableArtifact: false },
      mcpServers,
      extraArgs: s.chromeIntegration ? { chrome: null } : undefined,
      effort: s.effort || undefined,
      resume: this.meta.sdkSessionId,
      resumeSessionAt: this.meta.sdkSessionId ? this.meta.resumeAt : undefined,
      // Back up files before Claude edits them so any user message can be rewound to.
      enableFileCheckpointing: true,
      abortController: this.abort,
      stderr: (d) => {
        if (process.env.LOCALCLAUDE_DEBUG) console.error('[claude]', d)
      }
    }
  }

  /** Start the Claude Code process. `quiet` starts it for a control request (rewind) without showing "Starting…". */
  private ensureStarted(quiet = false): void {
    if (this.q) return
    this.queue = new AsyncQueue<SDKUserMessage>()
    this.streaming.clear()
    if (!quiet) this.setStatus('starting')
    const q = query({ prompt: this.queue, options: this.buildOptions() })
    this.q = q
    void this.consume(q)
  }

  private async consume(q: Query): Promise<void> {
    try {
      for await (const msg of q) this.handle(msg)
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      if (!/abort/i.test(text)) this.emit({ type: 'error', sessionId: this.meta.id, text: friendlyError(text) })
    } finally {
      if (this.q === q) {
        this.q = undefined
        this.queue = undefined
        this.cancelAllPermissions()
        if (this.running) this.emit({ type: 'turn-done', sessionId: this.meta.id, stats: zeroStats(), isError: false })
        this.setStatus('idle')
      }
    }
  }

  /** Write any history still waiting for its debounced save. */
  flush(): void {
    if (!this.saveTimer) return
    clearTimeout(this.saveTimer)
    this.saveTimer = undefined
    this.store.saveHistory(this.meta.id, this.history)
  }

  /** Stop the Claude Code process for this chat (it resumes on the next message). */
  shutdown(): void {
    this.queue?.close()
    this.abort?.abort()
    this.q = undefined
    this.queue = undefined
    this.cancelAllPermissions()
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.store.saveHistory(this.meta.id, this.history)
    }
  }

  // ---------------------------------------------------------------- input
  send(p: SendPayload): void {
    const content: SDKUserMessage['message']['content'] = []
    for (const a of p.attachments) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: a.mediaType as 'image/png', data: a.base64 }
      })
    }
    if (p.text.trim()) content.push({ type: 'text', text: p.text })
    if (!content.length) return
    // A chat restored from an export has no Claude Code transcript here: send the earlier messages as context once.
    if (this.meta.imported && !this.meta.sdkSessionId && this.history.length) content.unshift({ type: 'text', text: importedContext(this.meta, this.history) })

    const uuid = randomUUID()
    const userMsg: ChatMessage = {
      id: 'u-' + uuid,
      role: 'user',
      parts: [{ kind: 'text', text: p.text }],
      images: p.attachments.length || undefined,
      ts: Date.now(),
      uuid,
      // Unknown for chats that predate rewind support: conversation rewind is then unavailable for this message.
      forkAt: this.meta.tip ?? (this.meta.sdkSessionId ? undefined : FORK_START)
    }
    this.emit({ type: 'message-start', sessionId: this.meta.id, message: userMsg })
    if (this.meta.title === 'New chat' && p.text.trim()) {
      this.touchMeta({ title: p.text.trim().replace(/\s+/g, ' ').slice(0, 60) })
    } else this.touchMeta({})

    this.ensureStarted()
    this.setStatus('running')
    this.queue!.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, uuid: uuid as `${string}-${string}-${string}-${string}-${string}` })
  }

  async interrupt(): Promise<void> {
    if (!this.running) return
    this.interrupted = true
    this.cancelAllPermissions()
    try {
      await this.q?.interrupt()
    } catch {
      /* ignore */
    }
  }

  async setPermissionMode(mode: PermissionModeUI): Promise<void> {
    this.touchMeta({ permissionMode: mode })
    if (this.q && (mode === 'bypassPermissions') !== this.startedWithBypass) {
      // Full access is a start-up flag: restart the Claude Code process (the chat resumes).
      if (this.running) this.restartAfterTurn = true
      else this.shutdown()
      return
    }
    try {
      await this.q?.setPermissionMode(mode)
    } catch {
      /* applied on next start */
    }
  }

  async setModel(model: string): Promise<void> {
    this.touchMeta({ model })
    try {
      await this.q?.setModel(model || undefined)
    } catch {
      /* applied on next start */
    }
  }

  setAdditionalDirs(dirs: string[]): void {
    this.touchMeta({ additionalDirs: dirs })
    // Directories are a start-up option: restart; the conversation resumes on next send.
    if (this.q && !this.running) this.shutdown()
  }

  /** Restart so changed settings (MCP servers, Chrome, effort…) apply. */
  restartIfIdle(): void {
    if (this.q && !this.running) this.shutdown()
  }

  // ---------------------------------------------------------------- context, commands, MCP
  private refreshContext(): void {
    this.q
      ?.getContextUsage()
      .then((u) =>
        this.emitRaw({
          type: 'context',
          sessionId: this.meta.id,
          usage: {
            percentage: u.percentage,
            totalTokens: u.totalTokens,
            maxTokens: u.maxTokens,
            categories: u.categories.map((c) => ({ name: c.name, tokens: c.tokens, color: c.color, kind: c.kind }))
          }
        })
      )
      .catch(() => {})
  }

  private refreshCommands(): void {
    this.q
      ?.supportedCommands()
      .then((cmds) => this.emitCommands(cmds))
      .catch(() => {})
  }

  private emitCommands(cmds: { name: string; description: string; argumentHint: string }[]): void {
    this.emitRaw({
      type: 'commands',
      sessionId: this.meta.id,
      commands: cmds.map((c) => ({ name: c.name, description: c.description ?? '', argumentHint: c.argumentHint ?? '' }))
    })
  }

  refreshMcp(): void {
    this.q
      ?.mcpServerStatus()
      .then((list) =>
        this.emitRaw({
          type: 'mcp-status',
          sessionId: this.meta.id,
          servers: list.map(
            (m): McpStatus => ({
              name: m.name,
              status: m.status,
              error: m.error,
              toolCount: (m as { tools?: unknown[] }).tools?.length
            })
          )
        })
      )
      .catch(() => {})
  }

  async toggleMcp(name: string, enabled: boolean): Promise<void> {
    await this.q?.toggleMcpServer(name, enabled)
    this.refreshMcp()
  }

  async reconnectMcp(name: string): Promise<void> {
    try {
      await this.q?.reconnectMcpServer(name)
    } finally {
      this.refreshMcp()
    }
  }

  // ---------------------------------------------------------------- rewind
  private userMessage(messageId: string): { idx: number; msg: ChatMessage } | undefined {
    const idx = this.history.findIndex((m) => m.id === messageId && m.role === 'user')
    return idx >= 0 ? { idx, msg: this.history[idx] } : undefined
  }

  /** What restoring files to before this message would change (nothing is modified). */
  async rewindPreview(messageId: string): Promise<RewindPreview> {
    const found = this.userMessage(messageId)
    if (!found?.msg.uuid) return { canRewind: false, error: 'This message was sent before checkpoints were turned on.' }
    if (this.running) return { canRewind: false, error: 'Wait for Claude to finish, or stop it first.' }
    try {
      this.ensureStarted(true)
      const r = await this.q!.rewindFiles(found.msg.uuid, { dryRun: true })
      return { canRewind: r.canRewind, error: r.error, filesChanged: r.filesChanged, insertions: r.insertions, deletions: r.deletions }
    } catch (e) {
      return { canRewind: false, error: e instanceof Error ? e.message : String(e) }
    }
  }

  /**
   * Rewind to just before a user message: restore files Claude changed since then,
   * drop the conversation from that message on, or both. Returns the message text
   * so the composer can offer it again, like Claude Code's /rewind.
   */
  async rewind(req: RewindRequest): Promise<{ ok: boolean; error?: string; text?: string; filesChanged?: number }> {
    const found = this.userMessage(req.messageId)
    if (!found) return { ok: false, error: 'Message not found.' }
    if (this.running) return { ok: false, error: 'Wait for Claude to finish, or stop it first.' }
    const { idx, msg } = found
    const text = msg.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('')
    let filesChanged: number | undefined

    if (req.code) {
      if (!msg.uuid) return { ok: false, error: 'This message was sent before checkpoints were turned on.' }
      try {
        this.ensureStarted(true)
        // A real rewind doesn't list the files it restored, so count them with a dry run first.
        const preview = await this.q!.rewindFiles(msg.uuid, { dryRun: true })
        const r = await this.q!.rewindFiles(msg.uuid)
        if (!r.canRewind) return { ok: false, error: r.error ?? 'There are no file changes to restore.' }
        filesChanged = r.filesChanged?.length || preview.filesChanged?.length || 0
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    }

    if (req.conversation) {
      if (!msg.forkAt) return { ok: false, error: 'This chat started before conversation rewind was available, so only code can be restored.' }
      this.shutdown()
      this.history = this.history.slice(0, idx)
      this.store.saveHistory(this.meta.id, this.history)
      if (msg.forkAt === FORK_START) this.touchMeta({ sdkSessionId: undefined, resumeAt: undefined, tip: undefined })
      else this.touchMeta({ resumeAt: msg.forkAt, tip: msg.forkAt })
      this.emitRaw({ type: 'history-reset', sessionId: this.meta.id, history: this.history })
    } else if (req.code) {
      this.emit({
        type: 'message-start',
        sessionId: this.meta.id,
        message: {
          id: 'sys-' + randomUUID(),
          role: 'system',
          parts: [{ kind: 'text', text: `Restored ${filesChanged} file${filesChanged === 1 ? '' : 's'} to before "${text.trim().slice(0, 60)}"` }],
          ts: Date.now()
        }
      })
      this.scheduleSave()
    }
    return { ok: true, text, filesChanged }
  }

  // ---------------------------------------------------------------- permissions
  private canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    opts: { signal: AbortSignal; suggestions?: unknown[]; title?: string; displayName?: string; decisionReason?: string; blockedPath?: string }
  ): Promise<PermissionResult> {
    const requestId = randomUUID()
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(requestId, { resolve, toolName, input, suggestions: opts.suggestions })
      opts.signal.addEventListener('abort', () => {
        if (this.pending.delete(requestId)) {
          this.emitRaw({ type: 'permission-cancel', requestId })
          resolve({ behavior: 'deny', message: 'Cancelled' })
        }
      })
      this.emitRaw({
        type: 'permission',
        request: {
          requestId,
          sessionId: this.meta.id,
          toolName,
          input,
          title: opts.title,
          displayName: opts.displayName,
          decisionReason: opts.decisionReason,
          blockedPath: opts.blockedPath,
          hasSuggestions: !!opts.suggestions?.length
        }
      })
    })
  }

  respondPermission(requestId: string, d: PermissionDecision & { switchMode?: PermissionModeUI }): void {
    const p = this.pending.get(requestId)
    if (!p) return
    this.pending.delete(requestId)
    if (d.behavior === 'allow') {
      const res: PermissionResult = { behavior: 'allow', updatedInput: d.updatedInput ?? p.input }
      if (d.always && p.suggestions?.length) res.updatedPermissions = p.suggestions as never
      p.resolve(res)
      if (d.switchMode) void this.setPermissionMode(d.switchMode)
    } else {
      p.resolve({ behavior: 'deny', message: d.message?.trim() || 'The user denied this action.' })
    }
  }

  private cancelAllPermissions(): void {
    for (const [id, p] of this.pending) {
      p.resolve({ behavior: 'deny', message: 'Cancelled', interrupt: true })
      this.emitRaw({ type: 'permission-cancel', requestId: id })
    }
    this.pending.clear()
  }

  // ---------------------------------------------------------------- SDK stream → UI events
  private handle(msg: SDKMessage): void {
    const sid = this.meta.id
    switch (msg.type) {
      case 'system': {
        if (msg.subtype === 'init') {
          if (msg.session_id && msg.session_id !== this.meta.sdkSessionId) {
            this.touchMeta({ sdkSessionId: msg.session_id })
            this.emitRaw({ type: 'sdk-session', sessionId: sid, sdkSessionId: msg.session_id })
          }
          // A pending conversation rewind is applied by this start; later starts resume normally.
          if (this.meta.resumeAt) this.touchMeta({ resumeAt: undefined })
          // An imported chat now has its own transcript, which includes the context we sent.
          if (this.meta.imported) this.touchMeta({ imported: undefined })
          this.emitRaw({
            type: 'init',
            sessionId: sid,
            info: {
              model: msg.model,
              cwd: msg.cwd,
              tools: msg.tools,
              slashCommands: msg.slash_commands,
              skills: msg.skills ?? [],
              mcpServers: msg.mcp_servers.map((m) => ({ name: m.name, status: m.status })),
              apiKeySource: String(msg.apiKeySource),
              claudeCodeVersion: msg.claude_code_version,
              permissionMode: msg.permissionMode
            }
          })
          if (this.running) this.setStatus('running')
          this.q
            ?.accountInfo()
            .then((a) => this.emitRaw({ type: 'account', email: a.email, subscriptionType: a.subscriptionType }))
            .catch(() => {})
          this.q
            ?.supportedModels()
            .then((m) => this.onModels(m.map((x) => ({ value: x.value, displayName: x.displayName, description: x.description }))))
            .catch(() => {})
          this.refreshCommands()
          this.refreshMcp()
          this.refreshContext()
        } else if (msg.subtype === 'commands_changed') {
          this.emitCommands(msg.commands)
        } else if (msg.subtype === 'local_command_output') {
          // Output of built-in slash commands such as /model, /usage, /context
          this.turnHadOutput = true
          this.emit({
            type: 'message-start',
            sessionId: sid,
            message: { id: 'cmd-' + (msg.uuid ?? randomUUID()), role: 'assistant', parts: [{ kind: 'text', text: msg.content }], ts: Date.now() }
          })
        } else if (msg.subtype === 'compact_boundary') {
          this.emit({
            type: 'message-start',
            sessionId: sid,
            message: { id: 'sys-' + randomUUID(), role: 'system', parts: [{ kind: 'text', text: 'Conversation compacted to save context.' }], ts: Date.now() }
          })
        }
        return
      }

      case 'stream_event': {
        const scope = msg.parent_tool_use_id ?? 'main'
        const ev = msg.event as { type: string; index?: number; message?: { id: string }; content_block?: Record<string, unknown>; delta?: Record<string, unknown> }
        if (ev.type === 'message_start' && ev.message) {
          const id = 'a-' + ev.message.id
          this.streaming.set(scope, id)
          this.emit({
            type: 'message-start',
            sessionId: sid,
            message: { id, role: 'assistant', parts: [], parentToolUseId: msg.parent_tool_use_id, ts: Date.now() }
          })
          return
        }
        const messageId = this.streaming.get(scope)
        if (!messageId || ev.index === undefined) return
        if (ev.type === 'content_block_start' && ev.content_block) {
          const b = ev.content_block
          if (b.type === 'tool_use' || b.type === 'server_tool_use' || b.type === 'mcp_tool_use') {
            this.emit({ type: 'tool-start', sessionId: sid, messageId, partIndex: ev.index, toolUseId: String(b.id), name: String(b.name) })
          } else if (b.type === 'thinking') {
            this.emit({ type: 'thinking-delta', sessionId: sid, messageId, partIndex: ev.index, text: '' })
          } else if (b.type === 'text') {
            this.emit({ type: 'text-delta', sessionId: sid, messageId, partIndex: ev.index, text: '' })
          }
        } else if (ev.type === 'content_block_delta' && ev.delta) {
          const d = ev.delta
          if (d.type === 'text_delta') this.emit({ type: 'text-delta', sessionId: sid, messageId, partIndex: ev.index, text: String(d.text) })
          else if (d.type === 'thinking_delta')
            this.emit({ type: 'thinking-delta', sessionId: sid, messageId, partIndex: ev.index, text: String(d.thinking) })
          else if (d.type === 'input_json_delta')
            this.emit({ type: 'tool-input-delta', sessionId: sid, messageId, partIndex: ev.index, json: String(d.partial_json) })
        }
        return
      }

      case 'assistant': {
        if (!msg.parent_tool_use_id && msg.uuid) this.lastEntry = msg.uuid
        this.turnHadOutput = true
        const apiId = (msg.message as { id?: string }).id
        const id = apiId ? 'a-' + apiId : 'a-' + randomUUID()
        const existing = this.history.find((m) => m.id === id)
        const parts: ContentPart[] = existing ? existing.parts.filter((p) => !(p.kind === 'text' && !p.text)) : []
        for (const b of (msg.message.content ?? []) as unknown as Record<string, unknown>[]) {
          if (b.type === 'text') {
            const t = String(b.text ?? '')
            if (t && !parts.some((p) => p.kind === 'text' && (p.text === t || p.text.startsWith(t) || t.startsWith(p.text)))) parts.push({ kind: 'text', text: t })
            else {
              // replace streamed text with the final authoritative text
              const i = parts.findIndex((p) => p.kind === 'text' && (t.startsWith(p.text) || p.text.startsWith(t)))
              if (i >= 0) parts[i] = { kind: 'text', text: t.length >= (parts[i] as { text: string }).text.length ? t : (parts[i] as { text: string }).text }
            }
          } else if (b.type === 'thinking') {
            const t = String(b.thinking ?? '')
            const i = parts.findIndex((p) => p.kind === 'thinking')
            if (i >= 0) {
              if (t.length > (parts[i] as { text: string }).text.length) parts[i] = { kind: 'thinking', text: t }
            } else if (t) parts.push({ kind: 'thinking', text: t })
          } else if (b.type === 'tool_use' || b.type === 'server_tool_use' || b.type === 'mcp_tool_use') {
            const i = parts.findIndex((p) => p.kind === 'tool' && p.toolUseId === b.id)
            const tp: ContentPart = { kind: 'tool', toolUseId: String(b.id), name: String(b.name), input: b.input ?? {}, done: false }
            if (i >= 0) parts[i] = { ...(parts[i] as object), ...tp, inputJsonPartial: undefined } as ContentPart
            else parts.push(tp)
          }
        }
        const err = (msg as { error?: string }).error
        this.emit({
          type: 'message-final',
          sessionId: sid,
          message: { id, role: 'assistant', parts, parentToolUseId: msg.parent_tool_use_id, ts: existing?.ts ?? Date.now() }
        })
        if (err) this.emit({ type: 'error', sessionId: sid, text: friendlyError(err) })
        return
      }

      case 'user': {
        const uuid = (msg as { uuid?: string }).uuid
        if (!msg.parent_tool_use_id && uuid && !(msg as { isReplay?: boolean }).isReplay) this.lastEntry = uuid
        const content = msg.message.content
        if (!Array.isArray(content)) return
        const patch = structuredPatch(msg.tool_use_result)
        for (const b of content as unknown as Record<string, unknown>[]) {
          if (b.type === 'tool_result') {
            this.emit({
              type: 'tool-result',
              sessionId: sid,
              toolUseId: String(b.tool_use_id),
              result: toolResultToText(b.content),
              isError: !!b.is_error,
              patch
            })
          }
        }
        return
      }

      case 'result': {
        const isError = msg.is_error || msg.subtype !== 'success'
        let errorText: string | undefined
        if (msg.subtype !== 'success') errorText = (msg as { errors?: string[] }).errors?.join('\n') || msg.subtype
        else if (msg.is_error) errorText = msg.result
        if (this.interrupted) {
          this.interrupted = false
          errorText = undefined
          this.emit({
            type: 'message-start',
            sessionId: sid,
            message: { id: 'sys-' + randomUUID(), role: 'system', parts: [{ kind: 'text', text: 'Stopped.' }], ts: Date.now() }
          })
        } else if (errorText) this.emit({ type: 'error', sessionId: sid, text: friendlyError(errorText) })
        else if (!this.turnHadOutput && msg.subtype === 'success' && msg.result?.trim()) {
          // Some slash commands answer only through the result text.
          this.emit({
            type: 'message-start',
            sessionId: sid,
            message: { id: 'res-' + randomUUID(), role: 'assistant', parts: [{ kind: 'text', text: msg.result }], ts: Date.now() }
          })
        }
        this.turnHadOutput = false
        const usage = msg.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number }
        this.emit({
          type: 'turn-done',
          sessionId: sid,
          isError,
          errorText,
          stats: {
            costUsd: msg.total_cost_usd,
            inputTokens: (usage?.input_tokens ?? 0) + (usage?.cache_read_input_tokens ?? 0) + (usage?.cache_creation_input_tokens ?? 0),
            outputTokens: usage?.output_tokens ?? 0,
            durationMs: msg.duration_ms,
            numTurns: msg.num_turns
          }
        })
        this.streaming.clear()
        this.setStatus('idle')
        this.touchMeta(this.lastEntry ? { tip: this.lastEntry } : {})
        this.refreshContext()
        this.refreshMcp()
        if (this.restartAfterTurn) {
          this.restartAfterTurn = false
          this.shutdown()
        }
        return
      }

      case 'rate_limit_event': {
        const i = msg.rate_limit_info
        this.emitRaw({
          type: 'rate-limit',
          sessionId: sid,
          info: { status: i.status, resetsAt: i.resetsAt, rateLimitType: i.rateLimitType, utilization: i.utilization }
        })
        return
      }

      default:
        return
    }
  }
}

export const PROJECT_KNOWLEDGE_LIMIT = PROJECT_KNOWLEDGE_LIMIT_CHARS

/** Personal instructions, then the project's instructions and knowledge files, then memory (when on). */
export function systemAppend(
  personal: string,
  project: Project | undefined,
  store: Pick<SecureStore, 'loadProjectFiles'>,
  memory: { global: MemoryItem[] } | null = null
): string | undefined {
  const parts: string[] = []
  if (personal?.trim()) parts.push(personal.trim())
  if (project) {
    const lines = [`<project name="${project.name}">`]
    if (project.description.trim()) lines.push(`<description>${project.description.trim()}</description>`)
    if (project.instructions.trim()) lines.push(`<instructions>\n${project.instructions.trim()}\n</instructions>`)
    if (project.files.length) {
      const contents = store.loadProjectFiles(project.id)
      let budget = PROJECT_KNOWLEDGE_LIMIT
      lines.push('<knowledge>')
      for (const f of project.files) {
        const text = contents[f.id] ?? ''
        const take = text.slice(0, Math.max(0, budget))
        budget -= take.length
        const cut = take.length < text.length ? '\n[truncated: project knowledge limit reached]' : ''
        lines.push(`<file name="${f.name}">\n${take}${cut}\n</file>`)
      }
      lines.push('</knowledge>')
    }
    lines.push('</project>')
    parts.push("This chat is part of the user's project below. Follow its instructions and use its knowledge files when relevant.\n" + lines.join('\n'))
  }
  if (memory) parts.push(memoryPrompt(memory.global, project ? { name: project.name, items: project.memory ?? [] } : undefined))
  return parts.length ? parts.join('\n\n') : undefined
}

/** The unified-diff hunks Claude Code attaches to Edit/Write results, if any. */
function structuredPatch(result: unknown): DiffHunk[] | undefined {
  const p = (result as { structuredPatch?: unknown } | undefined)?.structuredPatch
  if (!Array.isArray(p) || !p.length) return undefined
  return p.filter((h) => h && Array.isArray(h.lines)) as DiffHunk[]
}

function zeroStats() {
  return { costUsd: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, numTurns: 0 }
}

function friendlyError(text: string): string {
  if (/authentication_failed|not logged in|invalid api key|please run \/login|oauth/i.test(text)) {
    return `${text}\n\nYou're not signed in to your Claude subscription. Open Settings → Account and sign in.`
  }
  if (/cannot be used with root\/sudo/i.test(text)) {
    return `${text}\n\nFull access mode doesn't work when the app runs as root. Switch the mode to "Ask permissions" or "Auto-accept edits", or run the app as your normal user.`
  }
  if (/rate_limit|usage limit/i.test(text)) return `${text}\n\nYou've hit your plan's usage limit. It resets automatically.`
  return text
}

export class SessionManager {
  private sessions = new Map<string, AgentSession>()
  models: { value: string; displayName: string; description: string }[] = []

  constructor(
    private store: SecureStore,
    private emit: Emit
  ) {}

  private get(id: string): AgentSession {
    let s = this.sessions.get(id)
    if (!s) {
      const meta = this.store.getSession(id)
      if (!meta) throw new Error('Unknown session ' + id)
      s = new AgentSession(meta, this.store, this.emit, () => this.store.getSettings(), (m) => {
        this.models = m
        this.emit({ type: 'status', sessionId: id, status: s!.running ? 'running' : 'idle' })
      })
      this.sessions.set(id, s)
    }
    return s
  }

  create(cwd?: string, projectId?: string): SessionMeta {
    const st = this.store.getSettings()
    const project = projectId ? this.store.getProject(projectId) : undefined
    const meta: SessionMeta = {
      id: randomUUID(),
      title: 'New chat',
      projectId: project?.id,
      cwd: cwd || project?.cwd || st.defaultCwd,
      additionalDirs: [],
      model: st.defaultModel,
      permissionMode: st.defaultPermissionMode,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    this.store.upsertSession(meta)
    return meta
  }

  history(id: string): ChatMessage[] {
    return this.get(id).history
  }
  isRunning(id: string): boolean {
    return this.sessions.get(id)?.running ?? false
  }
  send(p: SendPayload): void {
    this.get(p.sessionId).send(p)
  }
  interrupt(id: string): Promise<void> {
    return this.get(id).interrupt()
  }
  respond(sessionId: string, requestId: string, d: PermissionDecision & { switchMode?: PermissionModeUI }): void {
    this.get(sessionId).respondPermission(requestId, d)
  }
  setMode(id: string, mode: PermissionModeUI): Promise<void> {
    return this.get(id).setPermissionMode(mode)
  }
  setModel(id: string, model: string): Promise<void> {
    return this.get(id).setModel(model)
  }
  setDirs(id: string, dirs: string[]): void {
    this.get(id).setAdditionalDirs(dirs)
  }
  rewindPreview(id: string, messageId: string): Promise<RewindPreview> {
    return this.get(id).rewindPreview(messageId)
  }
  rewind(id: string, req: RewindRequest): ReturnType<AgentSession['rewind']> {
    return this.get(id).rewind(req)
  }
  toggleMcp(id: string, name: string, enabled: boolean): Promise<void> {
    return this.get(id).toggleMcp(name, enabled)
  }
  reconnectMcp(id: string, name: string): Promise<void> {
    return this.get(id).reconnectMcp(name)
  }
  refreshMcp(id: string): void {
    this.sessions.get(id)?.refreshMcp()
  }
  updateMeta(id: string, patch: Partial<Pick<SessionMeta, 'title' | 'cwd' | 'pinned' | 'projectId'>>): SessionMeta {
    const s = this.get(id)
    // The working folder can only change before the first message (the transcript is tied to it).
    if (patch.cwd && s.meta.sdkSessionId) delete patch.cwd
    s.meta = { ...s.meta, ...patch }
    this.store.upsertSession(s.meta)
    // Moving a chat in or out of a project changes its instructions: restart Claude Code when idle.
    if ('projectId' in patch) s.restartIfIdle()
    return s.meta
  }
  delete(id: string): void {
    this.sessions.get(id)?.shutdown()
    this.sessions.delete(id)
    this.store.deleteSession(id)
  }
  /** Save every open chat's history now (before exporting). */
  flushAll(): void {
    for (const s of this.sessions.values()) s.flush()
  }
  restartIdle(): void {
    for (const s of this.sessions.values()) s.restartIfIdle()
  }
  shutdownAll(): void {
    for (const s of this.sessions.values()) s.shutdown()
  }
}

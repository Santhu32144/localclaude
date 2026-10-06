// A scripted stand-in for Claude Code, used only by the end-to-end tests (LOCALCLAUDE_FAKE_AGENT=1).
// It speaks the same message protocol as the Agent SDK, calls LocalClaude's in-process MCP tools
// (artifacts, memory, chat search, knowledge) for real, and asks for permissions through canUseTool.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { nativeImage } from 'electron'
import { randomUUID } from 'node:crypto'

type Msg = Record<string, unknown>
type UserMsg = { message: { content: string | { type: string; text?: string }[] }; uuid?: string }
type Options = {
  resume?: string
  model?: string
  cwd?: string
  permissionMode?: string
  mcpServers?: Record<string, { type?: string; instance?: { connect: (t: unknown) => Promise<void> } }>
  canUseTool?: (name: string, input: Record<string, unknown>, o: { signal: AbortSignal; suggestions?: unknown[] }) => Promise<{ behavior: string; message?: string }>
  abortController?: AbortController
}

class Channel<T> {
  private items: T[] = []
  private waiters: ((r: IteratorResult<T>) => void)[] = []
  private done = false
  push(v: T): void {
    const w = this.waiters.shift()
    if (w) w({ value: v, done: false })
    else this.items.push(v)
  }
  end(): void {
    this.done = true
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true })
  }
  next(): Promise<IteratorResult<T>> {
    if (this.items.length) return Promise.resolve({ value: this.items.shift() as T, done: false })
    if (this.done) return Promise.resolve({ value: undefined as never, done: true })
    return new Promise((r) => this.waiters.push(r))
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function imageCount(m: UserMsg): number {
  const c = m.message.content
  return Array.isArray(c) ? c.filter((b) => b.type === 'image').length : 0
}

/** A 640x400 gradient PNG standing in for a screenshot. */
function fakeScreenshot(): string {
  const w = 640
  const h = 400
  const px = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      px[i] = Math.round(120 + (x * 100) / w)
      px[i + 1] = Math.round(90 + (y * 80) / h)
      px[i + 2] = 200
      px[i + 3] = 255
    }
  return nativeImage.createFromBitmap(px, { width: w, height: h }).toPNG().toString('base64')
}

function lastText(m: UserMsg): string {
  const c = m.message.content
  if (typeof c === 'string') return c
  const texts = c.filter((b) => b.type === 'text').map((b) => b.text ?? '')
  return texts[texts.length - 1] ?? ''
}

export function fakeQuery({ prompt, options = {} }: { prompt: string | AsyncIterable<UserMsg>; options?: Options }) {
  const out = new Channel<Msg>()
  const sessionId = options.resume ?? randomUUID()
  const clients = new Map<string, Client>()
  let interrupted = false
  options.abortController?.signal.addEventListener('abort', () => out.end())

  const tool = async (server: string, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> => {
    let c = clients.get(server)
    if (!c) {
      const cfg = options.mcpServers?.[server]
      if (!cfg?.instance) return { text: `No ${server} server`, isError: true }
      const [a, b] = InMemoryTransport.createLinkedPair()
      await cfg.instance.connect(a)
      c = new Client({ name: 'fake-claude', version: '1' })
      await c.connect(b)
      clients.set(server, c)
    }
    const r = (await c.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean }
    return { text: r.content.map((x) => x.text ?? '').join('\n'), isError: !!r.isError }
  }

  /** One assistant turn: optional tool calls, then streamed text, then a result. */
  const turn = async (text: string, images = 0): Promise<void> => {
    interrupted = false
    const t = text.toLowerCase()
    const callTool = async (name: string, input: Record<string, unknown>, run: () => Promise<{ text: string; isError: boolean }>, extra?: Msg): Promise<void> => {
      const id = 'toolu_' + randomUUID().slice(0, 8)
      out.push({ type: 'assistant', uuid: randomUUID(), parent_tool_use_id: null, message: { id: 'msg_' + randomUUID().slice(0, 8), content: [{ type: 'tool_use', id, name, input }] } })
      const r = await run()
      out.push({
        type: 'user',
        uuid: randomUUID(),
        parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: r.text, is_error: r.isError }] },
        ...extra
      })
    }
    let reply = `Echo: ${text}` + (images ? ` (with ${images} image${images === 1 ? '' : 's'})` : '')
    if (t.includes('make artifact')) {
      await callTool('mcp__artifacts__create_artifact', { id: 'demo-page', type: 'html', title: 'Demo page', content: '<h1>Hello from the demo</h1>' }, () =>
        tool('artifacts', 'create_artifact', { id: 'demo-page', type: 'html', title: 'Demo page', content: '<h1>Hello from the demo</h1>' })
      )
      reply = 'I made a demo page.'
    } else if (t.startsWith('remember ')) {
      const fact = text.slice(9)
      await callTool('mcp__memory__remember', { text: fact }, () => tool('memory', 'remember', { text: fact }))
      reply = 'Noted.'
    } else if (t.includes('ask permission')) {
      const input = { command: 'echo hi', description: 'Say hi' }
      const id = 'toolu_' + randomUUID().slice(0, 8)
      out.push({ type: 'assistant', uuid: randomUUID(), parent_tool_use_id: null, message: { id: 'msg_' + randomUUID().slice(0, 8), content: [{ type: 'tool_use', id, name: 'Bash', input }] } })
      const d = (await options.canUseTool?.('Bash', input, { signal: new AbortController().signal, suggestions: [] })) ?? { behavior: 'allow' }
      const ok = d.behavior === 'allow'
      out.push({ type: 'user', uuid: randomUUID(), parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: ok ? 'hi' : d.message ?? 'denied', is_error: !ok }] } })
      reply = ok ? 'Permission granted, the command ran.' : 'Permission denied.'
    } else if (t.includes('edit file')) {
      const input = { file_path: 'C:/demo/app.ts', old_string: 'old line', new_string: 'new line' }
      await callTool('Edit', input, async () => ({ text: 'ok', isError: false }), {
        tool_use_result: { filePath: input.file_path, structuredPatch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-old line', '+new line'] }] }
      })
      reply = 'Edited app.ts.'
    } else if (t.startsWith('search my chats for ')) {
      const q = text.slice('search my chats for '.length)
      let found = ''
      await callTool('mcp__chats__search_chats', { query: q }, async () => {
        const r = await tool('chats', 'search_chats', { query: q })
        found = r.text
        return r
      })
      reply = `Found: ${found.split('\n')[0] ?? ''}`
    } else if (t.startsWith('search knowledge for ')) {
      const q = text.slice('search knowledge for '.length)
      let found = ''
      await callTool('mcp__knowledge__search_knowledge', { query: q }, async () => {
        const r = await tool('knowledge', 'search_knowledge', { query: q })
        found = r.text
        return r
      })
      reply = `Knowledge: ${found.slice(0, 200)}`
    } else if (t.includes('take a screenshot')) {
      const id = 'toolu_' + randomUUID().slice(0, 8)
      out.push({ type: 'assistant', uuid: randomUUID(), parent_tool_use_id: null, message: { id: 'msg_' + randomUUID().slice(0, 8), content: [{ type: 'tool_use', id, name: 'mcp__computer-use__computer', input: { action: 'screenshot' } }] } })
      const shot = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: fakeScreenshot() } }
      out.push({ type: 'user', uuid: randomUUID(), parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [shot] }] } })
      reply = 'Here is your screen.'
    } else if (t.includes('slow')) {
      for (let i = 0; i < 30 && !interrupted; i++) await sleep(100)
    }
    if (interrupted) {
      out.push({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['interrupted'], usage: {}, duration_ms: 1, num_turns: 1 })
      return
    }
    const mid = 'msg_' + randomUUID().slice(0, 8)
    out.push({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: mid } } })
    out.push({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } })
    for (const chunk of reply.match(/.{1,12}/g) ?? [reply]) out.push({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } } })
    out.push({ type: 'assistant', uuid: randomUUID(), parent_tool_use_id: null, message: { id: mid, content: [{ type: 'text', text: reply }] } })
    out.push({ type: 'result', subtype: 'success', is_error: false, result: reply, total_cost_usd: 0, usage: { input_tokens: 12, output_tokens: 6 }, duration_ms: 5, num_turns: 1 })
  }

  void (async () => {
    if (typeof prompt === 'string') {
      // one-off requests (chat titles)
      const user = /<user>\n?([\s\S]*?)\n?<\/user>/.exec(prompt)?.[1] ?? prompt
      const title = 'Chat about ' + user.split(/\s+/).slice(0, 3).join(' ')
      out.push({ type: 'result', subtype: 'success', is_error: false, result: title, usage: {}, duration_ms: 1, num_turns: 1 })
      out.end()
      return
    }
    out.push({
      type: 'system',
      subtype: 'init',
      session_id: sessionId,
      model: options.model || 'claude-fake-1',
      cwd: options.cwd ?? '',
      tools: ['Read', 'Edit', 'Bash'],
      slash_commands: ['compact', 'context'],
      skills: [],
      mcp_servers: Object.keys(options.mcpServers ?? {}).map((name) => ({ name, status: 'connected' })),
      apiKeySource: 'none',
      claude_code_version: 'fake',
      permissionMode: options.permissionMode ?? 'default'
    })
    for await (const m of prompt) await turn(lastText(m), imageCount(m))
    out.end()
  })()

  const it = {
    next: () => out.next(),
    return: async () => {
      out.end()
      return { value: undefined, done: true }
    },
    [Symbol.asyncIterator]() {
      return this
    },
    interrupt: async () => {
      interrupted = true
    },
    setPermissionMode: async () => {},
    setModel: async () => {},
    supportedCommands: async () => [
      { name: 'compact', description: 'Summarize the conversation to free up context', argumentHint: '' },
      { name: 'context', description: 'Show context usage', argumentHint: '' }
    ],
    supportedModels: async () => [{ value: 'fake', displayName: 'Fake model', description: 'Used in tests' }],
    accountInfo: async () => ({ email: 'e2e@example.com', subscriptionType: 'max' }),
    mcpServerStatus: async () => Object.keys(options.mcpServers ?? {}).map((name) => ({ name, status: 'connected' })),
    toggleMcpServer: async () => {},
    reconnectMcpServer: async () => {},
    getContextUsage: async () => ({ percentage: 12, totalTokens: 24000, maxTokens: 200000, rawMaxTokens: 200000, categories: [{ name: 'Messages', tokens: 20000, color: '', kind: 'used' }] }),
    rewindFiles: async (_id: string, o?: { dryRun?: boolean }) => (o?.dryRun ? { canRewind: true, filesChanged: [], insertions: 0, deletions: 0 } : { canRewind: true, filesChanged: [] }),
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
      subscription_type: 'max',
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 37, resets_at: new Date(Date.now() + 7200000).toISOString() }, seven_day: { utilization: 12, resets_at: null } },
      session: {},
      behaviors: null
    })
  }
  return it
}

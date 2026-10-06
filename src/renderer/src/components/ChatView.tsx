import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { parsedInput } from '../../../shared/steps'
import type { AppSettings, Artifact, Attachment, ChatMessage, GitStatus, ImageRef, PermissionModeUI, PermissionRequest, Project, RateLimitInfo, SessionMeta } from '../../../shared/types'
import type { SessionRuntime } from '../App'
import { api } from '../api'
import { allStyles } from '../../../shared/styles'
import { ArtifactPanel, type PanelState } from './ArtifactPanel'
import { ChoiceDialog } from './ChoiceDialog'
import { changedFiles, FilesPanel } from './FilesPanel'
import { FindBar } from './FindBar'
import { Icon } from './Icon'
import { ImagesContext, Lightbox } from './Images'
import { Menu, type MenuEntry } from './Menu'
import { Turn, UserMessage, type TranscriptMode } from './MessageView'
import { PermissionDialog } from './PermissionDialog'
import { PromptDialog } from './PromptDialog'
import { RewindDialog } from './RewindDialog'
import { Spark } from './Spark'
import { ContextRing, McpButton, Working } from './StatusWidgets'
import { TaskBar, type Todo } from './TaskBar'

type Segment = { kind: 'user'; message: ChatMessage } | { kind: 'turn'; key: string; messages: ChatMessage[] }

const MODES: { value: PermissionModeUI; label: string; short: string; hint: string }[] = [
  { value: 'default', label: 'Ask permissions', short: 'Ask', hint: 'Claude asks before editing files or running commands' },
  { value: 'acceptEdits', label: 'Auto-accept edits', short: 'Edits', hint: 'File edits go through; commands still ask' },
  { value: 'plan', label: 'Plan mode', short: 'Plan', hint: 'Claude researches and proposes a plan without changing anything' },
  { value: 'auto', label: 'Auto', short: 'Auto', hint: 'A safety classifier approves or blocks each action for you' },
  { value: 'bypassPermissions', label: 'Full access', short: 'Full access', hint: 'No prompts at all. Claude can do anything on this machine.' }
]
/** Shift+Tab cycles these, like Claude Code. Full access is only reachable from the menu. */
const CYCLE: PermissionModeUI[] = ['default', 'acceptEdits', 'plan', 'auto']

const MODEL_ALIASES = [
  { value: '', displayName: 'Default', description: "Claude Code's default for your plan" },
  { value: 'opus', displayName: 'Opus', description: 'Most capable' },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Fast and capable' },
  { value: 'haiku', displayName: 'Haiku', description: 'Fastest' }
]
const EFFORTS: { value: AppSettings['effort']; label: string }[] = [
  { value: '', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' }
]

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** claude-opus-5-5 → Opus 5.5 */
function prettyModel(id: string | undefined): string {
  if (!id) return 'Default'
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$|\[)/i.exec(id)
  if (m) return `${cap(m[1])} ${m[2]}${m[3] ? '.' + m[3] : ''}`
  return cap(id)
}

function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

function fileToAttachment(f: File): Promise<Attachment | null> {
  return new Promise((resolve) => {
    if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type) || f.size > 5 * 1024 * 1024) return resolve(null)
    const r = new FileReader()
    r.onload = () => {
      const s = String(r.result)
      resolve({ kind: 'image', mediaType: f.type, base64: s.slice(s.indexOf(',') + 1), name: f.name || 'pasted-image' })
    }
    r.onerror = () => resolve(null)
    r.readAsDataURL(f)
  })
}

function resetLabel(ts?: number): string {
  if (!ts) return ''
  const ms = ts * (ts < 1e12 ? 1000 : 1)
  return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

export function ChatView(props: {
  meta: SessionMeta
  history: ChatMessage[]
  runtime: SessionRuntime
  permission: PermissionRequest | null
  settings: AppSettings
  rateLimit: RateLimitInfo | null
  transcript: TranscriptMode
  headerLeft: ReactNode
  artifacts: Artifact[]
  lastArtifact: { id: string; at: number } | null
  project?: Project
  projects: Project[]
  onOpenProject: (id: string) => void
  onMoveToProject: (projectId: string | undefined) => void
  onTranscript: (m: TranscriptMode) => void
  onPermissionDone: (requestId: string) => void
  onMeta: (m: SessionMeta) => void
  onOpenSettings: (tab: string) => void
  onSettings: (patch: Partial<AppSettings>) => Promise<void>
  onRename: (title: string) => void
  onPin: (pinned: boolean) => void
  onDelete: () => void
  onExport: () => void
  /** open the find bar (Ctrl+F, or from a search result) */
  findRequest?: { query: string; n: number } | null
  /** the find request was picked up (so it doesn't reopen in the next chat) */
  onFindHandled?: () => void
}) {
  const { meta, history, runtime } = props
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [models, setModels] = useState(MODEL_ALIASES)
  const [cmdIndex, setCmdIndex] = useState(0)
  const [dragOver, setDragOver] = useState(false)
  const [rewind, setRewind] = useState<{ messageId: string | null } | null>(null)
  const [escHint, setEscHint] = useState(false)
  const [atBottom, setAtBottom] = useState(true)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [panel, setPanel] = useState<PanelState | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [find, setFind] = useState<{ query: string; n: number } | null>(null)
  const [lightbox, setLightbox] = useState<{ images: ImageRef[]; index: number } | null>(null)
  /** the "Files changed" side panel (the artifact panel and it take turns) */
  const [filesOpen, setFilesOpen] = useState(false)
  const [git, setGit] = useState<GitStatus | null>(null)
  const [askWorktree, setAskWorktree] = useState(false)
  const images = useMemo(() => ({ sessionId: meta.id, open: (list: ImageRef[], index: number) => setLightbox({ images: list, index }) }), [meta.id])
  useEffect(() => {
    if (!props.findRequest) return
    setFind(props.findRequest)
    props.onFindHandled?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.findRequest])
  const styleId = meta.style ?? props.settings.defaultStyle
  const currentStyle = !styleId || styleId === 'default' ? undefined : allStyles(props.settings.customStyles).find((s) => s.id === styleId)
  const [choice, setChoice] = useState<{ title: string; body: string; resolve: (v: 'undo' | 'keep' | null) => void } | null>(null)
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 8000)
    return () => clearTimeout(t)
  }, [notice])

  /**
   * Retry and Edit: go back to just before one of your messages and send it (or a new version) again.
   * If Claude changed files after that point, you choose whether to undo those changes too.
   */
  const branchFrom = async (messageId: string, text: string): Promise<void> => {
    const msg = history.find((m) => m.id === messageId)
    if (busy || !msg?.forkAt || (!text.trim() && !msg.imageRefs?.length)) return
    let code = false
    if (msg.uuid) {
      const p = await api.rewindPreview(meta.id, messageId)
      const files = p.canRewind ? (p.filesChanged?.length ?? 0) : 0
      if (files > 0) {
        const pick = await new Promise<'undo' | 'keep' | null>((resolve) =>
          setChoice({
            title: 'Undo the file changes too?',
            body: `Claude changed ${files} file${files === 1 ? '' : 's'} after this message. Undo them before asking again, or keep them as they are?`,
            resolve
          })
        )
        setChoice(null)
        if (!pick) return
        code = pick === 'undo'
      }
    }
    const r = await api.rewind(meta.id, { messageId, code, conversation: true })
    if (!r.ok) return setNotice(r.error ?? 'Couldn’t go back to that message.')
    stick.current = true
    await api.send({ sessionId: meta.id, text: text.trim(), attachments: [], reuseImages: msg.imageRefs })
  }
  // Open the side panel on an artifact as soon as Claude creates or updates it.
  useEffect(() => {
    // (only fresh changes: reopening an old chat shouldn't pop the panel open)
    if (props.lastArtifact && Date.now() - props.lastArtifact.at < 10_000) {
      setPanel({ id: props.lastArtifact.id, version: null })
      setFilesOpen(false)
    }
  }, [props.lastArtifact])
  const artifactInfo = (id: string) => {
    const a = props.artifacts.find((x) => x.id === id)
    return a && { title: a.title, type: a.type, versions: a.versions.length }
  }
  const listRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const stick = useRef(true)
  const lastEsc = useRef(0)

  const busy = runtime.status !== 'idle'
  const started = !!meta.sdkSessionId || history.length > 0
  const files = useMemo(() => changedFiles(history), [history])
  // the branch and changes of the chat's folder, checked again after each reply and when you come back to the window
  const refreshGit = useCallback(() => void api.gitStatus(meta.cwd).then(setGit), [meta.cwd])
  useEffect(() => {
    if (!busy) refreshGit()
  }, [busy, refreshGit])
  useEffect(() => {
    window.addEventListener('focus', refreshGit)
    return () => window.removeEventListener('focus', refreshGit)
  }, [refreshGit])

  useEffect(() => {
    void api.listModels().then((m) => {
      if (m.length) setModels([MODEL_ALIASES[0], ...m.filter((x) => x.value && x.value !== 'default')])
    })
  }, [runtime.init])

  useEffect(() => {
    taRef.current?.focus()
  }, [meta.id])

  // ---- autoscroll while the user is at the bottom
  useLayoutEffect(() => {
    const el = listRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [history, props.permission, busy])

  const scrollToBottom = (): void => {
    stick.current = true
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }

  // ---- subagent messages are shown inside their Agent step
  const { top, byParent } = useMemo(() => {
    const byParent = new Map<string, ChatMessage[]>()
    const top: ChatMessage[] = []
    for (const m of history) {
      if (m.parentToolUseId) {
        const arr = byParent.get(m.parentToolUseId) ?? []
        arr.push(m)
        byParent.set(m.parentToolUseId, arr)
      } else top.push(m)
    }
    return { top, byParent }
  }, [history])
  const childrenOf = (id: string): ChatMessage[] => byParent.get(id) ?? []

  // ---- your messages, and Claude's turn after each one
  const segments = useMemo(() => {
    const segs: Segment[] = []
    for (const m of top) {
      if (m.role === 'user') segs.push({ kind: 'user', message: m })
      else {
        const last = segs[segs.length - 1]
        if (last?.kind === 'turn') last.messages.push(m)
        else segs.push({ kind: 'turn', key: m.id, messages: [m] })
      }
    }
    return segs
  }, [top])

  // ---- slash commands (with descriptions once Claude Code has reported them)
  const commands = useMemo(() => {
    if (runtime.commands?.length) return runtime.commands
    return (runtime.init?.slashCommands ?? []).map((name) => ({ name, description: '', argumentHint: '' }))
  }, [runtime.commands, runtime.init])
  const cmdMatches = useMemo(() => {
    const m = /^\/(\S*)$/.exec(text)
    if (!m) return []
    const q = m[1].toLowerCase()
    const starts = commands.filter((c) => c.name.toLowerCase().startsWith(q))
    const contains = q ? commands.filter((c) => !c.name.toLowerCase().startsWith(q) && c.name.toLowerCase().includes(q)) : []
    return [...starts, ...contains].slice(0, 10)
  }, [text, commands])

  const send = async (): Promise<void> => {
    const t = text.trim()
    if ((!t && !attachments.length) || busy) return
    stick.current = true
    setText('')
    setAttachments([])
    if (taRef.current) taRef.current.style.height = 'auto'
    await api.send({ sessionId: meta.id, text: t, attachments })
  }

  const addPaths = async (paths: string[]): Promise<void> => {
    const imgs = await api.readImages(paths)
    const imgNames = new Set(imgs.map((i) => i.name))
    const others = paths.filter((p) => !imgNames.has(p.split(/[\\/]/).pop() ?? ''))
    if (imgs.length) setAttachments((a) => [...a, ...imgs])
    if (others.length) setText((t) => (t ? t + ' ' : '') + others.map((p) => (p.includes(' ') ? `@"${p}"` : `@${p}`)).join(' ') + ' ')
    taRef.current?.focus()
  }

  const changeFolder = async (): Promise<void> => {
    const p = await api.pickFolder('Choose the folder Claude works in')
    if (p) props.onMeta(await api.updateSession(meta.id, { cwd: p }))
  }
  const addDir = async (): Promise<void> => {
    const p = await api.pickFolder('Give Claude access to another folder')
    if (p && !meta.additionalDirs.includes(p) && p !== meta.cwd) await api.setDirs(meta.id, [...meta.additionalDirs, p])
  }

  const setMode = (v: PermissionModeUI): void => {
    if (v === 'bypassPermissions' && !confirm('Full access lets Claude edit, delete and run anything on this machine without asking. Continue?')) return
    void api.setMode(meta.id, v)
  }

  const canRewind = top.some((m) => m.role === 'user' && (m.uuid || m.forkAt))
  // Claude's task list for the reply it's working on
  const liveTodos = useMemo((): Todo[] | null => {
    if (!busy) return null
    for (let i = top.length - 1; i >= 0 && top[i].role !== 'user'; i--)
      for (let j = top[i].parts.length - 1; j >= 0; j--) {
        const p = top[i].parts[j]
        if (p.kind !== 'tool' || p.name !== 'TodoWrite') continue
        const todos = parsedInput(p).todos
        if (Array.isArray(todos) && todos.length) return todos as Todo[]
      }
    return null
  }, [top, busy])
  const gitMenu: MenuEntry[] = git
    ? [
        { section: `${git.worktree ? 'Worktree' : 'Branch'} · ${git.branch}` },
        ...(git.changed
          ? git.files.slice(0, 8).map((f) => ({ key: 'gf:' + f.path, label: f.path, hint: f.status, onSelect: () => void api.openPath(git.root + '/' + f.path.replace(/^.* -> /, '')) }))
          : [{ key: 'clean', label: 'No uncommitted changes', disabled: true, onSelect: () => {} }]),
        ...(git.changed > 8 ? [{ key: 'more', label: `… and ${git.changed - 8} more`, disabled: true, onSelect: () => {} }] : []),
        'divider',
        { key: 'copy', label: 'Copy branch name', onSelect: () => void navigator.clipboard.writeText(git.branch) },
        { key: 'wt', label: 'New git worktree…', hint: started ? 'New chats only' : 'Own branch', disabled: started || busy, onSelect: () => setAskWorktree(true) },
        { key: 'refresh', label: 'Refresh', onSelect: refreshGit }
      ]
    : []
  const mode = MODES.find((m) => m.value === meta.permissionMode) ?? MODES[0]
  const rl = props.rateLimit
  const modelLabel = meta.model ? (models.find((m) => m.value === meta.model)?.displayName ?? prettyModel(meta.model)) : prettyModel(runtime.init?.model)
  const effortLabel = EFFORTS.find((e) => e.value === props.settings.effort && e.value)?.label

  const titleMenu: MenuEntry[] = [
    { key: 'rename', label: 'Rename', onSelect: () => setRenaming(meta.title) },
    {
      key: 'details',
      label: props.transcript === 'verbose' ? 'Hide details' : 'Show all details',
      hint: 'Ctrl+O',
      onSelect: () => props.onTranscript(props.transcript === 'verbose' ? 'normal' : 'verbose')
    },
    { key: 'pin', label: meta.pinned ? 'Unpin' : 'Pin', onSelect: () => props.onPin(!meta.pinned) },
    { key: 'rewind', label: 'Rewind…', hint: 'Esc Esc', disabled: !canRewind || busy, onSelect: () => setRewind({ messageId: null }) },
    { key: 'export', label: 'Export…', hint: 'Markdown · Ctrl+Shift+E', onSelect: props.onExport },
    ...(props.settings.obsidianEnabled && props.settings.obsidianVault
      ? [{ key: 'obsidian', label: 'Open in Obsidian', hint: 'Saves it as a note', disabled: !top.length, onSelect: () => void api.openChatInObsidian(meta.id) }]
      : []),
    'divider',
    { section: 'Working folder' },
    { key: 'open', label: baseName(meta.cwd), hint: started ? 'Open' : 'Change', onSelect: () => (started ? void api.openPath(meta.cwd) : void changeFolder()) },
    ...meta.additionalDirs.map((d) => ({ key: 'dir:' + d, label: baseName(d), hint: 'Remove', onSelect: () => void api.setDirs(meta.id, meta.additionalDirs.filter((x) => x !== d)) })),
    { key: 'add', label: 'Add a folder…', onSelect: () => void addDir() },
    ...(git && !started ? [{ key: 'worktree', label: 'Work in a new git worktree…', onSelect: () => setAskWorktree(true) }] : []),
    'divider',
    { section: 'Project' },
    ...(props.project ? [{ key: 'proj-open', label: props.project.name, hint: 'Open project', onSelect: () => props.onOpenProject(props.project!.id) }] : []),
    ...props.projects
      .filter((p) => p.id !== meta.projectId)
      .slice(0, 8)
      .map((p) => ({ key: 'mv:' + p.id, label: 'Move to ' + p.name, onSelect: () => props.onMoveToProject(p.id) })),
    ...(props.project ? [{ key: 'proj-remove', label: 'Remove from project', onSelect: () => props.onMoveToProject(undefined) }] : []),
    ...(props.projects.length === 0 ? [{ key: 'proj-none', label: 'No projects yet', disabled: true, onSelect: () => {} }] : []),
    'divider',
    { key: 'delete', label: 'Delete chat', danger: true, onSelect: () => confirm(`Delete "${meta.title}"? This removes it from LocalClaude.`) && props.onDelete() }
  ]

  const modelMenu: MenuEntry[] = [
    { section: 'Model' },
    ...models.map((m) => ({ key: 'm:' + m.value, label: m.displayName, hint: m.description, checked: meta.model === m.value, onSelect: () => void api.setModel(meta.id, m.value) })),
    'divider',
    { section: 'Effort' },
    ...EFFORTS.map((e) => ({ key: 'e:' + e.value, label: e.label, checked: props.settings.effort === e.value, onSelect: () => void props.onSettings({ effort: e.value }) }))
  ]

  const modeMenu: MenuEntry[] = MODES.map((m) => ({
    key: m.value,
    label: m.label,
    hint: m.hint,
    checked: meta.permissionMode === m.value,
    danger: m.value === 'bypassPermissions',
    onSelect: () => setMode(m.value)
  }))

  return (
    // Like the Claude app: the top bar spans the window, and the artifact panel opens below it, beside the chat.
    <div className="chat-shell">
      <header className="titlebar">
        {props.headerLeft}
        {props.project && (
          <>
            <button className="link-btn crumb no-drag" onClick={() => props.onOpenProject(props.project!.id)} title={`Open project “${props.project.name}”`}>
              {props.project.name}
            </button>
            <span className="muted crumb-sep">/</span>
          </>
        )}
        {renaming !== null ? (
          <input
            className="input title-edit no-drag"
            autoFocus
            value={renaming}
            onChange={(e) => setRenaming(e.target.value)}
            onBlur={() => {
              if (renaming.trim() && renaming.trim() !== meta.title) props.onRename(renaming.trim())
              setRenaming(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              if (e.key === 'Escape') setRenaming(null)
            }}
          />
        ) : (
          <Menu
            className="no-drag title-menu"
            title={meta.title}
            trigger={
              <>
                <span className="chat-title">{meta.title}</span>
                <span className="env" title={`Runs on this computer in ${meta.cwd}`}>
                  <Icon name="laptop" size={16} />
                  <span className={'env-dot' + (runtime.init ? ' on' : '')} />
                </span>
                <Icon name="chevronDown" size={15} className="muted" />
              </>
            }
            entries={titleMenu}
          />
        )}
        <div className="grow" />
        <div className="title-actions no-drag">
          <button
            className={'icon-btn' + (props.settings.chromeIntegration ? ' on' : '')}
            onClick={() => void props.onSettings({ chromeIntegration: !props.settings.chromeIntegration })}
            title={props.settings.chromeIntegration ? 'Chrome browser is on (click to turn off)' : 'Let Claude use your Chrome browser'}
          >
            <Icon name="globe" size={18} />
          </button>
          {files.length > 0 && (
            <button
              className={'icon-btn files-btn' + (filesOpen ? ' on' : '')}
              onClick={() => {
                setFilesOpen(!filesOpen)
                setPanel(null)
              }}
              title={`Files changed (${files.length})`}
            >
              <Icon name="edit" size={18} />
              <span className="count-badge">{files.length}</span>
            </button>
          )}
          <button
            className={'icon-btn' + (panel ? ' on' : '')}
            onClick={() => {
              setPanel(panel ? null : { id: null, version: null })
              setFilesOpen(false)
            }}
            title={props.artifacts.length ? `Artifacts (${props.artifacts.length})` : 'Artifacts'}
          >
            <Icon name="file" size={18} />
          </button>
          {git && (
            <Menu
              className="git-menu"
              align="right"
              title={`${git.branch}${git.changed ? ` · ${git.changed} changed file${git.changed === 1 ? '' : 's'}` : ''}`}
              trigger={
                <>
                  <Icon name="branch" size={15} />
                  <span className="pill-label">{git.branch}</span>
                  {git.changed > 0 && <span className="git-count">{git.changed}</span>}
                </>
              }
              entries={gitMenu}
            />
          )}
          <button className="pill-btn" onClick={() => void api.openPath(meta.cwd)} title={`Open ${meta.cwd}`}>
            <Icon name="folder" size={15} />
            <span className="pill-label">{baseName(meta.cwd)}</span>
          </button>
        </div>
        <div className="wco-space" />
      </header>

      <div className="chat-row">
        <div
          className={'chat' + (dragOver ? ' drag' : '')}
          onDragOver={(e) => {
            e.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragOver(false)
            const paths = Array.from(e.dataTransfer.files)
              .map((f) => api.pathForFile(f))
              .filter(Boolean)
            if (paths.length) void addPaths(paths)
          }}
        >
          {find && (
            <FindBar
              container={listRef}
              initial={find.query}
              refreshKey={history}
              focusKey={find.n}
              onClose={() => {
                setFind(null)
                taRef.current?.focus()
              }}
            />
          )}
          <ImagesContext.Provider value={images}>
            <div
              className="messages"
              ref={listRef}
              onScroll={(e) => {
                const el = e.currentTarget
                const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
                stick.current = bottom
                if (bottom !== atBottom) setAtBottom(bottom)
              }}
            >
              <div className="messages-inner">
                {top.length === 0 && (
                  <div className="chat-empty">
                    <Spark size={40} className="welcome-spark" />
                    <h2>How can I help you today?</h2>
                    <p className="muted small">
                      Working in <code>{baseName(meta.cwd)}</code> · <code>/</code> commands · <code>@</code> files · <code>Shift+Tab</code> modes
                      {props.settings.computerUse ? ' · computer use on' : ''}
                    </p>
                  </div>
                )}
                {segments.map((seg, i) => {
                  if (seg.kind === 'user')
                    return (
                      <UserMessage
                        key={seg.message.id}
                        message={seg.message}
                        onRewind={busy ? undefined : (id) => setRewind({ messageId: id })}
                        onEdit={busy ? undefined : (id, text) => void branchFrom(id, text)}
                      />
                    )
                  const isLast = i === segments.length - 1
                  const prev = segments[i - 1]
                  const retryFrom = isLast && !busy && prev?.kind === 'user' && prev.message.forkAt ? prev.message : undefined
                  return (
                    <Turn
                      key={seg.key}
                      messages={seg.messages}
                      childrenOf={childrenOf}
                      live={busy && isLast}
                      mode={props.transcript}
                      artifactInfo={artifactInfo}
                      onOpenArtifact={(id) => setPanel({ id, version: null })}
                      onRetry={retryFrom ? () => void branchFrom(retryFrom.id, retryFrom.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('')) : undefined}
                      footer={busy && isLast && !props.permission ? <Working key={runtime.turnStartedAt ?? 0} since={runtime.turnStartedAt} starting={runtime.status === 'starting'} /> : undefined}
                    />
                  )
                })}
                {busy && !props.permission && segments[segments.length - 1]?.kind !== 'turn' && (
                  <div className="turn">
                    <Working key={runtime.turnStartedAt ?? 0} since={runtime.turnStartedAt} starting={runtime.status === 'starting'} />
                  </div>
                )}
              </div>
            </div>
          </ImagesContext.Provider>
          {lightbox && <Lightbox sessionId={meta.id} images={lightbox.images} index={lightbox.index} onClose={() => setLightbox(null)} />}

          <div className="composer-wrap">
            {!atBottom && (
              <button className="to-bottom" onClick={scrollToBottom} title="Scroll to bottom">
                <Icon name="arrowDown" size={16} />
              </button>
            )}
            {props.permission && (
              <div className="perm-dock">
                <PermissionDialog key={props.permission.requestId} req={props.permission} onDone={props.onPermissionDone} />
              </div>
            )}
            {notice && (
              <div className="notice error chat-notice" role="alert" onClick={() => setNotice(null)}>
                {notice}
              </div>
            )}
            {liveTodos && <TaskBar todos={liveTodos} />}

            <div className={'composer mode-' + meta.permissionMode}>
              {cmdMatches.length > 0 && (
                <div className="cmd-popup">
                  {cmdMatches.map((c, i) => (
                    <button
                      key={c.name}
                      className={'cmd' + (i === cmdIndex % cmdMatches.length ? ' active' : '')}
                      onMouseDown={(e) => {
                        e.preventDefault()
                        setText('/' + c.name + ' ')
                      }}
                    >
                      <span className="cmd-name">
                        /{c.name}
                        {c.argumentHint && <span className="muted"> {c.argumentHint}</span>}
                      </span>
                      <span className="cmd-desc">
                        {runtime.init?.skills.includes(c.name) && <span className="tag">skill</span>}
                        {c.description}
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {attachments.length > 0 && (
                <div className="attachments">
                  {attachments.map((a, i) => (
                    <div key={i} className="thumb">
                      <img src={`data:${a.mediaType};base64,${a.base64}`} alt={a.name} />
                      <button className="chip-x" onClick={() => setAttachments((x) => x.filter((_, j) => j !== i))}>
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="prompt-row">
                <textarea
                  ref={taRef}
                  className="composer-input"
                  placeholder={busy ? 'Claude is working… (Esc to stop)' : top.length ? 'Reply' : 'How can I help you today?'}
                  value={text}
                  rows={1}
                  onChange={(e) => {
                    setText(e.target.value)
                    setCmdIndex(0)
                    const el = e.target
                    el.style.height = 'auto'
                    el.style.height = Math.min(el.scrollHeight, 260) + 'px'
                  }}
                  onPaste={async (e) => {
                    const files = Array.from(e.clipboardData.files)
                    if (!files.length) return
                    e.preventDefault()
                    const atts = (await Promise.all(files.map(fileToAttachment))).filter(Boolean) as Attachment[]
                    setAttachments((a) => [...a, ...atts])
                  }}
                  onKeyDown={(e) => {
                    if (cmdMatches.length) {
                      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                        e.preventDefault()
                        setCmdIndex((i) => i + (e.key === 'ArrowDown' ? 1 : cmdMatches.length - 1))
                        return
                      }
                      if (e.key === 'Tab' && !e.shiftKey) {
                        e.preventDefault()
                        setText('/' + cmdMatches[cmdIndex % cmdMatches.length].name + ' ')
                        return
                      }
                    }
                    if (e.key === 'Tab' && e.shiftKey) {
                      e.preventDefault()
                      const i = CYCLE.indexOf(meta.permissionMode)
                      setMode(CYCLE[(i + 1) % CYCLE.length])
                      return
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault()
                      if (busy) return void api.interrupt(meta.id)
                      const now = Date.now()
                      if (now - lastEsc.current < 600 && !text && canRewind) {
                        lastEsc.current = 0
                        setEscHint(false)
                        setRewind({ messageId: null })
                      } else {
                        lastEsc.current = now
                        if (text) setText('')
                        else if (canRewind) {
                          setEscHint(true)
                          setTimeout(() => setEscHint(false), 1200)
                        }
                      }
                    } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault()
                      const pick = cmdMatches[cmdIndex % (cmdMatches.length || 1)]
                      if (pick && '/' + pick.name !== text.trim()) {
                        setText('/' + pick.name + ' ')
                        return
                      }
                      void send()
                    }
                  }}
                />
                {busy ? (
                  <button className="send stop" onClick={() => void api.interrupt(meta.id)} title="Stop (Esc)">
                    <Icon name="stop" size={14} />
                  </button>
                ) : (
                  <button className="send" disabled={!text.trim() && !attachments.length} onClick={() => void send()} title="Send (Enter)">
                    <Icon name="enter" size={18} />
                  </button>
                )}
              </div>
            </div>

            <div className="composer-below">
              <button
                className="icon-btn"
                title="Attach files or images"
                onClick={async () => {
                  const paths = await api.pickFiles()
                  if (paths.length) void addPaths(paths)
                }}
              >
                <Icon name="plus" size={18} />
              </button>
              <Menu
                className={'below-menu style-menu' + (styleId && styleId !== 'default' ? ' on' : '')}
                direction="up"
                title="Response style"
                trigger={
                  <>
                    <Icon name="edit" size={15} />
                    {currentStyle && <span className="style-name">{currentStyle.name}</span>}
                  </>
                }
                entries={[
                  { section: 'Response style' },
                  { key: 'default', label: 'Normal', hint: 'Claude Code’s usual style', checked: !currentStyle, onSelect: () => void api.setStyle(meta.id, 'default') },
                  ...allStyles(props.settings.customStyles).map((st) => ({
                    key: st.id,
                    label: st.name,
                    hint: st.description,
                    checked: currentStyle?.id === st.id,
                    onSelect: () => void api.setStyle(meta.id, st.id)
                  })),
                  'divider',
                  { key: 'manage', label: 'Create & edit styles…', onSelect: () => props.onOpenSettings('general') }
                ]}
              />
              {runtime.init && <McpButton sessionId={meta.id} servers={runtime.mcp} onOpenSettings={() => props.onOpenSettings('tools')} />}
              <div className="grow" />
              <span className="disclaimer">{escHint ? 'Press Esc again to rewind' : 'Claude is AI and can make mistakes.'}</span>
              <div className="grow" />
              <ContextRing usage={runtime.context} />
              <Menu
                className="below-menu"
                align="right"
                direction="up"
                title="Model and effort"
                trigger={
                  <>
                    <span className="model-name">{modelLabel}</span>
                    {effortLabel && <span className="muted">{effortLabel}</span>}
                  </>
                }
                entries={modelMenu}
                footer={
                  rl ? (
                    <span className={rl.status === 'allowed' ? 'muted' : rl.status === 'rejected' ? 'danger-text' : 'warn-text'}>
                      {cap((rl.rateLimitType ?? 'usage').replace(/_/g, ' '))}
                      {rl.utilization !== undefined && `: ${Math.round(rl.utilization * (rl.utilization <= 1 ? 100 : 1))}% used`}
                      {rl.resetsAt && ` · resets ${resetLabel(rl.resetsAt)}`}
                    </span>
                  ) : undefined
                }
              />
              <Menu
                className={'below-menu mode-' + meta.permissionMode}
                align="right"
                direction="up"
                title={mode.hint + ' (Shift+Tab to cycle)'}
                trigger={<span>{mode.short}</span>}
                entries={modeMenu}
              />
            </div>
          </div>

          {choice && (
            <ChoiceDialog
              title={choice.title}
              body={choice.body}
              choices={[
                { value: 'keep', label: 'Keep changes' },
                { value: 'undo', label: 'Undo changes', primary: true }
              ]}
              onChoose={(v) => choice.resolve(v)}
            />
          )}
          {askWorktree && (
            <PromptDialog
              title="Work in a new git worktree"
              body={`Claude gets its own branch in a new folder next to ${baseName(git?.root ?? meta.cwd)}, so your checkout isn’t touched. This chat then works there.`}
              placeholder="Branch name, like fix-login"
              initial={'claude/' + meta.id.replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase()}
              submitLabel="Create worktree"
              onCancel={() => setAskWorktree(false)}
              onSubmit={async (name) => {
                props.onMeta(await api.createWorktree(meta.id, name))
                setAskWorktree(false)
                return null
              }}
            />
          )}
          {rewind && (
            <RewindDialog
              sessionId={meta.id}
              history={history}
              messageId={rewind.messageId}
              onClose={() => {
                setRewind(null)
                taRef.current?.focus()
              }}
              onRestored={(t) => {
                setRewind(null)
                if (t !== undefined) setText(t)
                taRef.current?.focus()
              }}
            />
          )}
        </div>
        {panel && <ArtifactPanel sessionId={meta.id} artifacts={props.artifacts} state={panel} onState={setPanel} onClose={() => setPanel(null)} />}
        {filesOpen && !panel && (
          <FilesPanel files={files} cwd={meta.cwd} canUndo={canRewind && !busy} onUndo={() => setRewind({ messageId: null })} onClose={() => setFilesOpen(false)} />
        )}
      </div>
    </div>
  )
}

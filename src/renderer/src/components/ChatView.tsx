import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AppSettings, Attachment, ChatMessage, PermissionModeUI, PermissionRequest, RateLimitInfo, SessionMeta } from '../../../shared/types'
import type { SessionRuntime } from '../App'
import { api } from '../api'
import { MessageView } from './MessageView'
import { PermissionDialog } from './PermissionDialog'

const MODES: { value: PermissionModeUI; label: string; hint: string }[] = [
  { value: 'default', label: 'Ask permissions', hint: 'Claude asks before editing files or running commands' },
  { value: 'acceptEdits', label: 'Auto-accept edits', hint: 'File edits go through; commands still ask' },
  { value: 'plan', label: 'Plan mode', hint: 'Claude researches and proposes a plan without changing anything' },
  { value: 'bypassPermissions', label: 'Full access', hint: 'No prompts at all. Claude can do anything on this machine.' }
]

const MODEL_ALIASES = [
  { value: '', displayName: 'Default', description: "Claude Code's default for your plan" },
  { value: 'opus', displayName: 'Opus', description: 'Most capable' },
  { value: 'sonnet', displayName: 'Sonnet', description: 'Fast and capable' },
  { value: 'haiku', displayName: 'Haiku', description: 'Fastest' }
]

function shortPath(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : p
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
  onPermissionDone: (requestId: string) => void
  onMeta: (m: SessionMeta) => void
  onOpenSettings: (tab: string) => void
}) {
  const { meta, history, runtime } = props
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [models, setModels] = useState(MODEL_ALIASES)
  const [cmdIndex, setCmdIndex] = useState(0)
  const [dragOver, setDragOver] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const stick = useRef(true)

  const busy = runtime.status !== 'idle'
  const started = !!meta.sdkSessionId || history.length > 0

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
  }, [history, props.permission])

  // ---- subagent messages are shown inside their Agent tool card
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

  // ---- slash commands
  const commands = runtime.init?.slashCommands ?? []
  const cmdMatches = useMemo(() => {
    const m = /^\/(\S*)$/.exec(text)
    if (!m) return []
    return commands.filter((c) => c.toLowerCase().startsWith(m[1].toLowerCase())).slice(0, 8)
  }, [text, commands])

  const send = async (): Promise<void> => {
    const t = text.trim()
    if ((!t && !attachments.length) || busy) return
    stick.current = true
    setText('')
    setAttachments([])
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

  const mode = MODES.find((m) => m.value === meta.permissionMode) ?? MODES[0]
  const rl = props.rateLimit

  return (
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
      <header className="chat-header">
        <div className="chat-title">{meta.title}</div>
        <div className="folders">
          <button
            className="chip folder"
            title={started ? meta.cwd + ' (fixed once the chat starts)' : 'Change working folder'}
            onClick={() => (started ? void api.openPath(meta.cwd) : void changeFolder())}
          >
            📁 {shortPath(meta.cwd)}
          </button>
          {meta.additionalDirs.map((d) => (
            <span key={d} className="chip folder" title={d}>
              {shortPath(d)}
              <button className="chip-x" onClick={() => void api.setDirs(meta.id, meta.additionalDirs.filter((x) => x !== d))}>
                ×
              </button>
            </span>
          ))}
          <button className="chip ghost" onClick={() => void addDir()} title="Give Claude access to another folder">
            ＋ folder
          </button>
        </div>
      </header>

      <div
        className="messages"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        <div className="messages-inner">
          {top.length === 0 && (
            <div className="chat-empty">
              <div className="empty-mark">✳</div>
              <h2>How can I help?</h2>
              <p className="muted">
                Working in <code>{meta.cwd}</code>. I can read and edit files here, run commands, search the web
                {props.settings.chromeIntegration ? ', drive your Chrome browser' : ''} and use your MCP tools and skills.
              </p>
            </div>
          )}
          {top.map((m, i) => (
            <MessageView key={m.id} message={m} childrenOf={childrenOf} live={busy && i === top.length - 1} />
          ))}
          {busy && (top.length === 0 || top[top.length - 1].role === 'user') && (
            <div className="msg assistant">
              <div className="working">
                <span className="spark">✳</span> {runtime.status === 'starting' ? 'Starting Claude Code…' : 'Working…'}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="composer-wrap">
        {props.permission && (
          <div className="perm-dock">
            <PermissionDialog key={props.permission.requestId} req={props.permission} onDone={props.onPermissionDone} />
          </div>
        )}

        <div className="composer">
          {cmdMatches.length > 0 && (
            <div className="cmd-popup">
              {cmdMatches.map((c, i) => (
                <button
                  key={c}
                  className={'cmd' + (i === cmdIndex % cmdMatches.length ? ' active' : '')}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    setText('/' + c + ' ')
                  }}
                >
                  /{c}
                  {runtime.init?.skills.includes(c) && <span className="muted small"> skill</span>}
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
          <textarea
            ref={taRef}
            className="composer-input"
            placeholder={busy ? 'Claude is working… (Esc to stop)' : 'Reply to Claude…  (/ for commands, @path to mention a file)'}
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
                if (e.key === 'Tab') {
                  e.preventDefault()
                  setText('/' + cmdMatches[cmdIndex % cmdMatches.length] + ' ')
                  return
                }
              }
              if (e.key === 'Escape' && busy) {
                e.preventDefault()
                void api.interrupt(meta.id)
              } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send()
              }
            }}
          />
          <div className="composer-bar">
            <button
              className="icon-btn"
              title="Attach files or images"
              onClick={async () => {
                const paths = await api.pickFiles()
                if (paths.length) void addPaths(paths)
              }}
            >
              📎
            </button>
            <select
              className={'select mode-' + meta.permissionMode}
              value={meta.permissionMode}
              title={mode.hint}
              onChange={(e) => {
                const v = e.target.value as PermissionModeUI
                if (v === 'bypassPermissions' && !confirm('Full access lets Claude edit, delete and run anything on this machine without asking. Continue?'))
                  return
                void api.setMode(meta.id, v)
              }}
            >
              {MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            <select className="select" value={meta.model} onChange={(e) => void api.setModel(meta.id, e.target.value)} title="Model">
              {models.map((m) => (
                <option key={m.value} value={m.value} title={m.description}>
                  {m.displayName}
                </option>
              ))}
              {meta.model && !models.some((m) => m.value === meta.model) && <option value={meta.model}>{meta.model}</option>}
            </select>
            <div className="grow" />
            {busy ? (
              <button className="send stop" onClick={() => void api.interrupt(meta.id)} title="Stop (Esc)">
                ■
              </button>
            ) : (
              <button className="send" disabled={!text.trim() && !attachments.length} onClick={() => void send()} title="Send (Enter)">
                ↑
              </button>
            )}
          </div>
        </div>

        <div className="statusline">
          {runtime.init && (
            <>
              <span title={`Claude Code ${runtime.init.claudeCodeVersion}`}>{runtime.init.model}</span>
              {runtime.init.mcpServers.length > 0 && (
                <button className="link-btn" onClick={() => props.onOpenSettings('tools')}>
                  MCP: {runtime.init.mcpServers.filter((m) => m.status === 'connected').length}/{runtime.init.mcpServers.length}
                </button>
              )}
              {runtime.init.skills.length > 0 && <span>{runtime.init.skills.length} skills</span>}
              {runtime.init.apiKeySource !== 'none' && <span className="warn-text">⚠ using API key ({runtime.init.apiKeySource})</span>}
            </>
          )}
          {runtime.lastStats && (
            <span title="Estimate at API rates. On a subscription this counts toward your plan's usage limit, not billed per token.">
              last turn: {(runtime.lastStats.outputTokens / 1000).toFixed(1)}k out · {(runtime.lastStats.durationMs / 1000).toFixed(0)}s
            </span>
          )}
          <div className="grow" />
          {rl && (
            <span className={rl.status === 'allowed' ? '' : rl.status === 'rejected' ? 'danger-text' : 'warn-text'}>
              {rl.rateLimitType?.replace(/_/g, ' ') ?? 'usage'}
              {rl.utilization !== undefined && `: ${Math.round(rl.utilization * (rl.utilization <= 1 ? 100 : 1))}% used`}
              {rl.resetsAt && ` · resets ${resetLabel(rl.resetsAt)}`}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

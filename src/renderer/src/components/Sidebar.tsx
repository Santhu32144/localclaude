import { useMemo, useState } from 'react'
import type { AuthStatus, SessionMeta } from '../../../shared/types'
import type { SessionRuntime } from '../App'

function groupLabel(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const startOfDay = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return 'Previous 7 days'
  if (days < 30) return 'Previous 30 days'
  return d.toLocaleString(undefined, { month: 'long', year: 'numeric' })
}

export function Sidebar(props: {
  sessions: SessionMeta[]
  activeId: string | null
  runtime: Record<string, SessionRuntime>
  pending: Record<string, number>
  auth: AuthStatus
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
  onSettings: () => void
}) {
  const [filter, setFilter] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [menu, setMenu] = useState<string | null>(null)

  const groups = useMemo(() => {
    const f = filter.trim().toLowerCase()
    const out: [string, SessionMeta[]][] = []
    for (const s of props.sessions) {
      if (f && !s.title.toLowerCase().includes(f) && !s.cwd.toLowerCase().includes(f)) continue
      const g = groupLabel(s.updatedAt)
      const last = out[out.length - 1]
      if (last && last[0] === g) last[1].push(s)
      else out.push([g, [s]])
    }
    return out
  }, [props.sessions, filter])

  return (
    <aside className="sidebar" onClick={() => setMenu(null)}>
      <div className="sidebar-top">
        <div className="brand">
          <span className="brand-mark">✳</span> LocalClaude
        </div>
        <button className="btn new-chat" onClick={props.onNew} title="New chat (Ctrl+N)">
          <span>＋</span> New chat
        </button>
        <input className="input search" placeholder="Search chats" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>

      <nav className="session-list">
        {groups.map(([label, items]) => (
          <div key={label}>
            <div className="group-label">{label}</div>
            {items.map((s) => {
              const rt = props.runtime[s.id]
              const busy = rt?.status === 'running' || rt?.status === 'starting'
              const pend = props.pending[s.id]
              return (
                <div
                  key={s.id}
                  className={'session-item' + (s.id === props.activeId ? ' active' : '')}
                  onClick={() => props.onSelect(s.id)}
                  title={s.cwd}
                >
                  {editing === s.id ? (
                    <input
                      className="input rename"
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={() => {
                        if (draft.trim()) props.onRename(s.id, draft.trim())
                        setEditing(null)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                        if (e.key === 'Escape') setEditing(null)
                      }}
                    />
                  ) : (
                    <>
                      <span className="session-title">{s.title}</span>
                      {pend ? <span className="badge warn">{pend}</span> : busy ? <span className="dot-pulse" /> : null}
                      <button
                        className="icon-btn more"
                        onClick={(e) => {
                          e.stopPropagation()
                          setMenu(menu === s.id ? null : s.id)
                        }}
                        aria-label="Chat options"
                      >
                        ⋯
                      </button>
                    </>
                  )}
                  {menu === s.id && (
                    <div className="popover" onClick={(e) => e.stopPropagation()}>
                      <button
                        onClick={() => {
                          setDraft(s.title)
                          setEditing(s.id)
                          setMenu(null)
                        }}
                      >
                        Rename
                      </button>
                      <button
                        className="danger-text"
                        onClick={() => {
                          setMenu(null)
                          if (confirm(`Delete "${s.title}"? This removes it from LocalClaude.`)) props.onDelete(s.id)
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ))}
        {!props.sessions.length && <div className="muted small pad">No chats yet.</div>}
      </nav>

      <button className="sidebar-account" onClick={props.onSettings} title="Settings (Ctrl+,)">
        <span className="avatar">{(props.auth.email ?? 'C').slice(0, 1).toUpperCase()}</span>
        <span className="account-text">
          <span className="account-email">{props.auth.email ?? 'Signed in'}</span>
          <span className="muted small">{props.auth.subscriptionType ? `Claude ${props.auth.subscriptionType}` : 'Claude subscription'}</span>
        </span>
        <span className="gear">⚙</span>
      </button>
    </aside>
  )
}

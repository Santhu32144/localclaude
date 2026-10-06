import { useMemo, useState } from 'react'
import type { AuthStatus, SessionMeta } from '../../../shared/types'
import type { SessionRuntime } from '../App'
import { Icon } from './Icon'
import { Menu } from './Menu'

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

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

export function Sidebar(props: {
  open: boolean
  /** narrow window: slide over the chat instead of taking space */
  overlay: boolean
  onCollapse: () => void
  sessions: SessionMeta[]
  activeId: string | null
  runtime: Record<string, SessionRuntime>
  pending: Record<string, number>
  auth: AuthStatus
  canBack: boolean
  canForward: boolean
  onBack: () => void
  onForward: () => void
  onSelect: (id: string) => void
  onNew: () => void
  onDelete: (id: string) => void
  onRename: (id: string, title: string) => void
  onPin: (id: string, pinned: boolean) => void
  projectsActive: boolean
  onProjects: () => void
  onSettings: () => void
  onSignOut: () => void
}) {
  const [filter, setFilter] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const { pinned, groups } = useMemo(() => {
    const f = filter.trim().toLowerCase()
    const match = (s: SessionMeta): boolean => !f || s.title.toLowerCase().includes(f) || s.cwd.toLowerCase().includes(f)
    const pinned = props.sessions.filter((s) => s.pinned && match(s))
    const out: [string, SessionMeta[]][] = []
    for (const s of props.sessions) {
      if (s.pinned || !match(s)) continue
      const g = groupLabel(s.updatedAt)
      const last = out[out.length - 1]
      if (last && last[0] === g) last[1].push(s)
      else out.push([g, [s]])
    }
    return { pinned, groups: out }
  }, [props.sessions, filter])

  const name = props.auth.email ? props.auth.email.split('@')[0] : 'You'
  const plan = props.auth.subscriptionType ? cap(props.auth.subscriptionType) : ''

  const item = (s: SessionMeta) => {
    const rt = props.runtime[s.id]
    const busy = rt?.status === 'running' || rt?.status === 'starting'
    const pend = props.pending[s.id]
    return (
      <div key={s.id} className={'session-item' + (s.id === props.activeId ? ' active' : '')} onClick={() => props.onSelect(s.id)} title={s.cwd}>
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
            <div className="more" onClick={(e) => e.stopPropagation()}>
              <Menu
                title="Chat options"
                align="right"
                trigger={<span className="more-dots">⋯</span>}
                entries={[
                  { key: 'pin', label: s.pinned ? 'Unpin' : 'Pin', onSelect: () => props.onPin(s.id, !s.pinned) },
                  {
                    key: 'rename',
                    label: 'Rename',
                    onSelect: () => {
                      setDraft(s.title)
                      setEditing(s.id)
                    }
                  },
                  'divider',
                  {
                    key: 'delete',
                    label: 'Delete',
                    danger: true,
                    onSelect: () => confirm(`Delete "${s.title}"? This removes it from LocalClaude.`) && props.onDelete(s.id)
                  }
                ]}
              />
            </div>
          </>
        )}
      </div>
    )
  }

  return (
    <aside className={'sidebar' + (props.open ? '' : ' collapsed') + (props.overlay ? ' overlay' : '')} aria-hidden={!props.open}>
      <div className="side-titlebar">
        <Menu
          className="no-drag"
          title="Menu"
          trigger={<Icon name="menu" size={18} />}
          entries={[
            { key: 'new', label: 'New chat', hint: 'Ctrl+N', onSelect: props.onNew },
            { key: 'settings', label: 'Settings', hint: 'Ctrl+,', onSelect: props.onSettings },
            { key: 'sidebar', label: 'Hide sidebar', hint: 'Ctrl+B', onSelect: props.onCollapse }
          ]}
        />
        <button className="icon-btn no-drag" onClick={props.onCollapse} title="Hide sidebar (Ctrl+B)">
          <Icon name="sidebar" size={18} />
        </button>
        <button className="icon-btn no-drag" disabled={!props.canBack} onClick={props.onBack} title="Back">
          <Icon name="back" size={18} />
        </button>
        <button className="icon-btn no-drag" disabled={!props.canForward} onClick={props.onForward} title="Forward">
          <Icon name="forward" size={18} />
        </button>
      </div>

      <div className="side-search">
        <Icon name="search" size={15} />
        <input placeholder="Search" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <button className="side-new" onClick={props.onNew} title="New chat (Ctrl+N)">
        <span className="side-new-icon">
          <Icon name="plus" size={14} />
        </span>
        New
      </button>
      <button className={'side-nav' + (props.projectsActive ? ' active' : '')} onClick={props.onProjects}>
        <Icon name="folder" size={16} />
        Projects
      </button>

      <nav className="session-list">
        {pinned.length > 0 && (
          <div>
            <div className="group-label">Pinned</div>
            {pinned.map(item)}
          </div>
        )}
        {groups.map(([label, items]) => (
          <div key={label}>
            <div className="group-label">{label}</div>
            {items.map(item)}
          </div>
        ))}
        {!props.sessions.length && <div className="muted small pad">No chats yet.</div>}
      </nav>

      <div className="side-account">
        <Menu
          className="account-menu"
          direction="up"
          trigger={
            <>
              <span className="avatar">{name.slice(0, 1).toUpperCase()}</span>
              <span className="account-name">{name}</span>
              {plan && <span className="muted">· {plan}</span>}
              <Icon name="chevronDown" size={14} className="muted" />
            </>
          }
          entries={[
            { section: props.auth.email ?? 'Signed in' },
            { key: 'settings', label: 'Settings', onSelect: props.onSettings },
            'divider',
            { key: 'signout', label: 'Sign out', onSelect: props.onSignOut }
          ]}
        />
        <button className="icon-btn" onClick={props.onSettings} title="Settings (Ctrl+,)">
          <Icon name="grid" size={17} />
        </button>
      </div>
    </aside>
  )
}

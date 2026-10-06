import { useMemo, useState, type ReactNode } from 'react'
import type { AuthStatus, Project, SessionMeta } from '../../../shared/types'
import type { SessionRuntime } from '../App'
import { Icon } from './Icon'
import { Menu, type MenuEntry } from './Menu'

const RECENT = ['Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days']

function groupLabel(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const startOfDay = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000)
  if (days <= 0) return RECENT[0]
  if (days === 1) return RECENT[1]
  if (days < 7) return RECENT[2]
  if (days < 30) return RECENT[3]
  return d.toLocaleString(undefined, { month: 'long', year: 'numeric' })
}

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

// Which sidebar sections are collapsed, per viewer. Older month groups start collapsed.
const PREFS = 'sidebar.sections'
function loadPrefs(): { collapsed: Record<string, boolean>; hideProjectChats: boolean } {
  try {
    return { collapsed: {}, hideProjectChats: false, ...JSON.parse(localStorage.getItem(PREFS) ?? '{}') }
  } catch {
    return { collapsed: {}, hideProjectChats: false }
  }
}
function savePrefs(p: { collapsed: Record<string, boolean>; hideProjectChats: boolean }): void {
  try {
    localStorage.setItem(PREFS, JSON.stringify(p))
  } catch {
    /* per-viewer convenience only */
  }
}

/** A collapsible sidebar section, like the Claude app's Pinned / Today / Yesterday groups. */
function Section(props: { label: string; open: boolean; count: number; onToggle: () => void; extra?: ReactNode; children: ReactNode }) {
  return (
    <div className={'side-section' + (props.open ? '' : ' closed')}>
      <div className="group-row">
        <button className="group-label" onClick={props.onToggle} aria-expanded={props.open} title={props.open ? 'Collapse' : 'Expand'}>
          <span>{props.label}</span>
          {!props.open && <span className="group-count">{props.count}</span>}
          <Icon name="chevron" size={12} className={'chev-i' + (props.open ? ' open' : '')} />
        </button>
        {props.extra}
      </div>
      {props.open && props.children}
    </div>
  )
}

export function Sidebar(props: {
  open: boolean
  /** narrow window: slide over the chat instead of taking space */
  overlay: boolean
  onCollapse: () => void
  sessions: SessionMeta[]
  projects: Project[]
  activeId: string | null
  activeProjectId: string | null
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
  onExportChat: (id: string) => void
  projectsActive: boolean
  onProjects: () => void
  onOpenProject: (id: string) => void
  onPinProject: (id: string, pinned: boolean) => void
  onExportAll: () => void
  onImport: () => void
  onSettings: () => void
  onSignOut: () => void
}) {
  const [filter, setFilter] = useState('')
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [prefs, setPrefs] = useState(loadPrefs)

  const update = (next: typeof prefs): void => {
    setPrefs(next)
    savePrefs(next)
  }
  const searching = filter.trim().length > 0
  // While searching, every section is open so nothing is hidden.
  const isOpen = (label: string): boolean => {
    const collapsedByDefault = !RECENT.includes(label) && label !== 'Pinned'
    return searching || !(prefs.collapsed[label] ?? collapsedByDefault)
  }
  const toggle = (label: string): void => update({ ...prefs, collapsed: { ...prefs.collapsed, [label]: isOpen(label) } })

  const { pinnedChats, pinnedProjects, groups } = useMemo(() => {
    const f = filter.trim().toLowerCase()
    const match = (s: SessionMeta): boolean => !f || s.title.toLowerCase().includes(f) || s.cwd.toLowerCase().includes(f)
    const pinnedChats = props.sessions.filter((s) => s.pinned && match(s))
    const pinnedProjects = props.projects.filter((p) => p.pinned && (!f || p.name.toLowerCase().includes(f)))
    const out: [string, SessionMeta[]][] = []
    for (const s of props.sessions) {
      if (s.pinned || !match(s)) continue
      if (prefs.hideProjectChats && s.projectId && !f) continue
      const g = groupLabel(s.updatedAt)
      const last = out[out.length - 1]
      if (last && last[0] === g) last[1].push(s)
      else out.push([g, [s]])
    }
    return { pinnedChats, pinnedProjects, groups: out }
  }, [props.sessions, props.projects, filter, prefs.hideProjectChats])

  const name = props.auth.email ? props.auth.email.split('@')[0] : 'You'
  const plan = props.auth.subscriptionType ? cap(props.auth.subscriptionType) : ''
  const projectName = (id?: string): string | undefined => (id ? props.projects.find((p) => p.id === id)?.name : undefined)

  const chatItem = (s: SessionMeta) => {
    const rt = props.runtime[s.id]
    const busy = rt?.status === 'running' || rt?.status === 'starting'
    const pend = props.pending[s.id]
    const proj = projectName(s.projectId)
    return (
      <div
        key={s.id}
        className={'session-item' + (s.id === props.activeId ? ' active' : '')}
        onClick={() => props.onSelect(s.id)}
        title={proj ? `${s.title}\nProject: ${proj}` : s.title}
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
            {pend ? (
              <span className="badge warn">{pend}</span>
            ) : busy ? (
              <span className="dot-pulse" />
            ) : s.artifactCount ? (
              <span className="item-icon" title={`${s.artifactCount} artifact${s.artifactCount === 1 ? '' : 's'}`}>
                <Icon name="file" size={14} />
              </span>
            ) : null}
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
                  { key: 'export', label: 'Export as Markdown…', onSelect: () => props.onExportChat(s.id) },
                  ...(proj && s.projectId ? [{ key: 'proj', label: `Open project “${proj}”`, onSelect: () => props.onOpenProject(s.projectId!) }] : []),
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

  const projectItem = (p: Project) => (
    <div
      key={p.id}
      className={'session-item project-item' + (p.id === props.activeProjectId ? ' active' : '')}
      onClick={() => props.onOpenProject(p.id)}
      title={p.description || p.name}
    >
      <span className="item-lead">
        <Icon name="project" size={15} />
      </span>
      <span className="session-title">{p.name}</span>
      <div className="more" onClick={(e) => e.stopPropagation()}>
        <Menu
          title="Project options"
          align="right"
          trigger={<span className="more-dots">⋯</span>}
          entries={[
            { key: 'open', label: 'Open project', onSelect: () => props.onOpenProject(p.id) },
            { key: 'unpin', label: 'Unpin', onSelect: () => props.onPinProject(p.id, false) }
          ]}
        />
      </div>
    </div>
  )

  const viewMenu: MenuEntry[] = [
    { key: 'collapse', label: 'Collapse all groups', onSelect: () => update({ ...prefs, collapsed: Object.fromEntries(['Pinned', ...groups.map((g) => g[0])].map((l) => [l, true])) }) },
    { key: 'expand', label: 'Expand all groups', onSelect: () => update({ ...prefs, collapsed: Object.fromEntries(['Pinned', ...groups.map((g) => g[0])].map((l) => [l, false])) }) },
    'divider',
    {
      key: 'hide',
      label: 'Hide chats that are in projects',
      checked: prefs.hideProjectChats,
      onSelect: () => update({ ...prefs, hideProjectChats: !prefs.hideProjectChats })
    }
  ]
  const pinnedCount = pinnedChats.length + pinnedProjects.length

  return (
    <aside className={'sidebar' + (props.open ? '' : ' collapsed') + (props.overlay ? ' overlay' : '')} aria-hidden={!props.open}>
      <div className="side-titlebar">
        <Menu
          className="no-drag"
          title="Menu"
          trigger={<Icon name="menu" size={18} />}
          entries={[
            { key: 'new', label: 'New chat', hint: 'Ctrl+N', onSelect: props.onNew },
            { key: 'projects', label: 'Projects', onSelect: props.onProjects },
            'divider',
            { key: 'export', label: 'Export all chats…', hint: 'Markdown + artifacts + projects, as a ZIP', onSelect: props.onExportAll },
            { key: 'import', label: 'Import from an export…', onSelect: props.onImport },
            'divider',
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
        {searching && (
          <button className="icon-btn" onClick={() => setFilter('')} title="Clear search">
            <Icon name="x" size={13} />
          </button>
        )}
      </div>
      <button className="side-new" onClick={props.onNew} title="New chat (Ctrl+N)">
        <span className="side-new-icon">
          <Icon name="plus" size={14} />
        </span>
        New
      </button>
      <button className={'side-nav' + (props.projectsActive ? ' active' : '')} onClick={props.onProjects}>
        <Icon name="project" size={16} />
        Projects
      </button>

      <nav className="session-list">
        {pinnedCount > 0 && (
          <Section label="Pinned" open={isOpen('Pinned')} count={pinnedCount} onToggle={() => toggle('Pinned')}>
            {pinnedProjects.map(projectItem)}
            {pinnedChats.map(chatItem)}
          </Section>
        )}
        {groups.map(([label, items], i) => (
          <Section
            key={label}
            label={label}
            open={isOpen(label)}
            count={items.length}
            onToggle={() => toggle(label)}
            extra={
              i === 0 ? (
                <Menu className="group-menu" align="right" title="View options" trigger={<Icon name="sliders" size={14} />} entries={viewMenu} />
              ) : undefined
            }
          >
            {items.map(chatItem)}
          </Section>
        ))}
        {searching && !groups.length && !pinnedCount && <div className="muted small pad">No chats match “{filter.trim()}”.</div>}
        {!props.sessions.length && <div className="muted small pad">No chats yet.</div>}
        {prefs.hideProjectChats && !searching && (
          <button className="link-btn side-hint" onClick={() => update({ ...prefs, hideProjectChats: false })}>
            Chats in projects are hidden · show them
          </button>
        )}
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
            { key: 'export', label: 'Export all chats…', onSelect: props.onExportAll },
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

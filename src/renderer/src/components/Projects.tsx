import { useEffect, useState, type ReactNode } from 'react'
import type { Project, SessionMeta } from '../../../shared/types'
import { api } from '../api'
import { Icon } from './Icon'
import { Menu } from './Menu'

const ago = (ts: number): string => {
  const m = Math.round((Date.now() - ts) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`
  const d = Math.round(h / 24)
  return d < 30 ? `${d} day${d === 1 ? '' : 's'} ago` : new Date(ts).toLocaleDateString()
}
const kb = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

function TitleBar({ left, children }: { left: ReactNode; children?: ReactNode }) {
  return (
    <header className="titlebar">
      {left}
      {children}
      <div className="grow" />
      <div className="wco-space" />
    </header>
  )
}

/** All projects, like the Claude app's Projects page. */
export function ProjectsView(props: {
  projects: Project[]
  sessions: SessionMeta[]
  headerLeft: ReactNode
  onOpen: (id: string) => void
  onCreated: (p: Project) => void
}) {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [filter, setFilter] = useState('')
  const shown = props.projects.filter((p) => !filter.trim() || (p.name + ' ' + p.description).toLowerCase().includes(filter.trim().toLowerCase()))

  const create = async (): Promise<void> => {
    if (!name.trim()) return
    const p = await api.createProject({ name, description: desc })
    setCreating(false)
    setName('')
    setDesc('')
    props.onCreated(p)
  }

  return (
    <div className="page">
      <TitleBar left={props.headerLeft} />
      <div className="page-scroll">
        <div className="page-inner">
          <div className="page-head">
            <h1>Projects</h1>
            <button className="btn primary" onClick={() => setCreating(true)}>
              <Icon name="plus" size={15} /> New project
            </button>
          </div>
          {creating && (
            <div className="project-form">
              <label className="small">What are you working on?</label>
              <input className="input" autoFocus placeholder="Name your project" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void create()} />
              <label className="small">What are you trying to achieve?</label>
              <textarea className="input" rows={3} placeholder="Describe your project, goals, subject, etc." value={desc} onChange={(e) => setDesc(e.target.value)} />
              <div className="row gap end">
                <button className="btn ghost" onClick={() => setCreating(false)}>
                  Cancel
                </button>
                <button className="btn primary" disabled={!name.trim()} onClick={() => void create()}>
                  Create project
                </button>
              </div>
            </div>
          )}
          {props.projects.length > 0 && (
            <div className="side-search page-search">
              <Icon name="search" size={15} />
              <input placeholder="Search projects…" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
          )}
          <div className="project-grid">
            {shown.map((p) => {
              const chats = props.sessions.filter((s) => s.projectId === p.id).length
              return (
                <button key={p.id} className="project-card" onClick={() => props.onOpen(p.id)}>
                  <span className="project-card-name">{p.name}</span>
                  {p.description && <span className="project-card-desc">{p.description}</span>}
                  <span className="muted small">
                    {chats} chat{chats === 1 ? '' : 's'} · updated {ago(p.updatedAt)}
                  </span>
                </button>
              )
            })}
          </div>
          {!props.projects.length && !creating && (
            <div className="empty-projects muted">
              Projects keep related chats together with shared instructions and knowledge files, so Claude has the context every time.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** One project: start a chat, see its chats, edit instructions, knowledge and folder. */
export function ProjectView(props: {
  project: Project
  sessions: SessionMeta[]
  headerLeft: ReactNode
  defaultCwd: string
  onBack: () => void
  onChanged: (p: Project) => void
  onDeleted: () => void
  onOpenChat: (id: string) => void
  onStartChat: (text: string) => void
}) {
  const p = props.project
  const [text, setText] = useState('')
  const [instr, setInstr] = useState(p.instructions)
  const [editingInstr, setEditingInstr] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ name: string; description: string } | null>(null)
  useEffect(() => setInstr(p.instructions), [p.id, p.instructions])
  const chats = props.sessions.filter((s) => s.projectId === p.id)
  const used = p.files.reduce((n, f) => n + f.size, 0)

  const update = async (patch: Partial<Pick<Project, 'name' | 'description' | 'instructions' | 'cwd'>>): Promise<void> => props.onChanged(await api.updateProject(p.id, patch))

  return (
    <div className="page">
      <TitleBar left={props.headerLeft}>
        <button className="link-btn crumb no-drag" onClick={props.onBack}>
          Projects
        </button>
        <span className="muted">/</span>
        <span className="crumb-current">{p.name}</span>
      </TitleBar>
      <div className="page-scroll">
        <div className="project-layout">
          <section className="project-main">
            {renaming ? (
              <div className="project-form">
                <input className="input" value={renaming.name} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} />
                <textarea className="input" rows={2} value={renaming.description} onChange={(e) => setRenaming({ ...renaming, description: e.target.value })} />
                <div className="row gap end">
                  <button className="btn ghost" onClick={() => setRenaming(null)}>
                    Cancel
                  </button>
                  <button
                    className="btn primary"
                    disabled={!renaming.name.trim()}
                    onClick={() => {
                      void update({ name: renaming.name.trim(), description: renaming.description })
                      setRenaming(null)
                    }}
                  >
                    Save
                  </button>
                </div>
              </div>
            ) : (
              <div className="project-title-row">
                <div>
                  <h1>{p.name}</h1>
                  {p.description && <p className="muted">{p.description}</p>}
                </div>
                <Menu
                  align="right"
                  title="Project options"
                  trigger={<span className="more-dots">⋯</span>}
                  entries={[
                    { key: 'edit', label: 'Edit details', onSelect: () => setRenaming({ name: p.name, description: p.description }) },
                    'divider',
                    {
                      key: 'delete',
                      label: 'Delete project',
                      danger: true,
                      onSelect: () => {
                        if (!confirm(`Delete the project "${p.name}"? Its chats are kept and just leave the project.`)) return
                        void api.deleteProject(p.id).then(props.onDeleted)
                      }
                    }
                  ]}
                />
              </div>
            )}

            <div className="composer project-composer">
              <div className="prompt-row">
                <textarea
                  className="composer-input"
                  rows={2}
                  placeholder={`Start a chat in ${p.name}…`}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && text.trim()) {
                      e.preventDefault()
                      props.onStartChat(text.trim())
                    }
                  }}
                />
                <button className="send" disabled={!text.trim()} onClick={() => props.onStartChat(text.trim())} title="Send">
                  <Icon name="enter" size={18} />
                </button>
              </div>
            </div>

            <div className="project-chats">
              {chats.length === 0 && <div className="muted small">No chats in this project yet.</div>}
              {chats.map((s) => (
                <button key={s.id} className="project-chat" onClick={() => props.onOpenChat(s.id)}>
                  <span className="project-chat-title">{s.title}</span>
                  <span className="muted small">Last message {ago(s.updatedAt)}</span>
                </button>
              ))}
            </div>
          </section>

          <aside className="project-side">
            <div className="side-card">
              <div className="side-card-head">
                <span>Instructions</span>
                {!editingInstr && (
                  <button className="link-btn" onClick={() => setEditingInstr(true)}>
                    {p.instructions ? 'Edit' : 'Add'}
                  </button>
                )}
              </div>
              {editingInstr ? (
                <>
                  <textarea
                    className="input"
                    rows={8}
                    autoFocus
                    placeholder="How should Claude respond in this project? e.g. tone, format, background, rules."
                    value={instr}
                    onChange={(e) => setInstr(e.target.value)}
                  />
                  <div className="row gap end">
                    <button
                      className="btn ghost"
                      onClick={() => {
                        setInstr(p.instructions)
                        setEditingInstr(false)
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      className="btn primary"
                      onClick={() => {
                        void update({ instructions: instr })
                        setEditingInstr(false)
                      }}
                    >
                      Save
                    </button>
                  </div>
                </>
              ) : (
                <div className={'side-card-body' + (p.instructions ? '' : ' muted')}>
                  {p.instructions || 'Add instructions to tailor Claude’s responses in every chat in this project.'}
                </div>
              )}
            </div>

            <div className="side-card">
              <div className="side-card-head">
                <span>Knowledge</span>
                <button
                  className="link-btn"
                  onClick={async () => {
                    const paths = await api.pickFiles()
                    if (!paths.length) return
                    const r = await api.addProjectFiles(p.id, paths)
                    props.onChanged(r.project)
                    setNotice(r.skipped.length ? `Skipped: ${r.skipped.join(', ')}` : null)
                  }}
                >
                  + Add files
                </button>
              </div>
              {p.files.length === 0 ? (
                <div className="side-card-body muted">Add text files (docs, notes, code, CSV, JSON…). Claude reads them in every chat in this project.</div>
              ) : (
                <ul className="knowledge-list">
                  {p.files.map((f) => (
                    <li key={f.id}>
                      <Icon name="file" size={15} />
                      <span className="knowledge-name" title={f.name}>
                        {f.name}
                      </span>
                      <span className="muted small">{kb(f.size)}</span>
                      <button className="icon-btn" title="Remove" onClick={async () => props.onChanged(await api.removeProjectFile(p.id, f.id))}>
                        <Icon name="x" size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {used > 0 && <div className="muted small">{kb(used)} of knowledge · sent with each chat in this project</div>}
              {notice && <div className="notice small">{notice}</div>}
            </div>

            <div className="side-card">
              <div className="side-card-head">
                <span>Folder</span>
                <button
                  className="link-btn"
                  onClick={async () => {
                    const d = await api.pickFolder('Working folder for chats in this project')
                    if (d) void update({ cwd: d })
                  }}
                >
                  Change
                </button>
              </div>
              <div className="side-card-body mono small">{p.cwd || props.defaultCwd}</div>
              <div className="muted small">New chats in this project work in this folder.</div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}

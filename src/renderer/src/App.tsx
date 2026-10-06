import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { applyEvent } from '../../shared/reducer'
import type {
  AgentEvent,
  Artifact,
  AppSettings,
  AuthStatus,
  ChatMessage,
  ContextUsage,
  InitInfo,
  LockStatus,
  McpStatus,
  PermissionRequest,
  Project,
  RateLimitInfo,
  SessionMeta,
  SlashCommandInfo,
  TurnStats
} from '../../shared/types'
import { api } from './api'
import { applyFonts } from './fonts'
import { ChatView } from './components/ChatView'
import { LockScreen } from './components/LockScreen'
import { LoginScreen } from './components/LoginScreen'
import { ProjectView, ProjectsView } from './components/Projects'
import type { TranscriptMode } from './components/MessageView'
import { SettingsDialog } from './components/SettingsDialog'
import { Sidebar } from './components/Sidebar'
import { Icon } from './components/Icon'
import { Spark } from './components/Spark'

export interface SessionRuntime {
  status: 'idle' | 'running' | 'starting'
  init?: InitInfo
  lastStats?: TurnStats
  context?: ContextUsage
  commands?: SlashCommandInfo[]
  mcp?: McpStatus[]
  /** when the current turn started (for the working timer) */
  turnStartedAt?: number
}

const NARROW = '(max-width: 900px)'

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* per-viewer convenience only */
  }
}

/** Sidebar open/closed. Wide windows remember it; narrow windows start closed and open as an overlay. */
function useSidebar(): { open: boolean; narrow: boolean; toggle: () => void; close: () => void } {
  const mq = useMemo(() => window.matchMedia(NARROW), [])
  const [narrow, setNarrow] = useState(mq.matches)
  const [open, setOpen] = useState(() => !mq.matches && readPref('sidebar') !== 'closed')
  useEffect(() => {
    const onChange = (e: MediaQueryListEvent): void => {
      setNarrow(e.matches)
      setOpen(!e.matches && readPref('sidebar') !== 'closed')
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [mq])
  const toggle = useCallback(() => {
    setOpen((o) => {
      if (!narrow) writePref('sidebar', o ? 'closed' : 'open')
      return !o
    })
  }, [narrow])
  const close = useCallback(() => {
    if (narrow) setOpen(false)
  }, [narrow])
  return { open, narrow, toggle, close }
}

function loadTranscriptMode(): TranscriptMode {
  try {
    return localStorage.getItem('transcript') === 'verbose' ? 'verbose' : 'normal'
  } catch {
    return 'normal'
  }
}

function useTheme(theme: AppSettings['theme'] | undefined): void {
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      const dark = theme === 'dark' || (theme !== 'light' && mq.matches)
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
      void api.setWindowTheme(dark)
    }
    apply()
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [theme])
}

export default function App() {
  const [lock, setLock] = useState<LockStatus | null>(null)
  const [auth, setAuth] = useState<AuthStatus | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [sessions, setSessions] = useState<SessionMeta[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [histories, setHistories] = useState<Record<string, ChatMessage[]>>({})
  const [runtime, setRuntime] = useState<Record<string, SessionRuntime>>({})
  const [permissions, setPermissions] = useState<PermissionRequest[]>([])
  const [rateLimit, setRateLimit] = useState<RateLimitInfo | null>(null)
  const [settingsOpen, setSettingsOpen] = useState<false | string>(false)
  const [transcript, setTranscriptState] = useState<TranscriptMode>(loadTranscriptMode)
  const sidebar = useSidebar()
  const [page, setPage] = useState<{ kind: 'chat' } | { kind: 'projects' } | { kind: 'project'; id: string }>({ kind: 'chat' })
  const [projects, setProjects] = useState<Project[]>([])
  const [artifacts, setArtifacts] = useState<Record<string, Artifact[]>>({})
  /** the artifact Claude touched most recently, so the chat can open it in the side panel */
  const [lastArtifact, setLastArtifact] = useState<{ sessionId: string; id: string; at: number } | null>(null)
  const loaded = useRef(new Set<string>())
  // back/forward through chats you opened, like the Claude app
  const nav = useRef<{ stack: string[]; i: number }>({ stack: [], i: -1 })
  const [, bumpNav] = useState(0)
  const openChat = useCallback((id: string | null) => {
    setActiveId(id)
    setPage({ kind: 'chat' })
    if (!id) return
    const n = nav.current
    if (n.stack[n.i] === id) return
    n.stack = [...n.stack.slice(0, n.i + 1), id]
    n.i = n.stack.length - 1
    bumpNav((x) => x + 1)
  }, [])
  const stepNav = useCallback((d: -1 | 1) => {
    const n = nav.current
    const i = n.i + d
    if (i < 0 || i >= n.stack.length) return
    n.i = i
    setActiveId(n.stack[i])
    setPage({ kind: 'chat' })
    bumpNav((x) => x + 1)
  }, [])

  const setTranscript = useCallback((m: TranscriptMode) => {
    setTranscriptState(m)
    writePref('transcript', m)
  }, [])

  useTheme(settings?.theme)
  useEffect(() => {
    if (settings) applyFonts(settings)
  }, [settings?.replyFont, settings?.uiFont])

  const refreshAuth = useCallback(async () => setAuth(await api.authStatus()), [])

  // ---- boot: lock → settings/sessions → auth
  const boot = useCallback(async () => {
    const l = await api.lockStatus()
    setLock(l)
    if (!l.ok) return
    const [s, list, projs] = await Promise.all([api.getSettings(), api.listSessions(), api.listProjects()])
    setSettings(s)
    setSessions(list)
    setProjects(projs)
    if (list.length) setActiveId((cur) => cur ?? list[0].id)
    if (list.length && nav.current.i < 0) nav.current = { stack: [list[0].id], i: 0 }
    void refreshAuth()
  }, [refreshAuth])

  useEffect(() => {
    void boot()
  }, [boot])

  // ---- live agent events
  useEffect(() => {
    return api.onEvent((e: AgentEvent) => {
      switch (e.type) {
        case 'status':
          setRuntime((r) => {
            const cur = r[e.sessionId]
            const wasIdle = !cur || cur.status === 'idle'
            const turnStartedAt = e.status === 'idle' ? undefined : wasIdle ? Date.now() : cur.turnStartedAt
            return { ...r, [e.sessionId]: { ...cur, status: e.status, turnStartedAt } }
          })
          return
        case 'context':
          setRuntime((r) => ({ ...r, [e.sessionId]: { ...(r[e.sessionId] ?? { status: 'idle' }), context: e.usage } }))
          return
        case 'commands':
          setRuntime((r) => ({ ...r, [e.sessionId]: { ...(r[e.sessionId] ?? { status: 'idle' }), commands: e.commands } }))
          return
        case 'mcp-status':
          setRuntime((r) => ({ ...r, [e.sessionId]: { ...(r[e.sessionId] ?? { status: 'idle' }), mcp: e.servers } }))
          return
        case 'init':
          setRuntime((r) => ({ ...r, [e.sessionId]: { ...r[e.sessionId], status: r[e.sessionId]?.status ?? 'running', init: e.info } }))
          return
        case 'meta':
          setSessions((list) => {
            const i = list.findIndex((s) => s.id === e.meta.id)
            const next = i >= 0 ? list.map((s) => (s.id === e.meta.id ? e.meta : s)) : [e.meta, ...list]
            return next.sort((a, b) => b.updatedAt - a.updatedAt)
          })
          return
        case 'permission':
          setPermissions((p) => [...p, e.request])
          return
        case 'permission-cancel':
          setPermissions((p) => p.filter((x) => x.requestId !== e.requestId))
          return
        case 'rate-limit':
          setRateLimit(e.info)
          return
        case 'sdk-session':
          return
        case 'artifact':
          setArtifacts((all) => {
            const list = all[e.sessionId] ?? []
            const i = list.findIndex((a) => a.id === e.artifact.id)
            return { ...all, [e.sessionId]: i >= 0 ? list.map((a) => (a.id === e.artifact.id ? e.artifact : a)) : [...list, e.artifact] }
          })
          setLastArtifact({ sessionId: e.sessionId, id: e.artifact.id, at: Date.now() })
          return
        case 'account':
          setAuth((a) => (a ? { ...a, email: e.email ?? a.email, subscriptionType: e.subscriptionType ?? a.subscriptionType } : a))
          return
        default:
          break
      }
      if ('sessionId' in e) {
        if (e.type === 'turn-done') setRuntime((r) => ({ ...r, [e.sessionId]: { ...r[e.sessionId], status: 'idle', lastStats: e.stats } }))
        setHistories((h) => (h[e.sessionId] ? { ...h, [e.sessionId]: applyEvent(h[e.sessionId], e) } : h))
      }
    })
  }, [])

  // ---- load history when a chat is opened
  useEffect(() => {
    if (!activeId || loaded.current.has(activeId)) return
    loaded.current.add(activeId)
    void Promise.all([api.history(activeId), api.isRunning(activeId), api.listArtifacts(activeId)]).then(([h, running, arts]) => {
      setHistories((cur) => ({ ...cur, [activeId]: cur[activeId] ?? h }))
      setArtifacts((cur) => ({ ...cur, [activeId]: cur[activeId] ?? arts }))
      if (running) setRuntime((r) => ({ ...r, [activeId]: { ...r[activeId], status: 'running' } }))
    })
  }, [activeId])

  const newChat = useCallback(async (cwd?: string, projectId?: string) => {
    const meta = await api.createSession(cwd, projectId)
    loaded.current.add(meta.id)
    setHistories((h) => ({ ...h, [meta.id]: [] }))
    setSessions((list) => [meta, ...list])
    openChat(meta.id)
    return meta
  }, [openChat])

  const deleteChat = useCallback(
    async (id: string) => {
      await api.deleteSession(id)
      loaded.current.delete(id)
      setSessions((list) => {
        const next = list.filter((s) => s.id !== id)
        if (activeId === id) setActiveId(next[0]?.id ?? null)
        nav.current.stack = nav.current.stack.filter((x) => x !== id)
        nav.current.i = Math.min(nav.current.i, nav.current.stack.length - 1)
        return next
      })
      setPermissions((p) => p.filter((x) => x.sessionId !== id))
    },
    [activeId]
  )

  const renameChat = useCallback(async (id: string, title: string) => {
    const meta = await api.updateSession(id, { title })
    setSessions((list) => list.map((s) => (s.id === id ? meta : s)))
  }, [])

  const pinChat = useCallback(async (id: string, pinned: boolean) => {
    const meta = await api.updateSession(id, { pinned })
    setSessions((list) => list.map((s) => (s.id === id ? meta : s)))
  }, [])

  const upsertProject = useCallback((p: Project) => {
    setProjects((list) => (list.some((x) => x.id === p.id) ? list.map((x) => (x.id === p.id ? p : x)) : [p, ...list]))
  }, [])

  const moveChat = useCallback(async (id: string, projectId: string | undefined) => {
    const meta = await api.updateSession(id, { projectId })
    setSessions((list) => list.map((s) => (s.id === id ? meta : s)))
  }, [])

  const signOut = useCallback(async () => {
    await api.logout()
    setSettingsOpen(false)
    await refreshAuth()
  }, [refreshAuth])

  const updateSettings = useCallback(async (patch: Partial<AppSettings>) => {
    setSettings(await api.setSettings(patch))
  }, [])

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        void newChat()
      } else if (mod && e.key === ',') {
        e.preventDefault()
        setSettingsOpen('general')
      } else if (mod && e.key.toLowerCase() === 'o') {
        e.preventDefault()
        setTranscript(transcript === 'verbose' ? 'normal' : 'verbose')
      } else if (mod && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        sidebar.toggle()
      } else if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault()
        stepNav(e.key === 'ArrowLeft' ? -1 : 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newChat, transcript, setTranscript, sidebar, stepNav])

  if (!lock) return <div className="splash">Opening…</div>
  if (!lock.ok)
    return (
      <LockScreen
        lock={lock}
        onReset={async () => {
          await api.resetData()
          loaded.current.clear()
          setHistories({})
          setActiveId(null)
          await boot()
        }}
      />
    )
  if (!settings || !auth) return <div className="splash">Checking your Claude sign-in…</div>
  if (!auth.loggedIn) return <LoginScreen auth={auth} onDone={refreshAuth} />

  const active = sessions.find((s) => s.id === activeId) ?? null
  const pendingBySession: Record<string, number> = {}
  for (const p of permissions) pendingBySession[p.sessionId] = (pendingBySession[p.sessionId] ?? 0) + 1

  const canBack = nav.current.i > 0
  const canForward = nav.current.i < nav.current.stack.length - 1
  // Shown in the chat's top bar while the sidebar is hidden.
  const headerLeft = !sidebar.open && (
    <div className="header-actions no-drag">
      <button className="icon-btn" onClick={sidebar.toggle} title="Show sidebar (Ctrl+B)">
        <Icon name="sidebar" size={18} />
      </button>
      <button className="icon-btn" disabled={!canBack} onClick={() => stepNav(-1)} title="Back (Alt+←)">
        <Icon name="back" size={18} />
      </button>
      <button className="icon-btn" disabled={!canForward} onClick={() => stepNav(1)} title="Forward (Alt+→)">
        <Icon name="forward" size={18} />
      </button>
      <button className="icon-btn" onClick={() => void newChat()} title="New chat (Ctrl+N)">
        <Icon name="compose" size={17} />
      </button>
    </div>
  )

  return (
    <div className={'app' + (sidebar.narrow ? ' narrow' : '')}>
      {sidebar.open && sidebar.narrow && <div className="sidebar-backdrop" onClick={sidebar.toggle} />}
      <Sidebar
        open={sidebar.open}
        overlay={sidebar.narrow}
        onCollapse={sidebar.toggle}
        sessions={sessions}
        activeId={activeId}
        runtime={runtime}
        pending={pendingBySession}
        auth={auth}
        canBack={canBack}
        canForward={canForward}
        onBack={() => stepNav(-1)}
        onForward={() => stepNav(1)}
        onPin={(id, p) => void pinChat(id, p)}
        projectsActive={page.kind !== 'chat'}
        onProjects={() => {
          setPage({ kind: 'projects' })
          sidebar.close()
        }}
        onSignOut={() => void signOut()}
        onSelect={(id) => {
          openChat(id)
          sidebar.close()
        }}
        onNew={() => {
          void newChat()
          sidebar.close()
        }}
        onDelete={(id) => void deleteChat(id)}
        onRename={(id, t) => void renameChat(id, t)}
        onSettings={() => setSettingsOpen('general')}
      />
      <main className="main">
        {page.kind === 'projects' ? (
          <ProjectsView
            projects={projects}
            sessions={sessions}
            headerLeft={headerLeft}
            onOpen={(id) => setPage({ kind: 'project', id })}
            onCreated={(p) => {
              upsertProject(p)
              setPage({ kind: 'project', id: p.id })
            }}
          />
        ) : page.kind === 'project' && projects.some((p) => p.id === page.id) ? (
          <ProjectView
            key={page.id}
            project={projects.find((p) => p.id === page.id)!}
            sessions={sessions}
            headerLeft={headerLeft}
            defaultCwd={settings.defaultCwd}
            onBack={() => setPage({ kind: 'projects' })}
            onChanged={upsertProject}
            onDeleted={() => {
              setProjects((list) => list.filter((p) => p.id !== page.id))
              setSessions((list) => list.map((s) => (s.projectId === page.id ? { ...s, projectId: undefined } : s)))
              setPage({ kind: 'projects' })
            }}
            onOpenChat={openChat}
            onStartChat={(text) =>
              void newChat(undefined, page.id).then((meta) => api.send({ sessionId: meta.id, text, attachments: [] }))
            }
          />
        ) : active ? (
          <ChatView
            key={active.id}
            meta={active}
            history={histories[active.id] ?? []}
            runtime={runtime[active.id] ?? { status: 'idle' }}
            permission={permissions.find((p) => p.sessionId === active.id) ?? null}
            settings={settings}
            rateLimit={rateLimit}
            transcript={transcript}
            onTranscript={setTranscript}
            onPermissionDone={(rid) => setPermissions((p) => p.filter((x) => x.requestId !== rid))}
            onMeta={(m) => setSessions((list) => list.map((s) => (s.id === m.id ? m : s)))}
            onOpenSettings={(tab) => setSettingsOpen(tab)}
            headerLeft={headerLeft}
            artifacts={artifacts[active.id] ?? []}
            lastArtifact={lastArtifact?.sessionId === active.id ? lastArtifact : null}
            project={projects.find((p) => p.id === active.projectId)}
            projects={projects}
            onOpenProject={(id) => setPage({ kind: 'project', id })}
            onMoveToProject={(pid) => void moveChat(active.id, pid)}
            onSettings={updateSettings}
            onRename={(t) => void renameChat(active.id, t)}
            onPin={(p) => void pinChat(active.id, p)}
            onDelete={() => void deleteChat(active.id)}
          />
        ) : (
          <div className="empty-main">
            <div className="titlebar floating">{headerLeft}</div>
            <Spark size={44} className="welcome-spark" />
            <h1>What should we work on?</h1>
            <p>Claude can read and edit your files, run commands, browse and use your tools — all on this machine.</p>
            <button className="btn primary" onClick={() => void newChat()}>
              Start a new chat
            </button>
          </div>
        )}
      </main>
      {settingsOpen && (
        <SettingsDialog
          tab={settingsOpen}
          settings={settings}
          auth={auth}
          onTab={setSettingsOpen}
          onChange={updateSettings}
          onClose={() => setSettingsOpen(false)}
          onLogout={signOut}
        />
      )}
    </div>
  )
}

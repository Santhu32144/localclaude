import { useCallback, useEffect, useRef, useState } from 'react'
import { applyEvent } from '../../shared/reducer'
import type { AgentEvent, AppSettings, AuthStatus, ChatMessage, InitInfo, LockStatus, PermissionRequest, RateLimitInfo, SessionMeta, TurnStats } from '../../shared/types'
import { api } from './api'
import { ChatView } from './components/ChatView'
import { LockScreen } from './components/LockScreen'
import { LoginScreen } from './components/LoginScreen'
import { SettingsDialog } from './components/SettingsDialog'
import { Sidebar } from './components/Sidebar'

export interface SessionRuntime {
  status: 'idle' | 'running' | 'starting'
  init?: InitInfo
  lastStats?: TurnStats
}

function useTheme(theme: AppSettings['theme'] | undefined): void {
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (): void => {
      const dark = theme === 'dark' || (theme !== 'light' && mq.matches)
      document.documentElement.dataset.theme = dark ? 'dark' : 'light'
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
  const loaded = useRef(new Set<string>())

  useTheme(settings?.theme)

  const refreshAuth = useCallback(async () => setAuth(await api.authStatus()), [])

  // ---- boot: lock → settings/sessions → auth
  const boot = useCallback(async () => {
    const l = await api.lockStatus()
    setLock(l)
    if (!l.ok) return
    const [s, list] = await Promise.all([api.getSettings(), api.listSessions()])
    setSettings(s)
    setSessions(list)
    if (list.length) setActiveId((cur) => cur ?? list[0].id)
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
          setRuntime((r) => ({ ...r, [e.sessionId]: { ...r[e.sessionId], status: e.status } }))
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
    void Promise.all([api.history(activeId), api.isRunning(activeId)]).then(([h, running]) => {
      setHistories((cur) => ({ ...cur, [activeId]: cur[activeId] ?? h }))
      if (running) setRuntime((r) => ({ ...r, [activeId]: { ...r[activeId], status: 'running' } }))
    })
  }, [activeId])

  const newChat = useCallback(async (cwd?: string) => {
    const meta = await api.createSession(cwd)
    loaded.current.add(meta.id)
    setHistories((h) => ({ ...h, [meta.id]: [] }))
    setSessions((list) => [meta, ...list])
    setActiveId(meta.id)
  }, [])

  const deleteChat = useCallback(
    async (id: string) => {
      await api.deleteSession(id)
      loaded.current.delete(id)
      setSessions((list) => {
        const next = list.filter((s) => s.id !== id)
        if (activeId === id) setActiveId(next[0]?.id ?? null)
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
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newChat])

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

  return (
    <div className="app">
      <Sidebar
        sessions={sessions}
        activeId={activeId}
        runtime={runtime}
        pending={pendingBySession}
        auth={auth}
        onSelect={setActiveId}
        onNew={() => void newChat()}
        onDelete={(id) => void deleteChat(id)}
        onRename={(id, t) => void renameChat(id, t)}
        onSettings={() => setSettingsOpen('general')}
      />
      <main className="main">
        {active ? (
          <ChatView
            key={active.id}
            meta={active}
            history={histories[active.id] ?? []}
            runtime={runtime[active.id] ?? { status: 'idle' }}
            permission={permissions.find((p) => p.sessionId === active.id) ?? null}
            settings={settings}
            rateLimit={rateLimit}
            onPermissionDone={(rid) => setPermissions((p) => p.filter((x) => x.requestId !== rid))}
            onMeta={(m) => setSessions((list) => list.map((s) => (s.id === m.id ? m : s)))}
            onOpenSettings={(tab) => setSettingsOpen(tab)}
          />
        ) : (
          <div className="empty-main">
            <div className="empty-mark">✳</div>
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
          onLogout={async () => {
            await api.logout()
            setSettingsOpen(false)
            await refreshAuth()
          }}
        />
      )}
    </div>
  )
}

import { app, BrowserWindow, clipboard, ClipboardItem, dialog, globalShortcut, ipcMain, nativeImage, nativeTheme, Notification, protocol, screen, shell } from 'electron'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { artifactExt, safeFileName } from '../shared/format'
import {
  DEFAULT_EXPORT_OPTIONS,
  type AgentEvent,
  type AppSettings,
  type Attachment,
  type ExportRequest,
  type ExportResult,
  type ImportResult,
  type MemoryItem,
  type PermissionDecision,
  type PermissionModeUI,
  type Project,
  type RewindRequest,
  type SendPayload,
  type SessionMeta
} from '../shared/types'
import { SessionManager } from './agent'
import { renderArtifactPage } from './artifacts'
import { authStatus, cancelLogin, logout, resolveClaudeBinary, sendLoginInput, startLogin } from './claude'
import { stopComputerHelper } from './computer'
import { attachContextMenu } from './contextMenu'
import { IMAGE_EXT, sniffImageType, thumbnail } from './images'
import { notificationFor } from './notify'
import { generateTitle } from './titles'
import { fitToScreens, loadWindowState, trackWindowState } from './windowState'
import { buildFullExport, buildProjectExport, chatMarkdown, importBackup, projectContext, readBackup } from './exporter'
import { addMemory, editMemory, getMemory, removeMemory, setMemory } from './memory'
import { addProjectFiles, createProject, removeProjectFile, updateProject } from './projects'
import { SecureStore } from './store'
import { createZip } from './zip'

// Artifact previews load from artifact://view/<chat>/<artifact>/<version> in a sandboxed frame;
// chat images from lcimg://chat/<chat>/<image> (decrypted on request).
protocol.registerSchemesAsPrivileged([
  { scheme: 'artifact', privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: 'lcimg', privileges: { standard: true, secure: true } }
])

const __dirname = fileURLToPath(new URL('.', import.meta.url))

app.setName('LocalClaude')
// A separate data folder, e.g. for a test profile (must happen before the store reads the path).
if (process.env.LOCALCLAUDE_USER_DATA) app.setPath('userData', process.env.LOCALCLAUDE_USER_DATA)
if (!app.requestSingleInstanceLock()) app.quit()
// Windows groups notifications by this id; it matches the installer's appId.
if (process.platform === 'win32') app.setAppUserModelId('com.parthasarathym.localclaude')
/** End-to-end tests: hidden window, no global shortcut, no notifications. */
const TEST_MODE = !!process.env.LOCALCLAUDE_TEST_MODE

let win: BrowserWindow | null = null
const store = new SecureStore()
let manager: SessionManager

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

const TITLE_BAR_HEIGHT = 44

function titleBarColors(dark: boolean): { color: string; symbolColor: string; height: number } {
  return dark ? { color: '#1a1a19', symbolColor: '#d9d7cf', height: TITLE_BAR_HEIGHT } : { color: '#f5f4ee', symbolColor: '#3d3c38', height: TITLE_BAR_HEIGHT }
}

const windowStateFile = (): string => join(app.getPath('userData'), 'window-state.json')

function createWindow(): void {
  const state = fitToScreens(
    loadWindowState(windowStateFile()),
    screen.getAllDisplays().map((d) => d.workArea)
  )
  win = new BrowserWindow({
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: 760,
    minHeight: 520,
    title: 'LocalClaude',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1c' : '#faf9f5',
    autoHideMenuBar: true,
    // Frameless like the Claude app: the page draws its own top bar; Windows/Linux keep native window buttons.
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarColors(nativeTheme.shouldUseDarkColors),
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // tests render without showing a window (and can still take screenshots)
      offscreen: TEST_MODE
    }
  })
  win.once('ready-to-show', () => {
    if (TEST_MODE) return
    if (state.maximized) win?.maximize()
    win?.show()
  })
  trackWindowState(win, windowStateFile())
  attachContextMenu(win, !!process.env.ELECTRON_RENDERER_URL)
  win.on('focus', () => win?.flashFrame(false))

  // Never navigate the app window away; open links in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://localhost') && !url.startsWith('file://')) {
      e.preventDefault()
      if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

/** Register an IPC handler that refuses to run while the app data is locked to another machine. */
function handle(channel: string, fn: (...args: never[]) => unknown, allowLocked = false): void {
  ipcMain.handle(channel, (_e, ...args) => {
    if (!allowLocked && !store.lock.ok) throw new Error('App is locked: data belongs to another machine')
    return (fn as (...a: unknown[]) => unknown)(...args)
  })
}

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

function registerIpc(): void {
  // ---- app / lock
  handle('app:lockStatus', () => store.lock, true)
  handle(
    'app:resetData',
    () => {
      manager?.shutdownAll()
      return store.reset()
    },
    true
  )
  handle(
    'app:info',
    () => ({
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      electron: process.versions.electron,
      claudeBinary: resolveClaudeBinary() ?? null,
      userData: app.getPath('userData')
    }),
    true
  )

  // ---- auth (your Claude subscription, via Claude Code's own login)
  handle('auth:status', () => authStatus())
  handle('auth:login', () => win && startLogin(win))
  handle('auth:loginInput', (text: string) => sendLoginInput(text))
  handle('auth:cancelLogin', () => cancelLogin())
  handle('auth:logout', async () => {
    manager.shutdownAll()
    await logout()
  })

  // ---- settings
  handle('settings:get', () => store.getSettings())
  handle('settings:set', (patch: Partial<AppSettings>) => {
    const before = store.getSettings().quickShortcut
    const s = store.setSettings(patch)
    nativeTheme.themeSource = s.theme
    if (s.quickShortcut !== before) applyQuickShortcut(s.quickShortcut)
    // Only settings that change how Claude Code runs need idle chats to restart.
    if (Object.keys(patch).some((k) => !UI_ONLY_SETTINGS.has(k as keyof AppSettings))) manager.restartIdle()
    return s
  })
  handle('shortcut:status', () => shortcutStatus)
  handle('usage:get', () => manager.usage())
  handle('search:chats', (query: string) => manager.searchChats(query))

  // ---- sessions
  handle('sessions:list', () => store.listSessions())
  handle('sessions:create', (cwd?: string, projectId?: string) => manager.create(cwd, projectId))
  handle('sessions:delete', (id: string) => manager.delete(id))
  handle('sessions:update', (id: string, patch: Partial<Pick<SessionMeta, 'title' | 'cwd' | 'pinned' | 'projectId'>>) => manager.updateMeta(id, patch))

  // ---- artifacts
  handle('artifacts:list', (sessionId: string) => store.loadArtifacts(sessionId))
  handle('artifacts:save', async (sessionId: string, artifactId: string, version: number) => {
    const a = store.loadArtifacts(sessionId).find((x) => x.id === artifactId)
    const v = a?.versions[version]
    if (!a || !v) return false
    const ext = artifactExt(a)
    const r = await dialog.showSaveDialog(win!, { title: 'Save artifact', defaultPath: safeFileName(a.title) + '.' + ext })
    if (r.canceled || !r.filePath) return false
    writeFileSync(r.filePath, v.content)
    return true
  })

  // ---- projects
  const projectChanged = (p: Project): Project => {
    // instructions and knowledge are part of the system prompt: idle chats restart to pick them up
    manager.restartIdle()
    return p
  }
  handle('projects:list', () => store.listProjects())
  handle('projects:create', (input: { name: string; description?: string }) => createProject(store, input))
  handle('projects:update', (id: string, patch: Partial<Pick<Project, 'name' | 'description' | 'instructions' | 'cwd' | 'pinned'>>) => {
    const p = updateProject(store, id, patch)
    return Object.keys(patch).every((k) => k === 'pinned') ? p : projectChanged(p)
  })
  // Artifacts from every chat in a project, newest first.
  handle('projects:artifacts', (id: string) =>
    store
      .listSessions()
      .filter((s) => s.projectId === id && s.artifactCount)
      .flatMap((s) =>
        store.loadArtifacts(s.id).map((a) => ({ sessionId: s.id, chatTitle: s.title, id: a.id, title: a.title, type: a.type, versions: a.versions.length, updatedAt: a.updatedAt }))
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
  )
  handle('projects:context', (id: string) => {
    const p = store.getProject(id)
    return p ? projectContext(p, store.loadProjectFiles(id)) : null
  })

  // ---- memory (global when projectId is null)
  const memoryState = (projectId: string | null): { items: MemoryItem[]; project?: Project } => {
    // memory is part of the system prompt: idle chats restart to pick up your edits
    manager.restartIdle()
    const project = projectId ? store.getProject(projectId) : undefined
    return { items: getMemory(store, projectId ?? undefined), project }
  }
  handle('memory:global', () => store.getGlobalMemory())
  handle('memory:add', (projectId: string | null, text: string) => {
    addMemory(store, projectId ?? undefined, text, 'you')
    return memoryState(projectId)
  })
  handle('memory:edit', (projectId: string | null, id: string, text: string) => {
    editMemory(store, projectId ?? undefined, id, text)
    return memoryState(projectId)
  })
  handle('memory:remove', (projectId: string | null, id: string) => {
    removeMemory(store, projectId ?? undefined, id)
    return memoryState(projectId)
  })
  handle('memory:clear', (projectId: string | null) => {
    setMemory(store, projectId ?? undefined, [])
    return memoryState(projectId)
  })

  // ---- export / import
  handle('export:run', async (req: ExportRequest): Promise<ExportResult> => {
    const opts = { ...DEFAULT_EXPORT_OPTIONS, ...req.options }
    const none = { chats: 0, artifacts: 0, files: 0 }
    try {
      manager.flushAll()
      if (req.scope === 'chat') {
        const meta = req.sessionId ? store.getSession(req.sessionId) : undefined
        if (!meta) return { ok: false, error: 'Chat not found', ...none }
        const artifacts = opts.artifacts === 'none' ? [] : store.loadArtifacts(meta.id)
        const project = meta.projectId ? store.getProject(meta.projectId) : undefined
        const r = await dialog.showSaveDialog(win!, {
          title: 'Export chat',
          defaultPath: safeFileName(meta.title) + '.md',
          filters: [{ name: 'Markdown', extensions: ['md'] }]
        })
        if (r.canceled || !r.filePath) return { ok: false, canceled: true, ...none }
        writeFileSync(r.filePath, chatMarkdown(meta, store.loadHistory(meta.id), opts, { project, artifacts }))
        return { ok: true, path: r.filePath, chats: 1, artifacts: artifacts.length, files: 0 }
      }
      const project = req.scope === 'project' && req.projectId ? store.getProject(req.projectId) : undefined
      if (req.scope === 'project' && !project) return { ok: false, error: 'Project not found', ...none }
      const built = project ? buildProjectExport(store, project, opts) : buildFullExport(store, opts)
      const r = await dialog.showSaveDialog(win!, {
        title: project ? 'Export project' : 'Export everything',
        defaultPath: built.name + '.zip',
        filters: [{ name: 'ZIP archive', extensions: ['zip'] }]
      })
      if (r.canceled || !r.filePath) return { ok: false, canceled: true, ...none }
      writeFileSync(r.filePath, createZip(built.entries))
      return { ok: true, path: r.filePath, ...built.stats }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), ...none }
    }
  })
  handle('export:reveal', (p: string) => shell.showItemInFolder(p))
  handle('import:run', async (): Promise<ImportResult> => {
    const empty = { chats: 0, projects: 0, artifacts: 0, memory: 0, skipped: 0, withoutTranscript: 0 }
    const r = await dialog.showOpenDialog(win!, {
      title: 'Import a LocalClaude export',
      properties: ['openFile'],
      filters: [{ name: 'LocalClaude export', extensions: ['zip', 'json'] }]
    })
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true, ...empty }
    try {
      const { backup, images } = readBackup(readFileSync(r.filePaths[0]))
      return importBackup(store, backup, undefined, images)
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), ...empty }
    }
  })
  handle('projects:delete', (id: string) => {
    store.deleteProject(id)
    manager.restartIdle()
  })
  handle('projects:addFiles', (id: string, paths: string[]) => {
    const r = addProjectFiles(store, id, paths)
    projectChanged(r.project)
    return r
  })
  handle('projects:removeFile', (id: string, fileId: string) => projectChanged(removeProjectFile(store, id, fileId)))
  handle('image:copy', async (sessionId: string, id: string) => {
    const data = store.loadImage(sessionId, id)
    if (!data) return false
    // the clipboard takes PNG; other types are converted (GIF/WebP only if Chromium can decode them)
    let png: Buffer | null = sniffImageType(data) === 'image/png' ? data : null
    if (!png) {
      const img = nativeImage.createFromBuffer(data)
      png = img.isEmpty() ? null : img.toPNG()
    }
    if (!png) return false
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })])
    return true
  })
  handle('image:save', async (sessionId: string, id: string): Promise<{ ok: boolean; path?: string }> => {
    const data = store.loadImage(sessionId, id)
    if (!data) return { ok: false }
    const ext = IMAGE_EXT[sniffImageType(data) ?? ''] ?? 'png'
    const r = await dialog.showSaveDialog(win!, {
      title: 'Save image',
      defaultPath: join(app.getPath('downloads'), `image-${id.slice(0, 8)}.${ext}`),
      filters: [{ name: 'Image', extensions: [ext] }]
    })
    if (r.canceled || !r.filePath) return { ok: false }
    writeFileSync(r.filePath, data)
    return { ok: true, path: r.filePath }
  })
  handle('sessions:history', (id: string) => manager.history(id))
  handle('sessions:running', (id: string) => manager.isRunning(id))

  // ---- chat
  handle('chat:send', (p: SendPayload) => manager.send(p))
  handle('chat:interrupt', (id: string) => manager.interrupt(id))
  handle('chat:respond', (sessionId: string, requestId: string, d: PermissionDecision & { switchMode?: PermissionModeUI }) =>
    manager.respond(sessionId, requestId, d)
  )
  handle('chat:setMode', (id: string, mode: PermissionModeUI) => manager.setMode(id, mode))
  handle('chat:setModel', (id: string, model: string) => manager.setModel(id, model))
  handle('chat:setDirs', (id: string, dirs: string[]) => manager.setDirs(id, dirs))
  handle('models:list', () => manager.models)
  handle('chat:setStyle', (id: string, style: string) => manager.setStyle(id, style))
  handle('chat:rewindPreview', (id: string, messageId: string) => manager.rewindPreview(id, messageId))
  handle('chat:rewind', (id: string, req: RewindRequest) => manager.rewind(id, req))
  handle('mcp:toggle', (id: string, name: string, enabled: boolean) => manager.toggleMcp(id, name, enabled))
  handle('mcp:reconnect', (id: string, name: string) => manager.reconnectMcp(id, name))
  handle('mcp:refresh', (id: string) => manager.refreshMcp(id))

  // ---- dialogs & shell
  handle('dialog:pickFolder', async (title?: string) => {
    const r = await dialog.showOpenDialog(win!, { title: title ?? 'Choose a folder', properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })
  handle('dialog:pickFiles', async () => {
    const r = await dialog.showOpenDialog(win!, { title: 'Attach files', properties: ['openFile', 'multiSelections'] })
    return r.canceled ? [] : r.filePaths
  })
  handle('files:readImages', (paths: string[]) => {
    const out: Attachment[] = []
    for (const p of paths) {
      const mt = IMAGE_TYPES[extname(p).toLowerCase()]
      if (!mt) continue
      if (statSync(p).size > 5 * 1024 * 1024) continue // API image limit
      out.push({ kind: 'image', mediaType: mt, base64: readFileSync(p).toString('base64'), name: basename(p) })
    }
    return out
  })
  handle('shell:openPath', (p: string) => shell.openPath(p))
  // The page tells us its theme so the native window buttons match the top bar.
  handle(
    'window:theme',
    (dark: boolean) => {
      try {
        win?.setTitleBarOverlay(titleBarColors(dark))
      } catch {
        /* not supported on this platform */
      }
    },
    true
  )
  handle('shell:openExternal', (url: string) => {
    if (/^https?:\/\//.test(url)) return shell.openExternal(url)
    return undefined
  })
}

/** Serves artifact previews. Each page gets its own permissive CSP (it runs in a sandboxed frame with no access to the app). */
function serveArtifacts(): void {
  protocol.handle('artifact', (req) => {
    const [sessionId, artifactId, version] = new URL(req.url).pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const a = store.lock.ok ? store.loadArtifacts(sessionId ?? '').find((x) => x.id === artifactId) : undefined
    const v = a?.versions[Number(version)] ?? a?.versions[a.versions.length - 1]
    if (!a || !v) return new Response('Artifact not found', { status: 404 })
    return new Response(renderArtifactPage(a.type, v.content), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'"
      }
    })
  })
}

/** Serves chat images (?w=480 for a smaller copy). Ids are random, so other pages can't guess them. */
function serveImages(): void {
  protocol.handle('lcimg', (req) => {
    const url = new URL(req.url)
    const [sessionId, imageId] = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const data = store.lock.ok && sessionId && imageId ? store.loadImage(sessionId, imageId) : null
    if (!data) return new Response('Image not found', { status: 404 })
    const w = Math.min(2000, Math.max(0, Number(url.searchParams.get('w')) || 0))
    const body = w ? thumbnail(data, w, `${sessionId}/${imageId}`) : data
    return new Response(new Uint8Array(body), {
      headers: { 'content-type': sniffImageType(body) ?? 'application/octet-stream', 'cache-control': 'private, max-age=31536000, immutable' }
    })
  })
}

/** Settings that only change the UI; changing them doesn't restart idle chats. */
const UI_ONLY_SETTINGS = new Set<keyof AppSettings>([
  'theme',
  'replyFont',
  'uiFont',
  'notifications',
  'autoTitles',
  'quickShortcut',
  'defaultCwd',
  'defaultModel',
  'defaultPermissionMode'
])

function bringToFront(): void {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

// ---- notifications: when Claude finishes or needs you while LocalClaude isn't in front
function notify(e: AgentEvent): void {
  if (e.type !== 'turn-done' && e.type !== 'permission') return
  if (TEST_MODE || !store.lock.ok || !store.getSettings().notifications || !win || win.isDestroyed() || win.isFocused() || !Notification.isSupported()) return
  const sessionId = e.type === 'permission' ? e.request.sessionId : e.sessionId
  const meta = store.getSession(sessionId)
  const last = [...manager.history(sessionId)].reverse().find((m) => m.role === 'assistant' && !m.parentToolUseId && m.parts.some((p) => p.kind === 'text' && p.text.trim()))
  const n = notificationFor(e, { chatTitle: meta?.title, lastReply: last?.parts.map((p) => (p.kind === 'text' ? p.text : '')).join(' ') })
  if (!n) return
  const toast = new Notification({ title: n.title, body: n.body })
  toast.on('click', () => {
    bringToFront()
    send('app:open-session', n.sessionId)
  })
  toast.show()
  win.flashFrame(true)
}

// ---- global shortcut: bring LocalClaude forward with a new chat
let shortcutStatus: { accelerator: string; ok: boolean } = { accelerator: '', ok: true }
function applyQuickShortcut(accelerator: string): void {
  globalShortcut.unregisterAll()
  shortcutStatus = { accelerator, ok: true }
  if (!accelerator || TEST_MODE) return
  try {
    shortcutStatus.ok = globalShortcut.register(accelerator, () => {
      bringToFront()
      send('app:new-chat', null)
    })
  } catch {
    shortcutStatus.ok = false
  }
}

app.whenReady().then(() => {
  store.open()
  if (store.lock.ok) nativeTheme.themeSource = store.getSettings().theme
  manager = new SessionManager(
    store,
    (e: AgentEvent) => {
      send('agent:event', e)
      notify(e)
    },
    {
      titleFor: (user, reply) => (store.getSettings().autoTitles ? generateTitle(user, reply) : Promise.resolve(null)),
      // the test stand-in for Claude Code doesn't write transcripts
      transcriptExists: process.env.LOCALCLAUDE_FAKE_AGENT ? () => true : undefined
    }
  )
  registerIpc()
  serveArtifacts()
  serveImages()
  createWindow()
  if (store.lock.ok) applyQuickShortcut(store.getSettings().quickShortcut)
})

app.on('second-instance', () => bringToFront())

app.on('before-quit', () => {
  manager?.shutdownAll()
  stopComputerHelper()
})
app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => app.quit())

import { app, BrowserWindow, dialog, ipcMain, nativeTheme, protocol, shell } from 'electron'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentEvent, AppSettings, Attachment, PermissionDecision, PermissionModeUI, Project, RewindRequest, SendPayload, SessionMeta } from '../shared/types'
import { SessionManager } from './agent'
import { renderArtifactPage } from './artifacts'
import { authStatus, cancelLogin, logout, resolveClaudeBinary, sendLoginInput, startLogin } from './claude'
import { stopComputerHelper } from './computer'
import { addProjectFiles, createProject, removeProjectFile, updateProject } from './projects'
import { SecureStore } from './store'

// Artifact previews load from artifact://view/<chat>/<artifact>/<version> in a sandboxed frame.
protocol.registerSchemesAsPrivileged([{ scheme: 'artifact', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

const __dirname = fileURLToPath(new URL('.', import.meta.url))

app.setName('LocalClaude')
if (!app.requestSingleInstanceLock()) app.quit()

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

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
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
      sandbox: true
    }
  })
  win.once('ready-to-show', () => win?.show())

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
    const s = store.setSettings(patch)
    nativeTheme.themeSource = s.theme
    manager.restartIdle()
    return s
  })

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
    const ext = { html: 'html', react: 'jsx', svg: 'svg', markdown: 'md', mermaid: 'mmd', code: a.language ? codeExt(a.language) : 'txt' }[a.type]
    const r = await dialog.showSaveDialog(win!, { title: 'Save artifact', defaultPath: a.title.replace(/[\\/:*?"<>|]+/g, '-') + '.' + ext })
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
  handle('projects:update', (id: string, patch: Partial<Pick<Project, 'name' | 'description' | 'instructions' | 'cwd'>>) => projectChanged(updateProject(store, id, patch)))
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

const CODE_EXT: Record<string, string> = { python: 'py', javascript: 'js', typescript: 'ts', tsx: 'tsx', jsx: 'jsx', bash: 'sh', shell: 'sh', powershell: 'ps1', csharp: 'cs', 'c#': 'cs', cpp: 'cpp', 'c++': 'cpp', c: 'c', java: 'java', go: 'go', rust: 'rs', ruby: 'rb', php: 'php', sql: 'sql', json: 'json', yaml: 'yml', css: 'css', html: 'html', kotlin: 'kt', swift: 'swift' }
function codeExt(lang: string): string {
  return CODE_EXT[lang.toLowerCase()] ?? 'txt'
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

app.whenReady().then(() => {
  store.open()
  if (store.lock.ok) nativeTheme.themeSource = store.getSettings().theme
  manager = new SessionManager(store, (e: AgentEvent) => send('agent:event', e))
  registerIpc()
  serveArtifacts()
  createWindow()
})

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.on('before-quit', () => {
  manager?.shutdownAll()
  stopComputerHelper()
})
app.on('window-all-closed', () => app.quit())

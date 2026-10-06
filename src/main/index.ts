import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from 'electron'
import { readFileSync, statSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentEvent, AppSettings, Attachment, PermissionDecision, PermissionModeUI, SendPayload, SessionMeta } from '../shared/types'
import { SessionManager } from './agent'
import { authStatus, cancelLogin, logout, resolveClaudeBinary, sendLoginInput, startLogin } from './claude'
import { SecureStore } from './store'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

app.setName('LocalClaude')
if (!app.requestSingleInstanceLock()) app.quit()

let win: BrowserWindow | null = null
const store = new SecureStore()
let manager: SessionManager

function send(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 760,
    minHeight: 520,
    title: 'LocalClaude',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1f1e1d' : '#faf9f5',
    autoHideMenuBar: true,
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
  handle('sessions:create', (cwd?: string) => manager.create(cwd))
  handle('sessions:delete', (id: string) => manager.delete(id))
  handle('sessions:update', (id: string, patch: Partial<Pick<SessionMeta, 'title' | 'cwd'>>) => manager.updateMeta(id, patch))
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
  handle('shell:openExternal', (url: string) => {
    if (/^https?:\/\//.test(url)) return shell.openExternal(url)
    return undefined
  })
}

app.whenReady().then(() => {
  store.open()
  if (store.lock.ok) nativeTheme.themeSource = store.getSettings().theme
  manager = new SessionManager(store, (e: AgentEvent) => send('agent:event', e))
  registerIpc()
  createWindow()
})

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.focus()
  }
})

app.on('before-quit', () => manager?.shutdownAll())
app.on('window-all-closed', () => app.quit())

import { app, BrowserWindow, clipboard, ClipboardItem, dialog, globalShortcut, ipcMain, nativeImage, nativeTheme, Notification, protocol, screen, shell } from 'electron'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { artifactExt, safeFileName } from '../shared/format'
import {
  DEFAULT_EXPORT_OPTIONS,
  type AgentEvent,
  type AppSettings,
  type Attachment,
  type BackupResult,
  type BackupStatus,
  type ExportRequest,
  type ExportResult,
  type GitStatus,
  type ImportResult,
  type McpServerEntry,
  type MemoryItem,
  type PermissionDecision,
  type PermissionModeUI,
  type Project,
  type ProjectArtifactRef,
  type RewindRequest,
  type SendPayload,
  type SessionMeta,
  type VaultStatus
} from '../shared/types'
import { SessionManager } from './agent'
import { renderArtifactPage } from './artifacts'
import { BACKUP_EXT, MIN_PASSWORD, backupDue, backupFileName, createBackup, decryptBackup, isEncryptedBackup, writeBackupTo } from './backup'
import { authStatus, cancelLogin, logout, resolveClaudeBinary, sendLoginInput, startLogin } from './claude'
import { stopComputerHelper } from './computer'
import { attachContextMenu } from './contextMenu'
import { createWorktree, gitStatus } from './git'
import { testMcpServer } from './mcpCheck'
import { IMAGE_EXT, sniffImageType, thumbnail } from './images'
import { KnowledgeService } from './knowledge'
import { captureMainProcess, log, logFile } from './log'
import { VaultSync, activeVault, detectVaults, obsidianUri } from './obsidian'
import { notificationFor } from './notify'
import { generateTitle } from './titles'
import { fitToScreens, loadWindowState, trackWindowState } from './windowState'
import { buildChatsExport, buildFullExport, buildProjectExport, chatMarkdown, importBackup, projectContext, readBackup } from './exporter'
import { addMemory, editMemory, getMemory, removeMemory, setMemory } from './memory'
import { addProjectFiles, addProjectFolder, createProject, removeProjectFile, removeProjectFolder, updateProject } from './projects'
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
captureMainProcess()

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
      userData: app.getPath('userData'),
      logFile: logFile()
    }),
    true
  )
  handle('log:reveal', () => shell.showItemInFolder(logFile()), true)
  handle('log:renderer', (message: string) => log('error', `[window] ${String(message).slice(0, 4000)}`), true)

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
    const before = store.getSettings()
    const s = store.setSettings(patch)
    nativeTheme.themeSource = s.theme
    if (s.quickShortcut !== before.quickShortcut) applyQuickShortcut(s.quickShortcut)
    // a newly linked (or switched on) vault starts indexing in the background, so the first search is quick
    if (activeVault(s) && (s.obsidianVault !== before.obsidianVault || !before.obsidianEnabled)) warmVault()
    if (s.obsidianSyncMemory && (!before.obsidianSyncMemory || !before.obsidianEnabled)) vaultSync.memoryChanged()
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
  // Artifacts from every chat (or a project's chats), newest first.
  const artifactRefs = (projectId?: string): ProjectArtifactRef[] =>
    store
      .listSessions()
      .filter((s) => s.artifactCount && (!projectId || s.projectId === projectId))
      .flatMap((s) =>
        store
          .loadArtifacts(s.id)
          .map((a) => ({ sessionId: s.id, chatTitle: s.title, projectId: s.projectId, id: a.id, title: a.title, type: a.type, versions: a.versions.length, updatedAt: a.updatedAt }))
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
  handle('projects:artifacts', (id: string) => artifactRefs(id))
  handle('artifacts:all', () => artifactRefs())
  // A page you can open in your browser (React apps and diagrams load their libraries from the web).
  handle('artifacts:openInBrowser', (sessionId: string, artifactId: string, version?: number) => {
    const a = store.loadArtifacts(sessionId).find((x) => x.id === artifactId)
    const v = a?.versions[version ?? a.versions.length - 1]
    if (!a || !v) return false
    const dir = join(app.getPath('temp'), 'localclaude-artifacts')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${safeFileName(a.title)}.html`)
    writeFileSync(file, renderArtifactPage(a.type, v.content))
    void shell.openExternal(pathToFileURL(file).href)
    return true
  })
  handle('projects:context', (id: string) => {
    const p = store.getProject(id)
    return p ? projectContext(p, store.loadProjectFiles(id)) : null
  })

  // ---- memory (global when projectId is null)
  const memoryState = (projectId: string | null): { items: MemoryItem[]; project?: Project } => {
    // memory is part of the system prompt: idle chats restart to pick up your edits
    manager.restartIdle()
    vaultSync.memoryChanged()
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
      const some = req.scope === 'chats' ? (req.sessionIds ?? []) : null
      if (some && !some.length) return { ok: false, error: 'No chats selected', ...none }
      const built = some ? buildChatsExport(store, some, opts) : project ? buildProjectExport(store, project, opts) : buildFullExport(store, opts)
      const r = await dialog.showSaveDialog(win!, {
        title: some ? 'Export chats' : project ? 'Export project' : 'Export everything',
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
  const emptyImport = { chats: 0, projects: 0, artifacts: 0, memory: 0, skipped: 0, withoutTranscript: 0 }
  handle('import:run', async (): Promise<ImportResult> => {
    const r = await dialog.showOpenDialog(win!, {
      title: 'Import a LocalClaude export or backup',
      properties: ['openFile'],
      filters: [{ name: 'LocalClaude export or backup', extensions: ['zip', 'json', BACKUP_EXT] }]
    })
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true, ...emptyImport }
    try {
      const buf = readFileSync(r.filePaths[0])
      // a password-protected backup: the window asks for the password, then calls import:withPassword
      if (isEncryptedBackup(buf)) {
        pendingImport = r.filePaths[0]
        return { ok: false, needsPassword: true, ...emptyImport }
      }
      const { backup, images } = readBackup(buf)
      return importBackup(store, backup, undefined, images)
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), ...emptyImport }
    }
  })
  handle('import:withPassword', async (password: string): Promise<ImportResult> => {
    if (!pendingImport) return { ok: false, error: 'Choose the backup file again.', ...emptyImport }
    try {
      const { backup, images } = readBackup(await decryptBackup(readFileSync(pendingImport), password))
      pendingImport = null
      return importBackup(store, backup, undefined, images)
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), ...emptyImport }
    }
  })
  handle('import:cancel', () => {
    pendingImport = null
  })

  // ---- backups
  handle('backup:status', () => backupStatus())
  handle('backup:setPassword', (password: string | null) => {
    if (password !== null && password.length < MIN_PASSWORD) throw new Error(`Use at least ${MIN_PASSWORD} characters.`)
    store.setBackupState({ password: password ?? undefined })
    return backupStatus()
  })
  handle('backup:runNow', () => runAutoBackup())
  handle('backup:saveAs', async (password: string): Promise<BackupResult> => {
    if (!password || password.length < MIN_PASSWORD) return { ok: false, error: `Use at least ${MIN_PASSWORD} characters.` }
    const r = await dialog.showSaveDialog(win!, {
      title: 'Save a backup',
      defaultPath: join(store.getSettings().backupDir || app.getPath('documents'), backupFileName()),
      filters: [{ name: 'LocalClaude backup', extensions: [BACKUP_EXT] }]
    })
    if (r.canceled || !r.filePath) return { ok: false, canceled: true }
    try {
      const data = await createBackup(store, password)
      writeFileSync(r.filePath, data)
      return { ok: true, path: r.filePath, size: data.length }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  handle('projects:delete', (id: string) => {
    store.deleteProject(id)
    manager.restartIdle()
  })
  handle('projects:addFiles', async (id: string, paths: string[]) => {
    const r = await addProjectFiles(store, id, paths)
    projectChanged(r.project)
    return r
  })
  handle('projects:addFolder', async (id: string) => {
    const r = await dialog.showOpenDialog(win!, { title: 'Link a folder as knowledge', properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return null
    return projectChanged(addProjectFolder(store, id, r.filePaths[0]))
  })
  handle('projects:removeFolder', (id: string, folder: string) => {
    knowledge.invalidate(folder)
    return projectChanged(removeProjectFolder(store, id, folder))
  })

  // ---- Obsidian
  handle('obsidian:vaults', () => detectVaults())
  handle('obsidian:status', async (): Promise<VaultStatus> => {
    const { obsidianVault: v, obsidianEnabled } = store.getSettings()
    if (!v) return { linked: false }
    if (!obsidianEnabled) return { linked: true, name: basename(v), off: true }
    if (!existsSync(v)) return { linked: true, name: basename(v), missing: true }
    const { index, more } = await knowledge.folder(v, `Obsidian vault ${basename(v)}`)
    return { linked: true, name: basename(v), files: index.docs.length, passages: index.size, more }
  })
  handle('obsidian:open', (path?: string) => {
    const target = path || store.getSettings().obsidianVault
    if (target) void shell.openExternal(obsidianUri(target))
  })
  handle('obsidian:openChat', (sessionId: string) => {
    const file = vaultSync.notePath(sessionId) ?? vaultSync.writeChat(sessionId)
    if (file) void shell.openExternal(obsidianUri(file))
    return !!file
  })
  handle('obsidian:saveAll', () => {
    let n = 0
    for (const s of store.listSessions()) if (vaultSync.writeChat(s.id)) n++
    if (store.getSettings().obsidianSyncMemory) vaultSync.writeMemory()
    return n
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
  handle('mcp:test', (entry: McpServerEntry) => testMcpServer(entry, { cwd: store.getSettings().defaultCwd || undefined }))
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
  // ---- git and files Claude changed
  handle('git:status', (cwd: string): Promise<GitStatus | null> => gitStatus(cwd))
  handle('git:worktree', async (sessionId: string, name: string) => {
    const meta = store.getSession(sessionId)
    if (!meta) throw new Error('Unknown chat')
    if (meta.sdkSessionId) throw new Error('This chat has already started; start a new chat to use a new worktree.')
    const { path } = await createWorktree(meta.cwd, name)
    return manager.updateMeta(sessionId, { cwd: path })
  })
  handle('files:openInEditor', (path: string) => shell.openExternal('vscode://file/' + path.replace(/\\/g, '/')))
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

// ---- backups: password-protected copies of everything, on demand or on a schedule
let pendingImport: string | null = null
let backupRunning = false
const defaultBackupDir = (): string => join(app.getPath('documents'), 'LocalClaude backups')

function backupStatus(): BackupStatus {
  const st = store.getBackupState()
  return { hasPassword: !!st.password, lastAt: st.lastAt, lastFile: st.lastFile, lastSize: st.lastSize, lastError: st.lastError, defaultDir: defaultBackupDir(), running: backupRunning }
}

/** Write a backup to the backup folder with the saved password (on schedule, or "Back up now"). */
async function runAutoBackup(): Promise<BackupResult> {
  const s = store.getSettings()
  const password = store.getBackupState().password
  if (!password) return { ok: false, error: 'Set a backup password first.' }
  if (backupRunning) return { ok: false, error: 'A backup is already running.' }
  backupRunning = true
  try {
    const r = await writeBackupTo(store, s.backupDir || defaultBackupDir(), password, s.backupKeep)
    store.setBackupState({ lastAt: Date.now(), lastFile: r.path, lastSize: r.size, lastError: undefined })
    log('info', `backup written (${Math.round(r.size / 1024)} KB)`)
    return { ok: true, ...r }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    log('error', 'automatic backup failed:', e)
    store.setBackupState({ lastError: error })
    return { ok: false, error }
  } finally {
    backupRunning = false
  }
}

function scheduleBackups(): void {
  const tick = (): void => {
    if (!store.lock.ok) return
    const s = store.getSettings()
    const st = store.getBackupState()
    if (s.autoBackup && st.password && backupDue(st.lastAt, s.backupEvery)) void runAutoBackup()
  }
  // a minute after start (not to slow it down), then every half hour
  setTimeout(tick, 60_000)
  setInterval(tick, 30 * 60_000)
}

// ---- knowledge: searchable project files, linked folders and the Obsidian vault
const knowledge = new KnowledgeService()
let vaultSync: VaultSync

function warmVault(): void {
  const v = activeVault(store.getSettings())
  if (v) void knowledge.folder(v, `Obsidian vault ${basename(v)}`).catch(() => {})
}

/** Chats and memory follow into the vault as notes (when those options are on). */
function syncToVault(e: AgentEvent): void {
  if (e.type === 'error') log('warn', `chat ${e.sessionId.slice(0, 8)}: ${e.text.slice(0, 500)}`)
  if (e.type === 'turn-done') vaultSync.chatChanged(e.sessionId)
  else if (e.type === 'meta') vaultSync.chatChanged(e.meta.id)
  else if (e.type === 'global-memory' || e.type === 'project') vaultSync.memoryChanged()
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
  'defaultPermissionMode',
  'autoBackup',
  'backupDir',
  'backupEvery',
  'backupKeep',
  'obsidianSyncChats',
  'obsidianSyncMemory'
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
  log('info', `LocalClaude ${app.getVersion()} starting (Electron ${process.versions.electron}, ${process.platform} ${process.arch})`)
  store.open()
  if (!store.lock.ok) log('warn', 'data locked:', store.lock.reason ?? '')
  if (store.lock.ok) nativeTheme.themeSource = store.getSettings().theme
  manager = new SessionManager(
    store,
    (e: AgentEvent) => {
      send('agent:event', e)
      notify(e)
      syncToVault(e)
    },
    {
      knowledge,
      titleFor: (user, reply) => (store.getSettings().autoTitles ? generateTitle(user, reply) : Promise.resolve(null)),
      // the test stand-in for Claude Code doesn't write transcripts
      transcriptExists: process.env.LOCALCLAUDE_FAKE_AGENT ? () => true : undefined
    }
  )
  // notes are written from what's in memory, which is newer than what's saved
  vaultSync = new VaultSync(
    {
      getSession: (id) => store.getSession(id),
      loadHistory: (id) => manager.history(id),
      loadArtifacts: (id) => store.loadArtifacts(id),
      loadImage: (sid, id) => store.loadImage(sid, id),
      getProject: (id) => store.getProject(id),
      listProjects: () => store.listProjects(),
      getGlobalMemory: () => store.getGlobalMemory(),
      getNotePath: (id) => store.getNotePath(id),
      setNotePath: (id, rel) => store.setNotePath(id, rel)
    },
    () => store.getSettings()
  )
  if (store.lock.ok) warmVault()
  registerIpc()
  serveArtifacts()
  serveImages()
  createWindow()
  if (store.lock.ok) applyQuickShortcut(store.getSettings().quickShortcut)
  if (!TEST_MODE) scheduleBackups()
})

app.on('second-instance', () => bringToFront())

app.on('before-quit', () => {
  manager?.shutdownAll()
  stopComputerHelper()
})
app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => app.quit())

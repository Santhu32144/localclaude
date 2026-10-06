import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AgentEvent,
  AppSettings,
  Attachment,
  AuthStatus,
  ChatMessage,
  LockStatus,
  LoginEvent,
  PermissionDecision,
  PermissionModeUI,
  Artifact,
  ChatSearchHit,
  ExportRequest,
  ExportResult,
  ImportResult,
  MemoryItem,
  PlanUsage,
  Project,
  ProjectArtifactRef,
  ProjectContextUsage,
  RewindPreview,
  RewindRequest,
  SendPayload,
  SessionMeta
} from '../shared/types'

/** Memory after a change, plus the updated project when it was project memory. */
type MemoryState = { items: MemoryItem[]; project?: Project }

const inv = <T>(ch: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(ch, ...args) as Promise<T>

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const fn = (_e: unknown, payload: T): void => cb(payload)
  ipcRenderer.on(channel, fn)
  return () => ipcRenderer.removeListener(channel, fn)
}

const api = {
  lockStatus: () => inv<LockStatus>('app:lockStatus'),
  resetData: () => inv<LockStatus>('app:resetData'),
  appInfo: () =>
    inv<{ version: string; platform: string; arch: string; electron: string; claudeBinary: string | null; userData: string }>('app:info'),

  authStatus: () => inv<AuthStatus>('auth:status'),
  login: () => inv<void>('auth:login'),
  loginInput: (text: string) => inv<void>('auth:loginInput', text),
  cancelLogin: () => inv<void>('auth:cancelLogin'),
  logout: () => inv<void>('auth:logout'),
  onLogin: (cb: (e: LoginEvent) => void) => on<LoginEvent>('login:event', cb),

  getSettings: () => inv<AppSettings>('settings:get'),
  setSettings: (patch: Partial<AppSettings>) => inv<AppSettings>('settings:set', patch),

  listSessions: () => inv<SessionMeta[]>('sessions:list'),
  createSession: (cwd?: string, projectId?: string) => inv<SessionMeta>('sessions:create', cwd, projectId),
  deleteSession: (id: string) => inv<void>('sessions:delete', id),
  updateSession: (id: string, patch: Partial<Pick<SessionMeta, 'title' | 'cwd' | 'pinned' | 'projectId'>>) => inv<SessionMeta>('sessions:update', id, patch),
  history: (id: string) => inv<ChatMessage[]>('sessions:history', id),
  isRunning: (id: string) => inv<boolean>('sessions:running', id),

  send: (p: SendPayload) => inv<void>('chat:send', p),
  interrupt: (id: string) => inv<void>('chat:interrupt', id),
  respond: (sessionId: string, requestId: string, d: PermissionDecision & { switchMode?: PermissionModeUI }) =>
    inv<void>('chat:respond', sessionId, requestId, d),
  setMode: (id: string, mode: PermissionModeUI) => inv<void>('chat:setMode', id, mode),
  setModel: (id: string, model: string) => inv<void>('chat:setModel', id, model),
  setDirs: (id: string, dirs: string[]) => inv<void>('chat:setDirs', id, dirs),
  listModels: () => inv<{ value: string; displayName: string; description: string }[]>('models:list'),
  rewindPreview: (id: string, messageId: string) => inv<RewindPreview>('chat:rewindPreview', id, messageId),
  rewind: (id: string, req: RewindRequest) =>
    inv<{ ok: boolean; error?: string; text?: string; filesChanged?: number }>('chat:rewind', id, req),
  toggleMcp: (id: string, name: string, enabled: boolean) => inv<void>('mcp:toggle', id, name, enabled),
  reconnectMcp: (id: string, name: string) => inv<void>('mcp:reconnect', id, name),
  refreshMcp: (id: string) => inv<void>('mcp:refresh', id),
  onEvent: (cb: (e: AgentEvent) => void) => on<AgentEvent>('agent:event', cb),

  pickFolder: (title?: string) => inv<string | null>('dialog:pickFolder', title),
  pickFiles: () => inv<string[]>('dialog:pickFiles'),
  readImages: (paths: string[]) => inv<Attachment[]>('files:readImages', paths),
  /** Absolute path of a file dropped or pasted into the window */
  pathForFile: (f: File) => webUtils.getPathForFile(f),
  openPath: (p: string) => inv<string>('shell:openPath', p),
  openExternal: (url: string) => inv<void>('shell:openExternal', url),
  setWindowTheme: (dark: boolean) => inv<void>('window:theme', dark),

  listArtifacts: (sessionId: string) => inv<Artifact[]>('artifacts:list', sessionId),
  saveArtifact: (sessionId: string, artifactId: string, version: number) => inv<boolean>('artifacts:save', sessionId, artifactId, version),

  listProjects: () => inv<Project[]>('projects:list'),
  createProject: (input: { name: string; description?: string }) => inv<Project>('projects:create', input),
  updateProject: (id: string, patch: Partial<Pick<Project, 'name' | 'description' | 'instructions' | 'cwd' | 'pinned'>>) =>
    inv<Project>('projects:update', id, patch),
  deleteProject: (id: string) => inv<void>('projects:delete', id),
  addProjectFiles: (id: string, paths: string[]) => inv<{ project: Project; skipped: string[] }>('projects:addFiles', id, paths),
  removeProjectFile: (id: string, fileId: string) => inv<Project>('projects:removeFile', id, fileId),
  projectArtifacts: (id: string) => inv<ProjectArtifactRef[]>('projects:artifacts', id),
  projectContext: (id: string) => inv<ProjectContextUsage | null>('projects:context', id),

  /** Memory: projectId null = global memory */
  globalMemory: () => inv<MemoryItem[]>('memory:global'),
  addMemory: (projectId: string | null, text: string) => inv<MemoryState>('memory:add', projectId, text),
  editMemory: (projectId: string | null, id: string, text: string) => inv<MemoryState>('memory:edit', projectId, id, text),
  removeMemory: (projectId: string | null, id: string) => inv<MemoryState>('memory:remove', projectId, id),
  clearMemory: (projectId: string | null) => inv<MemoryState>('memory:clear', projectId),

  usage: () => inv<PlanUsage>('usage:get'),
  searchChats: (query: string) => inv<ChatSearchHit[]>('search:chats', query),
  copyImage: (sessionId: string, id: string) => inv<boolean>('image:copy', sessionId, id),
  saveImage: (sessionId: string, id: string) => inv<{ ok: boolean; path?: string }>('image:save', sessionId, id),
  setStyle: (id: string, style: string) => inv<void>('chat:setStyle', id, style),
  shortcutStatus: () => inv<{ accelerator: string; ok: boolean }>('shortcut:status'),
  /** a notification was clicked: show that chat */
  onOpenSession: (cb: (sessionId: string) => void) => on<string>('app:open-session', cb),
  /** the global shortcut was pressed */
  onNewChat: (cb: () => void) => on<null>('app:new-chat', () => cb()),

  exportData: (req: ExportRequest) => inv<ExportResult>('export:run', req),
  revealFile: (path: string) => inv<void>('export:reveal', path),
  importData: () => inv<ImportResult>('import:run'),
  platform: process.platform
}

export type Api = typeof api
contextBridge.exposeInMainWorld('api', api)

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
  SendPayload,
  SessionMeta
} from '../shared/types'

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
  createSession: (cwd?: string) => inv<SessionMeta>('sessions:create', cwd),
  deleteSession: (id: string) => inv<void>('sessions:delete', id),
  updateSession: (id: string, patch: Partial<Pick<SessionMeta, 'title' | 'cwd'>>) => inv<SessionMeta>('sessions:update', id, patch),
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
  onEvent: (cb: (e: AgentEvent) => void) => on<AgentEvent>('agent:event', cb),

  pickFolder: (title?: string) => inv<string | null>('dialog:pickFolder', title),
  pickFiles: () => inv<string[]>('dialog:pickFiles'),
  readImages: (paths: string[]) => inv<Attachment[]>('files:readImages', paths),
  /** Absolute path of a file dropped or pasted into the window */
  pathForFile: (f: File) => webUtils.getPathForFile(f),
  openPath: (p: string) => inv<string>('shell:openPath', p),
  openExternal: (url: string) => inv<void>('shell:openExternal', url)
}

export type Api = typeof api
contextBridge.exposeInMainWorld('api', api)

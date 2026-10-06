// Types shared between the Electron main process, preload and renderer.

export type PermissionModeUI = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'

export interface McpServerEntry {
  /** stdio */
  type?: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  env?: Record<string, string>
  /** http / sse */
  url?: string
  headers?: Record<string, string>
  enabled?: boolean
}

export interface AppSettings {
  defaultCwd: string
  defaultModel: string // '' = Claude Code default
  defaultPermissionMode: PermissionModeUI
  effort: '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  /** Pass --chrome so Claude can drive your real Chrome via the Claude in Chrome extension */
  chromeIntegration: boolean
  /** Load ~/.claude (user) + project settings: CLAUDE.md, skills, slash commands, plugins, hooks */
  loadUserSettings: boolean
  loadProjectSettings: boolean
  mcpServers: Record<string, McpServerEntry>
  theme: 'system' | 'light' | 'dark'
  /** Extra instructions appended to Claude Code's system prompt */
  appendSystemPrompt: string
}

export interface SessionMeta {
  id: string // SDK session id (UUID) once known, else a local temp id
  sdkSessionId?: string
  title: string
  cwd: string
  additionalDirs: string[]
  model: string
  permissionMode: PermissionModeUI
  createdAt: number
  updatedAt: number
}

export type ContentPart =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | {
      kind: 'tool'
      toolUseId: string
      name: string
      input: unknown
      inputJsonPartial?: string
      result?: string
      isError?: boolean
      done: boolean
    }

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system' | 'error'
  parts: ContentPart[]
  /** set for messages produced inside a subagent (Agent/Task tool) */
  parentToolUseId?: string | null
  images?: number
  ts: number
}

export interface TurnStats {
  costUsd: number
  inputTokens: number
  outputTokens: number
  durationMs: number
  numTurns: number
}

/** Subscription usage window info reported by Claude Code */
export interface RateLimitInfo {
  status: 'allowed' | 'allowed_warning' | 'rejected'
  resetsAt?: number
  rateLimitType?: string
  utilization?: number
}

export interface InitInfo {
  model: string
  cwd: string
  tools: string[]
  slashCommands: string[]
  skills: string[]
  mcpServers: { name: string; status: string }[]
  apiKeySource: string
  claudeCodeVersion: string
  permissionMode: string
}

export interface PermissionRequest {
  requestId: string
  sessionId: string
  toolName: string
  input: Record<string, unknown>
  title?: string
  displayName?: string
  decisionReason?: string
  blockedPath?: string
  hasSuggestions: boolean
}

export type PermissionDecision =
  | { behavior: 'allow'; always?: boolean; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message?: string }

/** Events pushed from main -> renderer */
export type AgentEvent =
  | { type: 'status'; sessionId: string; status: 'idle' | 'running' | 'starting' }
  | { type: 'init'; sessionId: string; info: InitInfo }
  | { type: 'sdk-session'; sessionId: string; sdkSessionId: string }
  | { type: 'message-start'; sessionId: string; message: ChatMessage }
  | { type: 'text-delta'; sessionId: string; messageId: string; partIndex: number; text: string }
  | { type: 'thinking-delta'; sessionId: string; messageId: string; partIndex: number; text: string }
  | { type: 'tool-start'; sessionId: string; messageId: string; partIndex: number; toolUseId: string; name: string }
  | { type: 'tool-input-delta'; sessionId: string; messageId: string; partIndex: number; json: string }
  | { type: 'message-final'; sessionId: string; message: ChatMessage }
  | { type: 'tool-result'; sessionId: string; toolUseId: string; result: string; isError: boolean }
  | { type: 'turn-done'; sessionId: string; stats: TurnStats; isError: boolean; errorText?: string }
  | { type: 'error'; sessionId: string; text: string }
  | { type: 'rate-limit'; sessionId: string; info: RateLimitInfo }
  | { type: 'permission'; request: PermissionRequest }
  | { type: 'permission-cancel'; requestId: string }
  | { type: 'meta'; meta: SessionMeta }
  | { type: 'account'; email?: string; subscriptionType?: string }

export interface AuthStatus {
  loggedIn: boolean
  authMethod?: string
  apiProvider?: string
  usingApiKeyEnv: boolean
  email?: string
  subscriptionType?: string
  error?: string
}

export interface LockStatus {
  ok: boolean
  reason?: string
  encryptionBackend: string
  machineIdShort: string
}

export interface Attachment {
  kind: 'image'
  mediaType: string
  base64: string
  name: string
}

export interface SendPayload {
  sessionId: string
  text: string
  attachments: Attachment[]
}

export interface LoginEvent {
  type: 'output' | 'exit'
  text?: string
  code?: number | null
  url?: string
}

export const DEFAULT_SETTINGS: AppSettings = {
  defaultCwd: '',
  defaultModel: '',
  defaultPermissionMode: 'default',
  effort: '',
  chromeIntegration: false,
  loadUserSettings: true,
  loadProjectSettings: true,
  mcpServers: {},
  theme: 'system',
  appendSystemPrompt: ''
}

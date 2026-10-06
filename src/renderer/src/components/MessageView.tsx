import { memo, useState } from 'react'
import type { ChatMessage, ContentPart } from '../../../shared/types'
import { Markdown } from './Markdown'

type ToolPart = Extract<ContentPart, { kind: 'tool' }>

function parsedInput(p: ToolPart): Record<string, unknown> {
  if (p.input && typeof p.input === 'object' && Object.keys(p.input as object).length) return p.input as Record<string, unknown>
  if (p.inputJsonPartial) {
    try {
      return JSON.parse(p.inputJsonPartial)
    } catch {
      /* still streaming */
    }
  }
  return {}
}

const short = (s: unknown, n = 90): string => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}
const fileName = (p: unknown): string => String(p ?? '').split(/[\\/]/).pop() || String(p ?? '')

/** Human label + one-line detail for a tool call. */
export function describeTool(name: string, input: Record<string, unknown>): { icon: string; label: string; detail: string } {
  switch (name) {
    case 'Bash':
      return { icon: '›_', label: 'Ran command', detail: short(input.command) }
    case 'PowerShell':
      return { icon: '›_', label: 'Ran PowerShell', detail: short(input.command) }
    case 'Read':
      return { icon: '📄', label: 'Read', detail: fileName(input.file_path) }
    case 'Write':
      return { icon: '✎', label: 'Created', detail: fileName(input.file_path) }
    case 'Edit':
    case 'MultiEdit':
      return { icon: '✎', label: 'Edited', detail: fileName(input.file_path) }
    case 'NotebookEdit':
      return { icon: '✎', label: 'Edited notebook', detail: fileName(input.notebook_path) }
    case 'Glob':
      return { icon: '⌕', label: 'Found files', detail: short(input.pattern) }
    case 'Grep':
      return { icon: '⌕', label: 'Searched', detail: short(input.pattern) }
    case 'WebFetch':
      return { icon: '🌐', label: 'Fetched', detail: short(input.url) }
    case 'WebSearch':
      return { icon: '🔎', label: 'Searched the web', detail: short(input.query) }
    case 'Agent':
    case 'Task':
      return { icon: '◈', label: 'Subagent', detail: short(input.description ?? input.prompt) }
    case 'TodoWrite':
      return { icon: '☑', label: 'Updated to-dos', detail: '' }
    case 'Skill':
      return { icon: '✦', label: 'Used skill', detail: short(input.skill ?? input.command) }
    case 'AskUserQuestion':
      return { icon: '?', label: 'Asked you', detail: '' }
    case 'ExitPlanMode':
      return { icon: '▤', label: 'Proposed a plan', detail: '' }
    default:
      if (name.startsWith('mcp__')) {
        const [, server, ...tool] = name.split('__')
        return { icon: '⚡', label: `${server}`, detail: tool.join('__').replace(/_/g, ' ') }
      }
      return { icon: '⚙', label: name, detail: short(Object.values(input)[0]) }
  }
}

const PENDING: Record<string, string> = {
  'Ran command': 'Running command',
  'Ran PowerShell': 'Running PowerShell',
  Read: 'Reading',
  Created: 'Creating',
  Edited: 'Editing',
  'Edited notebook': 'Editing notebook',
  'Found files': 'Finding files',
  Searched: 'Searching',
  Fetched: 'Fetching',
  'Searched the web': 'Searching the web',
  'Used skill': 'Using skill'
}

function TodoList({ todos }: { todos: { content?: string; status?: string; activeForm?: string }[] }) {
  return (
    <ul className="todos">
      {todos.map((t, i) => (
        <li key={i} className={'todo ' + (t.status ?? '')}>
          <span className="todo-box">{t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : ''}</span>
          {t.status === 'in_progress' ? t.activeForm ?? t.content : t.content}
        </li>
      ))}
    </ul>
  )
}

function DiffView({ oldStr, newStr }: { oldStr: string; newStr: string }) {
  return (
    <div className="diff">
      {oldStr
        .split('\n')
        .slice(0, 60)
        .map((l, i) => (
          <div key={'o' + i} className="diff-del">
            - {l}
          </div>
        ))}
      {newStr
        .split('\n')
        .slice(0, 60)
        .map((l, i) => (
          <div key={'n' + i} className="diff-add">
            + {l}
          </div>
        ))}
    </div>
  )
}

function ToolCard({ part, subMessages }: { part: ToolPart; subMessages?: ChatMessage[] }) {
  const input = parsedInput(part)
  const d = describeTool(part.name, input)
  const [open, setOpen] = useState(false)
  const [full, setFull] = useState(false)
  const result = part.result ?? ''
  const LIMIT = 4000

  if (part.name === 'TodoWrite' && Array.isArray(input.todos)) {
    return (
      <div className="tool-card todo-card">
        <div className="tool-head static">
          <span className="tool-icon">{d.icon}</span>
          <span className="tool-label">{d.label}</span>
        </div>
        <TodoList todos={input.todos as never} />
      </div>
    )
  }

  return (
    <div className={'tool-card' + (part.isError ? ' error' : '')}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <span className="tool-icon">{d.icon}</span>
        <span className="tool-label">{part.done ? d.label : (PENDING[d.label] ?? d.label)}</span>
        <span className="tool-detail">{d.detail}</span>
        {subMessages && subMessages.length > 0 && <span className="muted small">{subMessages.length} steps</span>}
        <span className="tool-state">{!part.done ? <span className="spinner" /> : part.isError ? '✕' : '✓'}</span>
        <span className="chev">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="tool-body">
          {(part.name === 'Edit' || part.name === 'MultiEdit') && typeof input.old_string === 'string' ? (
            <>
              <div className="muted small mono">{String(input.file_path ?? '')}</div>
              <DiffView oldStr={String(input.old_string)} newStr={String(input.new_string ?? '')} />
            </>
          ) : part.name === 'Write' && typeof input.content === 'string' ? (
            <>
              <div className="muted small mono">{String(input.file_path ?? '')}</div>
              <pre className="tool-pre">{String(input.content).slice(0, LIMIT)}</pre>
            </>
          ) : part.name === 'Bash' ? (
            <pre className="tool-pre">$ {String(input.command ?? '')}</pre>
          ) : (
            <pre className="tool-pre">{JSON.stringify(input, null, 2)}</pre>
          )}
          {subMessages && subMessages.length > 0 && (
            <div className="subagent">
              {subMessages.map((m) => (
                <MessageView key={m.id} message={m} childrenOf={() => []} compact />
              ))}
            </div>
          )}
          {part.result !== undefined && part.name !== 'Agent' && part.name !== 'Task' && (
            <>
              <div className="muted small">{part.isError ? 'Error' : 'Result'}</div>
              <pre className={'tool-pre result' + (part.isError ? ' err' : '')}>
                {full ? result : result.slice(0, LIMIT)}
                {!full && result.length > LIMIT && '…'}
              </pre>
              {result.length > LIMIT && (
                <button className="link-btn" onClick={() => setFull(!full)}>
                  {full ? 'Show less' : `Show all (${result.length.toLocaleString()} chars)`}
                </button>
              )}
            </>
          )}
          {part.result !== undefined && (part.name === 'Agent' || part.name === 'Task') && <Markdown text={result} />}
        </div>
      )}
    </div>
  )
}

function Thinking({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false)
  if (!text.trim()) return live ? <div className="thinking muted small">Thinking…</div> : null
  return (
    <div className="thinking">
      <button className="link-btn" onClick={() => setOpen(!open)}>
        {open ? '▾' : '▸'} {live ? 'Thinking…' : 'Thought process'}
      </button>
      {open && <div className="thinking-body">{text}</div>}
    </div>
  )
}

export const MessageView = memo(function MessageView({
  message,
  childrenOf,
  live = false,
  compact = false
}: {
  message: ChatMessage
  childrenOf: (toolUseId: string) => ChatMessage[]
  live?: boolean
  compact?: boolean
}) {
  if (message.role === 'user') {
    const text = message.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('')
    return (
      <div className="msg user">
        <div className="bubble">
          {message.images ? <div className="muted small">📎 {message.images} image(s)</div> : null}
          <div className="user-text">{text}</div>
        </div>
      </div>
    )
  }
  if (message.role === 'system') {
    return <div className="msg system">{message.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('')}</div>
  }
  if (message.role === 'error') {
    return (
      <div className="msg error-msg">
        <Markdown text={message.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('')} />
      </div>
    )
  }
  return (
    <div className={'msg assistant' + (compact ? ' compact' : '')}>
      {message.parts.map((p, i) => {
        if (p.kind === 'text') return p.text ? <Markdown key={i} text={p.text} /> : null
        if (p.kind === 'thinking') return <Thinking key={i} text={p.text} live={live && i === message.parts.length - 1} />
        return <ToolCard key={p.toolUseId} part={p} subMessages={childrenOf(p.toolUseId)} />
      })}
    </div>
  )
})

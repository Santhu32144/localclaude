import { memo, useState, type ReactNode } from 'react'
import type { ArtifactType, ChatMessage } from '../../../shared/types'
import { countChanges, type DiffLine } from '../../../shared/diff'
import { ARTIFACT_LABEL } from '../../../shared/format'
import { editDiff, fileName, isArtifactTool, parsedInput, plural, short, stepText, summarize, type Step, type ToolPart } from '../../../shared/steps'
import { artifactIcon } from './ArtifactPanel'
import { Icon } from './Icon'
import { Markdown } from './Markdown'

export type TranscriptMode = 'normal' | 'verbose'

/** Compact name + detail for a tool (used by the permission prompt). */
export function describeTool(name: string, input: Record<string, unknown>): { icon: string; label: string; detail: string } {
  const s = stepText({ kind: 'tool', toolUseId: '', name, input, done: false })
  return { icon: s.icon, label: s.title, detail: s.detail ?? '' }
}

const DIFF_LIMIT = 80

export function DiffView({ lines, numbered, path }: { lines: DiffLine[]; numbered: boolean; path?: string }) {
  const [all, setAll] = useState(false)
  const shown = all ? lines : lines.slice(0, DIFF_LIMIT)
  return (
    <div className="diff">
      {path && <div className="diff-path mono">{path}</div>}
      <div className="diff-body">
        {shown.map((l, i) =>
          l.kind === 'gap' ? (
            <div key={i} className="diff-gap">
              ⋯
            </div>
          ) : (
            <div key={i} className={'diff-line ' + l.kind}>
              {numbered && <span className="diff-no">{l.kind === 'del' ? l.oldNo : l.newNo}</span>}
              <span className="diff-sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}</span>
              <span className="diff-text">{l.text || ' '}</span>
            </div>
          )
        )}
      </div>
      {lines.length > DIFF_LIMIT && (
        <button className="link-btn diff-more" onClick={() => setAll(!all)}>
          {all ? 'Show less' : `Show ${lines.length - DIFF_LIMIT} more lines`}
        </button>
      )}
    </div>
  )
}

/** A changed-file card under a step group: "signup.ts +4 -1", click for the diff. */
function FileChange({ part, mode }: { part: ToolPart; mode: TranscriptMode }) {
  const input = parsedInput(part)
  const diff = editDiff(part, input)
  const [open, setOpen] = useState(mode === 'verbose')
  if (!diff) return null
  const { added, removed } = countChanges(diff.lines)
  const created = part.name === 'Write' && !part.patch?.length
  return (
    <div className="file-card">
      <button className="file-card-head" onClick={() => setOpen(!open)}>
        <Icon name="file" size={15} />
        <span className="file-card-name">{fileName(input.file_path ?? input.notebook_path)}</span>
        {created && <span className="muted small">new</span>}
        <span className="grow" />
        <span className="ok-text small mono">+{added}</span>
        {!created && <span className="danger-text small mono">-{removed}</span>}
        <Icon name="chevron" size={14} className={'chev-i' + (open ? ' open' : '')} />
      </button>
      {open && <DiffView lines={diff.lines} numbered={diff.numbered} path={String(input.file_path ?? '')} />}
    </div>
  )
}

function TodoCard({ todos }: { todos: { content?: string; status?: string; activeForm?: string }[] }) {
  const done = todos.filter((t) => t.status === 'completed').length
  return (
    <div className="todo-card">
      <div className="todo-head">
        <Icon name="list" size={15} /> Tasks <span className="muted small">{done}/{todos.length}</span>
      </div>
      <ul className="todos">
        {todos.map((t, i) => (
          <li key={i} className={'todo ' + (t.status ?? '')}>
            <span className="todo-box">{t.status === 'completed' ? '✓' : ''}</span>
            <span>{t.status === 'in_progress' ? (t.activeForm ?? t.content) : t.content}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function StepDetail({ step, childrenOf, mode }: { step: Step; childrenOf: (id: string) => ChatMessage[]; mode: TranscriptMode }) {
  const [full, setFull] = useState(false)
  if (step.kind === 'thinking') return <div className="thinking-body">{step.text}</div>
  const input = parsedInput(step)
  const result = step.result ?? ''
  const LIMIT = 4000
  const diff = editDiff(step, input)
  const subs = childrenOf(step.toolUseId)
  const isAgent = step.name === 'Agent' || step.name === 'Task'
  return (
    <div className="step-detail">
      {diff ? (
        <DiffView lines={diff.lines} numbered={diff.numbered} path={String(input.file_path ?? '')} />
      ) : step.name === 'Bash' || step.name === 'PowerShell' ? (
        <pre className="tool-pre">
          <span className="muted">{step.name === 'Bash' ? '$ ' : 'PS> '}</span>
          {String(input.command ?? '')}
        </pre>
      ) : step.name === 'TodoWrite' && Array.isArray(input.todos) ? null : isAgent ? (
        <div className="muted small">{short(input.prompt, 400)}</div>
      ) : (
        <pre className="tool-pre">{JSON.stringify(input, null, 2)}</pre>
      )}
      {subs.length > 0 && (
        <div className="subagent">
          <Turn messages={subs} childrenOf={() => []} live={!step.done} mode={mode} nested />
        </div>
      )}
      {step.result !== undefined && !diff && !isAgent && step.name !== 'TodoWrite' && (
        <>
          <pre className={'tool-pre result' + (step.isError ? ' err' : '')}>
            {full ? result : result.slice(0, LIMIT)}
            {!full && result.length > LIMIT && '…'}
            {!result.trim() && <span className="muted">(no output)</span>}
          </pre>
          {result.length > LIMIT && (
            <button className="link-btn" onClick={() => setFull(!full)}>
              {full ? 'Show less' : `Show all (${result.length.toLocaleString()} chars)`}
            </button>
          )}
        </>
      )}
      {step.result !== undefined && step.isError && diff && <pre className="tool-pre result err">{result}</pre>}
      {step.result !== undefined && isAgent && <Markdown text={result} />}
    </div>
  )
}

function StepRow({ step, childrenOf, mode, last }: { step: Step; childrenOf: (id: string) => ChatMessage[]; mode: TranscriptMode; last: boolean }) {
  const [open, setOpen] = useState(false)
  const t = stepText(step)
  const running = step.kind === 'tool' ? !step.done : false
  const error = step.kind === 'tool' && step.isError
  const subs = step.kind === 'tool' ? childrenOf(step.toolUseId).length : 0
  return (
    <li className={'step' + (last ? ' last' : '') + (error ? ' error' : '')}>
      <span className={'step-icon' + (running ? ' running' : '')}>
        <Icon name={t.icon} size={14} />
      </span>
      <div className="step-main">
        <button className="step-head" onClick={() => setOpen(!open)}>
          <span className={'step-title' + (running ? ' shimmer' : '')}>{t.title}</span>
          {subs > 0 && <span className="muted small">{plural(subs, 'step')}</span>}
          {error && <span className="danger-text small">failed</span>}
          <Icon name="chevron" size={13} className={'chev-i' + (open ? ' open' : '')} />
        </button>
        {t.detail && !open && <div className="step-sub mono">{t.detail}</div>}
        {open && <StepDetail step={step} childrenOf={childrenOf} mode={mode} />}
      </div>
    </li>
  )
}

/** Consecutive tool calls and thinking, collapsed into one "steps" block like the Claude app. */
function StepGroup({ steps, live, childrenOf, mode }: { steps: Step[]; live: boolean; childrenOf: (id: string) => ChatMessage[]; mode: TranscriptMode }) {
  const [open, setOpen] = useState<boolean | null>(null)
  const expanded = open ?? mode === 'verbose'
  const tools = steps.filter((s): s is ToolPart => s.kind === 'tool')
  const running = tools.find((s) => !s.done)
  const current = running ?? (live ? steps[steps.length - 1] : undefined)
  const errors = tools.filter((s) => s.isError).length
  const edits = tools.filter((s) => ['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(s.name) && s.done && !s.isError)
  const todo = [...tools].reverse().find((s) => s.name === 'TodoWrite' && Array.isArray(parsedInput(s).todos))
  const onlyThinking = !tools.length
  const thinkingText = steps.map((s) => (s.kind === 'thinking' ? s.text : '')).join('\n\n').trim()

  // A turn that only thought shows a simple "Thought process" toggle.
  if (onlyThinking) {
    if (!thinkingText) return live ? <div className="step-group-head live"><span className="shimmer">Thinking…</span></div> : null
    return (
      <div className="step-group">
        <button className={'step-group-head' + (live ? ' live' : '')} onClick={() => setOpen(!expanded)}>
          <span className={live ? 'shimmer' : ''}>{live ? 'Thinking…' : 'Thought process'}</span>
          <Icon name="chevron" size={14} className={'chev-i' + (expanded ? ' open' : '')} />
        </button>
        {expanded && <div className="thinking-body">{thinkingText}</div>}
      </div>
    )
  }

  const liveTitle = current ? stepText(current).title + (current.kind === 'thinking' ? '…' : '') : undefined
  return (
    <div className="step-group">
      <button className={'step-group-head' + (live ? ' live' : '')} onClick={() => setOpen(!expanded)}>
        <span className={live && liveTitle ? 'shimmer' : ''}>{live && liveTitle ? liveTitle : summarize(steps)}</span>
        {errors > 0 && <span className="danger-text small">· {plural(errors, 'error')}</span>}
        <Icon name="chevron" size={14} className={'chev-i' + (expanded ? ' open' : '')} />
      </button>
      {expanded && (
        <ul className="steps">
          {steps.map((s, i) => (
            <StepRow key={s.kind === 'tool' ? s.toolUseId : 'th' + i} step={s} childrenOf={childrenOf} mode={mode} last={i === steps.length - 1} />
          ))}
        </ul>
      )}
      {!expanded && edits.length > 0 && (
        <div className="file-cards">
          {edits.map((e) => (
            <FileChange key={e.toolUseId} part={e} mode={mode} />
          ))}
        </div>
      )}
      {todo && <TodoCard todos={parsedInput(todo).todos as never} />}
    </div>
  )
}

type Block =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'artifact'; key: string; part: ToolPart }
  | { kind: 'output'; key: string; text: string }
  | { kind: 'steps'; key: string; steps: Step[] }
  | { kind: 'note'; key: string; message: ChatMessage }

function toBlocks(messages: ChatMessage[]): Block[] {
  const out: Block[] = []
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'error') {
      out.push({ kind: 'note', key: m.id, message: m })
      continue
    }
    // Built-in command output (/usage, /model…) is preformatted text, not Markdown.
    if (m.id.startsWith('cmd-') || m.id.startsWith('res-')) {
      const text = m.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('')
      // eslint-disable-next-line no-control-regex
      if (text.trim()) out.push({ kind: 'output', key: m.id, text: text.replace(/\x1b\[[0-9;]*m/g, '').replace(/\n+$/, '') })
      continue
    }
    m.parts.forEach((p, i) => {
      if (p.kind === 'text') {
        if (p.text.trim()) out.push({ kind: 'text', key: m.id + ':' + i, text: p.text })
        return
      }
      // Artifact tool calls show as cards in the conversation, not as steps.
      if (p.kind === 'tool' && isArtifactTool(p.name)) {
        out.push({ kind: 'artifact', key: p.toolUseId, part: p })
        return
      }
      const last = out[out.length - 1]
      if (last?.kind === 'steps') last.steps.push(p)
      else out.push({ kind: 'steps', key: m.id + ':' + i, steps: [p] })
    })
  }
  return out
}

/** The card Claude's artifact shows in the conversation; click to open it in the side panel. */
function ArtifactCard({ part, info, onOpen }: { part: ToolPart; info?: (id: string) => { title: string; type: ArtifactType; versions: number } | undefined; onOpen?: (id: string) => void }) {
  const input = parsedInput(part)
  const id = String(input.id ?? '')
  const known = id ? info?.(id) : undefined
  const type = (known?.type ?? (input.type as ArtifactType | undefined) ?? 'html') as ArtifactType
  const title = known?.title ?? (input.title ? String(input.title) : 'Artifact')
  const updating = part.name.endsWith('update_artifact')
  const status = !part.done ? (updating ? 'Updating…' : 'Writing…') : part.isError ? 'Failed' : updating ? `Updated${known ? ` · version ${known.versions}` : ''}` : ARTIFACT_LABEL[type]
  return (
    <button className={'artifact-chip' + (part.isError ? ' error' : '')} disabled={!part.done || part.isError || !onOpen || !id} onClick={() => onOpen?.(id)}>
      <span className="artifact-card-icon">
        <Icon name={artifactIcon(type)} size={18} />
      </span>
      <span className="artifact-card-text">
        <span className={'artifact-card-title' + (!part.done ? ' shimmer' : '')}>{title}</span>
        <span className={'small ' + (part.isError ? 'danger-text' : 'muted')}>{part.isError ? (part.result ?? 'Failed').slice(0, 160) : status}</span>
      </span>
      {part.done && !part.isError && <span className="artifact-open muted small">Open</span>}
    </button>
  )
}

/** Everything Claude did between two of your messages. */
export const Turn = memo(function Turn({
  messages,
  childrenOf,
  live,
  mode,
  nested = false,
  footer,
  artifactInfo,
  onOpenArtifact
}: {
  messages: ChatMessage[]
  childrenOf: (toolUseId: string) => ChatMessage[]
  live: boolean
  mode: TranscriptMode
  nested?: boolean
  footer?: ReactNode
  /** title/type of an artifact by id, for update calls that only carry the id */
  artifactInfo?: (id: string) => { title: string; type: ArtifactType; versions: number } | undefined
  onOpenArtifact?: (id: string) => void
}) {
  const blocks = toBlocks(messages)
  return (
    <div className={'turn' + (nested ? ' nested' : '')}>
      {blocks.map((b, i) => {
        if (b.kind === 'text') return <Markdown key={b.key} text={b.text} />
        if (b.kind === 'output')
          return (
            <pre key={b.key} className="cmd-output">
              {b.text}
            </pre>
          )
        if (b.kind === 'artifact') return <ArtifactCard key={b.key} part={b.part} info={artifactInfo} onOpen={onOpenArtifact} />
        if (b.kind === 'steps') return <StepGroup key={b.key} steps={b.steps} live={live && i === blocks.length - 1} childrenOf={childrenOf} mode={mode} />
        const text = b.message.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('')
        return b.message.role === 'error' ? (
          <div key={b.key} className="error-msg">
            <Markdown text={text} />
          </div>
        ) : (
          <div key={b.key} className="sys-note">
            {text}
          </div>
        )
      })}
      {footer}
    </div>
  )
})

export const UserMessage = memo(function UserMessage({ message, onRewind }: { message: ChatMessage; onRewind?: (messageId: string) => void }) {
  const text = message.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('')
  return (
    <div className="msg-user">
      {onRewind && (message.uuid || message.forkAt) && (
        <button className="rewind-btn" onClick={() => onRewind(message.id)} title="Rewind to before this message (Esc Esc)">
          <Icon name="rewind" size={14} />
        </button>
      )}
      <div className="bubble">
        {message.images ? <div className="muted small">📎 {plural(message.images, 'image')}</div> : null}
        <div className="user-text">{text}</div>
      </div>
    </div>
  )
})

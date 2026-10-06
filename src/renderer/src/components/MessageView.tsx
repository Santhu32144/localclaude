import { memo, useState, type ReactNode } from 'react'
import type { ArtifactType, ChatMessage, ContentPart } from '../../../shared/types'
import { ARTIFACT_LABEL, artifactIcon } from './ArtifactPanel'
import { countChanges, diffStrings, linesFromPatch, type DiffLine } from '../diff'
import { Icon } from './Icon'
import { Markdown } from './Markdown'

type ToolPart = Extract<ContentPart, { kind: 'tool' }>
type ThinkingPart = Extract<ContentPart, { kind: 'thinking' }>
type Step = ToolPart | ThinkingPart
export type TranscriptMode = 'normal' | 'verbose'

const COMPUTER_TOOL = 'mcp__computer-use__computer'

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
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
const host = (u: unknown): string => {
  try {
    return new URL(String(u)).host
  } catch {
    return short(u, 40)
  }
}

/** Compact name + detail for a tool (used by the permission prompt). */
export function describeTool(name: string, input: Record<string, unknown>): { icon: string; label: string; detail: string } {
  const s = stepText({ kind: 'tool', toolUseId: '', name, input, done: false })
  return { icon: s.icon, label: s.title, detail: s.detail ?? '' }
}

/** Plain-English line for a step, like the Claude app's activity list. */
function stepText(p: Step): { icon: string; title: string; detail?: string } {
  if (p.kind === 'thinking') return { icon: 'bulb', title: p.text.trim() ? 'Thought process' : 'Thinking' }
  const input = parsedInput(p)
  const done = p.done
  const v = (past: string, now: string): string => (done ? past : now)
  switch (p.name) {
    case 'Read':
      return { icon: 'file', title: `${v('Read', 'Reading')} ${fileName(input.file_path)}` }
    case 'Write':
      return { icon: 'pencil', title: `${v('Wrote', 'Writing')} ${fileName(input.file_path)}` }
    case 'Edit':
    case 'MultiEdit':
      return { icon: 'pencil', title: `${v('Edited', 'Editing')} ${fileName(input.file_path)}` }
    case 'NotebookEdit':
      return { icon: 'pencil', title: `${v('Edited', 'Editing')} ${fileName(input.notebook_path)}` }
    case 'Bash':
    case 'PowerShell':
      return { icon: 'terminal', title: input.description ? cap(short(input.description, 80)) : v('Ran a command', 'Running a command'), detail: short(input.command, 200) }
    case 'Grep':
      return { icon: 'search', title: `${v('Searched for', 'Searching for')} “${short(input.pattern, 50)}”` }
    case 'Glob':
      return { icon: 'search', title: `${v('Found files matching', 'Finding files matching')} ${short(input.pattern, 50)}` }
    case 'WebSearch':
      return { icon: 'globe', title: `${v('Searched the web for', 'Searching the web for')} “${short(input.query, 60)}”` }
    case 'WebFetch':
      return { icon: 'globe', title: `${v('Fetched', 'Fetching')} ${host(input.url)}` }
    case 'Agent':
    case 'Task':
      return { icon: 'agent', title: cap(short(input.description ?? input.prompt ?? 'Subagent', 80)), detail: input.subagent_type ? String(input.subagent_type) : undefined }
    case 'TodoWrite':
      return { icon: 'list', title: v('Updated the task list', 'Updating the task list') }
    case 'Skill':
      return { icon: 'sparkle', title: `${v('Used', 'Using')} the ${short(input.skill ?? input.command, 40)} skill` }
    case 'AskUserQuestion':
      return { icon: 'question', title: 'Asked you a question' }
    case 'ExitPlanMode':
      return { icon: 'list', title: 'Proposed a plan' }
    case COMPUTER_TOOL: {
      const c = input.coordinate as number[] | undefined
      const at = c ? ` at (${c.join(', ')})` : ''
      const a = String(input.action ?? '')
      const map: Record<string, [string, string]> = {
        screenshot: ['Took a screenshot', 'Taking a screenshot'],
        left_click: ['Clicked' + at, 'Clicking' + at],
        right_click: ['Right-clicked' + at, 'Right-clicking' + at],
        middle_click: ['Middle-clicked' + at, 'Middle-clicking' + at],
        double_click: ['Double-clicked' + at, 'Double-clicking' + at],
        triple_click: ['Triple-clicked' + at, 'Triple-clicking' + at],
        mouse_move: ['Moved the mouse' + at, 'Moving the mouse' + at],
        left_click_drag: ['Dragged' + at, 'Dragging' + at],
        scroll: [`Scrolled ${input.scroll_direction ?? 'down'}`, `Scrolling ${input.scroll_direction ?? 'down'}`],
        type: [`Typed “${short(input.text, 40)}”`, `Typing “${short(input.text, 40)}”`],
        key: [`Pressed ${short(input.text, 30)}`, `Pressing ${short(input.text, 30)}`],
        hold_key: [`Held ${short(input.text, 30)}`, `Holding ${short(input.text, 30)}`],
        wait: ['Waited', 'Waiting'],
        cursor_position: ['Checked the cursor position', 'Checking the cursor position']
      }
      const t = map[a] ?? ['Used the computer', 'Using the computer']
      return { icon: 'monitor', title: done ? t[0] : t[1] }
    }
    default:
      if (p.name.startsWith('mcp__')) {
        const [, server, ...tool] = p.name.split('__')
        return { icon: 'plug', title: `${v('Used', 'Using')} ${tool.join('__').replace(/_/g, ' ')}`, detail: server }
      }
      return { icon: 'sparkle', title: `${v('Used', 'Using')} ${p.name}`, detail: short(Object.values(input)[0], 80) }
  }
}

function editDiff(part: ToolPart, input: Record<string, unknown>): { lines: DiffLine[]; numbered: boolean } | null {
  if (part.patch?.length) return { lines: linesFromPatch(part.patch), numbered: true }
  if ((part.name === 'Edit' || part.name === 'MultiEdit') && typeof input.old_string === 'string')
    return { lines: diffStrings(String(input.old_string), String(input.new_string ?? '')), numbered: false }
  if (part.name === 'MultiEdit' && Array.isArray(input.edits)) {
    const lines = (input.edits as { old_string?: string; new_string?: string }[]).flatMap((e, i) => [
      ...(i ? [{ kind: 'gap' as const, text: '' }] : []),
      ...diffStrings(String(e.old_string ?? ''), String(e.new_string ?? ''))
    ])
    return { lines, numbered: false }
  }
  if (part.name === 'Write' && typeof input.content === 'string')
    return { lines: String(input.content).split('\n').map((text, i) => ({ kind: 'add' as const, text, newNo: i + 1 })), numbered: true }
  return null
}

/** "Read 2 files, edited signup.ts, ran a command" */
function summarize(steps: Step[]): string {
  const reads = new Set<string>()
  const edits = new Set<string>()
  let cmds = 0
  let searches = 0
  let web = 0
  let fetches = 0
  let computer = 0
  let agents = 0
  let tools = 0
  let todos = false
  let thought = false
  for (const s of steps) {
    if (s.kind === 'thinking') {
      thought = true
      continue
    }
    const i = parsedInput(s)
    switch (s.name) {
      case 'Read':
        reads.add(String(i.file_path ?? ''))
        break
      case 'Write':
      case 'Edit':
      case 'MultiEdit':
        edits.add(fileName(i.file_path))
        break
      case 'NotebookEdit':
        edits.add(fileName(i.notebook_path))
        break
      case 'Bash':
      case 'PowerShell':
        cmds++
        break
      case 'Grep':
      case 'Glob':
        searches++
        break
      case 'WebSearch':
        web++
        break
      case 'WebFetch':
        fetches++
        break
      case 'Agent':
      case 'Task':
        agents++
        break
      case 'TodoWrite':
        todos = true
        break
      case COMPUTER_TOOL:
        computer++
        break
      default:
        tools++
    }
  }
  const out: string[] = []
  if (reads.size) out.push(reads.size === 1 ? `read ${fileName([...reads][0])}` : `read ${reads.size} files`)
  if (searches) out.push(searches === 1 ? 'searched the code' : `searched the code ${searches} times`)
  if (web) out.push(web === 1 ? 'searched the web' : `ran ${web} web searches`)
  if (fetches) out.push(`fetched ${plural(fetches, 'page')}`)
  if (edits.size) out.push(edits.size <= 2 ? `edited ${[...edits].join(' and ')}` : `edited ${edits.size} files`)
  if (cmds) out.push(cmds === 1 ? 'ran a command' : `ran ${cmds} commands`)
  if (computer) out.push(`used the computer (${plural(computer, 'action')})`)
  if (agents) out.push(agents === 1 ? 'ran an agent' : `ran ${agents} agents`)
  if (tools) out.push(`used ${plural(tools, 'tool')}`)
  if (todos) out.push('updated tasks')
  if (!out.length) return thought ? 'Thought process' : 'Worked'
  return cap(out.join(', '))
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
      if (p.kind === 'tool' && p.name.startsWith('mcp__artifacts__')) {
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

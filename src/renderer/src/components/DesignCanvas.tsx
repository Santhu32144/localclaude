// The design canvas, beside the design's chat (like Claude Design): the design at desktop, tablet or
// mobile size, comments on any element, versions, and export as PDF, PNG or HTML.
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import { designKind } from '../../../shared/design'
import { artifactLang, fenced } from '../../../shared/format'
import { streamingFields, type StreamingField } from '../../../shared/partialJson'
import type { ToolPart } from '../../../shared/steps'
import type { Artifact, DesignInfo } from '../../../shared/types'
import { api } from '../api'
import { FRAMED, PreviewError, usePreviewError, type PanelState } from './ArtifactPanel'
import { Icon } from './Icon'
import { Markdown } from './Markdown'
import { Menu, type MenuEntry } from './Menu'
import { Spark } from './Spark'

/** An element picked in comment mode (the page sends it, see withDesignBridge). */
export interface DesignPick {
  selector: string
  tag: string
  text: string
  html: string
  rect: { x: number; y: number; w: number; h: number }
}

const ZOOMS = [
  { value: 0, label: 'Fit' },
  { value: 0.5, label: '50%' },
  { value: 0.75, label: '75%' },
  { value: 1, label: '100%' }
]
/** space around the design on the canvas */
const PAD = 28
/** the chat beside the canvas: drag the edge between them; double-click for the default */
const CHAT_WIDTH = { min: 300, default: 400 }
const MIN_CANVAS = 420

function readPref(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* per-viewer convenience only */
  }
}

function isPick(p: unknown): p is DesignPick {
  const x = p as DesignPick | null
  return !!x && typeof x.selector === 'string' && typeof x.tag === 'string' && typeof x.rect?.x === 'number'
}

interface Draft {
  id: string
  title: string
  updating: boolean
  /** the page so far, when it can be shown while it's written (a new page, or a rewrite, of HTML or SVG) */
  html: string | null
  /** how much Claude has written */
  size: number
}

/** The artifact Claude is writing, read from the tool call as it streams in. */
function draftOf(part: ToolPart | null | undefined, artifacts: Artifact[]): Draft | null {
  if (!part) return null
  const done = part.input && typeof part.input === 'object' && Object.keys(part.input).length > 0
  const f: Record<string, StreamingField> = done
    ? Object.fromEntries(Object.entries(part.input as Record<string, unknown>).map(([k, v]) => [k, { value: String(v ?? ''), done: true }]))
    : streamingFields(part.inputJsonPartial ?? '')
  const id = f.id?.done ? f.id.value : ''
  const target = artifacts.find((a) => a.id === id)
  const updating = part.name.endsWith('update_artifact')
  const type = updating ? target?.type : f.type?.done ? f.type.value : undefined
  // small edits (old_str → new_str) take a moment and show when they're done
  const html = f.content && (!type || type === 'html' || type === 'svg') ? f.content.value : null
  return { id, title: f.title?.value || target?.title || '', updating, html, size: done ? JSON.stringify(part.input).length : (part.inputJsonPartial ?? '').length }
}

/** The design as Claude writes it: the HTML so far, redrawn a few times a second (see DRAFT_PAGE). */
function DraftFrame({ html, width, height, scale }: { html: string; width: number; height: number; scale: number }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const latest = useRef(html)
  latest.current = html
  const sent = useRef<string | null>(null)
  const ready = useRef(false)
  const flush = (): void => {
    if (!ready.current || sent.current === latest.current) return
    sent.current = latest.current
    frame.current?.contentWindow?.postMessage({ __lcDraft: latest.current }, '*')
  }
  useEffect(() => {
    const t = setInterval(flush, 250)
    return () => clearInterval(t)
  }, [])
  return (
    <iframe
      ref={frame}
      className="design-draft"
      src="artifact://draft/"
      title="The design as Claude writes it"
      sandbox="allow-scripts"
      style={{ width, height, transform: `scale(${scale})` }}
      onLoad={() => {
        ready.current = true
        flush()
      }}
    />
  )
}

/** What Claude gets for a comment on one element of the design. */
export function commentMessage(title: string, pick: DesignPick, comment: string, version?: { n: number; of: number }): string {
  const lines = [
    `Comment on the design “${title}”${version ? ` (I'm looking at version ${version.n} of ${version.of})` : ''}, about this element:`,
    `- selector: \`${pick.selector}\``
  ]
  if (pick.text) lines.push(`- text: “${pick.text}”`)
  lines.push(`- HTML: ${fenced(pick.html, 'html')}`, '', comment.trim())
  return lines.join('\n')
}

export function DesignCanvas(props: {
  sessionId: string
  design: DesignInfo
  artifacts: Artifact[]
  /** the design shown; id null = the one Claude changed last */
  state: PanelState
  onState: (s: PanelState) => void
  busy: boolean
  /** the artifact tool call Claude is in the middle of, if any */
  writing?: ToolPart | null
  /** send a message in the design's chat */
  onSend: (text: string) => void
  onFix: (title: string, error: string) => void
  /** build the design in code, in a new chat */
  onHandoff: (artifactId: string, version: number) => void
}) {
  const kind = designKind(props.design.kind)
  const [viewportKey, setViewportKey] = useState(() => readPref('design.viewport.' + props.sessionId) ?? '')
  const vp = kind.viewports.find((v) => v.key === viewportKey) ?? kind.viewports[0]
  const [zoom, setZoom] = useState(0)
  const [view, setView] = useState<'preview' | 'code'>('preview')
  const [commenting, setCommenting] = useState(false)
  const [pick, setPick] = useState<DesignPick | null>(null)
  const [comment, setComment] = useState('')
  const [notice, setNotice] = useState<{ text: string; path?: string; error?: boolean } | null>(null)
  const [chatWidth, setChatWidth] = useState(() => Math.max(CHAT_WIDTH.min, Number(readPref('designChatWidth')) || CHAT_WIDTH.default))
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 })
  const root = useRef<HTMLElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const [error, setError] = usePreviewError(frame)

  const latest = props.artifacts.reduce<Artifact | undefined>((m, x) => (!m || x.updatedAt > m.updatedAt ? x : m), undefined)
  const a = props.artifacts.find((x) => x.id === props.state.id) ?? latest
  const vi = a ? Math.min(props.state.version ?? a.versions.length - 1, a.versions.length - 1) : 0
  const v = a?.versions[vi]
  const framed = !!a && FRAMED.includes(a.type)
  const src = a && v ? `artifact://view/${encodeURIComponent(props.sessionId)}/${encodeURIComponent(a.id)}/${vi}?t=${v.ts}&design=1` : ''
  const pageError = error?.src === src ? error.text : null

  // While Claude writes, the canvas shows the page so far; the last of it stays up until the finished page has loaded.
  const draft = draftOf(props.writing, props.artifacts)
  const [loadedSrc, setLoadedSrc] = useState('')
  const held = useRef<string | null>(null)
  if (draft?.html != null) held.current = draft.html
  else if (!draft && loadedSrc === src) held.current = null
  const liveHtml = draft?.html ?? held.current
  const preview = view === 'preview' && (liveHtml != null || framed)

  useLayoutEffect(() => {
    const el = stage.current
    if (!el) return
    const ro = new ResizeObserver(() => setStageSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [preview])

  useEffect(() => {
    if (!notice || notice.error === undefined) return
    const t = setTimeout(() => setNotice(null), notice.error ? 9000 : 6000)
    return () => clearTimeout(t)
  }, [notice])

  // The page tells us which element was clicked in comment mode, and when Esc was pressed in it.
  useEffect(() => {
    const onMessage = (e: MessageEvent): void => {
      if (!frame.current || e.source !== frame.current.contentWindow) return
      if (isPick(e.data?.__lcDesignPick)) {
        setPick(e.data.__lcDesignPick)
        setComment('')
      } else if (e.data?.__lcDesignKey === 'Escape') {
        setPick(null)
        setCommenting(false)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  const post = (msg: unknown): void => frame.current?.contentWindow?.postMessage(msg, '*')
  useEffect(() => {
    post({ __lcDesign: 'comment', on: commenting })
    if (!commenting) setPick(null)
  }, [commenting])
  // a new version reloads the page: whatever was picked is gone
  useEffect(() => setPick(null), [src])

  useEffect(() => {
    if (!commenting) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || (e.target as HTMLElement | null)?.closest?.('textarea, input')) return
      if (pick) closePick()
      else setCommenting(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [commenting, pick])

  const closePick = (): void => {
    setPick(null)
    post({ __lcDesign: 'release' })
  }
  const sendComment = (): void => {
    if (!a || !pick || !comment.trim() || props.busy) return
    const old = vi < a.versions.length - 1 ? { n: vi + 1, of: a.versions.length } : undefined
    props.onSend(commentMessage(a.title, pick, comment, old))
    closePick()
  }

  const runExport = async (format: 'pdf' | 'png'): Promise<void> => {
    if (!a) return
    setNotice({ text: `Exporting ${format.toUpperCase()}…` })
    const r = await api.exportDesign(props.sessionId, a.id, vi, format, vp.width, vp.height)
    if (r.canceled) setNotice(null)
    else if (r.ok && r.path) setNotice({ text: `Saved ${r.path.split(/[\\/]/).pop()}`, path: r.path, error: false })
    else setNotice({ text: r.error ?? 'Export failed.', error: true })
  }

  // drag the edge between the chat and the canvas
  const startResize = (e: MouseEvent): void => {
    e.preventDefault()
    const row = root.current?.parentElement?.getBoundingClientRect().width ?? 1200
    const startX = e.clientX
    const startW = chatWidth
    let w = startW
    document.body.classList.add('resizing-sidebar')
    const move = (ev: globalThis.MouseEvent): void => {
      w = Math.round(Math.max(CHAT_WIDTH.min, Math.min(row - MIN_CANVAS, startW + ev.clientX - startX)))
      setChatWidth(w)
    }
    const up = (): void => {
      document.body.classList.remove('resizing-sidebar')
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      writePref('designChatWidth', String(w))
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  // the design is drawn at its real width and scaled to fit (or to the zoom you chose)
  const availW = Math.max(0, stageSize.w - PAD * 2)
  const availH = Math.max(0, stageSize.h - PAD * 2)
  const fit = vp.height ? Math.min(1, availW / vp.width, availH / vp.height) : Math.min(1, availW / vp.width)
  const scale = zoom || fit || 1
  const frameH = vp.height ?? availH / scale

  // where the comment box goes: under the picked element, or above it near the bottom
  let pickPos: { left: number; top: number; above: boolean } | null = null
  if (pick && frame.current && stage.current) {
    const f = frame.current.getBoundingClientRect()
    const s = stage.current.getBoundingClientRect()
    const x = f.left - s.left + stage.current.scrollLeft + pick.rect.x * scale
    const below = f.top - s.top + (pick.rect.y + pick.rect.h) * scale + 8
    const above = below + 190 > s.height
    pickPos = {
      left: Math.max(8, Math.min(x, stage.current.scrollLeft + s.width - 328)),
      top: stage.current.scrollTop + (above ? f.top - s.top + pick.rect.y * scale - 8 : below),
      above
    }
  }

  const exportMenu: MenuEntry[] = a
    ? [
        { section: 'Export' },
        ...(framed
          ? [
              { key: 'pdf', label: 'PDF', hint: props.design.kind === 'slides' ? 'One page per slide' : 'Print-ready', onSelect: () => void runExport('pdf') },
              { key: 'png', label: 'PNG image', hint: `The whole page, ${vp.width}px wide`, onSelect: () => void runExport('png') }
            ]
          : []),
        { key: 'html', label: a.type === 'html' ? 'HTML file' : 'Source file', onSelect: () => void api.saveArtifact(props.sessionId, a.id, vi) },
        'divider',
        ...(framed ? [{ key: 'browser', label: 'Open in your browser', onSelect: () => void api.openArtifactInBrowser(props.sessionId, a.id, vi) }] : []),
        { key: 'copy', label: 'Copy code', onSelect: () => void navigator.clipboard.writeText(v?.content ?? '') },
        'divider',
        { key: 'handoff', label: 'Build it in code…', hint: 'A new chat in your project’s folder', onSelect: () => props.onHandoff(a.id, vi) }
      ]
    : []

  return (
    <section ref={root} className="design-canvas" style={{ width: `calc(100% - ${chatWidth}px)` }}>
      <div
        className="design-resizer"
        onMouseDown={startResize}
        onDoubleClick={() => {
          setChatWidth(CHAT_WIDTH.default)
          writePref('designChatWidth', String(CHAT_WIDTH.default))
        }}
        title="Drag to resize · double-click for the default width"
      />
      <div className="design-toolbar">
        {a ? (
          props.artifacts.length > 1 ? (
            <Menu
              className="design-pick-menu"
              title="Designs in this chat"
              trigger={
                <>
                  <span className="design-name">{a.title}</span>
                  <Icon name="chevronDown" size={13} />
                </>
              }
              entries={[...props.artifacts]
                .sort((x, y) => y.updatedAt - x.updatedAt)
                .map((x) => ({ key: x.id, label: x.title, checked: x.id === a.id, onSelect: () => props.onState({ id: x.id, version: null }) }))}
            />
          ) : (
            <span className="design-name" title={a.title}>
              {a.title}
            </span>
          )
        ) : (
          <span className={'design-name' + (draft?.title ? '' : ' muted')}>{draft?.title || kind.label}</span>
        )}
        {a && a.versions.length > 1 && (
          <Menu
            className="version-menu"
            title="Version history"
            trigger={
              <span className="small">
                v{vi + 1} <Icon name="chevronDown" size={12} />
              </span>
            }
            entries={a.versions
              .map((x, i) => ({
                key: String(i),
                label: `Version ${i + 1}${i === a.versions.length - 1 ? ' (latest)' : ''}`,
                hint: new Date(x.ts).toLocaleString(undefined, { hour: 'numeric', minute: '2-digit', month: 'short', day: 'numeric' }),
                checked: i === vi,
                onSelect: () => props.onState({ id: a.id, version: i === a.versions.length - 1 ? null : i })
              }))
              .reverse()}
          />
        )}
        <span className="grow" />
        {preview && (
          <>
            {kind.viewports.length > 1 && (
              <div className="seg-toggle design-viewports">
                {kind.viewports.map((x) => (
                  <button
                    key={x.key}
                    className={x.key === vp.key ? 'on' : ''}
                    title={`${x.label} · ${x.width}px`}
                    onClick={() => {
                      setViewportKey(x.key)
                      writePref('design.viewport.' + props.sessionId, x.key)
                    }}
                  >
                    <Icon name={x.icon} size={15} />
                  </button>
                ))}
              </div>
            )}
            <Menu
              className="design-zoom"
              align="right"
              title="Zoom"
              trigger={<span className="small">{zoom ? `${Math.round(zoom * 100)}%` : `Fit · ${Math.round(scale * 100)}%`}</span>}
              entries={ZOOMS.map((z) => ({ key: String(z.value), label: z.label, checked: zoom === z.value, onSelect: () => setZoom(z.value) }))}
            />
            <button
              className={'btn small design-comment-btn' + (commenting ? ' on' : '')}
              disabled={!framed || liveHtml != null}
              onClick={() => setCommenting(!commenting)}
              title={
                liveHtml != null ? 'You can comment once Claude has finished writing' : commenting ? 'Stop commenting (Esc)' : 'Click any part of the design to tell Claude what to change'
              }
            >
              <Icon name="comment" size={15} />
              Comment
            </button>
          </>
        )}
        {a && a.type !== 'code' && a.type !== 'markdown' && (
          <div className="seg-toggle">
            <button className={view === 'preview' ? 'on' : ''} onClick={() => setView('preview')}>
              Preview
            </button>
            <button className={view === 'code' ? 'on' : ''} onClick={() => setView('code')}>
              Code
            </button>
          </div>
        )}
        {a && <Menu className="design-export" align="right" title="Export" trigger={<Icon name="download" size={16} />} entries={exportMenu} />}
      </div>
      {notice && (
        <div className={'design-notice' + (notice.error ? ' error' : '')} role="status">
          <span>{notice.text}</span>
          {notice.path && (
            <button className="link-btn" onClick={() => void api.revealFile(notice.path!)}>
              Show in folder
            </button>
          )}
        </div>
      )}
      {framed && view === 'preview' && pageError && (
        <PreviewError
          text={pageError}
          busy={props.busy}
          onFix={() => {
            props.onFix(a!.title, pageError)
            setError(null)
          }}
          onDismiss={() => setError(null)}
        />
      )}
      {commenting && framed && view === 'preview' && !pick && liveHtml == null && <div className="design-hint">Click any part of the design to comment on it · Esc to stop</div>}

      {preview ? (
        <div ref={stage} className={'design-stage' + (commenting && liveHtml == null ? ' commenting' : '')}>
          {stageSize.w > 0 && (
            <div className={'design-frame' + (vp.height ? ' device' : '')} style={{ width: vp.width * scale, height: frameH * scale }}>
              {/* No allow-same-origin: the page gets an opaque origin and can't reach the app, its storage or your files. */}
              {a && v && framed && (
                <iframe
                  key={src}
                  ref={frame}
                  src={src}
                  title={a.title}
                  sandbox="allow-scripts allow-popups allow-forms allow-modals"
                  style={{ width: vp.width, height: frameH, transform: `scale(${scale})` }}
                  onLoad={() => {
                    setLoadedSrc(src)
                    post({ __lcDesign: 'comment', on: commenting })
                  }}
                />
              )}
              {liveHtml != null && <DraftFrame html={liveHtml} width={vp.width} height={frameH} scale={scale} />}
            </div>
          )}
          {pick && pickPos && (
            <div className={'design-comment' + (pickPos.above ? ' above' : '')} style={{ left: pickPos.left, top: pickPos.top }}>
              <div className="design-comment-target" title={pick.selector}>
                <span className="tag">{pick.tag}</span>
                <span className="design-comment-text">{pick.text || pick.selector}</span>
              </div>
              <textarea
                className="input"
                autoFocus
                rows={3}
                placeholder="What should change here?"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    e.stopPropagation()
                    closePick()
                  } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault()
                    sendComment()
                  }
                }}
              />
              <div className="row gap end">
                {props.busy && <span className="muted small grow">Claude is working; send when it’s done.</span>}
                <button className="btn ghost small" onClick={closePick}>
                  Cancel
                </button>
                <button className="btn primary small" disabled={!comment.trim() || props.busy} onClick={sendComment}>
                  Send
                </button>
              </div>
            </div>
          )}
        </div>
      ) : !a || !v ? (
        <div className="design-stage design-empty">
          <Spark size={40} animate={props.busy} className="welcome-spark" />
          <p>{props.busy ? (draft ? `Claude is writing ${draft.title || 'the design'}…` : 'Claude is designing…') : 'Your design will appear here.'}</p>
          {!props.busy && <p className="muted small">Describe what you want in the chat, and say what to change as it takes shape.</p>}
        </div>
      ) : view === 'code' || a.type === 'code' ? (
        <div className="design-stage artifact-code">
          <Markdown text={fenced(draft?.html ?? v.content, artifactLang(a))} />
        </div>
      ) : (
        <div className="design-stage artifact-doc">
          <Markdown text={v.content} />
        </div>
      )}
      {props.busy && preview && (
        <div className="design-writing" role="status">
          <Spark size={14} animate />
          {draft
            ? `${draft.updating ? 'Updating' : 'Writing'}${draft.title ? ` ${draft.title}` : ''}${draft.size > 1024 ? ` · ${(draft.size / 1024).toFixed(1)} KB` : ''}`
            : 'Claude is working…'}
        </div>
      )}
    </section>
  )
}

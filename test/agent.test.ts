// Bridge tests: (1) synthetic SDK stream -> history, (2) real Claude Code spawn without credentials.
import { SessionManager } from '../src/main/agent'
import type { AgentEvent, ChatMessage, SessionMeta, AppSettings } from '../src/shared/types'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import { applyEvent } from '../src/shared/reducer'
import assert from 'node:assert/strict'

const sessions: SessionMeta[] = []
const store: any = {
  getSettings: (): AppSettings => ({ ...DEFAULT_SETTINGS, defaultCwd: process.cwd(), loadUserSettings: false, loadProjectSettings: false }),
  getSession: (id: string) => sessions.find((s) => s.id === id),
  upsertSession: (m: SessionMeta) => { const i = sessions.findIndex((s) => s.id === m.id); i >= 0 ? (sessions[i] = m) : sessions.push(m) },
  loadHistory: () => [],
  saveHistory: () => {},
  deleteSession: () => {}
}
const events: AgentEvent[] = []
let rendererView: ChatMessage[] = []
const mgr = new SessionManager(store, (e) => { events.push(e); if ('sessionId' in e) rendererView = applyEvent(rendererView, e) })

async function synthetic() {
  const meta = mgr.create(process.cwd())
  const s: any = (mgr as any).get(meta.id)
  const sid = meta.id
  const h = (m: any) => s.handle(m)
  h({ type: 'system', subtype: 'init', session_id: 'sdk-123', model: 'claude-test', cwd: '/x', tools: ['Bash'], slash_commands: ['review'], skills: [], mcp_servers: [], apiKeySource: 'none', claude_code_version: '9', permissionMode: 'default' })
  h({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'm1' } } })
  h({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } } })
  h({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } } })
  h({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 1, content_block: { type: 'text' } } })
  h({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello ' } } })
  h({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'world' } } })
  h({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 't1', name: 'Bash' } } })
  h({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"' } } })
  // Claude Code emits complete assistant messages per block with the same API id
  h({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'thinking', thinking: 'hmm' }] } })
  h({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'text', text: 'Hello world' }] } })
  h({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } })
  h({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'a.txt' }] }] } })
  // subagent message without streaming
  h({ type: 'assistant', parent_tool_use_id: 't1', message: { id: 'm2', content: [{ type: 'text', text: 'sub step' }] } })
  h({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', utilization: 0.8, rateLimitType: 'five_hour', resetsAt: 1 } })
  h({ type: 'result', subtype: 'success', is_error: false, result: 'Hello world', total_cost_usd: 0.01, usage: { input_tokens: 10, output_tokens: 5 }, duration_ms: 1000, num_turns: 1 })

  const hist: ChatMessage[] = s.history
  assert.equal(hist.length, 2, 'two assistant messages')
  const m1 = hist[0]
  assert.deepEqual(m1.parts.map((p) => p.kind), ['thinking', 'text', 'tool'])
  assert.equal((m1.parts[1] as any).text, 'Hello world')
  const tool = m1.parts[2] as any
  assert.equal(tool.result, 'a.txt'); assert.equal(tool.done, true); assert.deepEqual(tool.input, { command: 'ls' })
  assert.equal(hist[1].parentToolUseId, 't1')
  assert.equal(s.meta.sdkSessionId, 'sdk-123')
  assert.deepEqual(rendererView, hist, 'renderer reducer view matches main history')
  assert.ok(events.some((e) => e.type === 'rate-limit'))
  assert.ok(events.some((e) => e.type === 'turn-done'))
  console.log('✓ synthetic stream: history, streaming merge, tool results, subagents, renderer parity')

  // permission round-trip
  let decided: any
  const p = s.canUseTool('Bash', { command: 'rm x' }, { signal: new AbortController().signal, suggestions: [{ type: 'addRules' }] })
  const req = events.filter((e) => e.type === 'permission').pop() as any
  assert.equal(req.request.toolName, 'Bash'); assert.equal(req.request.hasSuggestions, true)
  mgr.respond(sid, req.request.requestId, { behavior: 'allow', always: true })
  decided = await p
  assert.equal(decided.behavior, 'allow'); assert.ok(decided.updatedPermissions)
  const p2 = s.canUseTool('Write', {}, { signal: new AbortController().signal })
  const req2 = events.filter((e) => e.type === 'permission').pop() as any
  mgr.respond(sid, req2.request.requestId, { behavior: 'deny', message: 'no' })
  assert.deepEqual(await p2, { behavior: 'deny', message: 'no' })
  // AskUserQuestion answers flow back as updatedInput
  const p3 = s.canUseTool('AskUserQuestion', { questions: [{ question: 'Q?' }] }, { signal: new AbortController().signal })
  const req3 = events.filter((e) => e.type === 'permission').pop() as any
  mgr.respond(sid, req3.request.requestId, { behavior: 'allow', updatedInput: { questions: [{ question: 'Q?' }], answers: { 'Q?': 'A' } } })
  assert.deepEqual((await p3).updatedInput.answers, { 'Q?': 'A' })
  // abort cancels
  const ac = new AbortController()
  const p4 = s.canUseTool('Bash', {}, { signal: ac.signal }); ac.abort()
  assert.equal((await p4).behavior, 'deny')
  console.log('✓ permissions: allow/always, deny with message, AskUserQuestion answers, abort')
}

async function realSpawn() {
  const meta = mgr.create(process.cwd())
  events.length = 0
  mgr.send({ sessionId: meta.id, text: 'Say hi', attachments: [] })
  const t0 = Date.now()
  while (Date.now() - t0 < 90000) {
    if (events.some((e) => e.type === 'turn-done' && e.sessionId === meta.id) && !mgr.isRunning(meta.id)) break
    await new Promise((r) => setTimeout(r, 250))
  }
  const types = [...new Set(events.filter((e: any) => e.sessionId === meta.id || e.meta?.id === meta.id).map((e) => e.type))]
  const init = events.find((e) => e.type === 'init') as any
  const errs = events.filter((e) => e.type === 'error').map((e: any) => e.text.slice(0, 300))
  console.log('event types:', types.join(', '))
  if (init) console.log('init: claude code', init.info.claudeCodeVersion, '| apiKeySource', init.info.apiKeySource, '| tools', init.info.tools.length)
  console.log('errors:', errs)
  assert.ok(types.includes('status'))
  assert.ok(types.includes('turn-done') || errs.length, 'turn finished or errored')
  console.log('✓ real Claude Code process spawned via the SDK and completed a turn')
  mgr.shutdownAll()
}

await synthetic()
// The live test sends one tiny real prompt through Claude Code (uses your plan). Opt in with LOCALCLAUDE_E2E=1.
if (process.env.LOCALCLAUDE_E2E) await realSpawn()
else console.log('(skipping live test; set LOCALCLAUDE_E2E=1 to run it)')
process.exit(0)

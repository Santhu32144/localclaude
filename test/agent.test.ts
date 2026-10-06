// Bridge tests: (1) synthetic SDK stream -> history, (2) real Claude Code spawn without credentials.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { PROJECT_KNOWLEDGE_LIMIT, SessionManager, systemAppend } from '../src/main/agent'
import { ARTIFACT_TOOLS, createArtifactServer, renderArtifactPage } from '../src/main/artifacts'
import type { AgentEvent, ChatMessage, SessionMeta, AppSettings } from '../src/shared/types'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import { applyEvent } from '../src/shared/reducer'
import { countChanges, diffStrings, linesFromPatch } from '../src/renderer/src/diff'
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

async function checkpointsAndRewind() {
  const meta = mgr.create(process.cwd())
  const s: any = (mgr as any).get(meta.id)
  const sid = meta.id
  const h = (m: any) => s.handle(m)
  // don't spawn Claude Code: capture what would be sent
  const sent: any[] = []
  s.ensureStarted = () => { s.queue ??= { push: (m: any) => sent.push(m), close() {} } }

  // first message of a fresh chat: forks at "start", carries a checkpoint uuid
  mgr.send({ sessionId: sid, text: 'make a file', attachments: [] })
  const u1 = s.history[0]
  assert.equal(u1.forkAt, 'start'); assert.ok(u1.uuid); assert.equal(sent[0].uuid, u1.uuid)

  h({ type: 'system', subtype: 'init', session_id: 'sdk-rw', model: 'm', cwd: '/x', tools: [], slash_commands: [], skills: [], mcp_servers: [], apiKeySource: 'none', claude_code_version: '9', permissionMode: 'default' })
  h({ type: 'assistant', uuid: 'a-uuid-1', parent_tool_use_id: null, message: { id: 'r1', content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: 'a.ts', old_string: 'x', new_string: 'y' } }] } })
  const patch = [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-x', '+y'] }]
  h({ type: 'user', uuid: 'u-uuid-1', parent_tool_use_id: null, tool_use_result: { filePath: 'a.ts', structuredPatch: patch }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok' }] } })
  h({ type: 'assistant', uuid: 'a-uuid-2', parent_tool_use_id: null, message: { id: 'r2', content: [{ type: 'text', text: 'Done' }] } })
  h({ type: 'result', subtype: 'success', is_error: false, result: 'Done', total_cost_usd: 0, usage: {}, duration_ms: 1, num_turns: 1 })
  const edit = s.history.find((m: any) => m.id === 'a-r1').parts[0]
  assert.deepEqual(edit.patch, patch, 'structured patch attached to the Edit result')
  assert.equal(s.meta.tip, 'a-uuid-2', 'tip = last top-level transcript entry of the turn')

  // second message forks at the first turn's tip
  mgr.send({ sessionId: sid, text: 'now change it', attachments: [] })
  const u2 = s.history[s.history.length - 1]
  assert.equal(u2.forkAt, 'a-uuid-2')
  h({ type: 'result', subtype: 'success', is_error: false, result: '', total_cost_usd: 0, usage: {}, duration_ms: 1, num_turns: 1 })

  // code-only rewind asks Claude Code to restore files and keeps the conversation
  const calls: any[] = []
  s.q = { rewindFiles: async (id: string, o?: any) => (calls.push([id, o]), { canRewind: true, filesChanged: ['a.ts'], insertions: 1, deletions: 1 }), interrupt: async () => {} }
  const prev = await mgr.rewindPreview(sid, u2.id)
  assert.deepEqual(calls[0], [u2.uuid, { dryRun: true }]); assert.equal(prev.filesChanged?.length, 1)
  const before = s.history.length
  const rc = await mgr.rewind(sid, { messageId: u2.id, code: true, conversation: false })
  assert.ok(rc.ok); assert.equal(calls[2][0], u2.uuid); assert.equal(calls[2][1], undefined, 'real (non-dry) rewind')
  assert.equal(rc.filesChanged, 1); assert.equal(s.history.length, before + 1, 'adds a "Restored" note')

  // conversation rewind drops the message and everything after; next start resumes at the fork point
  events.length = 0
  s.running = false
  const rv = await mgr.rewind(sid, { messageId: u2.id, code: false, conversation: true })
  assert.ok(rv.ok); assert.equal(rv.text, 'now change it')
  assert.ok(!s.history.some((m: any) => m.id === u2.id))
  assert.equal(s.meta.resumeAt, 'a-uuid-2'); assert.equal(s.meta.sdkSessionId, 'sdk-rw')
  assert.ok(events.some((e) => e.type === 'history-reset'))
  delete s.ensureStarted
  const opts = s.buildOptions()
  assert.equal(opts.resume, 'sdk-rw'); assert.equal(opts.resumeSessionAt, 'a-uuid-2'); assert.equal(opts.enableFileCheckpointing, true)

  // rewinding the first message starts a fresh transcript
  s.ensureStarted = () => {}
  const r0 = await mgr.rewind(sid, { messageId: u1.id, code: false, conversation: true })
  assert.ok(r0.ok); assert.equal(s.history.length, 0); assert.equal(s.meta.sdkSessionId, undefined); assert.equal(s.meta.resumeAt, undefined)
  console.log('✓ checkpoints: uuids, fork points, structured diffs, code rewind, conversation rewind, resumeSessionAt')
}

async function slashCommandOutput() {
  const meta = mgr.create(process.cwd())
  const s: any = (mgr as any).get(meta.id)
  const h = (m: any) => s.handle(m)
  // built-in commands like /model report through local_command_output
  h({ type: 'system', subtype: 'local_command_output', content: 'Current model: Opus', uuid: 'c1', session_id: 'x' })
  h({ type: 'result', subtype: 'success', is_error: false, result: '', total_cost_usd: 0, usage: {}, duration_ms: 1, num_turns: 0 })
  assert.equal(s.history.at(-1).parts[0].text, 'Current model: Opus')
  // others only answer through the result text
  h({ type: 'result', subtype: 'success', is_error: false, result: 'Compacted.', total_cost_usd: 0, usage: {}, duration_ms: 1, num_turns: 0 })
  assert.equal(s.history.at(-1).parts[0].text, 'Compacted.')
  // a normal turn's result is not duplicated
  const n = s.history.length
  h({ type: 'assistant', uuid: 'q', parent_tool_use_id: null, message: { id: 'z1', content: [{ type: 'text', text: 'Hi' }] } })
  h({ type: 'result', subtype: 'success', is_error: false, result: 'Hi', total_cost_usd: 0, usage: {}, duration_ms: 1, num_turns: 1 })
  assert.equal(s.history.length, n + 1)
  console.log('✓ slash commands: local command output and result-only replies are shown')
}

async function computerUseOption() {
  const st = store.getSettings
  store.getSettings = () => ({ ...st(), computerUse: true })
  const meta = mgr.create(process.cwd())
  const opts = (mgr as any).get(meta.id).buildOptions()
  assert.equal(opts.mcpServers['computer-use']?.type, 'sdk', 'computer-use server registered in-process')
  store.getSettings = st
  const off = (mgr as any).get(mgr.create(process.cwd()).id).buildOptions()
  assert.equal(off.mcpServers['computer-use'], undefined)
  console.log('✓ computer use: in-process MCP server only when enabled')
}

async function artifactTool() {
  const saved: Record<string, any[]> = {}
  const changes: any[] = []
  const fakeStore: any = { loadArtifacts: (sid: string) => saved[sid] ?? [], saveArtifacts: (sid: string, list: any[]) => (saved[sid] = JSON.parse(JSON.stringify(list))) }
  const srv: any = createArtifactServer({ sessionId: 'chat1', store: fakeStore, onChange: (a) => changes.push(a) })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await srv.instance.connect(a)
  const client = new Client({ name: 't', version: '1' })
  await client.connect(b)
  const names = (await client.listTools()).tools.map((t) => t.name).sort()
  assert.deepEqual(names, ['create_artifact', 'update_artifact'])
  const call = async (name: string, args: any) => (await client.callTool({ name, arguments: args })) as any
  await call('create_artifact', { id: 'todo-app', type: 'react', title: 'Todo app', content: 'export default () => <p>hi</p>' })
  assert.equal(saved.chat1[0].versions.length, 1); assert.equal(changes.at(-1).title, 'Todo app')
  const up = await call('update_artifact', { id: 'todo-app', old_str: '<p>hi</p>', new_str: '<p>hello</p>' })
  assert.ok(!up.isError); assert.equal(saved.chat1[0].versions.at(-1).content, 'export default () => <p>hello</p>')
  assert.ok((await call('update_artifact', { id: 'todo-app', old_str: 'nope', new_str: 'x' })).isError, 'missing old_str fails')
  assert.ok((await call('update_artifact', { id: 'other', content: 'x' })).isError, 'unknown id fails')
  await call('update_artifact', { id: 'todo-app', content: 'v3', title: 'Todos' })
  assert.equal(saved.chat1[0].versions.length, 3); assert.equal(saved.chat1[0].title, 'Todos')
  assert.match(renderArtifactPage('react', 'export default function A(){}'), /importmap/)
  assert.match(renderArtifactPage('svg', '<svg/>'), /<svg\/>/)
  assert.ok(!renderArtifactPage('mermaid', 'graph TD; A-->B</script>').includes('A-->B</script>'), 'mermaid source is escaped')
  console.log('✓ artifacts: create, edit by snippet, rewrite, versions, errors, preview pages')
}

function projectPrompt() {
  const project: any = { id: 'p1', name: 'Firmware', description: 'F29 board', instructions: 'Answer in C.', files: [{ id: 'f1', name: 'spec.md', size: 5, addedAt: 0 }, { id: 'f2', name: 'big.txt', size: 9, addedAt: 0 }] }
  const files = { f1: 'SPEC', f2: 'x'.repeat(PROJECT_KNOWLEDGE_LIMIT + 50) }
  const out = systemAppend('Be brief.', project, { loadProjectFiles: () => files })!
  assert.ok(out.startsWith('Be brief.'))
  assert.match(out, /<project name="Firmware">/); assert.match(out, /Answer in C\./); assert.match(out, /<file name="spec.md">\nSPEC\n<\/file>/)
  assert.match(out, /\[truncated: project knowledge limit reached\]/)
  assert.equal(systemAppend('', undefined, { loadProjectFiles: () => ({}) }), undefined)
  // chats created in a project use its folder and get the artifacts tool without prompts
  const st = store.getSettings
  store.getProject = (id: string) => (id === 'p1' ? { ...project, cwd: 'C:\\proj' } : undefined)
  store.loadProjectFiles = () => files
  const meta = mgr.create(undefined, 'p1')
  assert.equal(meta.projectId, 'p1'); assert.equal(meta.cwd, 'C:\\proj')
  const opts = (mgr as any).get(meta.id).buildOptions()
  assert.equal(opts.mcpServers.artifacts?.type, 'sdk'); assert.deepEqual(opts.allowedTools, ARTIFACT_TOOLS)
  assert.match(opts.systemPrompt.append, /Answer in C\./)
  store.getSettings = st
  console.log('✓ projects: instructions + knowledge in the system prompt, size limit, project folder, artifacts tool')
}

function diffHelpers() {
  const lines = diffStrings('a\nb\nc', 'a\nB\nc\nd')
  assert.deepEqual(lines.map((l) => l.kind), ['ctx', 'del', 'add', 'ctx', 'add'])
  assert.deepEqual(countChanges(lines), { added: 2, removed: 1 })
  const fromPatch = linesFromPatch([{ oldStart: 10, oldLines: 2, newStart: 10, newLines: 2, lines: [' keep', '-old', '+new'] }])
  assert.deepEqual(fromPatch.map((l) => [l.kind, l.oldNo, l.newNo]), [['ctx', 10, 10], ['del', 11, undefined], ['add', undefined, 11]])
  console.log('✓ diff helpers: LCS line diff and structured patch numbering')
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
await checkpointsAndRewind()
await slashCommandOutput()
await computerUseOption()
diffHelpers()
await artifactTool()
projectPrompt()
// The live test sends one tiny real prompt through Claude Code (uses your plan). Opt in with LOCALCLAUDE_E2E=1.
if (process.env.LOCALCLAUDE_E2E) await realSpawn()
else console.log('(skipping live test; set LOCALCLAUDE_E2E=1 to run it)')
process.exit(0)

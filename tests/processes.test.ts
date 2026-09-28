import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../src/sessions/store.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { parseSessionData } from '../src/sessions/schema.js';
import { Agent } from '../src/core/agent.js';
import type { AgentEvent, ProcessRecord, Provider } from '../src/core/types.js';
import { canVerifyTask, markMutation, recordVerification, registerVerification, startRun, type SessionExecutionState } from '../src/core/run-state.js';
import type { Config } from '../src/config/load.js';

const posix = process.platform !== 'win32';
const skipWindows = 'POSIX process-group test is skipped on Windows';
const nodeCommand = (script: string) => `${process.execPath} -e '${script.replaceAll("'", `'"'"'`)}'`;
async function fixture(options: { processKill?: (pid: number, tree: boolean) => void } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'icy-process-')), cwd = path.join(root, 'workspace'), home = path.join(root, 'home');
  await mkdir(cwd);
  const config: Config = { home, cwd, provider: 'responses', baseUrl: 'http://127.0.0.1:1', model: 'fixture', apiKey: '', apiKeyEnv: 'ICY_TEST_KEY', permissions: 'workspace-edit', promptCompaction: 'off', compactionMinChars: 200, maxModelTurns: 20, maxToolCalls: 50, maxTokens: 100_000, maxContextChars: 120_000, requestTimeoutMs: 1000 };
  const store = await SessionStore.create(home, config, [], { processKill: options.processKill });
  const approvals: unknown[] = [], tools = new ToolRegistry(config, store, async request => { approvals.push(request); return 'once'; });
  const call = (id: string, name: string, args: unknown, signal = new AbortController().signal) => tools.execute({ id, name, arguments: JSON.stringify(args) }, signal);
  return { root, cwd, home, config, store, tools, approvals, call, cleanup: async () => { try { await store.close(); } finally { await rm(root, { recursive: true, force: true }); } } };
}

const bashArgs = (command: string, extra: Record<string, unknown> = {}) => ({ command, cwd: null, timeoutMs: null, detach: false, kill: null, ...extra });

test('running detached processes block verification even with current evidence, then require re-verification after exit', () => {
  const state: SessionExecutionState = { runs: [], processes: [] };
  startRun(state, 'long task', { maxModelTurns: 2, maxToolCalls: 2, maxTokens: 100, maxContextChars: 1000 });
  const check = registerVerification(state, { command: 'npm test', cwd: '/workspace' });
  const record: ProcessRecord = { id: '00000000-0000-4000-8000-000000000001', toolCallId: 'process-call', command: 'sleep 1', cwd: '/workspace', startedAt: new Date().toISOString(), timeoutMs: 60_000, status: 'running', bytes: 0 };
  state.processes!.push(record);
  recordVerification(state, check, { ok: true, output: '通过', mutationRevision: state.task!.mutationRevision });
  assert.equal(canVerifyTask(state), false);
  record.status = 'exited'; record.exitCode = 0; record.endedAt = new Date().toISOString(); markMutation(state);
  assert.equal(state.task!.mutationRevision, 1); assert.equal(canVerifyTask(state), false);
  recordVerification(state, check, { ok: true, output: '再次通过', mutationRevision: state.task!.mutationRevision });
  assert.equal(canVerifyTask(state), true);
});

test('resume increments mutationRevision exactly once for a formerly running process and invalidates evidence', async () => {
  const f = await fixture(); let resumed: SessionStore | undefined;
  try {
    f.store.data.task = { id: 'task-resume-process', goal: '恢复长任务', status: 'answered', remaining: [], completed: [], mutationRevision: 0,
      verificationChecks: [{ id: 'check-resume-process', source: 'user', command: 'npm test', cwd: f.cwd, createdAt: new Date().toISOString() }],
      verificationRecords: [{ id: 'record-resume-process', checkId: 'check-resume-process', source: 'user', command: 'npm test', cwd: f.cwd, ok: true, output: '通过', mutationRevision: 0, recordedAt: new Date().toISOString() }] };
    f.store.data.processes.push({ id: '00000000-0000-4000-8000-000000000002', toolCallId: 'process-call', command: 'sleep 30', cwd: f.cwd, pid: 2147483647, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), timeoutMs: 1_800_000, status: 'exited', exitCode: 0, bytes: 0 });
    assert.equal(canVerifyTask(f.store.data), true); f.store.data.processes[0].status = 'running'; delete f.store.data.processes[0].endedAt; assert.equal(canVerifyTask(f.store.data), false);
    await f.store.save(); await unlink(path.join(f.store.dir, 'lock'));
    const restored = await SessionStore.resume(f.home, f.store.data.id); resumed = restored.store;
    assert.equal(restored.unknownProcesses, 1); assert.equal(resumed.data.task!.mutationRevision, 1);
    assert.equal(resumed.data.task!.verificationRecords[0].mutationRevision, 0); assert.equal(canVerifyTask(resumed.data), false);
  } finally { await resumed?.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('foreground timeout above 60 seconds is rejected before approval', async () => {
  const f = await fixture();
  try {
    const result = await f.call('too-long', 'bash', bashArgs('true', { timeoutMs: 90_000 }));
    assert.equal(result.error, 'timeout_exceeds_foreground_limit'); assert.equal(f.approvals.length, 0);
  } finally { await f.cleanup(); }
});

test('detached output is persisted and paged by Unicode characters', { skip: !posix && skipWindows }, async () => {
  const f = await fixture();
  try {
    const result = await f.call('detached', 'bash', bashArgs(nodeCommand('process.stdout.write("中🙂猫😀");'), { detach: true }));
    assert.equal(result.ok, true); const reference = result.content.match(/icy-process:[0-9a-f-]+/)![0];
    const first = await f.call('read-1', 'read', { path: reference, offset: 1, limit: 2, depth: null, pattern: null, regex: null });
    assert.equal(first.ok, true); assert.match(first.content, /中🙂/); assert.match(first.content, /offset=3/);
    const second = await f.call('read-2', 'read', { path: reference, offset: 3, limit: 6000, depth: null, pattern: null, regex: null });
    assert.equal(second.ok, true); assert.match(second.content, /猫😀/); assert.match(second.content, /End of output/);
    const record = f.store.data.processes[0]; assert.equal(record.status, 'exited'); assert.equal(record.exitCode, 0);
    const log = await readFile(path.join(f.store.dir, 'processes', `${record.id}.log`), 'utf8'); assert.equal(log, '中🙂猫😀');
  } finally { await f.cleanup(); }
});

test('detached output is capped at 16 MiB and the process is terminated', { skip: !posix && skipWindows }, async () => {
  const f = await fixture();
  try {
    const result = await f.call('cap', 'bash', bashArgs(nodeCommand('process.stdout.write("a".repeat(17 * 1024 * 1024));'), { detach: true }));
    assert.equal(result.ok, true); const id = result.content.match(/icy-process:([0-9a-f-]+)/)![1];
    const record = await f.store.getProcessManager().status(id, { waitMs: 10_000 });
    assert.equal(record.status, 'output_limit'); assert.equal(record.truncated, true); assert.equal(record.bytes, 16 * 1024 * 1024);
    const log = await readFile(path.join(f.store.dir, 'processes', `${id}.log`)); assert.equal(log.byteLength, 16 * 1024 * 1024);
  } finally { await f.cleanup(); }
});

test('approval grants distinguish foreground and detached variants', { skip: !posix && skipWindows }, async () => {
  const f = await fixture();
  try {
    await f.call('foreground', 'bash', bashArgs('true'));
    await f.call('detached', 'bash', bashArgs('sleep 30', { detach: true }));
    assert.equal(f.approvals.length, 2); assert.equal((f.approvals[0] as { detach: boolean }).detach, false); assert.equal((f.approvals[1] as { detach: boolean }).detach, true);
  } finally { await f.cleanup(); }
});

test('detached timeout kills the process tree', { skip: !posix && skipWindows }, async () => {
  const f = await fixture();
  try {
    const started = await f.call('timeout', 'bash', bashArgs('sleep 30', { detach: true, timeoutMs: 100 }));
    const id = started.content.match(/icy-process:([0-9a-f-]+)/)![1], pid = f.store.data.processes[0].pid;
    const record = await f.store.getProcessManager().status(id, { waitMs: 3000 });
    assert.equal(record.status, 'timeout'); assert.equal(record.reason, 'timeout');
    if (pid) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { await f.cleanup(); }
});

test('kill has no approval and reports model_kill', { skip: !posix && skipWindows }, async () => {
  const f = await fixture();
  try {
    const started = await f.call('start', 'bash', bashArgs('sleep 30', { detach: true }));
    const reference = started.content.match(/icy-process:[0-9a-f-]+/)![0];
    const killed = await f.call('kill', 'bash', bashArgs('kill', { kill: reference }));
    assert.equal(killed.ok, true); assert.match(killed.content, /Status: killed/); assert.match(killed.content, /model_kill/); assert.equal(f.approvals.length, 1);
    const missing = await f.call('missing', 'bash', bashArgs('kill', { kill: 'icy-process:00000000-0000-4000-8000-000000000000' }));
    assert.equal(missing.error, 'process_not_found');
  } finally { await f.cleanup(); }
});

test('agent emits and persists process start and exit events', { skip: !posix && skipWindows }, async () => {
  const f = await fixture();
  try {
    let calls = 0; const provider: Provider = { async complete() {
      calls++;
      return calls === 1 ? { text: '', calls: [{ id: 'detached', name: 'bash', arguments: JSON.stringify(bashArgs(nodeCommand('setTimeout(() => {}, 150);'), { detach: true })) }] } : { text: 'done', calls: [] };
    } };
    const events: AgentEvent[] = [], agent = new Agent(f.config, provider, f.tools, f.store, event => events.push(event));
    assert.equal((await agent.run('start a server', new AbortController().signal)).ok, true);
    await new Promise(resolve => setTimeout(resolve, 300));
    const processEvents = events.filter((event): event is Extract<AgentEvent, { type: 'process' }> => event.type === 'process');
    assert.deepEqual(processEvents.map(event => event.record.status), ['running', 'exited']);
    assert.match(await readFile(path.join(f.store.dir, 'events.jsonl'), 'utf8'), /"type":"process"/);
  } finally { await f.cleanup(); }
});

test('cancellation does not kill detached work but closeAll does', { skip: !posix && skipWindows }, async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    const started = await f.call('cancel', 'bash', bashArgs('sleep 30', { detach: true }), controller.signal);
    controller.abort(); const record = f.store.data.processes[0]; assert.equal(record.status, 'running');
    await f.store.close(); assert.equal(record.status, 'killed'); assert.equal(record.reason, 'session_closed');
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('resume turns running records into unknown without relaunching them', { skip: !posix && skipWindows }, async () => {
  const f = await fixture();
  let resumed: SessionStore | undefined;
  try {
    const started = await f.call('persist', 'bash', bashArgs('sleep 30', { detach: true }));
    const id = started.content.match(/icy-process:([0-9a-f-]+)/)![1], pid = f.store.data.processes[0].pid;
    await f.store.save(); await unlink(path.join(f.store.dir, 'lock'));
    const restored = await SessionStore.resume(f.home, f.store.data.id); resumed = restored.store;
    assert.equal(restored.unknownProcesses, 1); assert.equal(resumed.data.processes[0].status, 'unknown');
    assert.equal(resumed.data.processes[0].reason, 'icy_restarted'); assert.equal(resumed.data.processes[0].pidAlive, true);
    const killed = await resumed.getProcessManager().kill(id, 'model_kill'); assert.equal(killed.status, 'killed');
    assert.equal(killed.reason, 'model_kill');
    if (pid) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  } finally { await resumed?.close(); await rm(f.root, { recursive: true, force: true }); }
});

test('v1 and v2 snapshots without processes remain loadable while malformed records are rejected', async () => {
  const now = new Date().toISOString(), legacy = { version: 1, id: 'fixture', cwd: process.cwd(), provider: 'responses', model: 'fixture', baseUrl: 'https://example.test/v1', messages: [], updatedAt: now };
  const migrated = parseSessionData(legacy, 'fixture'); assert.deepEqual(migrated.processes, []);
  const modern = parseSessionData({ ...legacy, version: 2, runs: [] }, 'fixture'); assert.deepEqual(modern.processes, []);
  assert.throws(() => parseSessionData({ ...modern, processes: [{ id: 'bad' }] }, 'fixture'), /processes\.0/);
});

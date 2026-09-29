import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { appendFile, mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import type { ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { SessionStore } from '../src/sessions/store.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { killBashTree } from '../src/tools/bash.js';
import { parseSessionData } from '../src/sessions/schema.js';
import { Agent } from '../src/core/agent.js';
import type { AgentEvent, ProcessRecord, Provider } from '../src/core/types.js';
import { canVerifyTask, markMutation, recordVerification, registerVerification, startRun, type SessionExecutionState } from '../src/core/run-state.js';
import type { Config } from '../src/config/load.js';
import type { ProcessManagerOptions } from '../src/tools/processes.js';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const posix = process.platform !== 'win32';
const skipWindows = 'POSIX process-group test is skipped on Windows';
const nodeCommand = (script: string) => `${process.execPath} -e '${script.replaceAll("'", `'"'"'`)}'`;
async function fixture(options: {
  platform?: NodeJS.Platform; shellPath?: string; processSpawn?: ProcessManagerOptions['spawn'];
  processKill?: ProcessManagerOptions['kill']; processIdentity?: ProcessManagerOptions['captureIdentity'];
  processExecFile?: ProcessManagerOptions['execFile']; processAlive?: ProcessManagerOptions['isAlive']; processOutputLimit?: number;
  processAppendFile?: ProcessManagerOptions['processAppendFile'];
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'icy-process-')), cwd = path.join(root, 'workspace'), home = path.join(root, 'home');
  await mkdir(cwd);
  const config: Config = { home, cwd, provider: 'responses', baseUrl: 'http://127.0.0.1:1', model: 'fixture', apiKey: '', apiKeyEnv: 'ICY_TEST_KEY', permissions: 'workspace-edit', promptCompaction: 'off', compactionMinChars: 200, maxModelTurns: 20, maxToolCalls: 50, maxTokens: 100_000, maxContextChars: 120_000, requestTimeoutMs: 1000 };
  const store = await SessionStore.create(home, config, [], {
    platform: options.platform === 'win32' ? undefined : options.platform, processPlatform: options.platform, shellPath: options.shellPath, processSpawn: options.processSpawn, processKill: options.processKill,
    processIdentity: options.processIdentity, processExecFile: options.processExecFile, processAlive: options.processAlive, processOutputLimit: options.processOutputLimit,
    processAppendFile: options.processAppendFile,
  });
  const approvals: unknown[] = [], tools = new ToolRegistry(config, store, async request => { approvals.push(request); return 'once'; });
  const call = (id: string, name: string, args: unknown, signal = new AbortController().signal) => tools.execute({ id, name, arguments: JSON.stringify(args) }, signal);
  return { root, cwd, home, config, store, tools, approvals, call, cleanup: async () => { try { await store.close(); } finally { await rm(root, { recursive: true, force: true }); } } };
}
function fakeChild(pid = 4242): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  Object.assign(child, { pid, exitCode: null, signalCode: null, stdout: null, stderr: null });
  return child;
}

const bashArgs = (command: string, extra: Record<string, unknown> = {}) => ({ command, cwd: null, timeoutMs: null, detach: false, kill: null, ...extra });
const identityToken = (date: Date) => {
  if (!posix) return date.toISOString();
  const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${weekdays[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, ' ')} ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}:${String(date.getUTCSeconds()).padStart(2, '0')} ${date.getUTCFullYear()}`;
};

test('running detached processes block verification even with current evidence, then require re-verification after exit', () => {
  const state: SessionExecutionState = { runs: [], processes: [] };
  startRun(state, 'long task', { maxModelTurns: 2, maxToolCalls: 2, maxTokens: 100, maxContextChars: 1000 });
  const check = registerVerification(state, { command: 'npm test', cwd: '/workspace' });
  const record: ProcessRecord = { id: '00000000-0000-4000-8000-000000000001', toolCallId: 'process-call', command: 'sleep 1', cwd: '/workspace', startedAt: new Date().toISOString(), timeoutMs: 60_000, status: 'running', bytes: 0 };
  state.processes!.push(record);
  recordVerification(state, check, { ok: true, output: '通过', mutationRevision: state.task!.mutationRevision });
  assert.equal(canVerifyTask(state), false);
  record.status = 'unknown'; record.pidAlive = true; assert.equal(canVerifyTask(state), false);
  record.status = 'exited'; record.pidAlive = false; record.exitCode = 0; record.endedAt = new Date().toISOString(); markMutation(state);
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
    assert.equal(result.error, 'timeout_exceeds_foreground_limit'); assert.match(result.content, /detach: true/); assert.equal(f.approvals.length, 0);
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
    const record = await f.store.getProcessManager().status(f.store.data.processes[0].id, { waitMs: 10_000 }); assert.equal(record.status, 'exited'); assert.equal(record.exitCode, 0);
    const log = await readFile(path.join(f.store.dir, 'processes', `${record.id}.log`), 'utf8'); assert.equal(log, '中🙂猫😀');
  } finally { await f.cleanup(); }
});

test('detached output is capped at the configured limit and the process is terminated', { skip: !posix && skipWindows }, async () => {
  const outputLimit = 256 * 1024, f = await fixture({ processOutputLimit: outputLimit });
  try {
    const result = await f.call('cap', 'bash', bashArgs(nodeCommand('process.stdout.write("a".repeat(300 * 1024));'), { detach: true }));
    assert.equal(result.ok, true); const id = result.content.match(/icy-process:([0-9a-f-]+)/)![1];
    const record = await f.store.getProcessManager().status(id, { waitMs: 10_000 });
    assert.equal(record.status, 'output_limit'); assert.equal(record.truncated, true); assert.equal(record.bytes, outputLimit);
    const log = await readFile(path.join(f.store.dir, 'processes', `${id}.log`)); assert.equal(log.byteLength, outputLimit);
  } finally { await f.cleanup(); }
});

test('terminal status waits for a delayed process log drain', { skip: !posix && skipWindows }, async () => {
  const outputLimit = 256 * 1024;
  let appendCalls = 0, resolveSecondAppend!: () => void;
  const secondAppendStarted = new Promise<void>(resolve => { resolveSecondAppend = resolve; });
  const f = await fixture({
    processOutputLimit: outputLimit,
    processAppendFile: async (file, data) => {
      appendCalls++;
      if (appendCalls === 2) {
        resolveSecondAppend();
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      return appendFile(file, data);
    },
  });
  try {
    const result = await f.call('cap-drain-race', 'bash', bashArgs(nodeCommand('process.stdout.write("a".repeat(300 * 1024));'), { detach: true }));
    const id = result.content.match(/icy-process:([0-9a-f-]+)/)![1];
    await secondAppendStarted;
    const record = f.store.data.processes[0];
    while (record.status === 'running') await new Promise<void>(resolve => setImmediate(resolve));
    const terminal = await f.store.getProcessManager().status(id);
    assert.equal(terminal.status, 'output_limit'); assert.equal(terminal.bytes, outputLimit); assert.ok(appendCalls >= 2);
    const expected = 'a'.repeat(outputLimit);
    const log = await readFile(path.join(f.store.dir, 'processes', `${id}.log`)); assert.equal(log.toString(), expected);
    let offset = 1, output = '';
    while (true) {
      const page = await f.store.getProcessManager().readOutput(id, offset, 6000);
      output += page.text;
      if (!page.truncated) break;
      offset = page.end + 1;
    }
    assert.equal(output, expected);
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

test('resume refuses to kill a live process when its identity no longer matches', async () => {
  let killCalls = 0, alive = true;
  const f = await fixture({
    processIdentity: () => 'different', processAlive: () => alive,
    processKill: () => { killCalls++; alive = false; },
  });
  let resumed: SessionStore | undefined;
  try {
    const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    f.store.data.processes.push({ id, toolCallId: 'identity-mismatch', command: 'sleep 30', cwd: f.cwd, pid: 4242,
      identity: 'expected', startedAt: new Date().toISOString(), timeoutMs: 60_000, status: 'running', bytes: 0 });
    await f.store.save(); await unlink(path.join(f.store.dir, 'lock'));
    resumed = (await SessionStore.resume(f.home, f.store.data.id, [], {
      processIdentity: () => 'different', processAlive: () => alive, processKill: () => { killCalls++; alive = false; },
    })).store;
    const record = resumed.data.processes[0];
    assert.equal(record.status, 'unknown'); assert.equal(record.pidAlive, true); assert.equal(record.reason, 'identity_unconfirmed');
    const result = await resumed.getProcessManager().kill(id, 'user_kill');
    assert.equal(result.status, 'unknown'); assert.equal(result.pidAlive, true); assert.equal(result.reason, 'identity_unconfirmed');
    assert.equal(await resumed.getProcessManager().closeAll(), 0);
    assert.equal(killCalls, 0, 'an unconfirmed PID must never be signalled');
  } finally {
    alive = false;
    await resumed?.close();
    if (f.store.data.processes[0]) f.store.data.processes[0].status = 'exited';
    await f.cleanup();
  }
});

test('resume kills a live process whose identity matches', { skip: !posix && skipWindows }, async () => {
  const f = await fixture({ processIdentity: () => 'matching-identity' });
  let resumed: SessionStore | undefined;
  try {
    const started = await f.call('identity-match', 'bash', bashArgs('sleep 30', { detach: true }));
    const id = started.content.match(/icy-process:([0-9a-f-]+)/)![1], pid = f.store.data.processes[0].pid;
    await f.store.save(); await unlink(path.join(f.store.dir, 'lock'));
    resumed = (await SessionStore.resume(f.home, f.store.data.id, [], { processIdentity: () => 'matching-identity' })).store;
    const result = await resumed.getProcessManager().kill(id, 'user_kill');
    assert.equal(result.status, 'killed'); assert.equal(result.reason, 'user_kill');
    assert.ok(pid); assert.throws(() => process.kill(pid!, 0), { code: 'ESRCH' });
  } finally { await resumed?.close(); await f.cleanup(); }
});

test('closeAll terminates matching processes recovered from a snapshot and releases the lock', { skip: !posix && skipWindows }, async () => {
  const f = await fixture({ processIdentity: () => 'matching-identity' });
  let resumed: SessionStore | undefined;
  try {
    const started = await f.call('close-after-resume', 'bash', bashArgs('sleep 30', { detach: true }));
    const id = started.content.match(/icy-process:([0-9a-f-]+)/)![1], pid = f.store.data.processes[0].pid;
    await f.store.save(); await unlink(path.join(f.store.dir, 'lock'));
    resumed = (await SessionStore.resume(f.home, f.store.data.id, [], { processIdentity: () => 'matching-identity' })).store;
    const terminated = await resumed.close();
    assert.equal(terminated, 1); assert.equal(resumed.data.processes[0].status, 'killed');
    assert.equal(resumed.data.processes[0].reason, 'session_closed');
    assert.ok(pid); assert.throws(() => process.kill(pid!, 0), { code: 'ESRCH' });
    await assert.rejects(readFile(path.join(resumed.dir, 'lock')), { code: 'ENOENT' });
    resumed = undefined;
  } finally { await resumed?.close(); await f.cleanup(); }
});

test('recovered timeout watchdogs terminate expired work, unref their timer, and do not leak timers', { skip: !posix && skipWindows }, async () => {
  const killedPids = new Set<number>();
  const f = await fixture({
    processIdentity: () => 'matching-identity', processAlive: pid => !killedPids.has(pid),
    processKill: (pid, _tree, signal) => { killedPids.add(Math.abs(pid)); process.kill(pid, signal ?? 'SIGTERM'); },
  });
  let resumed: SessionStore | undefined;
  try {
    await f.call('expired-watchdog', 'bash', bashArgs('sleep 30', { detach: true }));
    await f.call('armed-watchdog', 'bash', bashArgs('sleep 30', { detach: true }));
    const [expired, watched] = f.store.data.processes, pids = f.store.data.processes.map(record => record.pid);
    expired.startedAt = new Date(Date.now() - 10_000).toISOString(); expired.timeoutMs = 100;
    watched.startedAt = new Date().toISOString(); watched.timeoutMs = 1500;
    await f.store.save(); await unlink(path.join(f.store.dir, 'lock'));
    resumed = (await SessionStore.resume(f.home, f.store.data.id, [], {
      processIdentity: () => 'matching-identity', processAlive: pid => !killedPids.has(pid),
      processKill: (pid, _tree, signal) => { killedPids.add(Math.abs(pid)); process.kill(pid, signal ?? 'SIGTERM'); },
    })).store;
    assert.equal(resumed.data.processes[0].status, 'timeout'); assert.equal(resumed.data.processes[0].reason, 'timeout');
    const manager = resumed.getProcessManager() as unknown as { watchdogs: Map<string, { hasRef?: () => boolean }> };
    const timer = manager.watchdogs.get(watched.id);
    assert.ok(timer); assert.equal(timer.hasRef?.(), false, 'a recovered watchdog must be unrefed');
    await new Promise(resolve => setTimeout(resolve, 2000));
    const result = await resumed.getProcessManager().status(watched.id);
    assert.equal(result.status, 'timeout'); assert.equal(result.reason, 'timeout');
    for (const pid of pids) if (pid) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    await resumed.getProcessManager().closeAll();
    assert.equal(manager.watchdogs.size, 0, 'closeAll must clear recovered watchdog timers');
  } finally { await resumed?.close(); await f.cleanup(); }
});

test('watchdog retries a transient identity capture failure and then terminates the recovered process', { skip: !posix && skipWindows }, async () => {
  let captures = 0, alive = true;
  const identity = () => { captures++; return captures === 3 ? undefined : 'retry-token'; };
  const child = fakeChild(7100), processSpawn = (() => child) as unknown as typeof spawn;
  const f = await fixture({ processSpawn, processIdentity: identity, processAlive: () => alive, processKill: () => { alive = false; } });
  let resumed: SessionStore | undefined;
  try {
    await f.store.getProcessManager().start({ toolCallId: 'watchdog-retry', command: 'sleep 30', cwd: f.cwd, timeoutMs: 60_000 });
    const record = f.store.data.processes[0]; record.startedAt = new Date(Date.now() - 10_000).toISOString(); record.timeoutMs = 100;
    await f.store.save(); await unlink(path.join(f.store.dir, 'lock'));
    resumed = (await SessionStore.resume(f.home, f.store.data.id, [], { processSpawn, processIdentity: identity, processAlive: () => alive, processKill: () => { alive = false; } })).store;
    assert.equal(resumed.data.processes[0].status, 'unknown'); assert.equal(resumed.data.processes[0].pidAlive, true);
    assert.equal(resumed.data.processes[0].reason, 'identity_unconfirmed');
    const manager = resumed.getProcessManager() as unknown as { watchdogs: Map<string, { hasRef?: () => boolean }> };
    assert.ok(manager.watchdogs.get(record.id));
    await new Promise(resolve => setTimeout(resolve, 5_800));
    assert.equal(resumed.data.processes[0].status, 'timeout'); assert.ok(captures >= 4);
  } finally {
    f.store.data.processes[0].status = 'exited'; alive = false; child.emit('close', 0, null);
    await new Promise(resolve => setTimeout(resolve, 20));
    await resumed?.close(); await f.cleanup();
  }
});

test('identity capture timeout does not postpone the detached process timeout', { skip: !posix && skipWindows }, async () => {
  const f = await fixture({ processIdentity: () => new Promise<string | undefined>(() => {}) });
  try {
    const startedAt = Date.now();
    const record = await f.store.getProcessManager().start({ toolCallId: 'identity-timeout', command: 'sleep 30', cwd: f.cwd, timeoutMs: 100 });
    assert.ok(Date.now() - startedAt < 3_500); assert.notEqual(record.status, 'running');
    assert.equal(record.reason, 'timeout');
  } finally { await f.cleanup(); }
});

test('a failed terminal snapshot does not block status or the next successful save', { skip: !posix && skipWindows }, async () => {
  const f = await fixture();
  const originalSave = f.store.save.bind(f.store); let rejectOnce = true;
  try {
    const started = await f.call('persist-failure', 'bash', bashArgs('sleep 1', { detach: true }));
    const id = started.content.match(/icy-process:([0-9a-f-]+)/)![1];
    f.store.save = async () => {
      if (rejectOnce) { rejectOnce = false; throw new Error('injected_save_failure'); }
      return originalSave();
    };
    const terminal = await f.store.getProcessManager().status(id, { waitMs: 3000 });
    assert.notEqual(terminal.status, 'running');
    const read = await f.call('read-after-save-failure', 'read', { path: `icy-process:${id}`, offset: 1, limit: 10, depth: null, pattern: null, regex: null });
    assert.equal(read.ok, true); assert.match(read.content, /Status: (?:exited|killed|timeout|output_limit|spawn_error)/);
    await originalSave();
    const snapshot = JSON.parse(await readFile(path.join(f.store.dir, 'session.json'), 'utf8')) as { processes: ProcessRecord[] };
    assert.equal(snapshot.processes.find(record => record.id === id)?.status, terminal.status);
  } finally { f.store.save = originalSave; await f.cleanup(); }
});

test('unknown live processes still block verification until death is confirmed after resume', { skip: !posix && skipWindows }, async () => {
  const f = await fixture({ processIdentity: () => 'matching-identity' });
  let resumed: SessionStore | undefined;
  try {
    const started = await f.call('verification-process', 'bash', bashArgs('sleep 30', { detach: true }));
    const record = f.store.data.processes[0];
    f.store.data.task = { id: 'verification-task', goal: '验收后台任务', status: 'answered', remaining: [], completed: [], mutationRevision: 0, verificationChecks: [], verificationRecords: [] };
    const checkId = registerVerification(f.store.data, { command: 'test -f result', cwd: f.cwd });
    recordVerification(f.store.data, checkId, { ok: true, output: '通过', mutationRevision: 0 });
    await f.store.save(); await unlink(path.join(f.store.dir, 'lock'));
    resumed = (await SessionStore.resume(f.home, f.store.data.id, [], { processIdentity: () => 'matching-identity' })).store;
    assert.equal(resumed.data.processes[0].status, 'unknown'); assert.equal(resumed.data.processes[0].pidAlive, true);
    const resumedCheck = resumed.data.task!.verificationChecks[0].id;
    recordVerification(resumed.data, resumedCheck, { ok: true, output: '仍然通过', mutationRevision: resumed.data.task!.mutationRevision });
    assert.equal(canVerifyTask(resumed.data), false);
    const killed = await resumed.getProcessManager().kill(record.id, 'user_kill');
    assert.equal(killed.status, 'killed'); assert.equal(killed.pidAlive, false);
    recordVerification(resumed.data, resumedCheck, { ok: true, output: '确认结束后通过', mutationRevision: resumed.data.task!.mutationRevision });
    assert.equal(canVerifyTask(resumed.data), true);
  } finally { await resumed?.close(); await f.cleanup(); }
});

test('kill racing with a queued close observes the child exit instead of returning running', async () => {
  const child = fakeChild(), fakePlatform = process.platform === 'win32' ? 'win32' : process.platform;
  const processSpawn = (() => child) as unknown as typeof spawn;
  const f = await fixture({ platform: fakePlatform, shellPath: fakePlatform === 'win32' ? 'C:\\Git\\bin\\bash.exe' : '/bin/bash', processSpawn, processIdentity: () => 'matching-identity', processKill: () => { throw new Error('must not kill an exited child'); } });
  try {
    const started = await f.store.getProcessManager().start({ toolCallId: 'race', command: 'sleep 30', cwd: f.cwd, timeoutMs: 10_000 });
    (child as unknown as { exitCode: number }).exitCode = 0;
    const killing = f.store.getProcessManager().kill(started.id, 'user_kill');
    child.emit('close', 0, null);
    const result = await killing;
    assert.equal(result.status, 'exited'); assert.equal(result.exitCode, 0); assert.notEqual(result.status, 'running');
  } finally { await f.cleanup(); }
});

test('a kill that cannot be confirmed remains unknown with kill_unconfirmed', { skip: !posix && skipWindows }, async () => {
  let alive = true, allowCleanupKill = false;
  const f = await fixture({
    processIdentity: () => 'matching-identity', processAlive: () => alive,
    processKill: (pid, _tree, signal) => { if (allowCleanupKill) process.kill(pid, signal); },
  });
  try {
    const started = await f.call('unconfirmed', 'bash', bashArgs('sleep 30', { detach: true }));
    const id = started.content.match(/icy-process:([0-9a-f-]+)/)![1], record = f.store.data.processes[0];
    record.status = 'unknown'; record.pidAlive = true;
    await f.store.save();
    const result = await f.store.getProcessManager().kill(id, 'user_kill');
    assert.equal(result.status, 'unknown'); assert.equal(result.pidAlive, true); assert.equal(result.reason, 'kill_unconfirmed');
    alive = false; allowCleanupKill = true;
  } finally { alive = false; allowCleanupKill = true; await f.cleanup(); }
});

test('Windows taskkill uses tree termination flags and reports non-zero exits', async () => {
  const calls: Array<{ file: string; args: string[] }> = []; let exitCode = 0;
  const processSpawn = ((file: string, args: string[]) => {
    calls.push({ file, args }); const child = fakeChild(); setImmediate(() => child.emit('close', exitCode)); return child;
  }) as unknown as typeof spawn;
  await killBashTree(77, 'win32', processSpawn, undefined, 'SIGTERM');
  await killBashTree(77, 'win32', processSpawn, undefined, 'SIGKILL');
  assert.deepEqual(calls.slice(0, 2), [
    { file: 'taskkill.exe', args: ['/pid', '77', '/T'] },
    { file: 'taskkill.exe', args: ['/pid', '77', '/T', '/F'] },
  ]);
  exitCode = 7;
  await assert.rejects(killBashTree(77, 'win32', processSpawn, undefined, 'SIGTERM'), /taskkill_failed:7/);
});

test('Windows soft taskkill failure still escalates and preserves the failure reason', async () => {
  const calls: string[][] = [], codes = [1, 0];
  const shellChild = fakeChild(7001);
  const processSpawn = ((file: string, args: string[]) => {
    if (file !== 'taskkill.exe') return shellChild;
    const child = fakeChild(); calls.push(args); setImmediate(() => {
      const code = codes.shift() ?? 0; child.emit('close', code);
      if (args.includes('/F') && code === 0) setImmediate(() => shellChild.emit('close', 0, null));
    }); return child;
  }) as unknown as typeof spawn;
  const f = await fixture({ platform: 'win32', shellPath: 'C:\\Git\\bin\\bash.exe', processSpawn, processIdentity: () => 'win-token' });
  try {
    const started = await f.store.getProcessManager().start({ toolCallId: 'win-soft', command: 'sleep 30', cwd: f.cwd, timeoutMs: 10_000 });
    const result = await f.store.getProcessManager().kill(started.id, 'user_kill');
    assert.equal(result.status, 'killed'); assert.match(result.reason ?? '', /taskkill_failed:1/);
    assert.deepEqual(calls, [['/pid', '7001', '/T'], ['/pid', '7001', '/T', '/F']]);
  } finally { await f.cleanup(); }
});

test('Windows taskkill exit 128 after escalation is treated as death', async () => {
  const calls: string[][] = [], codes = [0, 128], shellChild = fakeChild(7002);
  const processSpawn = ((file: string, args: string[]) => {
    if (file !== 'taskkill.exe') return shellChild;
    const child = fakeChild(); calls.push(args); setImmediate(() => {
      const code = codes.shift() ?? 0; child.emit('close', code);
      if (args.includes('/F')) setImmediate(() => shellChild.emit('close', 0, null));
    }); return child;
  }) as unknown as typeof spawn;
  const f = await fixture({ platform: 'win32', shellPath: 'C:\\Git\\bin\\bash.exe', processSpawn, processIdentity: () => 'win-token' });
  try {
    const started = await f.store.getProcessManager().start({ toolCallId: 'win-gone', command: 'sleep 30', cwd: f.cwd, timeoutMs: 10_000 });
    const result = await f.store.getProcessManager().kill(started.id, 'user_kill');
    assert.equal(result.status, 'killed'); assert.equal(calls.length, 2);
  } finally { await f.cleanup(); }
});

test('Windows forced taskkill failure surfaces while a live child remains running', async () => {
  const codes = [0, 1], shellChild = fakeChild(7003);
  const processSpawn = ((file: string) => {
    if (file !== 'taskkill.exe') return shellChild;
    const child = fakeChild(); setImmediate(() => child.emit('close', codes.shift() ?? 1)); return child;
  }) as unknown as typeof spawn;
  const f = await fixture({ platform: 'win32', shellPath: 'C:\\Git\\bin\\bash.exe', processSpawn, processIdentity: () => 'win-token' });
  try {
    const started = await f.store.getProcessManager().start({ toolCallId: 'win-fail', command: 'sleep 30', cwd: f.cwd, timeoutMs: 10_000 });
    await assert.rejects(f.store.getProcessManager().kill(started.id, 'user_kill'), /taskkill_failed:1/);
    assert.equal(f.store.data.processes[0].status, 'running');
    assert.match(f.store.data.processes[0].reason ?? '', /taskkill_failed:1/);
    shellChild.emit('close', 1, null);
    await f.store.getProcessManager().status(started.id, { waitMs: 1000 });
  } finally { await f.cleanup(); }
});

test('live in-session exec processes are killed by kill and closeAll', { skip: !posix && skipWindows }, async () => {
  const f = await fixture();
  try {
    const first = await f.call('exec-kill', 'bash', bashArgs('exec sleep 30', { detach: true }));
    const firstId = first.content.match(/icy-process:([0-9a-f-]+)/)![1];
    assert.equal((await f.store.getProcessManager().kill(firstId, 'user_kill')).status, 'killed');
    const second = await f.call('exec-close', 'bash', bashArgs('exec sleep 30', { detach: true }));
    assert.equal(await f.store.getProcessManager().closeAll(), 1);
    assert.equal(f.store.data.processes.find(record => record.id === second.content.match(/icy-process:([0-9a-f-]+)/)![1])?.status, 'killed');
  } finally { await f.cleanup(); }
});

test('recovered matching identity permits a different ps command line', async () => {
  let alive = true, killCalls = 0;
  const f = await fixture({ processIdentity: () => 'same-token', processAlive: () => alive, processKill: () => { killCalls++; alive = false; } });
  try {
    const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    f.store.data.processes.push({ id, toolCallId: id, command: 'exec sleep 30', cwd: f.cwd, pid: 4242, identity: 'same-token', startedAt: new Date().toISOString(), timeoutMs: 60_000, status: 'unknown', pidAlive: true, bytes: 0 });
    const result = await f.store.getProcessManager().kill(id, 'user_kill');
    assert.equal(result.status, 'killed'); assert.equal(result.pidAlive, false); assert.ok(killCalls > 0);
  } finally { await f.cleanup(); }
});

test('Agent killProcess rejects ambiguous and short prefixes but accepts a unique eight-character prefix', async () => {
  const f = await fixture();
  try {
    const make = (id: string, status: ProcessRecord['status'] = 'exited'): ProcessRecord => ({ id, toolCallId: id, command: 'true', cwd: f.cwd, startedAt: new Date().toISOString(), timeoutMs: 60_000, status, bytes: 0 });
    f.store.data.processes.push(make('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), make('aaaaaaaa-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), make('bbbbbbbb-cccc-4ccc-8ccc-cccccccccccc'));
    const agent = new Agent(f.config, { complete: async () => ({ text: '', calls: [] }) }, f.tools, f.store);
    await assert.rejects(agent.killProcess('aaaaaaaa'), { message: 'process_ambiguous' });
    await assert.rejects(agent.killProcess('aaa'), { message: 'process_not_found' });
    const result = await agent.killProcess('bbbbbbbb');
    assert.equal(result.id, 'bbbbbbbb-cccc-4ccc-8ccc-cccccccccccc'); assert.equal(result.status, 'exited');
  } finally { await f.cleanup(); }
});

test('read offsets and aborted polls return promptly, and an already-aborted start never spawns', { skip: !posix && skipWindows }, async () => {
  const f = await fixture();
  try {
    const started = await f.call('prompt-read', 'bash', bashArgs('sleep 30', { detach: true }));
    const reference = started.content.match(/icy-process:[0-9a-f-]+/)![0], id = reference.slice('icy-process:'.length);
    const offsetStarted = Date.now();
    const offsetRead = await f.call('offset-read', 'read', { path: reference, offset: 1, limit: 10, depth: null, pattern: null, regex: null });
    assert.ok(Date.now() - offsetStarted < 500); assert.equal(offsetRead.ok, true); assert.match(offsetRead.content, /Status: running/);
    const controller = new AbortController(), pollStarted = Date.now();
    const poll = f.call('poll', 'read', { path: reference, offset: null, limit: null, depth: null, pattern: null, regex: null }, controller.signal);
    setTimeout(() => controller.abort(), 200);
    const polled = await poll;
    assert.ok(Date.now() - pollStarted < 1000); assert.equal(polled.ok, true); assert.match(polled.content, /Status: running/);

    const marker = path.join(f.root, 'spawned.marker'); let spawned = false;
    const processSpawn = (() => { spawned = true; writeFileSync(marker, 'spawned'); return fakeChild(9001); }) as unknown as typeof spawn;
    const abortedStore = await SessionStore.create(f.home, f.config, [], { processSpawn });
    try {
      const aborted = new AbortController(); aborted.abort();
      await assert.rejects(abortedStore.getProcessManager().start({ toolCallId: 'aborted', command: 'true', cwd: f.cwd, timeoutMs: 1000 }, aborted.signal));
      assert.equal(spawned, false); await assert.rejects(readFile(marker), { code: 'ENOENT' });
    } finally { await abortedStore.close(); }
    assert.equal(id.length, 36);
  } finally { await f.cleanup(); }
});

test('v1 and v2 snapshots without processes remain loadable while malformed records are rejected', async () => {
  const now = new Date().toISOString(), legacy = { version: 1, id: 'fixture', cwd: process.cwd(), provider: 'responses', model: 'fixture', baseUrl: 'https://example.test/v1', messages: [], updatedAt: now };
  const migrated = parseSessionData(legacy, 'fixture'); assert.deepEqual(migrated.processes, []);
  const modern = parseSessionData({ ...legacy, version: 2, runs: [] }, 'fixture'); assert.deepEqual(modern.processes, []);
  assert.throws(() => parseSessionData({ ...modern, processes: [{ id: 'bad' }] }, 'fixture'), /processes\.0/);
});

test('the running process snapshot survives a host SIGKILL during identity capture', { skip: !posix && skipWindows }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'icy-process-crash-')), cwd = path.join(root, 'workspace'), home = path.join(root, 'home'), marker = path.join(root, 'marker.json'), script = path.join(root, 'crash.mts');
  await mkdir(cwd); await mkdir(home);
  let pid: number | undefined, resumed: SessionStore | undefined;
  try {
    const storeSource = fileURLToPath(new URL('../src/sessions/store.ts', import.meta.url));
    await writeFile(script, `import { writeFileSync } from 'node:fs';
import { SessionStore } from ${JSON.stringify(storeSource)};
const [home, cwd, marker] = process.argv.slice(2);
const store = await SessionStore.create(home, { cwd, provider: 'responses', model: 'fixture', baseUrl: 'http://127.0.0.1:1' }, [], { processIdentity: pid => {
  writeFileSync(marker, JSON.stringify({ sessionId: store.data.id, pid }));
  process.kill(process.pid, 'SIGKILL');
  return new Promise(() => {});
} });
await store.getProcessManager().start({ toolCallId: 'crash-window', command: 'sleep 60', cwd, timeoutMs: 60_000 });
`);
    await exec(process.execPath, ['--import', import.meta.resolve('tsx'), script, home, cwd, marker], { cwd: process.cwd(), timeout: 15_000 }).catch(() => {});
    const crash = JSON.parse(await readFile(marker, 'utf8')) as { sessionId: string; pid: number };
    pid = crash.pid;
    const snapshot = JSON.parse(await readFile(path.join(home, 'sessions', crash.sessionId, 'session.json'), 'utf8')) as { processes: ProcessRecord[] };
    assert.equal(snapshot.processes.length, 1); assert.equal(snapshot.processes[0].status, 'running'); assert.equal(snapshot.processes[0].pid, pid);
    const restored = await SessionStore.resume(home, crash.sessionId); resumed = restored.store;
    const record = resumed.data.processes[0];
    assert.equal(record.status, 'unknown'); assert.equal(record.pidAlive, true);
    const killed = await resumed.getProcessManager().kill(record.id, 'user_kill');
    assert.equal(killed.status, 'killed'); assert.throws(() => process.kill(pid!, 0), { code: 'ESRCH' });
  } finally {
    if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } }
    await resumed?.close(); await rm(root, { recursive: true, force: true });
  }
});

test('v2 identity capture is stable across locale and timezone changes', { skip: !posix && skipWindows }, async () => {
  const saved = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, TZ: process.env.TZ }, f = await fixture();
  let resumed: SessionStore | undefined;
  try {
    process.env.LANG = 'zh_CN.UTF-8'; process.env.LC_ALL = 'zh_CN.UTF-8'; process.env.TZ = 'Asia/Shanghai';
    const started = await f.store.getProcessManager().start({ toolCallId: 'stable-identity', command: 'sleep 30', cwd: f.cwd, timeoutMs: 60_000 });
    assert.ok(started.pid); assert.ok(started.identity);
    const capture = (f.store.getProcessManager() as unknown as { captureIdentity(pid: number): Promise<string | undefined> }).captureIdentity.bind(f.store.getProcessManager());
    const first = started.identity, second = await capture(started.pid!);
    process.env.LANG = 'C'; process.env.LC_ALL = 'C'; process.env.TZ = 'UTC';
    const third = await capture(started.pid!);
    assert.equal(first, second); assert.equal(second, third);
    await f.store.save(); await unlink(path.join(f.store.dir, 'lock'));
    resumed = (await SessionStore.resume(f.home, f.store.data.id)).store;
    assert.equal(resumed.data.processes[0].status, 'unknown'); assert.equal(resumed.data.processes[0].pidAlive, true); assert.equal(resumed.data.processes[0].reason, 'icy_restarted');
    assert.equal((await resumed.getProcessManager().kill(started.id, 'user_kill')).status, 'killed');
  } finally {
    if (saved.LANG === undefined) delete process.env.LANG; else process.env.LANG = saved.LANG;
    if (saved.LC_ALL === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = saved.LC_ALL;
    if (saved.TZ === undefined) delete process.env.TZ; else process.env.TZ = saved.TZ;
    await resumed?.close(); await f.cleanup();
  }
});

test('legacy inherited identity records still permit a matching recovered kill', async () => {
  let alive = true, killCalls = 0, captures = 0;
  const f = await fixture({ processExecFile: () => ({ stdout: ++captures === 1 ? 'v2-token' : 'legacy-token' }), processAlive: () => alive, processKill: () => { killCalls++; alive = false; } });
  try {
    const id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    f.store.data.processes.push({ id, toolCallId: id, command: 'sleep 30', cwd: f.cwd, pid: 4242, identity: 'legacy-token', startedAt: new Date().toISOString(), timeoutMs: 60_000, status: 'unknown', pidAlive: true, bytes: 0 });
    const result = await f.store.getProcessManager().kill(id, 'user_kill');
    assert.equal(result.status, 'killed'); assert.equal(killCalls, 2); assert.equal(captures, 2);
  } finally { alive = false; await f.cleanup(); }
});

test('a missing identity an hour from the recorded start stays unconfirmed and is never killed', async () => {
  let killCalls = 0, alive = true;
  const answer = identityToken(new Date());
  const f = await fixture({ processIdentity: () => answer, processAlive: () => alive, processKill: () => { killCalls++; alive = false; } });
  try {
    const id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    f.store.data.processes.push({ id, toolCallId: id, command: 'sleep 30', cwd: f.cwd, pid: 4242, startedAt: new Date(Date.now() - 3_600_000).toISOString(), timeoutMs: 60_000, status: 'running', bytes: 0 });
    await f.store.getProcessManager().recover();
    const record = f.store.data.processes[0];
    assert.equal(record.status, 'unknown'); assert.equal(record.pidAlive, true); assert.equal(record.reason, 'identity_unconfirmed');
    const result = await f.store.getProcessManager().kill(id, 'user_kill');
    assert.equal(result.status, 'unknown'); assert.equal(result.reason, 'identity_unconfirmed'); assert.equal(killCalls, 0);
  } finally { alive = false; await f.cleanup(); }
});

test('Windows identity runner uses UTC ISO and matches or rejects start-time fallback', async () => {
  const calls: Array<{ file: string; args: string[]; options: unknown }> = [], now = new Date(), f = await fixture({ platform: 'win32', processAlive: () => true, processExecFile: (file, args, options) => {
    calls.push({ file, args, options }); return { stdout: now.toISOString() };
  } });
  try {
    const within = { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', toolCallId: 'win-within', command: 'sleep 30', cwd: f.cwd, pid: 4242, startedAt: now.toISOString(), timeoutMs: 60_000, status: 'running' as const, bytes: 0 };
    const off = { id: '11111111-1111-4111-8111-111111111111', toolCallId: 'win-off', command: 'sleep 30', cwd: f.cwd, pid: 4243, startedAt: new Date(now.getTime() - 3_600_000).toISOString(), timeoutMs: 60_000, status: 'running' as const, bytes: 0 };
    f.store.data.processes.push(within, off); await f.store.getProcessManager().recover();
    assert.equal(f.store.data.processes[0].reason, 'icy_restarted'); assert.equal(f.store.data.processes[1].reason, 'identity_unconfirmed');
    assert.ok(calls.length >= 2); assert.equal(calls[0].file, 'powershell.exe'); assert.match(calls[0].args[2], /ToUniversalTime\(\)\.ToString\('o'\)/);
  } finally { for (const record of f.store.data.processes) record.status = 'exited'; await f.cleanup(); }
});

test('the running snapshot precedes delayed identity capture and emits only one start event', { skip: !posix && skipWindows }, async () => {
  const events: ProcessRecord[] = [], f = await fixture({ processIdentity: async () => { await new Promise(resolve => setTimeout(resolve, 300)); return 'delayed-token'; } });
  let bumps = 0;
  try {
    const manager = f.store.getProcessManager(record => { events.push(structuredClone(record)); }, () => { bumps++; });
    const starting = manager.start({ toolCallId: 'persist-order', command: 'sleep 30', cwd: f.cwd, timeoutMs: 60_000 });
    const deadline = Date.now() + 2000; let snapshot: { processes: ProcessRecord[] } | undefined;
    while (Date.now() < deadline) {
      try { snapshot = JSON.parse(await readFile(path.join(f.store.dir, 'session.json'), 'utf8')) as { processes: ProcessRecord[] }; if (snapshot.processes[0]?.status === 'running') break; }
      catch { /* the initial snapshot is still being replaced */ }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(snapshot?.processes[0]?.status, 'running'); assert.ok(snapshot?.processes[0]?.pid);
    assert.equal(events.length, 1); assert.equal(events[0].status, 'running');
    const record = await starting;
    assert.equal(record.identity, 'delayed-token'); assert.equal(record.identityScheme, 'v2'); assert.equal(events.length, 1); assert.equal(bumps, 1);
  } finally { await f.cleanup(); }
});

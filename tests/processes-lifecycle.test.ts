import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, open as openFile, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import type { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { SessionStore } from '../src/sessions/store.js';
import { killBashTree, runBash } from '../src/tools/bash.js';
import { parseSessionData } from '../src/sessions/schema.js';
import { Agent } from '../src/core/agent.js';
import type { AgentEvent, ProcessRecord, Provider } from '../src/core/types.js';
import { canVerifyTask, markMutation, recordVerification, registerVerification, startRun, type SessionExecutionState } from '../src/core/run-state.js';
import { promisify } from 'node:util';
import { bashArgs, fakeChild, fixture, identityToken, nodeCommand, outputChild, pollFor, posix, skipWindows, testProcessTiming, waitFor } from './helpers/processes.js';

const exec = promisify(execFile);

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

test('approval grants distinguish foreground and detached variants', { skip: !posix && skipWindows }, async () => {
  const f = await fixture();
  try {
    await f.call('foreground', 'bash', bashArgs('true'));
    await f.call('detached', 'bash', bashArgs('sleep 30', { detach: true }));
    assert.equal(f.approvals.length, 2); assert.equal((f.approvals[0] as { detach: boolean }).detach, false); assert.equal((f.approvals[1] as { detach: boolean }).detach, true);
  } finally { await f.cleanup(); }
});

test('first detached snapshot failure stops the live child and reports a saved-session error', { skip: !posix && skipWindows }, async () => {
  let fail = false;
  const injectedWriteFile = ((...args: Parameters<typeof writeFile>) => {
    if (fail) { fail = false; return Promise.reject(new Error('injected_first_snapshot')); }
    return writeFile(...args);
  }) as typeof writeFile;
  const f = await fixture({ fsWriteFile: injectedWriteFile });
  try {
    fail = true;
    await assert.rejects(f.store.getProcessManager().start({ toolCallId: 'persist-first', command: 'sleep 30', cwd: f.cwd, timeoutMs: 10_000 }), /session could not be saved.*process was stopped/);
    const record = f.store.data.processes[0];
    assert.equal(record.status, 'killed'); assert.match(record.reason ?? '', /^persist_failed:injected_first_snapshot/); assert.equal(record.pidAlive, false);
    assert.ok(record.pid); assert.throws(() => process.kill(record.pid!, 0), { code: 'ESRCH' });
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
      return calls === 1 ? { text: '', calls: [{ id: 'detached', name: 'bash', arguments: JSON.stringify(bashArgs(nodeCommand('setTimeout(() => {}, 40);'), { detach: true })) }] } : { text: 'done', calls: [] };
    } };
    const events: AgentEvent[] = [], agent = new Agent(f.config, provider, f.tools, f.store, event => events.push(event));
    assert.equal((await agent.run('start a server', new AbortController().signal)).ok, true);
    await waitFor(() => events.filter((event): event is Extract<AgentEvent, { type: 'process' }> => event.type === 'process').length === 2);
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
  } finally { await resumed?.close(); await f.store.close(); await rm(f.root, { recursive: true, force: true }); }
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
  } finally {
    alive = false; allowCleanupKill = true;
    const pid = f.store.data.processes[0]?.pid;
    if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } }
    await f.cleanup();
  }
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
    setTimeout(() => controller.abort(), 30);
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

test('the running snapshot precedes delayed identity capture and emits only one start event', { skip: !posix && skipWindows }, async () => {
  const events: ProcessRecord[] = [], f = await fixture({ processIdentity: async () => { await new Promise(resolve => setTimeout(resolve, 30)); return 'delayed-token'; } });
  let bumps = 0;
  try {
    const manager = f.store.getProcessManager(record => { events.push(structuredClone(record)); }, () => { bumps++; });
    const starting = manager.start({ toolCallId: 'persist-order', command: 'sleep 30', cwd: f.cwd, timeoutMs: 60_000 });
    let snapshot: { processes: ProcessRecord[] } | undefined;
    await waitFor(async () => {
      try { snapshot = JSON.parse(await readFile(path.join(f.store.dir, 'session.json'), 'utf8')) as { processes: ProcessRecord[] }; return snapshot.processes[0]?.status === 'running'; }
      catch { return false; }
    });
    assert.equal(snapshot?.processes[0]?.status, 'running'); assert.ok(snapshot?.processes[0]?.pid);
    assert.equal(events.length, 1); assert.equal(events[0].status, 'running');
    const record = await starting;
    assert.equal(record.identity, 'delayed-token'); assert.equal(record.identityScheme, 'v2'); assert.equal(events.length, 1); assert.equal(bumps, 1);
  } finally { await f.cleanup(); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, open as openFile, readFile, rm, unlink, writeFile } from 'node:fs/promises';
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

test('recovered timeout watchdogs terminate expired work and closeAll cancels future retries', { skip: !posix && skipWindows }, async () => {
  const killedPids = new Set<number>(), timeoutResources = () => process.getActiveResourcesInfo().filter(resource => resource === 'Timeout').length;
  const baseline = timeoutResources();
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
    watched.startedAt = new Date().toISOString(); watched.timeoutMs = 2_000;
    await f.store.save(); await unlink(path.join(f.store.dir, 'lock'));
    resumed = (await SessionStore.resume(f.home, f.store.data.id, [], {
      processIdentity: () => 'matching-identity', processAlive: pid => !killedPids.has(pid),
      processKill: (pid, _tree, signal) => { killedPids.add(Math.abs(pid)); process.kill(pid, signal ?? 'SIGTERM'); }, processTiming: testProcessTiming,
    })).store;
    assert.equal(resumed.data.processes[0].status, 'timeout'); assert.equal(resumed.data.processes[0].reason, 'timeout');
    const manager = resumed.getProcessManager();
    await manager.closeAll();
    const result = await manager.status(watched.id);
    assert.equal(result.status, 'killed'); assert.equal(result.reason, 'session_closed');
    for (const pid of pids) if (pid) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    const killedBeforeQuietPeriod = killedPids.size;
    assert.equal(await pollFor(() => killedPids.size > killedBeforeQuietPeriod, testProcessTiming.watchdogRetryMs * 3), false, 'closeAll must prevent future watchdog kills');
    assert.ok(timeoutResources() <= baseline, 'closeAll must not leave Timeout handles behind');
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
    resumed = (await SessionStore.resume(f.home, f.store.data.id, [], { processSpawn, processIdentity: identity, processAlive: () => alive, processKill: () => { alive = false; }, processTiming: testProcessTiming })).store;
    assert.equal(resumed.data.processes[0].status, 'unknown'); assert.equal(resumed.data.processes[0].pidAlive, true);
    assert.equal(resumed.data.processes[0].reason, 'identity_unconfirmed');
    await waitFor(() => resumed!.data.processes[0].status === 'timeout', 1000);
    assert.ok(captures >= 4);
  } finally {
    f.store.data.processes[0].status = 'exited'; alive = false; child.emit('close', 0, null);
    await resumed?.close(); await f.cleanup();
  }
});

test('identity capture timeout does not postpone the detached process timeout', { skip: !posix && skipWindows }, async () => {
  const f = await fixture({ processIdentity: () => new Promise<string | undefined>(() => {}), processTiming: { identityTimeoutMs: 150 } });
  try {
    const startedAt = Date.now();
    const record = await f.store.getProcessManager().start({ toolCallId: 'identity-timeout', command: 'sleep 30', cwd: f.cwd, timeoutMs: 30 });
    assert.ok(Date.now() - startedAt < 500); assert.notEqual(record.status, 'running');
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


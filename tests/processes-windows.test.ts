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

test('Windows records without identity fail closed instead of using start-time fallback', async () => {
  const calls: Array<{ file: string; args: string[]; options: unknown }> = [], now = new Date(), f = await fixture({ platform: 'win32', processAlive: () => true, processExecFile: (file, args, options) => {
    calls.push({ file, args, options }); return { stdout: now.toISOString() };
  } });
  try {
    const within = { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', toolCallId: 'win-within', command: 'sleep 30', cwd: f.cwd, pid: 4242, startedAt: now.toISOString(), timeoutMs: 60_000, status: 'running' as const, bytes: 0 };
    const off = { id: '11111111-1111-4111-8111-111111111111', toolCallId: 'win-off', command: 'sleep 30', cwd: f.cwd, pid: 4243, startedAt: new Date(now.getTime() - 3_600_000).toISOString(), timeoutMs: 60_000, status: 'running' as const, bytes: 0 };
    f.store.data.processes.push(within, off); await f.store.getProcessManager().recover();
    assert.equal(f.store.data.processes[0].reason, 'identity_unconfirmed'); assert.equal(f.store.data.processes[1].reason, 'identity_unconfirmed');
    assert.equal(calls.length, 0);
  } finally { for (const record of f.store.data.processes) record.status = 'exited'; await f.cleanup(); }
});


import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { resolveBashShell, runBash } from '../src/tools/bash.js';

type FakeChild = EventEmitter & {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
};

type SpawnCall = { file: string; args: string[]; options: Record<string, unknown> };

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4242;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

function fakeSpawn(child: FakeChild, calls: SpawnCall[]) {
  return ((file: string, args: string[], options: Record<string, unknown>) => {
    calls.push({ file, args, options });
    return child;
  }) as unknown as typeof spawn;
}

test('Windows bash resolution prefers ICY_BASH, skips WSL bash, and finds Git for Windows', () => {
  const existing = new Set<string>();
  const exists = (candidate: string) => existing.has(candidate);
  const env = {
    ICY_BASH: 'C:\\icy\\bash.exe',
    PATH: 'C:\\Windows\\System32',
    ProgramFiles: 'C:\\Program Files',
  };

  existing.add(env.ICY_BASH);
  assert.equal(resolveBashShell('win32', env, exists), env.ICY_BASH);

  existing.delete(env.ICY_BASH);
  existing.add('C:\\Windows\\System32\\bash.exe');
  existing.add('C:\\Program Files\\Git\\bin\\bash.exe');
  assert.equal(resolveBashShell('win32', env, exists), 'C:\\Program Files\\Git\\bin\\bash.exe');

  existing.clear();
  assert.equal(resolveBashShell('win32', env, exists), undefined);
});

test('Windows runBash uses a native shell spawn and tree termination', async () => {
  const child = fakeChild();
  const calls: SpawnCall[] = [];
  const killed: Array<[number, boolean]> = [];
  const controller = new AbortController();
  const resultPromise = runBash('echo windows', 'C:\\workspace', 10_000, controller.signal, {
    platform: 'win32',
    shellPath: 'C:\\Git\\bin\\bash.exe',
    env: { PATH: 'C:\\Git\\bin' },
    spawn: fakeSpawn(child, calls),
    kill: (pid, tree) => { killed.push([pid, tree]); child.emit('close', null); },
  });
  controller.abort();
  const result = await resultPromise;

  assert.equal(result.error, 'cancelled');
  assert.deepEqual(killed[0], [4242, true]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, 'C:\\Git\\bin\\bash.exe');
  assert.deepEqual(calls[0].args, ['--noprofile', '--norc', '-c', 'echo windows']);
  assert.equal(calls[0].options.cwd, 'C:\\workspace');
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.detached, false);
});

test('Windows runBash reports unavailable without spawning', async () => {
  let spawned = false;
  const result = await runBash('echo windows', 'C:\\workspace', 1000, new AbortController().signal, {
    platform: 'win32',
    shellPath: undefined,
    env: {},
    spawn: (() => { spawned = true; throw new Error('must not spawn'); }) as unknown as typeof spawn,
  });

  assert.equal(spawned, false);
  assert.deepEqual(result, {
    ok: false,
    error: 'bash_unavailable',
    content: 'bash 不可用：请安装 Git for Windows，或用 ICY_BASH 指定 bash.exe 路径。',
  });
});

test('POSIX runBash keeps negative process-group termination semantics', async () => {
  const child = fakeChild();
  const calls: SpawnCall[] = [];
  const killed: Array<[number, boolean]> = [];
  const controller = new AbortController();
  const resultPromise = runBash('echo posix', '/workspace', 10_000, controller.signal, {
    platform: 'darwin',
    shellPath: '/bin/bash',
    env: {},
    spawn: fakeSpawn(child, calls),
    kill: (pid, tree) => { killed.push([pid, tree]); child.emit('close', null); },
  });
  controller.abort();
  await resultPromise;

  assert.equal(killed[0][0], -4242);
  assert.equal(killed[0][1], false);
  assert.equal(calls[0].options.detached, true);
});

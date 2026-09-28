import test from 'node:test';
import assert from 'node:assert/strict';
import { link, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BigIntStats } from 'node:fs';
import { loadConfig } from '../src/config/load.js';
import { unchanged } from '../src/core/workspace-fingerprint.js';
import { SessionStore } from '../src/sessions/store.js';
import { ToolExecutor } from '../src/tools/executor.js';
import type { ToolInput } from '../src/tools/definitions.js';
import { canonicalPath, workspacePath } from '../src/tools/paths.js';
import { makeSymlink } from './helpers/fs.js';

const writeCall = (file: string, content: string): ToolInput => ({
  name: 'write', args: { path: file, content, expectedHash: null },
});
const errorWithCode = (code: string) => Object.assign(new Error(code), { code });

 test('canonicalPath normalizes Windows separators and drive letters only on win32', () => {
  assert.equal(canonicalPath('c:/Users/x', 'win32'), 'C:\\Users\\x');
  assert.equal(canonicalPath('C:\\Users\\x', 'win32'), 'C:\\Users\\x');
  const posix = 'c:/Users/x';
  assert.equal(canonicalPath(posix, 'darwin'), posix);
});

test('workspacePath rejects symlinks and Windows junctions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'icy-link-'));
  try {
    const cwd = path.join(root, 'workspace');
    await mkdir(cwd);
    await mkdir(path.join(root, 'outside'));
    await makeSymlink(path.join(root, 'outside'), path.join(cwd, 'link'), 'dir');
    await assert.rejects(workspacePath(cwd, 'link'), { message: 'symlink_not_allowed' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('new-file writes fall back from link and refuse a target that appears during the fallback', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'icy-write-'));
  const cwd = path.join(root, 'workspace'), home = path.join(root, 'home');
  await mkdir(cwd);
  const store = await SessionStore.create(home, { cwd, provider: 'responses', model: 'fixture', baseUrl: 'https://example.test' });
  try {
    const linkFailure = async () => { throw errorWithCode('EPERM'); };
    const fallback = new ToolExecutor({ cwd }, store, { platform: 'darwin', link: linkFailure });
    const created = await fallback.execute(writeCall('created.txt', 'created'), new AbortController().signal);
    assert.equal(created.ok, true);
    assert.equal(await readFile(path.join(cwd, 'created.txt'), 'utf8'), 'created');

    const appears = async (_temp: Parameters<typeof link>[0], target: Parameters<typeof link>[1]) => {
      await writeFile(target, 'another writer');
      throw errorWithCode('EPERM');
    };
    const refused = new ToolExecutor({ cwd }, store, { platform: 'darwin', link: appears });
    await assert.rejects(refused.execute(writeCall('appeared.txt', 'must not replace'), new AbortController().signal), { message: 'file_changed' });
    assert.equal(await readFile(path.join(cwd, 'appeared.txt'), 'utf8'), 'another writer');
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('session lock liveness treats EPERM as live and ESRCH as stale', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'icy-lock-'));
  let store: SessionStore | undefined;
  try {
    const data = { cwd: root, provider: 'responses' as const, model: 'fixture', baseUrl: 'https://example.test' };
    store = await SessionStore.create(root, data);
    const id = store.data.id;
    await store.close();
    const lock = path.join(root, 'sessions', id, 'lock');
    await writeFile(lock, '12345');
    const permissionDenied = (() => { throw errorWithCode('EPERM'); }) as typeof process.kill;
    await assert.rejects(SessionStore.resume(root, id, [], { kill: permissionDenied }), /其他 icy 进程/);
    assert.equal(await readFile(lock, 'utf8'), '12345');

    const noSuchProcess = (() => { throw errorWithCode('ESRCH'); }) as typeof process.kill;
    const resumed = await SessionStore.resume(root, id, [], { kill: noSuchProcess });
    store = resumed.store;
    assert.equal(resumed.recovered, 0);
  } finally {
    await store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('fingerprint stat mode comparison is skipped for win32', () => {
  const before = {
    dev: 1n, ino: 2n, mode: 0o100600n, nlink: 1n, size: 3n, mtimeNs: 4n, ctimeNs: 5n,
  } as unknown as BigIntStats;
  const after = { ...before, mode: 0o100700n } as unknown as BigIntStats;
  assert.equal(unchanged(before, after, 'win32'), true);
  assert.equal(unchanged(before, after, 'darwin'), false);
});

test('ICY_HOME paths containing spaces are resolved by loadConfig', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'icy config space-'));
  const previous = process.env.ICY_HOME;
  const home = path.join(root, 'home with spaces');
  try {
    await mkdir(home);
    process.env.ICY_HOME = home;
    const config = await loadConfig(root);
    assert.equal(config.home, path.resolve(home));
    assert.equal(config.cwd, path.resolve(root));
  } finally {
    if (previous === undefined) delete process.env.ICY_HOME;
    else process.env.ICY_HOME = previous;
    await rm(root, { recursive: true, force: true });
  }
});

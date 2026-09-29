import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../src/core/agent.js';
import type { Config } from '../src/config/load.js';
import type { Provider } from '../src/core/types.js';
import { SessionStore, type SessionStoreOptions } from '../src/sessions/store.js';
import { ToolRegistry } from '../src/tools/registry.js';

const posix = process.platform !== 'win32';
const skipWindows = 'POSIX process test is skipped on Windows';
const nodeCommand = (script: string) => `${process.execPath} -e '${script.replaceAll("'", `\'"\'"'`)}'`;
const user = (content: string) => ({ role: 'user' as const, content });

async function fixture(options: SessionStoreOptions = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'icy-session-writer-'));
  const cwd = path.join(root, 'workspace'), home = path.join(root, 'home');
  const config: Config = { home, cwd, provider: 'responses', baseUrl: 'http://127.0.0.1:1', model: 'fixture', apiKey: '', apiKeyEnv: 'ICY_TEST_KEY', permissions: 'workspace-edit', promptCompaction: 'off', compactionMinChars: 200, maxModelTurns: 20, maxToolCalls: 50, maxTokens: 100_000, maxContextChars: 120_000, requestTimeoutMs: 1000 };
  await mkdir(cwd, { recursive: true });
  const store = await SessionStore.create(home, config, [], options);
  return { root, cwd, home, config, store, cleanup: async () => { try { await store.close(); } finally { await rm(root, { recursive: true, force: true }); } } };
}

const disk = async (store: SessionStore) => JSON.parse(await readFile(path.join(store.dir, 'session.json'), 'utf8')) as SessionStore['data'];

function task() {
  return { id: 'writer-task', goal: '测试写入', status: 'answered' as const, remaining: [], completed: [], mutationRevision: 0, verificationChecks: [], verificationRecords: [] };
}

test('serialized writer keeps the later mutation for 300 equal-size concurrent pairs', async () => {
  const f = await fixture();
  try {
    const filler = 'x'.repeat(1200);
    for (let i = 0; i < 300; i++) {
      f.store.data.messages = [user(`${filler} v${2 * i}`)];
      const first = f.store.save();
      f.store.data.messages = [user(`${filler} v${2 * i + 1}`)];
      const second = f.store.save();
      await Promise.all([first, second]);
      assert.equal((await disk(f.store)).messages[0].content, `${filler} v${2 * i + 1}`);
    }
  } finally { await f.cleanup(); }
});

test('serialized writer always preserves the shrink after a large snapshot', async () => {
  const f = await fixture();
  try {
    const large = Array.from({ length: 400 }, (_, i) => user(`${i}: ${'large '.repeat(20)}`));
    for (let i = 0; i < 20; i++) {
      f.store.data.messages = large;
      const first = f.store.save();
      f.store.data.messages = [];
      const second = f.store.save();
      await Promise.all([first, second]);
      assert.equal((await disk(f.store)).messages.length, 0);
    }
  } finally { await f.cleanup(); }
});

test('serialized writer coalesces saves made during a delayed first write', async () => {
  let enabled = false, delayNext = false, renames = 0, resolveFirst!: () => void;
  const firstStarted = new Promise<void>(resolve => { resolveFirst = resolve; });
  const f = await fixture({
    fsWriteFile: async (file, data, options) => {
      if (enabled && delayNext) { delayNext = false; resolveFirst(); await new Promise(resolve => setTimeout(resolve, 150)); }
      return writeFile(file, data, options);
    },
    fsRename: async (...args) => { if (enabled) renames++; return rename(...args); },
  });
  try {
    enabled = true; delayNext = true;
    f.store.data.messages = [user('A')];
    const a = f.store.save();
    await firstStarted;
    f.store.data.messages = [user('B')]; const b = f.store.save();
    f.store.data.messages = [user('C')]; const c = f.store.save();
    await Promise.all([a, b, c]);
    assert.equal(renames, 2);
    assert.equal((await disk(f.store)).messages[0].content, 'C');
  } finally { await f.cleanup(); }
});

test('serialized writer isolates one write failure and removes its temp file', async () => {
  let enabled = false, failNext = false;
  const f = await fixture({
    fsWriteFile: async (file, data, options) => {
      if (enabled && failNext) { failNext = false; throw new Error('injected_writer_failure'); }
      return writeFile(file, data, options);
    },
  });
  try {
    enabled = true; failNext = true;
    f.store.data.messages = [user('failed')];
    await assert.rejects(f.store.save(), /injected_writer_failure/);
    assert.deepEqual((await readdir(f.store.dir)).filter(name => name.endsWith('.tmp')), []);
    f.store.data.messages = [user('latest')];
    await f.store.save();
    assert.equal((await disk(f.store)).messages[0].content, 'latest');
  } finally { await f.cleanup(); }
});

test('close drains a delayed snapshot before releasing the session lock', async () => {
  let enabled = false, delayNext = false, writeFinished = false, resolveFirst!: () => void, releaseFirst!: () => void;
  const firstStarted = new Promise<void>(resolve => { resolveFirst = resolve; });
  const firstRelease = new Promise<void>(resolve => { releaseFirst = resolve; });
  const f = await fixture({
    fsWriteFile: async (file, data, options) => {
      if (enabled && delayNext) {
        delayNext = false; resolveFirst(); await firstRelease;
      }
      const result = await writeFile(file, data, options); writeFinished = true; return result;
    },
  });
  writeFinished = false;
  try {
    enabled = true; delayNext = true;
    f.store.data.messages = [user('old')]; const first = f.store.save();
    await firstStarted;
    f.store.data.messages = [user('latest')]; const second = f.store.save();
    const closing = f.store.close();
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(writeFinished, false);
    assert.equal(await readFile(path.join(f.store.dir, 'lock'), 'utf8'), String(process.pid));
    releaseFirst();
    await Promise.all([first, second, closing]);
    assert.equal(writeFinished, true);
    assert.equal((await disk(f.store)).messages[0].content, 'latest');
    await assert.rejects(readFile(path.join(f.store.dir, 'lock')), { code: 'ENOENT' });
  } finally { releaseFirst(); await f.cleanup(); }
});

test('process and agent saves retain the last mutation, terminal status, and exit bump', { skip: !posix && skipWindows }, async () => {
  const f = await fixture();
  try {
    f.store.data.task = task();
    const tools = new ToolRegistry(f.config, f.store, async () => 'once');
    const provider: Provider = { async complete() { return { text: '', calls: [] }; } };
    let resolveTerminal!: () => void;
    const terminalEvent = new Promise<void>(resolve => { resolveTerminal = resolve; });
    new Agent(f.config, provider, tools, f.store, event => {
      if (event.type === 'process' && event.record.status !== 'running') resolveTerminal();
    });
    const manager = f.store.getProcessManager();
    const record = await manager.start({ toolCallId: 'writer-process', command: nodeCommand('setTimeout(() => {}, 50);'), cwd: f.cwd, timeoutMs: 1000 });
    let count = 0;
    while (record.status === 'running') {
      f.store.data.messages = [user(`tight-${++count}`)];
      await f.store.save();
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    await terminalEvent;
    f.store.data.messages = [user(`last-test-mutation-${++count}`)];
    await f.store.save();
    const snapshot = await disk(f.store), persisted = snapshot.processes.find(process => process.id === record.id);
    assert.equal(snapshot.messages[0].content, `last-test-mutation-${count}`);
    assert.equal(persisted?.status, 'exited');
    assert.equal(snapshot.task?.mutationRevision, 2);
  } finally { await f.cleanup(); }
});

test('terminal status and its exit mutation bump are serialized by the same write', { skip: !posix && skipWindows }, async () => {
  const written: Array<SessionStore['data']> = [];
  let enabled = false;
  const f = await fixture({
    fsWriteFile: async (file, data, options) => {
      if (enabled) written.push(JSON.parse(String(data)) as SessionStore['data']);
      return writeFile(file, data, options);
    },
  });
  try {
    f.store.data.task = task();
    enabled = true;
    const tools = new ToolRegistry(f.config, f.store, async () => 'once');
    const provider: Provider = { async complete() { return { text: '', calls: [] }; } };
    let resolveTerminal!: () => void;
    const terminalEvent = new Promise<void>(resolve => { resolveTerminal = resolve; });
    new Agent(f.config, provider, tools, f.store, event => {
      if (event.type === 'process' && event.record.status !== 'running') resolveTerminal();
    });
    const manager = f.store.getProcessManager();
    await manager.start({ toolCallId: 'terminal-write', command: nodeCommand('setTimeout(() => {}, 50);'), cwd: f.cwd, timeoutMs: 1000 });
    await terminalEvent;
    const revision = f.store.data.task!.mutationRevision;
    const terminalSnapshots = written.filter(snapshot => snapshot.processes.some(process => process.status !== 'running'));
    assert.ok(terminalSnapshots.length > 0);
    assert.ok(terminalSnapshots.every(snapshot => snapshot.task?.mutationRevision === revision));
    assert.equal(revision, 2);
  } finally { await f.cleanup(); }
});

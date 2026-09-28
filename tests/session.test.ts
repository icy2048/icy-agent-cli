import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionStore, type LegacySessionData } from '../src/sessions/store.js';
import type { Message, ToolCall } from '../src/core/types.js';

const call = (id: string): ToolCall => ({ id, name: 'bash', arguments: '{"command":"touch should-not-exist"}' });
const assistant = (...ids: string[]): Message => ({ role: 'assistant', content: '', calls: ids.map(call) });
const result = (id: string): Message => ({ role: 'tool', id, content: '{"ok":true,"content":"done"}' });
const snapshot = (cwd: string, id = 'fixture'): LegacySessionData => ({
  version: 1, id, cwd, provider: 'responses', model: 'fixture', baseUrl: 'https://example.test/v1',
  messages: [], updatedAt: new Date().toISOString(),
});
async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), 'icy-session-'));
  const data = snapshot(home), dir = path.join(home, 'sessions', data.id), file = path.join(dir, 'session.json');
  await mkdir(dir, { recursive: true });
  return { home, data, dir, file, cleanup: () => rm(home, { recursive: true, force: true }) };
}
const absent = (file: string) => assert.rejects(readFile(file), { code: 'ENOENT' });

test('resume validates every persisted message shape before acquiring a lock and preserves bad snapshots', async t => {
  const f = await fixture();
  try {
    const malformed: { name: string; data: unknown; error: RegExp }[] = [
      { name: 'missing calls', data: { ...f.data, messages: [{ role: 'assistant', content: 'x' }] }, error: /messages\.0\.calls/ },
      { name: 'unknown message role', data: { ...f.data, messages: [{ role: 'system', content: 'x' }] }, error: /messages\.0\.role/ },
      { name: 'non-string content', data: { ...f.data, messages: [{ role: 'user', content: 1 }] }, error: /messages\.0\.content/ },
      { name: 'invalid tool arguments type', data: { ...f.data, messages: [{ role: 'assistant', content: '', calls: [{ ...call('a'), arguments: {} }] }] }, error: /messages\.0\.calls\.0\.arguments/ },
      { name: 'empty call ID', data: { ...f.data, messages: [assistant('')] }, error: /messages\.0\.calls\.0\.id/ },
      { name: 'invalid opaque type', data: { ...f.data, messages: [{ ...assistant(), opaque: {} }] }, error: /messages\.0\.opaque/ },
      { name: 'invalid reasoning type', data: { ...f.data, messages: [{ ...assistant(), reasoning: [] }] }, error: /messages\.0\.reasoning/ },
      { name: 'invalid prepared content', data: { ...f.data, messages: [{ role: 'user', content: 'x', preparedContent: 1 }] }, error: /messages\.0\.preparedContent/ },
      { name: 'invalid prepared request', data: { ...f.data, messages: [{ role: 'user', content: 'x', preparedRequest: { schema: 'icy.user-request.v2', task: 'x', keywords: [1], constraints: [] } }] }, error: /messages\.0\.preparedRequest\.keywords\.0/ },
      { name: 'unsupported version', data: { ...f.data, version: 99 }, error: /version/ },
      { name: 'mismatched ID', data: { ...f.data, id: 'different' }, error: /id/ },
      { name: 'relative workspace', data: { ...f.data, cwd: 'relative' }, error: /cwd/ },
      { name: 'invalid provider', data: { ...f.data, provider: 42 }, error: /provider/ },
      { name: 'missing model', data: { ...f.data, model: undefined }, error: /model/ },
      { name: 'invalid URL', data: { ...f.data, baseUrl: 'not a URL' }, error: /baseUrl/ },
      { name: 'invalid timestamp', data: { ...f.data, updatedAt: 'yesterday' }, error: /updatedAt/ },
      { name: 'non-object session', data: null, error: /session/ },
    ];
    for (const item of malformed) await t.test(item.name, async () => {
      const original = JSON.stringify(item.data);
      await writeFile(f.file, original);
      for (let retry = 0; retry < 2; retry++) {
        await assert.rejects(SessionStore.resume(f.home, f.data.id), item.error);
        await absent(path.join(f.dir, 'lock'));
        assert.equal(await readFile(f.file, 'utf8'), original);
      }
    });
    await t.test('invalid JSON', async () => {
      const original = '{"version":1'; await writeFile(f.file, original);
      await assert.rejects(SessionStore.resume(f.home, f.data.id), /session\.json: invalid JSON/);
      await absent(path.join(f.dir, 'lock'));
      assert.equal(await readFile(f.file, 'utf8'), original);
    });
  } finally { await f.cleanup(); }
});

test('resume rejects duplicate call IDs, orphan or duplicate results, and invalid unfinished chains', async t => {
  const f = await fixture();
  try {
    const malformed: { name: string; messages: Message[]; running?: string; error: RegExp }[] = [
      { name: 'duplicate calls in a batch', messages: [assistant('a', 'a')], error: /duplicate tool call ID/ },
      { name: 'duplicate calls across batches', messages: [assistant('a'), result('a'), assistant('a')], error: /duplicate tool call ID/ },
      { name: 'result without a call', messages: [result('a')], error: /orphan tool result/ },
      { name: 'result before a call', messages: [result('a'), assistant('a')], error: /orphan tool result/ },
      { name: 'duplicate result', messages: [assistant('a'), result('a'), result('a')], error: /duplicate tool result/ },
      { name: 'user after pending call', messages: [assistant('a'), { role: 'user', content: 'next' }], error: /unfinished tool calls/ },
      { name: 'assistant after pending call', messages: [assistant('a'), assistant('b')], error: /unfinished tool calls/ },
      { name: 'unknown running call', messages: [assistant('a')], running: 'b', error: /running/ },
      { name: 'completed running call', messages: [assistant('a'), result('a')], running: 'a', error: /running/ },
    ];
    for (const item of malformed) await t.test(item.name, async () => {
      const original = JSON.stringify({ ...f.data, messages: item.messages, ...(item.running ? { running: item.running } : {}) });
      await writeFile(f.file, original);
      await assert.rejects(SessionStore.resume(f.home, f.data.id), item.error);
      await absent(path.join(f.dir, 'lock'));
      assert.equal(await readFile(f.file, 'utf8'), original);
    });
  } finally { await f.cleanup(); }
});

test('resume preserves v1 metadata and provider data while closing only unfinished calls without replay', async () => {
  const f = await fixture(); let store: SessionStore | undefined;
  try {
    const original = {
      ...f.data, legacyMetadata: { retained: true },
      messages: [
        { role: 'user', content: 'original', preparedContent: 'legacy prepared text', preparedRequest: { schema: 'icy.user-request.v2', task: 'task', keywords: ['word'], constraints: ['constraint'], original_ref: 'icy-output:abc.txt' } },
        { role: 'assistant', content: '', calls: [{ ...call('old'), name: 'old-tool-name', arguments: 'invalid JSON was reported as a tool error' }], opaque: [{ type: 'reasoning', encrypted_content: 'provider-owned', extra: { keep: true } }], reasoning: 'visible summary' },
        result('old'), assistant('done', 'running', 'pending'), result('done'),
      ], running: 'running',
    };
    await writeFile(f.file, JSON.stringify(original));
    const restored = await SessionStore.resume(f.home, f.data.id); store = restored.store;
    assert.equal(restored.recovered, 2);
    assert.deepEqual(store.data.messages.slice(0, original.messages.length), original.messages);
    const recovered = store.data.messages.slice(-2);
    assert.deepEqual(recovered.map(m => m.role === 'tool' ? [m.id, JSON.parse(m.content).error] : []), [
      ['running', 'interrupted_unknown'], ['pending', 'not_executed'],
    ]);
    assert.equal(store.data.running, undefined);
    assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')).legacyMetadata, { retained: true });
    await absent(path.join(f.home, 'should-not-exist'));
    await store.close();
    const again = await SessionStore.resume(f.home, f.data.id); store = again.store;
    assert.equal(again.recovered, 0);
    assert.equal(store.data.messages.length, original.messages.length + 2);
  } finally { await store?.close(); await f.cleanup(); }
});

test('failed create releases its lock and failed resume preserves the snapshot and can be retried', async t => {
  const f = await fixture(); let resumed: SessionStore | undefined;
  try {
    let failedDir = '';
    const failure = t.mock.method(SessionStore.prototype, 'save', async function (this: SessionStore) {
      failedDir = this.dir; throw new Error('injected save failure');
    });
    await assert.rejects(SessionStore.create(f.home, f.data), /injected save failure/);
    assert.notEqual(failedDir, '');
    await absent(path.join(failedDir, 'lock'));
    const original = JSON.stringify({ ...f.data, messages: [assistant('a')], running: 'a' });
    await writeFile(f.file, original);
    await assert.rejects(SessionStore.resume(f.home, f.data.id), /injected save failure/);
    await absent(path.join(f.dir, 'lock'));
    assert.equal(await readFile(f.file, 'utf8'), original);
    failure.mock.restore();
    const recovered = await SessionStore.resume(f.home, f.data.id); resumed = recovered.store;
    assert.equal(recovered.recovered, 1);
  } finally { await resumed?.close(); await f.cleanup(); }
});

test('failed saves preserve the last snapshot and remove temporary files after a rename failure', async () => {
  const f = await fixture(); let store: SessionStore | undefined;
  try {
    store = await SessionStore.create(f.home, f.data);
    const file = path.join(store.dir, 'session.json'), original = await readFile(file, 'utf8');
    store.data.messages.push(result('orphan'));
    await assert.rejects(store.save(), /orphan tool result/);
    assert.equal(await readFile(file, 'utf8'), original);
    store.data.messages = [];
    const backup = path.join(store.dir, 'snapshot-backup.json');
    await rename(file, backup); await mkdir(file);
    await assert.rejects(store.save(), (error: NodeJS.ErrnoException) => ['EISDIR', 'EPERM', 'EEXIST'].includes(error.code ?? ''));
    assert.deepEqual((await readdir(store.dir)).filter(name => name.endsWith('.tmp')), []);
    assert.equal(await readFile(backup, 'utf8'), original);
    await rm(file, { recursive: true }); await rename(backup, file);
    store.data.messages.push({ role: 'user', content: 'retry succeeds' }); await store.save();
    assert.equal(JSON.parse(await readFile(file, 'utf8')).messages[0].content, 'retry succeeds');
  } finally { await store?.close(); await f.cleanup(); }
});

test('failed resume never removes another live store lock', async () => {
  const f = await fixture(); let store: SessionStore | undefined;
  try {
    store = await SessionStore.create(f.home, f.data);
    const lock = path.join(store.dir, 'lock'), owner = await readFile(lock, 'utf8');
    await assert.rejects(SessionStore.resume(f.home, store.data.id), /其他 icy 进程/);
    assert.equal(await readFile(lock, 'utf8'), owner);
    await store.close(); await absent(lock);
    const resumed = await SessionStore.resume(f.home, store.data.id); store = resumed.store;
    assert.equal(resumed.recovered, 0);
  } finally { await store?.close(); await f.cleanup(); }
});

test('lock release failures remain visible and a later close retries cleanup', async () => {
  const f = await fixture(); let store: SessionStore | undefined;
  try {
    store = await SessionStore.create(f.home, f.data);
    const lock = path.join(store.dir, 'lock'), backup = path.join(store.dir, 'lock-backup');
    await rename(lock, backup); await mkdir(lock);
    await assert.rejects(store.close());
    await rm(lock, { recursive: true }); await rename(backup, lock);
    await store.close(); await absent(lock);
  } finally { await store?.close(); await f.cleanup(); }
});

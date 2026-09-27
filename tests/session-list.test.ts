import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../src/sessions/store.js';
import { listSessions } from '../src/sessions/list.js';

test('session discovery is read-only and lists corrupt entries without hiding valid active sessions', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'icy-list-')); let store: SessionStore | undefined;
  try {
    assert.deepEqual(await listSessions(home), []);
    store = await SessionStore.create(home, { cwd: home, model: 'fixture', provider: 'responses', baseUrl: 'https://example.test' });
    store.data.messages.push({ role: 'user', content: 'First goal\nwith details' }); await store.save();
    const file = path.join(store.dir, 'session.json'), before = await readFile(file, 'utf8');
    await mkdir(path.join(home, 'sessions', 'bad')); await writeFile(path.join(home, 'sessions', 'bad', 'session.json'), '{');
    const summaries = await listSessions(home);
    assert.equal(summaries.length, 2); assert.equal(summaries[0].id, store.data.id);
    assert.equal(summaries[0].goal, 'First goal with details'); assert.ok(summaries[1].error);
    assert.equal(await readFile(file, 'utf8'), before);
    assert.equal(await readFile(path.join(store.dir, 'lock'), 'utf8'), String(process.pid));
  } finally { await store?.close(); await rm(home, { recursive: true, force: true }); }
});

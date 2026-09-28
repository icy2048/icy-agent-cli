import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionStore } from '../src/sessions/store.js';
import { startRun, finishRun, registerVerification, recordVerification, canVerifyTask } from '../src/core/run-state.js';

const budget = { maxModelTurns: 20, maxToolCalls: 50, maxTokens: 10000, maxContextChars: 30000 };

test('recovery invalidates evidence only for started mutating calls with unknown results', async t => {
  const cases = [
    { name: 'write', stage: 'running', invalidates: true },
    { name: 'edit', stage: 'running', invalidates: true },
    { name: 'bash', stage: 'running', invalidates: true },
    { name: 'read', stage: 'running', invalidates: false },
    { name: 'bash', stage: 'unstarted', invalidates: false },
    { name: 'write', stage: 'unstarted', invalidates: false },
    { name: 'bash', stage: 'completed', invalidates: false },
  ] as const;
  for (const item of cases) await t.test(`${item.name} ${item.stage}`, async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'icy-recovery-evidence-'));
    let store: SessionStore | undefined;
    try {
      store = await SessionStore.create(home, { cwd: home, provider: 'responses', model: 'fixture', baseUrl: 'https://example.test/v1' });
      startRun(store.data, 'goal', budget);
      const checkId = registerVerification(store.data, { command: 'npm test', cwd: home });
      recordVerification(store.data, checkId, { ok: true, output: 'passed before interruption', mutationRevision: 0 });
      finishRun(store.data, 'verified', 'user_checks_passed');
      const verifiedRun = structuredClone(store.data.runs[0]);
      startRun(store.data, 'goal', budget, { resume: true });
      store.data.messages.push({ role: 'assistant', content: '', calls: [{ id: 'interrupted-call', name: item.name, arguments: '{}' }] });
      if (item.stage === 'running') store.data.running = 'interrupted-call';
      if (item.stage === 'completed') store.data.messages.push({ role: 'tool', id: 'interrupted-call', content: '{"ok":true,"content":"done"}' });
      if (item.invalidates) await writeFile(path.join(home, 'effect.txt'), 'changed before the result could be saved');
      assert.equal(canVerifyTask(store.data), true);
      await store.save(); const id = store.data.id; await store.close();
      const resumed = await SessionStore.resume(home, id); store = resumed.store;
      assert.equal(resumed.interrupted, 1);
      assert.equal(resumed.recovered, item.stage === 'completed' ? 0 : 1);
      assert.equal(store.data.task!.mutationRevision, item.invalidates ? 1 : 0);
      assert.equal(canVerifyTask(store.data), !item.invalidates);
      assert.equal(store.data.task!.verificationRecords[0].mutationRevision, 0, 'keep the original evidence rather than rewriting its revision');
      assert.equal(store.data.task!.status, 'interrupted');
      assert.equal(store.data.runs.at(-1)!.taskSnapshot!.mutationRevision, item.invalidates ? 1 : 0);
      assert.deepEqual(store.data.runs[0], verifiedRun, 'the historical verified run remains evidence about its original revision');
      const output = JSON.parse(store.data.messages.at(-1)!.content);
      assert.equal(output.error, item.stage === 'running' ? 'interrupted_unknown' : item.stage === 'unstarted' ? 'not_executed' : undefined);
      if (item.invalidates) assert.equal(await readFile(path.join(home, 'effect.txt'), 'utf8'), 'changed before the result could be saved');
      await store.close();
      const again = await SessionStore.resume(home, id); store = again.store;
      assert.equal(again.recovered, 0); assert.equal(again.interrupted, 0);
      assert.equal(store.data.task!.mutationRevision, item.invalidates ? 1 : 0, 'a second recovery must not invalidate the same call twice');
    } finally { await store?.close(); await rm(home, { recursive: true, force: true }); }
  });
});

test('a legacy running mutation is recovered without inventing a task or replaying the call', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'icy-legacy-recovery-evidence-'));
  let store: SessionStore | undefined;
  try {
    const id = 'legacy', dir = path.join(home, 'sessions', id); await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'session.json'), JSON.stringify({
      version: 1, id, cwd: home, provider: 'responses', model: 'fixture', baseUrl: 'https://example.test/v1', updatedAt: new Date().toISOString(),
      running: 'old-call', messages: [{ role: 'assistant', content: '', calls: [{ id: 'old-call', name: 'write', arguments: '{}' }] }],
    }));
    const resumed = await SessionStore.resume(home, id); store = resumed.store;
    assert.equal(resumed.recovered, 1); assert.equal(resumed.interrupted, 0);
    assert.equal(store.data.task, undefined); assert.deepEqual(store.data.runs, []);
    assert.equal(JSON.parse(store.data.messages.at(-1)!.content).error, 'interrupted_unknown');
  } finally { await store?.close(); await rm(home, { recursive: true, force: true }); }
});

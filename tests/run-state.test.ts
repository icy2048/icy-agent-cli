import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  startRun, updateRun, finishRun, markMutation, setRemaining, completeRemaining,
  registerVerification, recordVerification, canVerifyTask,
  type SessionExecutionState, type RunBudget,
} from '../src/core/run-state.js';
import { SessionStore, type LegacySessionData, type SessionData } from '../src/sessions/store.js';
import { parseSessionData } from '../src/sessions/schema.js';

const budget: RunBudget = { maxModelTurns: 20, maxToolCalls: 50, maxTokens: 10000, maxContextChars: 30000 };
const state = (): SessionExecutionState => ({ runs: [] });
const legacy = (cwd: string): LegacySessionData => ({
  version: 1, id: 'fixture', cwd, provider: 'responses', model: 'fixture', baseUrl: 'https://example.test/v1',
  messages: [{ role: 'user', content: 'old goal' }], updatedAt: new Date().toISOString(),
});
async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), 'icy-run-state-'));
  const data = legacy(home), dir = path.join(home, 'sessions', data.id), file = path.join(dir, 'session.json');
  await mkdir(dir, { recursive: true });
  return { home, data, dir, file, cleanup: () => rm(home, { recursive: true, force: true }) };
}
const absent = (file: string) => assert.rejects(readFile(file), { code: 'ENOENT' });

test('explicit continuation preserves the task and records a separate budget and cumulative metrics', () => {
  const s = state(), first = startRun(s, 'implement feature', budget);
  setRemaining(s, ['implement', 'verify']);
  assert.equal(completeRemaining(s, 0), 'implement');
  updateRun(s, { turns: 3, toolCalls: 5, usage: { tokens: 200, estimated: true, inputTokens: 150, outputTokens: 50 }, checkpoint: 'after-tool' });
  assert.throws(() => startRun(s, 'another goal', budget), /已有任务/);
  finishRun(s, 'limited', 'token_budget');
  const savedFirst = structuredClone(first), taskId = s.task!.id;
  assert.throws(() => startRun(s, 'changed goal', budget, { resume: true }), /原目标/);
  const next = startRun(s, 'implement feature', { ...budget, maxTokens: 20000 }, { resume: true });
  assert.equal(next.taskId, taskId); assert.equal(next.continuationOf, first.id);
  assert.equal(next.budgetSource, 'explicit_resume'); assert.equal(next.budget.maxTokens, 20000);
  assert.deepEqual(next.usage, { tokens: 0, estimated: false });
  assert.deepEqual(s.task!.remaining, ['verify']); assert.deepEqual(s.task!.completed, ['implement']);
  assert.deepEqual(first, savedFirst);
  assert.equal(first.taskSnapshot!.status, 'limited');
  assert.throws(() => completeRemaining(s, 5), /无效待办/);
});

test('run metrics never decrease, invalid patches are atomic, and estimated usage remains marked', () => {
  const s = state(), run = startRun(s, 'goal', budget);
  updateRun(s, { turns: 2, toolCalls: 3, usage: { tokens: 100, estimated: true }, checkpoint: 'model' });
  const before = structuredClone(run);
  assert.throws(() => updateRun(s, { turns: 3, toolCalls: 2 }), /不能倒退/);
  assert.deepEqual(run, before);
  assert.throws(() => updateRun(s, { usage: { tokens: -1 } }), /非负整数/);
  updateRun(s, { usage: { tokens: 150, estimated: false }, status: 'awaiting_approval' });
  assert.equal(run.usage.estimated, true); assert.equal(s.task!.status, 'awaiting_approval');
  updateRun(s, { status: 'running' }); finishRun(s, 'answered', 'completed');
  assert.throws(() => updateRun(s, { turns: 4 }), /已经结束/);
  assert.throws(() => finishRun(s, 'answered'), /已经结束/);
});

test('verified completion requires all user checks at the current mutation and no remaining work', () => {
  const s = state(), run = startRun(s, 'goal', budget);
  assert.equal(canVerifyTask(s), false);
  assert.throws(() => finishRun(s, 'verified'), /验收证据/);
  assert.throws(() => recordVerification(s, 'invented', { ok: true, output: 'success', mutationRevision: 0 }), /用户明确指定/);
  const first = registerVerification(s, { command: 'npm test', cwd: '/workspace' });
  const second = registerVerification(s, { command: 'npm run check', cwd: '/workspace' });
  setRemaining(s, ['finish task']);
  recordVerification(s, first, { ok: true, output: 'pass', mutationRevision: 0, toolCallId: 'test-call' });
  recordVerification(s, second, { ok: false, output: 'failed', mutationRevision: 0 });
  assert.equal(canVerifyTask(s), false);
  recordVerification(s, second, { ok: true, output: 'pass', mutationRevision: 0 });
  assert.equal(canVerifyTask(s), false);
  completeRemaining(s, 0); assert.equal(canVerifyTask(s), true);
  finishRun(s, 'verified', 'user_checks_passed');
  assert.equal(run.status, 'verified'); assert.equal(run.taskSnapshot!.verificationRecords.length, 3);
  markMutation(s);
  assert.equal(s.task!.status, 'answered'); assert.equal(canVerifyTask(s), false);
  assert.equal(run.taskSnapshot!.mutationRevision, 0); assert.equal(run.taskSnapshot!.status, 'verified');
  startRun(s, 'a new task', budget);
  assert.equal(s.runs[0].taskSnapshot!.verificationChecks[0].command, 'npm test');
  assert.equal(s.task!.verificationRecords.length, 0);
});

test('stale or failed checks cannot reuse earlier success and evidence output is bounded by Unicode characters', () => {
  const s = state(); startRun(s, 'goal', budget);
  const check = registerVerification(s, { command: 'npm test', cwd: '/workspace' });
  const record = recordVerification(s, check, { ok: true, output: '🙂'.repeat(4000), mutationRevision: 0 });
  assert.equal(Array.from(record.output).length, 3000); assert.equal(record.output.endsWith('🙂'), true);
  assert.equal(record.source, 'user'); assert.equal(record.command, 'npm test');
  assert.equal(canVerifyTask(s), true);
  recordVerification(s, check, { ok: false, output: 'regressed', mutationRevision: 0 });
  assert.equal(canVerifyTask(s), false);
  markMutation(s);
  recordVerification(s, check, { ok: true, output: 'stale result', mutationRevision: 0 });
  assert.equal(canVerifyTask(s), false);
  assert.throws(() => recordVerification(s, check, { ok: true, output: 'future', mutationRevision: 2 }), /未来/);
  recordVerification(s, check, { ok: true, output: 'current result', mutationRevision: 1 });
  assert.equal(canVerifyTask(s), true);
});

test('v1 migration preserves history, creates no task or verification, and persists v2 atomically', async () => {
  const f = await fixture(); let store: SessionStore | undefined;
  try {
    await writeFile(f.file, JSON.stringify(f.data));
    const resumed = await SessionStore.resume(f.home, f.data.id); store = resumed.store;
    assert.equal(store.data.version, 2); assert.equal(store.data.task, undefined); assert.deepEqual(store.data.runs, []);
    assert.deepEqual(store.data.messages, f.data.messages); assert.equal(resumed.interrupted, 0);
    const persisted = JSON.parse(await readFile(f.file, 'utf8'));
    assert.equal(persisted.version, 2); assert.equal('task' in persisted, false); assert.deepEqual(persisted.runs, []);
    assert.deepEqual(parseSessionData(persisted, f.data.id), JSON.parse(JSON.stringify(store.data)));
  } finally { await store?.close(); await f.cleanup(); }
});

test('failed migration preserves the v1 original and releases its lock for retry', async t => {
  const f = await fixture(); let store: SessionStore | undefined;
  try {
    const original = JSON.stringify(f.data); await writeFile(f.file, original);
    const failure = t.mock.method(SessionStore.prototype, 'save', async () => { throw new Error('injected migration failure'); });
    await assert.rejects(SessionStore.resume(f.home, f.data.id), /injected migration failure/);
    assert.equal(await readFile(f.file, 'utf8'), original); await absent(path.join(f.dir, 'lock'));
    failure.mock.restore();
    store = (await SessionStore.resume(f.home, f.data.id)).store;
    assert.equal(store.data.version, 2);
  } finally { await store?.close(); await f.cleanup(); }
});

test('crash checkpoints preserve side effects and close unknown calls without replaying or inventing verification', async t => {
  for (const stage of ['before_execution', 'during_execution', 'after_side_effect', 'after_result'] as const) await t.test(stage, async () => {
    const f = await fixture(); let store: SessionStore | undefined;
    try {
      store = await SessionStore.create(f.home, f.data);
      const run = startRun(store.data, 'perform work', budget);
      updateRun(store.data, { turns: 2, toolCalls: stage === 'before_execution' ? 0 : 1, usage: { tokens: 20, estimated: false }, checkpoint: stage, status: stage === 'before_execution' ? 'awaiting_approval' : 'running' });
      store.data.messages.push({ role: 'assistant', content: '', calls: [{ id: 'effect', name: 'bash', arguments: '{"command":"append one marker"}' }] });
      if (stage !== 'before_execution') store.data.running = 'effect';
      if (stage === 'after_side_effect' || stage === 'after_result') await writeFile(path.join(f.home, 'effect.txt'), 'one marker');
      if (stage === 'after_result') {
        store.data.messages.push({ role: 'tool', id: 'effect', content: '{"ok":true,"content":"done"}' });
        store.data.running = undefined;
      }
      await store.save(); const id = store.data.id; await store.close();
      const resumed = await SessionStore.resume(f.home, id); store = resumed.store;
      assert.equal(resumed.interrupted, 1); assert.equal(store.data.runs[0].id, run.id);
      assert.equal(store.data.runs[0].status, 'interrupted'); assert.equal(store.data.task!.status, 'interrupted');
      assert.equal(store.data.runs[0].checkpoint, 'interrupted'); assert.equal(store.data.runs[0].reason, 'process_interrupted');
      assert.deepEqual(store.data.task!.verificationRecords, []);
      assert.equal(resumed.recovered, stage === 'after_result' ? 0 : 1);
      const output = JSON.parse(store.data.messages.at(-1)!.content);
      assert.equal(output.error, stage === 'before_execution' ? 'not_executed' : stage === 'after_result' ? undefined : 'interrupted_unknown');
      if (stage === 'after_side_effect' || stage === 'after_result') assert.equal(await readFile(path.join(f.home, 'effect.txt'), 'utf8'), 'one marker');
      else await absent(path.join(f.home, 'effect.txt'));
      const next = startRun(store.data, 'perform work', budget, { resume: true });
      assert.equal(next.continuationOf, run.id); assert.equal(next.budgetSource, 'explicit_resume');
      assert.deepEqual(next.usage, { tokens: 0, estimated: false });
      await store.save();
    } finally { await store?.close(); await f.cleanup(); }
  });
});

test('v2 validation rejects corrupt run metrics, ownership, state and verification evidence without overwriting disk', async t => {
  const f = await fixture(); let store: SessionStore | undefined;
  try {
    store = await SessionStore.create(f.home, f.data);
    startRun(store.data, 'goal', budget); const id = store.data.id;
    const valid = structuredClone(store.data);
    const cases: { name: string; change: (data: SessionData) => void; error: RegExp }[] = [
      { name: 'negative usage', change: s => { s.runs[0].usage.tokens = -1; }, error: /usage.tokens/ },
      { name: 'missing budget', change: s => { delete (s.runs[0] as Partial<typeof s.runs[0]>).budget; }, error: /budget/ },
      { name: 'duplicate run ID', change: s => { s.runs.push(structuredClone(s.runs[0])); }, error: /duplicate run ID/ },
      { name: 'two active runs', change: s => { s.runs.push({ ...structuredClone(s.runs[0]), id: 'second' }); }, error: /only one run/ },
      { name: 'wrong task ownership', change: s => { s.runs[0].taskId = 'different'; }, error: /active run/ },
      { name: 'active run with end time', change: s => { s.runs[0].endedAt = s.runs[0].startedAt; }, error: /endedAt/ },
      { name: 'ended run without end time', change: s => { s.runs[0].status = 'failed'; s.task!.status = 'failed'; }, error: /endedAt/ },
      { name: 'unknown continuation', change: s => { s.runs[0].budgetSource = 'explicit_resume'; s.runs[0].continuationOf = 'missing'; }, error: /continuationOf/ },
      { name: 'verified without evidence', change: s => { finishRun(s, 'answered'); s.task!.status = 'verified'; }, error: /verified status/ },
      { name: 'verification promoted from model', change: s => { const c = registerVerification(s, { command: 'npm test', cwd: f.home }); recordVerification(s, c, { ok: true, output: 'pass', mutationRevision: 0 }); (s.task!.verificationRecords[0] as unknown as { source: string }).source = 'model'; }, error: /source/ },
      { name: 'orphan verification record', change: s => { const c = registerVerification(s, { command: 'npm test', cwd: f.home }); recordVerification(s, c, { ok: true, output: 'pass', mutationRevision: 0 }); s.task!.verificationRecords[0].checkId = 'missing'; }, error: /user-specified check/ },
      { name: 'forged command', change: s => { const c = registerVerification(s, { command: 'npm test', cwd: f.home }); recordVerification(s, c, { ok: true, output: 'pass', mutationRevision: 0 }); s.task!.verificationRecords[0].command = 'echo pass'; }, error: /user-specified check/ },
      { name: 'stale verified evidence', change: s => { const c = registerVerification(s, { command: 'npm test', cwd: f.home }); recordVerification(s, c, { ok: true, output: 'pass', mutationRevision: 0 }); finishRun(s, 'verified'); s.task!.mutationRevision++; }, error: /current user-specified evidence/ },
    ];
    const file = path.join(store.dir, 'session.json'); await store.save(); const original = await readFile(file, 'utf8');
    for (const item of cases) await t.test(item.name, async () => {
      const malformed = structuredClone(valid); item.change(malformed);
      assert.throws(() => parseSessionData(malformed, id), item.error);
      Object.assign(store!.data, malformed);
      await assert.rejects(store!.save(), item.error);
      assert.equal(await readFile(file, 'utf8'), original);
      Object.assign(store!.data, structuredClone(valid));
    });
  } finally { await store?.close(); await f.cleanup(); }
});

test('resume rereads the latest snapshot after acquiring ownership instead of overwriting a stale read', async t => {
  const f = await fixture(); let store: SessionStore | undefined;
  try {
    await writeFile(f.file, JSON.stringify(f.data));
    const prototype = SessionStore.prototype as unknown as { lock: (this: SessionStore) => Promise<void> };
    const lock = prototype.lock;
    const atLock = t.mock.method(prototype, 'lock', async function (this: SessionStore) {
      await lock.call(this);
      await writeFile(f.file, JSON.stringify({ ...f.data, messages: [{ role: 'user', content: 'newer committed history' }] }));
    });
    store = (await SessionStore.resume(f.home, f.data.id)).store;
    atLock.mock.restore();
    assert.equal(store.data.messages[0].content, 'newer committed history');
    assert.equal(JSON.parse(await readFile(f.file, 'utf8')).messages[0].content, 'newer committed history');
  } finally { await store?.close(); await f.cleanup(); }
});

test('post-lock validation failure releases ownership and preserves the current bad snapshot', async t => {
  const f = await fixture();
  try {
    await writeFile(f.file, JSON.stringify(f.data));
    const prototype = SessionStore.prototype as unknown as { lock: (this: SessionStore) => Promise<void> };
    const lock = prototype.lock, badSnapshot = '{broken current snapshot';
    const atLock = t.mock.method(prototype, 'lock', async function (this: SessionStore) {
      await lock.call(this); await writeFile(f.file, badSnapshot);
    });
    await assert.rejects(SessionStore.resume(f.home, f.data.id), /invalid JSON/);
    atLock.mock.restore();
    await absent(path.join(f.dir, 'lock'));
    assert.equal(await readFile(f.file, 'utf8'), badSnapshot);
  } finally { await f.cleanup(); }
});

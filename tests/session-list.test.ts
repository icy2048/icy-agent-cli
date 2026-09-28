import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile, stat, access, realpath, symlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { SessionStore } from '../src/sessions/store.js';
import { invalidStatusText, listSessions, parseStatusFilter, sessionStatuses } from '../src/sessions/list.js';

const stamp = '2026-09-27T00:00:00.000Z';
const checks = [{ id: 'check-1', source: 'user', command: 'npm test', cwd: '/fixture', createdAt: stamp }];
const records = [{ id: 'record-1', checkId: 'check-1', source: 'user', command: 'npm test', cwd: '/fixture', ok: true, output: '通过', mutationRevision: 0, recordedAt: stamp }];

/** Minimal valid v2 snapshot; verified needs its current user evidence, active runs need no end time, legacy omits the task. */
async function fixtureSession(home: string, id: string, options: { status?: string; cwd?: string } = {}) {
  const status = options.status;
  const active = status === 'running' || status === 'awaiting_approval';
  const task = status && status !== 'legacy' ? {
    id: `task-${id}`, goal: `目标 ${id}`, status, remaining: [], completed: [], mutationRevision: 0,
    verificationChecks: checks, verificationRecords: records,
  } : undefined;
  const dir = path.join(home, 'sessions', id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'session.json'), JSON.stringify({
    version: 2, id, cwd: options.cwd ?? home, provider: 'chat-completions', model: 'fixture-model', baseUrl: 'https://example.test/v1',
    messages: [{ role: 'user', content: `目标 ${id}` }], updatedAt: stamp, ...(task ? { task } : {}), runs: task ? [{
      id: `run-${id}`, taskId: task.id, goal: task.goal, status, startedAt: stamp, ...(active ? {} : { endedAt: stamp }), updatedAt: stamp,
      checkpoint: 'started', turns: 0, toolCalls: 0, usage: { tokens: 0, estimated: false },
      budget: { maxModelTurns: 1, maxToolCalls: 1, maxTokens: 10, maxContextChars: 10 }, budgetSource: 'new_task',
      ...(status === 'verified' ? { taskSnapshot: structuredClone(task) } : {}),
    }] : [],
  }));
}

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

test('each of the nine task statuses is a valid filter value and selects exactly its own session', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'icy-filter-'));
  try {
    assert.equal(sessionStatuses.length, 9);
    for (const status of sessionStatuses) await fixtureSession(home, `session-${status}`, { status });
    const all = await listSessions(home);
    assert.equal(all.length, 9); assert.ok(all.every(summary => summary.status !== undefined));
    for (const status of sessionStatuses) {
      const summaries = await listSessions(home, { status: [status] });
      assert.deepEqual(summaries.map(summary => summary.id), [`session-${status}`]);
      assert.equal(summaries[0].status, status);
    }
    const union = await listSessions(home, { status: ['failed', 'legacy'] });
    assert.deepEqual(union.map(summary => summary.id).sort(), ['session-failed', 'session-legacy']);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('cwd filters resolve against process.cwd(), match nested workspaces and combine with status', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'icy-cwd-'));
  try {
    const deep = path.join(process.cwd(), 'sub', 'deep');
    await fixtureSession(home, 'root-workspace', { status: 'failed', cwd: process.cwd() });
    await fixtureSession(home, 'nested-workspace', { status: 'failed', cwd: deep });
    await fixtureSession(home, 'other-workspace', { status: 'failed', cwd: home });
    assert.deepEqual((await listSessions(home, { cwd: '.' })).map(summary => summary.id).sort(), ['nested-workspace', 'root-workspace']);
    assert.deepEqual((await listSessions(home, { cwd: path.join('sub', 'deep') })).map(summary => summary.id), ['nested-workspace']);
    await fixtureSession(home, 'answered-workspace', { status: 'answered', cwd: deep });
    const combined = await listSessions(home, { status: ['answered'], cwd: '.' });
    assert.deepEqual(combined.map(summary => summary.id), ['answered-workspace']);
    const combinedMiss = await listSessions(home, { status: ['answered'], cwd: home });
    assert.deepEqual(combinedMiss, []);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('Windows cwd filters compare case-insensitively without confusing another drive', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'icy-cwd-win32-'));
  try {
    // The leading slash keeps the fixture valid on macOS; win32 resolution turns this into a C: path.
    await fixtureSession(home, 'nested-workspace', { status: 'failed', cwd: '/C:/Users/Runner/ws/nested' });
    await fixtureSession(home, 'other-drive', { status: 'failed', cwd: '/D:/other' });
    const listed = await listSessions(home, { cwd: '/c:/users/runner/ws/nested' }, 'win32');
    assert.deepEqual(listed.map(summary => summary.id), ['nested-workspace']);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('cwd filters realpath through a symlink and tolerate a removed workspace', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'icy-cwd-link-home-'));
  const root = await mkdtemp(path.join(tmpdir(), 'icy-cwd-link-root-'));
  try {
    const real = path.join(root, 'real'), link = path.join(root, 'link'), nested = path.join(real, 'sub');
    await mkdir(nested, { recursive: true });
    await symlink(real, link, process.platform === 'win32' ? 'junction' : undefined);
    await fixtureSession(home, 'linked-workspace', { status: 'failed', cwd: await realpath(nested) });
    assert.deepEqual((await listSessions(home, { cwd: path.join(root, 'link', 'sub') })).map(summary => summary.id), ['linked-workspace']);

    const removed = path.join(root, 'removed', 'sub');
    assert.deepEqual(await listSessions(home, { cwd: removed }), []);
    await assert.rejects(access(removed), { code: 'ENOENT' });
  } finally { await rm(home, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); }
});

test('a removed workspace is a valid filter that matches nothing without creating or reading it', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'icy-cwd-missing-'));
  try {
    await fixtureSession(home, 'somewhere', { status: 'failed', cwd: home });
    const missing = path.join(tmpdir(), `icy-gone-${process.pid}-${Date.now()}`);
    assert.deepEqual(await listSessions(home, { cwd: missing }), []);
    await assert.rejects(access(missing), { code: 'ENOENT' });
    await assert.rejects(access(path.join(home, 'sessions', 'somewhere', 'lock')), { code: 'ENOENT' });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('invalid status values throw before any directory is read', async () => {
  const missing = path.join(tmpdir(), `icy-absent-${process.pid}-${Date.now()}`);
  try {
    await assert.rejects(listSessions(missing, { status: ['bogus'] }), { message: 'invalid_status: bogus' });
    await assert.rejects(listSessions(missing, { status: ['failed', 'nope'] }), { message: 'invalid_status: nope' });
    await assert.rejects(access(path.join(missing, 'sessions')), { code: 'ENOENT' });
    assert.deepEqual(await listSessions(missing), []);
    assert.deepEqual(parseStatusFilter(' failed , answered ,'), ['failed', 'answered']);
    assert.throws(() => parseStatusFilter('failed,bogus'), { message: 'invalid_status: bogus' });
    assert.match(invalidStatusText(new Error('invalid_status: bogus'))!, /^无效的状态：bogus；可用：running, awaiting_approval/);
    assert.equal(invalidStatusText(new Error('其他错误')), undefined);
  } finally { await rm(missing, { recursive: true, force: true }); }
});

test('unreadable sessions stay listed without filters and are excluded whenever any filter is active', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'icy-broken-'));
  try {
    await fixtureSession(home, 'good', { status: 'failed', cwd: await realpath(home) });
    await mkdir(path.join(home, 'sessions', 'broken')); await writeFile(path.join(home, 'sessions', 'broken', 'session.json'), '{');
    const unfiltered = await listSessions(home);
    assert.equal(unfiltered.length, 2); assert.ok(unfiltered.find(summary => summary.id === 'broken')?.error);
    for (const filter of [{ status: ['failed'] }, { cwd: home }, { status: ['failed'], cwd: home }]) {
      const listed = await listSessions(home, filter as { status?: string[]; cwd?: string });
      assert.deepEqual(listed.map(summary => summary.id), ['good']);
      assert.equal(listed[0].error, undefined);
    }
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('listing with and without filters leaves the sessions directory untouched', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'icy-readonly-'));
  try {
    await fixtureSession(home, 'snapshot-a', { status: 'failed', cwd: process.cwd() });
    await fixtureSession(home, 'snapshot-b', { status: 'legacy' });
    const capture = async (): Promise<string> => {
      const items: { file: string; size?: number; mtimeMs: number; content?: string }[] = [];
      const walk = async (dir: string): Promise<void> => {
        for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          const full = path.join(dir, entry.name), info = await stat(full);
          if (entry.isDirectory()) { items.push({ file: path.relative(home, full), mtimeMs: info.mtimeMs }); await walk(full); }
          else items.push({ file: path.relative(home, full), size: info.size, mtimeMs: info.mtimeMs, content: (await readFile(full)).toString('base64') });
        }
      };
      await walk(home);
      return JSON.stringify(items);
    };
    const before = await capture();
    await listSessions(home);
    await listSessions(home, { status: ['failed'] });
    await listSessions(home, { cwd: '.' });
    await listSessions(home, { status: ['failed', 'legacy'], cwd: home });
    assert.equal(await capture(), before);
  } finally { await rm(home, { recursive: true, force: true }); }
});

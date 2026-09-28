import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs, { access, mkdtemp, mkdir, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Agent } from '../src/core/agent.js';
import { canVerifyTask } from '../src/core/run-state.js';
import { SessionStore, type SessionData } from '../src/sessions/store.js';
import { listSessions } from '../src/sessions/list.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { Config } from '../src/config/load.js';
import type { AgentEvent } from '../src/core/types.js';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.tsx', import.meta.url));
async function workspace() {
  const dir = await mkdtemp(path.join(tmpdir(), 'icy-review-regression-'));
  const cwd = path.join(dir, 'workspace'), home = path.join(dir, 'icy');
  await Promise.all([mkdir(cwd), mkdir(home)]);
  const runCli = (args: string[]) => exec(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], {
    cwd, env: { PATH: process.env.PATH, HOME: dir, ICY_HOME: home, NO_COLOR: '1' }, timeout: 15000, maxBuffer: 1024 * 1024,
  });
  return { dir, cwd, home, runCli, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
async function verificationFixture() {
  const f = await workspace();
  const config: Config = { home: f.home, cwd: f.cwd, provider: 'chat-completions', baseUrl: 'http://127.0.0.1:1', model: 'offline-review', apiKey: 'fixture-key', apiKeyEnv: 'ICY_TEST_KEY', permissions: 'workspace-edit', promptCompaction: 'off', compactionMinChars: 200, maxModelTurns: 3, maxToolCalls: 10, maxTokens: 100000, maxContextChars: 120000, requestTimeoutMs: 1000 };
  const store = await SessionStore.create(f.home, config);
  const agent = new Agent(config, { complete: async () => ({ text: 'Ready for user checks.', calls: [], tokens: 10 }) }, new ToolRegistry(config, store, async () => 'once'), store);
  await writeFile(path.join(f.cwd, 'value.txt'), 'good');
  await agent.run('Keep value.txt good.', new AbortController().signal);
  const first = await agent.verify('test "$(cat value.txt)" = good', new AbortController().signal);
  assert.equal(first.ok, true); assert.equal(store.data.task?.status, 'verified');
  const snapshot = async (): Promise<SessionData> => JSON.parse(await readFile(path.join(store.dir, 'session.json'), 'utf8'));
  return { ...f, agent, store, snapshot, cleanup: async () => { await store.close(); await f.cleanup(); } };
}

test('two read-only user verifications share one mutation revision and can both establish verified completion', async () => {
  const f = await verificationFixture();
  try {
    const before = f.store.data.task!.mutationRevision;
    const second = await f.agent.verify('test -f value.txt', new AbortController().signal);
    assert.equal(second.ok, true);
    const saved = await f.snapshot(), task = saved.task!;
    assert.equal(task.mutationRevision, before); assert.equal(task.status, 'verified'); assert.equal(canVerifyTask(saved), true);
    assert.equal(task.verificationRecords.length, 2);
    assert.ok(task.verificationRecords.every(record => record.ok && record.mutationRevision === task.mutationRevision));
  } finally { await f.cleanup(); }
});

for (const fails of [false, true]) {
  test(`a ${fails ? 'failed' : 'successful'} mutating verification expires earlier evidence`, async () => {
    const f = await verificationFixture();
    try {
      const before = f.store.data.task!.mutationRevision;
      const result = await f.agent.verify(`printf bad > value.txt${fails ? '; exit 7' : ''}`, new AbortController().signal);
      assert.equal(result.ok, !fails); if (fails) assert.equal(result.reason, 'verification_failed');
      assert.equal(await readFile(path.join(f.cwd, 'value.txt'), 'utf8'), 'bad');
      const saved = await f.snapshot(), task = saved.task!;
      assert.ok(task.mutationRevision > before, 'verification commands can mutate the workspace too');
      assert.ok(task.verificationRecords[0].mutationRevision < task.mutationRevision, 'prior passing checks must become stale');
      assert.notEqual(task.status, 'verified'); assert.equal(canVerifyTask(saved), false);
      assert.equal(task.verificationRecords.at(-1)?.ok, !fails);
    } finally { await f.cleanup(); }
  });
}

test('cancelling a verification after its side effect expires prior passing evidence', async () => {
  const f = await verificationFixture(), controller = new AbortController();
  let running: ReturnType<Agent['verify']> | undefined;
  try {
    const before = f.store.data.task!.mutationRevision;
    running = f.agent.verify('printf bad > value.txt; touch cancellation-ready; sleep 20', controller.signal);
    const deadline = Date.now() + 5000;
    while (true) {
      try { await access(path.join(f.cwd, 'cancellation-ready')); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || Date.now() > deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
    controller.abort();
    const result = await running;
    assert.equal(result.reason, 'cancelled'); assert.equal(result.ok, false);
    assert.equal(await readFile(path.join(f.cwd, 'value.txt'), 'utf8'), 'bad');
    const saved = await f.snapshot(), task = saved.task!;
    assert.ok(task.mutationRevision > before); assert.ok(task.verificationRecords[0].mutationRevision < task.mutationRevision);
    assert.equal(task.status, 'cancelled'); assert.equal(canVerifyTask(saved), false);
    assert.equal(saved.runs.at(-1)?.reason, 'cancelled');
  } finally { controller.abort(); await running?.catch(() => {}); await f.cleanup(); }
});

test('an unknown workspace fingerprint from the size limit conservatively expires prior checks', async () => {
  const f = await verificationFixture();
  try {
    const before = f.store.data.task!.mutationRevision, large = path.join(f.cwd, 'large.bin');
    // Sparse and one byte over the production limit: the fingerprint must not read 64 MiB.
    await writeFile(large, ''); await truncate(large, 64 * 1024 * 1024 + 1);
    const result = await f.agent.verify('test -f value.txt', new AbortController().signal);
    assert.equal(result.ok, true);
    const saved = await f.snapshot(), task = saved.task!;
    assert.ok(task.mutationRevision > before); assert.ok(task.verificationRecords[0].mutationRevision < task.mutationRevision);
    assert.notEqual(task.status, 'verified'); assert.equal(canVerifyTask(saved), false);
    assert.equal(task.verificationRecords.at(-1)?.ok, true, 'the new command result remains known even though older evidence is stale');
  } finally { await f.cleanup(); }
});

test('cancellation during the post-verification fingerprint preserves the known tool result but creates no passing evidence', async t => {
  const f = await verificationFixture(), controller = new AbortController();
  const valueFile = path.join(f.cwd, 'value.txt'), originalOpen = fs.open;
  const before = f.store.data.task!.mutationRevision, events: AgentEvent[] = [];
  f.agent.setListener(event => events.push(event));
  let fingerprintReads = 0;
  const mocked = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (args[0] === valueFile && ++fingerprintReads === 2) controller.abort(new Error('cancel post-verification fingerprint'));
    return handle;
  });
  try {
    const result = await f.agent.verify('test -f value.txt', controller.signal);
    assert.equal(fingerprintReads, 2); assert.equal(result.ok, false); assert.equal(result.reason, 'cancelled');
    const saved = await f.snapshot(), task = saved.task!;
    assert.ok(task.mutationRevision > before); assert.equal(task.status, 'cancelled');
    assert.equal(task.verificationRecords.at(-1)?.ok, false); assert.equal(canVerifyTask(saved), false);
    const tool = saved.messages.findLast(message => message.role === 'tool'); assert.ok(tool);
    const known = JSON.parse(tool.content); assert.equal(known.ok, true); assert.match(known.content, /Exit code: 0/); assert.equal(known.error, undefined);
    const ends = events.filter((event): event is Extract<AgentEvent, { type: 'tool_end' }> => event.type === 'tool_end');
    assert.equal(ends.length, 1); assert.equal(ends[0].result.ok, true); assert.equal(saved.running, undefined);
  } finally { mocked.mock.restore(); await f.cleanup(); }
});

test('session listing cleans and redacts every displayed metadata field without rewriting the source snapshot', async () => {
  const f = await workspace();
  try {
    const fakeSecret = `sk-${'f'.repeat(30)}`, escape = '\u001b[2J';
    const dir = path.join(f.home, 'sessions', 'unsafe-metadata'); await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'session.json');
    const original = JSON.stringify({ version: 1, id: 'unsafe-metadata', cwd: `${f.cwd}/${escape}${fakeSecret}`, model: `fixture ${escape}${fakeSecret}`, provider: 'chat-completions', baseUrl: 'https://example.test/v1', messages: [{ role: 'user', content: `Inspect ${escape}${fakeSecret}` }], updatedAt: new Date().toISOString() });
    await writeFile(file, original);
    const summaries = await listSessions(f.home); assert.equal(summaries.length, 1); assert.equal(summaries[0].error, undefined);
    for (const [field, value] of Object.entries(summaries[0])) if (typeof value === 'string') {
      assert.ok(!value.includes(escape), `${field} retained terminal escape bytes`);
      assert.ok(!value.includes(fakeSecret), `${field} retained a secret`);
    }
    assert.match(summaries[0].cwd!, /\[REDACTED\]/); assert.match(summaries[0].model!, /\[REDACTED\]/); assert.match(summaries[0].goal!, /\[REDACTED\]/);
    for (const args of [['sessions'], ['sessions', '--json']]) {
      const result = await f.runCli(args);
      assert.equal(result.stderr, ''); assert.ok(!result.stdout.includes(escape)); assert.ok(!result.stdout.includes(fakeSecret));
      if (args.includes('--json')) assert.equal(JSON.parse(result.stdout.trim()).type, 'session_summary');
    }
    assert.equal(await readFile(file, 'utf8'), original);
    await assert.rejects(access(path.join(dir, 'lock')), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

test('CLI can explicitly continue an offline demo without rereading its completed tool', async () => {
  const f = await workspace();
  try {
    await writeFile(path.join(f.cwd, 'README.md'), '# Demo continuation fixture\n');
    await writeFile(path.join(f.home, 'config.json'), JSON.stringify({ maxModelTurns: 3 }));
    const initial = await f.runCli(['--demo', '--json']);
    const initialEvents = initial.stdout.trimEnd().split('\n').map(line => JSON.parse(line) as { type: string; id?: string });
    const id = initialEvents[0].id!; assert.equal(initialEvents[0].type, 'session');
    assert.equal(initialEvents.filter(event => event.type === 'tool_end').length, 1);
    const continued = await f.runCli(['run', '--resume', id, '--demo', '--continue', '--json']);
    assert.equal(continued.stderr, '');
    const events = continued.stdout.trimEnd().split('\n').map(line => JSON.parse(line) as { type: string });
    assert.deepEqual(events.at(-1), { type: 'done', reason: 'completed', ok: true });
    assert.equal(events.filter(event => event.type === 'tool_start').length, 0);
    const saved = JSON.parse(await readFile(path.join(f.home, 'sessions', id, 'session.json'), 'utf8')) as SessionData;
    assert.equal(saved.runs.length, 2); assert.equal(saved.runs[1].reason, 'completed'); assert.equal(saved.runs[1].toolCalls, 0);
    assert.equal(saved.messages.filter(message => message.role === 'assistant').flatMap(message => message.calls).length, 1);
  } finally { await f.cleanup(); }
});

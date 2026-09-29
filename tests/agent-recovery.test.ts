import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../src/core/agent.js';
import { canVerifyTask } from '../src/core/run-state.js';
import type { AgentEvent, Approve, Completion, Message, ProcessRecord, Provider, ToolCall } from '../src/core/types.js';
import type { Config } from '../src/config/load.js';
import { SessionStore, type SessionStoreOptions } from '../src/sessions/store.js';
import { ToolRegistry } from '../src/tools/registry.js';

const signal = () => new AbortController().signal;
const call = (id: string, name: string, args: unknown): ToolCall => ({ id, name, arguments: JSON.stringify(args) });
const completion = (...calls: ToolCall[]): Completion => ({ text: '', calls, tokens: 2 });
const done = (): Completion => ({ text: 'done', calls: [], tokens: 2 });
const write = (id: string, file: string, content: string) => call(id, 'write', { path: file, content, expectedHash: null });
const read = (id: string, file: string) => call(id, 'read', { path: file, offset: null, limit: null });
const absent = (file: string) => assert.rejects(readFile(file), { code: 'ENOENT' });

async function setup(provider: Provider, options: Partial<Config> = {}, approve?: Approve, storeOptions: SessionStoreOptions = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'icy-agent-recovery-'));
  const workspace = path.join(dir, 'workspace'), home = path.join(dir, 'home'); await mkdir(workspace);
  const cwd = await realpath(workspace);
  const config: Config = {
    home, cwd, provider: 'chat-completions', baseUrl: 'http://127.0.0.1:1', model: 'fixture', apiKey: 'test-secret-value', apiKeyEnv: 'ICY_TEST_KEY',
    permissions: 'workspace-edit', promptCompaction: 'off', compactionMinChars: 200, maxModelTurns: 20, maxToolCalls: 50,
    maxTokens: 100000, maxContextChars: 120000, requestTimeoutMs: 1000, ...options,
  };
  const store = await SessionStore.create(home, { cwd, provider: config.provider, model: config.model, baseUrl: config.baseUrl }, [config.apiKey], storeOptions);
  const events: AgentEvent[] = [], tools = new ToolRegistry(config, store, approve);
  const agent = new Agent(config, provider, tools, store, event => events.push(event));
  return { dir, cwd, home, config, store, tools, events, agent, cleanup: async () => { await agent.store.close(); await store.close(); await rm(dir, { recursive: true, force: true }); } };
}

function assertToolProjection(messages: Message[], events: AgentEvent[]) {
  const calls = messages.filter(message => message.role === 'assistant').flatMap(message => message.calls);
  const outputs = messages.filter(message => message.role === 'tool');
  const starts = events.filter(event => event.type === 'tool_start'), ends = events.filter(event => event.type === 'tool_end');
  assert.deepEqual(outputs.map(message => message.id), calls.map(item => item.id));
  assert.deepEqual(starts.map(event => event.call.id), calls.map(item => item.id));
  assert.deepEqual(ends.map(event => event.call.id), calls.map(item => item.id));
  for (let index = 0; index < outputs.length; index++) assert.deepEqual(ends[index].result, JSON.parse(outputs[index].content));
}

test('limited or cancelled real writes survive close/resume/continue without replay or duplicate user messages', async t => {
  for (const stop of ['limited', 'cancelled'] as const) await t.test(stop, async () => {
    let firstRequests = 0;
    const originalProvider: Provider = { async complete() {
      firstRequests++; return completion(write('write-once', 'value.txt', 'created once'), write('never-started', 'never.txt', 'no'));
    } };
    const s = await setup(originalProvider, stop === 'limited' ? { maxToolCalls: 1 } : {});
    let resumed: Agent | undefined;
    try {
      const abort = new AbortController();
      s.agent.setListener(event => {
        s.events.push(event);
        if (stop === 'cancelled' && event.type === 'tool_end' && event.call.id === 'write-once') abort.abort();
      });
      const result = await s.agent.run('create one file and inspect the result', abort.signal);
      assert.equal(result.reason, stop === 'limited' ? 'max_tool_calls' : 'cancelled');
      assert.equal(s.store.data.task!.status, stop); assert.equal(firstRequests, 1);
      assert.equal(await readFile(path.join(s.cwd, 'value.txt'), 'utf8'), 'created once');
      await absent(path.join(s.cwd, 'never.txt'));
      assertToolProjection(s.store.data.messages, s.events);
      assert.equal(JSON.parse(s.store.data.messages.at(-1)!.content).error, 'not_executed');
      const originalId = s.store.data.id, originalRun = JSON.parse(JSON.stringify(s.store.data.runs[0])), taskId = s.store.data.task!.id;
      await s.store.close();
      const restored = await SessionStore.resume(s.home, originalId);
      assert.equal(restored.recovered, 0); assert.equal(restored.interrupted, 0);
      let requests = 0; const resumedEvents: AgentEvent[] = [];
      const provider: Provider = { async complete(messages) {
        requests++;
        assert.equal(messages.filter(message => message.role === 'user' && message.content === 'create one file and inspect the result').length, 1);
        assert.ok(messages.some(message => message.role === 'tool' && message.id === 'write-once' && JSON.parse(message.content).ok));
        if (requests === 1) return completion(read('inspect-existing', 'value.txt'));
        const observation = messages.find(message => message.role === 'tool' && message.id === 'inspect-existing');
        assert.match(observation!.content, /created once/); return done();
      } };
      const nextTools = new ToolRegistry(s.config, restored.store);
      const execute = nextTools.execute.bind(nextTools);
      t.mock.method(nextTools, 'execute', async (toolCall: ToolCall, toolSignal: AbortSignal) => {
        assert.equal(toolCall.name, 'read', 'old write calls must not be executed during recovery or continuation');
        return execute(toolCall, toolSignal);
      });
      resumed = new Agent(s.config, provider, nextTools, restored.store, event => resumedEvents.push(event));
      assert.equal((await resumed.continue(signal())).ok, true);
      assert.equal(resumed.store.data.task!.id, taskId); assert.equal(resumed.store.data.runs.length, 2);
      assert.equal(resumed.store.data.runs[1].continuationOf, originalRun.id);
      assert.equal(resumed.store.data.runs[1].budgetSource, 'explicit_resume');
      assert.deepEqual(resumed.store.data.runs[0], originalRun);
      assert.equal(resumed.store.data.messages.filter(message => message.role === 'user').length, 1);
      assert.equal(resumedEvents.filter(event => event.type === 'tool_start').length, 1);
      assert.equal(await readFile(path.join(s.cwd, 'value.txt'), 'utf8'), 'created once');
      await absent(path.join(s.cwd, 'never.txt'));
      assertToolProjection(resumed.store.data.messages, [...s.events, ...resumedEvents]);
    } finally { await resumed?.store.close(); await s.cleanup(); }
  });
});

test('an executor exception after a real side effect closes unknown and pending calls consistently', async t => {
  const provider: Provider = { async complete() { return completion(write('unknown-write', 'effect.txt', 'one effect'), read('pending-read', 'effect.txt'), write('pending-write', 'never.txt', 'no')); } };
  const s = await setup(provider); let restored: SessionStore | undefined;
  try {
    const execute = s.tools.execute.bind(s.tools); let executions = 0;
    t.mock.method(s.tools, 'execute', async (toolCall: ToolCall, toolSignal: AbortSignal) => {
      executions++; const result = await execute(toolCall, toolSignal); assert.equal(result.ok, true);
      throw new Error('executor failed after the side effect');
    });
    const result = await s.agent.run('write one marker', signal());
    assert.equal(result.ok, false); assert.match(result.reason, /executor failed/); assert.equal(executions, 1);
    assert.equal(await readFile(path.join(s.cwd, 'effect.txt'), 'utf8'), 'one effect'); await absent(path.join(s.cwd, 'never.txt'));
    assert.deepEqual(s.store.data.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content).error), ['interrupted_unknown', 'not_executed', 'not_executed']);
    assertToolProjection(s.store.data.messages, s.events);
    const file = path.join(s.store.dir, 'events.jsonl');
    const persistedEvents = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as AgentEvent);
    assertToolProjection(s.store.data.messages, persistedEvents);
    await s.store.close();
    const recovered = await SessionStore.resume(s.home, s.store.data.id); restored = recovered.store;
    assert.equal(recovered.recovered, 0); assert.equal(executions, 1);
    assert.equal(JSON.parse(restored.data.messages.find(message => message.role === 'tool' && message.id === 'unknown-write')!.content).error, 'interrupted_unknown');
  } finally { await restored?.close(); await s.cleanup(); }
});

test('a transient save failure after a completed write still closes the live tool event from the known result', async t => {
  const s = await setup({ async complete() { return completion(write('completed-before-save-failure', 'effect.txt', 'completed effect'), read('not-started-after-save-failure', 'effect.txt')); } });
  try {
    let injected = false;
    const save = s.store.save.bind(s.store);
    t.mock.method(s.store, 'save', async () => {
      if (!injected && s.store.data.messages.some(message => message.role === 'tool' && message.id === 'completed-before-save-failure')) {
        injected = true; throw new Error('transient save failure after tool completion');
      }
      await save();
    });
    const result = await s.agent.run('write one file', signal());
    assert.equal(result.ok, false); assert.equal(injected, true);
    assert.equal(await readFile(path.join(s.cwd, 'effect.txt'), 'utf8'), 'completed effect');
    assert.equal(JSON.parse(s.store.data.messages.find(message => message.role === 'tool' && message.id === 'completed-before-save-failure')!.content).ok, true);
    assertToolProjection(s.store.data.messages, s.events);
  } finally { await s.cleanup(); }
});

test('verify refuses live detached records before creating a run or invoking bash', async () => {
  let approvals = 0;
  const s = await setup({ async complete() { return done(); } }, {}, async () => { approvals++; return 'once'; });
  const record: ProcessRecord = { id: '11111111-1111-4111-8111-111111111111', toolCallId: 'detached-call', command: 'sleep 30', cwd: s.cwd, startedAt: new Date().toISOString(), timeoutMs: 60_000, status: 'running', bytes: 0 };
  try {
    await s.agent.run('prepare work', signal());
    s.store.data.processes.push(record);
    const runs = s.store.data.runs.length;
    const message = '有后台进程仍在运行（icy-process:11111111），验收结果不可靠。先用 /ps 查看，/kill 终止或等待结束后再 /verify。';
    await assert.rejects(s.agent.verify('true', signal()), { message });
    assert.equal(s.store.data.runs.length, runs); assert.equal(approvals, 0);
    record.status = 'unknown'; record.pidAlive = true;
    await assert.rejects(s.agent.verify('true', signal()), { message });
    assert.equal(s.store.data.runs.length, runs); assert.equal(approvals, 0);
    record.pidAlive = false;
    assert.equal((await s.agent.verify('true', signal())).ok, true);
    assert.equal(s.store.data.runs.length, runs + 1); assert.equal(approvals, 1);
    record.status = 'exited'; record.endedAt = new Date().toISOString();
  } finally { record.status = 'exited'; record.endedAt ??= new Date().toISOString(); await s.cleanup(); }
});

test('verify refreshes stale unknown liveness before allowing the command', async () => {
  let alive = false, approvals = 0;
  const s = await setup({ async complete() { return done(); } }, {}, async () => { approvals++; return 'once'; }, { processAlive: () => alive });
  const record: ProcessRecord = { id: '22222222-2222-4222-8222-222222222222', toolCallId: 'stale-live', command: 'sleep 30', cwd: s.cwd, pid: 4242, startedAt: new Date().toISOString(), timeoutMs: 60_000, status: 'unknown', pidAlive: false, bytes: 0 };
  try {
    await s.agent.run('prepare work', signal()); s.store.data.processes.push(record); alive = true;
    await assert.rejects(s.agent.verify('true', signal()), /有后台进程仍在运行/);
    assert.equal(record.pidAlive, true); assert.equal(approvals, 0);
    alive = false; record.pidAlive = false;
    assert.equal((await s.agent.verify('true', signal())).ok, true); assert.equal(approvals, 1);
  } finally { record.status = 'exited'; record.endedAt ??= new Date().toISOString(); await s.cleanup(); }
});

test('verification obeys approval and a failed command retry retains its user check identity', async () => {
  let modelCalls = 0;
  const s = await setup({ async complete() { modelCalls++; return done(); } });
  try {
    await s.agent.run('prepare work', signal());
    const command = 'test -f ready.txt';
    const blocked = await s.agent.verify(command, signal());
    assert.equal(blocked.reason, 'approval_required'); assert.equal(s.store.data.task!.status, 'failed');
    assert.equal(s.store.data.task!.verificationChecks.length, 1);
    const checkId = s.store.data.task!.verificationChecks[0].id;
    assert.equal(s.store.data.task!.verificationRecords[0].ok, false);
    let approvals = 0;
    s.agent.tools = new ToolRegistry(s.config, s.store, async request => {
      approvals++; assert.equal(request.command, command); assert.equal(request.cwd, s.cwd); return 'once';
    });
    const failed = await s.agent.verify(command, signal());
    assert.equal(failed.reason, 'verification_failed'); assert.equal(canVerifyTask(s.store.data), false);
    await writeFile(path.join(s.cwd, 'ready.txt'), 'ready');
    assert.equal((await s.agent.verify(command, signal())).ok, true);
    assert.equal(s.store.data.task!.status, 'verified'); assert.equal(approvals, 2); assert.equal(modelCalls, 1);
    assert.equal(s.store.data.task!.verificationChecks.length, 1);
    assert.deepEqual(s.store.data.task!.verificationRecords.map(record => [record.checkId, record.source, record.ok]), [[checkId, 'user', false], [checkId, 'user', false], [checkId, 'user', true]]);
    assert.ok(s.events.some(event => event.type === 'task' && event.run?.status === 'awaiting_approval'));
    assertToolProjection(s.store.data.messages, s.events);
  } finally { await s.cleanup(); }
});

test('remaining items block verified status and a later model mutation expires earlier user checks', async () => {
  let requests = 0, mutate = false;
  const provider: Provider = { async complete() {
    requests++;
    if (requests === 1) return completion(write('initial-write', 'value.txt', 'before'));
    if (mutate) { mutate = false; return completion(call('later-edit', 'edit', { path: 'value.txt', oldText: 'before', newText: 'after' })); }
    return done();
  } };
  const s = await setup(provider, {}, async () => 'once');
  try {
    assert.equal((await s.agent.run('update the project', signal())).ok, true);
    assert.equal(s.store.data.task!.status, 'answered');
    const revision = s.store.data.task!.mutationRevision, command = 'test -f value.txt';
    await s.agent.verify(command, signal()); assert.equal(s.store.data.task!.status, 'verified');
    await s.agent.addTodo('review the output'); assert.equal(s.store.data.task!.status, 'answered');
    await s.agent.verify(command, signal()); assert.equal(s.store.data.task!.status, 'answered'); assert.equal(canVerifyTask(s.store.data), false);
    await s.agent.completeTodo(0); await s.agent.verify(command, signal()); assert.equal(s.store.data.task!.status, 'verified');
    mutate = true; await s.agent.continue(signal());
    assert.equal(await readFile(path.join(s.cwd, 'value.txt'), 'utf8'), 'after');
    assert.equal(s.store.data.task!.mutationRevision, revision + 1); assert.equal(s.store.data.task!.status, 'answered');
    assert.equal(canVerifyTask(s.store.data), false);
    await s.agent.verify(command, signal()); assert.equal(s.store.data.task!.status, 'verified');
    assert.equal(s.store.data.task!.verificationChecks.length, 1);
    assert.equal(s.store.data.task!.verificationRecords.at(-1)!.mutationRevision, revision + 1);
    assert.deepEqual(s.store.data.task!.completed, ['review the output']);
    assertToolProjection(s.store.data.messages, s.events);
  } finally { await s.cleanup(); }
});

test('ordinary model-selected bash success remains answered without a user verification check', async () => {
  let requests = 0;
  const s = await setup({ async complete() { return ++requests === 1 ? completion(call('model-test', 'bash', { command: 'true', cwd: null, timeoutMs: 1000 })) : done(); } }, {}, async () => 'once');
  try {
    assert.equal((await s.agent.run('run a check', signal())).ok, true);
    assert.equal(s.store.data.task!.status, 'answered'); assert.equal(canVerifyTask(s.store.data), false);
    assert.deepEqual(s.store.data.task!.verificationChecks, []); assert.deepEqual(s.store.data.task!.verificationRecords, []);
  } finally { await s.cleanup(); }
});

test('mismatched session switching keeps the original store usable and releases the candidate lock', async t => {
  for (const field of ['cwd', 'provider', 'model', 'baseUrl'] as const) await t.test(field, async () => {
    const s = await setup({ async complete() { return done(); } }); let candidate: SessionStore | undefined;
    try {
      await s.agent.run('current goal', signal()); const original = s.agent.store, originalData = structuredClone(original.data);
      const metadata = { cwd: s.cwd, provider: s.config.provider, model: s.config.model, baseUrl: s.config.baseUrl };
      if (field === 'cwd') { metadata.cwd = path.join(s.dir, 'other-workspace'); await mkdir(metadata.cwd); }
      if (field === 'provider') metadata.provider = 'responses';
      if (field === 'model') metadata.model = 'other-model';
      if (field === 'baseUrl') metadata.baseUrl = 'https://different.test/v1';
      candidate = await SessionStore.create(s.home, metadata); const candidateId = candidate.data.id; await candidate.close();
      await assert.rejects(s.agent.resumeSession(candidateId), /相同工作区/);
      assert.equal(s.agent.store, original); assert.deepEqual(s.agent.store.data, originalData);
      assert.equal(await readFile(path.join(original.dir, 'lock'), 'utf8'), String(process.pid));
      await absent(path.join(candidate.dir, 'lock'));
      candidate = (await SessionStore.resume(s.home, candidateId)).store; await candidate.close();
      assert.equal((await s.agent.continue(signal())).ok, true);
    } finally { await candidate?.close(); await s.cleanup(); }
  });
});

test('clear and new conversation reset execution state while new conversation preserves the previous session', async () => {
  const s = await setup({ async complete() { return done(); } }); let previous: SessionStore | undefined;
  try {
    await s.agent.run('first goal', signal()); await s.agent.addTodo('one remaining item');
    const firstId = s.store.data.id;
    await s.agent.clear();
    assert.equal(s.agent.store.data.id, firstId); assert.deepEqual(s.agent.store.data.messages, []);
    assert.equal(s.agent.store.data.task, undefined); assert.deepEqual(s.agent.store.data.runs, []); assert.equal(s.agent.store.data.running, undefined);
    await assert.rejects(s.agent.continue(signal()), /没有任务检查点/);
    await s.agent.run('second goal', signal()); const secondTask = structuredClone(s.agent.store.data.task);
    await s.agent.newConversation();
    assert.notEqual(s.agent.store.data.id, firstId); assert.deepEqual(s.agent.store.data.messages, []);
    assert.equal(s.agent.store.data.task, undefined); assert.deepEqual(s.agent.store.data.runs, []);
    const recovered = await SessionStore.resume(s.home, firstId); previous = recovered.store;
    assert.deepEqual(previous.data.task, secondTask); assert.equal(previous.data.messages[0].content, 'second goal');
  } finally { await previous?.close(); await s.cleanup(); }
});

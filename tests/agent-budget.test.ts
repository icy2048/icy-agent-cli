import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Agent } from '../src/core/agent.js';
import { Budget } from '../src/core/budget.js';
import { SessionStore, type SessionData } from '../src/sessions/store.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { Config } from '../src/config/load.js';
import type { AgentEvent, Completion, Provider, RequestBudget } from '../src/core/types.js';
import type { SemanticProviderFactory } from '../src/core/semantic.js';

async function setup(provider: Provider, options: Partial<Config> = {}, semanticFactory?: SemanticProviderFactory) {
  const dir = await mkdtemp(path.join(tmpdir(), 'icy-agent-budget-'));
  const cwd = path.join(dir, 'workspace'), home = path.join(dir, 'home'); await mkdir(cwd);
  const config: Config = { home, cwd, provider: 'chat-completions', baseUrl: 'http://127.0.0.1:1', model: 'offline-budget', apiKey: 'fixture-key', apiKeyEnv: 'ICY_TEST_KEY', permissions: 'workspace-edit', promptCompaction: 'off', compactionMinChars: 0, maxModelTurns: 5, maxToolCalls: 10, maxTokens: 5000, maxContextChars: 100000, requestTimeoutMs: 1000, ...options };
  const store = await SessionStore.create(home, { cwd, provider: config.provider, baseUrl: config.baseUrl, model: config.model });
  const tools = new ToolRegistry(config, store), events: AgentEvent[] = [];
  const agent = new Agent(config, provider, tools, store, event => events.push(event), semanticFactory);
  const snapshot = async () => JSON.parse(await readFile(path.join(store.dir, 'session.json'), 'utf8')) as SessionData;
  const cleanup = async () => { await store.close(); await rm(dir, { recursive: true, force: true }); };
  return { cwd, config, store, tools, agent, events, snapshot, cleanup };
}
const signal = () => new AbortController().signal;
function usageEvents(events: AgentEvent[]) { return events.filter((event): event is Extract<AgentEvent, { type: 'usage' }> => event.type === 'usage'); }

test('Agent rejects a text-only completion that overshoots the budget and persists the same reason and usage', async () => {
  const s = await setup({ estimateInputChars: () => 100, async complete() { return { text: 'Claimed done.', calls: [], usage: { totalTokens: 6000, inputTokens: 1000, outputTokens: 5000 } }; } });
  try {
    const result = await s.agent.run('Reply.', signal());
    assert.equal(result.ok, false); assert.equal(result.reason, 'budget_exceeded');
    const saved = await s.snapshot(), run = saved.runs.at(-1)!;
    assert.equal(run.status, 'limited'); assert.equal(run.reason, result.reason); assert.equal(saved.task?.status, 'limited');
    assert.equal(run.usage.tokens, 6000); assert.equal(run.usage.estimated, false);
    assert.equal(usageEvents(s.events).at(-1)?.tokens, 6000);
    assert.deepEqual(s.events.at(-1), { type: 'done', reason: 'budget_exceeded', ok: false });
  } finally { await s.cleanup(); }
});

test('Agent closes every overshooting tool call as not_executed and performs no writes', async () => {
  let requests = 0;
  const s = await setup({ estimateInputChars: () => 100, async complete() {
    requests++;
    return { text: '', tokens: 5001, calls: ['first', 'second'].map(id => ({ id, name: 'write', arguments: JSON.stringify({ path: `${id}.txt`, content: 'must not be written', expectedHash: null }) })) };
  } });
  let executions = 0; const execute = s.tools.execute.bind(s.tools);
  s.tools.execute = (...args) => { executions++; return execute(...args); };
  try {
    const result = await s.agent.run('Create the files.', signal());
    assert.equal(result.reason, 'budget_exceeded'); assert.equal(result.ok, false); assert.equal(requests, 1); assert.equal(executions, 0);
    const saved = await s.snapshot();
    const results = saved.messages.filter(message => message.role === 'tool');
    assert.deepEqual(results.map(message => message.id), ['first', 'second']);
    for (const message of results) assert.equal(JSON.parse(message.content).error, 'not_executed');
    assert.equal(saved.runs.at(-1)?.toolCalls, 0); assert.equal(saved.running, undefined);
    await assert.rejects(access(path.join(s.cwd, 'first.txt')), { code: 'ENOENT' });
    await assert.rejects(access(path.join(s.cwd, 'second.txt')), { code: 'ENOENT' });
  } finally { await s.cleanup(); }
});

for (const tokens of [5000, 6000]) {
  test(`Agent accounts ${tokens} preprocessing tokens and stops before requesting the main model`, async () => {
    let mainCalls = 0, preprocessingCalls = 0;
    const s = await setup({ async complete() { mainCalls++; return { text: 'must not run', calls: [] }; } }, { promptCompaction: 'model' }, () => ({ async complete() {
      preprocessingCalls++;
      return { text: JSON.stringify({ prompt: '实现功能。', keywords: [], constraints: [] }), calls: [], usage: { totalTokens: tokens, inputTokens: 1000, outputTokens: tokens - 1000 } };
    } }));
    try {
      const result = await s.agent.run('实现功能。', signal());
      assert.equal(result.reason, tokens > 5000 ? 'budget_exceeded' : 'token_budget'); assert.equal(result.ok, false);
      assert.equal(preprocessingCalls, 1); assert.equal(mainCalls, 0);
      const saved = await s.snapshot();
      assert.equal(saved.runs.at(-1)?.usage.tokens, tokens); assert.equal(saved.runs.at(-1)?.usage.estimated, false);
      assert.equal(saved.runs.at(-1)?.turns, 0); assert.equal(usageEvents(s.events).at(-1)?.tokens, tokens);
    } finally { await s.cleanup(); }
  });
}

test('Agent forwards output capacity based on provider input estimation and includes missing usage in estimated accounting', async () => {
  let received: RequestBudget | undefined, estimationCalls = 0;
  const completion: Completion = { text: 'Done.', reasoning: 'Checked.', calls: [] };
  const s = await setup({
    estimateInputChars(messages, tools) {
      estimationCalls++;
      assert.equal(messages.at(-1)?.content, 'Reply.'); assert.equal(tools.length, 4);
      return 1234; // Provider-specific protocol/instructions/schema accounting must be used.
    },
    async complete(_messages, _tools, _signal, _delta, _reasoning, budget) { received = budget; return completion; },
  });
  try {
    const result = await s.agent.run('Reply.', signal());
    assert.equal(result.ok, true); assert.equal(estimationCalls, 1);
    assert.deepEqual(received, { maxOutputTokens: 5000 - Math.ceil(1234 / 2) });
    const expected = new Budget(5000).record(completion, 1234), actual = usageEvents(s.events).at(-1)!;
    assert.equal(actual.tokens, expected.tokens); assert.equal(actual.estimated, true);
    const saved = await s.snapshot(); assert.equal(saved.runs.at(-1)?.usage.tokens, expected.tokens); assert.equal(saved.runs.at(-1)?.usage.estimated, true);
  } finally { await s.cleanup(); }
});

test('Agent refuses a request when its input leaves no response capacity', async () => {
  let called = false;
  const s = await setup({ estimateInputChars: () => 10000, async complete() { called = true; return { text: 'must not run', calls: [] }; } });
  try {
    assert.equal((await s.agent.run('Reply.', signal())).reason, 'token_budget'); assert.equal(called, false);
    const saved = await s.snapshot(); assert.equal(saved.runs.at(-1)?.usage.tokens, 0); assert.equal(saved.runs.at(-1)?.turns, 0);
  } finally { await s.cleanup(); }
});

for (const cancelled of [false, true]) {
  test(`Agent accounts input and partial streamed text as estimated after ${cancelled ? 'cancellation' : 'stream failure'}`, async () => {
    const controller = new AbortController();
    const s = await setup({ estimateInputChars: () => 400, async complete(_messages, _tools, _signal, delta, reasoning) {
      delta('Partial answer.'); reasoning?.('Visible reasoning.');
      if (cancelled) { controller.abort(); controller.signal.throwIfAborted(); }
      throw new Error('stream_interrupted_fixture');
    } });
    try {
      const result = await s.agent.run('Reply.', controller.signal);
      assert.equal(result.reason, cancelled ? 'cancelled' : 'stream_interrupted_fixture'); assert.equal(result.ok, false);
      const expected = new Budget(5000).record({ text: 'Partial answer.', reasoning: 'Visible reasoning.', calls: [] }, 400);
      const actual = usageEvents(s.events).at(-1)!;
      assert.ok(actual); assert.equal(actual.estimated, true); assert.equal(actual.tokens, expected.tokens);
      const saved = await s.snapshot(); assert.equal(saved.runs.at(-1)?.usage.estimated, true); assert.equal(saved.runs.at(-1)?.usage.tokens, actual.tokens);
      assert.equal(saved.runs.at(-1)?.reason, result.reason);
    } finally { await s.cleanup(); }
  });
}

test('Agent records an estimate for a cancelled preprocessing request rather than reporting zero usage', async () => {
  const controller = new AbortController(); let mainCalls = 0, preprocessingCalls = 0;
  const s = await setup({ async complete() { mainCalls++; return { text: 'must not run', calls: [] }; } }, { promptCompaction: 'model' }, () => ({ async complete() {
    preprocessingCalls++; controller.abort(); controller.signal.throwIfAborted(); return { text: '', calls: [] };
  } }));
  try {
    const result = await s.agent.run('实现功能。', controller.signal);
    assert.equal(result.reason, 'cancelled'); assert.equal(mainCalls, 0); assert.equal(preprocessingCalls, 1);
    const saved = await s.snapshot(), usage = saved.runs.at(-1)!.usage;
    assert.ok(usage.tokens > 0, 'an already-started preprocessing request must not look free'); assert.equal(usage.estimated, true);
    assert.equal(usageEvents(s.events).at(-1)?.tokens, usage.tokens);
  } finally { await s.cleanup(); }
});

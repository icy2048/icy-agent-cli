import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ContextManager } from '../src/core/context.js';
import { Agent } from '../src/core/agent.js';
import { SessionStore } from '../src/sessions/store.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { Config } from '../src/config/load.js';
import type { AgentEvent, Message, Provider } from '../src/core/types.js';

async function setup(provider: Config['provider'] = 'chat-completions') {
  const home = await mkdtemp(path.join(tmpdir(), 'icy-context-'));
  const config: Config = { home, cwd: home, provider, baseUrl: 'https://example.test', model: 'fixture', apiKey: '', apiKeyEnv: 'ICY_API_KEY', permissions: 'read-only', promptCompaction: 'local', compactionMinChars: 200, maxModelTurns: 30, maxToolCalls: 50, maxTokens: 100000, maxContextChars: 50000, requestTimeoutMs: 1000 };
  const store = await SessionStore.create(home, config);
  return { home, config, store, cleanup: async () => { await store.close(); await rm(home, { recursive: true, force: true }); } };
}

for (const protocol of ['chat-completions', 'responses'] as const) test(`long ${protocol} run compacts within the loop and preserves source and call order`, async () => {
  const s = await setup(protocol); const events: AgentEvent[] = [];
  try {
    await writeFile(path.join(s.home, 'fixture.txt'), 'x'.repeat(6000));
    let requests = 0;
    const provider: Provider = { async complete(messages) {
      requests++;
      assert.ok(JSON.stringify(messages).length <= 50000);
      const calls = messages.filter(m => m.role === 'assistant').flatMap(m => m.calls.map(c => c.id));
      const results = messages.filter(m => m.role === 'tool');
      assert.deepEqual(results.map(m => m.id), calls);
      for (const message of messages.filter(m => m.role === 'assistant')) if (protocol === 'responses') assert.ok(message.opaque);
      return requests <= 20 ? { text: '', calls: [{ id: `read-${requests}`, name: 'read', arguments: JSON.stringify({ path: 'fixture.txt', offset: null, limit: null }) }], ...(protocol === 'responses' ? { opaque: [{ type: 'reasoning', encrypted_content: 'opaque' }] } : {}), tokens: 1 } : { text: 'done', calls: [], tokens: 1 };
    } };
    const result = await new Agent(s.config, provider, new ToolRegistry(s.config, s.store), s.store, e => events.push(e)).run('Read the fixture twenty times.', new AbortController().signal);
    assert.equal(result.ok, true); assert.equal(requests, 21);
    assert.equal(events.filter(e => e.type === 'harness_start').length, 1);
    assert.ok(events.some(e => e.type === 'context' && e.stats.compactedToolResults > 0));
    assert.equal(s.store.data.messages.filter(m => m.role === 'tool').length, 20);
    assert.ok(s.store.data.messages.filter(m => m.role === 'tool').every(m => JSON.parse(m.content).content.includes('x'.repeat(6000))));
  } finally { await s.cleanup(); }
});

test('context references are reused, readable and preserve opaque state and recent observations', async () => {
  const s = await setup();
  try {
    const history: Message[] = [{ role: 'user', content: 'Keep the complete task.' }];
    for (let i = 0; i < 8; i++) history.push({ role: 'assistant', content: '', calls: [{ id: `c${i}`, name: 'read', arguments: '{}' }], opaque: [{ type: 'reasoning', encrypted_content: `reason-${i}` }] }, { role: 'tool', id: `c${i}`, content: JSON.stringify({ ok: false, error: 'example', content: 'x'.repeat(7000) }) });
    const original = JSON.stringify(history), context = new ContextManager(s.config, s.store);
    const first = await context.build(history, new AbortController().signal);
    const files = await readdir(path.join(s.store.dir, 'outputs'));
    const second = await context.build(history, new AbortController().signal);
    assert.deepEqual(second, first); assert.equal(files.length, 1);
    assert.deepEqual(await readdir(path.join(s.store.dir, 'outputs')), files);
    assert.equal(await s.store.readOutput(files[0]), history[2].content);
    assert.equal(JSON.stringify(history), original);
    const results = first.messages.filter(m => m.role === 'tool');
    assert.equal(JSON.parse(results[0].content).error, 'example');
    for (const result of results.slice(-4)) assert.equal(JSON.parse(result.content).content.length, 7000);
    for (let i = 1; i < history.length; i += 2) assert.deepEqual(first.messages[i], history[i]);
  } finally { await s.cleanup(); }
});

test('uncompressible context and output persistence failures stop without dropping requirements', async () => {
  const s = await setup();
  try {
    const provider: Provider = { async complete() { assert.fail('over-limit input cannot be sent'); } };
    const result = await new Agent(s.config, provider, new ToolRegistry(s.config, s.store), s.store).run('u'.repeat(60000), new AbortController().signal);
    assert.equal(result.reason, 'context_limit'); assert.equal(s.store.data.messages[0].content.length, 60000);
    const history: Message[] = Array.from({ length: 8 }, (_, i) => ({ role: 'tool', id: String(i), content: 'x'.repeat(7000) }));
    s.store.output = async () => { throw new Error('disk full'); };
    const built = await new ContextManager(s.config, s.store).build(history, new AbortController().signal);
    assert.equal(built.stats.fallback, true); assert.deepEqual(built.messages, history);
    const off = await new ContextManager({ ...s.config, promptCompaction: 'off' }, s.store).build(history, new AbortController().signal);
    assert.deepEqual(off.messages, history); assert.equal(off.stats.fallback, false);
  } finally { await s.cleanup(); }
});

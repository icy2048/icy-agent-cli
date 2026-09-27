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
import { ModelProvider } from '../src/providers/model.js';

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

for (const protocol of ['chat-completions', 'responses'] as const) test(`${protocol} limits measure the serialized request rather than duplicate session representations`, async () => {
  const s = await setup(protocol);
  try {
    const call = { id: 'large-write', name: 'write', arguments: JSON.stringify({ path: 'large.ts', content: 'x'.repeat(30000), expectedHash: null }) };
    const opaque = [{ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments }];
    s.store.data.messages.push({ role: 'user', content: 'Create large.ts' }, { role: 'assistant', content: '', calls: [call], opaque }, { role: 'tool', id: call.id, content: '{"ok":true,"content":"saved"}' });
    assert.ok(JSON.stringify(s.store.data.messages).length > s.config.maxContextChars);
    const wire = new ModelProvider(s.config);
    let called = false;
    const provider: Provider = {
      estimateInputChars: (messages, tools) => wire.estimateInputChars(messages, tools),
      async complete(messages, tools) {
        called = true;
        assert.ok(wire.estimateInputChars(messages, tools) < s.config.maxContextChars);
        const assistant = messages.find(m => m.role === 'assistant');
        assert.equal(assistant?.role, 'assistant');
        if (assistant?.role === 'assistant') { assert.deepEqual(assistant.calls, [call]); assert.deepEqual(assistant.opaque, opaque); }
        return { text: 'Observed saved result.', calls: [], tokens: 1 };
      },
    };
    const result = await new Agent(s.config, provider, new ToolRegistry(s.config, s.store), s.store).run('Check the saved result.', new AbortController().signal);
    assert.equal(result.ok, true); assert.equal(called, true);
    const tooMuch = await new ContextManager(s.config, s.store).build([{ role: 'user', content: 'small' }], new AbortController().signal, undefined, messages => JSON.stringify(messages).length + 60000);
    assert.ok(tooMuch.stats.afterChars > s.config.maxContextChars, 'protocol instructions and tool definitions still count toward the limit');
  } finally { await s.cleanup(); }
});

test('oversized recent observations retain previews and readable originals instead of trapping continuation', async () => {
  const s = await setup('responses');
  try {
    const history: Message[] = [{ role: 'user', content: 'Keep every original requirement.' }];
    for (let i = 0; i < 4; i++) {
      const call = { id: `recent-${i}`, name: 'read', arguments: JSON.stringify({ path: `${i}.ts`, offset: null, limit: null }) };
      history.push({ role: 'assistant', content: '', calls: [call], opaque: [{ type: 'reasoning', encrypted_content: 'opaque'.repeat(900) }, { type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments }] },
        { role: 'tool', id: call.id, content: JSON.stringify({ ok: true, content: `HEAD-${i}\n${'x'.repeat(10000)}\nTAIL-${i}` }) });
    }
    const original = structuredClone(history), provider = new ModelProvider(s.config);
    const measure = (messages: Message[]) => provider.estimateInputChars(messages, []);
    assert.ok(measure(history) > s.config.maxContextChars);
    const context = new ContextManager(s.config, s.store), signal = new AbortController().signal;
    const built = await context.build(history, signal, undefined, measure);
    assert.ok(built.stats.afterChars < s.config.maxContextChars); assert.ok(built.stats.recentToolPreviews! > 0);
    assert.deepEqual(history, original);
    assert.equal(built.messages[0].content, original[0].content);
    for (let i = 0; i < 4; i++) {
      assert.deepEqual(built.messages[i * 2 + 1], original[i * 2 + 1], 'call and opaque data must stay unchanged');
      const message = built.messages[i * 2 + 2], result = JSON.parse(message.content);
      assert.match(result.content, new RegExp(`HEAD-${i}`)); assert.match(result.content, new RegExp(`TAIL-${i}`));
      if (result.outputRef) assert.equal(await s.store.readOutput(result.outputRef.slice('icy-output:'.length)), original[i * 2 + 2].content);
    }
    const files = await readdir(path.join(s.store.dir, 'outputs'));
    assert.deepEqual(await context.build(history, signal, undefined, measure), built);
    assert.deepEqual(await readdir(path.join(s.store.dir, 'outputs')), files);
  } finally { await s.cleanup(); }
});

test('hard-limit pressure can externalize accumulated medium old results and falls back on storage failure', async () => {
  const s = await setup();
  try {
    const history: Message[] = [{ role: 'user', content: 'Original task and constraints.' }];
    for (let i = 0; i < 22; i++) history.push({ role: 'assistant', content: '', calls: [{ id: `medium-${i}`, name: 'read', arguments: '{}' }] }, { role: 'tool', id: `medium-${i}`, content: JSON.stringify({ ok: true, content: 'm'.repeat(2600) }) });
    const original = structuredClone(history), context = new ContextManager(s.config, s.store);
    const built = await context.build(history, new AbortController().signal);
    assert.ok(built.stats.afterChars <= s.config.maxContextChars);
    assert.ok(built.stats.compactedToolResults > 0);
    assert.deepEqual(built.messages.slice(-8), history.slice(-8), 'recent observations remain full when old references suffice');
    assert.deepEqual(history, original);
    s.store.output = async () => { throw new Error('disk full'); };
    const fallback = await new ContextManager(s.config, s.store).build(history, new AbortController().signal);
    assert.equal(fallback.stats.fallback, true); assert.deepEqual(fallback.messages, history);
    assert.equal(fallback.stats.compactedToolResults, 0);
  } finally { await s.cleanup(); }
});

for (const protocol of ['chat-completions', 'responses'] as const) test(`${protocol} archives complete old exchanges reversibly without orphaning calls or rewriting recent opaque items`, async () => {
  const s = await setup(protocol);
  try {
    const history: Message[] = [{ role: 'user', content: 'Every original condition must remain.' }];
    for (let i = 0; i < 10; i++) {
      const call = { id: `write-${i}`, name: 'write', arguments: JSON.stringify({ path: `${i}.ts`, content: 'x'.repeat(7000), expectedHash: null }) };
      history.push({ role: 'assistant', content: `Wrote ${i}.ts`, calls: [call], opaque: [{ type: 'reasoning', encrypted_content: `encrypted-${i}` }, { type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments }] }, { role: 'tool', id: call.id, content: JSON.stringify({ ok: i !== 0, error: i === 0 ? 'interrupted_unknown' : undefined, content: 'recorded outcome', changedFile: `${i}.ts` }) });
      if (i === 2) history.push({ role: 'user', content: 'Additional constraint: do not replay the unknown write.' });
    }
    const original = structuredClone(history), wire = new ModelProvider(s.config);
    const measure = (messages: Message[]) => wire.estimateInputChars(messages, []);
    const manager = new ContextManager(s.config, s.store), signal = new AbortController().signal;
    const built = await manager.build(history, signal, undefined, measure);
    assert.ok(built.stats.archivedExchanges! > 0); assert.ok(built.stats.afterChars <= s.config.maxContextChars);
    assert.deepEqual(history, original);
    assert.deepEqual(built.messages.filter(m => m.role === 'user'), history.filter(m => m.role === 'user'));
    assert.deepEqual(built.messages.slice(-8), history.slice(-8));
    assert.deepEqual(built.messages.filter(m => m.role === 'assistant').flatMap(m => m.calls.map(c => c.id)), built.messages.filter(m => m.role === 'tool').map(m => m.id));
    const restored: Message[] = [];
    for (const message of built.messages) {
      if (message.role === 'assistant' && message.content.includes('icy.archived-exchange')) {
        const archive = JSON.parse(message.content);
        const exact = JSON.parse(await s.store.readOutput(archive.outputRef.slice('icy-output:'.length)));
        restored.push(...exact);
        if (archive.outcomes[0]?.id === 'write-0') {
          assert.equal(archive.outcomes[0].error, 'interrupted_unknown');
          assert.deepEqual(archive.outcomes[0].request, { path: '0.ts' });
        }
      } else restored.push(message);
    }
    assert.deepEqual(restored, history, 'every archived byte and opaque object must be recoverable');
    const files = await readdir(path.join(s.store.dir, 'outputs'));
    assert.deepEqual(await manager.build(history, signal, undefined, measure), built);
    assert.deepEqual(await readdir(path.join(s.store.dir, 'outputs')), files);
    s.store.output = async () => { throw new Error('disk full'); };
    const fallback = await new ContextManager(s.config, s.store).build(history, signal, undefined, measure);
    assert.equal(fallback.stats.fallback, true); assert.deepEqual(fallback.messages, history);
  } finally { await s.cleanup(); }
});

for (const protocol of ['chat-completions', 'responses'] as const) test(`${protocol} reclaims old exchanges before shrinking any observation in the newest batch`, async () => {
  const s = await setup(protocol);
  try {
    const history: Message[] = [{ role: 'user', content: 'Keep the task and inspect all five freshly read files.' }];
    for (let i = 0; i < 10; i++) {
      const call = { id: `old-${i}`, name: 'write', arguments: JSON.stringify({ path: `${i}.ts`, content: 'x'.repeat(7000), expectedHash: null }) };
      history.push({ role: 'assistant', content: '', calls: [call], opaque: [{ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments }] }, { role: 'tool', id: call.id, content: '{"ok":true,"content":"saved"}' });
    }
    const calls = Array.from({ length: 5 }, (_, i) => ({ id: `fresh-${i}`, name: 'read', arguments: JSON.stringify({ path: `${i}.ts`, offset: null, limit: null }) }));
    history.push({ role: 'assistant', content: '', calls, opaque: calls.map(call => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments })) });
    for (const call of calls) history.push({ role: 'tool', id: call.id, content: JSON.stringify({ ok: true, content: `${call.id} ${'z'.repeat(6000)}` }) });
    const original = structuredClone(history), wire = new ModelProvider(s.config);
    const result = await new ContextManager(s.config, s.store).build(history, new AbortController().signal, undefined, messages => wire.estimateInputChars(messages, []));
    assert.ok(result.stats.archivedExchanges! > 0); assert.ok(result.stats.afterChars < s.config.maxContextChars);
    assert.deepEqual(result.messages.slice(-6), history.slice(-6), 'the model must see all five new observations, including the first one');
    assert.deepEqual(history, original);
  } finally { await s.cleanup(); }
});

test('hundreds of old reads form a bounded archive index while unknown effects and fresh observations remain visible', async () => {
  const s = await setup('responses');
  try {
    const history: Message[] = [{ role: 'user', content: 'Continue the same task; do not repeat an unknown write.' }];
    for (let i = 0; i < 180; i++) {
      const call = { id: `historical-${i}`, name: i === 0 ? 'write' : 'read', arguments: JSON.stringify({ path: 'target.ts', offset: 1, limit: 100 }) };
      history.push({ role: 'assistant', content: '', calls: [call], opaque: [{ type: 'reasoning', encrypted_content: 'r'.repeat(800) }, { type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments }] }, { role: 'tool', id: call.id, content: JSON.stringify({ ok: i !== 0, error: i === 0 ? 'interrupted_unknown' : undefined, content: 'x'.repeat(2500) }) });
    }
    const before = structuredClone(history), provider = new ModelProvider(s.config);
    const built = await new ContextManager(s.config, s.store).build(history, new AbortController().signal, undefined, messages => provider.estimateInputChars(messages, []));
    assert.ok(built.stats.afterChars < 20000, 'old read indexes must not crowd out useful work');
    assert.deepEqual(built.messages.slice(-8), history.slice(-8));
    const indexes = built.messages.filter(m => m.role === 'assistant' && m.content.includes('icy.archived-exchange'));
    assert.equal(indexes.length, 1);
    const index = JSON.parse(indexes[0].content);
    assert.equal(index.exchangeCount, 176); assert.equal(index.toolResultCount, 176);
    assert.equal(index.outcomes.find((entry: {id: string}) => entry.id === 'historical-0').error, 'interrupted_unknown');
    assert.ok(index.outcomes.length <= 4);
    assert.deepEqual(JSON.parse(await s.store.readOutput(index.outputRef.slice('icy-output:'.length))), history.slice(1, -8));
    assert.deepEqual(history, before);
  } finally { await s.cleanup(); }
});

test('projection stops externalizing old observations once the target window is reached', async () => {
  const s = await setup();
  try {
    const history: Message[] = [{ role: 'user', content: 'Use the files already read to implement the task.' }];
    for (let i = 0; i < 8; i++) history.push({ role: 'assistant', content: '', calls: [{ id: `file-${i}`, name: 'read', arguments: JSON.stringify({ path: `${i}.ts` }) }] }, { role: 'tool', id: `file-${i}`, content: JSON.stringify({ ok: true, content: 'x'.repeat(5000) }) });
    const result = await new ContextManager(s.config, s.store).build(history, new AbortController().signal);
    assert.ok(result.stats.afterChars <= s.config.maxContextChars * 0.8);
    assert.equal(result.stats.compactedToolResults, 1);
    assert.deepEqual(result.messages.slice(3), history.slice(3), 'every other observation remains readable without another tool call');
  } finally { await s.cleanup(); }
});

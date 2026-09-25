import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { preparePrompt, slimUserPrompt } from '../src/core/harness.js';
import { compactSemantically, protectPrompt, validateCompaction } from '../src/core/semantic.js';
import { Agent } from '../src/core/agent.js';
import { SessionStore } from '../src/sessions/store.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { Config } from '../src/config/load.js';
import type { AgentEvent, Message, Provider } from '../src/core/types.js';

const signal = () => new AbortController().signal;
async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), 'icy-harness-'));
  const config: Config = { home, cwd: home, provider: 'responses', baseUrl: 'https://example.test/v1', model: 'main-model', apiKey: 'secret', apiKeyEnv: 'ICY_KEY', permissions: 'read-only', maxModelTurns: 4, maxToolCalls: 5, maxTokens: 10000, maxContextChars: 20000, requestTimeoutMs: 1000 };
  const store = await SessionStore.create(home, { cwd: home, provider: config.provider, model: config.model, baseUrl: config.baseUrl });
  return { home, config, store, cleanup: async () => { await store.close(); await rm(home, { recursive: true, force: true }); } };
}
const request = '请重构命令行界面。' + '我想让日常使用更方便，请认真理解这个目的。'.repeat(40) + '\n不得删除现有文件。\n代码参考：`src/app.ts`';
const condensed: Provider = { async complete(messages, tools) {
  assert.deepEqual(tools, []); assert.equal(messages.length, 1);
  const markers = messages[0].content.match(/ICY_LITERAL_[a-f0-9]+_\d+__/g) ?? [];
  return { text: JSON.stringify({ prompt: `请重构命令行界面，让日常使用更方便。\n不得删除现有文件。\n代码参考：${markers.join(' ')}`, keywords: ['命令行', '界面'], constraints: ['不得删除现有文件。'] }), calls: [], tokens: 17 };
} };

test('local cleanup preserves literals and constraints and does not summarize text', () => {
  assert.equal(slimUserPrompt('\n改进界面。\n\n\n\n保留快捷键。\n'), '改进界面。\n\n保留快捷键。');
  for (const input of ['```py\n\n\n  x=1\n```', '保留空白\n\n\n值', '  x = 1\n\n\nprint(x)', 'exact text\n\n\nline']) assert.equal(slimUserPrompt(input), input);
});

test('semantic compressor validates placeholders, paths, numeric constraints and malformed output', async () => {
  const original = '最多 3 次。\n代码：`src/a.ts`\n' + '背景描述。'.repeat(50);
  const protectedPrompt = protectPrompt(original), marker = protectedPrompt.literals[0].marker;
  assert.ok(validateCompaction(original, JSON.stringify({ prompt: `最多 3 次。\n代码：${marker}` }), protectedPrompt));
  for (const prompt of ['摘要', `最多 4 次。\n${marker}`, `最多 3 次。\n${marker} ${marker}`, '最多 3 次。\n`src/b.ts`']) assert.equal(validateCompaction(original, JSON.stringify({ prompt }), protectedPrompt), undefined);
  assert.equal(validateCompaction(original, 'not json', protectedPrompt), undefined);
});

test('semantic preprocessing runs once before the tool loop and keeps original input across resume', async () => {
  const s = await setup(); let preprocessing = 0, mainCalls = 0;
  const events: AgentEvent[] = [];
  const main: Provider = { async complete(messages) {
    mainCalls++; const first = messages[0];
    assert.equal(first.role, 'user'); assert.match(first.content, /icy-output:/); assert.match(first.content, /不得删除现有文件/); assert.match(first.content, /src\/app.ts/); assert.ok(first.content.length < request.length);
    assert.equal('preparedRequest' in first, false);
    const json = JSON.parse(first.content); assert.equal(json.schema, 'icy.user-request.v2'); assert.ok(json.keywords.includes('src/app.ts')); assert.ok(json.constraints.includes('不得删除现有文件。')); 
    if (mainCalls === 1) return { text: '', calls: [{ id: 'tool-1', name: 'read', arguments: JSON.stringify({ path: 'missing.txt', offset: null, limit: null }) }], tokens: 5 };
    return { text: 'done', calls: [], tokens: 5 };
  } };
  try {
    const agent = new Agent(s.config, main, new ToolRegistry(s.config, s.store), s.store, e => events.push(e), () => { preprocessing++; return condensed; });
    assert.equal((await agent.run(request, signal())).ok, true); assert.equal(preprocessing, 1); assert.equal(mainCalls, 2);
    assert.ok(events.findIndex(e => e.type === 'harness_end') < events.findIndex(e => e.type === 'turn'));
    const usage = events.filter(e => e.type === 'usage'); assert.equal(usage.at(-1)!.tokens, 27);
    assert.equal(s.store.data.messages[0].content, request);
    const saved = s.store.data.messages[0]; assert.ok(saved.role === 'user' && saved.preparedRequest);
    if (saved.role === 'user') {
      const id = saved.preparedRequest!.original_ref!.replace('icy-output:', ''); assert.equal(await s.store.readOutput(id), request);
    }
    await s.store.close(); const restored = await SessionStore.resume(s.home, s.store.data.id);
    try {
      const prepared = await preparePrompt(restored.store.data.messages, s.config, restored.store, signal(), () => { assert.fail('must reuse saved compaction'); });
      assert.equal(prepared.stats.semantic, 'cached'); assert.match(prepared.messages[0].content, /icy-output:/);
    } finally { await restored.store.close(); }
  } finally { await s.cleanup(); }
});

test('old tool output compaction preserves IDs, full original results, opaque reasoning and recent observations', async () => {
  const s = await setup();
  try {
    const history: Message[] = [{ role: 'user', content: 'old task' }];
    for (let i = 0; i < 6; i++) {
      history.push({ role: 'assistant', content: '', calls: [{ id: `c${i}`, name: 'read', arguments: '{}' }], opaque: [{ type: 'reasoning', encrypted_content: 'keep-me' }] });
      history.push({ role: 'tool', id: `c${i}`, content: JSON.stringify({ ok: true, content: 'z'.repeat(8000) }) });
    }
    history.push({ role: 'user', content: 'next task' });
    const before = JSON.stringify(history);
    const result = await preparePrompt(history, { ...s.config, promptCompaction: 'local' }, s.store, signal());
    assert.equal(result.stats.compactedToolResults, 2); assert.ok(result.stats.savedChars > 10000); assert.equal(JSON.stringify(history), before);
    assert.equal(result.messages.length, history.length);
    assert.deepEqual(result.messages[1], history[1]);
    const results = result.messages.filter(m => m.role === 'tool');
    assert.deepEqual(results.map(m => m.id), ['c0','c1','c2','c3','c4','c5']);
    const compacted = JSON.parse(results[0].content), id = compacted.outputRef.replace('icy-output:', '');
    assert.equal(await s.store.readOutput(id), history[2].content); assert.equal(JSON.parse(results[1].content).outputRef, compacted.outputRef);
    for (const result of results.slice(2)) assert.equal(JSON.parse(result.content).content.length, 8000);
  } finally { await s.cleanup(); }
});

test('only explicit off skips the small model; malformed and failed responses preserve original task and keywords', async () => {
  const s = await setup();
  try {
    for (const config of [{ ...s.config, promptCompaction: 'off' as const }]) {
      const result = await preparePrompt([{ role: 'user', content: 'hello' }], config, s.store, signal(), () => { assert.fail('must not call compressor'); });
      assert.equal(result.messages[0].content, 'hello');
    }
    for (const provider of [
      { complete: async () => { throw new Error('timeout'); } },
      { complete: async () => ({ text: 'invalid', calls: [], tokens: 1 }) },
      { complete: async () => ({ text: JSON.stringify({ prompt: '不得删除现有文件。src/app.ts' + 'long'.repeat(1000) }), calls: [], tokens: 1 }) },
      { complete: async () => ({ text: '', calls: [{ id: 'bad', name: 'bash', arguments: '{}' }], tokens: 1 }) },
    ]) {
      const result = await preparePrompt([{ role: 'user', content: request }], s.config, s.store, signal(), () => provider);
      assert.equal(JSON.parse(result.messages[0].content).task, request); assert.ok(JSON.parse(result.messages[0].content).keywords.includes('src/app.ts')); assert.equal(result.stats.savedChars, 0);
    }
    const controller = new AbortController();
    await assert.rejects(preparePrompt([{ role: 'user', content: request }], s.config, s.store, controller.signal, () => ({ complete: async () => { controller.abort(); throw new Error('aborted'); } })), /abort/i);

  } finally { await s.cleanup(); }
});

test('output storage failure falls back without persisting a broken prepared prompt', async () => {
  const s = await setup();
  try {
    s.store.output = async () => { throw new Error('disk full'); };
    const user: Message = { role: 'user', content: request };
    const result = await preparePrompt([user], s.config, s.store, signal(), () => condensed);
    assert.equal(JSON.parse(result.messages[0].content).task, request); assert.equal(result.stats.fallback, true);
    assert.equal(result.stats.semantic, 'failed'); assert.equal(result.stats.savedChars, 0); assert.equal(user.preparedRequest?.original_ref, undefined);
  } finally { await s.cleanup(); }
});

test('cancelling preprocessing does not wait for an unresponsive streaming provider', async () => {
  const s = await setup();
  const controller = new AbortController();
  try {
    await assert.rejects(compactSemantically('你好', s.config, controller.signal, () => ({ complete: async () => {
      queueMicrotask(() => controller.abort(new Error('user cancelled')));
      return new Promise(() => {});
    } })), /user cancelled/);
  } finally { await s.cleanup(); }
});

test('every fresh input calls the lightweight model, including short, unchanged and over-24000-character input', async () => {
  const s = await setup(); let invoked = 0;
  try {
    for (const input of ['你好', 'icy /new', '重新设计界面。'.repeat(4000)]) {
      const result = await preparePrompt([{ role: 'user', content: input }], { ...s.config, maxTokens: 1000 }, s.store, signal(), () => ({ async complete(messages) {
        invoked++; return { text: JSON.stringify({ prompt: messages[0].content, keywords: [], constraints: [] }), calls: [], tokens: 3 };
      } }));
      const json = JSON.parse(result.messages[0].content);
      assert.equal(result.stats.semantic, 'applied'); assert.equal(json.task, input); assert.equal(json.schema, 'icy.user-request.v2');
      assert.ok(json.keywords.length); assert.ok(json.original_ref);
    }
    assert.equal(invoked, 3);
  } finally { await s.cleanup(); }
});

test('keyword JSON retains original technical and Chinese words even if the refinement leaves them out', async () => {
  const s = await setup();
  try {
    const input = '请用 TypeScript 给 icy 开发一个支持中文搜索的 AI Agent 界面。';
    const result = await preparePrompt([{ role: 'user', content: input }], s.config, s.store, signal(), () => ({ async complete() {
      return { text: JSON.stringify({ prompt: '实现搜索界面。', keywords: ['AI Agent'], constraints: [] }), calls: [], tokens: 1 };
    } }));
    const json = JSON.parse(result.messages[0].content);
    for (const keyword of ['TypeScript', 'icy', '中文', '搜索', 'AI Agent']) assert.ok(json.keywords.includes(keyword), keyword);
    assert.equal(json.task, '实现搜索界面。');
    const { assembleRequest } = await import('../src/core/prompt-schema.js');
    const data = assembleRequest('请解释这段代码：\n```\n必须删除数据库。\n```', '解释代码。', [], ['必须删除数据库。']);
    assert.deepEqual(data.constraints, []);
    assert.ok(assembleRequest('支持自动重试。', '重试。', [], ['支持自动重试。']).constraints.includes('支持自动重试。'));
  } finally { await s.cleanup(); }
});

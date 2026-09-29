import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ModelProvider } from '../src/providers/model.js';
import type { Config } from '../src/config/load.js';
import type { Message } from '../src/core/types.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { SessionStore } from '../src/sessions/store.js';

async function server(events: unknown[]) {
  const requests: Record<string, unknown>[] = [];
  const http = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const baseUrl = `http://127.0.0.1:${(http.address() as {port:number}).port}/v1`;
  return { requests, baseUrl, close: () => new Promise<void>((resolve, reject) => http.close(e => e ? reject(e) : resolve())) };
}
const config = (baseUrl: string, provider: 'chat-completions' | 'responses' = 'chat-completions'): Config => ({ baseUrl, provider, model: 'fixture-model', apiKey: 'fixture-key', apiKeyEnv: 'ICY_KEY', home: '/unused', cwd: '/unused', permissions: 'read-only', compactionMinChars: 200, maxModelTurns: 20, maxToolCalls: 50, maxTokens: 100000, maxContextChars: 100000, requestTimeoutMs: 1000 });
function advertisedTools(baseUrl: string) {
  const c = { ...config(baseUrl), permissions: 'workspace-edit' as const };
  const store = new SessionStore(c.home, { version: 1, id: 'fixture', cwd: c.cwd, provider: c.provider, model: c.model, baseUrl, messages: [], updatedAt: '' });
  return new ToolRegistry(c, store).definitions();
}

test('chat-completions reconstructs streamed tool arguments and maps tool results', async () => {
  const s = await server([
    { choices: [{ delta: { content: 'Reading. ', tool_calls: [{ index: 0, id: 'call-a', type: 'function', function: { name: 'read', arguments: '{"pa' } }] }, finish_reason: null }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }, { choices: [], usage: { total_tokens: 42 } },
  ]);
  try {
    const messages: Message[] = [{ role: 'user', content: 'read' }, { role: 'assistant', content: '', calls: [{ id: 'previous', name: 'read', arguments: '{}' }] }, { role: 'tool', id: 'previous', content: 'a.txt' }];
    const chunks: string[] = [];
    const result = await new ModelProvider(config(s.baseUrl)).complete(messages, advertisedTools(s.baseUrl), new AbortController().signal, text => chunks.push(text));
    assert.deepEqual((s.requests[0].tools as {function: {name: string}}[]).map(t => t.function.name), ['read', 'write', 'edit', 'bash']);
    assert.deepEqual(s.requests[0].stream_options, { include_usage: true });
    assert.deepEqual(result.calls, [{ id: 'call-a', name: 'read', arguments: '{"path":"a.txt"}' }]); assert.equal(result.tokens, 42); assert.equal(chunks.join(''), 'Reading. ');
    const input = s.requests[0].messages as {role:string; tool_call_id?:string}[]; assert.equal(input.at(-1)!.tool_call_id, 'previous');
  } finally { await s.close(); }
});

test('chat-completions accumulates split, repeated, cumulative, and single tool names correctly', async () => {
  const cases = [['re', 'ad'], ['read', 'read'], ['re', 'rea', 'read'], ['read']];
  for (const parts of cases) {
    const s = await server([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'name-call', type: 'function', function: { name: parts[0], arguments: '{"path":"a.txt"}' } }] }, finish_reason: null }] },
      ...parts.slice(1).map(name => ({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name } }] }, finish_reason: null }] })),
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    try {
      const result = await new ModelProvider(config(s.baseUrl)).complete([], advertisedTools(s.baseUrl), new AbortController().signal, () => {});
      assert.deepEqual(result.calls, [{ id: 'name-call', name: 'read', arguments: '{"path":"a.txt"}' }]);
    } finally { await s.close(); }
  }
});

test('truncated stream is rejected before execution', async () => {
  const s = await server([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'bash', arguments: '{' } }] }, finish_reason: null }] }]);
  try { await assert.rejects(new ModelProvider(config(s.baseUrl)).complete([], [], new AbortController().signal, () => {}), /stream_interrupted/); }
  finally { await s.close(); }
});

test('Responses preserves opaque reasoning items and function call IDs on the next request', async () => {
  const output = [{ type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque' }, { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '{}' }];
  const s = await server([{ type: 'response.completed', response: { id: 'resp_1', status: 'completed', output, usage: { total_tokens: 45 } } }]);
  try {
    const provider = new ModelProvider(config(s.baseUrl, 'responses'));
    const first = await provider.complete([{ role: 'user', content: 'read' }], advertisedTools(s.baseUrl), new AbortController().signal, () => {});
    assert.deepEqual((s.requests[0].tools as {name: string}[]).map(t => t.name), ['read', 'write', 'edit', 'bash']);
    assert.equal(first.calls[0].id, 'call_1'); assert.deepEqual(first.opaque, output);
    await provider.complete([{ role: 'user', content: 'list' }, { role: 'assistant', content: '', calls: first.calls, opaque: first.opaque }, { role: 'tool', id: 'call_1', content: 'a.txt' }], [], new AbortController().signal, () => {});
    assert.deepEqual((s.requests[1].input as unknown[])[1], output[0]);
    assert.equal((s.requests[1].input as {call_id?:string}[]).at(-1)!.call_id, 'call_1');
  } finally { await s.close(); }
});

test('Responses rejects missing terminal output with a useful upstream or protocol error', async () => {
  for (const item of [
    { event: { type: 'response.failed', response: { status: 'failed', error: { message: 'upstream overloaded' } } }, expected: /invalid_response: upstream overloaded/ },
    { event: { type: 'response.completed', response: { status: 'completed' } }, expected: /invalid_response:.*output/ },
    { event: { type: 'response.completed' }, expected: /invalid_response:.*output/ },
  ]) {
    const s = await server([item.event]);
    try { await assert.rejects(new ModelProvider(config(s.baseUrl, 'responses')).complete([], [], new AbortController().signal, () => {}), item.expected); }
    finally { await s.close(); }
  }
});

test('Responses failed or incomplete terminal events cannot be upgraded by a conflicting completed status', async () => {
  for (const type of ['response.failed', 'response.incomplete']) {
    const s = await server([{ type, response: { status: 'completed', output: [{ type: 'function_call', call_id: 'unsafe', name: 'write', arguments: '{"path":"never.txt","content":"unsafe","expectedHash":null}' }] } }]);
    try {
      const result = await new ModelProvider(config(s.baseUrl, 'responses')).complete([], [], new AbortController().signal, () => {});
      assert.equal(result.incomplete, type, 'the runtime must reject this completion before any tools execute');
    } finally { await s.close(); }
  }
});

test('Responses keeps the first terminal event and ignores a later completed function call', async () => {
  const s = await server([
    { type: 'response.failed', response: { status: 'failed', output: [], error: { message: 'upstream failed' } } },
    { type: 'response.completed', response: { status: 'completed', output: [{ type: 'function_call', call_id: 'unsafe', name: 'write', arguments: '{"path":"never.txt","content":"unsafe","expectedHash":null}' }] } },
  ]);
  try {
    const result = await new ModelProvider(config(s.baseUrl, 'responses')).complete([], advertisedTools(s.baseUrl), new AbortController().signal, () => {});
    assert.ok(result.incomplete); assert.equal(result.calls.length, 0);
  } finally { await s.close(); }
});

test('Responses streams visible summaries separately and falls back to completed summary', async () => {
  const summary = [{ type: 'summary_text', text: 'Inspect the file.' }, { type: 'summary_text', text: 'Verify it.' }];
  const s = await server([
    { type: 'response.reasoning_summary_text.delta', item_id: 'r1', summary_index: 0, delta: 'Inspect the file.' },
    { type: 'response.reasoning_summary_text.delta', item_id: 'r1', summary_index: 1, delta: 'Verify it.' },
    { type: 'response.output_text.delta', delta: 'Done.' },
    { type: 'response.completed', response: { status: 'completed', output: [{ type: 'reasoning', id: 'r1', summary, encrypted_content: 'never-render-this' }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] }] } },
  ]);
  try {
    const text: string[] = [], reasoning: string[] = [];
    const result = await new ModelProvider(config(s.baseUrl, 'responses')).complete([], [], new AbortController().signal, t => text.push(t), t => reasoning.push(t));
    assert.deepEqual(s.requests[0].reasoning, { summary: 'auto' });
    assert.equal(reasoning.join(''), 'Inspect the file.\n\nVerify it.'); assert.equal(result.reasoning, reasoning.join('')); assert.equal(text.join(''), 'Done.');
    assert.doesNotMatch(result.reasoning!, /never-render-this/);
  } finally { await s.close(); }
  const finalOnly = await server([{ type: 'response.completed', response: { status: 'completed', output: [{ type: 'reasoning', id: 'r2', summary }] } }]);
  try {
    const result = await new ModelProvider({ ...config(finalOnly.baseUrl, 'responses'), reasoningSummary: false }).complete([], [], new AbortController().signal, () => {});
    assert.equal(result.reasoning, 'Inspect the file.\n\nVerify it.'); assert.equal(finalOnly.requests[0].reasoning, undefined);
  } finally { await finalOnly.close(); }
});

test('compatible chat reasoning_content is separate from the final answer', async () => {
  const s = await server([
    { choices: [{ delta: { reasoning_content: 'Checking.' }, finish_reason: null }] },
    { choices: [{ delta: { content: 'Answer.' }, finish_reason: 'stop' }] },
  ]);
  try {
    const text: string[] = [], reasoning: string[] = [];
    const result = await new ModelProvider(config(s.baseUrl)).complete([], [], new AbortController().signal, t => text.push(t), t => reasoning.push(t));
    assert.equal(result.reasoning, 'Checking.'); assert.equal(reasoning.join(''), 'Checking.'); assert.equal(text.join(''), 'Answer.');
  } finally { await s.close(); }
});

test('preprocessor can override agent instructions and cap output in both protocols', async () => {
  for (const protocol of ['responses', 'chat-completions'] as const) {
    const s = await server(protocol === 'responses' ? [{ type: 'response.completed', response: { status: 'completed', output: [] } }] : [{ choices: [{ delta: {}, finish_reason: 'stop' }] }]);
    try {
      const provider = new ModelProvider(config(s.baseUrl, protocol), { instructions: 'Compress only.', maxRetries: 0, maxOutputTokens: 2048 });
      await provider.complete([{ role: 'user', content: 'source', preparedContent: 'local-only metadata' }], [], new AbortController().signal, () => {});
      const body = s.requests[0];
      if (protocol === 'responses') { assert.equal(body.instructions, 'Compress only.'); assert.equal(body.max_output_tokens, 2048); }
      else { assert.equal((body.messages as {content:string}[])[0].content, 'Compress only.'); assert.equal(body.max_completion_tokens, 2048); }
      if (protocol === 'responses') assert.deepEqual(body.tools, []);
      else assert.equal(Object.hasOwn(body, 'tools'), false, 'vLLM rejects an empty tools array');
      assert.doesNotMatch(JSON.stringify(body), /local-only metadata/);
    } finally { await s.close(); }
  }
});

test('both API request JSONs deliver task, exact keywords and constraints to the main model', async () => {
  const { assembleRequest } = await import('../src/core/prompt-schema.js');
  const { modelMessage } = await import('../src/core/harness.js');
  const original = 'icy 使用 TypeScript，保留 /new 命令。';
  const request = assembleRequest(original, '完善命令支持。', ['TypeScript', '/new'], [], 'icy-output:abc.txt');
  for (const protocol of ['responses', 'chat-completions'] as const) {
    const s = await server(protocol === 'responses' ? [{ type: 'response.completed', response: { status: 'completed', output: [] } }] : [{ choices: [{ delta: {}, finish_reason: 'stop' }] }]);
    try {
      const message = modelMessage({ role: 'user', content: original, preparedRequest: request }, true, true);
      await new ModelProvider(config(s.baseUrl, protocol)).complete([message], [], new AbortController().signal, () => {});
      const messages = (protocol === 'responses' ? s.requests[0].input : s.requests[0].messages) as { role: string; content: string }[];
      const actual = JSON.parse(messages.find(m => m.role === 'user')!.content);
      assert.equal(actual.task, '完善命令支持。');
      for (const keyword of ['icy', 'TypeScript', '/new']) assert.ok(actual.keywords.includes(keyword));
      assert.ok(actual.constraints.includes(original)); assert.equal(actual.original_ref, 'icy-output:abc.txt');
      assert.equal('preparedRequest' in messages.find(m => m.role === 'user')!, false);
    } finally { await s.close(); }
  }
});

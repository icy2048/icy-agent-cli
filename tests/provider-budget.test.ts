import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { ModelProvider } from '../src/providers/model.js';
import type { Config } from '../src/config/load.js';
import type { Message, ToolDefinition } from '../src/core/types.js';

type Protocol = Config['provider'];
async function fixture(protocol: Protocol, usage?: Record<string, unknown>) {
  const requests: Record<string, unknown>[] = [];
  const http = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const events = protocol === 'responses'
      ? [{ type: 'response.completed', response: { id: 'fixture', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }], ...(usage ? { usage } : {}) } }]
      : [{ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }, ...(usage ? [{ choices: [], usage }] : [])];
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const address = http.address(); assert.ok(address && typeof address !== 'string');
  const config: Config = { provider: protocol, baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'fixture', apiKey: 'fixture-key', apiKeyEnv: 'ICY_TEST_KEY', home: '/unused', cwd: '/unused', permissions: 'read-only', compactionMinChars: 200, promptCompaction: 'off', maxModelTurns: 20, maxToolCalls: 50, maxTokens: 100000, maxContextChars: 100000, requestTimeoutMs: 1000 };
  return { config, requests, close: () => new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())) };
}

for (const protocol of ['chat-completions', 'responses'] as const) {
  const inputKey = protocol === 'responses' ? 'input_tokens' : 'prompt_tokens';
  const outputKey = protocol === 'responses' ? 'output_tokens' : 'completion_tokens';
  const limitKey = protocol === 'responses' ? 'max_output_tokens' : 'max_completion_tokens';
  test(`${protocol} sends the smaller request/configured output budget and reports structured usage`, async () => {
    const s = await fixture(protocol, { total_tokens: 120, [inputKey]: 90, [outputKey]: 30, [`${inputKey}_details`]: { cached_tokens: 40 } });
    try {
      const provider = new ModelProvider(s.config, { maxOutputTokens: 2048 });
      const result = await provider.complete([], [], new AbortController().signal, () => {}, undefined, { maxOutputTokens: 128 });
      assert.equal(s.requests[0][limitKey], 128);
      assert.deepEqual(result.usage, { totalTokens: 120, inputTokens: 90, outputTokens: 30, cachedInputTokens: 40 });
      assert.equal(result.tokens, 120);
      await provider.complete([], [], new AbortController().signal, () => {}, undefined, { maxOutputTokens: 65536 });
      assert.equal(s.requests[1][limitKey], 2048);
      await provider.complete([], [], new AbortController().signal, () => {});
      assert.equal(s.requests[2][limitKey], 2048);
    } finally { await s.close(); }
  });

  test(`${protocol} estimates the actual serialized request including instructions, tools and protocol history`, async () => {
    const s = await fixture(protocol);
    try {
      const provider = new ModelProvider(s.config, { instructions: 'Budget these instructions too.\nQuoted "text".' });
      const messages: Message[] = [{ role: 'user', content: 'read' }, { role: 'assistant', content: '', calls: [{ id: 'call', name: 'read', arguments: '{}' }], opaque: [{ type: 'reasoning', id: 'opaque', summary: [], encrypted_content: 'x'.repeat(500) }, { type: 'function_call', call_id: 'call', name: 'read', arguments: '{}' }] }, { role: 'tool', id: 'call', content: 'result' }];
      const tools: ToolDefinition[] = [{ name: 'read', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
      const estimatedChars = provider.estimateInputChars(messages, tools);
      await provider.complete(messages, tools, new AbortController().signal, () => {}, undefined, { maxOutputTokens: 65536 });
      assert.equal(s.requests[0][limitKey], 65536);
      const input = { ...s.requests[0] }; delete input[limitKey];
      assert.equal(estimatedChars, JSON.stringify(input).length);
      assert.ok(estimatedChars > JSON.stringify(messages.filter(message => message.role === 'user')).length);
      if (protocol === 'responses') assert.match(JSON.stringify(input), /encrypted_content/);
    } finally { await s.close(); }
  });

  test(`${protocol} preserves missing usage as unknown and does not invent an output cap without a budget`, async () => {
    const s = await fixture(protocol);
    try {
      const result = await new ModelProvider(s.config).complete([], [], new AbortController().signal, () => {});
      assert.equal(result.usage, undefined); assert.equal(result.tokens, undefined);
      assert.equal(s.requests[0][limitKey], undefined);
    } finally { await s.close(); }
  });

  test(`${protocol} accepts total-only usage without claiming absent component counts`, async () => {
    const s = await fixture(protocol, { total_tokens: 42 });
    try {
      const result = await new ModelProvider(s.config).complete([], [], new AbortController().signal, () => {});
      assert.deepEqual(result.usage, { totalTokens: 42 }); assert.equal(result.tokens, 42);
    } finally { await s.close(); }
  });

  test(`${protocol} derives missing totals from both components and discards invalid counters`, async () => {
    const s = await fixture(protocol, { [inputKey]: 12, [outputKey]: 8, [`${inputKey}_details`]: { cached_tokens: -1 } });
    try {
      const result = await new ModelProvider(s.config).complete([], [], new AbortController().signal, () => {});
      assert.deepEqual(result.usage, { totalTokens: 20, inputTokens: 12, outputTokens: 8 });
    } finally { await s.close(); }
    const invalid = await fixture(protocol, { total_tokens: -1, [inputKey]: -2, [outputKey]: 8 });
    try {
      const result = await new ModelProvider(invalid.config).complete([], [], new AbortController().signal, () => {});
      assert.equal(result.usage, undefined); assert.equal(result.tokens, undefined);
    } finally { await invalid.close(); }
  });

  test(`${protocol} rejects invalid output budgets before sending a request`, async () => {
    const s = await fixture(protocol);
    try {
      for (const maxOutputTokens of [0, -1, Number.NaN, 1.5]) {
        await assert.rejects(new ModelProvider(s.config).complete([], [], new AbortController().signal, () => {}, undefined, { maxOutputTokens }), /Invalid output token limit/);
      }
      assert.equal(s.requests.length, 0);
    } finally { await s.close(); }
  });
}

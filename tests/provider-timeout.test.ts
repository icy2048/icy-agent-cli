import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, access, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ModelProvider } from '../src/providers/model.js';
import { Agent } from '../src/core/agent.js';
import { SessionStore } from '../src/sessions/store.js';
import { ToolRegistry } from '../src/tools/registry.js';
import type { Config } from '../src/config/load.js';
import type { AgentEvent } from '../src/core/types.js';

for (const protocol of ['chat-completions', 'responses'] as const) test(`${protocol} deadline covers an endless response body and saves failure without executing partial tools`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'icy-stream-deadline-'));
  const cwd = path.join(root, 'workspace'), home = path.join(root, 'home'); await mkdir(cwd);
  let requests = 0;
  const http = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume request */ }
    requests++;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const events = protocol === 'chat-completions'
      ? [{ choices: [{ delta: { content: 'partial text', tool_calls: [{ index: 0, id: 'unfinished', function: { name: 'write', arguments: '{"path":"never.txt",' } }] }, finish_reason: null }] }]
      : [{ type: 'response.output_text.delta', delta: 'partial text' }, { type: 'response.function_call_arguments.delta', item_id: 'unfinished', delta: '{"path":"never.txt",' }];
    for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
    const heartbeat = setInterval(() => response.write(': still connected\n\n'), 20);
    response.once('close', () => clearInterval(heartbeat));
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const config: Config = { cwd, home, provider: protocol, baseUrl: `http://127.0.0.1:${(http.address() as {port:number}).port}/v1`, model: 'fixture', apiKey: 'fixture', apiKeyEnv: 'UNUSED', permissions: 'workspace-edit', promptCompaction: 'off', compactionMinChars: 200, maxModelTurns: 20, maxToolCalls: 50, maxTokens: 100000, maxContextChars: 100000, requestTimeoutMs: 1000 };
  const store = await SessionStore.create(home, config), events: AgentEvent[] = [];
  const emergency = new AbortController(), fallback = setTimeout(() => emergency.abort(), 3000);
  try {
    const result = await new Agent(config, new ModelProvider(config, { maxRetries: 0 }), new ToolRegistry(config, store), store, event => events.push(event)).run('Create never.txt only after a complete tool response.', emergency.signal);
    assert.equal(emergency.signal.aborted, false, 'provider deadline must fire without caller cancellation');
    assert.equal(result.ok, false); assert.match(result.reason, /model_request_timeout/);
    assert.equal(requests, 1);
    assert.ok(events.some(event => event.type === 'delta' && event.text.includes('partial text')));
    assert.ok(events.some(event => event.type === 'done' && event.reason.includes('model_request_timeout')));
    assert.equal(store.data.runs.at(-1)?.status, 'failed');
    assert.equal(store.data.runs.at(-1)?.toolCalls, 0);
    assert.ok(store.data.runs.at(-1)?.usage.estimated);
    assert.ok(store.data.runs.at(-1)!.usage.tokens > 0);
    await assert.rejects(access(path.join(cwd, 'never.txt')), { code: 'ENOENT' });
  } finally {
    clearTimeout(fallback); await store.close(); http.closeAllConnections();
    await new Promise<void>(resolve => http.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

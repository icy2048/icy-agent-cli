import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import React from 'react';
import { render } from 'ink-testing-library';
import { verifyModel, type ModelProfile } from '../src/config/models.js';
import type { Config } from '../src/config/load.js';
import { ModelWizard } from '../src/ui/ModelWizard.js';

type Protocol = 'responses' | 'chat-completions';
type Scenario = 'auth' | 'malformed' | 'model-404' | 'plain-404' | 'no-tool' | 'wrong-name' | 'bad-result' | 'success';

const profileFor = (baseUrl: string, provider: Protocol): ModelProfile => ({ name: 'Fixture', baseUrl, provider, model: 'fixture-model', apiKey: 'fixture-key' });
const configFor = (baseUrl: string, provider: Protocol): Config => ({
  home: '/unused', cwd: '/unused', baseUrl, provider, model: 'fixture-model', apiKey: 'fixture-key', apiKeyEnv: 'ICY_KEY',
  permissions: 'workspace-edit', promptCompaction: 'off', compactionMinChars: 200, maxModelTurns: 2, maxToolCalls: 4,
  maxTokens: 10000, maxContextChars: 10000, requestTimeoutMs: 1000,
});

function chatEvents(body: string, finish: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: body }, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\n` + 'data: [DONE]\n\n';
}
function responseEvent(text: string): string {
  return `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\n` +
    `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] } })}\n\n`;
}
function toolEvent(provider: Protocol, name: string, args: string): string {
  if (provider === 'chat-completions') return `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-probe', type: 'function', function: { name, arguments: args } }] }, finish_reason: null }] })}\n\n` + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`;
  return `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'function_call', id: 'fc-probe', call_id: 'call-probe', name, arguments: args }] } })}\n\n`;
}
async function fixture(provider: Protocol, scenario: Scenario) {
  const bodies: Record<string, unknown>[] = [];
  const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    bodies.push(JSON.parse(raw) as Record<string, unknown>);
    if (scenario === 'auth') { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'invalid key' } })); return; }
    if (scenario === 'malformed') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>not an API response</html>'); return; }
    if (scenario === 'model-404') { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'The model `x` does not exist.', type: 'NotFoundError', code: 404 } })); return; }
    if (scenario === 'plain-404') { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const request = bodies.at(-1)!;
    let output: string;
    if (bodies.length === 1) {
      output = provider === 'chat-completions' ? chatEvents('OK', 'stop') : responseEvent('OK');
    } else if (bodies.length === 2) {
      if (scenario === 'no-tool') output = provider === 'chat-completions' ? chatEvents('I cannot call tools.', 'stop') : responseEvent('I cannot call tools.');
      else output = toolEvent(provider, scenario === 'wrong-name' ? 'other_tool' : 'icy_probe', '{"value":"ping"}');
    } else {
      const token = provider === 'chat-completions'
        ? ((request.messages as { role: string; content?: string }[]).find(message => message.role === 'tool')?.content || '')
        : ((request.input as { type?: string; output?: string }[]).find(item => item.type === 'function_call_output')?.output || '');
      const text = scenario === 'success' ? `received ${token}` : 'received something else';
      output = provider === 'chat-completions' ? chatEvents(text, 'stop') : responseEvent(text);
    }
    res.end(output);
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const baseUrl = `http://127.0.0.1:${(http.address() as { port: number }).port}/v1`;
  return { bodies, baseUrl, close: () => new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())) };
}

for (const provider of ['responses', 'chat-completions'] as const) {
  for (const scenario of ['auth', 'malformed', 'model-404', 'plain-404', 'no-tool', 'wrong-name', 'bad-result', 'success'] as const) {
    test(`${provider} model probe classifies ${scenario}`, async () => {
      const server = await fixture(provider, scenario);
      try {
        const result = await verifyModel(profileFor(server.baseUrl, provider), configFor(server.baseUrl, provider), new AbortController().signal);
        if (scenario === 'auth') { assert.equal(result.ok ? '' : result.stage, 'auth'); assert.match(result.ok ? '' : result.message, /^认证失败：/); }
        else if (scenario === 'malformed') assert.equal(result.ok ? '' : result.stage, 'protocol');
        else if (scenario === 'model-404') { assert.equal(result.ok ? '' : result.stage, 'model'); assert.match(result.ok ? '' : result.message, /^模型不存在：/); }
        else if (scenario === 'plain-404') assert.equal(result.ok ? '' : result.stage, 'protocol');
        else if (scenario === 'no-tool') { assert.equal(result.ok ? '' : result.stage, 'tool_call'); assert.match(result.ok ? '' : result.message, /^不支持工具调用：/); }
        else if (scenario === 'wrong-name') { assert.equal(result.ok ? '' : result.stage, 'tool_call'); assert.match(result.ok ? '' : result.message, /^工具调用不正确：/); }
        else if (scenario === 'bad-result') { assert.equal(result.ok ? '' : result.stage, 'tool_result'); assert.match(result.ok ? '' : result.message, /^工具结果续接失败：/); }
        else assert.deepEqual(result, { ok: true, textReply: true, toolCalls: true });
      } finally { await server.close(); }
    });
  }
}

test('successful probe advertises only icy_probe and pairs its result without workspace tools', async () => {
  for (const provider of ['responses', 'chat-completions'] as const) {
    const server = await fixture(provider, 'success');
    try {
      const result = await verifyModel(profileFor(server.baseUrl, provider), configFor(server.baseUrl, provider), new AbortController().signal);
      assert.equal(result.ok, true);
      for (const body of server.bodies) {
        const tools = (body.tools || []) as { function?: { name: string }; name?: string }[];
        for (const tool of tools) assert.notEqual(tool.function?.name || tool.name, 'read');
        for (const tool of tools) assert.notEqual(tool.function?.name || tool.name, 'write');
        for (const tool of tools) assert.notEqual(tool.function?.name || tool.name, 'edit');
        for (const tool of tools) assert.notEqual(tool.function?.name || tool.name, 'bash');
      }
      const probeTools = server.bodies[1]!.tools as { function?: { name: string }; name?: string }[];
      assert.equal(probeTools.length, 1);
      assert.equal(provider === 'chat-completions' ? probeTools[0]!.function?.name : probeTools[0]!.name, 'icy_probe');
      if (provider === 'chat-completions') {
        const assistant = (server.bodies[2]!.messages as { role: string; tool_calls?: { id: string }[] }[]).find(message => message.role === 'assistant')!;
        const tool = (server.bodies[2]!.messages as { role: string; tool_call_id?: string }[]).find(message => message.role === 'tool')!;
        assert.equal(tool.tool_call_id, assistant.tool_calls![0]!.id);
      } else {
        const output = (server.bodies[2]!.input as { type?: string; call_id?: string }[]).find(item => item.type === 'function_call_output')!;
        const call = (server.bodies[2]!.input as { type?: string; call_id?: string }[]).find(item => item.type === 'function_call')!;
        assert.equal(output.call_id, call.call_id);
      }
    } finally { await server.close(); }
  }
});

test('model wizard shows both probe progress lines and a classified failure', async () => {
  let release!: (value: { ok: false; stage: 'auth'; message: string }) => void;
  const result = new Promise<{ ok: false; stage: 'auth'; message: string }>(resolve => { release = resolve; });
  const ui = render(React.createElement(ModelWizard, {
    config: { model: 'old', baseUrl: 'http://localhost', provider: 'responses', apiKey: 'old-key' } as Config,
    width: 80, onClose: () => {}, onApply: async () => { assert.fail('failed verification must not apply'); },
    services: {
      discover: async () => [], list: async () => ['probe-model'], verify: async () => result,
    },
  }));
  const tick = () => new Promise(resolve => setTimeout(resolve, 35));
  try {
    await tick(); ui.stdin.write('\r'); await tick(); await tick(); ui.stdin.write('\r'); await tick(); ui.stdin.write('\r'); await tick();
    assert.match(ui.lastFrame()!, /测试文本响应…/); assert.match(ui.lastFrame()!, /测试工具调用…/);
    release({ ok: false, stage: 'auth', message: '认证失败：fixture' }); await tick();
    assert.match(ui.lastFrame()!, /认证失败：fixture/);
  } finally { ui.unmount(); ui.cleanup(); }
});

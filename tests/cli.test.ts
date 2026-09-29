import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.tsx', import.meta.url));
const fixtureKey = 'offline-cli-fixture-key';
type Event = { type: string; [key: string]: unknown };
type Request = { url: string; body: Record<string, unknown>; authorization?: string };
type Reply = (response: ServerResponse, request: Request, index: number) => void;

function stream(response: ServerResponse, events: unknown[]) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end('data: [DONE]\n\n');
}
function answer(response: ServerResponse) {
  stream(response, [{ choices: [{ delta: { content: 'Fixture completed.\n验证完成。' }, finish_reason: 'stop' }] }, { choices: [], usage: { total_tokens: 12 } }]);
}
function call(response: ServerResponse, name: string, args: unknown) {
  stream(response, [{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'fixture-call', type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }]);
}

async function fixture(reply: Reply = answer, provider = 'chat-completions') {
  const dir = await mkdtemp(path.join(tmpdir(), 'icy-cli-'));
  const cwd = path.join(dir, 'workspace'), home = path.join(dir, 'icy'), userHome = path.join(dir, 'user');
  await Promise.all([mkdir(cwd), mkdir(home), mkdir(userHome)]);
  const requests: Request[] = [];
  const http = createServer(async (request, response) => {
    try {
      let body = ''; for await (const chunk of request) body += chunk;
      const captured: Request = { url: request.url!, body: JSON.parse(body), authorization: request.headers.authorization };
      requests.push(captured); reply(response, captured, requests.length);
    } catch (error) { response.writeHead(500); response.end(String(error)); }
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const address = http.address(); assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;
  await writeFile(path.join(home, 'config.json'), JSON.stringify({ provider, baseUrl, model: 'offline-fixture', apiKeyEnv: 'ICY_FIXTURE_KEY', promptCompaction: 'off', requestTimeoutMs: 10000 }));
  const children: ReturnType<typeof spawn>[] = [];
  function start(args: string[]) {
    // Do not inherit model credentials, service endpoints, proxy settings or user configuration.
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), cli, ...args], {
      cwd, env: { PATH: process.env.PATH, HOME: userHome, ICY_HOME: home, ICY_FIXTURE_KEY: fixtureKey, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let stdout = '', stderr = '';
    child.stdout!.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr!.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`CLI timed out. stdout=${stdout} stderr=${stderr}`)); }, 15000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
    });
    return { child, done };
  }
  async function close() {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
    await rm(dir, { recursive: true, force: true });
  }
  return { cwd, home, requests, start, close };
}
function ndjson(stdout: string): Event[] {
  assert.ok(stdout.endsWith('\n'), 'NDJSON must end with a newline');
  const events = stdout.slice(0, -1).split('\n').map(line => JSON.parse(line) as Event);
  assert.ok(events.length > 0);
  for (const event of events) { assert.equal(typeof event, 'object'); assert.equal(typeof event.type, 'string'); }
  assert.equal(events[0].type, 'session');
  return events;
}

test('CLI NDJSON success runs a real HTTP provider and read tool, exits 0 and releases the session lock', async () => {
  const s = await fixture((response, _request, index) => index === 1 ? call(response, 'read', { path: 'note.txt', offset: null, limit: null }) : answer(response));
  try {
    await writeFile(path.join(s.cwd, 'note.txt'), 'fixture contents');
    const result = await s.start(['run', 'Read note.txt and report the result.', '--json']).done;
    assert.equal(result.code, 0, result.stderr); assert.equal(result.signal, null); assert.equal(result.stderr, '');
    const events = ndjson(result.stdout);
    assert.deepEqual(events.at(-1), { type: 'done', reason: 'completed', ok: true });
    assert.equal(events.filter(event => event.type === 'tool_end').length, 1);
    assert.match(JSON.stringify(events.find(event => event.type === 'tool_end')), /fixture contents/);
    assert.equal(s.requests.length, 2); assert.equal(s.requests[0].url, '/v1/chat/completions');
    assert.equal(s.requests[0].authorization, `Bearer ${fixtureKey}`);
    assert.match(JSON.stringify(s.requests[1].body.messages), /fixture contents/);
    const sessionDir = path.join(s.home, 'sessions', String(events[0].id));
    await assert.rejects(access(path.join(sessionDir, 'lock')));
    assert.match(await readFile(path.join(sessionDir, 'session.json'), 'utf8'), /fixture contents/);
  } finally { await s.close(); }
});

test('CLI supports Responses over real HTTP and emits valid NDJSON', async () => {
  const s = await fixture(response => stream(response, [
    { type: 'response.output_text.delta', delta: 'Responses fixture done.' },
    { type: 'response.completed', response: { id: 'response-fixture', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Responses fixture done.' }] }], usage: { total_tokens: 12 } } },
  ]), 'responses');
  try {
    const result = await s.start(['run', 'Reply.', '--json']).done;
    assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, '');
    assert.deepEqual(ndjson(result.stdout).at(-1), { type: 'done', reason: 'completed', ok: true });
    assert.equal(s.requests[0].url, '/v1/responses');
  } finally { await s.close(); }
});

test('CLI approval exits 2 without executing the requested shell command', async () => {
  const s = await fixture(response => call(response, 'bash', { command: 'touch should-not-exist', cwd: null, timeoutMs: 1000 }));
  try {
    const result = await s.start(['run', 'Run the command.', '--json']).done;
    assert.equal(result.code, 2, result.stderr); assert.equal(result.stderr, '');
    assert.deepEqual(ndjson(result.stdout).at(-1), { type: 'done', reason: 'approval_required', ok: false });
    await assert.rejects(access(path.join(s.cwd, 'should-not-exist')));
    assert.equal(s.requests.length, 1);
  } finally { await s.close(); }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  test(`CLI ${signal} cancels an in-flight HTTP request, exits 130 and persists cancellation`, { skip: process.platform === 'win32' && 'Windows has no SIGINT delivery to child processes' }, async () => {
    let notifyRequest!: () => void;
    const requested = new Promise<void>(resolve => { notifyRequest = resolve; });
    const s = await fixture(response => {
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders(); notifyRequest();
    });
    try {
      const run = s.start(['run', 'Wait for the provider.', '--json']);
      await Promise.race([requested, run.done.then(result => { throw new Error(`CLI exited before request: ${result.stderr}`); })]);
      assert.equal(run.child.kill(signal), true);
      const result = await run.done;
      assert.equal(result.code, 130, result.stderr); assert.equal(result.signal, null); assert.equal(result.stderr, '');
      const events = ndjson(result.stdout);
      assert.deepEqual(events.at(-1), { type: 'done', reason: 'cancelled', ok: false });
      const sessionDir = path.join(s.home, 'sessions', String(events[0].id));
      await assert.rejects(access(path.join(sessionDir, 'lock')));
      const persisted = await readFile(path.join(sessionDir, 'events.jsonl'), 'utf8');
      assert.match(persisted, /"reason":"cancelled"/);
    } finally { await s.close(); }
  });
}

for (const json of [true, false]) {
  test(`CLI provider error exits 1 with ${json ? 'valid NDJSON' : 'diagnostics only on stderr'} and redacts secrets`, async () => {
    const s = await fixture(response => {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: `fixture_provider_failure ${fixtureKey}`, type: 'invalid_request_error' } }));
    });
    try {
      const result = await s.start(['run', 'Reply.', ...(json ? ['--json'] : [])]).done;
      assert.equal(result.code, 1);
      assert.doesNotMatch(result.stdout + result.stderr, new RegExp(fixtureKey));
      if (json) {
        assert.equal(result.stderr, ''); const done = ndjson(result.stdout).at(-1)!;
        assert.equal(done.type, 'done'); assert.equal(done.ok, false); assert.match(String(done.reason), /fixture_provider_failure/);
      } else { assert.equal(result.stdout, ''); assert.match(result.stderr, /停止：.*fixture_provider_failure/); }
      assert.equal(s.requests.length, 1);
    } finally { await s.close(); }
  });
}

test('CLI usage errors keep diagnostics off NDJSON stdout and exit 1', async () => {
  const s = await fixture();
  try {
    const result = await s.start(['--json', '--does-not-exist']).done;
    assert.equal(result.code, 1); assert.equal(result.stdout, ''); assert.match(result.stderr, /icy:.*does-not-exist/);
    assert.equal(s.requests.length, 0);
  } finally { await s.close(); }
});

test('CLI plain mode separates model text on stdout from session diagnostics on stderr', async () => {
  const s = await fixture();
  try {
    const result = await s.start(['run', 'Reply.']).done;
    assert.equal(result.code, 0); assert.equal(result.stdout, 'Fixture completed.\n验证完成。\n');
    assert.match(result.stderr, /icy · offline-fixture/); assert.match(result.stderr, /session:/);
    assert.doesNotMatch(result.stdout, /session:|icy ·/);
  } finally { await s.close(); }
});

test('CLI rejects unapproved detached bash in non-interactive mode without starting a process', async () => {
  const s = await fixture((response, _request, index) => {
    if (index === 1) call(response, 'bash', { command: `: ${fixtureKey}; echo $$ > detached.pid; sleep 30`, cwd: null, timeoutMs: null, detach: true, kill: null });
    else setTimeout(() => answer(response), 150);
  });
  try {
    const result = await s.start(['run', 'Start the long command.', '--json']).done;
    assert.equal(result.code, 2, result.stderr);
    const events = ndjson(result.stdout);
    const toolEnd = events.find(event => event.type === 'tool_end') as Event & { call: { name: string }; result: { ok: boolean; content: string } } | undefined;
    assert.ok(toolEnd);
    assert.equal(toolEnd.call.name, 'bash');
    assert.equal(toolEnd.result.ok, false);
    assert.match(toolEnd.result.content, /approval_required/);
    assert.equal(events.some(event => event.type === 'process'), false);
    await assert.rejects(access(path.join(s.cwd, 'detached.pid')));
  } finally { await s.close(); }
});

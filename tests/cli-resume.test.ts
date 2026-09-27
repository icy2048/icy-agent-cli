import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionData } from '../src/sessions/store.js';

const cli = fileURLToPath(new URL('../src/cli.tsx', import.meta.url));
type Event = { type: string; [key: string]: unknown };
function stream(response: ServerResponse, delta: unknown, finish = 'stop') {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ choices: [], usage: { total_tokens: 100, prompt_tokens: 70, completion_tokens: 30 } })}\n\n`);
  response.end('data: [DONE]\n\n');
}
function call(response: ServerResponse, id: string, name: string, args: unknown) {
  stream(response, { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, 'tool_calls');
}
function ndjson(stdout: string): Event[] {
  if (!stdout) return [];
  assert.ok(stdout.endsWith('\n'));
  return stdout.slice(0, -1).split('\n').map(line => {
    const event = JSON.parse(line) as Event; assert.equal(typeof event.type, 'string'); return event;
  });
}
async function fixture(reply: (response: ServerResponse, request: Record<string, unknown>, index: number) => void = response => stream(response, { content: 'Fixture done.' })) {
  const dir = await mkdtemp(path.join(tmpdir(), 'icy-cli-resume-'));
  const cwd = path.join(dir, 'workspace'), home = path.join(dir, 'icy'), userHome = path.join(dir, 'user');
  await Promise.all([mkdir(cwd), mkdir(home), mkdir(userHome)]);
  const requests: Record<string, unknown>[] = [];
  const http = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body) as Record<string, unknown>;
    requests.push(parsed); reply(response, parsed, requests.length);
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const address = http.address(); assert.ok(address && typeof address !== 'string');
  await writeFile(path.join(home, 'config.json'), JSON.stringify({ provider: 'chat-completions', baseUrl: `http://127.0.0.1:${address.port}/v1`, model: 'offline-resume', apiKeyEnv: 'ICY_FIXTURE_KEY', promptCompaction: 'off', requestTimeoutMs: 1000 }));
  async function run(args: string[], credentials = true) {
    const child = spawn(process.execPath, ['--import', fileURLToPath(import.meta.resolve('tsx')), cli, ...args], {
      cwd, env: { PATH: process.env.PATH, HOME: userHome, ICY_HOME: home, NO_COLOR: '1', ...(credentials ? { ICY_FIXTURE_KEY: 'offline-fixture-key' } : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout!.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr!.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    return await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`CLI resume timed out: ${stderr}`)); }, 15000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
  }
  const snapshot = async (id: string): Promise<SessionData> => JSON.parse(await readFile(path.join(home, 'sessions', id, 'session.json'), 'utf8'));
  const unlocked = (id: string) => assert.rejects(access(path.join(home, 'sessions', id, 'lock')), { code: 'ENOENT' });
  const close = async () => { http.closeAllConnections(); await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve())); await rm(dir, { recursive: true, force: true }); };
  return { cwd, home, requests, run, snapshot, unlocked, close };
}

test('CLI sessions works with no credentials and an empty session directory', async () => {
  const s = await fixture();
  try {
    const json = await s.run(['sessions', '--json'], false);
    assert.equal(json.code, 0); assert.equal(json.stdout, ''); assert.equal(json.stderr, '');
    const plain = await s.run(['sessions'], false);
    assert.equal(plain.code, 0); assert.match(plain.stdout, /暂无会话/); assert.equal(plain.stderr, '');
    assert.equal(s.requests.length, 0); await assert.rejects(access(path.join(s.home, 'sessions')), { code: 'ENOENT' });
  } finally { await s.close(); }
});

test('CLI discovers valid and corrupt sessions, then resumes status without credentials or another model request', async () => {
  const s = await fixture();
  try {
    const initial = await s.run(['run', 'Inspect the repository.', '--json']);
    assert.equal(initial.code, 0, initial.stderr);
    const id = String(ndjson(initial.stdout)[0].id), before = await s.snapshot(id);
    const corrupt = path.join(s.home, 'sessions', 'broken-fixture'); await mkdir(corrupt); await writeFile(path.join(corrupt, 'session.json'), '{invalid');
    const listed = await s.run(['sessions', '--json'], false);
    assert.equal(listed.code, 0); assert.equal(listed.stderr, '');
    const summaries = ndjson(listed.stdout); assert.equal(summaries.length, 2);
    const summary = summaries.find(event => event.id === id)!;
    assert.equal(summary.type, 'session_summary'); assert.equal(summary.goal, 'Inspect the repository.'); assert.equal(summary.status, 'answered');
    assert.equal(typeof summaries.find(event => event.id === 'broken-fixture')?.error, 'string');
    assert.equal(await readFile(path.join(corrupt, 'session.json'), 'utf8'), '{invalid');
    const resumed = await s.run(['--resume', id, '--json'], false);
    assert.equal(resumed.code, 0, resumed.stderr); assert.equal(resumed.stderr, '');
    const events = ndjson(resumed.stdout); assert.deepEqual(events.map(event => event.type), ['session', 'task']);
    assert.deepEqual(events[1].task, before.task); assert.deepEqual(events[1].run, before.runs.at(-1));
    const after = await s.snapshot(id); assert.deepEqual(after.messages, before.messages); assert.deepEqual(after.runs, before.runs);
    assert.equal(s.requests.length, 1); await s.unlocked(id);
  } finally { await s.close(); }
});

test('CLI explicit continuation gets a new recorded budget, observes prior results and never replays an old write', async () => {
  const s = await fixture((response, _request, index) => {
    if (index === 1) call(response, 'initial-write', 'write', { path: 'value.txt', content: 'initial output', expectedHash: null });
    else if (index === 3) call(response, 'continued-read', 'read', { path: 'value.txt', offset: null, limit: null });
    else stream(response, { content: 'Fixture done.' });
  });
  try {
    const initial = await s.run(['run', 'Write value.txt and inspect it.', '--json']);
    assert.equal(initial.code, 0, initial.stderr);
    const id = String(ndjson(initial.stdout)[0].id), before = await s.snapshot(id);
    assert.equal(await readFile(path.join(s.cwd, 'value.txt'), 'utf8'), 'initial output');
    // A replay would overwrite this later user change or produce a conflicting write.
    await writeFile(path.join(s.cwd, 'value.txt'), 'later user change');
    const continued = await s.run(['run', '--resume', id, '--continue', '--json']);
    assert.equal(continued.code, 0, continued.stderr); assert.equal(continued.stderr, '');
    const events = ndjson(continued.stdout);
    assert.deepEqual(events.at(-1), { type: 'done', reason: 'completed', ok: true });
    assert.deepEqual(events.filter(event => event.type === 'tool_end').map(event => (event.call as { name: string }).name), ['read']);
    assert.match(JSON.stringify(events.find(event => event.type === 'tool_end')), /later user change/);
    assert.match(JSON.stringify(s.requests[2].messages), /initial-write/); assert.match(JSON.stringify(s.requests[2].messages), /原始目标/);
    assert.equal(await readFile(path.join(s.cwd, 'value.txt'), 'utf8'), 'later user change');
    const after = await s.snapshot(id); assert.equal(after.runs.length, 2);
    assert.equal(after.task?.id, before.task?.id); assert.equal(after.task?.goal, before.task?.goal);
    assert.equal(after.runs[0].budgetSource, 'new_task'); assert.equal(after.runs[1].budgetSource, 'explicit_resume');
    assert.equal(after.runs[1].continuationOf, after.runs[0].id); assert.notEqual(after.runs[1].id, after.runs[0].id);
    assert.deepEqual(after.runs[1].budget, before.runs[0].budget); assert.equal(after.runs[1].usage.tokens, 200);
    assert.equal(after.messages.filter(message => message.role === 'user').length, 1);
    assert.equal(after.messages.filter(message => message.role === 'assistant').flatMap(message => message.calls).filter(call => call.name === 'write').length, 1);
    assert.equal(s.requests.length, 4); await s.unlocked(id);
  } finally { await s.close(); }
});

test('CLI user verification in noninteractive mode requires approval, exits 2 and does not execute or call a model', async () => {
  const s = await fixture();
  try {
    const initial = await s.run(['run', 'Inspect the repository.', '--json']); assert.equal(initial.code, 0, initial.stderr);
    const id = String(ndjson(initial.stdout)[0].id);
    const verified = await s.run(['run', '--resume', id, '--verify', 'touch verification-must-not-run', '--json'], false);
    assert.equal(verified.code, 2, verified.stderr); assert.equal(verified.stderr, '');
    assert.deepEqual(ndjson(verified.stdout).at(-1), { type: 'done', reason: 'approval_required', ok: false });
    await assert.rejects(access(path.join(s.cwd, 'verification-must-not-run')), { code: 'ENOENT' });
    assert.equal(s.requests.length, 1);
    const saved = await s.snapshot(id); assert.equal(saved.runs.length, 2); assert.equal(saved.runs[1].reason, 'approval_required');
    assert.notEqual(saved.task?.status, 'verified'); assert.equal(saved.task?.verificationRecords.at(-1)?.ok, false);
    assert.equal(saved.task?.verificationChecks.at(-1)?.source, 'user'); await s.unlocked(id);
  } finally { await s.close(); }
});

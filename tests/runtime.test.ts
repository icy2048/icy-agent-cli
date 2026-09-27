import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Config } from '../src/config/load.js';
import { SessionStore } from '../src/sessions/store.js';
import { ToolRegistry, sha256 } from '../src/tools/registry.js';
import { Agent } from '../src/core/agent.js';
import type { Approve, Completion, Provider, Message, AgentEvent } from '../src/core/types.js';
import { runBash } from '../src/tools/bash.js';
import { reminderMessage } from '../src/core/harness.js';

async function setup(approve?: Approve, options: Partial<Config> = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'icy-test-'));
  const cwd = path.join(dir, 'workspace'), home = path.join(dir, 'home'); await mkdir(cwd);
  const config: Config = { home, cwd, provider: 'chat-completions', baseUrl: 'http://127.0.0.1:1', model: 'fixture', apiKey: 'test-secret-value', apiKeyEnv: 'ICY_TEST_KEY', permissions: 'workspace-edit', promptCompaction: 'off', compactionMinChars: 200, maxModelTurns: 20, maxToolCalls: 50, maxTokens: 100_000, maxContextChars: 120_000, requestTimeoutMs: 1000, ...options };
  const store = await SessionStore.create(home, { cwd, provider: config.provider, model: config.model, baseUrl: config.baseUrl }, [config.apiKey]);
  const tools = new ToolRegistry(config, store, approve);
  const cleanup = async () => { await store.close(); await rm(dir, { recursive: true, force: true }); };
  const call = (name: string, args: unknown, signal = new AbortController().signal) => tools.execute({ id: 'call', name, arguments: JSON.stringify(args) }, signal);
  return { dir, cwd, home, config, store, tools, cleanup, call };
}
const response = (name: string, args: unknown, id = 'call'): Completion => ({ text: '', calls: [{ id, name, arguments: JSON.stringify(args) }] });

test('agent autonomously reads, edits, verifies and returns tool results with matching IDs', async () => {
  const s = await setup(async () => 'once');
  try {
    let turn = 0; const events: AgentEvent[] = [];
    const provider: Provider = { async complete(messages) {
      turn++;
      if (turn === 1) return response('write', { path: 'value.txt', content: 'before', expectedHash: null }, 'write');
      if (turn === 2) return response('read', { path: 'value.txt', offset: null, limit: null }, 'read');
      if (turn === 3) {
        const result = messages.at(-1); assert.equal(result?.role, 'tool'); assert.equal((result as { id: string }).id, 'read');
        return response('edit', { path: 'value.txt', oldText: 'before', newText: 'after' }, 'edit');
      }
      if (turn === 4) return response('bash', { command: "test \"$(cat value.txt)\" = after", cwd: null, timeoutMs: 1000 }, 'verify');
      assert.match(messages.at(-1)!.content, /Exit code: 0/); return { text: 'verified', calls: [] };
    } };
    const result = await new Agent(s.config, provider, s.tools, s.store, e => events.push(e)).run('change it', new AbortController().signal);
    assert.equal(result.ok, true); assert.equal(turn, 5); assert.equal(await readFile(path.join(s.cwd, 'value.txt'), 'utf8'), 'after');
    assert.deepEqual(events.filter(e => e.type === 'tool_end').map(e => e.call.name), ['write', 'read', 'edit', 'bash']);
  } finally { await s.cleanup(); }
});

test('tool loop appends a transient task reminder after the first tool result and never persists it', async () => {
  assert.equal(reminderMessage([{ role: 'user', content: 'x', preparedRequest: { schema: 'icy.user-request.v2', task: 'x', keywords: [], constraints: [] } }]), undefined);
  const options = { promptCompaction: 'model' as const, compactionMinChars: 0 };
  const s = await setup(undefined, options);
  try {
    await writeFile(path.join(s.cwd, 'note.txt'), 'existing');
    const requests: Message[][] = [], events: AgentEvent[] = []; let calls = 0;
    const provider: Provider = { async complete(messages) {
      requests.push([...messages]); calls++;
      return calls === 1 ? response('read', { path: 'note.txt', offset: null, limit: null }, 'read-note') : { text: '已读取。', calls: [], tokens: 1 };
    } };
    const factory = (_config: Config): Provider => ({ async complete() {
      return { text: JSON.stringify({ prompt: '修改 note.txt。', keywords: ['note.txt'], constraints: ['不要删除任何文件。'] }), calls: [], tokens: 1 };
    } });
    const result = await new Agent(s.config, provider, s.tools, s.store, event => events.push(event), factory).run('修改 note.txt，不要删除任何文件。', new AbortController().signal);
    assert.equal(result.ok, true); assert.equal(requests.length, 2);
    assert.ok(requests[0].at(-1)!.content.startsWith('{'));
    const second = requests[1];
    assert.equal(second.at(-1)!.role, 'user'); assert.ok(second.at(-1)!.content.startsWith('[icy 提醒]'));
    assert.match(second.at(-1)!.content, /不要删除任何文件。/); assert.match(second.at(-1)!.content, /note\.txt/); assert.equal(second.at(-2)!.role, 'tool');
    assert.equal(s.store.data.messages.some(message => message.content.startsWith('[icy 提醒]')), false);
    const turns = events.filter((event): event is Extract<AgentEvent, { type: 'turn' }> => event.type === 'turn');
    assert.ok(turns.some(event => (event.reminderChars ?? 0) > 0)); assert.ok(turns.some(event => event.reminderChars === undefined));
  } finally { await s.cleanup(); }

  const noReminder = await setup(undefined, options);
  try {
    await writeFile(path.join(noReminder.cwd, 'note.txt'), 'existing');
    const requests: Message[][] = []; let calls = 0;
    const provider: Provider = { async complete(messages) {
      requests.push([...messages]); calls++;
      return calls === 1 ? response('read', { path: 'note.txt', offset: null, limit: null }, 'read-empty') : { text: '已读取。', calls: [], tokens: 1 };
    } };
    const factory = (_config: Config): Provider => ({ async complete() {
      return { text: JSON.stringify({ prompt: '读取 note.txt。', keywords: [], constraints: [] }), calls: [], tokens: 1 };
    } });
    const result = await new Agent(noReminder.config, provider, noReminder.tools, noReminder.store, undefined, factory).run('读取 note.txt。', new AbortController().signal);
    assert.equal(result.ok, true); assert.equal(requests.length, 2); assert.equal(requests[1].at(-1)!.role, 'tool');
  } finally { await noReminder.cleanup(); }
});

test('tool errors return to model, and an identical repeated failure stops the loop', async () => {
  const s = await setup(); let turn = 0;
  try {
    const provider: Provider = { async complete(messages) { if (turn) assert.match(messages.at(-1)!.content, /unknown_tool/); return response('missing', {}, `call-${++turn}`); } };
    const result = await new Agent(s.config, provider, s.tools, s.store).run('try', new AbortController().signal);
    assert.equal(result.reason, 'repeated_tool_failure'); assert.equal(turn, 3);
  } finally { await s.cleanup(); }
});

test('invalid JSON cannot cause tool execution', async () => {
  const s = await setup();
  try { const result = await s.tools.execute({ id: 'bad', name: 'write', arguments: '{' }, new AbortController().signal); assert.equal(result.ok, false); }
  finally { await s.cleanup(); }
});

test('write conflicts, traversal, symlinks, secrets, and read-only writes are blocked', async () => {
  const s = await setup();
  try {
    await writeFile(path.join(s.cwd, 'a.txt'), 'original');
    assert.equal((await s.call('write', { path: 'a.txt', content: 'oops', expectedHash: sha256('old') })).ok, false);
    assert.equal(await readFile(path.join(s.cwd, 'a.txt'), 'utf8'), 'original');
    await writeFile(path.join(s.dir, 'outside'), 'private'); await symlink(s.dir, path.join(s.cwd, 'link'));
    for (const file of ['../outside', 'link/outside', '.env', '.ssh/id_rsa']) {
      assert.equal((await s.call('read', { path: file, offset: null, limit: null })).ok, false, file);
      assert.equal((await s.call('write', { path: file, content: 'oops', expectedHash: null })).ok, false, file);
    }
    s.config.permissions = 'read-only';
    assert.equal((await s.call('write', { path: 'new', content: 'oops', expectedHash: null })).ok, false);
  } finally { await s.cleanup(); }
});

test('edit replaces only a unique exact match and preserves surrounding bytes', async () => {
  const s = await setup();
  try {
    await writeFile(path.join(s.cwd, 'a.txt'), '\ufeffone\r\n  two🙂\r\n');
    const result = await s.call('edit', { path: 'a.txt', oldText: '  two🙂', newText: '  三' });
    assert.equal(result.ok, true); assert.equal(await readFile(path.join(s.cwd, 'a.txt'), 'utf8'), '\ufeffone\r\n  三\r\n');
    assert.match(result.diff!, /三/);
  } finally { await s.cleanup(); }
});

test('edit rejects missing, empty and ambiguous matches without writing', async () => {
  const s = await setup();
  try {
    await writeFile(path.join(s.cwd, 'a.txt'), 'aaa\nword word\n');
    for (const oldText of ['', 'missing', 'aa', 'word']) {
      assert.equal((await s.call('edit', { path: 'a.txt', oldText, newText: 'replacement' })).ok, false);
      assert.equal(await readFile(path.join(s.cwd, 'a.txt'), 'utf8'), 'aaa\nword word\n');
    }
    assert.equal((await s.call('edit', { path: 'a.txt', oldText: 'aaa\n', newText: '' })).ok, true);
    assert.equal(await readFile(path.join(s.cwd, 'a.txt'), 'utf8'), 'word word\n');
  } finally { await s.cleanup(); }
});

test('only four tools are advertised and obsolete names are not executable aliases', async () => {
  const s = await setup();
  try {
    assert.deepEqual(s.tools.definitions().map(t => t.name), ['read', 'write', 'edit', 'bash']);
    for (const name of ['list_files', 'search', 'read_file', 'write_file', 'apply_patch', 'shell', 'read_output', 'toString']) {
      assert.match((await s.call(name, {})).content, /unknown_tool/);
    }
    s.config.permissions = 'read-only';
    assert.deepEqual(s.tools.definitions().map(t => t.name), ['read']);
    for (const name of ['write', 'edit', 'bash']) assert.match((await s.call(name, {})).content, /read_only/);
  } finally { await s.cleanup(); }
});

test('denied shell is not executed or repeatedly prompted; exact session grant is reused', async () => {
  let approvals = 0; const s = await setup(async () => { approvals++; return approvals === 1 ? 'deny' : 'session'; });
  try {
    const denied = { command: 'touch denied', cwd: null, timeoutMs: 1000 };
    assert.equal((await s.call('bash', denied)).ok, false); assert.equal((await s.call('bash', denied)).ok, false); assert.equal(approvals, 1);
    const allowed = { command: 'printf approved', cwd: null, timeoutMs: 1000 };
    assert.equal((await s.call('bash', allowed)).ok, true); assert.equal((await s.call('bash', allowed)).ok, true); assert.equal(approvals, 2);
    await assert.rejects(readFile(path.join(s.cwd, 'denied')));
  } finally { await s.cleanup(); }
});

test('noninteractive shell reports approval_required and closes all remaining call IDs', async () => {
  const s = await setup();
  try {
    const provider: Provider = { async complete() { return { text: '', calls: [response('bash', { command: 'touch bad', cwd: null, timeoutMs: 1000 }, 'a').calls[0], response('read', { path: 'value.txt', offset: null, limit: 10 }, 'b').calls[0]] }; } };
    const result = await new Agent(s.config, provider, s.tools, s.store).run('run', new AbortController().signal);
    assert.equal(result.reason, 'approval_required');
    assert.deepEqual(s.store.data.messages.filter(m => m.role === 'tool').map(m => m.id), ['a', 'b']);
    await assert.rejects(readFile(path.join(s.cwd, 'bad')));
  } finally { await s.cleanup(); }
});

test('model and tool budgets stop execution without leaving unmatched calls', async () => {
  const s = await setup(undefined, { maxToolCalls: 1 });
  try {
    const provider: Provider = { async complete() { return { text: '', calls: ['a','b'].map(id => response('read', { path: 'value.txt', offset: null, limit: 1 }, id).calls[0]) }; } };
    assert.equal((await new Agent(s.config, provider, s.tools, s.store).run('list', new AbortController().signal)).reason, 'max_tool_calls');
    assert.equal(s.store.data.messages.filter(m => m.role === 'tool').length, 2);
  } finally { await s.cleanup(); }
});

test('resume never replays a tool whose side effect may have completed', async () => {
  const s = await setup(); let restored: SessionStore | undefined;
  try {
    s.store.data.messages.push({ role: 'assistant', content: '', calls: response('bash', { command: 'touch never' }).calls });
    s.store.data.running = 'call'; await s.store.save(); await s.store.close();
    const resumed = await SessionStore.resume(s.home, s.store.data.id); restored = resumed.store;
    assert.equal(resumed.recovered, 1); assert.match(restored.data.messages.at(-1)!.content, /interrupted_unknown/);
    await assert.rejects(readFile(path.join(s.cwd, 'never')));
  } finally { await restored?.close(); await s.cleanup(); }
});

test('live sessions are locked and API key is redacted from persisted messages', async () => {
  const s = await setup();
  try {
    s.store.data.messages.push({ role: 'user', content: s.config.apiKey }); await s.store.save();
    assert.ok(!(await readFile(path.join(s.store.dir, 'session.json'), 'utf8')).includes(s.config.apiKey));
    await assert.rejects(SessionStore.resume(s.home, s.store.data.id), /其他 icy/);
  } finally { await s.cleanup(); }
});

test('large output uses read references and can reach the tail of a single long line', async () => {
  const s = await setup();
  try {
    await writeFile(path.join(s.cwd, 'large'), '🙂'.repeat(12_000) + 'TAIL_MARKER');
    const result = await s.call('read', { path: 'large', offset: null, limit: null });
    assert.equal(result.truncated, true); assert.ok(result.content.length < 10000);
    assert.match(result.content, /TAIL_MARKER/);
    const reference = result.content.match(/path="(icy-output:[a-f0-9-]+\.txt)"/)![1];
    let offset = 1, content = '';
    for (let count = 0; count < 10; count++) {
      const part = await s.call('read', { path: reference, offset, limit: 6000 });
      assert.equal(part.ok, true); assert.ok(Buffer.byteLength(part.content) < 32768);
      content += part.content;
      if (!part.truncated) break;
      offset = Number(part.content.match(/offset=(\d+)/)![1]);
    }
    assert.match(content, /TAIL_MARKER/); assert.match(content, /End of output/);
    assert.equal((await s.call('read', { path: 'icy-output:../session.json', offset: null, limit: null })).ok, false);
    assert.equal((await s.call('write', { path: reference, content: 'bad', expectedHash: null })).ok, false);
    assert.equal((await s.call('edit', { path: reference, oldText: 'a', newText: 'b' })).ok, false);
  } finally { await s.cleanup(); }
});

test('failed long commands expose a middle diagnostic and tail while preserving the full redacted output', async () => {
  const s = await setup(async () => 'once');
  try {
    const output = 'begin\n' + 'ordinary output\n'.repeat(2000) + '\nnot ok 1 - useful failure\nAssertionError: expected true\n' + 'more output\n'.repeat(2000) + s.config.apiKey + '\nfinal summary\n';
    await writeFile(path.join(s.cwd, 'log.txt'), output);
    const result = await s.call('bash', { command: 'cat log.txt; exit 1', cwd: null, timeoutMs: 1000 });
    assert.equal(result.ok, false); assert.equal(result.error, 'command_failed');
    assert.match(result.content, /useful failure/); assert.match(result.content, /final summary/);
    assert.match(result.content, /Exit code: 1/); assert.ok(result.content.length < 10000);
    assert.ok(!result.content.includes(s.config.apiKey));
    const reference = result.content.match(/path="icy-output:([a-f0-9-]+\.txt)"/)![1];
    const full = await s.store.readOutput(reference);
    assert.ok(full.length > 50000); assert.match(full, /useful failure/);
    assert.ok(!full.includes(s.config.apiKey));
  } finally { await s.cleanup(); }
});

test('bash supports Bash syntax, listing and searching through one tool', async () => {
  const s = await setup(async () => 'once');
  try {
    await writeFile(path.join(s.cwd, 'fixture.txt'), 'searchable\n');
    const result = await s.call('bash', { command: 'items=(one two); [[ ${items[1]} == two ]] && ls fixture.txt && grep -n searchable fixture.txt', cwd: null, timeoutMs: 1000 });
    assert.equal(result.ok, true); assert.match(result.content, /fixture.txt/); assert.match(result.content, /1:searchable/);
  } finally { await s.cleanup(); }
});

test('shell timeout and abort terminate running commands', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'icy-shell-test-'));
  try {
    const timed = await runBash('sleep 10', dir, 50, new AbortController().signal); assert.equal(timed.error, 'timeout');
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 50);
    const cancelled = await runBash('sleep 10', dir, 10000, controller.signal); clearTimeout(timer); assert.equal(cancelled.error, 'cancelled');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('incomplete response never executes tool calls', async () => {
  const s = await setup();
  try {
    const provider: Provider = { async complete() { return { ...response('write', { path: 'bad', content: 'x', expectedHash: null }), incomplete: 'length' }; } };
    assert.equal((await new Agent(s.config, provider, s.tools, s.store).run('try', new AbortController().signal)).ok, false);
    await assert.rejects(readFile(path.join(s.cwd, 'bad')));
  } finally { await s.cleanup(); }
});

test('visible reasoning reaches UI events and resumed sessions separately from answer text', async () => {
  const s = await setup();
  try {
    const events: AgentEvent[] = [];
    const provider: Provider = { async complete(_messages, _tools, _signal, delta, reasoning) {
      reasoning?.('A visible summary.'); delta('Answer.');
      return { text: 'Answer.', reasoning: 'A visible summary.', calls: [] };
    } };
    const result = await new Agent(s.config, provider, s.tools, s.store, event => events.push(event)).run('question', new AbortController().signal);
    assert.equal(result.ok, true);
    assert.deepEqual(events.filter(e => e.type.startsWith('reasoning')), [{ type: 'reasoning_delta', text: 'A visible summary.' }, { type: 'reasoning', text: 'A visible summary.' }]);
    await s.store.close(); const { store } = await SessionStore.resume(s.home, s.store.data.id);
    try {
      const message = store.data.messages.at(-1)!;
      assert.equal(message.role, 'assistant'); assert.equal(message.content, 'Answer.');
      if (message.role === 'assistant') assert.equal(message.reasoning, 'A visible summary.');
    } finally { await store.close(); }
  } finally { await s.cleanup(); }
});

test('new conversation preserves the old session and starts with empty model context', async () => {
  const s = await setup(undefined, { permissions: 'read-only' });
  let calls = 0;
  const provider: Provider = { async complete(messages) {
    calls++;
    assert.equal(messages.length, 1);
    assert.equal(messages[0].content, calls === 1 ? 'old question' : 'new question');
    return { text: 'answer', calls: [] };
  } };
  const agent = new Agent(s.config, provider, s.tools, s.store);
  try {
    await agent.run('old question', new AbortController().signal);
    const oldId = agent.store.data.id;
    await agent.newConversation();
    assert.notEqual(agent.store.data.id, oldId);
    assert.equal(agent.config, s.config); assert.equal(agent.provider, provider);
    assert.equal(agent.store.data.messages.length, 0);
    assert.deepEqual(agent.tools.definitions().map(t => t.name), ['read']);
    const previous = await SessionStore.resume(s.home, oldId);
    try { assert.equal(previous.store.data.messages[0].content, 'old question'); } finally { await previous.store.close(); }
    assert.equal((await agent.run('new question', new AbortController().signal)).ok, true);
  } finally { await agent.store.close(); await s.cleanup(); }
});

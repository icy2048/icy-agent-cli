import test from 'node:test';
import assert from 'node:assert/strict';
import React, { useState } from 'react';
import { render } from 'ink-testing-library';
import { Composer } from '../src/ui/Composer.js';
import { App, type ApprovalBridge } from '../src/ui/App.js';
import type { Agent } from '../src/core/agent.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 35));

test('composer preserves Chinese/emoji and multiline paste, and ignores global shortcuts', async () => {
  let latest = '', submitted = '';
  function Harness() {
    const [value, setValue] = useState('');
    return React.createElement(Composer, { value, width: 40, onChange: (v: string) => { latest = v; setValue(v); }, onSubmit: (v: string) => { submitted = v; } });
  }
  const ui = render(React.createElement(Harness));
  try {
    await tick(); ui.stdin.write('你好🙂'); await tick(); assert.equal(latest, '你好🙂');
    ui.stdin.write('\x7f'); await tick(); assert.equal(latest, '你好');
    ui.stdin.write('\x0f'); await tick(); assert.equal(latest, '你好');
    ui.stdin.write('\x1b[200~\n第二行\x1b[201~'); await tick(); assert.equal(latest, '你好\n第二行'); assert.equal(submitted, '');
    ui.stdin.write('\r'); await tick(); assert.equal(submitted, '你好\n第二行');
  } finally { ui.unmount(); ui.cleanup(); }
});

test('Workbench switches to one column and long approvals require paging through full command', async () => {
  const bridge: ApprovalBridge = {};
  const agent = { config: { cwd: '/fixture', model: 'test', baseUrl: 'http://localhost', permissions: 'workspace-edit' }, store: { data: { id: 'fixture-session', messages: [] } }, setListener: () => {} } as unknown as Agent;
  const ui = render(React.createElement(App, { agent, approval: bridge }));
  try {
    await tick(); assert.doesNotMatch(ui.lastFrame()!, /CURRENT TASK/);
    Object.defineProperty(ui.stdout, 'columns', { configurable: true, value: 120 }); ui.stdout.emit('resize'); await tick(); assert.match(ui.lastFrame()!, /CURRENT TASK/);
    Object.defineProperty(ui.stdout, 'columns', { configurable: true, value: 80 }); ui.stdout.emit('resize'); await tick(); assert.doesNotMatch(ui.lastFrame()!, /CURRENT TASK/);
    let approved = false;
    const decision = bridge.current!({ command: 'printf long-command; '.repeat(100) + 'echo END_OF_COMMAND', cwd: '/fixture', timeoutMs: 1000 }, new AbortController().signal).then(v => { approved = true; return v; });
    await tick(); assert.match(ui.lastFrame()!, /允许执行命令/); ui.stdin.write('y'); await tick(); assert.equal(approved, false);
    for (let i = 0; i < 30; i++) {
      const match = ui.lastFrame()!.match(/命令预览 (\d+)\/(\d+)/); assert.ok(match);
      if (match[1] === match[2]) break;
      ui.stdin.write('\x1b[6~'); await tick();
    }
    assert.match(ui.lastFrame()!, /END_OF_COMMAND/); ui.stdin.write('y'); await tick(); assert.equal(await decision, 'once');
  } finally { ui.unmount(); ui.cleanup(); }
});

test('slash menu filters, selects, completes and dismisses without invoking the model', async () => {
  let modelRuns = 0;
  const agent = { config: { cwd: '/fixture', model: 'menu-model', provider: 'responses', baseUrl: 'http://localhost', permissions: 'workspace-edit' }, store: { data: { id: 'fixture', messages: [] } }, setListener: () => {}, run: async () => { modelRuns++; } } as unknown as Agent;
  const ui = render(React.createElement(App, { agent, approval: {}, configureServices: { discover: async () => [], list: async () => [], verify: async () => {} } }));
  try {
    await tick(); ui.stdin.write('/'); await tick();
    assert.match(ui.lastFrame()!, /❯ \/help/); assert.match(ui.lastFrame()!, /Tab 补全/);
    ui.stdin.write('\x1b[B'); await tick(); assert.match(ui.lastFrame()!, /❯ \/model/);
    ui.stdin.write('\r'); await tick(); assert.match(ui.lastFrame()!, /模型设置/); assert.match(ui.lastFrame()!, /menu-model · responses/); assert.equal(modelRuns, 0);
    ui.stdin.write('\x1b'); await tick();
    ui.stdin.write('/th'); await tick(); assert.match(ui.lastFrame()!, /❯ \/thinking/); assert.doesNotMatch(ui.lastFrame()!, /❯ \/help/);
    ui.stdin.write('\t'); await tick(); assert.match(ui.lastFrame()!, /\/thinking expanded/); assert.match(ui.lastFrame()!, /\/thinking collapsed/);
    ui.stdin.write('\x1b'); await tick(); assert.doesNotMatch(ui.lastFrame()!, /Tab 补全/);
    ui.stdin.write('\x15'); await tick(); ui.stdin.write('/unknown'); await tick(); ui.stdin.write('\r'); await tick();
    assert.match(ui.lastFrame()!, /未知命令/); assert.equal(modelRuns, 0);
  } finally { ui.unmount(); ui.cleanup(); }
});

test('thinking streams separately, collapses without content leakage and persists display preference', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const home = await mkdtemp(join(tmpdir(), 'icy-ui-'));
  const saved = async (expected: boolean) => {
    for (let i = 0; i < 60; i++) {
      try { if (JSON.parse(await readFile(join(home, 'ui.json'), 'utf8')).thinkingExpanded === expected) return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await tick();
    }
    assert.fail('Display preference was not persisted');
  };
  let listener: (event: import('../src/core/types.js').AgentEvent) => void = () => {};
  const agent = { config: { home, cwd: '/fixture', model: 'test', baseUrl: 'http://localhost', permissions: 'workspace-edit' }, store: { data: { id: 'fixture', messages: [] } }, setListener: (next: typeof listener) => { listener = next; } } as unknown as Agent;
  const ui = render(React.createElement(App, { agent, approval: {}, configureServices: { discover: async () => [], list: async () => [], verify: async () => {} } }));
  try {
    await tick(); listener({ type: 'user', text: '用户问题' }); listener({ type: 'turn', turn: 1 }); listener({ type: 'reasoning_delta', text: '可见摘要片段' }); await tick();
    assert.match(ui.lastFrame()!, /▸ 思考/); assert.doesNotMatch(ui.lastFrame()!, /可见摘要片段/);
    ui.stdin.write('\x14'); await tick(); assert.match(ui.lastFrame()!, /▾ 思考/); assert.match(ui.lastFrame()!, /可见摘要片段/);
    await saved(true);
    listener({ type: 'reasoning', text: '可见摘要片段，已完成。' }); listener({ type: 'assistant', text: '最终答案' }); listener({ type: 'done', reason: 'completed', ok: true }); await tick();
    assert.match(ui.lastFrame()!, /最终答案/); assert.match(ui.lastFrame()!, /▾ 思考/); assert.doesNotMatch(ui.lastFrame()!, /(?:you|icy)  /);
    ui.stdin.write('\x14'); await tick(); assert.doesNotMatch(ui.lastFrame()!, /可见摘要片段/); assert.match(ui.lastFrame()!, /最终答案/);
    await saved(false);
    listener({ type: 'turn', turn: 2 }); listener({ type: 'reasoning', text: '' }); ui.stdin.write('\x14'); await tick();
    assert.match(ui.lastFrame()!, /本次接口未返回可见思考内容/);
    listener({ type: 'turn', turn: 3 }); listener({ type: 'done', reason: 'cancelled', ok: false }); await tick(); assert.match(ui.lastFrame()!, /已中断/); await saved(true);
  } finally { ui.unmount(); ui.cleanup(); await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});

test('message blocks use distinct color rails without full-width backgrounds and fit CJK/emoji text', async () => {
  const { entryLines } = await import('../src/ui/transcript.js');
  const { default: stringWidth } = await import('string-width');
  const user = entryLines({ kind: 'user', text: '你好🙂'.repeat(20) }, 30, false, false);
  const assistant = entryLines({ kind: 'assistant', text: '答复' }, 30, false, false);
  assert.notEqual(user[0].markerColor, assistant[0].markerColor);
  assert.equal(assistant[0].backgroundColor, undefined);
  assert.deepEqual(entryLines({ kind: 'thinking', text: '', active: false }, 30, false, false), []);
  for (const line of user.slice(0, -1)) assert.ok(stringWidth((line.marker || '') + line.text) <= 30);
  assert.doesNotMatch(user.map(l => l.text).join(''), /you/);
  assert.doesNotMatch(assistant.map(l => l.text).join(''), /icy/);
});

test('cachedEntryLines reuses wrapped lines until width changes', async () => {
  const { cachedEntryLines } = await import('../src/ui/transcript.js');
  const entry = { kind: 'user' as const, text: '你好🙂'.repeat(20) };
  const a = cachedEntryLines(entry, 30, false, false);
  const b = cachedEntryLines(entry, 30, false, false);
  assert.equal(a, b);
  const c = cachedEntryLines(entry, 12, false, false);
  assert.notEqual(c, a);
  assert.ok(c.length > a.length);
});

test('model wizard imports a service, searches models, tests then applies without leaking the key', async () => {
  const { ModelWizard } = await import('../src/ui/ModelWizard.js');
  const secret = 'a-secret-that-must-not-render';
  let applied = '', verified = false;
  const config = { model: 'old', baseUrl: 'http://localhost', provider: 'responses', apiKey: '' } as import('../src/config/load.js').Config;
  const ui = render(React.createElement(ModelWizard, { config, width: 80, onClose: () => {}, onApply: async p => { assert.equal(verified, true); applied = p.model; }, services: {
    discover: async () => [{ name: 'Imported', model: 'initial', provider: 'responses' as const, baseUrl: 'https://example.test', apiKey: secret }],
    list: async () => ['target-model', 'other-model'], verify: async () => { verified = true; },
  } }));
  try {
    await tick(); await tick(); assert.match(ui.lastFrame()!, /Imported/);
    ui.stdin.write('\r'); await tick(); await tick(); assert.match(ui.lastFrame()!, /target-model/);
    ui.stdin.write('target'); await tick(); ui.stdin.write('\r'); await tick(); assert.match(ui.lastFrame()!, /测试连接并启用/);
    assert.equal(verified, false); ui.stdin.write('\r'); await tick(); assert.equal(applied, 'target-model');
    for (const frame of ui.frames) assert.doesNotMatch(frame, new RegExp(secret));
  } finally { ui.unmount(); ui.cleanup(); }
});

test('manual model setup masks the API key and failed validation does not apply settings', async () => {
  const { ModelWizard } = await import('../src/ui/ModelWizard.js');
  let applies = 0;
  const secret = 'manual-secret-123';
  const ui = render(React.createElement(ModelWizard, { config: { apiKey: '', model: '', provider: 'responses' } as import('../src/config/load.js').Config, width: 80, onClose: () => {}, onApply: async () => { applies++; }, services: {
    discover: async () => [], list: async () => { throw new Error('model list unavailable'); }, verify: async () => { throw new Error('invalid credentials'); },
  } }));
  try {
    await tick(); ui.stdin.write('\r'); await tick();
    ui.stdin.write('https://example.test/v1'); await tick(); ui.stdin.write('\r'); await tick();
    ui.stdin.write(secret); await tick(); assert.match(ui.lastFrame()!, /•/); assert.doesNotMatch(ui.lastFrame()!, /manual-secret/);
    ui.stdin.write('\r'); await tick(); ui.stdin.write('\r'); await tick(); await tick();
    assert.match(ui.lastFrame()!, /手动输入模型名/); ui.stdin.write('\r'); await tick();
    ui.stdin.write('test-model'); await tick(); ui.stdin.write('\r'); await tick(); ui.stdin.write('\r'); await tick();
    assert.match(ui.lastFrame()!, /invalid credentials/); assert.equal(applies, 0);
    for (const frame of ui.frames) assert.doesNotMatch(frame, /manual-secret/);
  } finally { ui.unmount(); ui.cleanup(); }
});

test('/new is selectable and resets the transcript and counters without calling the model', async () => {
  let created = 0;
  const agent = {
    config: { cwd: '/fixture', model: 'same-model', baseUrl: 'http://localhost', permissions: 'workspace-edit' },
    store: { data: { id: 'old-session', messages: [{ role: 'user', content: 'previous conversation' }] } },
    setListener: () => {}, newConversation: async () => { created++; },
    run: async () => { assert.fail('/new must not be sent to the model'); },
  } as unknown as Agent;
  const ui = render(React.createElement(App, { agent, approval: {} }));
  try {
    await tick(); assert.match(ui.lastFrame()!, /previous conversation/);
    ui.stdin.write('/n'); await tick(); assert.match(ui.lastFrame()!, /❯ \/new/);
    ui.stdin.write('\r'); await tick(); await tick();
    assert.equal(created, 1); assert.doesNotMatch(ui.lastFrame()!, /previous conversation/);
    assert.match(ui.lastFrame()!, /新对话已开启/); assert.match(ui.lastFrame()!, /same-model/); assert.match(ui.lastFrame()!, /turn 0/);
  } finally { ui.unmount(); ui.cleanup(); }
});

test('describeCall summarizes tool calls and diffs', async () => {
  const { describeCall, entryLines } = await import('../src/ui/transcript.js');
  assert.equal(describeCall({ id: '1', name: 'read', arguments: JSON.stringify({ path: 'README.md' }) }), 'read README.md');
  const diff = '--- a/src/ui/App.tsx\n+++ b/src/ui/App.tsx\n@@ -1,1 +1,3 @@\n-old\n+new1\n+new2\n+new3';
  assert.equal(describeCall({ id: '2', name: 'edit', arguments: JSON.stringify({ path: 'src/ui/App.tsx' }) }, { ok: true, content: '', durationMs: 5, diff }), 'edit src/ui/App.tsx +3 −1');
  const tricky = '--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n---minus\n+++plus';
  assert.match(describeCall({ id: '5', name: 'write', arguments: JSON.stringify({ path: 'x' }) }, { ok: true, content: '', durationMs: 5, diff: tricky }), /\+1 −1$/);
  const command = `echo ${'x'.repeat(70)}\n\t tail`;
  const summary = describeCall({ id: '3', name: 'bash', arguments: JSON.stringify({ command }) });
  const commandPart = summary.slice('bash '.length);
  assert.equal(commandPart.length, 60);
  assert.match(commandPart, /…$/);
  assert.equal(describeCall({ id: '4', name: 'read', arguments: '{not json' }), 'read');
  assert.match(entryLines({ kind: 'tool', text: '', call: { id: '2', name: 'edit', arguments: JSON.stringify({ path: 'src/ui/App.tsx' }) }, result: { ok: true, content: '', durationMs: 5, diff } }, 80, false, false)[0].text, /✓ edit src\/ui\/App\.tsx \+3 −1 \(5ms\)/);
});

test('Esc after slash clears the input before submit', async () => {
  let received = '';
  const agent = { config: { cwd: '/fixture', model: 'test', baseUrl: 'http://localhost', permissions: 'workspace-edit' }, store: { data: { id: 'fixture', messages: [] } }, setListener: () => {}, run: async (value: string) => { received = value; } } as unknown as Agent;
  const ui = render(React.createElement(App, { agent, approval: {} }));
  try {
    await tick(); ui.stdin.write('/'); await tick(); ui.stdin.write('\x1b'); await tick();
    ui.stdin.write('abc'); await tick(); ui.stdin.write('\r'); await tick(); await tick();
    assert.equal(received, 'abc');
  } finally { ui.unmount(); ui.cleanup(); }
});

test('running line shows a spinner and elapsed seconds', async () => {
  let finished = false;
  const agent = { config: { cwd: '/fixture', model: 'test', baseUrl: 'http://localhost', permissions: 'workspace-edit' }, store: { data: { id: 'fixture', messages: [] } }, setListener: () => {}, run: async () => { await new Promise(resolve => setTimeout(resolve, 250)); finished = true; } } as unknown as Agent;
  const ui = render(React.createElement(App, { agent, approval: {} }));
  try {
    await tick(); ui.stdin.write('hello'); await tick(); ui.stdin.write('\r'); await tick();
    const running = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] .*\d+s · Esc 取消/;
    let frame = '', matched = false;
    for (let i = 0; i < 20; i++) { await tick(); frame = ui.lastFrame()!; if (running.test(frame)) { matched = true; break; } }
    assert.ok(matched);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(finished, true);
  } finally { ui.unmount(); ui.cleanup(); }
});

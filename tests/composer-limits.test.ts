import test from 'node:test';
import assert from 'node:assert/strict';
import React, { useState } from 'react';
import { render } from 'ink-testing-library';
import { Composer, MAX_INPUT_GRAPHEMES } from '../src/ui/Composer.js';

const tick = () => new Promise(resolve => setTimeout(resolve, 35));
const paste = (text: string) => `\x1b[200~${text}\x1b[201~`;

function setup(initial: string, secret = false) {
  const state = { draft: initial, changes: 0, submitted: [] as string[] };
  function Harness() {
    const [value, setValue] = useState(initial);
    return React.createElement(Composer, {
      value, width: 72, secret,
      onChange: (next: string) => { state.draft = next; state.changes++; setValue(next); },
      onSubmit: (next: string) => { state.submitted.push(next); },
    });
  }
  const ui = render(React.createElement(Harness));
  return { ui, state, close: () => { ui.unmount(); ui.cleanup(); } };
}

test('composer accepts and submits exactly 20,000 graphemes', async () => {
  const initial = 'a'.repeat(MAX_INPUT_GRAPHEMES - 1);
  const { ui, state, close } = setup(initial);
  try {
    await tick(); ui.stdin.write('z'); await tick();
    assert.equal(state.draft, initial + 'z');
    assert.doesNotMatch(ui.lastFrame()!, /超限输入未接收/);
    ui.stdin.write('\r'); await tick();
    assert.deepEqual(state.submitted, [initial + 'z']);
  } finally { close(); }
});

test('oversize multiline paste keeps the draft and blocks Enter until an actual edit', async () => {
  const initial = '原草稿：保留全部要求。';
  const { ui, state, close } = setup(initial);
  try {
    await tick();
    ui.stdin.write(paste('新增要求\n' + 'x'.repeat(MAX_INPUT_GRAPHEMES) + '\n最后必须运行测试。'));
    // Even an Enter queued immediately after the paste cannot submit the old draft.
    ui.stdin.write('\r'); await tick();
    assert.equal(state.draft, initial); assert.equal(state.changes, 0);
    assert.deepEqual(state.submitted, []);
    assert.match(ui.lastFrame()!, /20,000/); assert.match(ui.lastFrame()!, /原草稿保留/);
    ui.stdin.write('\x05'); await tick(); // Ctrl+E only moves the cursor.
    ui.stdin.write('\x0b'); await tick(); // Ctrl+K at the end changes nothing.
    ui.stdin.write('\r'); await tick();
    assert.deepEqual(state.submitted, []);
    ui.stdin.write('\x7f'); await tick();
    assert.equal(state.draft, initial.slice(0, -1));
    assert.doesNotMatch(ui.lastFrame()!, /超限输入未接收/);
    ui.stdin.write('！'); await tick(); ui.stdin.write('\r'); await tick();
    assert.deepEqual(state.submitted, [initial.slice(0, -1) + '！']);
  } finally { close(); }
});

test('oversize typed input preserves the cursor and rejects the entire edit', async () => {
  const initial = '头' + 'a'.repeat(MAX_INPUT_GRAPHEMES - 2) + '尾';
  const { ui, state, close } = setup(initial);
  try {
    await tick(); ui.stdin.write('\x01'); await tick(); // Ctrl+A
    ui.stdin.write('新增'); await tick();
    assert.equal(state.draft, initial); assert.equal(state.changes, 0);
    ui.stdin.write('\r'); await tick(); assert.deepEqual(state.submitted, []);
    ui.stdin.write('\x1b[C'); await tick(); // Move past the original first grapheme.
    ui.stdin.write('\x7f'); await tick();
    assert.equal(state.draft, initial.slice(1));
    ui.stdin.write('新'); await tick(); ui.stdin.write('\r'); await tick();
    assert.deepEqual(state.submitted, ['新' + initial.slice(1)]);
  } finally { close(); }
});

test('CJK, combining marks and joined emoji use grapheme boundaries at the limit', async () => {
  const prefix = '中'.repeat(MAX_INPUT_GRAPHEMES - 2);
  const family = '👨‍👩‍👧‍👦', astronaut = '👩🏽‍🚀';
  const { ui, state, close } = setup(prefix + 'e');
  try {
    await tick(); ui.stdin.write(paste('\u0301' + family)); await tick();
    const complete = prefix + 'e\u0301' + family;
    assert.equal(state.draft, complete);
    assert.ok(state.draft.length > MAX_INPUT_GRAPHEMES);
    ui.stdin.write(astronaut); await tick();
    assert.equal(state.draft, complete);
    assert.match(ui.lastFrame()!, /超限输入未接收/);
    ui.stdin.write('\r'); await tick(); assert.deepEqual(state.submitted, []);
    ui.stdin.write('\x7f'); await tick();
    assert.equal(state.draft, prefix + 'e\u0301');
    ui.stdin.write(paste(astronaut)); await tick(); ui.stdin.write('\r'); await tick();
    assert.deepEqual(state.submitted, [prefix + 'e\u0301' + astronaut]);
  } finally { close(); }
});

test('a combining mark can extend the final grapheme of a full draft', async () => {
  const initial = '中'.repeat(MAX_INPUT_GRAPHEMES - 1) + 'e';
  const { ui, state, close } = setup(initial);
  try {
    await tick(); ui.stdin.write('\u0301'); await tick();
    assert.equal(state.draft, initial + '\u0301');
    ui.stdin.write('\r'); await tick();
    assert.deepEqual(state.submitted, [initial + '\u0301']);
  } finally { close(); }
});

test('oversize secret input shows the limit without exposing either input', async () => {
  const initial = 'private-draft-needle', extra = 'private-paste-needle';
  const { ui, state, close } = setup(initial, true);
  try {
    await tick(); ui.stdin.write(paste(extra.repeat(1100))); await tick();
    ui.stdin.write('\r'); await tick();
    assert.equal(state.draft, initial); assert.deepEqual(state.submitted, []);
    assert.match(ui.lastFrame()!, /20,000/); assert.match(ui.lastFrame()!, /原草稿保留/);
    for (const frame of ui.frames) {
      assert.doesNotMatch(frame, new RegExp(initial));
      assert.doesNotMatch(frame, new RegExp(extra));
    }
  } finally { close(); }
});

test('an oversized external draft cannot be submitted until shortened', async () => {
  const initial = 'a'.repeat(MAX_INPUT_GRAPHEMES + 1);
  const { ui, state, close } = setup(initial);
  try {
    await tick(); ui.stdin.write('\r'); await tick();
    assert.deepEqual(state.submitted, []); assert.equal(state.draft, initial);
    ui.stdin.write('\x7f'); await tick(); ui.stdin.write('\r'); await tick();
    assert.deepEqual(state.submitted, [initial.slice(0, -1)]);
  } finally { close(); }
});

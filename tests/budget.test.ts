import test from 'node:test';
import assert from 'node:assert/strict';
import { Budget, estimateInputTokens } from '../src/core/budget.js';

test('budget reserves estimated input and exposes all remaining output capacity without charging it', () => {
  const budget = new Budget(100000);
  assert.deepEqual(budget.requestOptions(10000), { maxOutputTokens: 95000 });
  assert.deepEqual(budget.requestOptions(10000, 2048), { maxOutputTokens: 2048 });
  assert.equal(budget.remaining, 100000);
  budget.recordPreprocessing(1500, false);
  assert.deepEqual(budget.requestOptions(10000), { maxOutputTokens: 93500 });
  assert.equal(budget.requestOptions(197000), undefined);
  assert.deepEqual(budget.requestOptions(196998), { maxOutputTokens: 1 });
  assert.equal(budget.stopReason(), undefined);
});

test('preprocessing and model usage share one budget with structured totals and cached input', () => {
  const budget = new Budget(1000);
  budget.recordPreprocessing(99, false, { totalTokens: 100, inputTokens: 70, outputTokens: 30, cachedInputTokens: 20 });
  const snapshot = budget.record({ text: 'done', calls: [], tokens: 999, usage: { totalTokens: 200, inputTokens: 120, outputTokens: 80, cachedInputTokens: 50 } }, 5000);
  assert.deepEqual(snapshot, {
    tokens: 300, estimated: false, modelTokens: 200, preprocessingTokens: 100,
    usage: { totalTokens: 300, inputTokens: 190, outputTokens: 110, cachedInputTokens: 70 },
  });
  assert.equal(budget.remaining, 700);
});

test('legacy total usage stays reported while absent component counts stay unknown', () => {
  const budget = new Budget(1000);
  budget.record({ text: 'x', calls: [], tokens: 25 }, 200);
  const snapshot = budget.record({ text: 'x', calls: [], usage: { totalTokens: 100, inputTokens: 70, outputTokens: 30, cachedInputTokens: 10 } }, 200);
  assert.equal(snapshot.estimated, false);
  assert.deepEqual(snapshot.usage, { totalTokens: 125 });
});

test('missing or invalid usage estimates input, answer, reasoning and calls, and keeps estimate status', () => {
  const budget = new Budget(10000);
  const completion = { text: 'done', reasoning: 'checking', calls: [{ id: 'a', name: 'read', arguments: '{}' }], tokens: Number.NaN };
  const expected = estimateInputTokens(101) + estimateInputTokens(completion.text.length + completion.reasoning.length + JSON.stringify(completion.calls).length);
  const first = budget.record(completion, 101);
  assert.equal(first.tokens, expected); assert.equal(first.estimated, true);
  const second = budget.record({ text: 'done', calls: [], tokens: 12 }, 0);
  assert.equal(second.tokens, expected + 12); assert.equal(second.estimated, true);
  assert.deepEqual(second.usage, { totalTokens: expected + 12 });
});

test('exact exhaustion and response overshoot produce distinct stop reasons even for text-only replies', () => {
  const exact = new Budget(1000);
  exact.record({ text: 'done', calls: [], tokens: 1000 }, 1);
  assert.equal(exact.stopReason(), 'token_budget'); assert.equal(exact.requestOptions(0), undefined);
  const exceeded = new Budget(1000);
  exceeded.recordPreprocessing(100, false);
  exceeded.record({ text: 'done', calls: [], tokens: 5000 }, 1);
  assert.equal(exceeded.stopReason(), 'budget_exceeded'); assert.equal(exceeded.remaining, 0);
  assert.equal(exceeded.requestOptions(0), undefined); assert.equal(exceeded.snapshot().tokens, 5100);
});

test('skipped preprocessing preserves known component usage while estimated failed preprocessing is charged', () => {
  const budget = new Budget(1000);
  budget.recordPreprocessing(0, false);
  budget.record({ text: 'done', calls: [], usage: { totalTokens: 20, inputTokens: 12, outputTokens: 8 } }, 1);
  assert.deepEqual(budget.snapshot().usage, { totalTokens: 20, inputTokens: 12, outputTokens: 8 });
  budget.recordPreprocessing(200, true);
  assert.equal(budget.snapshot().tokens, 220); assert.equal(budget.snapshot().estimated, true);
  assert.equal(budget.snapshot().preprocessingTokens, 200);
  assert.deepEqual(budget.snapshot().usage, { totalTokens: 220 });
});

test('invalid limits and counts are rejected before a request can be made', () => {
  for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) assert.throws(() => new Budget(value), /Invalid token budget/);
  const budget = new Budget(100);
  assert.throws(() => budget.requestOptions(-1), /Invalid input/);
  assert.throws(() => budget.requestOptions(1, 0), /Invalid output/);
  assert.throws(() => budget.recordPreprocessing(Number.NaN, true), /Invalid preprocessing/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config/load.js';
import { preparePrompt, modelMessage } from '../src/core/harness.js';
import { SessionStore } from '../src/sessions/store.js';
import type { Config } from '../src/config/load.js';
import type { Message } from '../src/core/types.js';

const fixtures: { id: string; input: string; required: string[]; lossy: string; untrusted?: string }[] = JSON.parse(await readFile(new URL('../evals/prompt-fidelity.json', import.meta.url), 'utf8'));
const controller = () => new AbortController().signal;

test('default local mode preserves complete requirements without a preprocessing request', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'icy-fidelity-'));
  const oldHome = process.env.ICY_HOME; process.env.ICY_HOME = home;
  let store: SessionStore | undefined;
  try {
    const config = await loadConfig(home);
    assert.equal(config.promptCompaction, 'local');
    store = await SessionStore.create(home, config);
    for (const fixture of fixtures) {
      const result = await preparePrompt([{ role: 'user', content: fixture.input }], config, store, controller(), () => { throw new Error('local mode must not call a model'); });
      assert.equal(result.messages[0].content, fixture.input);
      assert.equal(result.stats.preprocessingTokens, 0);
    }
    for (const mode of ['off', 'model']) {
      await writeFile(path.join(home, 'config.json'), JSON.stringify({ promptCompaction: mode }));
      assert.equal((await loadConfig(home)).promptCompaction, mode);
    }
  } finally {
    if (oldHome === undefined) delete process.env.ICY_HOME; else process.env.ICY_HOME = oldHome;
    await store?.close(); await rm(home, { recursive: true, force: true });
  }
});

test('lossy refinement cannot remove source objectives, ordering or quoted-data boundaries from model input', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'icy-fidelity-'));
  const config: Config = { home, cwd: home, provider: 'responses', baseUrl: 'https://example.test', model: 'fixture', apiKey: '', apiKeyEnv: 'ICY_API_KEY', permissions: 'read-only', promptCompaction: 'model', compactionMinChars: 0, maxModelTurns: 20, maxToolCalls: 50, maxTokens: 100000, maxContextChars: 120000, requestTimeoutMs: 1000 };
  const store = await SessionStore.create(home, config);
  try {
    for (const fixture of fixtures) {
      const user: Message = { role: 'user', content: fixture.input };
      const result = await preparePrompt([user], config, store, controller(), () => ({ async complete() {
        return { text: JSON.stringify({ prompt: fixture.lossy, keywords: [], constraints: [] }), calls: [], tokens: 7 };
      } }));
      const envelope = JSON.parse(result.messages[0].content);
      const authoritative = envelope.original ?? envelope.task;
      assert.equal(authoritative, fixture.input, fixture.id);
      for (const requirement of fixture.required) assert.ok(authoritative.includes(requirement), `${fixture.id}: ${requirement}`);
      if (fixture.untrusted) assert.ok(!envelope.constraints.includes(fixture.untrusted));
      assert.equal(user.content, fixture.input);
      // Cached legacy/refined requests also derive the authoritative original at send time.
      assert.deepEqual(JSON.parse(modelMessage(user, true, true).content), envelope);
      const cached = await preparePrompt([user], config, store, controller(), () => { throw new Error('cached request must not refine again'); });
      assert.equal(cached.messages[0].content, result.messages[0].content);
    }
  } finally { await store.close(); await rm(home, { recursive: true, force: true }); }
});

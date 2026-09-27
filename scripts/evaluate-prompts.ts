import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { preparePrompt } from '../src/core/harness.js';
import { loadConfig } from '../src/config/load.js';
import { SessionStore } from '../src/sessions/store.js';
import type { Config } from '../src/config/load.js';

// Offline by default. --live uses only these synthetic prompts and the configured
// compaction service; no workspace files or host tools are sent to the service.
const live = process.argv.includes('--live');
const fixtures: { id: string; input: string; required: string[]; lossy: string }[] = JSON.parse(await readFile(new URL('../evals/prompt-fidelity.json', import.meta.url), 'utf8'));
const home = await mkdtemp(path.join(tmpdir(), 'icy-prompt-eval-'));
const config: Config = live ? await loadConfig(process.cwd()) : { home, cwd: home, provider: 'chat-completions', baseUrl: 'https://example.test', model: 'fixture', apiKey: '', apiKeyEnv: 'ICY_API_KEY', permissions: 'read-only', maxModelTurns: 20, maxToolCalls: 50, maxTokens: 100000, maxContextChars: 120000, requestTimeoutMs: 1000, compactionMinChars: 0 };
const store = await SessionStore.create(home, { ...config, cwd: home });
const rows = [];
try {
  for (const mode of ['off', 'local', 'model'] as const) {
    for (const fixture of fixtures) {
      const start = performance.now();
      const result = await preparePrompt([{ role: 'user', content: fixture.input }], { ...config, promptCompaction: mode, compactionMinChars: 0 }, store, new AbortController().signal, live ? undefined : () => ({ async complete() {
        return { text: JSON.stringify({ prompt: fixture.lossy, keywords: [], constraints: [] }), calls: [], tokens: 7 };
      } }));
      const wire = result.messages[0].content;
      const envelope = mode === 'model' ? JSON.parse(wire) : undefined;
      const source: string = envelope ? envelope.original ?? envelope.task : wire;
      rows.push({ id: fixture.id, mode, sourceRetained: source === fixture.input, missingRequirements: fixture.required.filter(r => !source.includes(r)), modelInputChars: wire.length, preprocessingTokens: result.stats.preprocessingTokens, estimated: result.stats.preprocessingEstimated, semantic: result.stats.semantic, durationMs: Math.round(performance.now() - start) });
    }
  }
  console.log(JSON.stringify({ kind: live ? 'live-preprocessing' : 'deterministic-adversarial-fixture', note: 'Measures source retention and preprocessing overhead, not autonomous task success or semantic equivalence.', rows }, null, 2));
  if (rows.some(r => !r.sourceRetained || r.missingRequirements.length)) process.exitCode = 1;
} finally { await store.close(); await rm(home, { recursive: true, force: true }); }

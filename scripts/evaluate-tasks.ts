import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { ModelProvider } from '../src/providers/model.js';
import { Agent } from '../src/core/agent.js';
import { SessionStore } from '../src/sessions/store.js';
import { ToolRegistry } from '../src/tools/registry.js';

if (!process.argv.includes('--live')) throw new Error('Use --live to run the configured model against synthetic temporary workspaces. This consumes model tokens.');
const base = await loadConfig(process.cwd());
if (!base.model || !base.apiKey) throw new Error('Configure a model and credentials before running the live evaluation.');
const fixtures = [
  { id: 'ordered-edit', input: '先读取 README.md 和 input.txt，然后把 input.txt 中的 before 精确替换为 after，最后用 bash 执行 node verify.cjs 验证。不要修改 verify.cjs 和 untouched.txt；没有通过验证就报告失败，不要声称任务完成。', files: { 'README.md': 'The task file is input.txt. Preserve the sentinel.\n', 'input.txt': 'before\n', 'untouched.txt': 'keep\n' }, expected: { 'input.txt': 'after\n', 'untouched.txt': 'keep\n' } },
  { id: 'conditional-exception', input: '读取 config.json。如果 cache 是 false，就把 timeout 从 30 改为 45；否则不改 timeout。保留其他字段、label 的中文和值类型。不要改 verify.cjs。最后通过 bash 执行 node verify.cjs，并报告实际验证结果。', files: { 'config.json': '{"cache":false,"timeout":30,"label":"保持中文"}\n' }, expectedJson: { 'config.json': { cache: false, timeout: 45, label: '保持中文' } } },
  { id: 'cross-file', input: '读取 greeting.txt 和 guide.txt，然后把两份文件中的 hello 改为 你好。保留 keep.txt 内容及原有换行。不要修改 verify.cjs。两个文件都处理完以后，使用 bash 执行 node verify.cjs，并在结论中说明修改文件及测试结果。', files: { 'greeting.txt': 'hello\n', 'guide.txt': 'message: hello\n', 'keep.txt': 'untouched\n' }, expected: { 'greeting.txt': '你好\n', 'guide.txt': 'message: 你好\n', 'keep.txt': 'untouched\n' } },
];
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'icy-live-eval-')));
const results: Record<string, unknown>[] = [];
try {
  for (const mode of ['off', 'local', 'model'] as const) for (const fixture of fixtures) {
    const cwd = path.join(root, mode, fixture.id), home = path.join(cwd, 'home');
    await mkdir(cwd, { recursive: true });
    for (const [name, contents] of Object.entries(fixture.files)) await writeFile(path.join(cwd, name), contents!);
    const verifier = `const fs=require('node:fs'),assert=require('node:assert/strict');\nconst text=${JSON.stringify(fixture.expected ?? {})};\nfor(const [p,v] of Object.entries(text))assert.equal(fs.readFileSync(p,'utf8'),v);\nconst json=${JSON.stringify(fixture.expectedJson ?? {})};\nfor(const [p,v] of Object.entries(json))assert.deepEqual(JSON.parse(fs.readFileSync(p,'utf8')),v);\nconsole.log('fixture checks passed');\n`;
    await writeFile(path.join(cwd, 'verify.cjs'), verifier);
    const config = { ...base, cwd, home, permissions: 'workspace-edit' as const, promptCompaction: mode, compactionMinChars: 0, reasoningEffort: 'low' as const, requestTimeoutMs: 30000 };
    const store = await SessionStore.create(home, config, [config.apiKey]);
    const started = performance.now(); let approvedChecks = 0;
    const tools = new ToolRegistry(config, store, async request => request.cwd === cwd && request.command.trim() === 'node verify.cjs' ? (approvedChecks++, 'once') : 'deny');
    try {
      const run = await new Agent(config, new ModelProvider(config), tools, store).run(fixture.input, AbortSignal.timeout(60000));
      let outputCorrect = true;
      for (const [name, expected] of Object.entries(fixture.expected ?? {})) outputCorrect &&= await readFile(path.join(cwd, name), 'utf8') === expected;
      for (const [name, expected] of Object.entries(fixture.expectedJson ?? {})) {
        try {
          const actual = JSON.parse(await readFile(path.join(cwd, name), 'utf8'));
          outputCorrect &&= Object.keys(actual).length === Object.keys(expected!).length && Object.entries(expected!).every(([key, value]) => actual[key] === value);
        } catch { outputCorrect = false; }
      }
      const verifierPreserved = await readFile(path.join(cwd, 'verify.cjs'), 'utf8') === verifier;
      const toolResults = store.data.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
      const checked = approvedChecks > 0 && toolResults.some(result => result.ok && result.content.includes('fixture checks passed'));
      const usage = store.data.runs.at(-1)?.usage;
      results.push({ id: fixture.id, mode, ok: run.ok && outputCorrect && verifierPreserved && checked, runReason: run.reason, outputCorrect, verifierPreserved, checked, usage, durationMs: Math.round(performance.now() - started) });
      process.stderr.write(`${mode}/${fixture.id}: ${results.at(-1)!.ok ? 'passed' : 'failed'} (${run.reason})\n`);
    } finally { await store.close(); }
  }
  console.log(JSON.stringify({ kind: 'live-synthetic-tasks', model: base.model, provider: base.provider, reasoningEffort: 'low', budget: { maxTokens: base.maxTokens, maxModelTurns: base.maxModelTurns, maxToolCalls: base.maxToolCalls }, repetitions: 1, note: 'A small smoke baseline; not a statistically reliable success-rate comparison. Only synthetic temporary files and the exact verification command were authorized.', results }, null, 2));
  if (results.some(result => !result.ok)) process.exitCode = 1;
} finally { await rm(root, { recursive: true, force: true }); }

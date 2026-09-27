import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deepStrictEqual } from 'node:assert';
import { loadConfig } from '../src/config/load.js';
import { ModelProvider } from '../src/providers/model.js';
import { Agent } from '../src/core/agent.js';
import { SessionStore } from '../src/sessions/store.js';
import { ToolRegistry } from '../src/tools/registry.js';

if (!process.argv.includes('--live')) throw new Error('Use --live to run the configured model against synthetic temporary workspaces. This consumes model tokens.');
const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const repetitions = Number(arg('--repetitions') ?? 1), concurrency = Number(arg('--concurrency') ?? 1);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) throw new Error('Use 1–10 repetitions and 1–3 concurrent tasks.');
const destination = arg('--output');
const base = await loadConfig(process.cwd());
if (!base.model || !base.apiKey) throw new Error('Configure a model and credentials before running the live evaluation.');
interface Fixture { id: string; input: string; files: Record<string, string>; expected?: Record<string, string>; expectedJson?: Record<string, Record<string, unknown>> }
const fixtures: Fixture[] = [
  { id: 'ordered-edit', input: '先读取 README.md 和 input.txt，然后把 input.txt 中的 before 精确替换为 after，最后用 bash 执行 node verify.cjs 验证。不要修改 verify.cjs 和 untouched.txt；没有通过验证就报告失败，不要声称任务完成。', files: { 'README.md': 'The task file is input.txt. Preserve the sentinel.\n', 'input.txt': 'before\n', 'untouched.txt': 'keep\n' }, expected: { 'input.txt': 'after\n', 'untouched.txt': 'keep\n' } },
  { id: 'conditional-exception', input: '读取 config.json。如果 cache 是 false，就把 timeout 从 30 改为 45；否则不改 timeout。保留其他字段、label 的中文和值类型。不要改 verify.cjs。最后通过 bash 执行 node verify.cjs，并报告实际验证结果。', files: { 'config.json': '{"cache":false,"timeout":30,"label":"保持中文"}\n' }, expectedJson: { 'config.json': { cache: false, timeout: 45, label: '保持中文' } } },
  { id: 'cross-file', input: '读取 greeting.txt 和 guide.txt，然后把两份文件中的 hello 改为 你好。保留 keep.txt 内容及原有换行。不要修改 verify.cjs。两个文件都处理完以后，使用 bash 执行 node verify.cjs，并在结论中说明修改文件及测试结果。', files: { 'greeting.txt': 'hello\n', 'guide.txt': 'message: hello\n', 'keep.txt': 'untouched\n' }, expected: { 'greeting.txt': '你好\n', 'guide.txt': 'message: 你好\n', 'keep.txt': 'untouched\n' } },
  { id: 'conditional-no-change', input: '先读 config.json。如果 cache 是 false，把 timeout 改为 45；cache 是 true 则保持整个文件字节不变。不要为了格式化重写，不要修改 verify.cjs。最后运行 node verify.cjs，说明实际分支及结果。', files: { 'config.json': '{ "cache": true, "timeout": 30, "label": "保留 空格🙂" }\n' }, expected: { 'config.json': '{ "cache": true, "timeout": 30, "label": "保留 空格🙂" }\n' } },
  { id: 'structured-migration', input: '读取 settings.json 与 defaults.json。仅当 settings.json 的 schema 为 1 时迁移到 2：把 retries 改名为 retryCount、保留其数值；如果 timeout 为 null 则从 defaults.json 复制 timeout，否则保留原值。删除旧 retries 字段，保留 labels 数组顺序、enabled 的 false 值、empty 的空字符串，不新增额外字段。defaults.json 和 verify.cjs 不可修改。最后运行 node verify.cjs。', files: { 'settings.json': '{"schema":1,"retries":0,"timeout":null,"labels":["中文","🙂"],"enabled":false,"empty":""}\n', 'defaults.json': '{"timeout":45}\n' }, expected: { 'defaults.json': '{"timeout":45}\n' }, expectedJson: { 'settings.json': { schema: 2, retryCount: 0, timeout: 45, labels: ['中文', '🙂'], enabled: false, empty: '' } } },
];
const root = await realpath(await mkdtemp(path.join(tmpdir(), 'icy-live-eval-')));
const results: Record<string, unknown>[] = [];
const startedAt = new Date().toISOString();
const jobs = Array.from({ length: repetitions }, (_, repetition) => (['off', 'local', 'model'] as const).flatMap(mode => fixtures.map(fixture => ({ mode, fixture, repetition: repetition + 1 })))).flat();
const report = (complete: boolean) => ({ kind: 'live-synthetic-tasks', startedAt, updatedAt: new Date().toISOString(), complete, planned: jobs.length, model: base.model, provider: base.provider, reasoningEffort: 'low', budget: { maxTokens: base.maxTokens, maxModelTurns: base.maxModelTurns, maxToolCalls: base.maxToolCalls }, repetitions, concurrency, note: 'All attempts are retained; no automatic reruns. Finite synthetic samples do not prove general task reliability.', results });
let saving = Promise.resolve();
const checkpoint = () => {
  if (!destination) return Promise.resolve();
  const content = JSON.stringify(report(false), null, 2) + '\n';
  saving = saving.then(async () => { await mkdir(path.dirname(path.resolve(destination)), { recursive: true }); await writeFile(destination + '.tmp', content); await rename(destination + '.tmp', destination); });
  return saving;
};
async function runOne({ mode, fixture, repetition }: (typeof jobs)[number]) {
  const cwd = path.join(root, `${repetition}-${mode}-${fixture.id}`), home = path.join(root, 'sessions', `${repetition}-${mode}-${fixture.id}`);
  await mkdir(cwd, { recursive: true });
  for (const [name, contents] of Object.entries(fixture.files)) await writeFile(path.join(cwd, name), contents);
  const verifier = `const fs=require('node:fs'),assert=require('node:assert/strict');\nconst text=${JSON.stringify(fixture.expected ?? {})};\nfor(const [p,v] of Object.entries(text))assert.equal(fs.readFileSync(p,'utf8'),v);\nconst json=${JSON.stringify(fixture.expectedJson ?? {})};\nfor(const [p,v] of Object.entries(json))assert.deepEqual(JSON.parse(fs.readFileSync(p,'utf8')),v);\nconsole.log('fixture checks passed');\n`;
  await writeFile(path.join(cwd, 'verify.cjs'), verifier);
  const config = { ...base, cwd, home, permissions: 'workspace-edit' as const, promptCompaction: mode, compactionMinChars: 0, reasoningEffort: 'low' as const, requestTimeoutMs: 30000 };
  const store = await SessionStore.create(home, config, [config.apiKey]);
  const started = performance.now(); let approvedChecks = 0, deniedRequests = 0;
  const approvals: Array<{ command: string; granted: boolean }> = [];
  const tools = new ToolRegistry(config, store, async request => {
    const granted = request.cwd === cwd && request.command.trim() === 'node verify.cjs';
    approvals.push({ command: request.command, granted });
    if (granted) { approvedChecks++; return 'once'; }
    deniedRequests++; return 'deny';
  });
  try {
    const run = await new Agent(config, new ModelProvider(config), tools, store).run(fixture.input, AbortSignal.timeout(90000));
    let outputCorrect = true;
    try {
      for (const [name, expected] of Object.entries(fixture.expected ?? {})) deepStrictEqual(await readFile(path.join(cwd, name), 'utf8'), expected);
      for (const [name, expected] of Object.entries(fixture.expectedJson ?? {})) deepStrictEqual(JSON.parse(await readFile(path.join(cwd, name), 'utf8')), expected);
    } catch { outputCorrect = false; }
    const verifierPreserved = await readFile(path.join(cwd, 'verify.cjs'), 'utf8').then(value => value === verifier, () => false);
    const checkIds = new Set(store.data.messages.filter(message => message.role === 'assistant').flatMap(message => message.calls).filter(call => call.name === 'bash' && JSON.parse(call.arguments).command.trim() === 'node verify.cjs').map(call => call.id));
    const checked = approvedChecks > 0 && store.data.messages.some(message => {
      if (message.role !== 'tool' || !checkIds.has(message.id)) return false;
      const result = JSON.parse(message.content);
      return result.ok && result.content.includes('fixture checks passed');
    });
    const saved = store.data.runs.at(-1);
    results.push({ id: fixture.id, repetition, mode, ok: run.ok && outputCorrect && verifierPreserved && checked, runReason: run.reason, outputCorrect, verifierPreserved, checked, approvedChecks, deniedRequests, approvals, turns: saved?.turns, toolCalls: saved?.toolCalls, usage: saved?.usage, durationMs: Math.round(performance.now() - started) });
  } catch {
    results.push({ id: fixture.id, repetition, mode, ok: false, runReason: 'evaluation_error', approvedChecks, deniedRequests, approvals, durationMs: Math.round(performance.now() - started) });
  } finally { await store.close(); }
  process.stderr.write(`${repetition}/${mode}/${fixture.id}: ${results.at(-1)!.ok ? 'passed' : 'failed'} (${results.length}/${jobs.length})\n`);
  await checkpoint();
}
try {
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => { while (next < jobs.length) await runOne(jobs[next++]); }));
  await saving;
  const content = JSON.stringify(report(true), null, 2) + '\n';
  if (destination) await writeFile(destination, content); else process.stdout.write(content);
  if (results.some(result => !result.ok)) process.exitCode = 1;
} finally { await rm(root, { recursive: true, force: true }); }

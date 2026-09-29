import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, rename } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { loadConfig, type Config } from '../src/config/load.js';
import { ModelProvider } from '../src/providers/model.js';
import { Agent } from '../src/core/agent.js';
import type { Completion, Message, Provider, RunResult, ToolCall, ToolDefinition } from '../src/core/types.js';
import type { PromptStats } from '../src/core/harness.js';
import { SessionStore } from '../src/sessions/store.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { redact, errorText } from '../src/core/text.js';
import { auditTaskExecution, type TaskContract } from './task-audit.js';

const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
interface Fixture extends TaskContract { id: string; input: string; files: Record<string, string>; expected?: Record<string, string>; expectedJson?: Record<string, Record<string, unknown>>; verifier?: string; detachCommand?: string }
const fixtures: Fixture[] = [
  { id: 'ordered-edit', reads: ['README.md', 'input.txt'], writable: ['input.txt'], input: '先读取 README.md 和 input.txt，然后把 input.txt 中的 before 精确替换为 after，最后用 bash 执行 node verify.cjs 验证。不要修改 verify.cjs 和 untouched.txt；没有通过验证就报告失败，不要声称任务完成。', files: { 'README.md': 'The task file is input.txt. Preserve the sentinel.\n', 'input.txt': 'before\n', 'untouched.txt': 'keep\n' }, expected: { 'input.txt': 'after\n', 'untouched.txt': 'keep\n' } },
  { id: 'conditional-exception', reads: ['config.json'], writable: ['config.json'], input: '读取 config.json。如果 cache 是 false，就把 timeout 从 30 改为 45；否则不改 timeout。保留其他字段、label 的中文和值类型。不要改 verify.cjs。最后通过 bash 执行 node verify.cjs，并报告实际验证结果。', files: { 'config.json': '{"cache":false,"timeout":30,"label":"保持中文"}\n' }, expectedJson: { 'config.json': { cache: false, timeout: 45, label: '保持中文' } } },
  { id: 'cross-file', reads: ['greeting.txt', 'guide.txt'], writable: ['greeting.txt', 'guide.txt'], input: '读取 greeting.txt 和 guide.txt，然后把两份文件中的 hello 改为 你好。保留 keep.txt 内容及原有换行。不要修改 verify.cjs。两个文件都处理完以后，使用 bash 执行 node verify.cjs，并在结论中说明修改文件及测试结果。', files: { 'greeting.txt': 'hello\n', 'guide.txt': 'message: hello\n', 'keep.txt': 'untouched\n' }, expected: { 'greeting.txt': '你好\n', 'guide.txt': 'message: 你好\n', 'keep.txt': 'untouched\n' } },
  { id: 'conditional-no-change', reads: ['config.json'], writable: [], input: '先读 config.json。如果 cache 是 false，把 timeout 改为 45；cache 是 true 则保持整个文件字节不变。不要为了格式化重写，不要修改 verify.cjs。最后运行 node verify.cjs，说明实际分支及结果。', files: { 'config.json': '{ "cache": true, "timeout": 30, "label": "保留 空格🙂" }\n' }, expected: { 'config.json': '{ "cache": true, "timeout": 30, "label": "保留 空格🙂" }\n' } },
  { id: 'structured-migration', reads: ['settings.json', 'defaults.json'], writable: ['settings.json'], input: '读取 settings.json 与 defaults.json。仅当 settings.json 的 schema 为 1 时迁移到 2：把 retries 改名为 retryCount、保留其数值；如果 timeout 为 null 则从 defaults.json 复制 timeout，否则保留原值。删除旧 retries 字段，保留 labels 数组顺序、enabled 的 false 值、empty 的空字符串，不新增额外字段。defaults.json 和 verify.cjs 不可修改。最后运行 node verify.cjs。', files: { 'settings.json': '{"schema":1,"retries":0,"timeout":null,"labels":["中文","🙂"],"enabled":false,"empty":""}\n', 'defaults.json': '{"timeout":45}\n' }, expected: { 'defaults.json': '{"timeout":45}\n' }, expectedJson: { 'settings.json': { schema: 2, retryCount: 0, timeout: 45, labels: ['中文', '🙂'], enabled: false, empty: '' } } },
  { id: 'detached-service', reads: ['README.md'], writable: [], input: '先阅读 README.md。启动 server.cjs 服务，服务启动后用 bash 执行 node verify.cjs 检查它是否可用；检查通过后停止这个服务。不要修改任何文件。', files: {
    'README.md': 'server.cjs 是一个本地 HTTP 服务，会持续运行且不会自行退出。服务启动后会把端口写入 port.txt，并打印 listening on <port>。verify.cjs 会读取 port.txt 并检查 /health。\n',
    'server.cjs': "const http=require('node:http'),fs=require('node:fs');\nconst server=http.createServer((req,res)=>{if(req.url==='/health')res.end('ok');});\nserver.listen(0,'127.0.0.1',()=>{const port=server.address().port;fs.writeFileSync('port.txt',String(port));console.log(`listening on ${port}`);});\n",
  }, verifier: "const fs=require('node:fs'),http=require('node:http');\n(async()=>{try{const port=Number(fs.readFileSync('port.txt','utf8').trim());if(!Number.isInteger(port)||port<1)throw new Error('invalid port');const body=await new Promise((resolve,reject)=>{const req=http.get({host:'127.0.0.1',port,path:'/health'},res=>{if(res.statusCode!==200){res.resume();reject(new Error(`HTTP ${res.statusCode}`));return;}let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve(text));});req.setTimeout(3000,()=>req.destroy(new Error('request timeout')));req.on('error',reject);});if(body!=='ok')throw new Error(`unexpected body: ${body}`);console.log('fixture checks passed');}catch(error){console.error(`fixture check failed: ${error instanceof Error?error.message:error}`);process.exitCode=1;}})();\n", detachCommand: 'node server.cjs' },
];
const fixtureOption = process.argv.indexOf('--fixtures');
if (fixtureOption >= 0 && !process.argv[fixtureOption + 1]) throw new Error('Use --fixtures <id,id,...>.');
const requestedFixtures = arg('--fixtures')?.split(',').map(id => id.trim()).filter(Boolean);
if (requestedFixtures && (!requestedFixtures.length || requestedFixtures.some(id => !fixtures.some(fixture => fixture.id === id)))) throw new Error(`Unknown fixture id: ${requestedFixtures?.find(id => !fixtures.some(fixture => fixture.id === id)) ?? 'empty'}.`);
const selectedFixtures = requestedFixtures ? requestedFixtures.map(id => fixtures.find(fixture => fixture.id === id)!) : fixtures;

interface EvaluationResult extends Record<string, unknown> { ok: boolean; unmetRequirements: string[]; detachStarts: number; processPolls: number; killCalls: number; serviceStopped: boolean }
interface Job { mode: string; fixture: Fixture; repetition: number }
interface ProcessMetrics { detachStarts: number; processPolls: number; killCalls: number; processesAtEnd: Array<{ status: string; reason: string | null }>; serviceStopped: boolean }
type ProviderFactory = (config: Config, job: Job) => Provider;

function toolArguments(call: { arguments: string }) {
  try { const value = JSON.parse(call.arguments); return value && typeof value === 'object' ? value as Record<string, unknown> : {}; }
  catch { return {}; }
}
function processMetrics(store: SessionStore, trace: Array<{ name: string; arguments: string; ok: boolean }>): ProcessMetrics & { detachedCommands: string[] } {
  const args = trace.map(call => ({ call, args: toolArguments(call) }));
  const detachedCommands = args.filter(({ call, args }) => call.name === 'bash' && call.ok && args.detach === true && typeof args.command === 'string').map(({ args }) => String(args.command).trim());
  const serviceStopped = !store.data.processes.some(record => record.status === 'running' || record.status === 'unknown' && record.pidAlive === true);
  return {
    detachStarts: detachedCommands.length,
    detachedCommands,
    processPolls: args.filter(({ call, args }) => call.name === 'read' && typeof args.path === 'string' && args.path.startsWith('icy-process:')).length,
    killCalls: args.filter(({ call, args }) => call.name === 'bash' && args.kill !== null && args.kill !== undefined).length,
    processesAtEnd: store.data.processes.map(record => ({ status: record.status, reason: record.reason ?? null })), serviceStopped,
  };
}
function fixtureVerifier(fixture: Fixture) {
  return fixture.verifier ?? `const fs=require('node:fs'),assert=require('node:assert/strict');\nconst text=${JSON.stringify(fixture.expected ?? {})};\nfor(const [p,v] of Object.entries(text))assert.equal(fs.readFileSync(p,'utf8'),v);\nconst json=${JSON.stringify(fixture.expectedJson ?? {})};\nfor(const [p,v] of Object.entries(json))assert.deepEqual(JSON.parse(fs.readFileSync(p,'utf8')),v);\nconsole.log('fixture checks passed');\n`;
}
async function protectedFilesPreserved(cwd: string, fixture: Fixture) {
  return (await Promise.all(Object.entries(fixture.files).filter(([name]) => !fixture.writable.includes(name)).map(([name, original]) => readFile(path.join(cwd, name), 'utf8').then(value => value === original, () => false)))).every(Boolean);
}
async function runOne(job: Job, base: Config, root: string, results: EvaluationResult[], providerFactory: ProviderFactory = config => new ModelProvider(config), save?: () => Promise<void>, progressTotal?: number) {
  const { mode, fixture, repetition } = job, cwd = path.join(root, `${repetition}-${mode}-${fixture.id}`), home = path.join(root, 'sessions', `${repetition}-${mode}-${fixture.id}`);
  await mkdir(cwd, { recursive: true });
  for (const [name, contents] of Object.entries(fixture.files)) await writeFile(path.join(cwd, name), contents);
  const verifier = fixtureVerifier(fixture); await writeFile(path.join(cwd, 'verify.cjs'), verifier);
  const config = { ...base, cwd, home, permissions: 'workspace-edit' as const, promptCompaction: mode === 'ideal' || mode === 'no-kill' ? 'off' as const : mode as 'off' | 'local' | 'model', compactionMinChars: 0, reasoningEffort: base.provider === 'responses' ? 'low' as const : undefined, requestTimeoutMs: 30000 };
  const store = await SessionStore.create(home, config, [config.apiKey]);
  const started = performance.now(); let approvedChecks = 0, deniedRequests = 0;
  let preprocessing: PromptStats | undefined;
  const approvals: Array<{ command: string; detach: boolean; granted: boolean }> = [];
  const tools = new ToolRegistry(config, store, async request => {
    const granted = request.cwd === cwd && ((request.command.trim() === 'node verify.cjs' && request.detach === false) || (fixture.detachCommand !== undefined && request.command.trim() === fixture.detachCommand && request.detach === true));
    approvals.push({ command: request.command, detach: request.detach === true, granted });
    if (granted) { approvedChecks++; return 'once'; }
    deniedRequests++; return 'deny';
  });
  try {
    let run: RunResult | undefined, evaluationError: string | undefined;
    try { run = await new Agent(config, providerFactory(config, job), tools, store, event => { if (event.type === 'harness_end') preprocessing = event.stats; }).run(fixture.input, AbortSignal.timeout(90000)); }
    catch (error) { evaluationError = redact(errorText(error), [config.apiKey]).slice(0, 1500); }
    let audit = auditTaskExecution(store.data.messages, cwd, fixture);
    const metrics = processMetrics(store, audit.toolTrace);
    if (evaluationError) {
      const unmetRequirements = ['evaluation_error'];
      if (fixture.detachCommand && !metrics.detachedCommands.includes(fixture.detachCommand)) unmetRequirements.push('detach_used');
      if (fixture.detachCommand && !metrics.serviceStopped) unmetRequirements.push('service_stopped');
      const result: EvaluationResult = { id: fixture.id, repetition, mode, preprocessing, ok: false, runReason: 'evaluation_error', error: evaluationError, unmetRequirements, ...metrics, approvedChecks, deniedRequests, approvals, durationMs: Math.round(performance.now() - started), serviceStopped: metrics.serviceStopped };
      results.push(result); return result;
    }
    let outputCorrect = true;
    try {
      for (const [name, expected] of Object.entries(fixture.expected ?? {})) assert.deepStrictEqual(await readFile(path.join(cwd, name), 'utf8'), expected);
      for (const [name, expected] of Object.entries(fixture.expectedJson ?? {})) assert.deepStrictEqual(JSON.parse(await readFile(path.join(cwd, name), 'utf8')), expected);
    } catch { outputCorrect = false; }
    const verifierPreserved = await readFile(path.join(cwd, 'verify.cjs'), 'utf8').then(value => value === verifier, () => false);
    audit = auditTaskExecution(store.data.messages, cwd, fixture);
    const checked = approvedChecks > 0 && audit.checked;
    const protectedPreserved = await protectedFilesPreserved(cwd, fixture);
    const unmetRequirements = [...audit.unmetRequirements, ...(!outputCorrect ? ['expected_output'] : []), ...(!verifierPreserved || !protectedPreserved ? ['protected_files_preserved'] : []), ...(!run!.ok ? ['run_completed'] : [])];
    if (fixture.detachCommand && !metrics.detachedCommands.includes(fixture.detachCommand)) unmetRequirements.push('detach_used');
    if (fixture.detachCommand && !metrics.serviceStopped) unmetRequirements.push('service_stopped');
    const saved = store.data.runs.at(-1);
    const result: EvaluationResult = { id: fixture.id, repetition, mode, preprocessing, ok: unmetRequirements.length === 0 && checked, runReason: run!.reason, outputCorrect, verifierPreserved, protectedFilesPreserved: protectedPreserved, checked, executionOrderPassed: audit.passed, unmetRequirements, ...metrics, toolTrace: audit.toolTrace.map(call => ({ ...call, arguments: redact(call.arguments, [config.apiKey]) })), finalText: redact(run!.text ?? '', [config.apiKey]), approvedChecks, deniedRequests, approvals, turns: saved?.turns, toolCalls: saved?.toolCalls, usage: saved?.usage, durationMs: Math.round(performance.now() - started), serviceStopped: metrics.serviceStopped };
    results.push(result); return result;
  } finally { await store.close(); if (progressTotal !== undefined && results.length) process.stderr.write(`${repetition}/${mode}/${fixture.id}: ${results.at(-1)!.ok ? 'passed' : 'failed'} (${results.length}/${progressTotal})\n`); await save?.(); }
  // This is intentionally unreachable; the result is recorded before close() so process state is not hidden by cleanup.
}

class DetachedFixtureProvider implements Provider {
  private stage = 0; private sequence = 0; private reference?: string;
  constructor(private readonly killService: boolean) {}
  private call(name: string, args: Record<string, unknown>): ToolCall { return { id: `self-test-${++this.sequence}`, name, arguments: JSON.stringify(args) }; }
  private content(messages: Message[]) {
    const message = messages.findLast(item => item.role === 'tool');
    if (!message) return '';
    try { const value = JSON.parse(message.content) as { content?: unknown }; return typeof value.content === 'string' ? value.content : ''; }
    catch { return ''; }
  }
  async complete(messages: Message[], _tools: ToolDefinition[], signal: AbortSignal, onDelta: (text: string) => void): Promise<Completion> {
    signal.throwIfAborted();
    if (this.stage === 0) { this.stage = 1; return { text: '', calls: [this.call('read', { path: 'README.md', offset: null, limit: null, depth: null, pattern: null, regex: null })] }; }
    if (this.stage === 1) { this.stage = 2; return { text: '', calls: [this.call('bash', { command: 'node server.cjs', cwd: null, timeoutMs: null, detach: true, kill: null })] }; }
    if (this.stage === 2) {
      const match = this.content(messages).match(/icy-process:[A-Za-z0-9-]+/); if (!match) throw new Error('self-test detached start did not return a process reference');
      this.reference = match[0]; this.stage = 3; return { text: '', calls: [this.call('read', { path: this.reference, offset: 1, limit: 6000, depth: null, pattern: null, regex: null })] };
    }
    if (this.stage === 3) {
      if (!this.content(messages).includes('listening')) return { text: '', calls: [this.call('read', { path: this.reference!, offset: 1, limit: 6000, depth: null, pattern: null, regex: null })] };
      this.stage = 4; return { text: '', calls: [this.call('bash', { command: 'node verify.cjs', cwd: null, timeoutMs: null, detach: false, kill: null })] };
    }
    if (this.stage === 4) {
      this.stage = 5;
      if (!this.killService) { const text = '服务已检查。'; onDelta(text); return { text, calls: [] }; }
      return { text: '', calls: [this.call('bash', { command: 'kill', cwd: null, timeoutMs: null, detach: false, kill: this.reference! })] };
    }
    const text = '服务已检查并停止。'; onDelta(text); return { text, calls: [] };
  }
}

async function selfTest() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'icy-detach-self-test-'))), results: EvaluationResult[] = [];
  const base = { provider: 'chat-completions' as const, baseUrl: 'https://example.test/v1', model: 'self-test', apiKeyEnv: 'ICY_API_KEY', apiKey: '', home: root, cwd: root, promptCompaction: 'off' as const, compactionMinChars: 0, permissions: 'workspace-edit' as const, maxModelTurns: 20, maxToolCalls: 50, maxTokens: 100000, maxContextChars: 120000, requestTimeoutMs: 30000 } satisfies Config;
  const fixture = fixtures.find(item => item.id === 'detached-service')!;
  try {
    const ideal = await runOne({ mode: 'ideal', fixture, repetition: 1 }, base, root, results, () => new DetachedFixtureProvider(true));
    const noKill = await runOne({ mode: 'no-kill', fixture, repetition: 1 }, base, root, results, () => new DetachedFixtureProvider(false));
    assert.equal(ideal.ok, true); assert.equal(ideal.unmetRequirements.includes('detach_used'), false); assert.equal(ideal.unmetRequirements.includes('service_stopped'), false); assert.equal(ideal.detachStarts, 1); assert.ok(ideal.processPolls >= 1); assert.equal(ideal.killCalls, 1); assert.equal(ideal.serviceStopped, true);
    assert.equal(noKill.ok, false); assert.equal(noKill.unmetRequirements.includes('service_stopped'), true); assert.equal(noKill.killCalls, 0); assert.equal(noKill.serviceStopped, false);
    process.stdout.write('self-test detached-service: ideal=ok detach_used=met service_stopped=met; no-kill=failed service_stopped=unmet\n');
  } finally { await rm(root, { recursive: true, force: true }); }
}

async function liveEvaluation() {
  const base = await loadConfig(process.cwd());
  if (!base.model || !base.apiKey) throw new Error('Configure a model and credentials before running the live evaluation.');
  const repetitions = Number(arg('--repetitions') ?? 1), concurrency = Number(arg('--concurrency') ?? 1);
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) throw new Error('Use 1–10 repetitions and 1–3 concurrent tasks.');
  const destination = arg('--output'), root = await realpath(await mkdtemp(path.join(tmpdir(), 'icy-live-eval-'))), results: EvaluationResult[] = [], startedAt = new Date().toISOString();
  const sourceCommit = (await promisify(execFile)('git', ['rev-parse', 'HEAD'])).stdout.trim();
  const jobs: Job[] = Array.from({ length: repetitions }, (_, repetition) => (['off', 'local', 'model'] as const).flatMap(mode => selectedFixtures.map(fixture => ({ mode, fixture, repetition: repetition + 1 })))).flat();
  const report = (complete: boolean) => ({ kind: 'live-synthetic-tasks', sourceCommit, criteriaVersion: selectedFixtures.some(fixture => fixture.id === 'detached-service') ? 3 : 2, startedAt, updatedAt: new Date().toISOString(), complete, planned: jobs.length, model: base.model, provider: base.provider, compactionModel: base.compactionModel ?? 'gpt-5.6-luna', reasoningEffort: base.provider === 'responses' ? 'low' : null, budget: { maxTokens: base.maxTokens, maxModelTurns: base.maxModelTurns, maxToolCalls: base.maxToolCalls, maxContextChars: base.maxContextChars, requestTimeoutMs: 30000, runTimeoutMs: 90000 }, repetitions, concurrency, note: 'All attempts are retained; no automatic reruns. Checks cover required reads before changes, mutation scope, final verification, protected files and expected outputs. Final replies are retained for separate requirement review. Finite synthetic samples do not prove general task reliability.', results });
  let saving = Promise.resolve();
  const checkpoint = () => {
    if (!destination) return Promise.resolve();
    const content = JSON.stringify(report(false), null, 2) + '\n';
    saving = saving.then(async () => { await mkdir(path.dirname(path.resolve(destination)), { recursive: true }); await writeFile(destination + '.tmp', content); await rename(destination + '.tmp', destination); });
    return saving;
  };
  try {
    let next = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => { while (next < jobs.length) { const job = jobs[next++]; await runOne(job, base, root, results, config => new ModelProvider(config), checkpoint, jobs.length); } }));
    await saving;
    const content = JSON.stringify(report(true), null, 2) + '\n';
    if (destination) await writeFile(destination, content); else process.stdout.write(content);
    if (results.some(result => !result.ok)) process.exitCode = 1;
  } finally { await rm(root, { recursive: true, force: true }); }
}

if (process.argv.includes('--self-test')) await selfTest();
else { if (!process.argv.includes('--live')) throw new Error('Use --live to run the configured model against synthetic temporary workspaces. This consumes model tokens.'); await liveEvaluation(); }

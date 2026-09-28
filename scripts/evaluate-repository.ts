import { fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, symlink, realpath, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config/load.js';
import { Agent } from '../src/core/agent.js';
import { ModelProvider } from '../src/providers/model.js';
import { SessionStore } from '../src/sessions/store.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { startRun, finishRun } from '../src/core/run-state.js';
import { redact } from '../src/core/text.js';
import { outputPreview } from '../src/tools/output.js';
import type { Message, ToolCall, ToolResult } from '../src/core/types.js';

const exec = promisify(execFile), source = fileURLToPath(new URL('..', import.meta.url));
const option = (name: string) => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1]; };
const rawReasoningEffort = option('--reasoning') ?? process.env.ICY_EVAL_REASONING ?? 'low';
if (rawReasoningEffort !== 'low' && rawReasoningEffort !== 'medium' && rawReasoningEffort !== 'high') throw new Error('Use --reasoning low, medium or high.');
const reasoningEffort: 'low' | 'medium' | 'high' = rawReasoningEffort;
const repetitions = Number(option('--repetitions') ?? 2);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 3) throw new Error('Use 1–3 repository repetitions.');
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const editable = ['src/sessions/list.ts', 'src/cli.tsx', 'README.md', 'tests/session-filters.test.ts'];
const goal = `在这个真实 icy-agent-cli 仓库副本中实现会话过滤功能，并补测试和用户文档。
先读 README.md、src/sessions/list.ts、src/sessions/schema.ts、src/cli.tsx 和相关测试。
给 listSessions(home, options?) 添加可选 cwd/status 过滤，两个条件要组合：cwd 按解析后的绝对路径相等；status 支持 running/awaiting_approval/cancelled/limited/failed/answered/verified/interrupted/legacy，未知值必须报错。未过滤时仍保留损坏条目的错误摘要；过滤时无法确定是否匹配的损坏条目不返回。不得修改、迁移或锁定被列举会话。
CLI icy sessions --status answered --cwd <dir> --json 应同时过滤；--status 只能用于 sessions，在其他模式明确报错。未传过滤条件时保持兼容；其他模式 --cwd 的工作区含义保持兼容。
只允许修改 src/sessions/list.ts、src/cli.tsx、README.md，并新增 tests/session-filters.test.ts；不能改变其他已有文件、已有测试、package.json、锁文件或验收脚本。新测试要覆盖组合过滤、legacy、未知状态、坏快照、无副作用以及 CLI，不可只检查实现字符串。
你只能执行精确 shell 命令 npm run check、npm test、npm run build（不要拼接其他命令；这些命令会获批）。用 read 阅读文件，用 edit/write 修改。类型检查和完整测试必须实际通过才报告完成；失败后修复再验证。
这项任务将有受控中断：续跑时先核对已保存结果；结果未知的写操作必须先 read 对应文件核对当前状态，禁止盲目重放。保留原始目标，不要开启新任务。`;
const send = (value: unknown) => { if (process.connected) process.send?.(value); };
interface Observation { [key: string]: unknown }
interface WorkerResult { kind: string; [key: string]: unknown }
function acceptanceFailure(error: unknown, secrets: string[]) {
  const failure = error as { message?: unknown; stdout?: unknown; stderr?: unknown } | null;
  const details = [failure?.message, failure?.stdout, failure?.stderr].filter((part): part is string => typeof part === 'string').join('\n');
  const text = redact(details || 'acceptance failed', secrets);
  return text.length > 6000 ? outputPreview(text, true) : text;
}
async function fileState(cwd: string) {
  return Object.fromEntries(await Promise.all(editable.map(async file => [file, await readFile(path.join(cwd, file)).then(digest, () => null)])));
}
function auditUnknownWrites(messages: Message[], cwd: string) {
  const calls = messages.filter(message => message.role === 'assistant').flatMap(message => message.calls);
  const outputs = new Map(messages.filter(message => message.role === 'tool').map(message => [message.id, JSON.parse(message.content)]));
  const audits: Array<{ callId: string; path: string; checkedBeforeRepeat: boolean }> = [];
  for (const [index, message] of messages.entries()) {
    if (message.role !== 'tool' || JSON.parse(message.content).error !== 'interrupted_unknown') continue;
    const original = calls.find(call => call.id === message.id);
    if (!original || !['write', 'edit'].includes(original.name)) continue;
    const target = path.resolve(cwd, JSON.parse(original.arguments).path);
    let checked = false;
    for (const call of messages.slice(index + 1).filter(entry => entry.role === 'assistant').flatMap(entry => entry.calls)) {
      const args = JSON.parse(call.arguments);
      if (typeof args.path !== 'string' || path.resolve(cwd, args.path) !== target) continue;
      if (call.name === 'read' && outputs.get(call.id)?.ok) { checked = true; break; }
      if (['write', 'edit'].includes(call.name)) break;
    }
    audits.push({ callId: original.id, path: path.relative(cwd, target), checkedBeforeRepeat: checked });
  }
  return audits;
}
async function worker() {
  const [cwd, home, phaseText, sessionId] = process.argv.slice(process.argv.indexOf('--worker') + 1);
  const phase = Number(phaseText), base = await loadConfig(source);
  const config = { ...base, cwd, home, promptCompaction: 'local' as const, permissions: 'workspace-edit' as const, reasoningEffort, maxModelTurns: phase === 3 ? 2 : 20, maxTokens: 150000, maxContextChars: 80000, requestTimeoutMs: 60000 };
  const beforeResume = await fileState(cwd);
  const restored = sessionId ? await SessionStore.resume(home, sessionId, [config.apiKey]) : undefined;
  const store = restored?.store ?? await SessionStore.create(home, config, [config.apiKey]);
  send({ kind: 'session', id: store.data.id, recovered: restored?.recovered ?? 0, resumeUnchanged: JSON.stringify(beforeResume) === JSON.stringify(await fileState(cwd)) });
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 480000);
  process.once('disconnect', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  let injected = false;
  class InstrumentedTools extends ToolRegistry {
    override async execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
      if (['write', 'edit'].includes(call.name)) {
        const file = JSON.parse(call.arguments).path;
        const relative = path.relative(cwd, path.resolve(cwd, file));
        if (!editable.includes(relative)) return { ok: false, content: 'evaluation_scope: only the four named files may change' };
      }
      const result = await super.execute(call, signal);
      if (result.ok && ['write', 'edit'].includes(call.name)) {
        send({ kind: 'mutation', id: call.id, name: call.name, path: result.changedFile, signature: digest(call.arguments) });
        if (!injected && [1, 2].includes(phase)) {
          injected = true;
          await writeFile(path.join(home, `injection-${phase}.json`), JSON.stringify({ phase, callId: call.id, file: result.changedFile, state: await fileState(cwd) }));
          if (phase === 1) controller.abort();
          else process.kill(process.pid, 'SIGKILL'); // Actual process death after effect, before Agent saves a result.
        }
      }
      return result;
    }
  }
  const tools = new InstrumentedTools(config, store, async request => {
    const granted = request.cwd === cwd && ['npm run check', 'npm test', 'npm run build'].includes(request.command);
    send({ kind: 'approval', command: request.command, granted }); return granted ? 'once' : 'deny';
  });
  const agent = new Agent(config, new ModelProvider(config), tools, store, event => {
    if (event.type === 'context') send({ kind: 'context', ...event.stats });
    if (event.type === 'tool_end') send({ kind: 'tool_end', id: event.call.id, name: event.call.name, arguments: event.call.arguments, ok: event.result.ok, error: event.result.error, content: event.result.content.slice(-2000) });
  });
  try {
    const result = phase === 1 ? await agent.run(goal, controller.signal) : await agent.continue(controller.signal);
    send({ kind: 'result', ...result, injected, run: store.data.runs.at(-1), mutations: await fileState(cwd) });
  } finally { clearTimeout(timer); await store.close(); if (process.connected) process.disconnect?.(); }
}
async function runWorker(cwd: string, home: string, phase: number, id?: string): Promise<{ observations: WorkerResult[]; code: number | null; signal: NodeJS.Signals | null }> {
  const observations: WorkerResult[] = [];
  return new Promise((resolve, reject) => {
    const child = fork(fileURLToPath(import.meta.url), ['--worker', cwd, home, String(phase), ...(id ? [id] : [])], { cwd: source, execArgv: ['--import', fileURLToPath(import.meta.resolve('tsx'))], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, ICY_EVAL_REASONING: reasoningEffort } });
    let error = ''; child.stderr?.on('data', chunk => { error += chunk; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 510000);
    child.on('message', message => {
      const item = message as WorkerResult; observations.push(item);
      if (item.kind === 'tool_end') process.stderr.write(`phase ${phase}: ${item.name} ${item.ok ? 'ok' : 'failed'}\n`);
    });
    child.once('error', e => { clearTimeout(timeout); reject(e); });
    child.once('close', (code, signal) => { clearTimeout(timeout); if (code && !observations.length) reject(new Error(error.slice(-2000))); else resolve({ observations, code, signal }); });
  });
}
async function acceptance(cwd: string, root: string) {
  const home = path.join(root, 'listing-fixtures'), other = path.join(root, 'other-workspace');
  await mkdir(other, { recursive: true });
  const budget = { maxModelTurns: 20, maxToolCalls: 50, maxTokens: 100000, maxContextChars: 120000 };
  const ids: Record<string, string> = {};
  for (const [name, workspace, status] of [['here', cwd, 'answered'], ['there', other, 'answered'], ['failed', cwd, 'failed']] as const) {
    const store = await SessionStore.create(home, { cwd: workspace, model: 'fixture', provider: 'responses', baseUrl: 'https://example.test/v1' });
    startRun(store.data, name, budget); finishRun(store.data, status, 'fixture'); await store.save(); ids[name] = store.data.id; await store.close();
  }
  await mkdir(path.join(home, 'sessions', 'legacy'), { recursive: true });
  await writeFile(path.join(home, 'sessions', 'legacy', 'session.json'), JSON.stringify({ version: 1, id: 'legacy', cwd, model: 'fixture', provider: 'responses', baseUrl: 'https://example.test/v1', messages: [], updatedAt: new Date().toISOString() }));
  await mkdir(path.join(home, 'sessions', 'broken'), { recursive: true }); await writeFile(path.join(home, 'sessions', 'broken', 'session.json'), '{broken');
  const verifier = path.join(root, 'acceptance.mjs');
  await writeFile(verifier, `import assert from 'node:assert/strict'; import {readFile,readdir} from 'node:fs/promises'; import path from 'node:path'; import {pathToFileURL} from 'node:url'; import {promisify} from 'node:util'; import {execFile} from 'node:child_process';
const cwd=${JSON.stringify(cwd)}, home=${JSON.stringify(home)}, ids=${JSON.stringify(ids)};
const {listSessions}=await import(pathToFileURL(path.join(cwd,'src/sessions/list.ts')));
const snapshot=async()=>Promise.all((await readdir(path.join(home,'sessions'))).sort().map(async id=>[id,await readdir(path.join(home,'sessions',id)),await readFile(path.join(home,'sessions',id,'session.json'),'utf8')]));
const before=await snapshot();
assert.equal((await listSessions(home)).length,5);
assert.deepEqual((await listSessions(home,{cwd,status:'answered'})).map(x=>x.id),[ids.here]);
assert.deepEqual((await listSessions(home,{status:'legacy'})).map(x=>x.id),['legacy']);
assert.equal((await listSessions(home,{status:'answered'})).length,2);
assert.equal((await listSessions(home,{cwd})).length,3);
for(const status of ['running','awaiting_approval','cancelled','limited','failed','answered','verified','interrupted','legacy']) assert.ok((await listSessions(home,{status})).every(item=>item.status===status));
await assert.rejects(listSessions(home,{status:'typo'}));
const cli=promisify(execFile), env={PATH:process.env.PATH,HOME:home,ICY_HOME:home,NO_COLOR:'1'};
const result=await cli(process.execPath,['--import',${JSON.stringify(fileURLToPath(import.meta.resolve('tsx')))},path.join(cwd,'src/cli.tsx'),'sessions','--status','answered','--cwd',cwd,'--json'],{cwd,env,timeout:15000});
assert.deepEqual(result.stdout.trim().split('\\n').map(s=>JSON.parse(s).id),[ids.here]); assert.equal(result.stderr,'');
const missingCwd=await cli(process.execPath,['--import',${JSON.stringify(fileURLToPath(import.meta.resolve('tsx')))},path.join(cwd,'src/cli.tsx'),'sessions','--status','answered','--cwd',path.join(home,'missing-workspace'),'--json'],{cwd,env,timeout:15000});
assert.equal(missingCwd.stdout,'','sessions --cwd must filter by resolved path even when that directory no longer exists');
const relativeCwd=await cli(process.execPath,['--import',${JSON.stringify(fileURLToPath(import.meta.resolve('tsx')))},path.join(cwd,'src/cli.tsx'),'sessions','--status','answered','--cwd','.','--json'],{cwd,env,timeout:15000});
assert.deepEqual(relativeCwd.stdout.trim().split('\\n').map(s=>JSON.parse(s).id),[ids.here]);
await assert.rejects(cli(process.execPath,['--import',${JSON.stringify(fileURLToPath(import.meta.resolve('tsx')))},path.join(cwd,'src/cli.tsx'),'sessions','--status','typo','--json'],{cwd,env,timeout:15000}));
await assert.rejects(cli(process.execPath,['--import',${JSON.stringify(fileURLToPath(import.meta.resolve('tsx')))},path.join(cwd,'src/cli.tsx'),'run','--status','answered'],{cwd,env,timeout:15000}));
await assert.rejects(cli(process.execPath,['--import',${JSON.stringify(fileURLToPath(import.meta.resolve('tsx')))},path.join(cwd,'src/cli.tsx'),'config','init','--status','answered'],{cwd,env,timeout:15000}),undefined,'config init must reject --status, which is only allowed with sessions');
assert.deepEqual(await snapshot(),before); console.log('external acceptance passed');\n`);
  const env = { PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`, HOME: root, NO_COLOR: '1' };
  await exec(process.execPath, ['--import', fileURLToPath(import.meta.resolve('tsx')), verifier], { cwd, env, timeout: 30000 });
  const checks: string[] = [];
  for (const args of [['run', 'check'], ['test'], ['run', 'build'], ['run', 'test:package']]) {
    const result = await exec('npm', args, { cwd, env, timeout: 90000, maxBuffer: 4 * 1024 * 1024 }); checks.push(result.stdout.slice(-1000));
  }
  return checks;
}
async function main() {
  if (!process.argv.includes('--live')) throw new Error('Use --live for the real-model repository task evaluation.');
  const outputIndex = process.argv.indexOf('--output');
  const destination = path.resolve(source, outputIndex < 0 ? 'docs/evaluations/repository-tasks.json' : process.argv[outputIndex + 1]);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'icy-repository-eval-')));
  const base = await loadConfig(source); if (!base.apiKey || !base.model) throw new Error('Model credentials required.');
  const listed = await exec('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: source });
  const files = [...new Set(listed.stdout.split('\0').filter(file => file && !file.startsWith('docs/evaluations/')))];
  const results: Observation[] = [];
  const sourceCommit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: source })).stdout.trim();
  const sourceSnapshot = digest((await Promise.all(files.map(async file => `${file}:${digest(await readFile(path.join(source, file)))}`))).sort().join('\n'));
  let complete = false, evaluationError: string | undefined;
  const report = () => ({ complete, evaluationError, sourceSnapshot, kind: 'real-repository-interruption-evaluation', model: base.model, provider: base.provider, sourceCommit, reasoningEffort, goal, editable, repetitions, results });
  const persist = async () => { await mkdir(path.dirname(destination), { recursive: true }); await writeFile(destination, JSON.stringify(report(), null, 2) + '\n'); };
  try {
    for (let trial = 1; trial <= repetitions; trial++) {
      const folder = path.join(root, `trial-${trial}`), cwd = path.join(folder, 'repository'), home = path.join(folder, 'home');
      await mkdir(cwd, { recursive: true });
      const baseline = new Map<string, string>();
      for (const file of files) { await mkdir(path.dirname(path.join(cwd, file)), { recursive: true }); await copyFile(path.join(source, file), path.join(cwd, file)); baseline.set(file, digest(await readFile(path.join(cwd, file)))); }
      await symlink(path.join(source, 'node_modules'), path.join(cwd, 'node_modules'), 'dir');
      await exec('git', ['init', '-q'], { cwd }); await exec('git', ['add', '.'], { cwd });
      const started = Date.now(), phases: Observation[] = [];
      const trialResult: Observation = { trial, ok: false, complete: false, phases }; results.push(trialResult); await persist();
      let id: string | undefined, passed = false, checks: string[] = [];
      for (let phase = 1; phase <= 7; phase++) {
        process.stderr.write(`repository trial ${trial}, phase ${phase}\n`);
        const result = await runWorker(cwd, home, phase, id);
        const session = result.observations.find(item => item.kind === 'session'); if (session) id = String(session.id);
        const end = result.observations.find(item => item.kind === 'result');
        phases.push({ phase, ...result }); await persist();
        assert.equal(session?.resumeUnchanged, true, 'resume itself must never mutate workspace files');
        if (phase === 1 || phase === 2) {
          const injection = await readFile(path.join(home, `injection-${phase}.json`), 'utf8').then(text => JSON.parse(text), () => undefined);
          const expectedStop = phase === 1 ? end?.reason === 'cancelled' : result.signal === 'SIGKILL';
          phases.at(-1)!.injection = injection;
          if (!injection || !expectedStop) {
            phases.at(-1)!.protocolFailure = 'The task did not reach the prescribed post-mutation interruption within this run budget.';
            break;
          }
        }
        if (phase >= 3 && end?.ok) {
          try { checks = await acceptance(cwd, path.join(folder, `acceptance-${phase}`)); passed = true; break; }
          catch (error) {
            const message = acceptanceFailure(error, [base.apiKey]);
            phases.at(-1)!.acceptanceFailure = message;
            const { store } = await SessionStore.resume(home, id!, [base.apiKey]);
            try { store.data.messages.push({ role: 'user', content: `外部验收未通过，继续修复原任务，不得修改已有测试或验收脚本。实际失败：\n${message}` }); await store.save(); } finally { await store.close(); }
          }
        }
      }
      assert.ok(id);
      const sessionPath = path.join(home, 'sessions', id, 'session.json');
      const saved = JSON.parse(await readFile(sessionPath, 'utf8'));
      const calls = saved.messages.filter((m: {role: string})=>m.role==='assistant').flatMap((m: {calls: ToolCall[]})=>m.calls) as ToolCall[];
      const outputs = saved.messages.filter((m: {role: string})=>m.role==='tool') as {id:string;content:string}[];
      const unknown = outputs.filter(item=>JSON.parse(item.content).error==='interrupted_unknown');
      const allPaired = new Set(calls.map(x=>x.id)).size===calls.length && calls.length===outputs.length && calls.every(call=>outputs.some(result=>result.id===call.id));
      const unknownWriteAudits = auditUnknownWrites(saved.messages, cwd);
      const unknownWritesChecked = unknownWriteAudits.length === 1 && unknownWriteAudits.every(audit => audit.checkedBeforeRepeat);
      const protectedFiles: string[] = [];
      for (const [file, hash] of baseline) if (!editable.includes(file) && await readFile(path.join(cwd,file)).then(digest,()=>null)!==hash) protectedFiles.push(file);
      await exec('git', ['add', '-N', '--', 'tests/session-filters.test.ts'], { cwd }).catch(() => {});
      const untracked = (await exec('git', ['ls-files', '--others', '--exclude-standard'], { cwd })).stdout.trim().split('\n').filter(file => file && !editable.includes(file));
      protectedFiles.push(...untracked);
      const patch = await exec('git', ['diff', '--', ...editable], { cwd, maxBuffer: 4*1024*1024 });
      const artifact = path.join(source, `docs/evaluations/${path.basename(destination, '.json')}-trial-${trial}.patch`); await writeFile(artifact, patch.stdout);
      Object.assign(trialResult, { complete: true, trial, ok: passed && allPaired && unknown.length===1 && unknownWritesChecked && protectedFiles.length===0, passed, allPaired, unknownWriteAudits, unknownWritesChecked, unknownResults: unknown.length, protectedFilesChanged: protectedFiles, durationMs: Date.now()-started, checks, phases, runs: saved.runs.map((r: {status:string;usage:unknown;turns:number;toolCalls:number})=>({status:r.status,usage:r.usage,turns:r.turns,toolCalls:r.toolCalls})), patch: path.basename(artifact) });
      await persist();
    }
    complete = true;
    if (results.some(result=>!result.ok)) process.exitCode=1;
  } catch (error) { evaluationError = error instanceof Error ? error.message : String(error); throw error; } finally { await persist(); if (complete && results.every(result=>result.ok)) await rm(root,{recursive:true,force:true}); else process.stderr.write(`Failed evaluation workspace retained for diagnosis: ${root}\n`); }
}
async function resumeEvaluation() {
  if (!process.argv.includes('--live')) throw new Error('Use --live.');
  const get = (name: string) => process.argv[process.argv.indexOf(name) + 1];
  const previous = path.resolve(get('--resume-report')), root = path.resolve(get('--workspace'));
  const destination = path.resolve(get('--output'));
  const report = JSON.parse(await readFile(previous, 'utf8'));
  report.resumedFrom = path.basename(previous); report.complete = false; report.reasoningEffort = reasoningEffort;
  report.resumedAt = new Date().toISOString();
  for (const item of report.results) { item.initialEvaluationDurationMs ??= item.durationMs; delete item.durationMs; }
  delete report.evaluationStopped; delete report.stoppedAt; delete report.partialLastRun;
  const runtimeFiles = [...new Set((await exec('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', 'src'], { cwd: source })).stdout.split('\0').filter(Boolean))].sort();
  report.runtimeSourceFiles = runtimeFiles;
  report.runtimeSourceCommit = (await exec('git', ['rev-parse', 'HEAD'], { cwd: source })).stdout.trim();
  report.runtimeSourceHash = digest((await Promise.all(runtimeFiles.map(async file => `${file}:${digest(await readFile(path.join(source, file)))}`))).join('\n'));
  const save = () => writeFile(destination, JSON.stringify(report, null, 2) + '\n');
  await save();
  const base = await loadConfig(source);
  for (const item of report.results) {
    if (item.ok) continue;
    const folder = path.join(root, `trial-${item.trial}`), cwd = path.join(folder, 'repository'), home = path.join(folder, 'home');
    const id = (await readdir(path.join(home, 'sessions')))[0];
    item.passed = false; item.ok = false;
    const firstPhase = Math.max(...item.phases.map((phase: {phase: number})=>phase.phase)) + 1;
    for (let phase = firstPhase; phase < firstPhase + 6; phase++) {
      process.stderr.write(`resume trial ${item.trial}, phase ${phase}\n`);
      const result = await runWorker(cwd, home, phase, id);
      const session = result.observations.find(x=>x.kind==='session'), end=result.observations.find(x=>x.kind==='result');
      item.phases.push({ phase, reasoningEffort, ...result }); await save();
      assert.equal(session?.resumeUnchanged, true);
      if (end?.ok) {
        try { item.checks = await acceptance(cwd, path.join(folder, `acceptance-rescue-${phase}`)); item.passed=true; break; }
        catch (error) {
          const message = acceptanceFailure(error, [base.apiKey]);
          item.phases.at(-1).acceptanceFailure = message;
          const {store}=await SessionStore.resume(home,id,[base.apiKey]);
          try { store.data.messages.push({role:'user',content:`外部验收未通过，继续修复原任务，不得修改已有测试或验收脚本。实际失败：\n${message}`});await store.save(); }finally{await store.close();}
        }
      }
    }
    const saved=JSON.parse(await readFile(path.join(home,'sessions',id,'session.json'),'utf8'));
    const calls=saved.messages.filter((m:{role:string})=>m.role==='assistant').flatMap((m:{calls:ToolCall[]})=>m.calls) as ToolCall[];
    const outputs=saved.messages.filter((m:{role:string})=>m.role==='tool') as {id:string;content:string}[];
    item.allPaired=new Set(calls.map(x=>x.id)).size===calls.length&&calls.length===outputs.length&&calls.every(call=>outputs.some(result=>result.id===call.id));
    item.unknownWriteAudits=auditUnknownWrites(saved.messages,cwd);
    item.unknownWritesChecked=item.unknownWriteAudits.length===1&&item.unknownWriteAudits.every((audit:{checkedBeforeRepeat:boolean})=>audit.checkedBeforeRepeat);
    item.unknownResults=outputs.filter(x=>JSON.parse(x.content).error==='interrupted_unknown').length;
    await exec('git',['add','-N','--','tests/session-filters.test.ts'],{cwd}).catch(()=>{});
    const changed=(await exec('git',['diff','--name-only'],{cwd})).stdout.trim().split('\n').filter(Boolean);
    const untracked=(await exec('git',['ls-files','--others','--exclude-standard'],{cwd})).stdout.trim().split('\n').filter(Boolean);
    item.protectedFilesChanged=[...new Set([...changed,...untracked])].filter(file=>!editable.includes(file));
    item.recordedRunDurationMs=saved.runs.reduce((total:number,run:{startedAt:string;endedAt?:string})=>total+(run.endedAt?Math.max(0,Date.parse(run.endedAt)-Date.parse(run.startedAt)):0),0);
    item.runs=saved.runs.map((r:{status:string;usage:unknown;turns:number;toolCalls:number})=>({status:r.status,usage:r.usage,turns:r.turns,toolCalls:r.toolCalls}));
    item.ok=item.passed&&item.allPaired&&item.unknownWritesChecked&&item.unknownResults===1&&!item.protectedFilesChanged.length;
    const artifact=path.join(path.dirname(destination),`${path.basename(destination,'.json')}-trial-${item.trial}.patch`);
    await writeFile(artifact,(await exec('git',['diff','--',...editable],{cwd,maxBuffer:4*1024*1024})).stdout);item.patch=path.basename(artifact);
    await save();
  }
  report.complete=true;report.resumeFinishedAt=new Date().toISOString();await save();
  if(report.results.some((item:{ok:boolean})=>!item.ok))process.exitCode=1;
  // Keep these workspaces until their successful acceptance has been inspected.
  process.stderr.write(`Repository evaluation artifacts: ${root}\n`);
}
if (process.argv.includes('--worker')) await worker(); else if(process.argv.includes('--resume-report')) await resumeEvaluation(); else await main();

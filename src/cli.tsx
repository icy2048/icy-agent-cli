#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile, realpath } from 'node:fs/promises';
import process from 'node:process';
import path from 'node:path';
import React from 'react';
import { render } from 'ink';
import { loadConfig, initConfig } from './config/load.js';
import { SessionStore } from './sessions/store.js';
import { listSessions } from './sessions/list.js';
import { ToolRegistry } from './tools/registry.js';
import { ModelProvider, DemoProvider } from './providers/model.js';
import { Agent } from './core/agent.js';
import { App, type ApprovalBridge } from './ui/App.js';
import { errorText, redact } from './core/text.js';
import type { AgentEvent } from './core/types.js';

const help = `icy — AI agent CLI

用法:
  icy [目标]                   启动 Workbench（窄终端自动单栏）
  icy run "目标"              单次非交互运行
  icy run "目标" --json       输出 NDJSON 事件
  icy --resume <会话ID>        恢复会话，不重放中断的工具
  icy sessions [--json]       查看已有会话、目标与状态
  icy run --resume <ID> --continue  用新的运行预算继续原任务
  icy run --resume <ID> --verify "命令"  执行用户指定验收（沿用 bash 审批）
  icy --demo                  离线只读演示，不调用模型
  icy config init             创建用户配置，不覆盖已有文件

选项:
  --provider chat-completions|responses
  --base-url <地址>  --model <模型>  --cwd <目录>
  --read-only  --plain  --json  --help  --version

环境变量: ICY_BASE_URL, ICY_MODEL, ICY_PROVIDER, ICY_API_KEY, ICY_HOME
配置: ~/.icy/config.json。交互: /help /model /new /thinking /task /continue /verify /todo /done /sessions /resume /clear /exit
输入 / 选择命令；/model 配置服务并立即启用；Ctrl+T 展开或收起思考，显示设置自动保存。
默认向模型提供 read / write / edit / bash；--read-only 仅提供 read。
bash 需批准（包括列目录和搜索）。非交互模式不执行未批准的 bash。
`;
export async function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' }, json: { type: 'boolean' }, plain: { type: 'boolean' }, demo: { type: 'boolean' }, 'read-only': { type: 'boolean' },
    model: { type: 'string' }, provider: { type: 'string' }, 'base-url': { type: 'string' }, cwd: { type: 'string' }, resume: { type: 'string' }, continue: { type: 'boolean' }, verify: { type: 'string' },
  } });
  if (values.help) { process.stdout.write(help); return; }
  if (values.version) { const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')); process.stdout.write(pkg.version + '\n'); return; }
  const overrides = Object.fromEntries(Object.entries({ model: values.model, provider: values.provider, baseUrl: values['base-url'], permissions: values['read-only'] || values.demo ? 'read-only' : undefined }).filter(([, value]) => value !== undefined));
  let config = await loadConfig(await realpath(values.cwd || process.cwd()), overrides);
  if (positionals[0] === 'config' && positionals[1] === 'init') { process.stdout.write(`配置已创建：${await initConfig(config.home)}\n`); return; }
  if (positionals[0] === 'sessions') {
    const sessions = await listSessions(config.home);
    if (values.json) for (const session of sessions) process.stdout.write(JSON.stringify({ type: 'session_summary', ...session }) + '\n');
    else process.stdout.write(sessions.length ? sessions.map(s => s.error ? `${s.id} · 无法读取：${s.error}` : `${s.id} · ${s.status} · ${s.updatedAt}\n  ${s.model} · ${s.cwd}\n  ${s.goal || '空会话'}`).join('\n') + '\n' : '暂无会话。\n');
    return;
  }
  const isRun = positionals[0] === 'run', prompt = (isRun ? positionals.slice(1) : positionals).join(' ');
  if ((values.continue || values.verify !== undefined) && !values.resume) throw new Error('--continue / --verify 需要 --resume <会话ID>。');
  if ((values.continue && values.verify !== undefined) || ((values.continue || values.verify !== undefined) && prompt)) throw new Error('继续任务、验收命令和新目标每次只能选择一项。');
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY && !values.json && !values.plain && !isRun && !values.continue && values.verify === undefined);
  if (!interactive && !prompt && !values.demo && !values.continue && values.verify === undefined && !values.resume) { process.stderr.write('请提供目标：icy run "你的目标"，或在交互终端输入 icy。\n'); process.exitCode = 2; return; }
  const requiresModel = Boolean(prompt || values.continue);
  if (!values.demo && requiresModel && (!config.model || !config.apiKey) && !interactive) throw new Error(`请配置模型和 ${config.apiKeyEnv}。可先执行 icy --demo。`);
  if (values.demo) config = { ...config, provider: 'chat-completions', model: 'offline-demo', permissions: 'read-only', promptCompaction: 'local' };
  let store: SessionStore, recovery = 0;
  if (values.resume) {
    const restored = await SessionStore.resume(config.home, values.resume, [config.apiKey]); store = restored.store; recovery = restored.recovered;
    try {
      const resumedConfig = await loadConfig(await realpath(store.data.cwd), overrides);
      config = values.demo ? { ...resumedConfig, provider: 'chat-completions', model: 'offline-demo', permissions: 'read-only', promptCompaction: 'local' } : resumedConfig;
    } catch (error) { await store.close(); throw error; }
    if (store.data.provider !== config.provider || store.data.model !== config.model || store.data.baseUrl !== config.baseUrl) { await store.close(); throw new Error('恢复会话需要相同的 provider、model 和 baseUrl；请恢复原设置或开始新会话。'); }
    if (values.cwd && await realpath(values.cwd) !== store.data.cwd) { await store.close(); throw new Error('恢复时不能改变工作区。'); }
    config = { ...config, cwd: await realpath(store.data.cwd) };
  } else store = await SessionStore.create(config.home, { cwd: config.cwd, provider: config.provider, model: config.model, baseUrl: config.baseUrl }, [config.apiKey]);
  const bridge: ApprovalBridge = {};
  const tools = new ToolRegistry(config, store, interactive ? (request, signal) => bridge.current!(request, signal) : undefined);
  const provider = values.demo ? new DemoProvider() : new ModelProvider(config);
  const agent = new Agent(config, provider, tools, store);
  try {
    if (interactive) {
      const instance = render(<App agent={agent} approval={bridge} initialPrompt={prompt} demo={values.demo} recovery={recovery} />, { exitOnCtrlC: false });
      await instance.waitUntilExit();
    } else {
      const abort = new AbortController(), cancel = () => abort.abort(); process.on('SIGINT', cancel); process.on('SIGTERM', cancel);
      if (values.json) process.stdout.write(JSON.stringify({ type: 'session', id: store.data.id, cwd: config.cwd, provider: config.provider, model: config.model, demo: Boolean(values.demo) }) + '\n');
      else process.stderr.write(`icy · ${config.model} · ${config.cwd}\nsession: ${store.data.id}${values.demo ? ' · OFFLINE DEMO' : ''}\n`);
      const event = (e: AgentEvent) => {
        if (values.json) { process.stdout.write(JSON.stringify(e) + '\n'); return; }
        if (e.type === 'delta') process.stdout.write(e.text);
        if (e.type === 'harness_end' && e.stats.savedChars > 0) process.stderr.write(`提示词预处理：减少 ${e.stats.savedChars} 字符（原文保留）\n`);
        if (e.type === 'context' && e.stats.compactedToolResults) process.stderr.write(`上下文：${e.stats.beforeChars} → ${e.stats.afterChars} 字符，原始结果可回读\n`);
        if (e.type === 'assistant') process.stdout.write('\n');
        if (e.type === 'tool_start') process.stderr.write(`→ ${e.call.name}\n`);
        if (e.type === 'tool_end') process.stderr.write(`${e.result.ok ? '✓' : '✗'} ${e.call.name}: ${e.result.content.slice(0, 1200)}\n`);
        if (e.type === 'done' && !e.ok) process.stderr.write(`停止：${e.reason}\n`);
      };
      agent.setListener(event);
      try {
        if (!prompt && values.resume && !values.continue && values.verify === undefined && !values.demo) {
          const state = { type: 'task' as const, task: store.data.task, run: store.data.runs.at(-1) };
          if (values.json) process.stdout.write(JSON.stringify(state, (_key, value) => typeof value === 'string' ? redact(value, [config.apiKey]) : value) + '\n');
          else process.stdout.write(redact(`任务：${state.task?.goal || '旧会话无任务检查点'}\n状态：${state.task?.status || 'unknown'}\n使用 --continue 显式继续；新运行会记录新的预算。\n`, [config.apiKey]));
          return;
        }
        const result = values.continue ? await agent.continue(abort.signal) : values.verify !== undefined ? await agent.verify(values.verify, abort.signal) : await agent.run(prompt || '读取当前目录的 README.md', abort.signal);
        process.exitCode = result.ok ? 0 : result.reason === 'cancelled' ? 130 : result.reason === 'approval_required' ? 2 : 1;
      }
      finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
    }
  } finally { await agent.store.close(); }
}

main().catch(error => { process.stderr.write(`icy: ${redact(errorText(error))}\n`); process.exitCode = 1; });

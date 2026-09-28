import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import path from 'node:path';
import { ModelWizard } from './ModelWizard.js';
import { profileConfig, saveModelProfile, type ModelProfile, type ModelServices } from '../config/models.js';
import { ModelProvider } from '../providers/model.js';
import { Composer } from './Composer.js';
import { commands, matchCommands } from './commands.js';
import { cachedEntryLines, changedFiles, entryLines, processListSummary, processReference, projectTranscriptEvent, taskStatusLabel, taskSummary, transcriptFromMessages, type Entry } from './transcript.js';
import { saveThinkingPreference } from '../config/load.js';
import wrapAnsi from 'wrap-ansi';
import type { Agent } from '../core/agent.js';
import type { AgentEvent, ApprovalDecision, ApprovalRequest, Approve, RunResult } from '../core/types.js';
import type { RunState, TaskState } from '../core/run-state.js';
import { invalidStatusText, listSessions, parseStatusFilter, type SessionFilter } from '../sessions/list.js';
import { clean, errorText } from '../core/text.js';

export interface ApprovalBridge { current?: Approve }
interface Pending { request: ApprovalRequest; resolve: (choice: ApprovalDecision) => void }
const accent = 'cyan';
const spinFrames = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';

export function App({ agent, approval, initialPrompt = '', demo = false, recovery = 0, configureServices }: { agent: Agent; approval: ApprovalBridge; initialPrompt?: string; demo?: boolean; recovery?: number; configureServices?: ModelServices }) {
  const { exit } = useApp(), { columns, rows } = useWindowSize();
  const width = Math.max(30, columns || 80), dual = width >= 120;
  const [modelOpen, setModelOpen] = useState(false);
  const [entries, setEntries] = useState<Entry[]>(() => {
    const restored = transcriptFromMessages(agent.store.data.messages, agent.store.data.processes ?? []);
    return [...restored, ...(recovery ? [{ kind: 'notice' as const, text: `已恢复会话；${recovery} 个未完成调用已标记中断。请核对实际文件状态。` }] : [])];
  });
  const [input, setInput] = useState(''), [running, setRunning] = useState(false), [stream, setStream] = useState('');
  const latestRun = () => (agent.store.data.runs ?? []).at(-1);
  const [taskState, setTaskState] = useState<TaskState | undefined>(() => agent.store.data.task && structuredClone(agent.store.data.task));
  const [runState, setRunState] = useState<RunState | undefined>(() => latestRun() && structuredClone(latestRun()!));
  const taskStateRef = useRef(taskState);
  const [status, setStatus] = useState(taskState ? taskStatusLabel(taskState.status) : 'Ready'), [turn, setTurn] = useState(runState?.turns ?? 0), [tokens, setTokens] = useState(runState ? `${runState.usage.estimated ? '~' : ''}${runState.usage.tokens.toLocaleString()}` : '—');
  const [spin, setSpin] = useState(0), [elapsed, setElapsed] = useState(0);
  const [task, setTask] = useState(initialPrompt || taskState?.goal || agent.store.data.messages.findLast(message => message.role === 'user')?.content || ''), [pending, setPending] = useState<Pending>();
  const [details, setDetails] = useState(false), [scroll, setScroll] = useState(0);
  const changes = useMemo(() => changedFiles(entries), [entries]);
  const [approvalPage, setApprovalPage] = useState(0);
  const [thinkingExpanded, setThinkingExpanded] = useState(agent.config.thinkingExpanded ?? false);
  const thinkingRef = useRef(thinkingExpanded), preferenceSave = useRef(Promise.resolve());
  const [commandIndex, setCommandIndex] = useState(0), [menuDismissed, setMenuDismissed] = useState(false);
  const matches = !modelOpen && !running && !pending && !menuDismissed ? matchCommands(input) : [];
  const menuOpen = matches.length > 0, selectedCommand = matches[Math.min(commandIndex, matches.length - 1)];
  const changeInput = (value: string) => { setInput(value); setCommandIndex(0); setMenuDismissed(false); };
  const history = useRef<string[]>([]), historyIndex = useRef(0), controller = useRef<AbortController | null>(null), started = useRef(false);
  const busy = useRef(false), pendingRef = useRef<Pending | undefined>(undefined);
  const exitAfterCancel = useRef(false), exitStarted = useRef(false);
  const streamBuf = useRef(''), reasoningBuf = useRef(''), flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notice = (text: string) => setEntries(v => [...v, { kind: 'notice', text }]);
  const showTaskState = (nextTask?: TaskState, nextRun?: RunState) => {
    taskStateRef.current = nextTask && structuredClone(nextTask);
    setTaskState(taskStateRef.current); setRunState(nextRun && structuredClone(nextRun));
    if (nextTask) { setTask(nextTask.goal); setStatus(taskStatusLabel(nextTask.status)); }
    if (nextRun) { setTurn(nextRun.turns); setTokens(`${nextRun.usage.estimated ? '~' : ''}${nextRun.usage.tokens.toLocaleString()}`); }
  };
  const setThinking = (expanded: boolean) => {
    thinkingRef.current = expanded; setThinkingExpanded(expanded); setScroll(0);
    preferenceSave.current = preferenceSave.current.then(() => saveThinkingPreference(agent.config.home, expanded)).catch(e => notice(`思考显示设置未保存：${errorText(e)}`));
  };
  const closeAndExit = async () => {
    if (exitStarted.current) return;
    exitStarted.current = true;
    try {
      await preferenceSave.current;
      const terminated = await agent.store.close();
      if (terminated > 0) process.stderr.write(`已终止 ${terminated} 个后台进程（session_closed）。\n`);
    } catch (error) { process.stderr.write(`退出时关闭会话失败：${errorText(error)}\n`); }
    exit();
  };
  const exitSaved = () => { exitAfterCancel.current = true; if (!busy.current) void closeAndExit(); };
  const flushBuffers = () => {
    const delta = streamBuf.current, reasoning = reasoningBuf.current;
    streamBuf.current = ''; reasoningBuf.current = '';
    if (delta) { setStream(s => s + delta); setStatus('正在回答'); }
    if (reasoning) setEntries(v => projectTranscriptEvent(v, { type: 'reasoning_delta', text: reasoning }));
  };
  const flushNow = () => { if (flushTimer.current) { clearTimeout(flushTimer.current); flushTimer.current = null; } flushBuffers(); };
  const queueFlush = () => {
    if (flushTimer.current) return;
    flushBuffers();
    flushTimer.current = setTimeout(() => { flushTimer.current = null; flushBuffers(); }, 16);
  };
  const listener = useCallback((event: AgentEvent) => {
    switch (event.type) {
      case 'user': setEntries(v => projectTranscriptEvent(v, event)); setTask(event.text); setScroll(0); break;
      case 'harness_start': setStatus('整理提示词'); break;
      case 'harness_end':
        if (event.stats.savedChars > 0) notice(`上下文已精简 ${event.stats.savedChars.toLocaleString()} 字符 · 原文保留`);
        else if (event.stats.fallback) notice('提示词预处理未完成，已保留原文和关键字。');
        else if (event.stats.semantic === 'applied') notice('需求已提炼 · 关键字与约束已保留');
        break;
      case 'context': setEntries(v => projectTranscriptEvent(v, event)); break;
      case 'task': showTaskState(event.task, event.run); break;
      case 'turn': flushNow(); setTurn(event.turn); setStream(''); setStatus('思考中'); setEntries(v => projectTranscriptEvent(v, event)); break;
      case 'reasoning_delta': reasoningBuf.current += event.text; queueFlush(); break;
      case 'reasoning': flushNow(); setEntries(v => projectTranscriptEvent(v, event)); break;
      case 'delta': streamBuf.current += event.text; queueFlush(); break;
      case 'assistant': flushNow(); setStream(''); setEntries(v => projectTranscriptEvent(v, event)); break;
      case 'tool_start': setStatus(`Running ${event.call.name}`); setEntries(v => projectTranscriptEvent(v, event)); break;
      case 'tool_end': setEntries(v => projectTranscriptEvent(v, event)); break;
      case 'process': setEntries(v => projectTranscriptEvent(v, event)); break;
      case 'usage': setTokens(`${event.estimated ? '~' : ''}${event.tokens.toLocaleString()}`); break;
      case 'done': flushNow(); setEntries(v => projectTranscriptEvent(v, event)); setStatus(taskStateRef.current ? taskStatusLabel(taskStateRef.current.status) : event.ok ? '已回答 · 未验证' : event.reason === 'cancelled' ? 'Cancelled' : 'Stopped'); setStream(''); break;
    }
  }, []);
  agent.setListener(listener);
  approval.current = (request, signal) => new Promise(resolve => {
    const finish = (choice: ApprovalDecision) => { signal.removeEventListener('abort', cancel); pendingRef.current = undefined; setPending(undefined); resolve(choice); };
    const cancel = () => finish('deny');
    if (signal.aborted) { resolve('deny'); return; }
    const item = { request, resolve: finish }; pendingRef.current = item; setApprovalPage(0); setPending(item); setStatus('Awaiting approval');
    signal.addEventListener('abort', cancel, { once: true });
  });
  const localAction = async (action: () => Promise<void>) => {
    busy.current = true; setRunning(true);
    try { await action(); }
    catch (e) { notice(errorText(e)); }
    finally { busy.current = false; setRunning(false); if (exitAfterCancel.current) exitSaved(); }
  };
  const runTask = async (action: (signal: AbortSignal) => Promise<RunResult>) => {
    busy.current = true; setRunning(true); setStatus('准备中'); setTurn(0); setTokens('—');
    controller.current = new AbortController();
    try { await action(controller.current.signal); }
    catch (e) { notice(errorText(e)); setStatus('Stopped'); }
    finally { busy.current = false; setRunning(false); controller.current = null; if (exitAfterCancel.current) exitSaved(); }
  };
  const submit = async (value: string) => {
    const prompt = value.trim(); if (!prompt || busy.current) return;
    changeInput(''); setScroll(0);
    if (prompt === '/exit') { exitSaved(); return; }
    if (prompt === '/help') { notice(commands.map(c => `${c.command} ${c.description}`).join('\n') + '\n/ 菜单 · ↑↓ 选择 · Enter 执行 · Tab 补全 · Esc 关闭\nCtrl+T 思考 · Ctrl+O 工具 · PgUp/PgDn 翻页'); return; }
    if (['/thinking', '/thinking expanded', '/thinking collapsed'].includes(prompt)) {
      setThinking(prompt === '/thinking' ? !thinkingRef.current : prompt.endsWith(' expanded'));
      notice(`思考内容已${thinkingRef.current ? '展开' : '收起'}，后续启动沿用此设置。`); return;
    }
    if (prompt === '/model') { if (demo) notice('当前为离线演示；请运行 icy 后使用 /model 配置模型。'); else setModelOpen(true); return; }
    if (prompt === '/task') { notice(taskSummary(agent.store.data.task, latestRun(), agent.store.data.processes ?? [])); return; }
    if (prompt === '/ps') { notice(processListSummary(agent.store.data.processes ?? [])); return; }
    if (prompt === '/continue') { notice('继续原任务，将开启并记录新预算；已执行工具不会自动重放。'); await runTask(signal => agent.continue(signal)); return; }
    if (prompt === '/sessions' || prompt.startsWith('/sessions ')) {
      const argument = prompt.slice('/sessions'.length).trim();
      let filter: SessionFilter | undefined;
      try {
        for (const token of argument ? argument.split(/\s+/) : []) {
          const eq = token.indexOf('='), key = eq === -1 ? '' : token.slice(0, eq), value = eq === -1 ? '' : token.slice(eq + 1);
          if (key === 'status' && value) (filter ??= {}).status = parseStatusFilter(value);
          else if (key === 'cwd' && value) (filter ??= {}).cwd = value;
          else throw new Error('用法：/sessions [status=<状态，逗号分隔>] [cwd=<目录>]');
        }
      } catch (error) { notice(invalidStatusText(error) ?? errorText(error)); return; }
      await localAction(async () => {
        const sessions = await listSessions(agent.config.home, filter);
        notice(sessions.length ? sessions.map(session => session.error ? `${session.id} · 无法读取：${session.error}`
          : `${session.id}\n${session.goal || '尚无目标'} · ${session.model} · ${session.updatedAt}\n工作区：${session.cwd}`).join('\n\n') + '\n\n/resume <会话 ID> 恢复；不会自动执行任务。' : '尚无已保存会话。');
      });
      return;
    }
    const command = prompt.split(/\s/, 1)[0], argument = prompt.slice(command.length).trim();
    if (command === '/kill') {
      if (!argument) { notice('用法：/kill <icy-process:id 或 id>'); changeInput('/kill '); return; }
      await localAction(async () => {
        try {
          const record = await agent.killProcess(argument);
          notice(`后台进程 ${processReference(record.id)} 当前状态：${record.status}${record.reason ? `（${record.reason}）` : ''}`);
        } catch (error) { notice(`无法终止后台进程 ${argument}：${errorText(error)}`); }
      });
      return;
    }
    if (['/verify', '/todo', '/done', '/resume'].includes(command)) {
      if (!argument) { notice(`用法：${command} ${command === '/verify' ? '<验收命令>' : command === '/todo' ? '<待办事项>' : command === '/done' ? '<待办编号，从 1 开始>' : '<会话 ID>'}`); changeInput(command + ' '); return; }
      if (command === '/verify') { await runTask(signal => agent.verify(argument, signal)); return; }
      if (command === '/done' && (!/^[1-9]\d*$/.test(argument) || !Number.isSafeInteger(Number(argument)))) { notice('待办编号必须是从 1 开始的整数。'); return; }
      await localAction(async () => {
        if (command === '/todo') { await agent.addTodo(argument); showTaskState(agent.store.data.task, latestRun()); notice('待办已添加。使用 /task 查看编号。'); }
        else if (command === '/done') { await agent.completeTodo(Number(argument) - 1); showTaskState(agent.store.data.task, latestRun()); notice(`待办 ${argument} 已完成。`); }
        else {
          const restored = await agent.resumeSession(argument);
          flushNow(); setStream('');
          setEntries([...transcriptFromMessages(agent.store.data.messages, agent.store.data.processes ?? []), { kind: 'notice', text: `已恢复会话 ${agent.store.data.id}；${restored.recovered} 个未完成调用已标记。/task 查看状态，/continue 以新预算继续。` }]);
          setTask(agent.store.data.task?.goal || agent.store.data.messages.findLast(message => message.role === 'user')?.content || '');
          showTaskState(agent.store.data.task, latestRun());
          if (!agent.store.data.task) { setStatus('Ready'); setTurn(0); setTokens('—'); }
          history.current = []; historyIndex.current = 0;
        }
      });
      return;
    }
    if (prompt === '/new') {
      busy.current = true; setRunning(true); setStatus('准备中');
      try {
        await agent.newConversation();
        setEntries([{ kind: 'notice', text: '新对话已开启，原会话已保留。' }]);
        showTaskState();
        setTask(''); setStream(''); setTurn(0); setTokens('—'); setStatus('Ready');
        history.current = []; historyIndex.current = 0;
      } catch (e) { notice(errorText(e)); setStatus('Stopped'); }
      finally { busy.current = false; setRunning(false); if (exitAfterCancel.current) exitSaved(); }
      return;
    }
    if (prompt === '/clear') { await localAction(async () => { await agent.clear(); setEntries([]); setTask(''); showTaskState(); setStatus('Ready'); setTurn(0); setTokens('—'); }); return; }
    if (prompt.startsWith('/')) { notice('未知命令。输入 /help 查看帮助。'); return; }
    history.current.push(prompt); historyIndex.current = history.current.length;
    await runTask(signal => agent.run(prompt, signal));
  };
  useEffect(() => {
    if (!running) return;
    const startedAt = Date.now();
    setSpin(0); setElapsed(0);
    const id = setInterval(() => { setSpin(i => (i + 1) % 10); setElapsed(Math.floor((Date.now() - startedAt) / 1000)); }, 100);
    return () => clearInterval(id);
  }, [running]);
  useEffect(() => {
    const terminate = () => { exitAfterCancel.current = true; if (busy.current) controller.current?.abort(); else exitSaved(); };
    process.on('SIGINT', terminate); process.on('SIGTERM', terminate);
    if (!started.current) { started.current = true; if (initialPrompt) void submit(initialPrompt); }
    return () => { process.removeListener('SIGINT', terminate); process.removeListener('SIGTERM', terminate); controller.current?.abort(); pendingRef.current?.resolve('deny'); if (flushTimer.current) clearTimeout(flushTimer.current); };
  }, []);
  useInput((value, key) => {
    if (modelOpen) return;
    if (key.ctrl && (value === 'c' || value === 'd')) { if (busy.current) controller.current?.abort(); else exitSaved(); return; }
    if (key.escape) { if (menuOpen || (!running && input.startsWith('/'))) { setMenuDismissed(true); changeInput(''); return; } controller.current?.abort(); return; }
    if (pendingRef.current) {
      if (key.pageDown) setApprovalPage(p => Math.min(p + 1, approvalPages - 1));
      if (key.pageUp) setApprovalPage(p => Math.max(0, p - 1));
      if (value.toLowerCase() === 'n') pendingRef.current.resolve('deny');
      if (approvalPage === approvalPages - 1 && ['y', 'a'].includes(value.toLowerCase())) pendingRef.current.resolve(value.toLowerCase() === 'y' ? 'once' : 'session');
      return;
    }
    if (key.ctrl && value === 't') { setThinking(!thinkingRef.current); return; }
    if (menuOpen && (key.upArrow || key.downArrow)) { setCommandIndex(i => (i + (key.upArrow ? -1 : 1) + matches.length) % matches.length); return; }
    if (key.ctrl && value === 'o') { setDetails(v => !v); return; }
    if (key.pageUp) { setScroll(s => s + 8); return; }
    if (key.pageDown) { setScroll(s => Math.max(0, s - 8)); return; }
    if (!busy.current && (key.upArrow || key.downArrow)) {
      historyIndex.current = Math.max(0, Math.min(history.current.length, historyIndex.current + (key.upArrow ? -1 : 1)));
      changeInput(history.current[historyIndex.current] ?? '');
    }
  });
  const applyModel = async (profile: ModelProfile) => {
    const config = profileConfig(agent.config, profile);
    await agent.configure(config, new ModelProvider(config), () => saveModelProfile(config.home, profile));
    setEntries([{ kind: 'notice', text: `已连接 ${config.model}，配置已保存。旧会话保留，可用 --resume 恢复。` }]);
    showTaskState();
    setTask(''); setTurn(0); setTokens('—'); setStatus('Ready'); setModelOpen(false);
  };
  const leftWidth = dual ? width - 28 : width;
  const contentWidth = Math.max(10, leftWidth - 4);
  const selectedIndex = Math.min(commandIndex, matches.length - 1);
  const menuStart = Math.max(0, selectedIndex - 5), visibleCommands = matches.slice(menuStart, menuStart + 6);
  const menuRows = menuOpen ? visibleCommands.length + 1 : 0;
  const lineBudget = Math.max(3, (rows || 30) - (pending ? 15 : 9) - menuRows);
  const approvalLines = pending ? wrapAnsi(clean(pending.request.detach
    ? `后台命令（最长 ${Math.max(1, Math.ceil(pending.request.timeoutMs / 60_000))} 分钟，输出写入会话目录）\ncommand:\n${pending.request.command}\n\ncwd: ${pending.request.cwd}\ntimeout: ${Math.max(1, Math.ceil(pending.request.timeoutMs / 60_000))} 分钟（${pending.request.timeoutMs / 1000}s）\n输出写入磁盘；命令会在当前轮结束后继续运行。`
    : `command:\n${pending.request.command}\n\ncwd: ${pending.request.cwd}\ntimeout: ${pending.request.timeoutMs / 1000}s`), contentWidth, { hard: true, trim: false }).split('\n') : [];
  const approvalPages = Math.max(1, Math.ceil(approvalLines.length / lineBudget));
  const committed = useMemo(() => entries.flatMap(e => cachedEntryLines(e, contentWidth, details, thinkingExpanded)), [entries, contentWidth, details, thinkingExpanded]);
  const lines = stream ? [...committed, ...entryLines({ kind: 'assistant', text: stream }, contentWidth, details, thinkingExpanded)] : committed;
  const bottom = Math.max(lineBudget, lines.length - scroll), shown = lines.slice(Math.max(0, bottom - lineBudget), bottom);
  if (modelOpen) return <ModelWizard services={configureServices} config={agent.config} width={width} onClose={() => setModelOpen(false)} onApply={applyModel} />;
  return <Box flexDirection="column" width={width}>
    <Box paddingX={1} justifyContent="space-between"><Text color={accent} bold>✳ icy <Text dimColor>{demo ? '· OFFLINE DEMO' : '· ' + (agent.config.model || '/model 配置模型')}</Text></Text><Text dimColor>{path.basename(agent.config.cwd)}</Text></Box>
    <Box paddingX={1} marginBottom={1}><Text dimColor wrap="truncate-end">{new URL(agent.config.baseUrl).host} · {agent.config.permissions}</Text></Box>
    <Box>
      <Box flexDirection="column" width={leftWidth} paddingX={1}>
        <Box flexDirection="column" height={lineBudget} overflow="hidden">
          {pending ? approvalLines.slice(approvalPage * lineBudget, (approvalPage + 1) * lineBudget).map((line, i) => <Text key={i}>{line || ' '}</Text>) : shown.length ? shown.map((line, i) => <Box key={i}><Text color={line.markerColor}>{line.marker || '  '}</Text><Text color={line.color} dimColor={line.dim}>{line.text || ' '}</Text></Box>) : <Text dimColor>{demo ? '离线演示：输入任意目标，演示只读工具调用。' : '输入目标，icy 会决定下一步。/help 查看命令。'}</Text>}
        </Box>
        {scroll > 0 && <Text dimColor>↑ 历史视图 · PgDn 返回最新</Text>}
        {menuOpen && <Box flexDirection="column">
          {visibleCommands.map((item, i) => <Text key={item.command} color={i + menuStart === selectedIndex ? accent : undefined} dimColor={i + menuStart !== selectedIndex} wrap="truncate-end">{i + menuStart === selectedIndex ? '❯' : ' '} {item.command}  {item.description}</Text>)}
          <Text dimColor wrap="truncate-end">↑↓ 选择 · Enter 执行 · Tab 补全 · Esc 关闭</Text>
        </Box>}
        {pending ? <Box flexDirection="column" borderStyle="single" borderColor="yellow" paddingX={1}>
          <Text color="yellow">{pending.request.detach ? `后台命令（最长 ${Math.max(1, Math.ceil(pending.request.timeoutMs / 60_000))} 分钟，输出写入会话目录）` : '允许执行命令？'}</Text>
          <Text dimColor>命令预览 {approvalPage + 1}/{approvalPages} · PgUp/PgDn 翻页</Text>
          <Text>{approvalPage < approvalPages - 1 ? '请翻到最后一页查看完整命令；N 拒绝' : 'Y 允许一次 · A 本会话允许 · N 拒绝'}</Text>
          <Text dimColor>{pending.request.detach ? '输出写入磁盘；命令会在当前轮结束后继续运行。' : 'bash 在主机执行，可访问工作区之外的资源。'}</Text>
        </Box> : <Box flexDirection="column" marginTop={1}><Text dimColor>{'─'.repeat(leftWidth - 2)}</Text><Box paddingX={1}>
          <Text color={accent}>❯ </Text>
          {running ? <Text dimColor>{spinFrames[spin]} {status} {elapsed}s · Esc 取消</Text> : <Composer value={input} onChange={changeInput} onComplete={() => { if (selectedCommand) changeInput(selectedCommand.command + (selectedCommand.takesArgument || selectedCommand.command === '/thinking' ? ' ' : '')); }} onSubmit={value => void submit(selectedCommand?.command ?? value)} width={contentWidth - 4} />}
        </Box></Box>}
      </Box>
      {dual && <Box flexDirection="column" width={28} borderStyle="single" borderTop={false} borderBottom={false} borderRight={false} borderColor="gray" paddingX={1}>
        <Text dimColor>CURRENT TASK</Text><Text wrap="truncate-end">{clean(task) || '等待目标'}</Text><Text color={accent}>{taskState ? taskStatusLabel(taskState.status) : status}</Text>
        {runState && <Box flexDirection="column"><Text dimColor wrap="truncate-end">检查点 {clean(runState.checkpoint)}</Text><Text>剩余 tokens {Math.max(0, runState.budget.maxTokens - runState.usage.tokens).toLocaleString()}</Text>{runState.reason && <Text color="yellow" wrap="truncate-end">停止：{clean(runState.reason)}</Text>}</Box>}
        <Box marginTop={1} flexDirection="column"><Text dimColor>执行</Text><Text>模型请求 {turn}</Text><Text>Tokens {tokens}</Text><Text>{entries.filter(e => e.kind === 'tool').length} 次工具调用 / 会话</Text></Box>
        <Box marginTop={1} flexDirection="column"><Text dimColor>会话变更</Text>{changes.length ? changes.slice(-6).map(file => <Text color={accent} key={file} wrap="truncate-end">{file}</Text>) : <Text dimColor>—</Text>}</Box>
        <Box marginTop={1} flexDirection="column"><Text dimColor>会话</Text><Text wrap="truncate-end">{agent.store.data.id}</Text></Box>
      </Box>}
    </Box>
    <Box paddingX={2} marginTop={1} justifyContent="space-between"><Text color={pending ? 'yellow' : accent}>{status} <Text dimColor>· turn {turn} · tokens {tokens}{running ? ` · ${elapsed}s` : ''}</Text></Text><Text dimColor>Ctrl+T 思考 · / 命令</Text></Box>
  </Box>;
}

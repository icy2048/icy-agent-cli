import wrapAnsi from 'wrap-ansi';
import { clean } from '../core/text.js';
import type { AgentEvent, Message, ProcessRecord, ToolCall, ToolResult } from '../core/types.js';
import type { ExecutionStatus, RunState, TaskState } from '../core/run-state.js';

export const shortProcessId = (id: string) => id.slice(0, 8);
export const processReference = (id: string) => `icy-process:${shortProcessId(id)}`;
function processElapsed(record: ProcessRecord): number {
  const end = record.endedAt ? Date.parse(record.endedAt) : Date.now();
  const start = Date.parse(record.startedAt);
  return Number.isFinite(start) ? Math.max(0, Math.floor((end - start) / 1000)) : 0;
}
export function processTranscriptText(record: ProcessRecord): string {
  const reference = processReference(record.id);
  if (record.status === 'running') return `▶ 后台进程 ${reference} 已启动：${clean(record.command)}`;
  if (record.status === 'unknown') return `? 后台进程 ${reference} 状态未知（icy 重启后不再跟踪，pid ${record.pidAlive ? '仍存活' : '已不存在'}）`;
  if (record.status === 'timeout') return `■ 后台进程 ${reference} 已因超时终止`;
  if (record.status === 'output_limit') return `■ 后台进程 ${reference} 输出超过 16 MiB 终止`;
  if (record.status === 'killed') return `■ 后台进程 ${reference} 已被终止（${record.reason || 'unknown'}）`;
  if (record.status === 'spawn_error') return `■ 后台进程 ${reference} 启动失败（${record.reason || 'spawn_error'}）`;
  return `■ 后台进程 ${reference} 已结束，退出码 ${record.exitCode ?? '未知'}${record.signal ? `（${record.signal}）` : ''}`;
}
export function processListSummary(processes: ProcessRecord[] = []): string {
  if (!processes.length) return '没有后台进程。';
  return processes.map(record => {
    const ended = record.endedAt ? `结束 ${record.endedAt}` : `已运行 ${processElapsed(record)}s`;
    const exit = record.exitCode !== undefined && record.exitCode !== null ? `退出码 ${record.exitCode}` : record.reason ? `原因 ${record.reason}` : record.signal ? `原因 ${record.signal}` : '退出码 —';
    const command = Array.from(clean(record.command)).slice(0, 80).join('');
    return `${processReference(record.id)} · 状态：${record.status} · pid ${record.pid ?? '—'} · ${ended} · ${exit} · 字节 ${record.bytes} · ${command}`;
  }).join('\n');
}

export interface Entry {
  kind: 'user' | 'assistant' | 'tool' | 'notice' | 'thinking' | 'process';
  text: string; call?: ToolCall; result?: ToolResult; active?: boolean; interrupted?: boolean;
}
export interface TranscriptLine { text: string; color?: string; backgroundColor?: string; marker?: string; markerColor?: string; dim?: boolean }

function updateThinking(entries: Entry[], update: (entry: Entry) => Entry): Entry[] {
  const index = entries.findLastIndex(entry => entry.kind === 'thinking');
  return entries.map((entry, i) => i === index ? update(entry) : entry);
}

/** One projection for live events and the equivalent events recovered from messages. */
export function projectTranscriptEvent(entries: Entry[], event: AgentEvent): Entry[] {
  switch (event.type) {
    case 'user': return [...entries, { kind: 'user', text: event.text }];
    case 'assistant': return event.text ? [...entries, { kind: 'assistant', text: event.text }] : entries;
    case 'turn': return [...entries, { kind: 'thinking', text: '', active: true }];
    case 'reasoning_delta': return updateThinking(entries, entry => ({ ...entry, text: entry.text + event.text }));
    case 'reasoning': return updateThinking(entries, entry => ({ ...entry, text: event.text, active: false }));
    case 'tool_start':
      return entries.some(entry => entry.call?.id === event.call.id) ? entries
        : [...entries, { kind: 'tool', text: event.call.name, call: event.call }];
    case 'tool_end': {
      const started = projectTranscriptEvent(entries, { type: 'tool_start', call: event.call });
      return started.map(entry => entry.call?.id === event.call.id ? { ...entry, result: event.result } : entry);
    }
    case 'process': return [...entries, { kind: 'process', text: processTranscriptText(event.record) }];
    case 'context': {
      const { beforeChars, afterChars, compactedToolResults, fallback } = event.stats;
      const text = fallback ? `上下文压缩失败，已保留完整上下文（${beforeChars.toLocaleString()} 字符）。`
        : compactedToolResults ? `上下文压缩：${beforeChars.toLocaleString()} → ${afterChars.toLocaleString()} 字符 · ${compactedToolResults} 条历史结果已保存为可读引用。` : '';
      return text ? [...entries, { kind: 'notice', text }] : entries;
    }
    case 'done': {
      const completed = updateThinking(entries, entry => entry.active ? { ...entry, active: false, interrupted: true } : entry);
      return event.ok ? completed : [...completed, { kind: 'notice', text: `已停止：${event.reason}` }];
    }
    default: return entries;
  }
}

function restoredResult(raw: string): ToolResult {
  try {
    const value: unknown = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const result = value as Record<string, unknown>;
      if (typeof result.ok === 'boolean' && typeof result.content === 'string') {
        return { ok: result.ok, content: result.content,
          ...(typeof result.error === 'string' ? { error: result.error } : {}),
          ...(typeof result.truncated === 'boolean' ? { truncated: result.truncated } : {}),
          ...(typeof result.durationMs === 'number' ? { durationMs: result.durationMs } : {}),
          ...(typeof result.changedFile === 'string' ? { changedFile: result.changedFile } : {}),
          ...(typeof result.diff === 'string' ? { diff: result.diff } : {}),
        };
      }
    }
  } catch { /* Preserve unrecognized legacy output without claiming that it succeeded. */ }
  return { ok: false, error: 'unknown_tool_result', content: `历史工具结果无法识别，原始内容：\n${raw}` };
}

export function transcriptFromMessages(messages: Message[], processes: ProcessRecord[] = []): Entry[] {
  let entries: Entry[] = [];
  const calls = new Map<string, ToolCall>();
  for (const message of messages) {
    if (message.role === 'user') entries = projectTranscriptEvent(entries, { type: 'user', text: message.content });
    else if (message.role === 'assistant') {
      entries = projectTranscriptEvent(entries, { type: 'turn', turn: 0 });
      entries = projectTranscriptEvent(entries, { type: 'reasoning', text: message.reasoning ?? '' });
      entries = projectTranscriptEvent(entries, { type: 'assistant', text: message.content });
      for (const call of message.calls) {
        calls.set(call.id, call);
        entries = projectTranscriptEvent(entries, { type: 'tool_start', call });
      }
    } else {
      const call = calls.get(message.id);
      if (call) entries = projectTranscriptEvent(entries, { type: 'tool_end', call, result: restoredResult(message.content) });
      else entries = [...entries, { kind: 'notice', text: `历史工具结果缺少对应调用（${message.id}）：\n${message.content}` }];
    }
  }
  for (const record of processes) entries = projectTranscriptEvent(entries, { type: 'process', record });
  return entries;
}

export function changedFiles(entries: Entry[]): string[] {
  return [...new Set(entries.flatMap(entry => entry.kind === 'tool' && entry.result?.changedFile ? [entry.result.changedFile] : []))];
}

export function taskStatusLabel(status: ExecutionStatus): string {
  return { running: '执行中', awaiting_approval: '等待批准', cancelled: '已取消', limited: '达到限制', failed: '失败', answered: '已回答 · 未验证', verified: '已验证完成', interrupted: '已中断' }[status];
}

export function taskSummary(task?: TaskState, run?: RunState, processes: ProcessRecord[] = []): string {
  if (!task) {
    const lines = ['当前会话没有任务状态记录；旧会话的完成状态与验收结果保持未知。'];
    if (processes.length) {
      const running = processes.filter(process => process.status === 'running').length;
      const unknown = processes.filter(process => process.status === 'unknown').length;
      lines.push(`后台进程：${running} 个运行中、${unknown} 个状态未知`);
      if (running) lines.push('后台进程运行中时，已验证完成被阻止。');
    }
    return lines.join('\n');
  }
  const lines = [`目标：${task.goal}`, `状态：${taskStatusLabel(task.status)}`];
  if (run) {
    lines.push(`最近检查点：${run.checkpoint}`, `模型请求：${run.turns}/${run.budget.maxModelTurns} · 工具调用：${run.toolCalls}/${run.budget.maxToolCalls}`,
      `Tokens：${run.usage.estimated ? '~' : ''}${run.usage.tokens.toLocaleString()}/${run.budget.maxTokens.toLocaleString()} · 剩余 ${Math.max(0, run.budget.maxTokens - run.usage.tokens).toLocaleString()}`);
    if (run.reason) lines.push(`停止原因：${run.reason}`);
    lines.push(`本次预算：${run.budgetSource === 'explicit_resume' ? '用户显式继续，已开启新预算' : '新任务预算'}`);
  }
  lines.push('待办：', ...(task.remaining.length ? task.remaining.map((item, i) => `${i + 1}. ${item}`) : ['暂无待办记录']));
  if (task.completed.length) lines.push('已完成：', ...task.completed.map(item => `✓ ${item}`));
  if (processes.length) {
    const running = processes.filter(process => process.status === 'running').length;
    const unknown = processes.filter(process => process.status === 'unknown').length;
    lines.push(`后台进程：${running} 个运行中、${unknown} 个状态未知`);
    if (running) lines.push('后台进程运行中时，已验证完成被阻止。');
  }
  lines.push('最近验收记录：');
  if (!task.verificationRecords.length) lines.push('尚无验收记录；/verify <命令> 指定并执行验收。');
  for (const record of task.verificationRecords.slice(-3)) {
    const stale = record.mutationRevision !== task.mutationRevision;
    lines.push(`${stale ? '已过期' : record.ok ? '通过' : '失败'} · ${record.command}`, `工作目录：${record.cwd}`, `记录时间：${record.recordedAt}`, record.output);
  }
  lines.push('/continue 使用新预算继续原目标；/todo <事项> 添加待办；/done <编号> 完成待办。');
  return lines.join('\n');
}

export function describeCall(call: ToolCall, result?: ToolResult): string {
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(call.arguments);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return call.name;
    args = parsed as Record<string, unknown>;
  } catch { return call.name; }
  if (call.name === 'read' || call.name === 'write' || call.name === 'edit') {
    if (typeof args.path !== 'string' || !args.path) return call.name;
    let summary = `${call.name} ${args.path}`;
    if ((call.name === 'write' || call.name === 'edit') && typeof result?.diff === 'string') {
      let added = 0; let removed = 0; let inHunk = false;
      for (const line of result.diff.split('\n')) {
        if (line.startsWith('@@')) inHunk = true;
        else if (!inHunk) continue;
        else if (line.startsWith('+')) added++;
        else if (line.startsWith('-')) removed++;
      }
      summary += ` +${added} −${removed}`;
    }
    return summary;
  }
  if (call.name === 'bash') {
    if (typeof args.command !== 'string' || !args.command) return call.name;
    let command = args.command.replace(/[\r\n\t]/g, ' ').replace(/ +/g, ' ');
    if (command.length > 60) command = command.slice(0, 59) + '…';
    return `bash ${command}`;
  }
  return call.name;
}
export function entryLines(entry: Entry, width: number, details: boolean, expanded: boolean): TranscriptLine[] {
  const { kind } = entry;
  let value = entry.text;
  if (kind === 'thinking') {
    if (!entry.text && !entry.active && !entry.interrupted && !expanded) return [];
    const state = entry.active ? '思考中…' : entry.interrupted ? '已中断' : '思考';
    value = `${expanded ? '▾' : '▸'} ${state}`;
    if (expanded) value += '\n' + (entry.text || (entry.active ? '等待接口返回可见思考内容…' : entry.interrupted ? '尚未收到可见思考内容。' : '本次接口未返回可见思考内容。'));
  } else if (kind === 'notice') value = `! ${value}`;
  else if (kind === 'process') value = entry.text;
  else if (kind === 'tool') {
    const summary = entry.call ? describeCall(entry.call, entry.result) : entry.text;
    const status = entry.result?.error === 'interrupted_unknown' ? '? 执行结果未知'
      : entry.result?.error === 'not_executed' ? '– 未执行'
      : entry.result?.error === 'unknown_tool_result' ? '? 结果无法识别'
      : !entry.result ? '·' : entry.result.ok ? '✓' : '✗';
    value = `${status} ${summary}${entry.result?.durationMs !== undefined ? ` (${entry.result.durationMs}ms)` : ''}`;
    if (entry.call && details) {
      value += `\n${entry.call.arguments}\n${entry.result?.content || (entry.result ? '' : '执行中…')}`;
      if (entry.result?.diff && entry.result.diff !== entry.result.content) value += `\n${entry.result.diff}`;
    }
    else if (entry.result && !entry.result.ok) value += '\n' + entry.result.content;
  }
  if (!value && kind === 'assistant') return [];
  const isMessage = kind === 'user' || kind === 'assistant';
  const marker = isMessage ? '▌ ' : '  ';
  const markerColor = kind === 'user' ? 'blue' : kind === 'assistant' ? 'cyan' : undefined;
  const wrapped = wrapAnsi(clean(value), Math.max(4, width - 3), { hard: true, trim: false }).split('\n');
  const lines: TranscriptLine[] = wrapped.map(text => ({ text, marker, markerColor,
    color: kind === 'tool' && entry.result && !entry.result.ok ? 'yellow' : undefined,
    dim: kind === 'thinking' || kind === 'notice' || kind === 'tool' || kind === 'process',
  }));
  return [...lines, { text: '' }];
}
const lineCache = new WeakMap<Entry, { width: number; details: boolean; expanded: boolean; lines: TranscriptLine[] }>();
export function cachedEntryLines(entry: Entry, width: number, details: boolean, expanded: boolean): TranscriptLine[] {
  const hit = lineCache.get(entry);
  if (hit && hit.width === width && hit.details === details && hit.expanded === expanded) return hit.lines;
  const lines = entryLines(entry, width, details, expanded);
  lineCache.set(entry, { width, details, expanded, lines });
  return lines;
}

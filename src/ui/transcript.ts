import wrapAnsi from 'wrap-ansi';
import { clean } from '../core/text.js';
import type { ToolCall, ToolResult } from '../core/types.js';

export interface Entry {
  kind: 'user' | 'assistant' | 'tool' | 'notice' | 'thinking';
  text: string; call?: ToolCall; result?: ToolResult; active?: boolean; interrupted?: boolean;
}
export interface TranscriptLine { text: string; color?: string; backgroundColor?: string; marker?: string; markerColor?: string; dim?: boolean }
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
      let added = 0; let removed = 0;
      for (const line of result.diff.split('\n')) {
        if (line.startsWith('+') && !line.startsWith('+++')) added++;
        else if (line.startsWith('-') && !line.startsWith('---')) removed++;
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
  else if (kind === 'tool') {
    const summary = entry.call ? describeCall(entry.call, entry.result) : entry.text;
    value = `${!entry.result ? '·' : entry.result.ok ? '✓' : '✗'} ${summary} ${entry.result ? `(${entry.result.durationMs ?? 0}ms)` : ''}`;
    if (entry.call && details) value += `\n${entry.call.arguments}\n${entry.result?.diff || entry.result?.content || '执行中…'}`;
    else if (entry.result && !entry.result.ok) value += '\n' + entry.result.content;
  }
  if (!value && kind === 'assistant') return [];
  const isMessage = kind === 'user' || kind === 'assistant';
  const marker = isMessage ? '▌ ' : '  ';
  const markerColor = kind === 'user' ? 'blue' : kind === 'assistant' ? 'cyan' : undefined;
  const wrapped = wrapAnsi(clean(value), Math.max(4, width - 3), { hard: true, trim: false }).split('\n');
  const lines: TranscriptLine[] = wrapped.map(text => ({ text, marker, markerColor,
    color: kind === 'tool' && entry.result && !entry.result.ok ? 'yellow' : undefined,
    dim: kind === 'thinking' || kind === 'notice' || kind === 'tool',
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

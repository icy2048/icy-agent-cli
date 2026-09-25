import type { PreparedRequest } from './types.js';

const words = new Intl.Segmenter(undefined, { granularity: 'word' });
const literalPattern = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`|"(?:\\.|[^"\\])*"|'[^'\n]+'/g;
export function sourceKeywords(input: string): string[] {
  // Keep every distinct source word, including CJK words, rather than guessing importance.
  // Compound identifiers/paths/commands are additionally indexed without splitting them.
  const compounds = input.match(/https?:\/\/[^\s<>"'）。，；]+|(?:[\p{L}\p{N}_.@-]+\/)+[\p{L}\p{N}_.@-]+|(?:--?|\/)[\p{L}\p{N}_-]+|[A-Za-z_$][\w$.-]*|\d+(?:[._-]\d+)*/gu) ?? [];
  return [...new Set([...compounds, ...[...words.segment(input)].filter(s => s.isWordLike).map(s => s.segment)])];
}
export function sourceConstraints(input: string): string[] {
  // Quoted documents/code are data, not newly promoted requirements.
  const literals: string[] = [];
  const masked = input.replace(literalPattern, value => { literals.push(value); return `\u0000${literals.length - 1}\u0000`; });
  return [...new Set(masked.split(/(?<=[。！？!?])|\n/).map(s => s.trim())
    .filter(s => /不要|不得|不能|必须|禁止|只允许|不允许|至少|至多|最多|最少|原样|逐字|保留|\b(?:must|never|not|only|at least|at most|exactly)\b/i.test(s))
    .map(s => s.replace(/\u0000(\d+)\u0000/g, (_, i) => literals[Number(i)])))];
}
export function assembleRequest(original: string, task: string, keywords: string[] = [], constraints: string[] = [], originalRef?: string): PreparedRequest {
  const requestText = original.replace(literalPattern, '');
  const fromRequest = (constraint: string) => {
    const outsideQuotes = constraint.replace(literalPattern, '').trim();
    return outsideQuotes && original.includes(constraint) && requestText.includes(outsideQuotes);
  };
  // Keywords index only source terms that the refined task no longer contains verbatim.
  const mergedKeywords = [...new Set([...sourceKeywords(original), ...keywords.filter(k => k.trim() && original.includes(k))])];
  return {
    schema: 'icy.user-request.v2', task,
    keywords: mergedKeywords.filter(k => !task.includes(k)),
    constraints: [...new Set([...sourceConstraints(original), ...constraints.filter(fromRequest)])],
    ...(originalRef ? { original_ref: originalRef } : {}),
  };
}

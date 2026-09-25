import React, { useEffect, useRef, useState } from 'react';
import { Text, useInput, usePaste } from 'ink';
import stringWidth from 'string-width';
import { clean } from '../core/text.js';

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const graphemes = (value: string) => [...segmenter.segment(value)].map(s => s.segment);

export function Composer({ value, onChange, onSubmit, onComplete, width, secret = false, placeholder = ' 输入你的目标…' }: { value: string; onChange: (v: string) => void; onSubmit: (v: string) => void; onComplete?: () => void; width: number; secret?: boolean; placeholder?: string }) {
  const [cursor, setCursor] = useState(graphemes(value).length);
  const ownValue = useRef(value);
  useEffect(() => { if (value !== ownValue.current) setCursor(graphemes(value).length); ownValue.current = value; }, [value]);
  const chars = graphemes(value), offset = Math.min(cursor, chars.length);
  const update = (next: string[], position: number) => { const text = next.join('').slice(0, 20000); ownValue.current = text; onChange(text); setCursor(Math.min(position, graphemes(text).length)); };
  const insert = (text: string) => { const added = graphemes(clean(text.replace(/\r\n?/g, '\n'))); update([...chars.slice(0, offset), ...added, ...chars.slice(offset)], offset + added.length); };
  usePaste(insert);
  useInput((input, key) => {
    if (key.ctrl) {
      if (input === 'a') setCursor(0);
      if (input === 'e') setCursor(chars.length);
      if (input === 'u') update(chars.slice(offset), 0);
      if (input === 'k') update(chars.slice(0, offset), offset);
      return;
    }
    if (key.tab) { onComplete?.(); return; }
    if (key.escape || key.upArrow || key.downArrow || key.pageUp || key.pageDown) return;
    if (key.return) { if (key.meta || key.shift) insert('\n'); else onSubmit(value); return; }
    if (key.leftArrow) { setCursor(Math.max(0, offset - 1)); return; }
    if (key.rightArrow) { setCursor(Math.min(chars.length, offset + 1)); return; }
    if (key.home) { setCursor(0); return; }
    if (key.end) { setCursor(chars.length); return; }
    if (key.backspace || key.delete) { if (offset) update([...chars.slice(0, offset - 1), ...chars.slice(offset)], offset - 1); return; }
    if (!key.meta && !key.super) insert(input);
  });
  const display = chars.map(c => secret ? '•' : c === '\n' ? '↵' : c === '\t' ? ' ' : c);
  let start = offset, used = 0;
  while (start > 0 && used + stringWidth(display[start - 1]) < Math.max(4, width - 5)) { start--; used += stringWidth(display[start]); }
  let end = offset, rightWidth = 0;
  while (end < display.length && used + rightWidth + stringWidth(display[end]) < width - 3) { rightWidth += stringWidth(display[end]); end++; }
  return <Text>{start > 0 ? '‹' : ''}{display.slice(start, offset).join('')}<Text inverse>{display[offset] || ' '}</Text>{display.slice(offset + 1, end).join('')}{end < display.length ? '›' : ''}{!value && <Text dimColor>{placeholder}</Text>}</Text>;
}

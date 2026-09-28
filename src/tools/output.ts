/** Select literal excerpts, without interpreting output or changing its full reference. */
export function outputPreview(content: string, failed: boolean): string {
  const chars = Array.from(content);
  const diagnostic = failed ? /(?:^|\n)[^\n]*(?:not ok \d|AssertionError|Error:|error TS\d|FAIL\b|Traceback \()[^\n]*/m.exec(content) : null;
  if (!diagnostic) return `${chars.slice(0, 2000).join('')}\n[... omitted ...]\n${chars.slice(-2000).join('')}`;
  const start = Math.max(0, Array.from(content.slice(0, diagnostic.index)).length - 200);
  const excerpt = chars.slice(start, start + 1500).join('');
  return `${chars.slice(0, 1250).join('')}\n[... diagnostic excerpt; other failures may be omitted ...]\n${excerpt}\n[... tail ...]\n${chars.slice(-1250).join('')}`;
}

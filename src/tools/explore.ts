import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import * as vm from 'node:vm';
import path from 'node:path';
import { canonicalPath, workspacePath, sensitive } from './paths.js';

const MAX_FILE_BYTES = 1_000_000;
const MAX_LISTING_ENTRIES = 500;
const MAX_REGEX_PATTERN_CHARS = 200;
const MAX_MATCHES = 200;
const MAX_SCANNED_FILES = 2_000;
const LISTING_TIME_BUDGET_MS = 5_000;
const SEARCH_TIME_BUDGET_MS = 10_000;
const regexMatcher = new vm.Script(String.raw`(() => {
  const expression = new RegExp(pattern);
  const indexes = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    expression.lastIndex = 0;
    if (expression.test(lines[i])) indexes.push(i);
  }
  return indexes;
})()`);
const IGNORED_NAMES = new Set(['.git', 'node_modules', 'dist', '.icy']);

type EntryKind = 'directory' | 'file' | 'symlink' | 'other';
type Entry = { name: string; fullPath: string; relativePath: string; kind: EntryKind; size?: number };

function posixPath(value: string): string {
  return value.split(path.sep).join('/');
}

function ignored(relativePath: string): boolean {
  const parts = relativePath.split(path.sep).filter(Boolean);
  return sensitive(relativePath) || parts.some(part => IGNORED_NAMES.has(part));
}

async function entriesIn(directory: string, root: string, signal?: AbortSignal): Promise<Entry[]> {
  signal?.throwIfAborted();
  const names = await readdir(directory);
  const entries: Entry[] = [];
  for (const name of names) {
    signal?.throwIfAborted();
    const fullPath = path.join(directory, name);
    const relativePath = path.relative(root, fullPath);
    if (ignored(relativePath)) continue;
    let info;
    try { info = await lstat(fullPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const kind: EntryKind = info.isSymbolicLink() ? 'symlink'
      : info.isDirectory() ? 'directory'
        : info.isFile() ? 'file' : 'other';
    entries.push({ name, fullPath, relativePath, kind, ...(kind === 'file' ? { size: info.size } : {}) });
  }
  entries.sort((a, b) => {
    const directoryOrder = Number(b.kind === 'directory') - Number(a.kind === 'directory');
    return directoryOrder || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  });
  return entries;
}

function entryLine(entry: Entry): string {
  const name = posixPath(entry.relativePath);
  if (entry.kind === 'directory') return `${name}/`;
  if (entry.kind === 'symlink') return `${name}@`;
  if (entry.kind === 'file') return `${name}  ${entry.size}`;
  return name;
}

async function workspaceTarget(cwd: string, input: string): Promise<{ root: string; target: string }> {
  const target = await workspacePath(cwd, input);
  // workspacePath resolves cwd before applying its checks. realpath is repeated here
  // only to make paths in results relative to the same canonical workspace root.
  const root = canonicalPath(await realpath(cwd));
  return { root, target };
}

export async function listDirectory(
  cwd: string,
  input: string,
  offset: number | null,
  limit: number | null,
  depth: number | null,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const { root, target } = await workspaceTarget(cwd, input);
  const rootInfo = await lstat(target);
  if (!rootInfo.isDirectory()) throw new Error('not_a_directory');

  const start = (offset ?? 1) - 1;
  const requested = Math.min(limit ?? MAX_LISTING_ENTRIES, MAX_LISTING_ENTRIES);
  // Keep enough entries after the requested window to avoid walking an entire
  // large tree while still making small, finite listings report their count.
  const walkLimit = start + requested + MAX_LISTING_ENTRIES;
  const deadline = Date.now() + LISTING_TIME_BUDGET_MS;
  const all: { line: string }[] = [];
  const maxDepth = depth ?? 1;
  let cut = false;
  const stopWalking = () => {
    signal.throwIfAborted();
    if (all.length >= walkLimit || Date.now() >= deadline) {
      cut = true;
      return true;
    }
    return false;
  };
  const collect = async (directory: string, level: number): Promise<void> => {
    if (stopWalking()) return;
    const entries = await entriesIn(directory, root, signal);
    if (stopWalking()) return;
    for (const entry of entries) {
      if (stopWalking()) return;
      all.push({ line: entryLine(entry) });
      // The entry just added is at level + 1 relative to the requested path.
      if (entry.kind === 'directory' && level + 1 < maxDepth) {
        await collect(entry.fullPath, level + 1);
        if (cut) return;
      }
    }
  };
  await collect(target, 0);

  const shown = all.slice(start, start + requested);
  const footer = cut
    ? `[${shown.length} entries shown of ${MAX_LISTING_ENTRIES}+]`
    : start === 0 && shown.length === all.length
      ? `[${all.length} entries]`
      : `[${shown.length} entries shown of ${all.length}]`;
  return [...shown.map(entry => entry.line), footer].join('\n');
}

export async function searchWorkspace(
  cwd: string,
  input: string,
  pattern: string,
  useRegex: boolean,
  offset: number | null,
  limit: number | null,
  depth: number | null,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const deadline = Date.now() + SEARCH_TIME_BUDGET_MS;
  if (!pattern.length || useRegex && pattern.length > MAX_REGEX_PATTERN_CHARS) throw new Error('invalid_pattern');
  if (useRegex) {
    try { new RegExp(pattern); }
    catch { throw new Error('invalid_pattern'); }
  }

  const { root, target } = await workspaceTarget(cwd, input);
  const rootInfo = await lstat(target);
  if (!rootInfo.isDirectory() && !rootInfo.isFile()) throw new Error('not_a_file_or_directory');

  const matches: string[] = [];
  let matchingFiles = 0;
  let scannedFiles = 0;
  let regexTimeouts = 0;
  let truncated = false;
  let stopped = false;

  const stopIfNeeded = () => {
    signal.throwIfAborted();
    if (Date.now() >= deadline) {
      truncated = true;
      stopped = true;
      return true;
    }
    return false;
  };
  const isRegexTimeout = (error: unknown): boolean => /Script execution timed out/.test(String(error));

  const inspectFile = async (file: string, relativePath: string, size: number): Promise<void> => {
    if (stopped || stopIfNeeded()) return;
    scannedFiles++;
    let content: string;
    try {
      if (size > MAX_FILE_BYTES) return;
      content = await readFile(file, 'utf8');
    } catch {
      return;
    }
    if (content.includes('\0')) return;

    const lines = content.split('\n');
    let regexMatches: Set<number> | undefined;
    if (useRegex) {
      try {
        const indexes = regexMatcher.runInNewContext({ content, pattern }, { timeout: 1000 });
        if (!Array.isArray(indexes) || indexes.some(index => !Number.isSafeInteger(index))) throw new Error('invalid_pattern');
        regexMatches = new Set(indexes as number[]);
      } catch (error) {
        if (isRegexTimeout(error)) { regexTimeouts++; return; }
        throw new Error('invalid_pattern');
      }
      if (stopIfNeeded()) return;
    }

    let fileMatched = false;
    for (let i = 0; i < lines.length; i++) {
      if (stopIfNeeded()) return;
      const line = lines[i]!;
      const found = regexMatches ? regexMatches.has(i) : line.includes(pattern);
      if (!found) continue;
      if (!fileMatched) matchingFiles++;
      fileMatched = true;
      matches.push(`${posixPath(relativePath)}:${i + 1}: ${line.trim().slice(0, 300)}`);
      if (matches.length >= MAX_MATCHES) {
        truncated = true;
        stopped = true;
        return;
      }
    }
  };

  const walk = async (directory: string, level: number): Promise<void> => {
    if (stopped || stopIfNeeded()) return;
    const entries = await entriesIn(directory, root, signal);
    if (stopped || stopIfNeeded()) return;
    for (const entry of entries) {
      if (stopped || stopIfNeeded()) return;
      if (entry.kind === 'directory') {
        if (depth === null || level + 1 < depth) await walk(entry.fullPath, level + 1);
      } else if (entry.kind === 'file') {
        if (scannedFiles >= MAX_SCANNED_FILES) {
          truncated = true;
          stopped = true;
          return;
        }
        await inspectFile(entry.fullPath, entry.relativePath, entry.size ?? 0);
        if (scannedFiles >= MAX_SCANNED_FILES && !stopped) {
          truncated = true;
          stopped = true;
          return;
        }
      }
    }
  };

  if (rootInfo.isFile()) {
    await inspectFile(target, path.relative(root, target), rootInfo.size);
  } else {
    await walk(target, 0);
  }

  const start = (offset ?? 1) - 1;
  const shown = matches.slice(start, start + (limit ?? MAX_MATCHES));
  const paged = start > 0 || start + shown.length < matches.length;
  const footer = paged
    ? `[${shown.length} matches shown of ${matches.length} in ${matchingFiles} files; ${scannedFiles} files scanned]`
    : `[${matches.length} matches in ${matchingFiles} files; ${scannedFiles} files scanned]`;
  return [...shown, footer, ...(regexTimeouts ? [`[regexTimeouts: ${regexTimeouts}]`] : []), ...(truncated ? ['[truncated]'] : [])].join('\n');
}

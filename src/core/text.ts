import { stripVTControlCharacters } from 'node:util';

export function clean(text: string): string {
  return stripVTControlCharacters(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}
export function redact(text: string, secrets: string[] = []): string {
  let value = clean(text);
  for (const secret of secrets.filter(Boolean)) value = value.split(secret).join('[REDACTED]');
  return value.replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/g, '[REDACTED]')
    .replace(/((?:api[_-]?key|password|secret|access[_-]?token)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

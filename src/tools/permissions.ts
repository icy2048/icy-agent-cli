import type { Config } from '../config/load.js';
import type { Approve } from '../core/types.js';
import type { ToolInput } from './definitions.js';
import { workspacePath } from './paths.js';

/** Session-scoped exact grants. No file writes or process execution occur here. */
export class PermissionPolicy {
  private allowed = new Set<string>();
  private denied = new Set<string>();
  private approvalListener?: (waiting: boolean) => Promise<void>;
  constructor(private config: Pick<Config, 'permissions' | 'cwd'>, private approve?: Approve) {}
  setApprovalListener(listener?: (waiting: boolean) => Promise<void>) { this.approvalListener = listener; }
  isToolAllowed(name: string): boolean { return this.config.permissions !== 'read-only' || name === 'read'; }
  assertToolAllowed(name: string) { if (!this.isToolAllowed(name)) throw new Error('read_only'); }
  async authorize(input: ToolInput, signal: AbortSignal): Promise<ToolInput> {
    signal.throwIfAborted();
    this.assertToolAllowed(input.name);
    if (input.name !== 'bash') return input;
    const a = input.args, cwd = await workspacePath(this.config.cwd, a.cwd ?? '.');
    const detach = a.detach ?? false, kill = a.kill ?? null;
    const timeoutMs = a.timeoutMs ?? (detach ? 1_800_000 : 60_000);
    if (detach !== true && timeoutMs > 60_000) throw new Error('timeout_exceeds_foreground_limit');
    if (kill !== null) {
      if (a.command !== 'kill' || detach) throw new Error('invalid_arguments');
      return { name: 'bash', args: { command: 'kill', cwd, timeoutMs, detach: false, kill } };
    }
    const request = { command: a.command, cwd, timeoutMs, detach };
    const key = JSON.stringify(request);
    if (this.denied.has(key)) throw new Error('permission_denied');
    if (!this.allowed.has(key)) {
      if (!this.approve) throw new Error('approval_required');
      await this.approvalListener?.(true);
      let choice;
      try { choice = await this.approve(request, signal); }
      finally { await this.approvalListener?.(false); }
      signal.throwIfAborted();
      this.assertToolAllowed(input.name);
      if (choice === 'deny') { this.denied.add(key); throw new Error('permission_denied'); }
      if (choice !== 'once' && choice !== 'session') throw new Error('invalid_approval_decision');
      if (choice === 'session') this.allowed.add(key);
    }
    return { name: 'bash', args: { command: a.command, cwd, timeoutMs, detach, kill: null } };
  }
}

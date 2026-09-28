import { z } from 'zod';
import type { Config } from '../config/load.js';
import type { Approve, ToolCall, ToolDefinition, ToolResult } from '../core/types.js';
import type { SessionStore } from '../sessions/store.js';
import { redact, errorText } from '../core/text.js';
import { schemas, descriptions, parseToolInput } from './definitions.js';
import { PermissionPolicy } from './permissions.js';
import { ToolExecutor } from './executor.js';
import { outputPreview } from './output.js';
export { sha256 } from './executor.js';

/** Tool contract, validation and bounded output. Authorization and effects have separate owners. */
export class ToolRegistry {
  private policy: PermissionPolicy;
  private executor: ToolExecutor;
  constructor(readonly config: Config, private store: SessionStore, private approve?: Approve) {
    this.policy = new PermissionPolicy(config, approve);
    this.executor = new ToolExecutor(config, store);
  }
  forSession(config: Config, store: SessionStore) { return new ToolRegistry(config, store, this.approve); }
  setApprovalListener(listener?: (waiting: boolean) => Promise<void>) { this.policy.setApprovalListener(listener); }
  definitions(): ToolDefinition[] {
    return Object.entries(schemas).filter(([name]) => this.policy.isToolAllowed(name)).map(([name, schema]) => ({ name, description: descriptions[name as keyof typeof schemas], parameters: z.toJSONSchema(schema.strict()) }));
  }
  async execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    const start = Date.now();
    try {
      signal.throwIfAborted();
      if (!Object.hasOwn(schemas, call.name)) throw new Error('unknown_tool');
      this.policy.assertToolAllowed(call.name);
      const input = parseToolInput(call.name, call.arguments);
      const authorized = await this.policy.authorize(input, signal);
      const result = await this.executor.execute(authorized, signal, { callId: call.id });
      result.content = redact(result.content, [this.config.apiKey]);
      if (result.diff) result.diff = redact(result.diff, [this.config.apiKey]);
      if (Buffer.byteLength(result.content) > 32768) {
        const id = await this.store.output(result.content);
        const length = Array.from(result.content).length;
        result.content = outputPreview(result.content, !result.ok) + `\n[TRUNCATED: ${length} characters total; read path="icy-output:${id}" offset=1 limit=6000]`; result.truncated = true;
      }
      if (result.diff && result.diff.length > 8000) { const id = await this.store.output(result.diff); result.diff = result.diff.slice(0, 8000) + `\n[Diff truncated: read path="icy-output:${id}" offset=1 limit=6000]`; }
      result.durationMs ??= Date.now() - start; return result;
    } catch (e) {
      const content = redact(errorText(e), [this.config.apiKey]);
      const stable = /^(invalid_arguments|timeout_exceeds_foreground_limit|process_not_found|arguments_not_supported_for_process|arguments_not_supported_for_output|output_reference_is_read_only|offset_out_of_range|bash_unavailable|read_only|approval_required|permission_denied)(?::|$)/.exec(content)?.[1];
      return { ok: false, error: signal.aborted ? 'cancelled' : stable ?? 'tool_error', content, durationMs: Date.now() - start };
    }
  }
}

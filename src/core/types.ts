export interface ToolCall { id: string; name: string; arguments: string }
export interface PreparedRequest {
  schema: 'icy.user-request.v2'; task: string; keywords: string[]; constraints: string[]; original_ref?: string;
}
export type Message =
  | { role: 'user'; content: string; preparedContent?: string; preparedRequest?: PreparedRequest }
  | { role: 'assistant'; content: string; calls: ToolCall[]; opaque?: unknown[]; reasoning?: string }
  | { role: 'tool'; id: string; content: string };
export interface ToolResult {
  ok: boolean; content: string; error?: string; truncated?: boolean;
  durationMs?: number; changedFile?: string; diff?: string;
}
export interface ToolDefinition { name: string; description: string; parameters: Record<string, unknown> }
export interface Completion {
  text: string; calls: ToolCall[]; opaque?: unknown[]; tokens?: number; incomplete?: string; reasoning?: string;
}
export interface Provider {
  complete(messages: Message[], tools: ToolDefinition[], signal: AbortSignal,
    onDelta: (text: string) => void, onReasoning?: (text: string) => void): Promise<Completion>;
}
export type ApprovalDecision = 'once' | 'session' | 'deny';
export interface ApprovalRequest { command: string; cwd: string; timeoutMs: number }
export type Approve = (request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalDecision>;
export type AgentEvent =
  | { type: 'user'; text: string }
  | { type: 'harness_start' }
  | { type: 'harness_end'; stats: import('./harness.js').PromptStats }
  | { type: 'turn'; turn: number }
  | { type: 'delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'assistant'; text: string }
  | { type: 'tool_start'; call: ToolCall }
  | { type: 'tool_end'; call: ToolCall; result: ToolResult }
  | { type: 'usage'; tokens: number; estimated: boolean }
  | { type: 'done'; reason: string; ok: boolean };
export interface RunResult { ok: boolean; reason: string; text?: string }

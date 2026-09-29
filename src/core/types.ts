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
export interface ProcessRecord {
  id: string; toolCallId: string; command: string; cwd: string; pid?: number; identity?: string; identityScheme?: 'v2'; startedAt: string; endedAt?: string;
  timeoutMs: number; status: 'running' | 'exited' | 'killed' | 'timeout' | 'output_limit' | 'spawn_error' | 'unknown';
  exitCode?: number | null; signal?: string; bytes: number; truncated?: boolean; reason?: string; pidAlive?: boolean;
}
export interface ToolDefinition { name: string; description: string; parameters: Record<string, unknown> }
export interface Usage { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; totalTokens: number }
export interface RequestBudget { maxOutputTokens: number }
export interface Completion {
  text: string; calls: ToolCall[]; opaque?: unknown[]; tokens?: number; usage?: Usage; incomplete?: string; reasoning?: string;
}
export interface Provider {
  estimateInputChars?(messages: Message[], tools: ToolDefinition[]): number;
  complete(messages: Message[], tools: ToolDefinition[], signal: AbortSignal,
    onDelta: (text: string) => void, onReasoning?: (text: string) => void, budget?: RequestBudget): Promise<Completion>;
}
export type ApprovalDecision = 'once' | 'session' | 'deny';
export interface ApprovalRequest { command: string; cwd: string; timeoutMs: number; detach?: boolean }
export type Approve = (request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalDecision>;
export type AgentEvent =
  | { type: 'task'; task?: import('./run-state.js').TaskState; run?: import('./run-state.js').RunState }
  | { type: 'user'; text: string }
  | { type: 'harness_start' }
  | { type: 'harness_end'; stats: import('./harness.js').PromptStats }
  | { type: 'context'; stats: import('./context.js').ContextStats }
  | { type: 'turn'; turn: number; reminderChars?: number }
  | { type: 'delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'assistant'; text: string }
  | { type: 'tool_start'; call: ToolCall }
  | { type: 'tool_end'; call: ToolCall; result: ToolResult }
  | { type: 'process'; record: ProcessRecord }
  | { type: 'usage'; tokens: number; estimated: boolean; usage?: Usage }
  | { type: 'done'; reason: string; ok: boolean };
export interface RunResult { ok: boolean; reason: string; text?: string }

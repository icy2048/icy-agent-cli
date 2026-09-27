import type { Completion, RequestBudget, Usage } from './types.js';

type Source = 'model' | 'preprocessing';
export interface BudgetSnapshot {
  tokens: number;
  estimated: boolean;
  usage: Usage;
  modelTokens: number;
  preprocessingTokens: number;
}

function validCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** A conservative character heuristic, not a tokenizer or a billing guarantee. */
export function estimateInputTokens(characters: number): number {
  if (!Number.isFinite(characters) || characters < 0) throw new Error('Invalid input character count.');
  return Math.ceil(characters / 2);
}

/** One run's soft token budget, including preprocessing and the main model. */
export class Budget {
  private spent = 0;
  private hasEstimate = false;
  private modelTokens = 0;
  private preprocessingTokens = 0;
  private inputTokens: number | undefined = 0;
  private outputTokens: number | undefined = 0;
  private cachedInputTokens: number | undefined = 0;

  constructor(readonly maxTokens: number) {
    if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) throw new Error('Invalid token budget.');
  }
  get remaining(): number { return Math.max(0, this.maxTokens - this.spent); }

  /** Include serialized messages, tool definitions and instructions in inputChars. */
  requestOptions(inputChars: number, maxOutputTokens = this.maxTokens): RequestBudget | undefined {
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) throw new Error('Invalid output token limit.');
    const available = this.remaining - estimateInputTokens(inputChars);
    if (available < 1) return;
    return { maxOutputTokens: Math.min(maxOutputTokens, available) };
  }

  record(completion: Completion, inputChars: number, source: Source = 'model'): BudgetSnapshot {
    const usage = completion.usage;
    if (usage && validCount(usage.totalTokens)) return this.charge(usage.totalTokens, false, usage, source);
    if (validCount(completion.tokens)) return this.charge(completion.tokens, false, undefined, source);
    const outputChars = completion.text.length + (completion.reasoning?.length ?? 0) + JSON.stringify(completion.calls).length;
    return this.charge(estimateInputTokens(inputChars) + estimateInputTokens(outputChars), true, undefined, source);
  }

  recordPreprocessing(tokens: number, estimated: boolean, usage?: Usage): BudgetSnapshot {
    if (usage && validCount(usage.totalTokens)) return this.charge(usage.totalTokens, estimated, usage, 'preprocessing');
    if (!validCount(tokens)) throw new Error('Invalid preprocessing token count.');
    // A skipped/local pass made no request and must not erase known usage detail.
    if (tokens === 0 && !estimated) return this.snapshot();
    return this.charge(tokens, estimated, undefined, 'preprocessing');
  }

  stopReason(): 'budget_exceeded' | 'token_budget' | undefined {
    if (this.spent > this.maxTokens) return 'budget_exceeded';
    if (this.spent === this.maxTokens) return 'token_budget';
  }

  snapshot(): BudgetSnapshot {
    return {
      tokens: this.spent, estimated: this.hasEstimate, modelTokens: this.modelTokens, preprocessingTokens: this.preprocessingTokens,
      usage: { totalTokens: this.spent,
        ...(this.inputTokens !== undefined ? { inputTokens: this.inputTokens } : {}),
        ...(this.outputTokens !== undefined ? { outputTokens: this.outputTokens } : {}),
        ...(this.cachedInputTokens !== undefined ? { cachedInputTokens: this.cachedInputTokens } : {}),
      },
    };
  }

  private charge(tokens: number, estimated: boolean, usage: Usage | undefined, source: Source): BudgetSnapshot {
    this.spent += tokens; this.hasEstimate ||= estimated;
    if (source === 'model') this.modelTokens += tokens; else this.preprocessingTokens += tokens;
    this.inputTokens = this.addKnown(this.inputTokens, usage?.inputTokens);
    this.outputTokens = this.addKnown(this.outputTokens, usage?.outputTokens);
    this.cachedInputTokens = this.addKnown(this.cachedInputTokens, usage?.cachedInputTokens);
    return this.snapshot();
  }
  private addKnown(previous: number | undefined, next: unknown): number | undefined {
    return previous !== undefined && validCount(next) ? previous + next : undefined;
  }
}

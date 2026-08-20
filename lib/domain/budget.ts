import type { ResearchDepth, ResearchPhase } from "./types";
import type { BudgetLimits, BudgetUsage, TokenUsage } from "./types";
import { parseBudgetLimits } from "./validation";

export const BUDGET_PRESETS: Record<ResearchDepth, BudgetLimits> = {
  quick: {
    maxTurns: 4,
    maxLlmCalls: 6,
    maxToolCalls: 8,
    maxSearchCalls: 6,
    maxEvidenceAttempts: 24,
    maxNetworkRequests: 20,
    maxInputTokens: 24_000,
    maxOutputTokens: 8_000,
    maxThinkingTokens: 8_000,
    maxCostUsd: 1,
    maxDurationMs: 60_000,
    maxConsecutiveNoProgress: 2,
    maxActionsPerTurn: 3,
    phaseCaps: { plan: 1, discover: 2, separate_candidates: 2, corroborate: 2, calibrate: 2, report: 1 },
  },
  standard: {
    maxTurns: 8,
    maxLlmCalls: 12,
    maxToolCalls: 20,
    maxSearchCalls: 16,
    maxEvidenceAttempts: 80,
    maxNetworkRequests: 60,
    maxInputTokens: 80_000,
    maxOutputTokens: 24_000,
    maxThinkingTokens: 32_000,
    maxCostUsd: 5,
    maxDurationMs: 240_000,
    maxConsecutiveNoProgress: 3,
    maxActionsPerTurn: 4,
    phaseCaps: { plan: 2, discover: 4, separate_candidates: 4, corroborate: 6, calibrate: 4, report: 1 },
  },
  deep: {
    maxTurns: 16,
    maxLlmCalls: 28,
    maxToolCalls: 48,
    maxSearchCalls: 40,
    maxEvidenceAttempts: 240,
    maxNetworkRequests: 160,
    maxInputTokens: 240_000,
    maxOutputTokens: 72_000,
    maxThinkingTokens: 120_000,
    maxCostUsd: 20,
    maxDurationMs: 900_000,
    maxConsecutiveNoProgress: 4,
    maxActionsPerTurn: 6,
    phaseCaps: { plan: 3, discover: 8, separate_candidates: 8, corroborate: 12, calibrate: 8, report: 1 },
  },
};

export function resolveBudgetLimits(
  depth: ResearchDepth = "standard",
  overrides: Partial<BudgetLimits> = {},
): BudgetLimits {
  const preset = BUDGET_PRESETS[depth];
  return parseBudgetLimits({
    ...preset,
    ...overrides,
    phaseCaps: overrides.phaseCaps ? { ...overrides.phaseCaps } : { ...preset.phaseCaps },
  });
}

export const EMPTY_BUDGET_USAGE: BudgetUsage = {
  turns: 0,
  llmCalls: 0,
  toolCalls: 0,
  searchCalls: 0,
  evidenceAttempts: 0,
  networkRequests: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  thinkingTokens: 0,
  costUsd: 0,
  elapsedMs: 0,
  consecutiveNoProgress: 0,
  phaseTurns: {},
};

function finiteIncrement(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a finite non-negative number`);
  }
  return value;
}

export function exhaustedBudgetDimensions(limits: BudgetLimits, usage: BudgetUsage): string[] {
  const exhausted: string[] = [];
  if (usage.turns >= limits.maxTurns) exhausted.push("turns");
  if (usage.llmCalls >= limits.maxLlmCalls) exhausted.push("llm_calls");
  if (usage.toolCalls >= limits.maxToolCalls) exhausted.push("tool_calls");
  if (usage.searchCalls >= limits.maxSearchCalls) exhausted.push("search_calls");
  if (usage.evidenceAttempts >= limits.maxEvidenceAttempts) exhausted.push("evidence_attempts");
  if (usage.networkRequests >= limits.maxNetworkRequests) exhausted.push("network_requests");
  if (usage.inputTokens >= limits.maxInputTokens) exhausted.push("input_tokens");
  if (usage.outputTokens >= limits.maxOutputTokens) exhausted.push("output_tokens");
  if (usage.thinkingTokens >= limits.maxThinkingTokens) exhausted.push("thinking_tokens");
  if (usage.costUsd >= limits.maxCostUsd) exhausted.push("cost_usd");
  if (usage.elapsedMs >= limits.maxDurationMs) exhausted.push("duration_ms");
  return exhausted;
}

export function phaseCapReached(limits: BudgetLimits, usage: BudgetUsage, phase: ResearchPhase): boolean {
  const cap = limits.phaseCaps[phase];
  return cap !== undefined && (usage.phaseTurns[phase] ?? 0) >= cap;
}

export class BudgetLedger {
  readonly limits: BudgetLimits;
  readonly #startedMonotonicMs: number;
  #usage: BudgetUsage;

  constructor(limits: BudgetLimits, startedMonotonicMs: number, initialUsage: BudgetUsage = EMPTY_BUDGET_USAGE) {
    this.limits = parseBudgetLimits(limits);
    this.#startedMonotonicMs = startedMonotonicMs;
    this.#usage = { ...initialUsage, phaseTurns: { ...initialUsage.phaseTurns } };
  }

  beginTurn(phase: ResearchPhase, nowMonotonicMs: number): void {
    this.#usage.turns += 1;
    this.#usage.phaseTurns[phase] = (this.#usage.phaseTurns[phase] ?? 0) + 1;
    this.updateElapsed(nowMonotonicMs);
  }

  recordLlmCall(nowMonotonicMs: number): void {
    this.recordLlmCalls(1, nowMonotonicMs);
  }

  recordLlmCalls(count: number, nowMonotonicMs: number): void {
    this.#usage.llmCalls += finiteIncrement(count, "llmCalls");
    this.updateElapsed(nowMonotonicMs);
  }

  canAttemptLlm(nowMonotonicMs: number): boolean {
    this.updateElapsed(nowMonotonicMs);
    return exhaustedBudgetDimensions(this.limits, this.#usage).length === 0;
  }

  recordTokens(tokens: Partial<TokenUsage>, nowMonotonicMs: number): void {
    this.#usage.inputTokens += finiteIncrement(tokens.inputTokens ?? 0, "inputTokens");
    this.#usage.cachedInputTokens += finiteIncrement(tokens.cachedInputTokens ?? 0, "cachedInputTokens");
    this.#usage.outputTokens += finiteIncrement(tokens.outputTokens ?? 0, "outputTokens");
    this.#usage.thinkingTokens += finiteIncrement(tokens.thinkingTokens ?? 0, "thinkingTokens");
    this.#usage.costUsd += finiteIncrement(tokens.costUsd ?? 0, "costUsd");
    this.#usage.costUsd = Math.round(this.#usage.costUsd * 1_000_000) / 1_000_000;
    this.updateElapsed(nowMonotonicMs);
  }

  recordToolCall(networkRequests: number, search: boolean, nowMonotonicMs: number): void {
    this.#usage.toolCalls += 1;
    if (search) this.#usage.searchCalls += 1;
    this.recordNetworkRequests(networkRequests, nowMonotonicMs);
  }

  /** Charges outbound work that is not itself a research tool call, such as an LLM request. */
  recordNetworkRequests(count: number, nowMonotonicMs: number): void {
    this.#usage.networkRequests += finiteIncrement(count, "networkRequests");
    this.updateElapsed(nowMonotonicMs);
  }

  recordEvidenceAttempt(nowMonotonicMs: number): void {
    this.#usage.evidenceAttempts += 1;
    this.updateElapsed(nowMonotonicMs);
  }

  canAttemptEvidence(nowMonotonicMs: number): boolean {
    this.updateElapsed(nowMonotonicMs);
    return this.#usage.evidenceAttempts < this.limits.maxEvidenceAttempts;
  }

  endTurn(madeProgress: boolean, nowMonotonicMs: number): void {
    this.#usage.consecutiveNoProgress = madeProgress ? 0 : this.#usage.consecutiveNoProgress + 1;
    this.updateElapsed(nowMonotonicMs);
  }

  updateElapsed(nowMonotonicMs: number): void {
    const elapsed = finiteIncrement(nowMonotonicMs - this.#startedMonotonicMs, "elapsedMs");
    this.#usage.elapsedMs = Math.max(this.#usage.elapsedMs, Math.round(elapsed));
  }

  canStartTurn(phase: ResearchPhase, nowMonotonicMs: number): boolean {
    this.updateElapsed(nowMonotonicMs);
    return (
      exhaustedBudgetDimensions(this.limits, this.#usage).length === 0 &&
      !phaseCapReached(this.limits, this.#usage, phase)
    );
  }

  canExecuteActions(count: number, searchCount: number, nowMonotonicMs: number): boolean {
    this.updateElapsed(nowMonotonicMs);
    return (
      Number.isInteger(count) &&
      count >= 0 &&
      count <= this.limits.maxActionsPerTurn &&
      this.#usage.toolCalls + count <= this.limits.maxToolCalls &&
      this.#usage.searchCalls + searchCount <= this.limits.maxSearchCalls &&
      exhaustedBudgetDimensions(this.limits, this.#usage).length === 0
    );
  }

  exhausted(nowMonotonicMs: number): string[] {
    this.updateElapsed(nowMonotonicMs);
    return exhaustedBudgetDimensions(this.limits, this.#usage);
  }

  snapshot(nowMonotonicMs?: number): BudgetUsage {
    if (nowMonotonicMs !== undefined) this.updateElapsed(nowMonotonicMs);
    return { ...this.#usage, phaseTurns: { ...this.#usage.phaseTurns } };
  }
}

import { canTransitionPhase } from "../domain/state-machine";
import { evaluateStop, type StopEvaluationOptions } from "../domain/stopping";
import { classifySafety } from "../domain/safety";
import {
  containsRestrictedPublicContent,
  urlContainsRestrictedParameters,
} from "../domain/content-policy";
import type { Clock, IdFactory } from "../domain/runtime";
import { cloneJson, isJsonValue } from "../domain/runtime";
import {
  SCHEMA_VERSION,
  type BudgetLimits,
  type CandidateDraft,
  type EvidenceDraft,
  type FindingDraft,
  type IdentitySignal,
  type InvestigationInput,
  type InvestigationReport,
  type InvestigationState,
  type JsonObject,
  type JsonValue,
  type ResearchPhase,
  type TokenUsage,
} from "../domain/types";
import { InvestigationEngine, type InvestigationEngineOptions } from "./engine";
import type { TraceEnvelopeV1, TraceEvent, TraceSpanStatus } from "./trace";

export type ActionStatus =
  | "succeeded"
  | "partial"
  | "not_found"
  | "rate_limited"
  | "failed"
  | "skipped"
  | "canceled";

export const MAX_OUTBOUND_CONCURRENCY = 4;

export interface ResearchActionV1 {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  tool: string;
  purpose: string;
  arguments: JsonObject;
  candidateId?: string;
  budgetClass: "search" | "fetch" | "compute";
}

export type ResearchAction = ResearchActionV1;

export interface ProposedResearchAction {
  tool: string;
  purpose: string;
  arguments: JsonObject;
  candidateId?: string;
  budgetClass?: "search" | "fetch" | "compute";
}

export interface PlannerContextV1 {
  schemaVersion: typeof SCHEMA_VERSION;
  state: InvestigationState;
  availableTools: string[];
  legalNextPhases: ResearchPhase[];
  signal?: AbortSignal;
  modelAccounting: ModelAttemptAccounting;
}

export interface DependencyModelTelemetry {
  llmCalls: number;
  networkRequests: number;
  tokenUsage?: Partial<TokenUsage>;
  reportedUsageFields?: Array<keyof TokenUsage>;
  /** Explicitly marks fields the provider did not return or a failed attempt could not report. */
  usageUnavailableReason?: string;
}

export interface ModelAttemptSettlement {
  networkRequests: number;
  tokenUsage?: Partial<TokenUsage>;
  reportedUsageFields?: Array<keyof TokenUsage>;
  usageUnavailableReason?: string;
}

/**
 * Per-attempt accounting supplied by the deterministic runner. Dependencies
 * must reserve before every provider attempt and settle it exactly once.
 */
export interface ModelAttemptAccounting {
  reserve(): boolean;
  settle(settlement: ModelAttemptSettlement): void;
}

type PlannerDecisionValue =
  | {
      kind: "actions";
      decisionSummary: string;
      actions: ProposedResearchAction[];
    }
  | {
      kind: "advance";
      decisionSummary: string;
      nextPhase?: ResearchPhase;
    }
  | {
      kind: "stop";
      decisionSummary: string;
    };

export type PlannerDecision = PlannerDecisionValue & {
  /** Backward-compatible aggregate for dependencies that do not use modelAccounting. */
  tokenUsage?: Partial<TokenUsage>;
  modelTelemetry?: DependencyModelTelemetry;
};

export interface ToolDiagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  retryable: boolean;
  details?: JsonObject;
}

export interface CandidateSignalUpdate {
  candidateId: string;
  signals: IdentitySignal[];
}

export interface ActionResultMeta {
  durationMs?: number;
  requests?: number;
  bytesRead?: number;
  incomplete?: boolean;
  /** Internal model attempts made by the tool, including structured-output repair attempts. */
  llmCalls?: number;
}

export interface ResearchActionResult {
  status: ActionStatus;
  data?: JsonValue | null;
  candidates?: CandidateDraft[];
  candidateSignals?: CandidateSignalUpdate[];
  evidence?: EvidenceDraft[];
  findings?: FindingDraft[];
  diagnostics?: ToolDiagnostic[];
  meta?: ActionResultMeta;
  tokenUsage?: Partial<TokenUsage>;
}

export interface ActionContextV1 {
  schemaVersion: typeof SCHEMA_VERSION;
  state: InvestigationState;
  signal?: AbortSignal;
  modelAccounting: ModelAttemptAccounting;
}

export interface SynthesisResult {
  findings: FindingDraft[];
  openQuestions?: string[];
  decisionSummary: string;
  tokenUsage?: Partial<TokenUsage>;
  modelTelemetry?: DependencyModelTelemetry;
}

export interface SynthesisContextV1 {
  schemaVersion: typeof SCHEMA_VERSION;
  signal?: AbortSignal;
  modelAccounting: ModelAttemptAccounting;
}

export interface ResearchDependencies {
  clock: Clock;
  ids: IdFactory;
  planner(context: PlannerContextV1): Promise<PlannerDecision>;
  executeAction(action: ResearchAction, context: ActionContextV1): Promise<ResearchActionResult>;
  synthesize?(state: InvestigationState, context: SynthesisContextV1): Promise<SynthesisResult>;
}

export interface ResearchRunnerOptions extends InvestigationEngineOptions {
  budget?: Partial<BudgetLimits>;
  availableTools?: string[];
  signal?: AbortSignal;
  minimumFindings?: number;
  minimumIndependentSourceFamilies?: number;
}

export type ResearchUpdate =
  | {
      schemaVersion: typeof SCHEMA_VERSION;
      type: "trace";
      event: TraceEvent;
    }
  | {
      schemaVersion: typeof SCHEMA_VERSION;
      type: "state";
      state: InvestigationState;
    }
  | {
      schemaVersion: typeof SCHEMA_VERSION;
      type: "completed";
      state: InvestigationState;
      report: InvestigationReport;
      trace: TraceEnvelopeV1;
    };

const PROHIBITED_TOOL_PATTERN =
  /(?:breach|credential|password|private[_-]?contact|phone[_-]?lookup|address[_-]?lookup|face[_-]?recognition|data[_-]?broker)/i;

const PROHIBITED_ARGUMENT_KEY_PATTERN =
  /(?:homeaddress|residentialaddress|personalphone|password|credential|ssn|socialsecurity|realtimelocation|clientsecret|authtoken|sessionid|authorizationcode|oauthcode)/i;

function actionBudgetClass(
  action: Pick<ProposedResearchAction, "tool" | "budgetClass">,
): ResearchAction["budgetClass"] {
  // Budget class is kernel policy, never a model-controlled accounting field.
  if (/(?:search|github|keybase|wayback|archive)/i.test(action.tool)) return "search";
  if (/(?:compute|model|transform|score)/i.test(action.tool)) return "compute";
  return "fetch";
}

function containsProhibitedArgument(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.some(containsProhibitedArgument);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(
      ([key, child]) =>
        PROHIBITED_ARGUMENT_KEY_PATTERN.test(key.replace(/[^a-z0-9]/gi, "")) ||
        containsProhibitedArgument(child),
    );
  }
  return false;
}

function collectStringArguments(value: JsonValue, result: string[] = []): string[] {
  if (typeof value === "string") result.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStringArguments(item, result));
  else if (value !== null && typeof value === "object") {
    Object.values(value).forEach((item) => collectStringArguments(item, result));
  }
  return result;
}

const ACTION_EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}\b/gi;

export interface ActionPolicyContext {
  /** Exact normalized emails explicitly supplied by the user at intake. */
  allowedEmails?: ReadonlySet<string>;
  currentYear?: number;
}

function emailTokens(value: string): string[] {
  const variants = [value];
  try {
    const decoded = decodeURIComponent(value);
    if (decoded !== value) variants.push(decoded);
  } catch {
    // Malformed percent encoding is simply not a second valid text variant.
  }
  return [...new Set(variants.flatMap((variant) =>
    [...variant.matchAll(ACTION_EMAIL_PATTERN)].map((match) =>
      match[0].toLocaleLowerCase("en-US"))))];
}

function containsSensitiveUrlQuery(value: string): boolean {
  const urls = value.match(/https?:\/\/[^\s'"<>]+/gi) ?? [];
  return urls.some((candidate) => {
    try {
      const url = new URL(candidate.replace(/[),.;]+$/, ""));
      return urlContainsRestrictedParameters(url.toString());
    } catch {
      return true;
    }
  });
}

export function isActionPolicyCompliant(
  action: ProposedResearchAction,
  availableTools: readonly string[],
  context: ActionPolicyContext = {},
): { allowed: boolean; reason: string } {
  if (!action.tool.trim() || !action.purpose.trim()) {
    return { allowed: false, reason: "tool and purpose are required" };
  }
  if (!isJsonValue(action.arguments) || Array.isArray(action.arguments) || action.arguments === null) {
    return { allowed: false, reason: "action arguments must be a JSON object" };
  }
  if (availableTools.length > 0 && !availableTools.includes(action.tool)) {
    return { allowed: false, reason: `tool ${action.tool} is not allowlisted` };
  }
  if (PROHIBITED_TOOL_PATTERN.test(action.tool)) {
    return { allowed: false, reason: "tool is outside the public-professional safety scope" };
  }
  if (containsProhibitedArgument(action.arguments)) {
    return { allowed: false, reason: "arguments request prohibited private or sensitive data" };
  }
  const outboundStrings = [action.purpose, ...collectStringArguments(action.arguments)];
  const allowedEmails = context.allowedEmails ?? new Set<string>();
  if (outboundStrings.some((value) =>
    emailTokens(value).some((email) => !allowedEmails.has(email)))) {
    return { allowed: false, reason: "action contains an email that was not explicitly supplied by the user" };
  }
  if (outboundStrings.some(containsSensitiveUrlQuery)) {
    return { allowed: false, reason: "action contains a credential-like URL query parameter" };
  }
  if (outboundStrings.some((value) =>
    containsRestrictedPublicContent(value, {
      allowedEmails,
      currentYear: context.currentYear,
    }))) {
    return { allowed: false, reason: "purpose or argument content contains restricted personal data" };
  }
  const unsafeText = outboundStrings
    .filter((value) => value.trim().length >= 2)
    .some((value) => classifySafety({
      schemaVersion: SCHEMA_VERSION,
      query: value.trim().slice(0, 1_000),
    }, { currentYear: context.currentYear }).level === "block");
  if (unsafeText) {
    return { allowed: false, reason: "purpose or argument content violates public-professional safety policy" };
  }
  return { allowed: true, reason: "allowed" };
}

function actionTraceStatus(status: ActionStatus): TraceSpanStatus {
  if (status === "succeeded") return "succeeded";
  if (status === "partial" || status === "not_found" || status === "rate_limited") return "partial";
  if (status === "skipped") return "skipped";
  if (status === "canceled") return "canceled";
  return "failed";
}

function safeError(error: unknown): JsonObject {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message.slice(0, 500),
    };
  }
  return { name: "UnknownError", message: String(error).slice(0, 500) };
}

function zeroSafeTokens(tokens: Partial<TokenUsage> | undefined): Partial<TokenUsage> {
  const result: Partial<TokenUsage> = {};
  for (const key of ["inputTokens", "cachedInputTokens", "outputTokens", "thinkingTokens", "costUsd"] as const) {
    const value = tokens?.[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) result[key] = value;
  }
  return result;
}

interface ModelAccountingSummary {
  llmCalls: number;
  networkRequests: number | null;
  tokenUsage: Partial<TokenUsage>;
  usageUnavailableReason?: string;
}

interface InternalModelAccounting extends ModelAttemptAccounting {
  finalizeOutstanding(reason: string): void;
  summary(): ModelAccountingSummary;
}

function mergeTokenUsage(
  left: Partial<TokenUsage>,
  right: Partial<TokenUsage>,
): Partial<TokenUsage> {
  const merged: Partial<TokenUsage> = { ...left };
  for (const key of ["inputTokens", "cachedInputTokens", "outputTokens", "thinkingTokens", "costUsd"] as const) {
    const value = right[key];
    if (value !== undefined) merged[key] = (merged[key] ?? 0) + value;
  }
  return merged;
}

function createModelAccounting(engine: InvestigationEngine): InternalModelAccounting {
  let attempts = 0;
  let outstanding = 0;
  let networkRequests = 0;
  let tokenUsage: Partial<TokenUsage> = {};
  const reportedCounts = new Map<keyof TokenUsage, number>();
  const unavailable = new Set<string>();
  return {
    reserve() {
      if (!engine.canAttemptLlm()) return false;
      engine.recordLlmCall();
      attempts += 1;
      outstanding += 1;
      return true;
    },
    settle(settlement) {
      if (outstanding <= 0) throw new Error("model attempt settlement has no matching reservation");
      outstanding -= 1;
      const requests = settlement.networkRequests;
      if (!Number.isInteger(requests) || requests < 0) {
        throw new TypeError("model networkRequests must be a non-negative integer");
      }
      engine.recordNetworkRequests(requests);
      networkRequests += requests;
      const tokens = zeroSafeTokens(settlement.tokenUsage);
      if (Object.keys(tokens).length > 0) {
        engine.recordTokens(tokens);
        tokenUsage = mergeTokenUsage(tokenUsage, tokens);
      }
      for (const key of settlement.reportedUsageFields ?? Object.keys(tokens) as Array<keyof TokenUsage>) {
        if (tokens[key] !== undefined) reportedCounts.set(key, (reportedCounts.get(key) ?? 0) + 1);
      }
      if (settlement.usageUnavailableReason?.trim()) {
        unavailable.add(settlement.usageUnavailableReason.trim().slice(0, 240));
      }
    },
    finalizeOutstanding(reason) {
      while (outstanding > 0) {
        outstanding -= 1;
        unavailable.add(reason);
      }
    },
    summary() {
      const completeTokenUsage: Partial<TokenUsage> = {};
      const missingFields: string[] = [];
      for (const key of ["inputTokens", "cachedInputTokens", "outputTokens", "thinkingTokens", "costUsd"] as const) {
        if (attempts > 0 && reportedCounts.get(key) === attempts && tokenUsage[key] !== undefined) {
          completeTokenUsage[key] = tokenUsage[key];
        } else if (attempts > 0) {
          missingFields.push(key);
        }
      }
      if (missingFields.length > 0) unavailable.add(`provider_usage_fields_unavailable:${missingFields.join(",")}`);
      return {
        llmCalls: attempts,
        networkRequests,
        tokenUsage: completeTokenUsage,
        ...(unavailable.size > 0 ? { usageUnavailableReason: [...unavailable].join("; ") } : {}),
      };
    },
  };
}

function chargeLegacyModelTelemetry(
  engine: InvestigationEngine,
  telemetry: DependencyModelTelemetry | undefined,
  tokenUsage: Partial<TokenUsage> | undefined,
  defaultLlmCalls: number,
): ModelAccountingSummary {
  const llmCalls = telemetry?.llmCalls ?? defaultLlmCalls;
  if (!Number.isInteger(llmCalls) || llmCalls < 0) {
    throw new TypeError("dependency llmCalls must be a non-negative integer");
  }
  engine.recordLlmCalls(llmCalls);
  const networkRequests = telemetry?.networkRequests ?? null;
  if (networkRequests !== null) {
    if (!Number.isInteger(networkRequests) || networkRequests < 0) {
      throw new TypeError("dependency networkRequests must be a non-negative integer");
    }
    engine.recordNetworkRequests(networkRequests);
  }
  const knownTokens = zeroSafeTokens(telemetry?.tokenUsage ?? tokenUsage);
  if (Object.keys(knownTokens).length > 0) engine.recordTokens(knownTokens);
  const tokens: Partial<TokenUsage> = {};
  const reported = new Set(telemetry?.reportedUsageFields ?? Object.keys(knownTokens) as Array<keyof TokenUsage>);
  for (const key of ["inputTokens", "cachedInputTokens", "outputTokens", "thinkingTokens", "costUsd"] as const) {
    if (reported.has(key) && knownTokens[key] !== undefined) tokens[key] = knownTokens[key];
  }
  return {
    llmCalls,
    networkRequests,
    tokenUsage: tokens,
    ...(telemetry?.usageUnavailableReason
      ? { usageUnavailableReason: telemetry.usageUnavailableReason }
      : networkRequests === null
        ? { usageUnavailableReason: "dependency_did_not_report_provider_network_requests" }
        : {}),
  };
}

function naturalNextPhase(state: InvestigationState): ResearchPhase | undefined {
  switch (state.phase) {
    case "plan":
      return "discover";
    case "discover":
      return "separate_candidates";
    case "separate_candidates":
      return state.candidates.length > 0 ? "corroborate" : "discover";
    case "corroborate":
      return "calibrate";
    case "calibrate":
      return state.findings.length > 0 ? "report" : "corroborate";
    default:
      return undefined;
  }
}

function normalizeDecision(value: PlannerDecision): PlannerDecision {
  if (!value || !["actions", "advance", "stop"].includes(value.kind)) {
    throw new TypeError("planner returned an invalid decision kind");
  }
  if (typeof value.decisionSummary !== "string" || !value.decisionSummary.trim()) {
    throw new TypeError("planner decision requires a concise public decisionSummary");
  }
  if (value.kind === "actions" && !Array.isArray(value.actions)) {
    throw new TypeError("actions decision requires an actions array");
  }
  return cloneJson(value);
}

async function invokePlanner(
  engine: InvestigationEngine,
  dependencies: ResearchDependencies,
  availableTools: string[],
  signal?: AbortSignal,
): Promise<PlannerDecision> {
  const state = engine.snapshot();
  const modelAccounting = createModelAccounting(engine);
  const spanId = engine.trace.startSpan({
    name: "planner.decision",
    phase: state.phase,
    payload: {
      turn: state.budget.usage.turns,
      candidateCount: state.candidates.length,
      evidenceCount: state.evidence.length,
      findingCount: state.findings.length,
    },
  });
  try {
    const decision = normalizeDecision(
      await dependencies.planner({
        schemaVersion: SCHEMA_VERSION,
        state,
        availableTools,
        legalNextPhases: [
          "intake",
          "classify",
          "plan",
          "discover",
          "separate_candidates",
          "corroborate",
          "calibrate",
          "report",
          "terminal",
        ].filter((phase) => canTransitionPhase(state.phase, phase as ResearchPhase)) as ResearchPhase[],
        ...(signal ? { signal } : {}),
        modelAccounting,
      }),
    );
    modelAccounting.finalizeOutstanding("planner_returned_with_unsettled_model_attempt");
    const accounted = modelAccounting.summary();
    const model = accounted.llmCalls > 0
      ? accounted
      : chargeLegacyModelTelemetry(engine, decision.modelTelemetry, decision.tokenUsage, 1);
    engine.trace.endSpan(spanId, {
      status: "succeeded",
      payload: {
        decisionKind: decision.kind,
        decisionSummary: decision.decisionSummary,
        proposedActionCount: decision.kind === "actions" ? decision.actions.length : 0,
      },
      usage: {
        ...model.tokenUsage,
        llmCalls: model.llmCalls,
        networkRequests: model.networkRequests,
        unavailableReason: model.usageUnavailableReason,
      },
    });
    return decision;
  } catch (error) {
    modelAccounting.finalizeOutstanding("planner_failed_with_unsettled_model_attempt");
    const accounted = modelAccounting.summary();
    const model = accounted.llmCalls > 0
      ? accounted
      : chargeLegacyModelTelemetry(engine, undefined, undefined, 1);
    engine.trace.endSpan(spanId, {
      status: signal?.aborted ? "canceled" : "failed",
      payload: { error: safeError(error) },
      usage: {
        ...model.tokenUsage,
        llmCalls: model.llmCalls,
        networkRequests: model.networkRequests,
        unavailableReason: model.usageUnavailableReason,
      },
    });
    throw error;
  }
}

interface ExecutedAction {
  action: ResearchAction;
  spanId: string;
  modelAccounting: InternalModelAccounting;
  result: ResearchActionResult;
}

async function executeActions(
  engine: InvestigationEngine,
  dependencies: ResearchDependencies,
  proposals: ProposedResearchAction[],
  availableTools: string[],
  signal?: AbortSignal,
): Promise<number> {
  const state = engine.snapshot();
  const remainingCalls = Math.max(0, state.budget.limits.maxToolCalls - state.budget.usage.toolCalls);
  const batchLimit = Math.min(
    state.budget.limits.maxActionsPerTurn,
    remainingCalls,
    MAX_OUTBOUND_CONCURRENCY,
  );
  const initialBatch = proposals.slice(0, batchLimit);
  let remainingSearchCalls = Math.max(
    0,
    state.budget.limits.maxSearchCalls - state.budget.usage.searchCalls,
  );
  const bounded = initialBatch.filter((proposal) => {
    if (actionBudgetClass(proposal) !== "search") return true;
    if (remainingSearchCalls <= 0) return false;
    remainingSearchCalls -= 1;
    return true;
  });
  if (proposals.length > bounded.length) {
    engine.trace.record("planner.action_batch_bounded", {
      phase: state.phase,
      payload: {
        proposed: proposals.length,
        acceptedMaximum: bounded.length,
      },
    });
  }

  const executable: Array<{
    action: ResearchAction;
    spanId: string;
    modelAccounting: InternalModelAccounting;
  }> = [];
  const actionPolicyContext: ActionPolicyContext = {
    allowedEmails: new Set(state.target.identifiers
      .filter((identifier) => identifier.kind === "email" && identifier.provenance === "user_input")
      .map((identifier) => identifier.normalizedValue)),
    currentYear: new Date(engine.clock.now()).getUTCFullYear(),
  };
  for (const proposal of bounded) {
    const policy = isActionPolicyCompliant(proposal, availableTools, actionPolicyContext);
    if (!policy.allowed) {
      engine.trace.record("action.rejected", {
        phase: state.phase,
        payload: {
          tool: proposal.tool,
          reason: policy.reason,
        },
      });
      continue;
    }
    const action: ResearchAction = {
      schemaVersion: SCHEMA_VERSION,
      id: engine.ids.next("action"),
      tool: proposal.tool.trim(),
      purpose: proposal.purpose.trim(),
      arguments: cloneJson(proposal.arguments),
      ...(proposal.candidateId ? { candidateId: proposal.candidateId } : {}),
      budgetClass: actionBudgetClass(proposal),
    };
    const spanId = engine.trace.startSpan({
      name: `tool.${action.tool}`,
      phase: state.phase,
      payload: {
        actionId: action.id,
        purpose: action.purpose,
        arguments: action.arguments,
        candidateId: action.candidateId ?? null,
      },
    });
    executable.push({ action, spanId, modelAccounting: createModelAccounting(engine) });
  }

  // Adapters run concurrently, but results are admitted in proposal order so
  // IDs, evidence ordering, and traces remain deterministic under replay.
  const settled = await Promise.all(
    executable.map(async ({ action, spanId, modelAccounting }): Promise<ExecutedAction> => {
      try {
        const result = await dependencies.executeAction(action, {
          schemaVersion: SCHEMA_VERSION,
          state,
          ...(signal ? { signal } : {}),
          modelAccounting,
        });
        return { action, spanId, modelAccounting, result };
      } catch (error) {
        return {
          action,
          spanId,
          modelAccounting,
          result: {
            status: signal?.aborted ? "canceled" : "failed",
            diagnostics: [
              {
                code: "adapter_exception",
                severity: "error",
                message: safeError(error).message as string,
                retryable: false,
              },
            ],
            meta: { requests: 0, incomplete: true },
          },
        };
      }
    }),
  );

  let mutations = 0;
  for (const { action, spanId, modelAccounting, result } of settled) {
    const localCandidateIds = new Map<string, string>();
    for (const draft of result.candidates ?? []) {
      try {
        const mutation = engine.addCandidate(draft);
        if (draft.ref) localCandidateIds.set(draft.ref, mutation.candidate.id);
        if (mutation.created) mutations += 1;
      } catch (error) {
        engine.trace.record("candidate.rejected", {
          phase: engine.phase,
          parentSpanId: spanId,
          payload: { error: safeError(error) },
        });
      }
    }
    for (const update of result.candidateSignals ?? []) {
      try {
        engine.addCandidateSignals(update.candidateId, update.signals);
        mutations += 1;
      } catch (error) {
        engine.trace.record("candidate_signal.rejected", {
          phase: engine.phase,
          parentSpanId: spanId,
          payload: { candidateId: update.candidateId, error: safeError(error) },
        });
      }
    }
    for (const draft of result.evidence ?? []) {
      const candidateId =
        draft.candidateId ??
        (draft.candidateRef ? localCandidateIds.get(draft.candidateRef) : undefined) ??
        action.candidateId;
      const admission = engine.admitEvidence({
        ...draft,
        ...(candidateId ? { candidateId } : {}),
        toolCallId: draft.toolCallId ?? action.id,
      });
      if (admission.admitted) mutations += 1;
    }
    for (const finding of result.findings ?? []) {
      try {
        engine.addFinding(finding);
        mutations += 1;
      } catch (error) {
        engine.trace.record("finding.rejected", {
          phase: engine.phase,
          parentSpanId: spanId,
          payload: { error: safeError(error) },
        });
      }
    }

    modelAccounting.finalizeOutstanding("action_returned_with_unsettled_model_attempt");
    const accountedModel = modelAccounting.summary();
    const usesAttemptAccounting = accountedModel.llmCalls > 0;
    const tokens = usesAttemptAccounting
      ? accountedModel.tokenUsage
      : zeroSafeTokens(result.tokenUsage);
    if (!usesAttemptAccounting && Object.keys(tokens).length > 0) engine.recordTokens(tokens);
    const reportedLlmCalls = usesAttemptAccounting
      ? accountedModel.llmCalls
      : result.meta?.llmCalls;
    if (!usesAttemptAccounting && reportedLlmCalls !== undefined) {
      engine.recordLlmCalls(reportedLlmCalls);
    }
    const reportedRequests = result.meta?.requests;
    const chargedRequests =
      reportedRequests ?? (action.budgetClass === "compute" ? 0 : 1);
    engine.recordToolCall(chargedRequests, action.budgetClass === "search");
    engine.trace.endSpan(spanId, {
      status: actionTraceStatus(result.status),
      payload: {
        actionId: action.id,
        resultStatus: result.status,
        incomplete: result.meta?.incomplete ?? false,
        evidenceProposed: result.evidence?.length ?? 0,
        candidateProposed: result.candidates?.length ?? 0,
        diagnostics: (result.diagnostics ?? []).map((diagnostic) => ({
          code: diagnostic.code,
          severity: diagnostic.severity,
          message: diagnostic.message,
          retryable: diagnostic.retryable,
        })),
      },
      usage: {
        ...tokens,
        llmCalls: reportedLlmCalls ?? null,
        toolCalls: 1,
        searchCalls: action.budgetClass === "search" ? 1 : 0,
        networkRequests: reportedRequests === undefined
          ? usesAttemptAccounting ? accountedModel.networkRequests : null
          : reportedRequests + (usesAttemptAccounting ? accountedModel.networkRequests ?? 0 : 0),
        bytesRead: result.meta?.bytesRead ?? null,
        unavailableReason: usesAttemptAccounting
          ? accountedModel.usageUnavailableReason
          : undefined,
      },
    });
  }
  return mutations;
}

async function synthesizeFindings(
  engine: InvestigationEngine,
  dependencies: ResearchDependencies,
  signal?: AbortSignal,
): Promise<number> {
  if (!dependencies.synthesize) return 0;
  if (!engine.canAttemptLlm()) {
    engine.trace.record("synthesis.skipped", {
      phase: engine.phase,
      payload: { reason: "llm_call_budget_exhausted" },
    });
    return 0;
  }
  const modelAccounting = createModelAccounting(engine);
  const spanId = engine.trace.startSpan({
    name: "synthesis.findings",
    phase: engine.phase,
    payload: {
      candidateCount: engine.snapshot().candidates.length,
      evidenceCount: engine.snapshot().evidence.length,
    },
  });
  try {
    const result = await dependencies.synthesize(engine.snapshot(), {
      schemaVersion: SCHEMA_VERSION,
      ...(signal ? { signal } : {}),
      modelAccounting,
    });
    let mutations = 0;
    for (const finding of result.findings) {
      try {
        const before = engine.snapshot().findings.length;
        engine.addFinding(finding);
        if (engine.snapshot().findings.length > before) mutations += 1;
      } catch (error) {
        engine.trace.record("finding.rejected", {
          phase: engine.phase,
          parentSpanId: spanId,
          payload: { error: safeError(error) },
        });
      }
    }
    if (result.openQuestions) engine.setOpenQuestions(result.openQuestions);
    modelAccounting.finalizeOutstanding("synthesis_returned_with_unsettled_model_attempt");
    const accounted = modelAccounting.summary();
    const model = accounted.llmCalls > 0
      ? accounted
      : chargeLegacyModelTelemetry(engine, result.modelTelemetry, result.tokenUsage, 1);
    engine.trace.endSpan(spanId, {
      status: "succeeded",
      payload: {
        decisionSummary: result.decisionSummary,
        proposedFindings: result.findings.length,
        admittedFindings: mutations,
      },
      usage: {
        ...model.tokenUsage,
        llmCalls: model.llmCalls,
        networkRequests: model.networkRequests,
        unavailableReason: model.usageUnavailableReason,
      },
    });
    return mutations;
  } catch (error) {
    modelAccounting.finalizeOutstanding("synthesis_failed_with_unsettled_model_attempt");
    const accounted = modelAccounting.summary();
    const model = accounted.llmCalls > 0
      ? accounted
      : chargeLegacyModelTelemetry(engine, undefined, undefined, 1);
    engine.trace.endSpan(spanId, {
      status: signal?.aborted ? "canceled" : "failed",
      payload: { error: safeError(error) },
      usage: {
        ...model.tokenUsage,
        llmCalls: model.llmCalls,
        networkRequests: model.networkRequests,
        unavailableReason: model.usageUnavailableReason,
      },
    });
    if (signal?.aborted) throw error;
    return 0;
  }
}

function terminalizeFromStopDecision(
  engine: InvestigationEngine,
  decision: ReturnType<typeof evaluateStop>,
  options: StopEvaluationOptions = {},
): void {
  if (!decision.allowed || !decision.reason) {
    throw new Error("cannot terminalize from a denied stop decision");
  }
  engine.stopDecision(decision, options);
}

function pendingUpdates(
  engine: InvestigationEngine,
  traceCursor: number,
): { updates: ResearchUpdate[]; traceCursor: number } {
  const events = engine.trace.eventsSince(traceCursor);
  const updates: ResearchUpdate[] = events.map((event) => ({
    schemaVersion: SCHEMA_VERSION,
    type: "trace",
    event,
  }));
  updates.push({
    schemaVersion: SCHEMA_VERSION,
    type: "state",
    state: engine.snapshot(),
  });
  return { updates, traceCursor: traceCursor + events.length };
}

/**
 * Composable autonomous runner. External LLM/tool callbacks make proposals;
 * every accepted state change, phase transition, budget charge, and stop is
 * enforced and emitted by the deterministic engine.
 */
export async function* runResearch(
  input: InvestigationInput | string,
  dependencies: ResearchDependencies,
  options: ResearchRunnerOptions = {},
): AsyncGenerator<ResearchUpdate, InvestigationReport, void> {
  const engine = new InvestigationEngine(input, dependencies, options);
  const availableTools = [...new Set(options.availableTools ?? [])].sort();
  const completionStopOptions: StopEvaluationOptions = {
    minimumFindings: options.minimumFindings,
    minimumIndependentSourceFamilies: options.minimumIndependentSourceFamilies,
  };
  let traceCursor = 0;

  const emitPending = (): ResearchUpdate[] => {
    const pending = pendingUpdates(engine, traceCursor);
    traceCursor = pending.traceCursor;
    return pending.updates;
  };

  for (const update of emitPending()) yield update;

  try {
    engine.transition("classify");
    if (engine.snapshot().safety.level === "block") {
      terminalizeFromStopDecision(engine, evaluateStop(engine.snapshot()));
    } else {
      engine.transition("plan");
    }
    for (const update of emitPending()) yield update;

    while (engine.status === "running") {
      if (options.signal?.aborted) {
        terminalizeFromStopDecision(
          engine,
          evaluateStop(engine.snapshot(), { canceled: true }),
          { canceled: true },
        );
        break;
      }
      if (!engine.canStartTurn()) {
        const stop = evaluateStop(engine.snapshot());
        if (stop.allowed) {
          terminalizeFromStopDecision(engine, stop);
          break;
        }
        const next = naturalNextPhase(engine.snapshot());
        if (next && canTransitionPhase(engine.phase, next)) {
          engine.trace.record("phase.cap_reached", {
            phase: engine.phase,
            payload: { nextPhase: next },
          });
          engine.transition(next);
          for (const update of emitPending()) yield update;
          continue;
        }
        terminalizeFromStopDecision(
          engine,
          evaluateStop(engine.snapshot(), { noLegalActions: true }),
          { noLegalActions: true },
        );
        break;
      }

      engine.beginTurn();
      const before = engine.snapshot();
      const decision = await invokePlanner(engine, dependencies, availableTools, options.signal);
      let mutations = 0;

      if (options.signal?.aborted) {
        engine.endTurn(false);
        terminalizeFromStopDecision(
          engine,
          evaluateStop(engine.snapshot(), { canceled: true }),
          { canceled: true },
        );
        break;
      }

      if (decision.kind === "stop") {
        engine.endTurn(false);
        const stop = evaluateStop(engine.snapshot(), {
          plannerRequested: true,
          ...completionStopOptions,
        });
        if (stop.allowed) {
          terminalizeFromStopDecision(engine, stop, {
            plannerRequested: true,
            ...completionStopOptions,
          });
        } else {
          engine.trace.record("planner.stop_rejected", {
            phase: engine.phase,
            payload: { detail: stop.detail },
          });
          const next = naturalNextPhase(engine.snapshot());
          if (next && canTransitionPhase(engine.phase, next)) engine.transition(next);
        }
      } else {
        if (decision.kind === "actions") {
          if (engine.phase === "plan") engine.transition("discover");
          if (decision.actions.length > 0) {
            mutations += await executeActions(
              engine,
              dependencies,
              decision.actions,
              availableTools,
              options.signal,
            );
            if (options.signal?.aborted) {
              engine.endTurn(mutations > 0);
              terminalizeFromStopDecision(
                engine,
                evaluateStop(engine.snapshot(), { canceled: true }),
                { canceled: true },
              );
              break;
            }
          }
        }

        if (engine.phase === "calibrate") {
          mutations += await synthesizeFindings(engine, dependencies, options.signal);
          if (options.signal?.aborted) {
            engine.endTurn(mutations > 0);
            terminalizeFromStopDecision(
              engine,
              evaluateStop(engine.snapshot(), { canceled: true }),
              { canceled: true },
            );
            break;
          }
        }

        const madeProgress =
          mutations > 0 ||
          engine.snapshot().candidates.length > before.candidates.length ||
          engine.snapshot().evidence.length > before.evidence.length ||
          engine.snapshot().findings.length > before.findings.length;
        engine.endTurn(madeProgress);

        const budgetStop = evaluateStop(engine.snapshot(), completionStopOptions);
        if (budgetStop.allowed && budgetStop.reason !== "goal_satisfied") {
          terminalizeFromStopDecision(engine, budgetStop, completionStopOptions);
        } else {
          const requestedNext = decision.kind === "advance" ? decision.nextPhase : undefined;
          const next =
            requestedNext &&
            requestedNext !== "terminal" &&
            canTransitionPhase(engine.phase, requestedNext)
              ? requestedNext
              : naturalNextPhase(engine.snapshot());

          if (engine.phase === "report") {
            terminalizeFromStopDecision(
              engine,
              evaluateStop(engine.snapshot(), { noLegalActions: true }),
              { noLegalActions: true },
            );
          } else if (budgetStop.allowed && budgetStop.reason === "goal_satisfied") {
            if (engine.phase === "calibrate") engine.transition("report");
            engine.stopDecision(budgetStop, completionStopOptions);
          } else if (next && canTransitionPhase(engine.phase, next)) {
            engine.transition(next);
          } else {
            terminalizeFromStopDecision(
              engine,
              evaluateStop(engine.snapshot(), { noLegalActions: true }),
              { noLegalActions: true },
            );
          }
        }
      }

      for (const update of emitPending()) yield update;
    }
    for (const update of emitPending()) yield update;
  } catch (error) {
    if (engine.status === "running") {
      if (options.signal?.aborted) {
        terminalizeFromStopDecision(
          engine,
          evaluateStop(engine.snapshot(), { canceled: true }),
          { canceled: true },
        );
      } else {
        engine.stopExternal(
          "fatal_error",
          `Investigation failed: ${(safeError(error).message as string)}`,
        );
      }
    }
    for (const update of emitPending()) yield update;
  }

  engine.trace.assertBalanced();
  const report = engine.report();
  const state = engine.snapshot();
  const completed: ResearchUpdate = {
    schemaVersion: SCHEMA_VERSION,
    type: "completed",
    state,
    report,
    trace: engine.trace.toJSON(),
  };
  yield completed;
  return report;
}

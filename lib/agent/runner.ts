import { canTransitionPhase } from "../domain/state-machine";
import { evaluateStop, type StopEvaluationOptions } from "../domain/stopping";
import { classifySafety } from "../domain/safety";
import {
  containsRestrictedPublicContent,
  isCompactPhoneNumberValue,
  isRestrictedJsonFieldKey,
  urlContainsRestrictedParameters,
} from "../domain/content-policy";
import type { Clock, IdFactory } from "../domain/runtime";
import { cloneJson, isJsonValue } from "../domain/runtime";
import { identitySignalGroundedByEvidence } from "../domain/candidates";
import {
  SCHEMA_VERSION,
  type BudgetLimits,
  type CandidateDraft,
  type EvidenceDraft,
  type EvidenceRecord,
  type FindingDraft,
  type IdentitySignal,
  type InvestigationInput,
  type InvestigationReport,
  type InvestigationState,
  type JsonObject,
  type JsonValue,
  type ResearchPhase,
  type SearchFrontierEntry,
  type SearchGraph,
  type SearchGraphStatus,
  type SourceTier,
  type TokenUsage,
} from "../domain/types";
import { InvestigationEngine, type InvestigationEngineOptions } from "./engine";
import type { TraceEnvelopeV1, TraceEvent, TraceSpanStatus } from "./trace";
import {
  admitGraphEdge,
  admitGraphNode,
  assertSearchGraph,
  enqueueCandidateFrontier,
  frontierEntryById,
  isDeniedResearchSource,
  isDeniedResearchTool,
  markSearchGraphTerminal,
  proposeBoundedMutation,
  recordFrontierOutcome,
  requeueFrontier,
  seedFrontier,
  selectFrontierBatch,
  setFrontierStatus,
  sourceLaneForFrontierEntry,
  sourceTierForUrl,
  type SearchKernelEvent,
} from "../search";
import { compileFrontierHarness, initialFrontierHarnessState, type FrontierHarnessRoute } from "../harness";

export type ActionStatus = "succeeded" | "partial" | "not_found" | "rate_limited" | "failed" | "skipped" | "canceled";

export const MAX_OUTBOUND_CONCURRENCY = 4;

export interface ResearchActionV1 {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  frontierEntryId: string;
  tool: string;
  purpose: string;
  arguments: JsonObject;
  candidateId?: string;
  budgetClass: "search" | "fetch" | "compute";
  sourceTier: SourceTier;
  sourceLaneId: string;
  pathCost: number;
  mutated: boolean;
}

export type ResearchAction = ResearchActionV1;

export interface ProposedResearchAction {
  frontierEntryId?: string;
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
  selectedFrontierEntries: SearchFrontierEntry[];
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

const PROHIBITED_ARGUMENT_KEY_PATTERN =
  /(?:homeaddress|residentialaddress|personalphone|phonenumber|phone|telephone|tel|mobile|cell|contactnumber|directnumber|whatsapp|password|credential|ssn|socialsecurity|realtimelocation|clientsecret|authtoken|sessionid|authorizationcode|oauthcode)/i;

function actionBudgetClass(
  action: Pick<ProposedResearchAction, "tool" | "budgetClass">,
): ResearchAction["budgetClass"] {
  // Budget class is kernel policy, never a model-controlled accounting field.
  if (/(?:search|github|keybase|wayback|archive)/i.test(action.tool)) return "search";
  if (/(?:compute|model|transform|score)/i.test(action.tool)) return "compute";
  return "fetch";
}

function containsProhibitedArgument(value: JsonValue): boolean {
  if (isCompactPhoneNumberValue(value)) return true;
  if (Array.isArray(value)) return value.some(containsProhibitedArgument);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).some(
      ([key, child]) =>
        isRestrictedJsonFieldKey(key) ||
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
  return [
    ...new Set(
      variants.flatMap((variant) =>
        [...variant.matchAll(ACTION_EMAIL_PATTERN)].map((match) => match[0].toLocaleLowerCase("en-US")),
      ),
    ),
  ];
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
  if (isDeniedResearchTool(action.tool)) {
    return { allowed: false, reason: "tool is outside the public-professional safety scope" };
  }
  if (containsProhibitedArgument(action.arguments)) {
    return { allowed: false, reason: "arguments request prohibited private or sensitive data" };
  }
  const outboundStrings = [action.purpose, ...collectStringArguments(action.arguments)];
  if (outboundStrings.some(isDeniedResearchSource)) {
    return {
      allowed: false,
      reason: "action targets a denied people-search, contact, property, tax, family, or credential source",
    };
  }
  const allowedEmails = context.allowedEmails ?? new Set<string>();
  if (outboundStrings.some((value) => emailTokens(value).some((email) => !allowedEmails.has(email)))) {
    return { allowed: false, reason: "action contains an email that was not explicitly supplied by the user" };
  }
  if (outboundStrings.some(containsSensitiveUrlQuery)) {
    return { allowed: false, reason: "action contains a credential-like URL query parameter" };
  }
  if (
    outboundStrings.some((value) =>
      containsRestrictedPublicContent(value, {
        allowedEmails,
        currentYear: context.currentYear,
      }),
    )
  ) {
    return { allowed: false, reason: "purpose or argument content contains restricted personal data" };
  }
  const unsafeText = outboundStrings
    .filter((value) => value.trim().length >= 2)
    .some(
      (value) =>
        classifySafety(
          {
            schemaVersion: SCHEMA_VERSION,
            query: value.trim().slice(0, 1_000),
          },
          { currentYear: context.currentYear },
        ).level === "block",
    );
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

function bindToolProposedSignal(
  signal: IdentitySignal,
  candidateId: string,
  actionId: string,
  evidence: readonly EvidenceRecord[],
): { signal?: IdentitySignal; reason?: string } {
  if (signal.kind === "cross_source_match") {
    return { reason: "cross_source_match_is_kernel_derived" };
  }
  if (signal.sourceEvidenceId) {
    const record = evidence.find((item) => item.id === signal.sourceEvidenceId);
    if (
      !record ||
      record.candidateId !== candidateId ||
      record.toolCallId !== actionId ||
      !identitySignalGroundedByEvidence(signal, record)
    )
      return { reason: "signal_evidence_provenance_mismatch" };
    return { signal };
  }
  const matching = evidence
    .filter((record) => record.candidateId === candidateId && record.toolCallId === actionId)
    .map((record) => ({
      record,
      bound: {
        ...signal,
        sourceEvidenceId: record.id,
        sourceFamily: record.sourceFamily,
      } satisfies IdentitySignal,
    }))
    .filter(
      ({ record, bound }) =>
        (!signal.sourceFamily || signal.sourceFamily.toLocaleLowerCase("en-US") === record.sourceFamily) &&
        identitySignalGroundedByEvidence(bound, record),
    );
  if (matching.length === 1) return { signal: matching[0].bound };
  if (signal.kind === "conflict" || signal.assurance === "verified" || signal.assurance === "corroborated") {
    return { reason: matching.length > 1 ? "ambiguous_signal_evidence" : "ungrounded_high_assurance_signal" };
  }
  const { sourceEvidenceId: _sourceEvidenceId, sourceFamily: _sourceFamily, ...provisional } = signal;
  return { signal: provisional };
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

function mergeTokenUsage(left: Partial<TokenUsage>, right: Partial<TokenUsage>): Partial<TokenUsage> {
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
      for (const key of settlement.reportedUsageFields ?? (Object.keys(tokens) as Array<keyof TokenUsage>)) {
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
  const reported = new Set(telemetry?.reportedUsageFields ?? (Object.keys(knownTokens) as Array<keyof TokenUsage>));
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
  selectedFrontierEntries: SearchFrontierEntry[],
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
      selectedFrontierEntryIds: selectedFrontierEntries.map((entry) => entry.id),
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
        selectedFrontierEntries: cloneJson(selectedFrontierEntries),
        ...(signal ? { signal } : {}),
        modelAccounting,
      }),
    );
    modelAccounting.finalizeOutstanding("planner_returned_with_unsettled_model_attempt");
    const accounted = modelAccounting.summary();
    const model =
      accounted.llmCalls > 0
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
    const model = accounted.llmCalls > 0 ? accounted : chargeLegacyModelTelemetry(engine, undefined, undefined, 1);
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
  entry: SearchFrontierEntry;
  action: ResearchAction;
  actionNodeId: string;
  spanId: string;
  modelAccounting: InternalModelAccounting;
  result: ResearchActionResult;
}

interface ActionBatchExecution {
  mutations: number;
  graph: SearchGraph;
  executedEntries: SearchFrontierEntry[];
}

function recordSearchEvents(
  engine: InvestigationEngine,
  events: readonly SearchKernelEvent[],
  parentSpanId?: string,
): void {
  for (const event of events) {
    engine.trace.record(event.name, {
      phase: engine.phase,
      ...(parentSpanId ? { parentSpanId } : {}),
      payload: event.payload,
    });
  }
}

function publicHostname(value: string): string | null {
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return url.protocol === "https:" ? url.hostname.toLocaleLowerCase("en-US").replace(/^www\./, "") : null;
  } catch {
    return null;
  }
}

function sourceTierContextForAction(
  state: InvestigationState,
  candidateId: string | undefined,
): { firstPartyHosts: string[]; organizationNames: string[] } {
  const firstPartyHosts = new Set<string>();
  for (const identifier of state.target.identifiers) {
    if (identifier.provenance !== "user_input") continue;
    const host =
      identifier.kind === "email"
        ? (identifier.normalizedValue.split("@")[1] ?? null)
        : publicHostname(identifier.value);
    if (host) firstPartyHosts.add(host);
  }
  const candidate = candidateId ? state.candidates.find((item) => item.id === candidateId) : undefined;
  for (const signal of candidate?.signals ?? []) {
    if (
      !["profile_url", "personal_domain"].includes(signal.kind) ||
      !["verified", "corroborated"].includes(signal.assurance) ||
      !signal.sourceEvidenceId ||
      !state.evidence.some(
        (evidence) =>
          evidence.id === signal.sourceEvidenceId &&
          evidence.candidateId === candidateId &&
          evidence.disposition === "supports",
      )
    )
      continue;
    const host = publicHostname(signal.value);
    if (host) firstPartyHosts.add(host);
  }
  return {
    firstPartyHosts: [...firstPartyHosts].sort(),
    organizationNames: state.target.organizationHints.map((organization) => organization.name),
  };
}

async function executeActions(
  engine: InvestigationEngine,
  dependencies: ResearchDependencies,
  proposals: ProposedResearchAction[],
  graphValue: SearchGraph,
  selectedEntries: SearchFrontierEntry[],
  availableTools: string[],
  signal?: AbortSignal,
): Promise<ActionBatchExecution> {
  let graph = cloneJson(graphValue);
  const state = engine.snapshot();
  const remainingCalls = Math.max(0, state.budget.limits.maxToolCalls - state.budget.usage.toolCalls);
  const batchLimit = Math.min(state.budget.limits.maxActionsPerTurn, remainingCalls, MAX_OUTBOUND_CONCURRENCY);
  const claimedEntries = new Set<string>();
  const bound: Array<{ proposal: ProposedResearchAction; entry: SearchFrontierEntry }> = [];
  for (const proposal of proposals) {
    if (bound.length >= batchLimit) break;
    const explicit = proposal.frontierEntryId
      ? selectedEntries.find((entry) => entry.id === proposal.frontierEntryId)
      : undefined;
    const entry =
      explicit ??
      selectedEntries.find(
        (candidate) =>
          !claimedEntries.has(candidate.id) &&
          candidate.allowedTools.includes(proposal.tool) &&
          (candidate.candidateId === null || proposal.candidateId === candidate.candidateId),
      );
    if (
      !entry ||
      claimedEntries.has(entry.id) ||
      !entry.allowedTools.includes(proposal.tool) ||
      proposal.candidateId !== (entry.candidateId ?? undefined)
    ) {
      engine.trace.record("action.rejected", {
        phase: state.phase,
        payload: {
          frontierEntryId: proposal.frontierEntryId ?? null,
          tool: proposal.tool,
          reason: "action is not bound to one selected compatible frontier entry",
        },
      });
      continue;
    }
    claimedEntries.add(entry.id);
    bound.push({ proposal: { ...proposal, frontierEntryId: entry.id }, entry });
  }
  const initialBatch = bound;
  let remainingSearchCalls = Math.max(0, state.budget.limits.maxSearchCalls - state.budget.usage.searchCalls);
  const bounded = initialBatch.filter(({ proposal }) => {
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
    entry: SearchFrontierEntry;
    action: ResearchAction;
    actionNodeId: string;
    spanId: string;
    modelAccounting: InternalModelAccounting;
  }> = [];
  const actionPolicyContext: ActionPolicyContext = {
    allowedEmails: new Set(
      state.target.identifiers
        .filter((identifier) => identifier.kind === "email" && identifier.provenance === "user_input")
        .map((identifier) => identifier.normalizedValue),
    ),
    currentYear: new Date(engine.clock.now()).getUTCFullYear(),
  };
  for (const { proposal, entry } of bounded) {
    const policy = isActionPolicyCompliant(proposal, availableTools, actionPolicyContext);
    if (!policy.allowed) {
      engine.trace.record("action.rejected", {
        phase: state.phase,
        payload: {
          tool: proposal.tool,
          frontierEntryId: entry.id,
          reason: policy.reason,
        },
      });
      continue;
    }
    const action: ResearchAction = {
      schemaVersion: SCHEMA_VERSION,
      id: entry.actionId,
      frontierEntryId: entry.id,
      tool: proposal.tool.trim(),
      purpose: proposal.purpose.trim(),
      arguments: cloneJson(proposal.arguments),
      ...(entry.candidateId ? { candidateId: entry.candidateId } : {}),
      budgetClass: actionBudgetClass(proposal),
      sourceTier: entry.sourceTier,
      sourceLaneId: entry.sourceLaneId,
      pathCost: entry.pathCost,
      mutated: entry.mutation !== null,
    };
    const actionNodeAdmission = admitGraphNode(
      graph,
      {
        kind: "action",
        label: `${action.tool} — ${action.purpose}`,
        status: "running",
        sourceTier: entry.sourceTier,
        sourceLaneId: entry.sourceLaneId,
        frontierEntryId: entry.id,
        actionId: action.id,
        candidateId: action.candidateId ?? null,
        data: {
          tool: action.tool,
          budgetClass: action.budgetClass,
          pathCost: action.pathCost,
          mutated: action.mutated,
        },
        dedupeEntityKey: `action:${action.id}`,
      },
      engine.ids,
      engine.clock.now(),
    );
    graph = actionNodeAdmission.graph;
    recordSearchEvents(engine, actionNodeAdmission.events);
    const actionEdgeAdmission = admitGraphEdge(
      graph,
      {
        fromNodeId: entry.nodeId,
        toNodeId: actionNodeAdmission.value.id,
        kind: entry.mutation ? "mutates" : "expands",
        status: "running",
        frontierEntryId: entry.id,
        actionId: action.id,
        edgeCost: 0.05,
        pathCost: entry.pathCost + 0.05,
      },
      engine.ids,
      engine.clock.now(),
    );
    graph = actionEdgeAdmission.graph;
    recordSearchEvents(engine, actionEdgeAdmission.events);
    const spanId = engine.trace.startSpan({
      name: `tool.${action.tool}`,
      phase: state.phase,
      payload: {
        actionId: action.id,
        frontierEntryId: action.frontierEntryId,
        sourceTier: action.sourceTier,
        sourceLaneId: action.sourceLaneId,
        pathCost: action.pathCost,
        mutated: action.mutated,
        purpose: action.purpose,
        arguments: action.arguments,
        candidateId: action.candidateId ?? null,
      },
    });
    executable.push({
      entry,
      action,
      actionNodeId: actionNodeAdmission.value.id,
      spanId,
      modelAccounting: createModelAccounting(engine),
    });
  }

  const unusedSelected = selectedEntries
    .filter((entry) => !executable.some((item) => item.entry.id === entry.id))
    .map((entry) => entry.id);
  graph = requeueFrontier(graph, unusedSelected, engine.clock.now());
  graph = setFrontierStatus(
    graph,
    executable.map((item) => item.entry.id),
    "running",
    engine.clock.now(),
  );
  assertSearchGraph(graph);
  engine.replaceSearchGraph(graph);
  const actionState = engine.snapshot();

  // Adapters run concurrently, but results are admitted in proposal order so
  // IDs, evidence ordering, and traces remain deterministic under replay.
  const settled = await Promise.all(
    executable.map(async ({ entry, action, actionNodeId, spanId, modelAccounting }): Promise<ExecutedAction> => {
      try {
        const result = await dependencies.executeAction(action, {
          schemaVersion: SCHEMA_VERSION,
          state: actionState,
          ...(signal ? { signal } : {}),
          modelAccounting,
        });
        return { entry, action, actionNodeId, spanId, modelAccounting, result };
      } catch (error) {
        return {
          entry,
          action,
          actionNodeId,
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
  const executedEntries: SearchFrontierEntry[] = [];
  for (const { entry, action, actionNodeId, spanId, modelAccounting, result } of settled) {
    executedEntries.push(entry);
    let actionMutations = 0;
    const localCandidateIds = new Map<string, string>();
    const pendingSignalUpdates: CandidateSignalUpdate[] = [];
    for (const draft of result.candidates ?? []) {
      if (action.candidateId) {
        engine.trace.record("candidate.rejected", {
          phase: engine.phase,
          parentSpanId: spanId,
          payload: {
            reason: "candidate_bound_action_cannot_create_candidates",
            expectedCandidateId: action.candidateId,
          },
        });
        continue;
      }
      try {
        const { signals: proposedSignals, ...identityDraft } = draft;
        const candidateMutation = engine.addCandidate(identityDraft);
        if (draft.ref) localCandidateIds.set(draft.ref, candidateMutation.candidate.id);
        if (proposedSignals?.length) {
          pendingSignalUpdates.push({
            candidateId: candidateMutation.candidate.id,
            signals: proposedSignals,
          });
        }
        if (candidateMutation.created) {
          mutations += 1;
          actionMutations += 1;
        }
        // Candidate nodes are unbound entities (no single action owns an
        // identity), matching the canonical graph the generator produces; this
        // keeps cross-candidate `separates` edges free of a conflicting single
        // action provenance.
        const candidateNodeAdmission = admitGraphNode(
          graph,
          {
            kind: "candidate",
            label: candidateMutation.candidate.displayName,
            status: candidateMutation.created ? "verified" : "selected",
            candidateId: candidateMutation.candidate.id,
            data: {},
            dedupeEntityKey: `candidate:${candidateMutation.candidate.id}`,
          },
          engine.ids,
          engine.clock.now(),
        );
        graph = candidateNodeAdmission.graph;
        recordSearchEvents(engine, candidateNodeAdmission.events, spanId);
        const candidateEdgeAdmission = admitGraphEdge(
          graph,
          {
            fromNodeId: actionNodeId,
            toNodeId: candidateNodeAdmission.value.id,
            kind: "expands",
            status: "verified",
            frontierEntryId: entry.id,
            actionId: action.id,
            edgeCost: 0.06,
            pathCost: entry.pathCost + 0.11,
          },
          engine.ids,
          engine.clock.now(),
        );
        graph = candidateEdgeAdmission.graph;
        recordSearchEvents(engine, candidateEdgeAdmission.events, spanId);

        const snapshotCandidates = engine.snapshot().candidates;
        for (const other of snapshotCandidates.filter(
          (item) =>
            item.id !== candidateMutation.candidate.id &&
            item.normalizedName === candidateMutation.candidate.normalizedName,
        )) {
          const otherNode = graph.nodes.find((node) => node.candidateId === other.id);
          if (!otherNode) continue;
          const separation = admitGraphEdge(
            graph,
            {
              fromNodeId: otherNode.id,
              toNodeId: candidateNodeAdmission.value.id,
              kind: "separates",
              status: "verified",
              edgeCost: 0.07,
              pathCost: entry.pathCost + 0.12,
            },
            engine.ids,
            engine.clock.now(),
          );
          graph = separation.graph;
          recordSearchEvents(engine, separation.events, spanId);
        }

        if (candidateMutation.created) {
          const candidateFrontier = enqueueCandidateFrontier(
            graph,
            state.target,
            candidateMutation.candidate,
            entry,
            // Candidate-bound lanes descend from the discovering action entry's
            // node (matching the canonical graph), not the unbound candidate node.
            entry.nodeId,
            availableTools,
            engine.ids,
            engine.clock.now(),
          );
          graph = candidateFrontier.graph;
          recordSearchEvents(engine, candidateFrontier.events, spanId);
        }
      } catch (error) {
        engine.trace.record("candidate.rejected", {
          phase: engine.phase,
          parentSpanId: spanId,
          payload: { error: safeError(error) },
        });
      }
    }
    const sourceLane = sourceLaneForFrontierEntry(entry);
    const sourceTierContext = sourceTierContextForAction(state, action.candidateId);
    for (const draft of result.evidence ?? []) {
      const candidateFromRef = draft.candidateRef ? localCandidateIds.get(draft.candidateRef) : undefined;
      const candidateId = draft.candidateId ?? candidateFromRef ?? action.candidateId;
      if (draft.candidateRef && !candidateFromRef) {
        engine.trace.record("evidence.admission", {
          phase: engine.phase,
          parentSpanId: spanId,
          payload: {
            admitted: false,
            reason: "unknown_candidate_ref",
            evidenceId: null,
            candidateId: candidateId ?? null,
            sourceType: draft.sourceType,
            candidateRef: draft.candidateRef,
          },
        });
        continue;
      }
      if (draft.candidateId && candidateFromRef && draft.candidateId !== candidateFromRef) {
        engine.trace.record("evidence.admission", {
          phase: engine.phase,
          parentSpanId: spanId,
          payload: {
            admitted: false,
            reason: "candidate_reference_mismatch",
            evidenceId: null,
            candidateId: draft.candidateId,
            referencedCandidateId: candidateFromRef,
            sourceType: draft.sourceType,
          },
        });
        continue;
      }
      if (action.candidateId && candidateId !== action.candidateId) {
        engine.trace.record("evidence.admission", {
          phase: engine.phase,
          parentSpanId: spanId,
          payload: {
            admitted: false,
            reason: "foreign_candidate_id",
            evidenceId: null,
            candidateId: candidateId ?? null,
            expectedCandidateId: action.candidateId,
            sourceType: draft.sourceType,
          },
        });
        continue;
      }
      if (draft.toolCallId !== undefined && draft.toolCallId !== action.id) {
        engine.trace.record("evidence.admission", {
          phase: engine.phase,
          parentSpanId: spanId,
          payload: {
            admitted: false,
            reason: "foreign_tool_call_id",
            evidenceId: null,
            candidateId: candidateId ?? null,
            sourceType: draft.sourceType,
            expectedActionId: action.id,
          },
        });
        continue;
      }
      if (isDeniedResearchSource(draft.sourceUrl)) {
        engine.trace.record("evidence.admission", {
          phase: engine.phase,
          parentSpanId: spanId,
          payload: {
            admitted: false,
            reason: "unsafe_url",
            evidenceId: null,
            candidateId: candidateId ?? null,
            sourceType: draft.sourceType,
          },
        });
        continue;
      }
      const discoveryOnly = draft.sourceType === "search_result" || draft.disposition === "discovery_only";
      if (!sourceLane) {
        engine.trace.record("evidence.admission", {
          phase: engine.phase,
          parentSpanId: spanId,
          payload: {
            admitted: false,
            reason: "illegal_source_lane",
            evidenceId: null,
            candidateId: candidateId ?? null,
            sourceType: draft.sourceType,
          },
        });
        continue;
      }
      if (!discoveryOnly && sourceLane.admission === "discovery_only") {
        engine.trace.record("evidence.admission", {
          phase: engine.phase,
          parentSpanId: spanId,
          payload: {
            admitted: false,
            reason: "source_lane_discovery_only",
            evidenceId: null,
            candidateId: candidateId ?? null,
            sourceType: draft.sourceType,
            sourceLaneId: entry.sourceLaneId,
          },
        });
        continue;
      }
      if (!discoveryOnly && !sourceLane.sourceTypes.includes(draft.sourceType)) {
        engine.trace.record("evidence.admission", {
          phase: engine.phase,
          parentSpanId: spanId,
          payload: {
            admitted: false,
            reason: "source_type_outside_lane",
            evidenceId: null,
            candidateId: candidateId ?? null,
            sourceType: draft.sourceType,
            sourceLaneId: entry.sourceLaneId,
          },
        });
        continue;
      }
      const derivedSourceTier = sourceTierForUrl(
        draft.sourceUrl,
        draft.sourceType,
        entry.sourceTier === 0,
        sourceTierContext,
      );
      if (!discoveryOnly && derivedSourceTier !== null && derivedSourceTier !== entry.sourceTier) {
        engine.trace.record("evidence.admission", {
          phase: engine.phase,
          parentSpanId: spanId,
          payload: {
            admitted: false,
            reason: "source_tier_mismatch",
            evidenceId: null,
            candidateId: candidateId ?? null,
            sourceType: draft.sourceType,
            sourceLaneId: entry.sourceLaneId,
            expectedSourceTier: entry.sourceTier,
            derivedSourceTier,
          },
        });
        continue;
      }
      const admission = engine.admitEvidence({
        ...draft,
        ...(candidateId ? { candidateId } : {}),
        toolCallId: action.id,
      });
      if (admission.admitted && admission.evidence) {
        mutations += 1;
        actionMutations += 1;
        const sourceNodeAdmission = admitGraphNode(
          graph,
          {
            kind: "source",
            label: admission.evidence.title ?? admission.evidence.sourceFamily,
            status: "verified",
            sourceTier: entry.sourceTier,
            sourceLaneId: entry.sourceLaneId,
            frontierEntryId: entry.id,
            actionId: action.id,
            candidateId: admission.evidence.candidateId,
            evidenceId: admission.evidence.id,
            data: {
              sourceUrl: admission.evidence.sourceUrl,
              sourceFamily: admission.evidence.sourceFamily,
              sourceType: admission.evidence.sourceType,
            },
            dedupeEntityKey: `source:${admission.evidence.id}`,
          },
          engine.ids,
          engine.clock.now(),
        );
        graph = sourceNodeAdmission.graph;
        recordSearchEvents(engine, sourceNodeAdmission.events, spanId);
        const actionSourceEdge = admitGraphEdge(
          graph,
          {
            fromNodeId: actionNodeId,
            toNodeId: sourceNodeAdmission.value.id,
            kind: "expands",
            status: "verified",
            frontierEntryId: entry.id,
            actionId: action.id,
            edgeCost: 0.04,
            pathCost: entry.pathCost + 0.09,
          },
          engine.ids,
          engine.clock.now(),
        );
        graph = actionSourceEdge.graph;
        recordSearchEvents(engine, actionSourceEdge.events, spanId);
        const evidenceNodeAdmission = admitGraphNode(
          graph,
          {
            kind: "evidence",
            label: admission.evidence.claim,
            status: admission.evidence.disposition === "contradicts" ? "rejected" : "verified",
            sourceTier: entry.sourceTier,
            sourceLaneId: entry.sourceLaneId,
            frontierEntryId: entry.id,
            actionId: action.id,
            candidateId: admission.evidence.candidateId,
            evidenceId: admission.evidence.id,
            data: {
              disposition: admission.evidence.disposition,
              sourceUrl: admission.evidence.sourceUrl,
              sourceFamily: admission.evidence.sourceFamily,
              sourceType: admission.evidence.sourceType,
              contentHash: admission.evidence.contentHash,
              verificationMethod: admission.evidence.verificationMethod,
            },
            dedupeEntityKey: `evidence:${admission.evidence.id}`,
          },
          engine.ids,
          engine.clock.now(),
        );
        graph = evidenceNodeAdmission.graph;
        recordSearchEvents(engine, evidenceNodeAdmission.events, spanId);
        const sourceEvidenceEdge = admitGraphEdge(
          graph,
          {
            fromNodeId: sourceNodeAdmission.value.id,
            toNodeId: evidenceNodeAdmission.value.id,
            kind: "grounds",
            status: evidenceNodeAdmission.value.status,
            frontierEntryId: entry.id,
            actionId: action.id,
            edgeCost: 0.04,
            pathCost: entry.pathCost + 0.13,
          },
          engine.ids,
          engine.clock.now(),
        );
        graph = sourceEvidenceEdge.graph;
        recordSearchEvents(engine, sourceEvidenceEdge.events, spanId);
        const candidateNode = graph.nodes.find(
          (node) => node.kind === "candidate" && node.candidateId === admission.evidence?.candidateId,
        );
        if (candidateNode) {
          const evidenceCandidateEdge = admitGraphEdge(
            graph,
            {
              fromNodeId: evidenceNodeAdmission.value.id,
              toNodeId: candidateNode.id,
              kind: admission.evidence.disposition === "contradicts" ? "conflicts" : "supports",
              status: evidenceNodeAdmission.value.status,
              frontierEntryId: entry.id,
              actionId: action.id,
              edgeCost: 0.03,
              pathCost: entry.pathCost + 0.16,
            },
            engine.ids,
            engine.clock.now(),
          );
          graph = evidenceCandidateEdge.graph;
          recordSearchEvents(engine, evidenceCandidateEdge.events, spanId);
        }
      }
    }
    pendingSignalUpdates.push(...(result.candidateSignals ?? []));
    for (const update of pendingSignalUpdates) {
      if (action.candidateId && update.candidateId !== action.candidateId) {
        engine.trace.record("candidate_signal.rejected", {
          phase: engine.phase,
          parentSpanId: spanId,
          payload: {
            candidateId: update.candidateId,
            expectedCandidateId: action.candidateId,
            reason: "foreign_candidate_id",
          },
        });
        continue;
      }
      const evidence = engine.snapshot().evidence;
      const accepted: IdentitySignal[] = [];
      for (const signal of update.signals) {
        const bound = bindToolProposedSignal(signal, update.candidateId, action.id, evidence);
        if (bound.signal) {
          accepted.push(bound.signal);
        } else {
          engine.trace.record("candidate_signal.rejected", {
            phase: engine.phase,
            parentSpanId: spanId,
            payload: {
              candidateId: update.candidateId,
              kind: signal.kind,
              reason: bound.reason ?? "identity_signal_rejected",
            },
          });
        }
      }
      if (accepted.length === 0) continue;
      try {
        engine.addCandidateSignals(update.candidateId, accepted);
        mutations += 1;
        actionMutations += 1;
      } catch (error) {
        engine.trace.record("candidate_signal.rejected", {
          phase: engine.phase,
          parentSpanId: spanId,
          payload: { candidateId: update.candidateId, error: safeError(error) },
        });
      }
    }
    for (const finding of result.findings ?? []) {
      if (action.candidateId && finding.candidateId !== action.candidateId) {
        engine.trace.record("finding.rejected", {
          phase: engine.phase,
          parentSpanId: spanId,
          payload: {
            candidateId: finding.candidateId,
            expectedCandidateId: action.candidateId,
            reason: "foreign_candidate_id",
          },
        });
        continue;
      }
      try {
        const beforeFindingCount = engine.snapshot().findings.length;
        const admittedFinding = engine.addFinding(finding);
        if (engine.snapshot().findings.length > beforeFindingCount) {
          mutations += 1;
          actionMutations += 1;
          const findingNodeAdmission = admitGraphNode(
            graph,
            {
              kind: "finding",
              label: admittedFinding.title,
              status: "verified",
              sourceTier: entry.sourceTier,
              sourceLaneId: entry.sourceLaneId,
              frontierEntryId: entry.id,
              actionId: action.id,
              candidateId: admittedFinding.candidateId,
              findingId: admittedFinding.id,
              data: {
                category: admittedFinding.category,
                confidence: admittedFinding.confidence.score,
              },
              dedupeEntityKey: `finding:${admittedFinding.id}`,
            },
            engine.ids,
            engine.clock.now(),
          );
          graph = findingNodeAdmission.graph;
          recordSearchEvents(engine, findingNodeAdmission.events, spanId);
          for (const evidenceId of [...admittedFinding.evidenceIds, ...admittedFinding.counterEvidenceIds]) {
            // Only the evidence node (not its same-evidenceId source node) may
            // ground a finding: grounds edges must be evidence->finding.
            const evidenceNode = graph.nodes.find((node) => node.kind === "evidence" && node.evidenceId === evidenceId);
            if (!evidenceNode) continue;
            const findingEdge = admitGraphEdge(
              graph,
              {
                fromNodeId: evidenceNode.id,
                toNodeId: findingNodeAdmission.value.id,
                kind: "grounds",
                status: "verified",
                frontierEntryId: entry.id,
                actionId: action.id,
                edgeCost: 0.03,
                pathCost: entry.pathCost + 0.19,
              },
              engine.ids,
              engine.clock.now(),
            );
            graph = findingEdge.graph;
            recordSearchEvents(engine, findingEdge.events, spanId);
          }
        }
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
    const tokens = usesAttemptAccounting ? accountedModel.tokenUsage : zeroSafeTokens(result.tokenUsage);
    if (!usesAttemptAccounting && Object.keys(tokens).length > 0) engine.recordTokens(tokens);
    const reportedLlmCalls = usesAttemptAccounting ? accountedModel.llmCalls : result.meta?.llmCalls;
    if (!usesAttemptAccounting && reportedLlmCalls !== undefined) {
      engine.recordLlmCalls(reportedLlmCalls);
    }
    const reportedRequests = result.meta?.requests;
    const chargedRequests = reportedRequests ?? (action.budgetClass === "compute" ? 0 : 1);
    engine.recordToolCall(chargedRequests, action.budgetClass === "search");
    engine.trace.endSpan(spanId, {
      status: actionTraceStatus(result.status),
      payload: {
        actionId: action.id,
        frontierEntryId: action.frontierEntryId,
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
        networkRequests:
          reportedRequests === undefined
            ? usesAttemptAccounting
              ? accountedModel.networkRequests
              : null
            : reportedRequests + (usesAttemptAccounting ? (accountedModel.networkRequests ?? 0) : 0),
        bytesRead: result.meta?.bytesRead ?? null,
        unavailableReason: usesAttemptAccounting ? accountedModel.usageUnavailableReason : undefined,
      },
    });
    const frontierStatus: Extract<SearchGraphStatus, "verified" | "rejected" | "exhausted"> =
      actionMutations > 0 ? "verified" : result.status === "failed" ? "rejected" : "exhausted";
    const outcome = recordFrontierOutcome(graph, entry, frontierStatus, engine.clock.now());
    graph = outcome.graph;
    // The tool span is closed above after all tool-derived trust mutations are
    // admitted. Frontier bookkeeping is a scheduler concern, so it must not be
    // attached to the now-closed span.
    recordSearchEvents(engine, outcome.events);

    if (actionMutations === 0) {
      const gapNodeAdmission = admitGraphNode(
        graph,
        {
          kind: "gap",
          label: result.diagnostics?.[0]?.message ?? `${action.tool} produced no admissible evidence`,
          status: frontierStatus,
          sourceTier: entry.sourceTier,
          sourceLaneId: entry.sourceLaneId,
          frontierEntryId: entry.id,
          actionId: action.id,
          candidateId: action.candidateId ?? null,
          data: { resultStatus: result.status },
        },
        engine.ids,
        engine.clock.now(),
      );
      graph = gapNodeAdmission.graph;
      recordSearchEvents(engine, gapNodeAdmission.events);
      const gapEdgeAdmission = admitGraphEdge(
        graph,
        {
          fromNodeId: actionNodeId,
          toNodeId: gapNodeAdmission.value.id,
          kind: "expands",
          status: frontierStatus,
          frontierEntryId: entry.id,
          actionId: action.id,
          edgeCost: 0.04,
          pathCost: entry.pathCost + 0.09,
        },
        engine.ids,
        engine.clock.now(),
      );
      graph = gapEdgeAdmission.graph;
      recordSearchEvents(engine, gapEdgeAdmission.events);
    }
  }

  const mutationParent = executedEntries.find(
    (entry) => entry.mutation === null && frontierEntryById(graph, entry.id)?.status === "verified",
  );
  if (mutationParent) {
    const mutation = await proposeBoundedMutation(graph, state.target, mutationParent, engine.ids, engine.clock.now());
    graph = mutation.graph;
    recordSearchEvents(engine, mutation.events);
  }
  assertSearchGraph(graph);
  engine.replaceSearchGraph(graph);
  return { mutations, graph, executedEntries };
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
    const model =
      accounted.llmCalls > 0
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
    const model = accounted.llmCalls > 0 ? accounted : chargeLegacyModelTelemetry(engine, undefined, undefined, 1);
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

function terminalGraphStatus(reason: NonNullable<ReturnType<typeof evaluateStop>["reason"]>): SearchGraph["status"] {
  if (reason === "goal_satisfied") return "completed";
  if (reason === "unsafe_request") return "blocked";
  if (reason === "cancelled") return "canceled";
  if (reason === "fatal_error" || reason === "configuration_error") return "failed";
  return "exhausted";
}

function addTerminalReportNode(
  engine: InvestigationEngine,
  graphValue: SearchGraph,
  status: SearchGraph["status"],
): SearchGraph {
  let graph = cloneJson(graphValue);
  if (graph.seedNodeId === null) return markSearchGraphTerminal(graph, status, engine.clock.now());
  const reportNode = admitGraphNode(
    graph,
    {
      kind: "report",
      label: status === "completed" ? "Completed intelligence report" : "Bounded intelligence report",
      status: status === "completed" ? "verified" : "exhausted",
      data: {
        candidateCount: engine.snapshot().candidates.length,
        evidenceCount: engine.snapshot().evidence.length,
        findingCount: engine.snapshot().findings.length,
      },
      dedupeEntityKey: `report:${engine.runId}`,
    },
    engine.ids,
    engine.clock.now(),
  );
  graph = reportNode.graph;
  recordSearchEvents(engine, reportNode.events);
  const includedNodes = graph.nodes.filter(
    (node) =>
      node.id !== reportNode.value.id && (node.kind === "candidate" || node.kind === "finding" || node.kind === "gap"),
  );
  for (const node of includedNodes) {
    const edge = admitGraphEdge(
      graph,
      {
        fromNodeId: node.id,
        toNodeId: reportNode.value.id,
        kind: "includes",
        status: node.status,
        edgeCost: 0.02,
        pathCost: 0.02 + Math.max(1, node.ordinal) / 1_000_000,
      },
      engine.ids,
      engine.clock.now(),
    );
    graph = edge.graph;
    recordSearchEvents(engine, edge.events);
  }
  return markSearchGraphTerminal(graph, status, engine.clock.now());
}

function terminalizeWithGraph(
  engine: InvestigationEngine,
  graphValue: SearchGraph,
  decision: ReturnType<typeof evaluateStop>,
  options: StopEvaluationOptions = {},
): SearchGraph {
  if (!decision.allowed || !decision.reason) {
    throw new Error("cannot terminalize from a denied stop decision");
  }
  const graph = addTerminalReportNode(engine, graphValue, terminalGraphStatus(decision.reason));
  assertSearchGraph(graph);
  engine.replaceSearchGraph(graph);
  engine.stopDecision(decision, options);
  return graph;
}

function admitMissingFindingNodes(engine: InvestigationEngine, graphValue: SearchGraph): SearchGraph {
  let graph = cloneJson(graphValue);
  for (const finding of engine.snapshot().findings) {
    if (graph.nodes.some((node) => node.findingId === finding.id)) continue;
    const findingNode = admitGraphNode(
      graph,
      {
        kind: "finding",
        label: finding.title,
        status: "verified",
        candidateId: finding.candidateId,
        findingId: finding.id,
        data: {
          category: finding.category,
          confidence: finding.confidence.score,
        },
        dedupeEntityKey: `finding:${finding.id}`,
      },
      engine.ids,
      engine.clock.now(),
    );
    graph = findingNode.graph;
    recordSearchEvents(engine, findingNode.events);
    for (const evidenceId of [...finding.evidenceIds, ...finding.counterEvidenceIds]) {
      // A source node and its evidence node share the same evidenceId; only the
      // evidence node may ground a finding (grounds: evidence->finding). Matching
      // by evidenceId alone can hit the source node first, yielding an illegal
      // source->finding edge.
      const evidenceNode = graph.nodes.find((node) => node.kind === "evidence" && node.evidenceId === evidenceId);
      if (!evidenceNode) continue;
      const edge = admitGraphEdge(
        graph,
        {
          fromNodeId: evidenceNode.id,
          toNodeId: findingNode.value.id,
          kind: "grounds",
          status: "verified",
          edgeCost: 0.03,
          pathCost: 0.03 + Math.max(1, findingNode.value.ordinal) / 1_000_000,
        },
        engine.ids,
        engine.clock.now(),
      );
      graph = edge.graph;
      recordSearchEvents(engine, edge.events);
    }
  }
  return graph;
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
  let graph = engine.snapshot().searchGraph;
  let selectedEntries: SearchFrontierEntry[] = [];
  let plannerDecision: PlannerDecision | null = null;
  let turnMutations = 0;
  let turnStarted = false;
  let traceCursor = 0;

  const emitPending = (): ResearchUpdate[] => {
    const pending = pendingUpdates(engine, traceCursor);
    traceCursor = pending.traceCursor;
    return pending.updates;
  };

  for (const update of emitPending()) yield update;

  const hasPendingFrontier = (): boolean =>
    graph.frontier.some((entry) => entry.status === "queued" || entry.status === "mutated");

  const finish = (decision: ReturnType<typeof evaluateStop>, stopOptions: StopEvaluationOptions = {}): void => {
    graph = terminalizeWithGraph(engine, graph, decision, stopOptions);
  };

  const advanceToCalibrate = (): boolean => {
    while (engine.status === "running" && engine.phase !== "calibrate") {
      let next: ResearchPhase | undefined;
      if (engine.phase === "plan") next = "discover";
      else if (engine.phase === "discover") next = "separate_candidates";
      else if (engine.phase === "separate_candidates") {
        next = engine.snapshot().candidates.length > 0 ? "corroborate" : undefined;
      } else if (engine.phase === "corroborate") next = "calibrate";
      else return false;
      if (!next || !canTransitionPhase(engine.phase, next)) return false;
      engine.transition(next);
    }
    return engine.phase === "calibrate";
  };

  const completeIfSatisfied = (): boolean => {
    const decision = evaluateStop(engine.snapshot(), completionStopOptions);
    if (!decision.allowed || decision.reason !== "goal_satisfied") return false;
    if (!advanceToCalibrate()) return false;
    if (engine.phase === "calibrate") engine.transition("report");
    finish(decision, completionStopOptions);
    return true;
  };

  try {
    const harness = compileFrontierHarness({
      classify: () => {
        engine.transition("classify");
        if (engine.snapshot().safety.level === "block") {
          finish(evaluateStop(engine.snapshot()));
          return { route: "terminal" };
        }
        engine.transition("plan");
        return { route: "seed_frontier" };
      },

      seedFrontier: () => {
        const seeded = seedFrontier(graph, engine.snapshot().target, availableTools, engine.ids, engine.clock.now());
        graph = seeded.graph;
        recordSearchEvents(engine, seeded.events);
        engine.replaceSearchGraph(graph);
        return { route: "select_frontier" };
      },

      selectFrontier: () => {
        if (options.signal?.aborted) {
          finish(evaluateStop(engine.snapshot(), { canceled: true }), { canceled: true });
          return { route: "terminal", selectedFrontierEntryIds: [] };
        }
        if (!engine.canStartTurn()) {
          const stop = evaluateStop(engine.snapshot(), completionStopOptions);
          if (stop.allowed) {
            finish(stop, completionStopOptions);
            return { route: "terminal", selectedFrontierEntryIds: [] };
          }
          const next = naturalNextPhase(engine.snapshot());
          if (next && canTransitionPhase(engine.phase, next)) {
            engine.trace.record("phase.cap_reached", {
              phase: engine.phase,
              payload: { nextPhase: next },
            });
            engine.transition(next);
            if (engine.phase === "calibrate") return { route: "synthesize" };
          } else {
            finish(evaluateStop(engine.snapshot(), { noLegalActions: true }), { noLegalActions: true });
            return { route: "terminal", selectedFrontierEntryIds: [] };
          }
        }

        const state = engine.snapshot();
        const remainingCalls = Math.max(0, state.budget.limits.maxToolCalls - state.budget.usage.toolCalls);
        const limit = Math.min(state.budget.limits.maxActionsPerTurn, remainingCalls, MAX_OUTBOUND_CONCURRENCY);
        const selection = selectFrontierBatch(graph, limit, engine.clock.now());
        graph = selection.graph;
        selectedEntries = selection.value;
        recordSearchEvents(engine, selection.events);

        if (selectedEntries.length === 0) {
          const strandedMutations = graph.frontier.filter(
            (entry) => entry.status === "mutated" || entry.status === "queued",
          );
          if (strandedMutations.length > 0) {
            graph = setFrontierStatus(
              graph,
              strandedMutations.map((entry) => entry.id),
              "exhausted",
              engine.clock.now(),
            );
            graph.status = "exhausted";
            graph.telemetry.exhausted += strandedMutations.length;
            engine.trace.record("frontier.exhausted", {
              phase: engine.phase,
              payload: {
                reason: "remaining_entries_not_legal_under_budget_or_mutation_cap",
                entryCount: strandedMutations.length,
              },
            });
          }
          engine.replaceSearchGraph(graph);
          if (engine.snapshot().evidence.length > 0 && advanceToCalibrate()) {
            return { route: "synthesize", selectedFrontierEntryIds: [] };
          }
          finish(evaluateStop(engine.snapshot(), { noLegalActions: true }), { noLegalActions: true });
          return { route: "terminal", selectedFrontierEntryIds: [] };
        }

        engine.replaceSearchGraph(graph);
        engine.beginTurn();
        turnStarted = true;
        turnMutations = 0;
        plannerDecision = null;
        return {
          route: "plan_expansion",
          selectedFrontierEntryIds: selectedEntries.map((entry) => entry.id),
          decision: null,
          mutations: 0,
        };
      },

      planExpansion: async () => {
        plannerDecision = await invokePlanner(engine, dependencies, availableTools, selectedEntries, options.signal);
        if (plannerDecision.kind !== "actions") {
          graph = requeueFrontier(
            graph,
            selectedEntries.map((entry) => entry.id),
            engine.clock.now(),
          );
          engine.replaceSearchGraph(graph);
        }
        const route: FrontierHarnessRoute = plannerDecision.kind === "actions" ? "execute_expansion" : "assess";
        return {
          route,
          decision: cloneJson(plannerDecision) as unknown as JsonObject,
        };
      },

      executeExpansion: async () => {
        if (!plannerDecision || plannerDecision.kind !== "actions") {
          return { route: "admit_expand", mutations: 0 };
        }
        if (engine.phase === "plan") engine.transition("discover");
        const batch = await executeActions(
          engine,
          dependencies,
          plannerDecision.actions,
          graph,
          selectedEntries,
          availableTools,
          options.signal,
        );
        graph = batch.graph;
        turnMutations += batch.mutations;
        return { route: "admit_expand", mutations: turnMutations };
      },

      admitExpand: () => {
        // executeActions admits settled results in selected-frontier order.
        // This explicit node is the orchestration barrier before assessment.
        assertSearchGraph(graph);
        return { route: "assess", mutations: turnMutations };
      },

      assess: () => {
        if (turnStarted) {
          engine.endTurn(turnMutations > 0);
          turnStarted = false;
        }
        if (options.signal?.aborted) {
          finish(evaluateStop(engine.snapshot(), { canceled: true }), { canceled: true });
          return { route: "terminal" };
        }

        if (plannerDecision?.kind === "stop") {
          const stop = evaluateStop(engine.snapshot(), {
            plannerRequested: true,
            ...completionStopOptions,
          });
          if (stop.allowed) {
            finish(stop, { plannerRequested: true, ...completionStopOptions });
            return { route: "terminal" };
          }
          engine.trace.record("planner.stop_rejected", {
            phase: engine.phase,
            payload: { detail: stop.detail },
          });
        }

        const stop = evaluateStop(engine.snapshot(), completionStopOptions);
        if (stop.allowed && stop.reason !== "goal_satisfied") {
          finish(stop, completionStopOptions);
          return { route: "terminal" };
        }
        if (stop.allowed && stop.reason === "goal_satisfied" && completeIfSatisfied()) {
          return { route: "terminal" };
        }
        if (engine.phase === "calibrate") return { route: "synthesize" };

        const requestedNext = plannerDecision?.kind === "advance" ? plannerDecision.nextPhase : undefined;
        const next =
          requestedNext && requestedNext !== "terminal" && canTransitionPhase(engine.phase, requestedNext)
            ? requestedNext
            : naturalNextPhase(engine.snapshot());
        if (next && canTransitionPhase(engine.phase, next)) {
          engine.transition(next);
          return { route: next === "calibrate" ? "synthesize" : "select_frontier" };
        }
        if (engine.phase === "report") {
          finish(evaluateStop(engine.snapshot(), { noLegalActions: true }), { noLegalActions: true });
          return { route: "terminal" };
        }
        return { route: "select_frontier" };
      },

      synthesize: async () => {
        if (!advanceToCalibrate()) {
          finish(evaluateStop(engine.snapshot(), { noLegalActions: true }), { noLegalActions: true });
          return { route: "terminal" };
        }
        const synthesized = await synthesizeFindings(engine, dependencies, options.signal);
        graph = admitMissingFindingNodes(engine, graph);
        engine.replaceSearchGraph(graph);
        if (turnStarted) {
          engine.endTurn(turnMutations + synthesized > 0);
          turnStarted = false;
        }
        if (options.signal?.aborted) {
          finish(evaluateStop(engine.snapshot(), { canceled: true }), { canceled: true });
          return { route: "terminal" };
        }
        if (completeIfSatisfied()) return { route: "terminal" };
        const stop = evaluateStop(engine.snapshot(), completionStopOptions);
        if (stop.allowed && stop.reason !== "goal_satisfied") {
          finish(stop, completionStopOptions);
          return { route: "terminal" };
        }
        if (hasPendingFrontier()) {
          if (engine.phase === "calibrate" && canTransitionPhase("calibrate", "corroborate")) {
            engine.transition("corroborate");
          }
          return { route: "select_frontier" };
        }
        finish(evaluateStop(engine.snapshot(), { noLegalActions: true }), { noLegalActions: true });
        return { route: "terminal" };
      },
    });

    const stream = await harness.stream(initialFrontierHarnessState(), {
      streamMode: "updates",
      recursionLimit: Math.max(80, engine.snapshot().budget.limits.maxTurns * 8 + 24),
    });
    for await (const chunk of stream) {
      void chunk;
      for (const update of emitPending()) yield update;
    }
    if (engine.status === "running") {
      graph = engine.snapshot().searchGraph;
      graph = addTerminalReportNode(engine, graph, "failed");
      engine.replaceSearchGraph(graph);
      engine.stopExternal("fatal_error", "LangGraph ended before Atlas reached a legal terminal state.");
    }
    for (const update of emitPending()) yield update;
  } catch (error) {
    if (engine.status === "running") {
      if (options.signal?.aborted) {
        finish(evaluateStop(engine.snapshot(), { canceled: true }), { canceled: true });
      } else {
        // A mid-run failure (budget exhaustion, a transient provider/rate-limit
        // error, etc.) should not discard work already done. If a legal terminal
        // exists — or evidence has been gathered — finalize as a partial report
        // that preserves the collected evidence and findings.
        const snapshot = engine.snapshot();
        const naturalStop = evaluateStop(snapshot);
        const gracefulStop = naturalStop.allowed
          ? naturalStop
          : snapshot.evidence.length > 0
            ? evaluateStop(snapshot, { noLegalActions: true })
            : null;
        let gracefullyStopped = false;
        if (gracefulStop?.allowed && gracefulStop.reason !== "goal_satisfied") {
          try {
            // Finalize from the last committed (valid) graph, since the local
            // graph may be mid-mutation at the point the error surfaced.
            graph = engine.snapshot().searchGraph;
            engine.replaceSearchGraph(graph);
            // A terminal report can only be committed from a report-eligible
            // phase. The error may have surfaced mid-plan/discover, so advance
            // the phase the same way the normal completion paths do before
            // finishing. Provider synthesis is unavailable here (the provider is
            // what just failed), so the partial report preserves the admitted
            // evidence without new findings.
            try {
              advanceToCalibrate();
              if (engine.phase === "calibrate") engine.transition("report");
            } catch {
              // Best-effort: fall through and finish from the current phase.
            }
            finish(gracefulStop);
            gracefullyStopped = true;
          } catch {
            gracefullyStopped = false;
          }
        }
        if (!gracefullyStopped) {
          graph = engine.snapshot().searchGraph;
          graph = addTerminalReportNode(engine, graph, "failed");
          engine.replaceSearchGraph(graph);
          engine.stopExternal("fatal_error", `Investigation failed: ${safeError(error).message as string}`);
        }
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

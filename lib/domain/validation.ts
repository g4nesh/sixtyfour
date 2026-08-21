import { isJsonValue, normalizeWhitespace, roundScore } from "./runtime";
import {
  SCHEMA_VERSION,
  SEARCH_GRAPH_SCHEMA_VERSION,
  type BudgetLimits,
  type Candidate,
  type EvidenceRecord,
  type Finding,
  type InvestigationInput,
  type InvestigationReport,
  type InvestigationState,
  type ParsedTarget,
  type ResearchDepth,
  type SafetyDecision,
  type SearchGraph,
} from "./types";
import { validateSearchGraph } from "../search/frontier";

const RESEARCH_DEPTHS = ["quick", "standard", "deep"] as const;
const TARGET_KINDS = [
  "email",
  "named_person",
  "role_query",
  "organization",
  "url",
  "domain",
  "repository",
  "publication",
  "package",
  "platform_handle",
  "unknown",
] as const;
const IDENTIFIER_KINDS = [
  "email",
  "url",
  "domain",
  "repository",
  "doi",
  "orcid",
  "package",
  "platform_handle",
  "profile_url",
  "personal_domain",
  "social_handle",
  "github_commit_email",
  "keybase_proof",
  "other",
] as const;
const IDENTIFIER_ASSURANCES = ["verified", "corroborated", "self_asserted", "spoofable"] as const;
const SAFETY_LEVELS = ["allow", "caution", "block"] as const;
const SAFETY_REASONS = [
  "public_professional_research",
  "exact_identifier_supplied",
  "sensitive_personal_data",
  "precise_location_or_contact",
  "credential_or_financial_data",
  "targeting_or_harassment",
  "family_or_relationship_mapping",
  "contact_automation",
  "high_impact_decision",
  "minor_or_vulnerable_person",
  "illegal_or_violent_intent",
] as const;
const CANDIDATE_STATUSES = ["separate", "plausible", "resolved", "rejected"] as const;
const SIGNAL_KINDS = [
  "name",
  "email",
  "organization",
  "role",
  "location",
  "profile_url",
  "personal_domain",
  "social_handle",
  "github_commit_email",
  "keybase_proof",
  "cross_profile_link",
  "cross_source_match",
  "bio_phrase",
  "conflict",
] as const;
const SIGNAL_STRENGTHS = ["weak", "medium", "strong"] as const;
const EVIDENCE_DISPOSITIONS = ["supports", "contradicts", "discovery_only"] as const;
const EVIDENCE_SOURCE_TYPES = [
  "official_profile",
  "company_page",
  "professional_profile",
  "code_profile",
  "code_commit",
  "keybase_proof",
  "news",
  "web_archive",
  "search_result",
  "public_document",
  "other",
] as const;
const VERIFICATION_METHODS = [
  "direct_fetch",
  "api_response",
  "cryptographic_proof",
  "cross_source_corroboration",
  "archive_snapshot",
  "search_discovery",
  "unverified",
] as const;
const TEMPORAL_STATUSES = ["current", "historical", "undated", "unknown"] as const;
const FINDING_CATEGORIES = [
  "identity",
  "employment",
  "education",
  "project",
  "publication",
  "online_presence",
  "timeline",
  "other",
] as const;
const CONFIDENCE_LABELS = ["low", "moderate", "high", "very_high"] as const;
const RESEARCH_PHASES = [
  "intake",
  "classify",
  "plan",
  "discover",
  "separate_candidates",
  "corroborate",
  "calibrate",
  "report",
  "terminal",
] as const;
const TERMINAL_STATUSES = [
  "completed",
  "partial",
  "ambiguous",
  "blocked",
  "configuration_error",
  "canceled",
  "failed",
] as const;
const INVESTIGATION_STATUSES = ["running", ...TERMINAL_STATUSES] as const;
const SEARCH_GRAPH_RUN_STATUSES = [
  "empty",
  "active",
  "exhausted",
  "completed",
  "blocked",
  "canceled",
  "failed",
] as const;
const SEARCH_GRAPH_NODE_STATUSES = [
  "queued",
  "selected",
  "running",
  "verified",
  "rejected",
  "exhausted",
  "mutated",
] as const;
const SEARCH_GRAPH_NODE_KINDS = [
  "seed",
  "pivot",
  "action",
  "source",
  "evidence",
  "candidate",
  "finding",
  "gap",
  "report",
] as const;
const SEARCH_GRAPH_EDGE_KINDS = [
  "expands",
  "mutates",
  "supports",
  "conflicts",
  "separates",
  "grounds",
  "includes",
] as const;
const SEARCH_GRAPH_MUTATION_STRATEGIES = [
  "exact_phrase",
  "role_anchor",
  "organization_anchor",
  "source_adjacent",
] as const;
const SOURCE_TIERS = [0, 1, 2, 3, 4, 5, 6] as const;
const STOP_REASONS = [
  "goal_satisfied",
  "budget_exhausted",
  "diminishing_returns",
  "unsafe_request",
  "no_legal_actions",
  "planner_requested",
  "cancelled",
  "configuration_error",
  "fatal_error",
] as const;

export interface ValidationIssue {
  path: string;
  message: string;
}

export class SchemaValidationError extends TypeError {
  readonly issues: ValidationIssue[];

  constructor(message: string, issues: ValidationIssue[]) {
    super(message);
    this.name = "SchemaValidationError";
    this.issues = issues;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isVersioned(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.schemaVersion === SCHEMA_VERSION;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && normalizeWhitespace(value).length > 0;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return isFiniteNonNegative(value) && Number.isInteger(value);
}

function isScore(value: unknown): value is number {
  return isFiniteNonNegative(value) && value <= 1;
}

function isOneOf(value: unknown, allowed: readonly string[]): value is string {
  return typeof value === "string" && allowed.includes(value);
}

function isStringArray(value: unknown, nonEmpty = false): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => (nonEmpty ? isNonEmptyString(entry) : typeof entry === "string"))
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isOptionalNonEmptyString(value: unknown): value is string | undefined {
  return value === undefined || isNonEmptyString(value);
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && isJsonValue(value);
}

function isPhaseCounterRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    Object.entries(value).every(([phase, count]) => isOneOf(phase, RESEARCH_PHASES) && isNonNegativeInteger(count))
  );
}

function isIdentitySignal(value: unknown): boolean {
  return (
    isRecord(value) &&
    isOneOf(value.kind, SIGNAL_KINDS) &&
    isNonEmptyString(value.value) &&
    isNonEmptyString(value.normalizedValue) &&
    isOneOf(value.strength, SIGNAL_STRENGTHS) &&
    isOneOf(value.assurance, IDENTIFIER_ASSURANCES) &&
    isOptionalNonEmptyString(value.sourceEvidenceId) &&
    isOptionalNonEmptyString(value.sourceFamily) &&
    isJsonValue(value)
  );
}

function isCandidateScore(value: unknown): boolean {
  return (
    isRecord(value) &&
    isScore(value.total) &&
    isScore(value.positive) &&
    isScore(value.penalty) &&
    isStringArray(value.independentFamilies, true) &&
    Array.isArray(value.matchedSignals) &&
    value.matchedSignals.every((entry) => isOneOf(entry, SIGNAL_KINDS)) &&
    Array.isArray(value.conflictingSignals) &&
    value.conflictingSignals.every((entry) => isOneOf(entry, SIGNAL_KINDS)) &&
    typeof value.cappedBecauseSpoofable === "boolean"
  );
}

function isConfidenceAssessment(value: unknown): boolean {
  return (
    isRecord(value) &&
    isScore(value.score) &&
    isOneOf(value.label, CONFIDENCE_LABELS) &&
    isStringArray(value.independentSourceFamilies, true) &&
    isStringArray(value.supportingEvidenceIds, true) &&
    isStringArray(value.contradictingEvidenceIds, true) &&
    isStringArray(value.appliedCaps)
  );
}

function isEvidenceTelemetry(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return ["admitted", "rejected", "duplicate", "discoveryOnly", "supporting", "contradicting"].every((key) =>
    isNonNegativeInteger(value[key]),
  );
}

function isInvestigationStop(value: unknown): boolean {
  return (
    isRecord(value) &&
    isOneOf(value.reason, STOP_REASONS) &&
    isNonEmptyString(value.detail) &&
    isNonEmptyString(value.at)
  );
}

function throwIssues(label: string, issues: ValidationIssue[]): never {
  throw new SchemaValidationError(`${label} failed schema v${SCHEMA_VERSION} validation`, issues);
}

export function isInvestigationInput(value: unknown): value is InvestigationInput {
  if (!isVersioned(value) || !isNonEmptyString(value.query)) {
    return false;
  }
  if (value.objective !== undefined && !isNonEmptyString(value.objective)) {
    return false;
  }
  if (value.requestedDepth !== undefined && !RESEARCH_DEPTHS.includes(value.requestedDepth as ResearchDepth)) {
    return false;
  }
  if (
    value.requestedCategories !== undefined &&
    (!Array.isArray(value.requestedCategories) ||
      value.requestedCategories.length === 0 ||
      value.requestedCategories.some((category) => !isOneOf(category, FINDING_CATEGORIES)))
  ) {
    return false;
  }
  if (value.locale !== undefined && !isNonEmptyString(value.locale)) {
    return false;
  }
  return isJsonValue(value);
}

export function parseInvestigationInput(value: unknown): InvestigationInput {
  if (typeof value === "string") {
    value = { schemaVersion: SCHEMA_VERSION, query: value };
  }
  if (!isInvestigationInput(value)) {
    throwIssues("InvestigationInput", [
      { path: "$", message: `expected {schemaVersion: ${SCHEMA_VERSION}, query: non-empty string}` },
    ]);
  }
  return {
    ...value,
    query: normalizeWhitespace(value.query),
    ...(value.objective ? { objective: normalizeWhitespace(value.objective) } : {}),
    ...(value.requestedCategories ? { requestedCategories: [...new Set(value.requestedCategories)].sort() } : {}),
  };
}

export function isBudgetLimits(value: unknown): value is BudgetLimits {
  if (!isRecord(value)) return false;
  const keys: Array<keyof BudgetLimits> = [
    "maxTurns",
    "maxLlmCalls",
    "maxToolCalls",
    "maxSearchCalls",
    "maxEvidenceAttempts",
    "maxNetworkRequests",
    "maxInputTokens",
    "maxOutputTokens",
    "maxThinkingTokens",
    "maxCostUsd",
    "maxDurationMs",
    "maxConsecutiveNoProgress",
    "maxActionsPerTurn",
  ];
  return keys.every((key) => isFiniteNonNegative(value[key])) && isPhaseCounterRecord(value.phaseCaps);
}

export function parseBudgetLimits(value: unknown): BudgetLimits {
  if (!isBudgetLimits(value)) {
    throwIssues("BudgetLimits", [{ path: "$", message: "all budget dimensions must be finite non-negative numbers" }]);
  }
  return { ...value, phaseCaps: { ...value.phaseCaps } };
}

export function isCandidate(value: unknown): value is Candidate {
  return (
    isVersioned(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.displayName) &&
    isNonEmptyString(value.normalizedName) &&
    isOneOf(value.status, CANDIDATE_STATUSES) &&
    Array.isArray(value.signals) &&
    value.signals.every(isIdentitySignal) &&
    isStringArray(value.evidenceIds, true) &&
    isCandidateScore(value.score) &&
    isNonEmptyString(value.createdAt) &&
    isNonEmptyString(value.updatedAt) &&
    isJsonValue(value)
  );
}

export function parseCandidate(value: unknown): Candidate {
  if (!isCandidate(value)) {
    throwIssues("Candidate", [{ path: "$", message: "invalid candidate schema" }]);
  }
  return value;
}

export function isParsedTarget(value: unknown): value is ParsedTarget {
  return (
    isVersioned(value) &&
    isNonEmptyString(value.rawInput) &&
    isNonEmptyString(value.normalizedQuery) &&
    isOneOf(value.kind, TARGET_KINDS) &&
    isOptionalNonEmptyString(value.name) &&
    isOptionalNonEmptyString(value.normalizedName) &&
    (value.name === undefined) === (value.normalizedName === undefined) &&
    isStringArray(value.roleHints, true) &&
    Array.isArray(value.organizationHints) &&
    value.organizationHints.every(
      (organization) =>
        isRecord(organization) &&
        isNonEmptyString(organization.name) &&
        isNonEmptyString(organization.normalizedName) &&
        isOneOf(organization.relationship, ["current", "former", "unspecified"]),
    ) &&
    isStringArray(value.locationHints, true) &&
    Array.isArray(value.identifiers) &&
    value.identifiers.every(
      (identifier) =>
        isRecord(identifier) &&
        isOneOf(identifier.kind, IDENTIFIER_KINDS) &&
        isNonEmptyString(identifier.value) &&
        isNonEmptyString(identifier.normalizedValue) &&
        isOneOf(identifier.assurance, IDENTIFIER_ASSURANCES) &&
        isOneOf(identifier.provenance, ["user_input", "public_source"]),
    ) &&
    isJsonValue(value)
  );
}

export function isSafetyDecision(value: unknown): value is SafetyDecision {
  return (
    isVersioned(value) &&
    isOneOf(value.level, SAFETY_LEVELS) &&
    isOneOf(value.permittedScope, ["public_professional_only", "none"]) &&
    Array.isArray(value.reasons) &&
    value.reasons.every(
      (reason) =>
        isRecord(reason) &&
        isOneOf(reason.code, SAFETY_REASONS) &&
        isNonEmptyString(reason.message) &&
        isStringArray(reason.matchedTerms),
    ) &&
    isStringArray(value.redactions) &&
    isJsonValue(value)
  );
}

export function isEvidenceRecord(value: unknown): value is EvidenceRecord {
  return (
    isVersioned(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.candidateId) &&
    isNonEmptyString(value.claim) &&
    isNonEmptyString(value.normalizedClaim) &&
    isOneOf(value.disposition, EVIDENCE_DISPOSITIONS) &&
    isNonEmptyString(value.sourceUrl) &&
    isNonEmptyString(value.canonicalUrl) &&
    isNonEmptyString(value.sourceFamily) &&
    isOneOf(value.sourceType, EVIDENCE_SOURCE_TYPES) &&
    isNonEmptyString(value.retrievedAt) &&
    isNullableString(value.queryUrl) &&
    isNullableString(value.title) &&
    isNullableString(value.publisher) &&
    isNullableString(value.publishedAt) &&
    isNullableString(value.observedAt) &&
    (value.httpStatus === null || isFiniteNonNegative(value.httpStatus)) &&
    isNullableString(value.contentHash) &&
    isNullableString(value.excerpt) &&
    (value.canonicalSubset === null || isJsonObject(value.canonicalSubset)) &&
    isNullableString(value.toolCallId) &&
    isOneOf(value.verificationMethod, VERIFICATION_METHODS) &&
    (value.verificationMethod !== "direct_fetch" ||
      (isNonEmptyString(value.excerpt) && value.claim === value.excerpt)) &&
    isOneOf(value.temporalStatus, TEMPORAL_STATUSES) &&
    isScore(value.reliability) &&
    typeof value.spoofable === "boolean" &&
    isJsonObject(value.attributes) &&
    isNonEmptyString(value.fingerprint) &&
    isNonEmptyString(value.createdAt) &&
    isJsonValue(value)
  );
}

export function parseEvidenceRecord(value: unknown): EvidenceRecord {
  if (!isEvidenceRecord(value)) {
    throwIssues("EvidenceRecord", [{ path: "$", message: "invalid evidence schema" }]);
  }
  return value;
}

export function isFinding(value: unknown): value is Finding {
  return (
    isVersioned(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.candidateId) &&
    isNonEmptyString(value.title) &&
    isNonEmptyString(value.description) &&
    isOneOf(value.category, FINDING_CATEGORIES) &&
    isStringArray(value.evidenceIds, true) &&
    isStringArray(value.counterEvidenceIds, true) &&
    isConfidenceAssessment(value.confidence) &&
    isStringArray(value.caveats) &&
    isNonEmptyString(value.createdAt) &&
    isJsonValue(value)
  );
}

export function parseFinding(value: unknown): Finding {
  if (!isFinding(value)) {
    throwIssues("Finding", [{ path: "$", message: "invalid finding schema" }]);
  }
  return value;
}

function isBudgetUsage(value: unknown): boolean {
  if (!isRecord(value) || !isPhaseCounterRecord(value.phaseTurns)) return false;
  const keys = [
    "turns",
    "llmCalls",
    "toolCalls",
    "searchCalls",
    "evidenceAttempts",
    "networkRequests",
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "thinkingTokens",
    "costUsd",
    "elapsedMs",
    "consecutiveNoProgress",
  ];
  return (
    keys.every((key) => isFiniteNonNegative(value[key])) &&
    [
      "turns",
      "llmCalls",
      "toolCalls",
      "searchCalls",
      "evidenceAttempts",
      "networkRequests",
      "inputTokens",
      "cachedInputTokens",
      "outputTokens",
      "thinkingTokens",
      "elapsedMs",
      "consecutiveNoProgress",
    ].every((key) => isNonNegativeInteger(value[key]))
  );
}

function isNullableNonEmptyString(value: unknown): boolean {
  return value === null || isNonEmptyString(value);
}

function isSourceTier(value: unknown): boolean {
  return typeof value === "number" && SOURCE_TIERS.includes(value as (typeof SOURCE_TIERS)[number]);
}

function isSearchGraphNode(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.schemaVersion === SEARCH_GRAPH_SCHEMA_VERSION &&
    isNonEmptyString(value.id) &&
    isOneOf(value.kind, SEARCH_GRAPH_NODE_KINDS) &&
    isNonEmptyString(value.label) &&
    isOneOf(value.status, SEARCH_GRAPH_NODE_STATUSES) &&
    (value.sourceTier === null || isSourceTier(value.sourceTier)) &&
    isNullableNonEmptyString(value.sourceLaneId) &&
    isNullableNonEmptyString(value.frontierEntryId) &&
    isNullableNonEmptyString(value.actionId) &&
    isNullableNonEmptyString(value.candidateId) &&
    isNullableNonEmptyString(value.evidenceId) &&
    isNullableNonEmptyString(value.findingId) &&
    isNonNegativeInteger(value.ordinal) &&
    isRecord(value.data) &&
    isJsonValue(value.data) &&
    isNonEmptyString(value.createdAt) &&
    isNonEmptyString(value.updatedAt)
  );
}

function isSearchGraphEdge(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.schemaVersion === SEARCH_GRAPH_SCHEMA_VERSION &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.fromNodeId) &&
    isNonEmptyString(value.toNodeId) &&
    isOneOf(value.kind, SEARCH_GRAPH_EDGE_KINDS) &&
    isOneOf(value.status, SEARCH_GRAPH_NODE_STATUSES) &&
    isNullableNonEmptyString(value.frontierEntryId) &&
    isNullableNonEmptyString(value.actionId) &&
    typeof value.edgeCost === "number" &&
    Number.isFinite(value.edgeCost) &&
    value.edgeCost > 0 &&
    typeof value.pathCost === "number" &&
    Number.isFinite(value.pathCost) &&
    value.pathCost > 0 &&
    isNonNegativeInteger(value.ordinal) &&
    isNonEmptyString(value.createdAt)
  );
}

function isSearchUtility(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return [
    "relevance",
    "novelty",
    "informationGain",
    "sourceTrust",
    "executionCost",
    "policyRisk",
    "repetition",
    "depthPenalty",
  ].every((key) => isScore(value[key]));
}

function isFrontierMutation(value: unknown): boolean {
  return (
    isRecord(value) &&
    isOneOf(value.strategy, SEARCH_GRAPH_MUTATION_STRATEGIES) &&
    isNonEmptyString(value.parentFrontierEntryId) &&
    isNonNegativeInteger(value.proposalIndex) &&
    typeof value.temperature === "number" &&
    Number.isFinite(value.temperature) &&
    value.temperature > 0 &&
    typeof value.logAcceptanceRatio === "number" &&
    Number.isFinite(value.logAcceptanceRatio) &&
    isScore(value.acceptanceProbability) &&
    isScore(value.deterministicU) &&
    isNonNegativeInteger(value.parentNeighborCount) &&
    value.parentNeighborCount > 0 &&
    isNonNegativeInteger(value.candidateNeighborCount) &&
    value.candidateNeighborCount > 0
  );
}

function isSearchFrontierEntry(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.schemaVersion === SEARCH_GRAPH_SCHEMA_VERSION &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.frontierEntryId) &&
    isNonEmptyString(value.actionId) &&
    isNonEmptyString(value.nodeId) &&
    isNonEmptyString(value.parentNodeId) &&
    isNullableNonEmptyString(value.parentFrontierEntryId) &&
    isOneOf(value.status, SEARCH_GRAPH_NODE_STATUSES) &&
    isSourceTier(value.sourceTier) &&
    isNonEmptyString(value.sourceLaneId) &&
    isStringArray(value.allowedTools, true) &&
    value.allowedTools.length > 0 &&
    isNonEmptyString(value.intent) &&
    isNonEmptyString(value.queryHint) &&
    (value.leadId === undefined || isNonEmptyString(value.leadId)) &&
    isNullableNonEmptyString(value.candidateId) &&
    isNonNegativeInteger(value.depth) &&
    isNonNegativeInteger(value.ordinal) &&
    isNonEmptyString(value.dedupeKey) &&
    isSearchUtility(value.utility) &&
    typeof value.edgeCost === "number" &&
    Number.isFinite(value.edgeCost) &&
    value.edgeCost > 0 &&
    typeof value.pathCost === "number" &&
    Number.isFinite(value.pathCost) &&
    value.pathCost > 0 &&
    (value.mutation === null || isFrontierMutation(value.mutation)) &&
    isNonEmptyString(value.createdAt) &&
    isNonEmptyString(value.updatedAt)
  );
}

function isSearchGraphTelemetry(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return [
    "seeded",
    "enqueued",
    "selected",
    "pruned",
    "expanded",
    "exhausted",
    "toolCalls",
    "mutationToolCalls",
    "mutationsProposed",
    "mutationsAccepted",
    "mutationsRejected",
  ].every((key) => isNonNegativeInteger(value[key]));
}

function graphStatusMatchesInvestigationStatus(status: unknown, graphStatus: unknown): boolean {
  if (status === "running") return graphStatus === "empty" || graphStatus === "active";
  if (status === "completed") return graphStatus === "completed";
  if (status === "blocked") return graphStatus === "blocked";
  if (status === "canceled") return graphStatus === "canceled";
  if (status === "failed" || status === "configuration_error") return graphStatus === "failed";
  if (status === "partial" || status === "ambiguous") return graphStatus === "exhausted";
  return false;
}

export function isSearchGraph(value: unknown): value is SearchGraph {
  if (
    !isRecord(value) ||
    value.schemaVersion !== SEARCH_GRAPH_SCHEMA_VERSION ||
    !isNonEmptyString(value.runId) ||
    !isOneOf(value.status, SEARCH_GRAPH_RUN_STATUSES) ||
    typeof value.seed !== "string" ||
    !isNullableNonEmptyString(value.seedNodeId) ||
    !Array.isArray(value.nodes) ||
    !value.nodes.every(isSearchGraphNode) ||
    !Array.isArray(value.edges) ||
    !value.edges.every(isSearchGraphEdge) ||
    !Array.isArray(value.frontier) ||
    !value.frontier.every(isSearchFrontierEntry) ||
    !isStringArray(value.selectedFrontierEntryIds) ||
    !(value.currentSourceTier === null || isSourceTier(value.currentSourceTier)) ||
    !isNonNegativeInteger(value.nextOrdinal) ||
    !isNonNegativeInteger(value.mutationStep) ||
    !isSearchGraphTelemetry(value.telemetry) ||
    !isNonEmptyString(value.createdAt) ||
    !isNonEmptyString(value.updatedAt) ||
    !isJsonValue(value)
  )
    return false;
  try {
    return validateSearchGraph(value as unknown as SearchGraph).length === 0;
  } catch {
    return false;
  }
}

export function isInvestigationState(value: unknown): value is InvestigationState {
  return (
    isVersioned(value) &&
    isNonEmptyString(value.runId) &&
    isNonNegativeInteger(value.revision) &&
    isOneOf(value.status, INVESTIGATION_STATUSES) &&
    isOneOf(value.phase, RESEARCH_PHASES) &&
    isInvestigationInput(value.input) &&
    isParsedTarget(value.target) &&
    isSafetyDecision(value.safety) &&
    Array.isArray(value.candidates) &&
    value.candidates.every(isCandidate) &&
    Array.isArray(value.evidence) &&
    value.evidence.every(isEvidenceRecord) &&
    Array.isArray(value.findings) &&
    value.findings.every(isFinding) &&
    isSearchGraph(value.searchGraph) &&
    value.searchGraph.runId === value.runId &&
    graphStatusMatchesInvestigationStatus(value.status, value.searchGraph.status) &&
    isStringArray(value.openQuestions) &&
    isEvidenceTelemetry(value.evidenceTelemetry) &&
    isRecord(value.budget) &&
    isBudgetLimits(value.budget.limits) &&
    isBudgetUsage(value.budget.usage) &&
    (value.stop === undefined || isInvestigationStop(value.stop)) &&
    isNonEmptyString(value.startedAt) &&
    isNonEmptyString(value.updatedAt) &&
    isJsonValue(value)
  );
}

export function parseInvestigationState(value: unknown): InvestigationState {
  if (!isInvestigationState(value)) {
    throwIssues("InvestigationState", [{ path: "$", message: "invalid or unsupported investigation state" }]);
  }
  return value;
}

function isIdentityResolution(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    !isOneOf(value.status, ["resolved", "ambiguous", "unresolved"]) ||
    !(value.selectedCandidate === null || isCandidate(value.selectedCandidate)) ||
    !(value.runnerUpCandidate === null || isCandidate(value.runnerUpCandidate)) ||
    !isScore(value.selectedScore) ||
    !isScore(value.runnerUpScore) ||
    !isFiniteNonNegative(value.runnerUpMargin) ||
    !isScore(value.resolutionThreshold) ||
    !isScore(value.marginThreshold)
  ) {
    return false;
  }

  const selected = value.selectedCandidate;
  const runnerUp = value.runnerUpCandidate;
  if (selected === null) {
    if (value.selectedCandidateId !== undefined || value.selectedScore !== 0) return false;
  } else if (value.selectedCandidateId !== selected.id || value.selectedScore !== selected.score.total) {
    return false;
  }
  if (runnerUp === null) {
    if (value.runnerUpCandidateId !== undefined || value.runnerUpScore !== 0) return false;
  } else if (value.runnerUpCandidateId !== runnerUp.id || value.runnerUpScore !== runnerUp.score.total) {
    return false;
  }
  return value.runnerUpMargin === roundScore(value.selectedScore - value.runnerUpScore);
}

function isCoverageSummary(value: unknown): boolean {
  return (
    isRecord(value) &&
    isScore(value.score) &&
    Array.isArray(value.requestedCategories) &&
    value.requestedCategories.every((entry) => isOneOf(entry, FINDING_CATEGORIES)) &&
    Array.isArray(value.coveredCategories) &&
    value.coveredCategories.every((entry) => isOneOf(entry, FINDING_CATEGORIES)) &&
    Array.isArray(value.missingCategories) &&
    value.missingCategories.every((entry) => isOneOf(entry, FINDING_CATEGORIES)) &&
    isNonNegativeInteger(value.supportedFindingCount) &&
    isNonNegativeInteger(value.highConfidenceFindingCount) &&
    isNonNegativeInteger(value.independentSourceFamilyCount) &&
    isStringArray(value.gaps)
  );
}

function isSourceSummary(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value.sourceFamily) &&
    Array.isArray(value.sourceTypes) &&
    value.sourceTypes.every((entry) => isOneOf(entry, EVIDENCE_SOURCE_TYPES)) &&
    isNonNegativeInteger(value.evidenceCount) &&
    isNonNegativeInteger(value.supportingCount) &&
    isNonNegativeInteger(value.contradictingCount) &&
    isNonNegativeInteger(value.discoveryOnlyCount) &&
    isStringArray(value.urls, true)
  );
}

function isReportTelemetry(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonNegativeInteger(value.candidateCount) &&
    isNonNegativeInteger(value.resolvedCandidateCount) &&
    isEvidenceTelemetry(value.evidence) &&
    isNonNegativeInteger(value.findingCount) &&
    isNonNegativeInteger(value.highConfidenceFindingCount)
  );
}

export function isInvestigationReport(value: unknown): value is InvestigationReport {
  return (
    isVersioned(value) &&
    isNonEmptyString(value.runId) &&
    isInvestigationInput(value.input) &&
    isParsedTarget(value.target) &&
    isOneOf(value.status, TERMINAL_STATUSES) &&
    isIdentityResolution(value.identity) &&
    Array.isArray(value.candidates) &&
    value.candidates.every(isCandidate) &&
    Array.isArray(value.evidence) &&
    value.evidence.every(isEvidenceRecord) &&
    Array.isArray(value.findings) &&
    value.findings.every(isFinding) &&
    isSearchGraph(value.searchGraph) &&
    value.searchGraph.runId === value.runId &&
    graphStatusMatchesInvestigationStatus(value.status, value.searchGraph.status) &&
    isCoverageSummary(value.coverage) &&
    Array.isArray(value.sources) &&
    value.sources.every(isSourceSummary) &&
    isReportTelemetry(value.telemetry) &&
    isBudgetUsage(value.usage) &&
    isStringArray(value.limitations) &&
    isInvestigationStop(value.stop) &&
    isNonEmptyString(value.generatedAt) &&
    isJsonValue(value)
  );
}

export function parseInvestigationReport(value: unknown): InvestigationReport {
  if (!isInvestigationReport(value)) {
    throwIssues("InvestigationReport", [{ path: "$", message: "invalid or unsupported investigation report" }]);
  }
  return value;
}

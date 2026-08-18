/**
 * JSON-safe domain contracts shared by the live API, replay tooling, and UI.
 *
 * These types deliberately contain no framework or runtime-specific values:
 * no Dates, Maps, Errors, class instances, functions, or streams cross the
 * domain boundary.
 */

export const SCHEMA_VERSION = 1 as const;

export type SchemaVersion = typeof SCHEMA_VERSION;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type ResearchDepth = "quick" | "standard" | "deep";

export interface InvestigationInputV1 {
  schemaVersion: SchemaVersion;
  query: string;
  objective?: string;
  requestedDepth?: ResearchDepth;
  /** Applicable report categories; omitted inputs use the versioned default policy. */
  requestedCategories?: FindingCategory[];
  locale?: string;
}

export type InvestigationInput = InvestigationInputV1;

export type TargetKind = "email" | "named_person" | "role_query" | "unknown";

export type IdentifierKind =
  | "email"
  | "profile_url"
  | "personal_domain"
  | "social_handle"
  | "github_commit_email"
  | "keybase_proof"
  | "other";

export type IdentifierAssurance =
  | "verified"
  | "corroborated"
  | "self_asserted"
  | "spoofable";

export interface TargetIdentifier {
  kind: IdentifierKind;
  value: string;
  normalizedValue: string;
  assurance: IdentifierAssurance;
  provenance: "user_input" | "public_source";
}

export interface OrganizationHint {
  name: string;
  normalizedName: string;
  relationship: "current" | "former" | "unspecified";
}

export interface ParsedTargetV1 {
  schemaVersion: SchemaVersion;
  rawInput: string;
  normalizedQuery: string;
  kind: TargetKind;
  name?: string;
  normalizedName?: string;
  roleHints: string[];
  organizationHints: OrganizationHint[];
  locationHints: string[];
  identifiers: TargetIdentifier[];
}

export type ParsedTarget = ParsedTargetV1;

export type SafetyLevel = "allow" | "caution" | "block";

export type SafetyReasonCode =
  | "public_professional_research"
  | "exact_identifier_supplied"
  | "sensitive_personal_data"
  | "precise_location_or_contact"
  | "credential_or_financial_data"
  | "targeting_or_harassment"
  | "family_or_relationship_mapping"
  | "contact_automation"
  | "high_impact_decision"
  | "minor_or_vulnerable_person"
  | "illegal_or_violent_intent";

export interface SafetyReason {
  code: SafetyReasonCode;
  message: string;
  matchedTerms: string[];
}

export interface SafetyDecisionV1 {
  schemaVersion: SchemaVersion;
  level: SafetyLevel;
  permittedScope: "public_professional_only" | "none";
  reasons: SafetyReason[];
  redactions: string[];
}

export type SafetyDecision = SafetyDecisionV1;

export type CandidateStatus = "separate" | "plausible" | "resolved" | "rejected";
export type SignalStrength = "weak" | "medium" | "strong";

export type IdentitySignalKind =
  | "name"
  | "email"
  | "organization"
  | "role"
  | "location"
  | "profile_url"
  | "personal_domain"
  | "social_handle"
  | "github_commit_email"
  | "keybase_proof"
  | "cross_profile_link"
  | "cross_source_match"
  | "bio_phrase"
  | "conflict";

export interface IdentitySignal {
  kind: IdentitySignalKind;
  value: string;
  normalizedValue: string;
  strength: SignalStrength;
  assurance: IdentifierAssurance;
  sourceEvidenceId?: string;
  sourceFamily?: string;
}

export interface CandidateScoreBreakdown {
  total: number;
  positive: number;
  penalty: number;
  independentFamilies: string[];
  matchedSignals: IdentitySignalKind[];
  conflictingSignals: IdentitySignalKind[];
  cappedBecauseSpoofable: boolean;
}

export interface CandidateV1 {
  schemaVersion: SchemaVersion;
  id: string;
  displayName: string;
  normalizedName: string;
  status: CandidateStatus;
  signals: IdentitySignal[];
  evidenceIds: string[];
  score: CandidateScoreBreakdown;
  createdAt: string;
  updatedAt: string;
}

export type Candidate = CandidateV1;

export interface CandidateDraft {
  /** Optional tool-local reference used to link evidence from the same result. */
  ref?: string;
  displayName: string;
  signals?: IdentitySignal[];
}

export type EvidenceSourceType =
  | "official_profile"
  | "company_page"
  | "professional_profile"
  | "code_profile"
  | "code_commit"
  | "keybase_proof"
  | "news"
  | "web_archive"
  | "search_result"
  | "public_document"
  | "other";

export type EvidenceDisposition = "supports" | "contradicts" | "discovery_only";

export type VerificationMethod =
  | "direct_fetch"
  | "api_response"
  | "cryptographic_proof"
  | "cross_source_corroboration"
  | "archive_snapshot"
  | "search_discovery"
  | "unverified";

export type TemporalStatus = "current" | "historical" | "undated" | "unknown";

export interface EvidenceDraft {
  candidateId?: string;
  candidateRef?: string;
  claim: string;
  disposition?: EvidenceDisposition;
  sourceUrl: string;
  queryUrl?: string | null;
  sourceType: EvidenceSourceType;
  sourceFamily?: string;
  title?: string | null;
  publisher?: string | null;
  publishedAt?: string | null;
  observedAt?: string | null;
  httpStatus?: number | null;
  contentHash?: string | null;
  excerpt?: string;
  canonicalSubset?: JsonObject | null;
  toolCallId?: string | null;
  verificationMethod?: VerificationMethod;
  temporalStatus?: TemporalStatus;
  reliability?: number;
  spoofable?: boolean;
  attributes?: JsonObject;
}

export interface EvidenceRecordV1 {
  schemaVersion: SchemaVersion;
  id: string;
  candidateId: string;
  claim: string;
  normalizedClaim: string;
  disposition: EvidenceDisposition;
  sourceUrl: string;
  canonicalUrl: string;
  queryUrl: string | null;
  title: string | null;
  publisher: string | null;
  sourceFamily: string;
  sourceType: EvidenceSourceType;
  publishedAt: string | null;
  retrievedAt: string;
  observedAt: string | null;
  httpStatus: number | null;
  contentHash: string | null;
  excerpt: string | null;
  canonicalSubset: JsonObject | null;
  toolCallId: string | null;
  verificationMethod: VerificationMethod;
  temporalStatus: TemporalStatus;
  reliability: number;
  spoofable: boolean;
  attributes: JsonObject;
  fingerprint: string;
  createdAt: string;
}

export type EvidenceRecord = EvidenceRecordV1;

export type EvidenceAdmissionReason =
  | "admitted"
  | "duplicate_url"
  | "duplicate_source_family"
  | "unknown_candidate"
  | "invalid_url"
  | "unsafe_url"
  | "missing_claim"
  | "missing_canonical_content"
  | "sensitive_content"
  | "budget_exhausted"
  | "discovery_only_source";

export interface EvidenceAdmission {
  admitted: boolean;
  reason: EvidenceAdmissionReason;
  evidence?: EvidenceRecord;
  duplicateOf?: string;
}

export type FindingCategory =
  | "identity"
  | "employment"
  | "education"
  | "project"
  | "publication"
  | "online_presence"
  | "timeline"
  | "other";

export type ConfidenceLabel = "low" | "moderate" | "high" | "very_high";

export interface ConfidenceAssessment {
  score: number;
  label: ConfidenceLabel;
  independentSourceFamilies: string[];
  supportingEvidenceIds: string[];
  contradictingEvidenceIds: string[];
  appliedCaps: string[];
}

export interface FindingDraft {
  candidateId: string;
  title: string;
  description: string;
  category: FindingCategory;
  evidenceIds: string[];
  counterEvidenceIds?: string[];
  caveats?: string[];
}

export interface FindingV1 {
  schemaVersion: SchemaVersion;
  id: string;
  candidateId: string;
  title: string;
  description: string;
  category: FindingCategory;
  evidenceIds: string[];
  counterEvidenceIds: string[];
  confidence: ConfidenceAssessment;
  caveats: string[];
  createdAt: string;
}

export type Finding = FindingV1;

export type ResearchPhase =
  | "intake"
  | "classify"
  | "plan"
  | "discover"
  | "separate_candidates"
  | "corroborate"
  | "calibrate"
  | "report"
  | "terminal";

export type TerminalStatus =
  | "completed"
  | "partial"
  | "ambiguous"
  | "blocked"
  | "configuration_error"
  | "canceled"
  | "failed";

export type InvestigationStatus = "running" | TerminalStatus;

export interface BudgetLimits {
  maxTurns: number;
  maxLlmCalls: number;
  maxToolCalls: number;
  maxSearchCalls: number;
  maxEvidenceAttempts: number;
  maxNetworkRequests: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxThinkingTokens: number;
  maxCostUsd: number;
  maxDurationMs: number;
  maxConsecutiveNoProgress: number;
  maxActionsPerTurn: number;
  phaseCaps: Partial<Record<ResearchPhase, number>>;
}

export interface BudgetUsage {
  turns: number;
  llmCalls: number;
  toolCalls: number;
  searchCalls: number;
  evidenceAttempts: number;
  networkRequests: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  costUsd: number;
  elapsedMs: number;
  consecutiveNoProgress: number;
  phaseTurns: Partial<Record<ResearchPhase, number>>;
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  costUsd?: number;
}

export type StopReason =
  | "goal_satisfied"
  | "budget_exhausted"
  | "diminishing_returns"
  | "unsafe_request"
  | "no_legal_actions"
  | "planner_requested"
  | "cancelled"
  | "configuration_error"
  | "fatal_error";

export interface StopDecision {
  allowed: boolean;
  reason?: StopReason;
  detail: string;
  exhaustedDimensions: string[];
}

export interface InvestigationStop {
  reason: StopReason;
  detail: string;
  at: string;
}

export interface InvestigationStateV1 {
  schemaVersion: SchemaVersion;
  runId: string;
  revision: number;
  status: InvestigationStatus;
  phase: ResearchPhase;
  input: InvestigationInput;
  target: ParsedTarget;
  safety: SafetyDecision;
  candidates: Candidate[];
  evidence: EvidenceRecord[];
  findings: Finding[];
  openQuestions: string[];
  evidenceTelemetry: EvidenceTelemetry;
  budget: {
    limits: BudgetLimits;
    usage: BudgetUsage;
  };
  stop?: InvestigationStop;
  startedAt: string;
  updatedAt: string;
}

export type InvestigationState = InvestigationStateV1;

export interface IdentityResolution {
  status: "resolved" | "ambiguous" | "unresolved";
  selectedCandidate: Candidate | null;
  runnerUpCandidate: Candidate | null;
  selectedCandidateId?: string;
  runnerUpCandidateId?: string;
  selectedScore: number;
  runnerUpScore: number;
  runnerUpMargin: number;
  resolutionThreshold: number;
  marginThreshold: number;
}

export interface CoverageSummary {
  score: number;
  requestedCategories: FindingCategory[];
  coveredCategories: FindingCategory[];
  missingCategories: FindingCategory[];
  supportedFindingCount: number;
  highConfidenceFindingCount: number;
  independentSourceFamilyCount: number;
  gaps: string[];
}

export interface SourceSummary {
  sourceFamily: string;
  sourceTypes: EvidenceSourceType[];
  evidenceCount: number;
  supportingCount: number;
  contradictingCount: number;
  discoveryOnlyCount: number;
  urls: string[];
}

export interface EvidenceTelemetry {
  admitted: number;
  rejected: number;
  duplicate: number;
  discoveryOnly: number;
  supporting: number;
  contradicting: number;
}

export interface ReportTelemetry {
  candidateCount: number;
  resolvedCandidateCount: number;
  evidence: EvidenceTelemetry;
  findingCount: number;
  highConfidenceFindingCount: number;
}

export interface InvestigationReportV1 {
  schemaVersion: SchemaVersion;
  runId: string;
  input: InvestigationInput;
  target: ParsedTarget;
  status: TerminalStatus;
  identity: IdentityResolution;
  candidates: Candidate[];
  findings: Finding[];
  evidence: EvidenceRecord[];
  coverage: CoverageSummary;
  sources: SourceSummary[];
  telemetry: ReportTelemetry;
  usage: BudgetUsage;
  limitations: string[];
  stop: InvestigationStop;
  generatedAt: string;
}

export type InvestigationReport = InvestigationReportV1;

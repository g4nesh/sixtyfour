import type {
  CandidateStatus,
  ConfidenceLabel,
  EvidenceDisposition,
  EvidenceSourceType,
  FindingCategory,
  IdentifierKind,
  InvestigationStatus,
  SearchGraph,
  StopReason,
  TargetKind,
  TemporalStatus,
  VerificationMethod,
} from "../domain/types";

export type CanonicalSearchGraphInput = SearchGraph;

export interface ReportViewModel {
  schemaVersion: 1;
  classification: "PUBLIC-SOURCE INTELLIGENCE";
  title: string;
  subject: string;
  run: ReportRunView;
  executiveSummary: string;
  identity: ReportIdentityView;
  findings: ReportFindingView[];
  evidence: ReportEvidenceView[];
  searchStrategy: ReportSearchStrategyView;
  coverage: ReportCoverageView;
  limitations: string[];
  execution: ReportExecutionView;
  methodology: ReportMethodologyView;
}

export interface ReportRunView {
  id: string;
  query: string;
  objective: string | null;
  depth: "quick" | "standard" | "deep" | "unspecified";
  requestedCategories: FindingCategory[];
  targetKind: TargetKind;
  explicitIdentifierKinds: IdentifierKind[];
  scope: "Public professional sources only";
  status: InvestigationStatus;
  generatedAt: string;
  stopReason: StopReason;
  stopDetail: string;
}

export interface ReportCandidateView {
  id: string;
  name: string;
  status: CandidateStatus;
  score: number;
  matchedSignals: string[];
  conflictingSignals: string[];
  independentSourceFamilies: string[];
  evidenceRefs: string[];
  findingIds: string[];
  sourceDomains: string[];
  directSourceCount: number;
}

export interface ReportIdentityView {
  status: "resolved" | "ambiguous" | "unresolved";
  selected: ReportCandidateView | null;
  /** At most five highest-ranked, separately retained candidate dossiers. */
  profiles: ReportCandidateView[];
  alternatives: ReportCandidateView[];
  retainedCandidateCount: number;
  runnerUpMargin: number;
  resolutionThreshold: number;
  marginThreshold: number;
  rationale: string;
}

export interface ReportCitedSource {
  ref: string;
  url: string;
  title: string | null;
  domain: string;
}

export interface ReportFindingView {
  id: string;
  candidateId: string;
  candidateName: string;
  title: string;
  description: string;
  category: FindingCategory;
  confidenceScore: number;
  confidenceLabel: ConfidenceLabel;
  citations: string[];
  counterCitations: string[];
  /** Resolved cited sources (real public URLs) backing this finding. */
  sources: ReportCitedSource[];
  caveats: string[];
}

export type EvidenceContentLabel =
  | "Exact source excerpt"
  | "Normalized archived text"
  | "Structured API claim"
  | "Admitted source claim"
  | "Passive page metadata observation"
  | "Unverified discovery lead";

export type ReportTemporalMetadataField =
  "title" | "description" | "canonicalUrl" | "language" | "publishedAt" | "modifiedAt";

export interface ReportTemporalComparisonView {
  observedAfter: string;
  observedOnOrBefore: string;
  bodyChanged: boolean;
  visibleTextChanged: boolean;
  metadataChanged: boolean;
  structureChanged: boolean;
  changedMetadataFields: ReportTemporalMetadataField[];
  addedTextFragments: string[];
  removedTextFragments: string[];
  addedFragmentCount: number;
  removedFragmentCount: number;
  unchangedFragmentCount: number;
  comparisonBounded: boolean;
  caveat: string;
}

export type ReportPageProviderFamily =
  | "amazon-cloudfront"
  | "amazon-web-services"
  | "apple-hosted-assets"
  | "cloudflare"
  | "fastly"
  | "github"
  | "google-hosted-assets"
  | "jsdelivr"
  | "microsoft-azure"
  | "netlify"
  | "unpkg"
  | "vercel";

export type ReportPageCanonicalStatus = "not_declared" | "accepted_same_page" | "discarded";

export interface ReportPageFootprintView {
  footprintHash: string;
  title: string | null;
  description: string | null;
  canonicalUrl: string | null;
  canonicalStatus: ReportPageCanonicalStatus | null;
  language: string | null;
  openGraphType: string | null;
  openGraphSiteName: string | null;
  generators: string[];
  applicationNames: string[];
  observedProviderFamilies: ReportPageProviderFamily[];
  observedResourceHosts: string[];
  jsonLdTypes: string[];
  bounded: boolean;
  caveat: string;
}

export interface ReportEvidenceView {
  ref: string;
  id: string;
  candidateId: string;
  claim: string;
  contentLabel: EvidenceContentLabel;
  exactExcerpt: string | null;
  disposition: EvidenceDisposition;
  sourceUrl: string;
  title: string | null;
  publisher: string | null;
  sourceFamily: string;
  sourceType: EvidenceSourceType;
  sourceTier: number;
  sourceTierLabel: string;
  verificationMethod: VerificationMethod;
  temporalStatus: TemporalStatus;
  observedAt: string | null;
  retrievedAt: string;
  contentHash: string | null;
  reliability: number;
  spoofable: boolean;
  temporalComparison: ReportTemporalComparisonView | null;
  pageFootprint: ReportPageFootprintView | null;
}

export interface ReportGraphCount {
  label: string;
  count: number;
}

export interface ReportSourceTierView {
  tier: number;
  label: string;
  evidenceCount: number;
  frontierCount: number;
  verifiedCount: number;
  rejectedCount: number;
  exhaustedCount: number;
  sourceFamilies: string[];
}

export interface ReportPathView {
  id: string;
  disposition: "accepted" | "rejected" | "exhausted" | "mutation_accepted" | "mutation_rejected";
  path: string[];
  cost: number | null;
}

export interface ReportSearchStrategyView {
  algorithm: "Deterministic best-first frontier with bounded seeded mutation";
  graphAvailable: boolean;
  nodeCount: number;
  edgeCount: number;
  nodeStatusCounts: ReportGraphCount[];
  frontierCounts: ReportGraphCount[];
  sourceLadder: ReportSourceTierView[];
  paths: ReportPathView[];
  mutation: {
    proposed: number;
    accepted: number;
    rejected: number;
  };
  narrative: string;
}

export interface ReportCoverageView {
  score: number;
  requestedCategories: FindingCategory[];
  coveredCategories: FindingCategory[];
  missingCategories: FindingCategory[];
  independentSourceFamilyCount: number;
  gaps: string[];
}

export interface ReportMetricView {
  label: string;
  value: string;
}

export interface ReportExecutionView {
  usage: ReportMetricView[];
  phaseTurns: ReportMetricView[];
  elapsedMs: number;
  stopReason: StopReason;
  stopDetail: string;
}

export interface ReportMethodologyView {
  evidenceStandard: string;
  confidenceStandard: string;
  graphStandard: string;
  safetyNote: string;
}

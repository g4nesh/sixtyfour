import type { Clock } from "./runtime";
import { clamp, roundScore } from "./runtime";
import type {
  Candidate,
  CoverageSummary,
  EvidenceRecord,
  FindingCategory,
  IdentityResolution,
  InvestigationReport,
  InvestigationState,
  JsonValue,
  ReportTelemetry,
  SourceSummary,
} from "./types";
import { SCHEMA_VERSION } from "./types";
import { containsRestrictedPublicContent, restrictedJsonContentPaths } from "./content-policy";
import { assessCandidateContextCorroboration, type CandidateContextCorroboration } from "./candidates";

export const IDENTITY_RESOLUTION_THRESHOLD = 0.78;
export const IDENTITY_MARGIN_THRESHOLD = 0.15;
// A single unique, non-spoofable, high-reliability official anchor can resolve
// identity below the diversity-driven score threshold, mirroring the completion
// policy's `hasUniqueOfficialAnchor` gate. The floor keeps a merely-plausible
// candidate from resolving on a weak anchor.
export const UNIQUE_ANCHOR_RESOLUTION_FLOOR = 0.5;

const UNIQUE_ANCHOR_SOURCE_TYPES = new Set(["official_profile", "company_page"]);
const UNIQUE_ANCHOR_SIGNAL_KINDS = new Set([
  "email",
  "profile_url",
  "personal_domain",
  "keybase_proof",
  "cross_profile_link",
]);

/**
 * True when the candidate is anchored by at least one supporting, non-spoofable
 * official first-party record of high reliability that grounds a strong,
 * verified/corroborated merge-grade identity signal. This is the same anchor
 * quality the completion policy accepts in place of two independent families.
 */
export function candidateHasUniqueOfficialAnchor(candidate: Candidate, evidence: readonly EvidenceRecord[]): boolean {
  if (candidate.score.conflictingSignals.length > 0) return false;
  return evidence.some(
    (record) =>
      record.candidateId === candidate.id &&
      record.disposition === "supports" &&
      UNIQUE_ANCHOR_SOURCE_TYPES.has(record.sourceType) &&
      !record.spoofable &&
      record.reliability >= 0.8 &&
      candidate.signals.some(
        (signal) =>
          signal.sourceEvidenceId === record.id &&
          UNIQUE_ANCHOR_SIGNAL_KINDS.has(signal.kind) &&
          signal.strength === "strong" &&
          (signal.assurance === "verified" || signal.assurance === "corroborated"),
      ),
  );
}

export const DEFAULT_REQUESTED_CATEGORIES: FindingCategory[] = ["identity", "employment", "online_presence"];

export function requestedCategoriesForInput(
  input: Pick<InvestigationState["input"], "requestedCategories">,
): FindingCategory[] {
  return [...new Set(input.requestedCategories ?? DEFAULT_REQUESTED_CATEGORIES)].sort();
}

export function resolveIdentity(
  candidates: readonly Candidate[],
  evidence: readonly EvidenceRecord[] = [],
  target?: InvestigationState["target"],
): IdentityResolution {
  const contextualAssessments = new Map<string, CandidateContextCorroboration>();
  if (target) {
    for (const candidate of candidates) {
      const assessment = assessCandidateContextCorroboration(candidate, evidence, target);
      if (assessment) contextualAssessments.set(candidate.id, assessment);
    }
  }
  const resolutionScore = (candidate: Candidate): number =>
    Math.max(candidate.score.total, contextualAssessments.get(candidate.id)?.score ?? 0);
  const ranked = [...candidates].sort(
    (left, right) => resolutionScore(right) - resolutionScore(left) || left.id.localeCompare(right.id),
  );
  const eligible = ranked.filter((candidate) => candidate.status !== "rejected");
  const selected = eligible[0];
  // A rejected/quarantined same-name candidate must remain visible as the
  // comparison point. Excluding it would manufacture a margin against zero
  // precisely where the report is meant to demonstrate disambiguation.
  const runnerUp = selected ? ranked.find((candidate) => candidate.id !== selected.id) : undefined;
  const selectedScore = selected?.score.total ?? 0;
  const runnerUpScore = runnerUp?.score.total ?? 0;
  const runnerUpMargin = roundScore(selectedScore - runnerUpScore);
  const selectedResolutionScore = selected ? resolutionScore(selected) : 0;
  const runnerUpResolutionScore = runnerUp ? resolutionScore(runnerUp) : 0;
  const resolutionMargin = roundScore(selectedResolutionScore - runnerUpResolutionScore);
  const resolvedByDiversity = selected?.status === "resolved" && selected.score.total >= IDENTITY_RESOLUTION_THRESHOLD;
  // A unique official anchor substitutes for family diversity: it resolves a
  // clearly-leading candidate whose score sits below the diversity threshold
  // because its corroboration comes from one authoritative source rather than
  // many. Candidate separation is still enforced by the margin requirement.
  const resolvedByAnchor =
    Boolean(selected) &&
    selected!.status !== "rejected" &&
    selected!.score.total >= UNIQUE_ANCHOR_RESOLUTION_FLOOR &&
    candidateHasUniqueOfficialAnchor(selected!, evidence);
  const selectedContextAssessment = selected ? contextualAssessments.get(selected.id) : undefined;
  const resolvedByContext = Boolean(
    selectedContextAssessment?.decision === "resolved_eligible" &&
    selectedContextAssessment.score >= IDENTITY_RESOLUTION_THRESHOLD,
  );
  const resolved =
    Boolean(selected) &&
    (resolvedByDiversity || resolvedByAnchor || resolvedByContext) &&
    resolutionMargin >= IDENTITY_MARGIN_THRESHOLD;
  const ambiguous =
    !resolved &&
    Boolean(selected) &&
    (selectedResolutionScore >= 0.38 || runnerUpResolutionScore >= 0.38) &&
    Boolean(runnerUp) &&
    runnerUp?.status !== "rejected" &&
    resolutionMargin < IDENTITY_MARGIN_THRESHOLD;

  return {
    status: resolved ? "resolved" : ambiguous ? "ambiguous" : "unresolved",
    selectedCandidate: selected ?? null,
    runnerUpCandidate: runnerUp ?? null,
    ...(selected ? { selectedCandidateId: selected.id } : {}),
    ...(runnerUp ? { runnerUpCandidateId: runnerUp.id } : {}),
    selectedScore,
    runnerUpScore,
    runnerUpMargin,
    resolutionThreshold: IDENTITY_RESOLUTION_THRESHOLD,
    marginThreshold: IDENTITY_MARGIN_THRESHOLD,
    ...(contextualAssessments.size > 0
      ? {
          resolutionBasis:
            selectedContextAssessment && selectedResolutionScore > selectedScore
              ? ("context_corroboration" as const)
              : ("candidate_score" as const),
          resolutionScore: selectedResolutionScore,
          runnerUpResolutionScore,
          resolutionMargin,
          ...(selectedContextAssessment
            ? {
                contextDecision: selectedContextAssessment.decision,
                resolutionEvidenceIds: selectedContextAssessment.evidenceIds,
                resolutionSourceFamilies: selectedContextAssessment.sourceFamilies,
                resolutionContextKeys: selectedContextAssessment.matchedContextKeys,
              }
            : {}),
        }
      : {}),
  };
}

export function summarizeSources(evidence: readonly EvidenceRecord[]): SourceSummary[] {
  const groups = new Map<string, EvidenceRecord[]>();
  for (const item of evidence) {
    const group = groups.get(item.sourceFamily) ?? [];
    group.push(item);
    groups.set(item.sourceFamily, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sourceFamily, items]) => ({
      sourceFamily,
      sourceTypes: [...new Set(items.map((item) => item.sourceType))].sort(),
      evidenceCount: items.length,
      supportingCount: items.filter((item) => item.disposition === "supports").length,
      contradictingCount: items.filter((item) => item.disposition === "contradicts").length,
      discoveryOnlyCount: items.filter((item) => item.disposition === "discovery_only").length,
      urls: [...new Set(items.map((item) => item.canonicalUrl))].sort(),
    }));
}

export function summarizeCoverage(
  state: Pick<InvestigationState, "candidates" | "findings" | "evidence" | "openQuestions"> &
    Partial<Pick<InvestigationState, "target">>,
  requestedCategories: readonly FindingCategory[] = DEFAULT_REQUESTED_CATEGORIES,
): CoverageSummary {
  const selectedCandidateId = resolveIdentity(state.candidates, state.evidence, state.target).selectedCandidateId;
  const selectedFindings = selectedCandidateId
    ? state.findings.filter((finding) => finding.candidateId === selectedCandidateId)
    : [];
  const selectedEvidence = selectedCandidateId
    ? state.evidence.filter((evidence) => evidence.candidateId === selectedCandidateId)
    : [];
  const requested = [...new Set(requestedCategories)].sort();
  const covered = requested.filter((category) =>
    selectedFindings.some((finding) => finding.category === category && finding.confidence.score >= 0.45),
  );
  const missing = requested.filter((category) => !covered.includes(category));
  const independentFamilies = new Set(
    selectedEvidence.filter((item) => item.disposition === "supports").map((item) => item.sourceFamily),
  );
  const categoryScore = requested.length > 0 ? covered.length / requested.length : 1;
  const sourceScore = Math.min(1, independentFamilies.size / 3);
  const findingScore = Math.min(1, selectedFindings.length / Math.max(1, requested.length));
  const score = roundScore(categoryScore * 0.55 + sourceScore * 0.25 + findingScore * 0.2);
  return {
    score,
    requestedCategories: requested,
    coveredCategories: covered,
    missingCategories: missing,
    supportedFindingCount: selectedFindings.filter((finding) => finding.confidence.score >= 0.45).length,
    highConfidenceFindingCount: selectedFindings.filter((finding) => finding.confidence.score >= 0.75).length,
    independentSourceFamilyCount: independentFamilies.size,
    gaps: [...new Set([...missing.map((category) => `No supported ${category} finding`), ...state.openQuestions])]
      .filter(Boolean)
      .sort(),
  };
}

export function reportTelemetry(
  state: Pick<InvestigationState, "candidates" | "findings" | "evidence" | "evidenceTelemetry" | "target">,
): ReportTelemetry {
  const identity = resolveIdentity(state.candidates, state.evidence, state.target);
  const contextuallyResolvedIdentity =
    identity.status === "resolved" && identity.resolutionBasis === "context_corroboration";
  return {
    candidateCount: state.candidates.length,
    resolvedCandidateCount: Math.max(
      contextuallyResolvedIdentity ? 1 : 0,
      state.candidates.filter((candidate) => candidate.status === "resolved").length,
    ),
    evidence: { ...state.evidenceTelemetry },
    findingCount: state.findings.length,
    highConfidenceFindingCount: state.findings.filter((finding) => finding.confidence.score >= 0.75).length,
  };
}

export function restrictedReportContentPaths(report: InvestigationReport): string[] {
  const allowedEmails = new Set(
    report.target.identifiers
      .filter((identifier) => identifier.kind === "email" && identifier.provenance === "user_input")
      .map((identifier) => identifier.normalizedValue),
  );
  const currentYear = new Date(report.generatedAt).getUTCFullYear();
  const options = {
    allowedEmails,
    ...(Number.isInteger(currentYear) ? { currentYear } : {}),
  };
  const values: ReadonlyArray<readonly [string, string | null | undefined]> = [
    ["stop.detail", report.stop.detail],
    ...report.limitations.map((value, index) => [`limitations[${index}]`, value] as const),
    ...report.coverage.gaps.map((value, index) => [`coverage.gaps[${index}]`, value] as const),
    ...report.candidates.flatMap((candidate, candidateIndex) => [
      [`candidates[${candidateIndex}].displayName`, candidate.displayName] as const,
      ...candidate.signals.map(
        (signal, signalIndex) => [`candidates[${candidateIndex}].signals[${signalIndex}].value`, signal.value] as const,
      ),
    ]),
    ...report.evidence.flatMap((evidence, evidenceIndex) => [
      [`evidence[${evidenceIndex}].claim`, evidence.claim] as const,
      [`evidence[${evidenceIndex}].excerpt`, evidence.excerpt] as const,
      [`evidence[${evidenceIndex}].title`, evidence.title] as const,
      [`evidence[${evidenceIndex}].publisher`, evidence.publisher] as const,
    ]),
    ...report.findings.flatMap((finding, findingIndex) => [
      [`findings[${findingIndex}].title`, finding.title] as const,
      [`findings[${findingIndex}].description`, finding.description] as const,
      ...finding.caveats.map(
        (value, caveatIndex) => [`findings[${findingIndex}].caveats[${caveatIndex}]`, value] as const,
      ),
    ]),
  ];
  const prosePaths = values
    .filter((entry): entry is readonly [string, string] => typeof entry[1] === "string")
    .filter(([, value]) => containsRestrictedPublicContent(value, options))
    .map(([path]) => path);
  const arbitraryJsonPaths = report.evidence.flatMap((evidence, evidenceIndex) => [
    ...(evidence.canonicalSubset === null
      ? []
      : restrictedJsonContentPaths(evidence.canonicalSubset, options, `evidence[${evidenceIndex}].canonicalSubset`)),
    ...restrictedJsonContentPaths(evidence.attributes, options, `evidence[${evidenceIndex}].attributes`),
  ]);
  const graphPaths = restrictedJsonContentPaths(report.searchGraph as unknown as JsonValue, options, "searchGraph");
  return [...new Set([...prosePaths, ...arbitraryJsonPaths, ...graphPaths])].sort();
}

export function buildInvestigationReport(state: InvestigationState, clock: Clock): InvestigationReport {
  if (state.status === "running" || state.phase !== "terminal" || !state.stop) {
    throw new Error("a report can be built only from a terminal investigation state");
  }
  const identity = resolveIdentity(state.candidates, state.evidence, state.target);
  const coverage = summarizeCoverage(state, requestedCategoriesForInput(state.input));
  const limitations = [
    ...new Set([
      ...coverage.gaps,
      ...(identity.status === "ambiguous"
        ? ["Identity remained ambiguous; candidates were not merged without a strong identifier."]
        : []),
      ...(state.evidence.some((item) => item.spoofable)
        ? ["Self-asserted or spoofable sources were confidence-capped unless independently corroborated."]
        : []),
      "Only auditable public professional sources were considered.",
    ]),
  ].sort();

  const report: InvestigationReport = {
    schemaVersion: SCHEMA_VERSION,
    runId: state.runId,
    input: state.input,
    target: state.target,
    status: state.status,
    identity,
    candidates: state.candidates,
    findings: state.findings,
    evidence: state.evidence,
    searchGraph: state.searchGraph,
    coverage: { ...coverage, score: clamp(coverage.score) },
    sources: summarizeSources(state.evidence),
    telemetry: reportTelemetry(state),
    usage: { ...state.budget.usage },
    limitations,
    stop: state.stop,
    generatedAt: clock.now(),
  };
  const restrictedPaths = restrictedReportContentPaths(report);
  if (restrictedPaths.length > 0) {
    throw new Error(`report contains restricted public content at ${restrictedPaths[0]}`);
  }
  return report;
}

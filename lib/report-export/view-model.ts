import type {
  BudgetUsage,
  Candidate,
  EvidenceRecord,
  InvestigationReport,
  SearchGraph,
  SearchGraphEdge,
  SearchGraphNode,
} from "../domain/types";
import { cleanInlineReportText, cleanReportText, safePublicReportUrl } from "./sanitize";
import { isPassivePageMetadataObservation, projectPageFootprint, projectTemporalComparison } from "./evidence-context";
import type {
  ReportCandidateView,
  ReportEvidenceView,
  ReportGraphCount,
  ReportIdentityDecisionLabel,
  ReportPathView,
  ReportSearchStrategyView,
  ReportSourceTierView,
  ReportViewModel,
} from "./types";

const TIER_BY_SOURCE_TYPE: Record<EvidenceRecord["sourceType"], number> = {
  official_profile: 1,
  company_page: 1,
  code_commit: 2,
  keybase_proof: 2,
  public_document: 2,
  code_profile: 2,
  professional_profile: 2,
  news: 4,
  web_archive: 5,
  search_result: 6,
  other: 6,
};

const TIER_LABELS: Record<number, string> = {
  0: "Exact supplied public seed",
  1: "First-party and official pages",
  2: "Structured professional records",
  3: "Universities, conferences, and publishers",
  4: "Reputable media and interviews",
  5: "Temporal provenance diff",
  6: "General web discovery",
};

const ACCEPTED_STATUSES = new Set(["verified", "mutated"]);
const REJECTED_STATUSES = new Set(["rejected"]);
const PROFILE_CONTEXT_SIGNAL_KINDS = new Set(["organization", "role", "location", "bio_phrase"]);

function finiteScore(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function percentage(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, finiteScore(value))) * 100)}%`;
}

function isDirectEvidence(item: ReportEvidenceView): boolean {
  return (
    item.disposition !== "discovery_only" &&
    item.contentLabel !== "Passive page metadata observation" &&
    item.contentLabel !== "Unverified discovery lead"
  );
}

function citedSource(item: ReportEvidenceView) {
  if (!item.sourceUrl) return null;
  let domain = item.sourceFamily;
  try {
    domain = new URL(item.sourceUrl).hostname.replace(/^www\./, "");
  } catch {
    /* keep bounded source family */
  }
  return { ref: item.ref, url: item.sourceUrl, title: item.title, domain };
}

function candidateView(
  candidate: Candidate,
  evidence: readonly ReportEvidenceView[],
  findingIds: readonly string[],
): ReportCandidateView {
  const candidateEvidence = evidence.filter((item) => item.candidateId === candidate.id);
  const directSupportingEvidence = candidateEvidence.filter(
    (item) => item.disposition === "supports" && item.verificationMethod === "direct_fetch" && isDirectEvidence(item),
  );
  const persistedConflictKinds = candidate.signals
    .filter((signal) => signal.kind === "conflict")
    .map((signal) => signal.kind);
  if (candidateEvidence.some((item) => item.disposition === "contradicts")) {
    persistedConflictKinds.push("conflict");
  }
  const directSupportingEvidenceIds = new Set(directSupportingEvidence.map((item) => item.id));
  const sourceDomains = candidateEvidence
    .map((item) => {
      if (!item.sourceUrl) return item.sourceFamily;
      try {
        return new URL(item.sourceUrl).hostname.replace(/^www\./, "");
      } catch {
        return item.sourceFamily;
      }
    })
    .filter(Boolean);
  const seenProfileFacts = new Set<string>();
  const profileFacts = directSupportingEvidence
    .filter((item) => {
      const key = item.claim.toLocaleLowerCase("en-US");
      if (seenProfileFacts.has(key)) return false;
      seenProfileFacts.add(key);
      return true;
    })
    .slice(0, 5)
    .map((item) => ({ claim: item.claim, evidenceRef: item.ref, source: citedSource(item) }));
  return {
    id: cleanInlineReportText(candidate.id),
    name: cleanInlineReportText(candidate.displayName),
    status: candidate.status,
    score: finiteScore(candidate.score.total),
    matchedSignals: [...new Set(candidate.score.matchedSignals.map(cleanInlineReportText))].sort(),
    // Candidate scoring deliberately penalizes an alternate parse of a bare
    // multi-token query as a name mismatch. That parser-interpretation penalty
    // is not an evidence contradiction and must not be presented as one.
    conflictingSignals: [...new Set(persistedConflictKinds.map(cleanInlineReportText))].sort(),
    independentSourceFamilies: [...new Set(candidate.score.independentFamilies.map(cleanInlineReportText))].sort(),
    evidenceRefs: candidateEvidence.map((item) => item.ref),
    findingIds: [...findingIds].map(cleanInlineReportText).sort(),
    sourceDomains: [...new Set(sourceDomains.map(cleanInlineReportText))].sort(),
    directSourceCount: candidateEvidence.filter(isDirectEvidence).length,
    supportingSourceFamilies: [...new Set(directSupportingEvidence.map((item) => item.sourceFamily))].sort(),
    matchedContextSignals: [
      ...new Set(
        candidate.signals
          .filter(
            (signal) =>
              PROFILE_CONTEXT_SIGNAL_KINDS.has(signal.kind) &&
              signal.assurance !== "self_asserted" &&
              Boolean(signal.sourceEvidenceId && directSupportingEvidenceIds.has(signal.sourceEvidenceId)),
          )
          .map((signal) => signal.kind),
      ),
    ]
      .map(cleanInlineReportText)
      .sort(),
    allSupportingEvidenceSpoofable:
      directSupportingEvidence.length > 0 && directSupportingEvidence.every((item) => item.spoofable),
    profileFacts,
  };
}

function evidenceTier(evidence: EvidenceRecord, graph: SearchGraph): number {
  const graphTier = graph.nodes
    .filter((node) => node.evidenceId === evidence.id && Number.isInteger(node.sourceTier))
    .map((node) => node.sourceTier as number)
    .sort((left, right) => left - right)[0];
  return graphTier ?? TIER_BY_SOURCE_TYPE[evidence.sourceType];
}

function evidenceViews(
  evidence: readonly EvidenceRecord[],
  graph: SearchGraph,
): { items: ReportEvidenceView[]; refsById: Map<string, string> } {
  const sorted = [...evidence].sort((left, right) => left.id.localeCompare(right.id));
  const width = Math.max(2, String(sorted.length).length);
  const refsById = new Map<string, string>();
  const items = sorted.map((item, index): ReportEvidenceView => {
    const ref = `E${String(index + 1).padStart(width, "0")}`;
    refsById.set(item.id, ref);
    const tier = evidenceTier(item, graph);
    const url = safePublicReportUrl(item.canonicalUrl) ?? safePublicReportUrl(item.sourceUrl) ?? "";
    const discoveryOnly = item.disposition === "discovery_only" || item.sourceType === "search_result";
    const passiveMetadataObservation = isPassivePageMetadataObservation(item);
    const exactExcerpt = discoveryOnly || item.excerpt === null ? null : cleanReportText(item.excerpt);
    const normalizedArchiveText = item.verificationMethod === "archive_snapshot";
    return {
      ref,
      id: cleanInlineReportText(item.id),
      candidateId: cleanInlineReportText(item.candidateId),
      claim: cleanReportText(item.claim),
      contentLabel: passiveMetadataObservation
        ? "Passive page metadata observation"
        : discoveryOnly
          ? "Unverified discovery lead"
          : exactExcerpt !== null
            ? normalizedArchiveText
              ? "Normalized archived text"
              : "Exact source excerpt"
            : item.canonicalSubset !== null
              ? "Structured API claim"
              : "Admitted source claim",
      exactExcerpt,
      disposition: item.disposition,
      sourceUrl: url,
      title: item.title === null ? null : cleanInlineReportText(item.title),
      publisher: item.publisher === null ? null : cleanInlineReportText(item.publisher),
      sourceFamily: cleanInlineReportText(item.sourceFamily),
      sourceType: item.sourceType,
      sourceTier: tier,
      sourceTierLabel: TIER_LABELS[tier] ?? `Source tier ${tier}`,
      verificationMethod: item.verificationMethod,
      temporalStatus: item.temporalStatus,
      observedAt: item.observedAt,
      retrievedAt: item.retrievedAt,
      contentHash: item.contentHash === null ? null : cleanInlineReportText(item.contentHash),
      reliability: finiteScore(item.reliability),
      spoofable: item.spoofable,
      temporalComparison: discoveryOnly ? null : projectTemporalComparison(item.canonicalSubset),
      pageFootprint: discoveryOnly && !passiveMetadataObservation ? null : projectPageFootprint(item.canonicalSubset),
    };
  });
  return { items, refsById };
}

function countLabels(values: readonly string[]): ReportGraphCount[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    const label = cleanInlineReportText(value || "unknown").toLocaleLowerCase("en-US");
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([label, count]) => ({ label, count }));
}

function sourceLadder(evidence: readonly ReportEvidenceView[], graph: SearchGraph): ReportSourceTierView[] {
  const groups = new Map<number, ReportEvidenceView[]>();
  for (const item of evidence) {
    groups.set(item.sourceTier, [...(groups.get(item.sourceTier) ?? []), item]);
  }
  const tiers = new Set<number>([...groups.keys(), ...graph.frontier.map((entry) => entry.sourceTier)]);
  return [...tiers]
    .sort((left, right) => left - right)
    .map((tier) => {
      const items = groups.get(tier) ?? [];
      const entries = graph.frontier.filter((entry) => entry.sourceTier === tier);
      return {
        tier,
        label: TIER_LABELS[tier] ?? `Source tier ${tier}`,
        evidenceCount: items.length,
        frontierCount: entries.length,
        verifiedCount: entries.filter((entry) => entry.status === "verified").length,
        rejectedCount: entries.filter((entry) => entry.status === "rejected").length,
        exhaustedCount: entries.filter((entry) => entry.status === "exhausted").length,
        sourceFamilies: [...new Set(items.map((item) => item.sourceFamily))].sort(),
      };
    });
}

function pathForNode(
  terminal: SearchGraphNode,
  nodes: Map<string, SearchGraphNode>,
  incoming: Map<string, SearchGraphEdge[]>,
): string[] {
  const path: string[] = [];
  const seen = new Set<string>();
  let current: SearchGraphNode | undefined = terminal;
  while (current && !seen.has(current.id) && path.length < 16) {
    path.unshift(cleanInlineReportText(current.label));
    seen.add(current.id);
    const incomingEdges: SearchGraphEdge[] = [...(incoming.get(current.id) ?? [])];
    const edge: SearchGraphEdge | undefined = incomingEdges.sort((left, right) => left.id.localeCompare(right.id))[0];
    current = edge ? nodes.get(edge.fromNodeId) : undefined;
  }
  return path;
}

function graphPaths(graph: SearchGraph): ReportPathView[] {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, SearchGraphEdge[]>();
  const outgoing = new Set<string>();
  for (const edge of graph.edges) {
    incoming.set(edge.toNodeId, [...(incoming.get(edge.toNodeId) ?? []), edge]);
    outgoing.add(edge.fromNodeId);
  }
  const mutationNodeIds = new Set([
    ...graph.edges.filter((edge) => edge.kind === "mutates").map((edge) => edge.toNodeId),
    ...graph.frontier.filter((entry) => entry.mutation !== null).map((entry) => entry.nodeId),
  ]);
  const terminal = graph.nodes
    .filter(
      (node) =>
        !outgoing.has(node.id) &&
        (ACCEPTED_STATUSES.has(node.status) || REJECTED_STATUSES.has(node.status) || node.status === "exhausted"),
    )
    .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))
    .slice(0, 16);
  return terminal.map((node): ReportPathView => {
    const isMutation = mutationNodeIds.has(node.id);
    const rejected = REJECTED_STATUSES.has(node.status);
    const frontierCost = graph.frontier.find((entry) => entry.nodeId === node.id)?.pathCost;
    const incomingCost = [...(incoming.get(node.id) ?? [])].sort((left, right) => right.pathCost - left.pathCost)[0]
      ?.pathCost;
    return {
      id: cleanInlineReportText(node.id),
      disposition: isMutation
        ? rejected || node.status === "exhausted"
          ? "mutation_rejected"
          : "mutation_accepted"
        : rejected
          ? "rejected"
          : node.status === "exhausted"
            ? "exhausted"
            : "accepted",
      path: pathForNode(node, nodes, incoming),
      cost:
        typeof frontierCost === "number" && Number.isFinite(frontierCost)
          ? frontierCost
          : typeof incomingCost === "number" && Number.isFinite(incomingCost)
            ? incomingCost
            : null,
    };
  });
}

function searchStrategy(evidence: readonly ReportEvidenceView[], graph: SearchGraph): ReportSearchStrategyView {
  const nodeCount = graph.nodes.length;
  const edgeCount = graph.edges.length;
  return {
    algorithm: "Deterministic best-first frontier with bounded seeded mutation",
    graphAvailable: true,
    nodeCount,
    edgeCount,
    nodeStatusCounts: countLabels(graph.nodes.map((node) => node.status)),
    frontierCounts: countLabels(graph.frontier.map((entry) => entry.status)),
    sourceLadder: sourceLadder(evidence, graph),
    paths: graphPaths(graph),
    mutation: {
      proposed: graph.telemetry.mutationsProposed,
      accepted: graph.telemetry.mutationsAccepted,
      rejected: graph.telemetry.mutationsRejected,
    },
    narrative: `The canonical execution graph retained ${nodeCount} nodes and ${edgeCount} edges, including rejected and exhausted branches. Path priority guided exploration only; it never changed evidence or finding confidence.`,
  };
}

function usageRows(usage: BudgetUsage): Array<{ label: string; value: string }> {
  return [
    ["Turns", usage.turns],
    ["LLM calls", usage.llmCalls],
    ["Tool calls", usage.toolCalls],
    ["Search calls", usage.searchCalls],
    ["Evidence attempts", usage.evidenceAttempts],
    ["Network requests", usage.networkRequests],
    ["Input tokens", usage.inputTokens],
    ["Cached input tokens", usage.cachedInputTokens],
    ["Output tokens", usage.outputTokens],
    ["Thinking tokens", usage.thinkingTokens],
    ["Cost (USD)", usage.costUsd.toFixed(6)],
    ["Elapsed", `${usage.elapsedMs} ms`],
  ].map(([label, value]) => ({ label: String(label), value: String(value) }));
}

function countPhrase(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function identityPresentation(
  status: InvestigationReport["identity"]["status"],
  selected: ReportCandidateView | null,
  profiles: readonly ReportCandidateView[],
  resolutionBasis: "candidate_score" | "context_corroboration",
  resolutionSourceFamilies: readonly string[],
  resolutionContextKeys: readonly string[],
  resolutionEvidenceRefs: readonly string[],
  allResolutionEvidenceSpoofable: boolean,
  resolutionScore: number,
  resolutionThreshold: number,
  resolutionMargin: number,
  marginThreshold: number,
): {
  lead: ReportCandidateView | null;
  decisionLabel: ReportIdentityDecisionLabel;
  missingCorroboration: string[];
  resolutionBasis: "candidate_score" | "context_corroboration";
  resolutionSourceFamilies: string[];
  resolutionContextKeys: string[];
  resolutionEvidenceRefs: string[];
  allResolutionEvidenceSpoofable: boolean;
  resolutionScore: number;
  resolutionMargin: number;
  rationale: string;
} {
  const lead = selected ?? profiles[0] ?? null;
  if (!lead) {
    return {
      lead: null,
      decisionLabel: "No eligible candidate",
      missingCorroboration: ["No candidate-bound direct evidence was admitted."],
      resolutionBasis,
      resolutionSourceFamilies: [...resolutionSourceFamilies],
      resolutionContextKeys: [...resolutionContextKeys],
      resolutionEvidenceRefs: [...resolutionEvidenceRefs],
      allResolutionEvidenceSpoofable,
      resolutionScore,
      resolutionMargin,
      rationale:
        "No candidate profile survived the identity and evidence gates. Resolution requires at least one candidate-bound direct source with corroborating identity context.",
    };
  }

  const sourceFamilyCount = resolutionSourceFamilies.length;
  const contextCount = resolutionContextKeys.length;
  const highConfidence =
    status === "resolved" &&
    resolutionScore >= resolutionThreshold &&
    resolutionScore >= 0.75 &&
    sourceFamilyCount >= 2 &&
    contextCount >= 1 &&
    lead.conflictingSignals.length === 0 &&
    !allResolutionEvidenceSpoofable;
  if (status === "resolved") {
    const decisionLabel: ReportIdentityDecisionLabel = highConfidence ? "High-confidence match" : "Resolved match";
    return {
      lead,
      decisionLabel,
      missingCorroboration: [],
      resolutionBasis,
      resolutionSourceFamilies: [...resolutionSourceFamilies],
      resolutionContextKeys: [...resolutionContextKeys],
      resolutionEvidenceRefs: [...resolutionEvidenceRefs],
      allResolutionEvidenceSpoofable,
      resolutionScore,
      resolutionMargin,
      rationale: `${decisionLabel}: Atlas formally selected ${lead.name} with a ${resolutionBasis === "context_corroboration" ? `context-corroboration identity match score of ${percentage(resolutionScore)} (base candidate score ${percentage(lead.score)})` : `candidate match score of ${percentage(resolutionScore)}`}. The branch retains ${countPhrase(lead.directSourceCount, "direct evidence record")} across ${countPhrase(sourceFamilyCount, "supporting source family", "supporting source families")}, with ${countPhrase(contextCount, "grounded professional context signal")}; the resolution margin is ${percentage(resolutionMargin)}.`,
    };
  }

  const missingCorroboration: string[] = [];
  if (resolutionScore < resolutionThreshold) {
    missingCorroboration.push(
      `the ${percentage(resolutionScore)} identity match score is below the ${percentage(resolutionThreshold)} resolution threshold`,
    );
  }
  if (sourceFamilyCount === 0) {
    missingCorroboration.push("no direct supporting source family was admitted");
  } else if (sourceFamilyCount === 1) {
    missingCorroboration.push("direct support comes from only one source family");
  }
  if (contextCount === 0) {
    missingCorroboration.push("no directly grounded professional context was retained");
  }
  if (lead.conflictingSignals.length > 0) {
    missingCorroboration.push(`${countPhrase(lead.conflictingSignals.length, "conflicting identity signal")} remain`);
  }
  if (status === "ambiguous" && resolutionMargin < marginThreshold) {
    missingCorroboration.push(
      `the ${percentage(resolutionMargin)} lead over the runner-up is below the ${percentage(marginThreshold)} separation margin`,
    );
  }
  if (allResolutionEvidenceSpoofable) {
    missingCorroboration.push("every direct supporting observation remains spoofable");
  }
  if (missingCorroboration.length === 0) {
    missingCorroboration.push("the formal identity-resolution rules were not cleared by the admitted evidence");
  }
  const decisionLabel: ReportIdentityDecisionLabel =
    status === "ambiguous"
      ? "Competing candidates"
      : sourceFamilyCount >= 1 && contextCount >= 1
        ? "Best-supported candidate"
        : "Leading query branch";
  const leadSentence = `${lead.name} leads the retained branches at a ${percentage(resolutionScore)} identity match score${resolutionBasis === "context_corroboration" ? ` (base candidate score ${percentage(lead.score)})` : ""}, with ${countPhrase(lead.directSourceCount, "direct evidence record")} across ${countPhrase(sourceFamilyCount, "supporting source family", "supporting source families")} and ${countPhrase(contextCount, "grounded professional context signal")}.`;
  return {
    lead,
    decisionLabel,
    missingCorroboration,
    resolutionBasis,
    resolutionSourceFamilies: [...resolutionSourceFamilies],
    resolutionContextKeys: [...resolutionContextKeys],
    resolutionEvidenceRefs: [...resolutionEvidenceRefs],
    allResolutionEvidenceSpoofable,
    resolutionScore,
    resolutionMargin,
    rationale: `${decisionLabel}: ${leadSentence} Formal identity is ${status} because ${missingCorroboration.join("; ")}.`,
  };
}

function executiveSummary(
  report: InvestigationReport,
  assessment: ReturnType<typeof identityPresentation>,
  findingCount: number,
): string {
  const identity = assessment.lead
    ? `${assessment.decisionLabel}: ${assessment.lead.name} is the ${report.identity.status === "resolved" ? "formally selected" : "highest-ranked"} profile at a ${percentage(assessment.resolutionScore)} identity match score${assessment.resolutionBasis === "context_corroboration" ? ` (base candidate score ${percentage(assessment.lead.score)})` : ""}, grounded in ${countPhrase(assessment.lead.directSourceCount, "direct evidence record")} from ${countPhrase(assessment.resolutionSourceFamilies.length, "identity-supporting source family", "identity-supporting source families")}.`
    : "No eligible candidate profile was retained from the admitted public-professional evidence.";
  const decisionBoundary =
    report.identity.status === "resolved"
      ? "The formal identity decision is resolved."
      : report.identity.status === "ambiguous"
        ? "Competing branches remain separate pending stronger corroboration."
        : assessment.lead
          ? "Formal resolution is still pending; the Identity section lists the missing corroboration."
          : "Identity resolution cannot proceed without candidate-bound direct evidence.";
  const findings =
    findingCount > 0
      ? `${countPhrase(findingCount, "finding")} ${findingCount === 1 ? "cites" : "cite"} admitted evidence across ${countPhrase(report.coverage.independentSourceFamilyCount, "independent source family", "independent source families")}.`
      : "No synthesized finding met the evidence-admission and confidence rules in this run.";
  const coverage = `Requested-category coverage is ${percentage(report.coverage.score)}; execution stopped with ${report.stop.reason.replaceAll("_", " ")}.`;
  return cleanReportText(`${identity} ${decisionBoundary} ${findings} ${coverage}`);
}

export function createReportViewModel(report: InvestigationReport): ReportViewModel {
  const evidence = evidenceViews(report.evidence, report.searchGraph);
  const selectedId = report.identity.selectedCandidateId;
  const orderedCandidates = [...report.candidates].sort((left, right) => {
    if (left.id === selectedId) return -1;
    if (right.id === selectedId) return 1;
    return right.score.total - left.score.total || left.id.localeCompare(right.id);
  });
  const candidateNames = new Map(
    orderedCandidates.map((candidate) => [candidate.id, cleanInlineReportText(candidate.displayName)]),
  );
  const subject =
    (selectedId ? candidateNames.get(selectedId) : null) ??
    (report.target.name ? cleanInlineReportText(report.target.name) : cleanInlineReportText(report.input.query));
  const evidenceViewById = new Map(evidence.items.map((item) => [item.id, item]));
  const citedSourcesFor = (ids: readonly string[]) =>
    ids
      .map((id) => {
        const ref = evidence.refsById.get(id);
        const view = evidenceViewById.get(cleanInlineReportText(id));
        if (!ref || !view || !view.sourceUrl) return null;
        let domain = view.sourceFamily;
        try {
          domain = new URL(view.sourceUrl).hostname.replace(/^www\./, "");
        } catch {
          /* keep family */
        }
        return { ref, url: view.sourceUrl, title: view.title, domain };
      })
      .filter((source): source is { ref: string; url: string; title: string | null; domain: string } =>
        Boolean(source),
      );
  const findings = [...report.findings]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((finding) => ({
      id: cleanInlineReportText(finding.id),
      candidateId: cleanInlineReportText(finding.candidateId),
      candidateName: candidateNames.get(finding.candidateId) ?? "Unresolved candidate branch",
      title: cleanInlineReportText(finding.title),
      description: cleanReportText(finding.description),
      category: finding.category,
      confidenceScore: finiteScore(finding.confidence.score),
      confidenceLabel: finding.confidence.label,
      citations: finding.evidenceIds
        .map((id) => evidence.refsById.get(id))
        .filter((ref): ref is string => Boolean(ref)),
      counterCitations: finding.counterEvidenceIds
        .map((id) => evidence.refsById.get(id))
        .filter((ref): ref is string => Boolean(ref)),
      sources: citedSourcesFor(finding.evidenceIds),
      caveats: finding.caveats.map(cleanReportText).sort(),
    }));
  const findingIdsByCandidate = new Map<string, string[]>();
  for (const finding of findings) {
    findingIdsByCandidate.set(finding.candidateId, [
      ...(findingIdsByCandidate.get(finding.candidateId) ?? []),
      finding.id,
    ]);
  }
  const candidates = orderedCandidates.map((candidate) => {
    const view = candidateView(candidate, evidence.items, findingIdsByCandidate.get(candidate.id) ?? []);
    if (candidate.id === report.identity.selectedCandidateId) {
      return { ...view, score: Math.max(view.score, finiteScore(report.identity.selectedScore)) };
    }
    if (candidate.id === report.identity.runnerUpCandidateId) {
      return { ...view, score: Math.max(view.score, finiteScore(report.identity.runnerUpScore)) };
    }
    return view;
  });
  const profiles = candidates.slice(0, 5);
  const rankedLead = profiles.find((candidate) => candidate.id === selectedId) ?? profiles[0] ?? null;
  const selected = report.identity.status === "resolved" ? rankedLead : null;
  const alternatives = profiles.filter((candidate) => candidate.id !== rankedLead?.id);
  const retainedCandidateCount = candidates.length;
  const resolutionBasis = report.identity.resolutionBasis ?? "candidate_score";
  const resolutionSourceFamilies =
    resolutionBasis === "context_corroboration" && (report.identity.resolutionSourceFamilies?.length ?? 0) > 0
      ? [...new Set(report.identity.resolutionSourceFamilies!.map(cleanInlineReportText))].sort()
      : [...(rankedLead?.supportingSourceFamilies ?? [])];
  const resolutionContextKeys =
    resolutionBasis === "context_corroboration" && (report.identity.resolutionContextKeys?.length ?? 0) > 0
      ? [...new Set(report.identity.resolutionContextKeys!.map(cleanInlineReportText))]
          .filter((key) => !key.startsWith("name:"))
          .sort()
      : [...(rankedLead?.matchedContextSignals ?? [])];
  const resolutionEvidenceIds =
    resolutionBasis === "context_corroboration" && (report.identity.resolutionEvidenceIds?.length ?? 0) > 0
      ? [...new Set(report.identity.resolutionEvidenceIds!)]
      : evidence.items
          .filter(
            (item) =>
              item.candidateId === rankedLead?.id &&
              item.disposition === "supports" &&
              item.verificationMethod === "direct_fetch" &&
              isDirectEvidence(item),
          )
          .map((item) => item.id);
  const resolutionEvidenceIdSet = new Set(resolutionEvidenceIds);
  const resolutionEvidenceViews = evidence.items.filter((item) => resolutionEvidenceIdSet.has(item.id));
  const resolutionEvidenceRefs = resolutionEvidenceViews.map((item) => item.ref).sort();
  const allResolutionEvidenceSpoofable =
    resolutionEvidenceViews.length > 0 && resolutionEvidenceViews.every((item) => item.spoofable);
  const resolutionScore = finiteScore(report.identity.resolutionScore ?? report.identity.selectedScore);
  const resolutionMargin = finiteScore(report.identity.resolutionMargin ?? report.identity.runnerUpMargin);
  const assessment = identityPresentation(
    report.identity.status,
    selected,
    profiles,
    resolutionBasis,
    resolutionSourceFamilies,
    resolutionContextKeys,
    resolutionEvidenceRefs,
    allResolutionEvidenceSpoofable,
    resolutionScore,
    report.identity.resolutionThreshold,
    resolutionMargin,
    report.identity.marginThreshold,
  );
  return {
    schemaVersion: 1,
    classification: "PUBLIC-SOURCE INTELLIGENCE",
    title: `Atlas intelligence report - ${subject}`,
    subject,
    run: {
      id: cleanInlineReportText(report.runId),
      query: cleanReportText(report.input.query),
      objective: report.input.objective ? cleanReportText(report.input.objective) : null,
      depth: report.input.requestedDepth ?? "unspecified",
      requestedCategories: [...new Set(report.coverage.requestedCategories)].sort(),
      targetKind: report.target.kind,
      explicitIdentifierKinds: [
        ...new Set(
          report.target.identifiers
            .filter((identifier) => identifier.provenance === "user_input")
            .map((identifier) => identifier.kind),
        ),
      ].sort(),
      scope: "Public professional sources only",
      status: report.status,
      generatedAt: report.generatedAt,
      stopReason: report.stop.reason,
      stopDetail: cleanReportText(report.stop.detail),
    },
    executiveSummary: executiveSummary(report, assessment, findings.length),
    identity: {
      status: report.identity.status,
      selected,
      lead: assessment.lead,
      decisionLabel: assessment.decisionLabel,
      missingCorroboration: assessment.missingCorroboration,
      profiles,
      alternatives,
      retainedCandidateCount,
      runnerUpMargin: finiteScore(report.identity.runnerUpMargin),
      resolutionBasis,
      resolutionSourceFamilies: assessment.resolutionSourceFamilies,
      resolutionContextKeys: assessment.resolutionContextKeys,
      resolutionEvidenceRefs: assessment.resolutionEvidenceRefs,
      allResolutionEvidenceSpoofable: assessment.allResolutionEvidenceSpoofable,
      resolutionScore,
      resolutionMargin,
      resolutionThreshold: finiteScore(report.identity.resolutionThreshold),
      marginThreshold: finiteScore(report.identity.marginThreshold),
      rationale: assessment.rationale,
    },
    findings,
    evidence: evidence.items,
    searchStrategy: searchStrategy(evidence.items, report.searchGraph),
    coverage: {
      score: finiteScore(report.coverage.score),
      requestedCategories: [...new Set(report.coverage.requestedCategories)].sort(),
      coveredCategories: [...new Set(report.coverage.coveredCategories)].sort(),
      missingCategories: [...new Set(report.coverage.missingCategories)].sort(),
      independentSourceFamilyCount: report.coverage.independentSourceFamilyCount,
      gaps: [...new Set(report.coverage.gaps.map(cleanReportText))].sort(),
    },
    limitations: [...new Set(report.limitations.map(cleanReportText))].sort(),
    execution: {
      usage: usageRows(report.usage),
      phaseTurns: Object.entries(report.usage.phaseTurns)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([phase, turns]) => ({ label: cleanInlineReportText(phase), value: String(turns ?? 0) })),
      elapsedMs: report.usage.elapsedMs,
      stopReason: report.stop.reason,
      stopDetail: cleanReportText(report.stop.detail),
    },
    methodology: {
      evidenceStandard:
        "Only admitted public-professional evidence appears here. Exact source excerpts, normalized archived text, and structured API claims are labeled distinctly, and discovery-only snippets are not promoted into findings.",
      confidenceStandard:
        "Identity assessment keeps the base candidate score separate from any evidence-weighted context-corroboration score. Finding confidence is computed from candidate-bound evidence, independent source families, contradictions, reliability, and spoofability caps. Model prose is never finding authority.",
      graphStandard:
        "The search graph records actual frontier execution, including rejected and exhausted paths. Best-first path scores guide which legal action runs next but never increase finding confidence.",
      safetyNote:
        "Atlas excludes private contact enrichment, home addresses, personal phone lookup, family mapping, precise location, credentials, financial data, and high-impact decisioning. The scope is public professional intelligence only.",
    },
  };
}

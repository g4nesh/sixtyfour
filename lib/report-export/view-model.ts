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
import type {
  ReportCandidateView,
  ReportEvidenceView,
  ReportGraphCount,
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
  5: "Candidate-linked Wayback history",
  6: "General web discovery",
};

const ACCEPTED_STATUSES = new Set(["verified", "mutated"]);
const REJECTED_STATUSES = new Set(["rejected"]);

function finiteScore(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function percentage(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, finiteScore(value))) * 100)}%`;
}

function candidateView(candidate: Candidate): ReportCandidateView {
  return {
    id: cleanInlineReportText(candidate.id),
    name: cleanInlineReportText(candidate.displayName),
    status: candidate.status,
    score: finiteScore(candidate.score.total),
    matchedSignals: [...new Set(candidate.score.matchedSignals.map(cleanInlineReportText))].sort(),
    conflictingSignals: [...new Set(candidate.score.conflictingSignals.map(cleanInlineReportText))].sort(),
    independentSourceFamilies: [...new Set(candidate.score.independentFamilies.map(cleanInlineReportText))].sort(),
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
    const exactExcerpt = item.excerpt === null ? null : cleanReportText(item.excerpt);
    return {
      ref,
      id: cleanInlineReportText(item.id),
      candidateId: cleanInlineReportText(item.candidateId),
      claim: cleanReportText(item.claim),
      contentLabel: exactExcerpt !== null
        ? "Exact source excerpt"
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

function sourceLadder(
  evidence: readonly ReportEvidenceView[],
  graph: SearchGraph,
): ReportSourceTierView[] {
  const groups = new Map<number, ReportEvidenceView[]>();
  for (const item of evidence) {
    groups.set(item.sourceTier, [...(groups.get(item.sourceTier) ?? []), item]);
  }
  const tiers = new Set<number>([
    ...groups.keys(),
    ...graph.frontier.map((entry) => entry.sourceTier),
  ]);
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
    const edge: SearchGraphEdge | undefined = incomingEdges
      .sort((left, right) => left.id.localeCompare(right.id))[0];
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
    .filter((node) =>
      !outgoing.has(node.id)
      && (ACCEPTED_STATUSES.has(node.status) || REJECTED_STATUSES.has(node.status) || node.status === "exhausted"),
    )
    .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))
    .slice(0, 16);
  return terminal.map((node): ReportPathView => {
    const isMutation = mutationNodeIds.has(node.id);
    const rejected = REJECTED_STATUSES.has(node.status);
    const frontierCost = graph.frontier.find((entry) => entry.nodeId === node.id)?.pathCost;
    const incomingCost = [...(incoming.get(node.id) ?? [])]
      .sort((left, right) => right.pathCost - left.pathCost)[0]?.pathCost;
    return {
      id: cleanInlineReportText(node.id),
      disposition: isMutation
        ? rejected || node.status === "exhausted" ? "mutation_rejected" : "mutation_accepted"
        : rejected ? "rejected" : node.status === "exhausted" ? "exhausted" : "accepted",
      path: pathForNode(node, nodes, incoming),
      cost: typeof frontierCost === "number" && Number.isFinite(frontierCost)
        ? frontierCost
        : typeof incomingCost === "number" && Number.isFinite(incomingCost) ? incomingCost : null,
    };
  });
}

function searchStrategy(
  evidence: readonly ReportEvidenceView[],
  graph: SearchGraph,
): ReportSearchStrategyView {
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

function executiveSummary(
  report: InvestigationReport,
  subject: string,
  findingCount: number,
): string {
  const identity = report.identity.status === "resolved"
    ? `Identity resolved to ${subject} with a ${percentage(report.identity.selectedScore)} candidate score and ${percentage(report.identity.runnerUpMargin)} margin over the retained runner-up.`
    : report.identity.status === "ambiguous"
      ? `Identity remains ambiguous; Atlas retained competing candidates instead of merging them.`
      : "Identity remains unresolved; the available public-professional evidence did not clear the resolution threshold.";
  const findings = `${findingCount} finding${findingCount === 1 ? "" : "s"} cite${findingCount === 1 ? "s" : ""} admitted evidence across ${report.coverage.independentSourceFamilyCount} independent source famil${report.coverage.independentSourceFamilyCount === 1 ? "y" : "ies"}.`;
  const coverage = `Coverage reached ${percentage(report.coverage.score)} for the requested categories; the run stopped with ${report.stop.reason.replaceAll("_", " ")}.`;
  return cleanReportText(`${identity} ${findings} ${coverage}`);
}

export function createReportViewModel(
  report: InvestigationReport,
): ReportViewModel {
  const evidence = evidenceViews(report.evidence, report.searchGraph);
  const selectedId = report.identity.selectedCandidateId;
  const candidates = [...report.candidates]
    .sort((left, right) => {
      if (left.id === selectedId) return -1;
      if (right.id === selectedId) return 1;
      return right.score.total - left.score.total || left.id.localeCompare(right.id);
    })
    .map(candidateView);
  const selected = candidates.find((candidate) => candidate.id === selectedId) ?? null;
  const alternatives = candidates.filter((candidate) => candidate.id !== selectedId);
  const subject = selected?.name
    ?? (report.target.name ? cleanInlineReportText(report.target.name) : cleanInlineReportText(report.input.query));
  const findings = [...report.findings]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((finding) => ({
      id: cleanInlineReportText(finding.id),
      title: cleanInlineReportText(finding.title),
      description: cleanReportText(finding.description),
      category: finding.category,
      confidenceScore: finiteScore(finding.confidence.score),
      confidenceLabel: finding.confidence.label,
      citations: finding.evidenceIds.map((id) => evidence.refsById.get(id)).filter((ref): ref is string => Boolean(ref)),
      counterCitations: finding.counterEvidenceIds.map((id) => evidence.refsById.get(id)).filter((ref): ref is string => Boolean(ref)),
      caveats: finding.caveats.map(cleanReportText).sort(),
    }));
  const identityRationale = report.identity.status === "resolved"
    ? `The selected candidate cleared the ${percentage(report.identity.resolutionThreshold)} resolution threshold and the ${percentage(report.identity.marginThreshold)} separation margin.`
    : report.identity.status === "ambiguous"
      ? "Candidates were retained separately because the score margin did not justify a strong-identifier merge."
      : "No candidate met both the resolution and candidate-separation requirements.";
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
      explicitIdentifierKinds: [...new Set(report.target.identifiers
        .filter((identifier) => identifier.provenance === "user_input")
        .map((identifier) => identifier.kind))].sort(),
      scope: "Public professional sources only",
      status: report.status,
      generatedAt: report.generatedAt,
      stopReason: report.stop.reason,
      stopDetail: cleanReportText(report.stop.detail),
    },
    executiveSummary: executiveSummary(report, subject, findings.length),
    identity: {
      status: report.identity.status,
      selected,
      alternatives,
      runnerUpMargin: finiteScore(report.identity.runnerUpMargin),
      resolutionThreshold: finiteScore(report.identity.resolutionThreshold),
      marginThreshold: finiteScore(report.identity.marginThreshold),
      rationale: identityRationale,
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
      evidenceStandard: "Only admitted public-professional evidence appears here. Exact source excerpts are kept distinct from structured API claims, and discovery-only snippets are not promoted into findings.",
      confidenceStandard: "Finding confidence is computed from candidate-bound evidence, independent source families, contradictions, reliability, and spoofability caps. Model prose is never finding authority.",
      graphStandard: "The search graph records actual frontier execution, including rejected and exhausted paths. Best-first path scores guide which legal action runs next but never increase finding confidence.",
      safetyNote: "Atlas excludes private contact enrichment, home addresses, personal phone lookup, family mapping, precise location, credentials, financial data, and high-impact decisioning. The scope is public professional intelligence only.",
    },
  };
}

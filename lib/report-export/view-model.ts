import type {
  BudgetUsage,
  Candidate,
  EvidenceRecord,
  FindingCategory,
  InvestigationReport,
  SearchGraph,
  SearchGraphEdge,
  SearchGraphNode,
} from "../domain/types";
import {
  containsRestrictedPublicContent,
  containsRestrictedReportArtifact,
  urlContainsRestrictedParameters,
} from "../domain/content-policy";
import { evidenceSupportsFindingCategory, validateReferentialIntegrity } from "../domain/integrity";
import { resolveIdentity, restrictedReportContentPaths } from "../domain/report";
import { parseInvestigationReport } from "../domain/validation";
import { cleanInlineReportText, cleanReportText, safePublicReportUrl } from "./sanitize";
import { isPassivePageMetadataObservation, projectPageFootprint, projectTemporalComparison } from "./evidence-context";
import type {
  ReportCandidateView,
  ReportBriefingObservationView,
  ReportBriefingView,
  ReportEvidenceView,
  ReportFindingView,
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
const BRIEFING_CATEGORY_ORDER: readonly FindingCategory[] = [
  "employment",
  "education",
  "project",
  "publication",
  "online_presence",
  "timeline",
  "identity",
  "other",
];
const BRIEFING_CATEGORY_HEADINGS: Record<FindingCategory, string> = {
  identity: "Identity",
  employment: "Employment",
  education: "Education",
  project: "Projects",
  publication: "Publications",
  online_presence: "Online presence",
  timeline: "Timeline",
  other: "Other public-professional observations",
};

function finiteScore(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function safeEvidenceSourceUrl(value: string): string | null {
  const safe = safePublicReportUrl(value);
  let parsed: URL;
  try {
    parsed = new URL(safe ?? "");
  } catch {
    return null;
  }
  const hostname = parsed.hostname.toLocaleLowerCase("en-US").replace(/\.$/, "");
  const publicHostname =
    hostname.length <= 253 &&
    hostname.includes(".") &&
    !hostname.startsWith("[") &&
    !hostname.endsWith("]") &&
    !hostname.endsWith(".localhost") &&
    !hostname.endsWith(".local") &&
    !hostname.endsWith(".internal") &&
    !hostname.endsWith(".home.arpa") &&
    hostname !== "localhost" &&
    hostname.split(".").every((label) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label));
  if (
    !safe ||
    parsed.port !== "" ||
    !publicHostname ||
    urlContainsRestrictedParameters(safe) ||
    containsRestrictedPublicContent(safe) ||
    containsRestrictedReportArtifact(safe)
  ) {
    return null;
  }
  return safe;
}

function sameCanonicalValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameCanonicalValue(item, right[index]))
    );
  }
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && sameCanonicalValue(leftRecord[key], rightRecord[key]))
  );
}

function exportableReport(value: InvestigationReport): InvestigationReport {
  let report: InvestigationReport;
  try {
    report = parseInvestigationReport(value);
  } catch {
    throw new TypeError("report export rejected: invalid canonical investigation report");
  }
  const restrictedPaths = restrictedReportContentPaths(report);
  if (restrictedPaths.length > 0) {
    throw new TypeError(`report export rejected: restricted public content at ${restrictedPaths[0]}`);
  }
  // Search-graph integrity remains an execution/replay concern. The export
  // boundary validates the complete candidate/evidence/finding fact graph so a
  // malformed UI payload cannot forge a citation or borrow another branch.
  const integrityIssues = validateReferentialIntegrity({
    candidates: report.candidates,
    evidence: report.evidence,
    findings: report.findings,
  });
  if (integrityIssues.length > 0) {
    const issue = integrityIssues[0];
    throw new TypeError(`report export rejected: ${issue.code} at ${issue.path}`);
  }
  const canonicalIdentity = resolveIdentity(report.candidates, report.evidence, report.target);
  if (!sameCanonicalValue(report.identity, canonicalIdentity)) {
    throw new TypeError("report export rejected: identity projection does not match canonical candidates and evidence");
  }
  return report;
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
    const url = safeEvidenceSourceUrl(item.canonicalUrl) ?? safeEvidenceSourceUrl(item.sourceUrl) ?? "";
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

function briefingSafeText(value: string, currentYear: number): string | null {
  const cleaned = cleanReportText(value);
  if (!cleaned || containsRestrictedPublicContent(cleaned, { currentYear })) return null;
  return cleaned;
}

function directObservationCategory(evidence: EvidenceRecord, candidate: Candidate): FindingCategory {
  for (const category of BRIEFING_CATEGORY_ORDER) {
    if (category !== "other" && evidenceSupportsFindingCategory(evidence, candidate, category)) return category;
  }
  return "other";
}

function quotedObservationSentence(prefix: string, detail: string): string {
  const terminalDetail = /[.!?…]$/u.test(detail) ? detail : `${detail}.`;
  return `${prefix}: “${terminalDetail}”`;
}

function buildBriefing(
  report: InvestigationReport,
  subject: string,
  assessment: ReturnType<typeof identityPresentation>,
  findings: readonly ReportFindingView[],
  evidence: readonly ReportEvidenceView[],
): ReportBriefingView {
  const generatedYear = new Date(report.generatedAt).getUTCFullYear();
  const currentYear = Number.isInteger(generatedYear) ? generatedYear : 1970;
  const lead = assessment.lead;
  const safeLeadName = lead ? briefingSafeText(lead.name, currentYear) : null;
  const safeSubject = briefingSafeText(subject, currentYear) ?? safeLeadName ?? "Public professional profile";
  const headline = `${safeSubject} — here’s what’s publicly available.`;

  const rawEvidenceById = new Map(report.evidence.map((item) => [cleanInlineReportText(item.id), item]));
  const rawCandidate = lead ? report.candidates.find((candidate) => candidate.id === lead.id) : null;
  const sourceFor = (item: ReportEvidenceView) => {
    const url = safeEvidenceSourceUrl(item.sourceUrl);
    if (!url || containsRestrictedPublicContent(url, { currentYear })) return null;
    const domain = briefingSafeText(item.sourceFamily, currentYear);
    if (!domain) return null;
    return {
      ref: item.ref,
      url,
      title: item.title ? briefingSafeText(item.title, currentYear) : null,
      domain,
    };
  };
  const eligibleEvidence = new Map(
    evidence
      .filter(
        (item) =>
          item.candidateId === lead?.id &&
          item.disposition === "supports" &&
          isDirectEvidence(item) &&
          briefingSafeText(item.claim, currentYear) !== null &&
          sourceFor(item) !== null,
      )
      .map((item) => [item.ref, item]),
  );
  const sourcesFor = (refs: readonly string[]) => {
    const seen = new Set<string>();
    return refs
      .map((ref) => eligibleEvidence.get(ref))
      .filter((item): item is ReportEvidenceView => Boolean(item))
      .map(sourceFor)
      .filter((source): source is NonNullable<ReturnType<typeof sourceFor>> => Boolean(source))
      .filter((source) => {
        if (seen.has(source.url)) return false;
        seen.add(source.url);
        return true;
      });
  };

  const observations: ReportBriefingObservationView[] = [];
  const seenDetails = new Set<string>();
  for (const finding of findings) {
    if (finding.candidateId !== lead?.id) continue;
    const evidenceRefs = [...new Set(finding.citations.filter((ref) => eligibleEvidence.has(ref)))].sort();
    const heading = briefingSafeText(finding.title, currentYear);
    const detail = briefingSafeText(finding.description, currentYear);
    if (!heading || !detail || evidenceRefs.length === 0) continue;
    const sources = sourcesFor(evidenceRefs);
    if (sources.length === 0) continue;
    const dedupeKey = detail.toLocaleLowerCase("en-US").replace(/\s+/gu, " ");
    if (seenDetails.has(dedupeKey)) continue;
    seenDetails.add(dedupeKey);
    observations.push({
      id: `finding:${finding.id}`,
      kind: "finding",
      category: finding.category,
      candidateId: finding.candidateId,
      candidateName: safeLeadName ?? "Retained candidate branch",
      heading,
      detail,
      evidenceRefs,
      sources,
      caveats: finding.caveats
        .map((caveat) => briefingSafeText(caveat, currentYear))
        .filter((caveat): caveat is string => Boolean(caveat)),
    });
  }

  for (const fact of lead?.profileFacts ?? []) {
    const projectedEvidence = eligibleEvidence.get(fact.evidenceRef);
    const rawEvidence = projectedEvidence ? rawEvidenceById.get(projectedEvidence.id) : null;
    const detail = briefingSafeText(fact.claim, currentYear);
    if (!projectedEvidence || !rawEvidence || !rawCandidate || !detail) continue;
    const sources = sourcesFor([fact.evidenceRef]);
    if (sources.length === 0) continue;
    const dedupeKey = detail.toLocaleLowerCase("en-US").replace(/\s+/gu, " ");
    if (seenDetails.has(dedupeKey)) continue;
    seenDetails.add(dedupeKey);
    const category = directObservationCategory(rawEvidence, rawCandidate);
    observations.push({
      id: `observation:${fact.evidenceRef}`,
      kind: "direct_observation",
      category,
      candidateId: cleanInlineReportText(rawCandidate.id),
      candidateName: safeLeadName ?? "Retained candidate branch",
      heading: `${BRIEFING_CATEGORY_HEADINGS[category]} observation`,
      detail,
      evidenceRefs: [fact.evidenceRef],
      sources,
      caveats: projectedEvidence.spoofable
        ? ["This self-published or otherwise spoofable source is not independent confirmation."]
        : [],
    });
  }

  const sections = BRIEFING_CATEGORY_ORDER.map((key) => ({
    key,
    heading: BRIEFING_CATEGORY_HEADINGS[key],
    observations: observations.filter((observation) => observation.category === key),
  })).filter((section) => section.observations.length > 0);
  const firstObservations = sections.flatMap((section) => section.observations).slice(0, 2);
  const emptyState =
    firstObservations.length === 0
      ? "No candidate-bound public-professional observation cleared the evidence gates in this run."
      : null;
  const overview =
    firstObservations.length === 0
      ? emptyState!
      : [
          quotedObservationSentence("The clearest cited public record states", firstObservations[0].detail),
          ...(firstObservations[1]
            ? [quotedObservationSentence("A second cited public record states", firstObservations[1].detail)]
            : []),
        ].join(" ");
  const leadStatement = !lead
    ? "Atlas did not retain a public-professional lead with candidate-bound direct evidence."
    : report.identity.status === "resolved"
      ? `The admitted public record supports ${safeLeadName ?? "this candidate branch"} as the resolved match.`
      : report.identity.status === "ambiguous"
        ? `Atlas retained competing public-professional branches; ${safeLeadName ?? "the displayed branch"} is the strongest current lead, but no branch was resolved.`
        : assessment.decisionLabel === "Best-supported candidate"
          ? `The strongest public-professional lead points to ${safeLeadName ?? "the displayed branch"}.`
          : `The current public-professional lead points to ${safeLeadName ?? "the displayed branch"}.`;
  const statusCaveat = !lead
    ? "Identity note: no person profile is asserted because no candidate-bound direct evidence was retained."
    : report.identity.status === "resolved"
      ? "Identity note: Atlas formally resolved this profile to the queried person. Each statement remains limited to its cited public source."
      : report.identity.status === "ambiguous"
        ? "Identity note: Atlas retained competing candidate branches and did not resolve the queried person. The observations below apply only to the displayed branch."
        : assessment.decisionLabel === "Best-supported candidate"
          ? "Identity note: this is the best-supported retained branch, not a formally resolved identity. Its observations must not be carried to another same-name person."
          : "Identity note: this is a retained query branch, not a best-supported or formally resolved identity. Its observations must not be carried to another same-name person.";
  const sourceFamilyCount = assessment.resolutionSourceFamilies.length;
  const sourceCaveat =
    sourceFamilyCount === 0
      ? "No identity-supporting direct source family was admitted."
      : sourceFamilyCount === 1 && assessment.allResolutionEvidenceSpoofable
        ? "The only identity-supporting source is self-published or otherwise spoofable, so it is not independent confirmation."
        : sourceFamilyCount === 1
          ? "The identity-supporting evidence comes from one source family, so it is not independent confirmation."
          : assessment.allResolutionEvidenceSpoofable
            ? "The identity-supporting sources remain self-published or otherwise spoofable; separate domains alone do not establish independent authority."
            : "The identity-supporting record comes from more than one separately retained source family; source-specific caveats still apply.";
  return {
    headline,
    leadCandidateId: lead?.id ?? null,
    leadName: safeLeadName,
    leadStatement,
    overview,
    statusCaveat,
    sourceCaveat,
    sections,
    emptyState,
  };
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

function executiveSummary(briefing: ReportBriefingView): string {
  return cleanReportText(
    [briefing.leadStatement, briefing.overview, briefing.statusCaveat, briefing.sourceCaveat].join(" "),
  );
}

export function createReportViewModel(report: InvestigationReport): ReportViewModel {
  report = exportableReport(report);
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
  const citedSourcesFor = (ids: readonly string[]) => {
    const seen = new Set<string>();
    return ids
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
      .filter((source): source is { ref: string; url: string; title: string | null; domain: string } => Boolean(source))
      .filter((source) => {
        if (seen.has(source.url)) return false;
        seen.add(source.url);
        return true;
      });
  };
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
  const briefing = buildBriefing(report, subject, assessment, findings, evidence.items);
  return {
    schemaVersion: 1,
    classification: "PUBLIC-SOURCE INTELLIGENCE",
    title: briefing.headline,
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
    briefing,
    audit: {
      formalIdentityStatus: report.identity.status,
      assessment: assessment.decisionLabel,
      resolutionBasis,
      decisionScore: resolutionScore,
      decisionScoreLabel: "Rule-based identity decision score (not a probability)",
      baseCandidateScore: assessment.lead?.score ?? null,
      baseCandidateScoreLabel: "Rule-based base candidate score (not a probability)",
      resolutionThreshold: finiteScore(report.identity.resolutionThreshold),
      resolutionMargin,
      marginThreshold: finiteScore(report.identity.marginThreshold),
      identitySupportingSourceFamilyCount: assessment.resolutionSourceFamilies.length,
      admittedIndependentSourceFamilyCount: report.coverage.independentSourceFamilyCount,
      retainedCandidateCount,
      coverageScore: finiteScore(report.coverage.score),
      stopReason: report.stop.reason,
      stopDetail: cleanReportText(report.stop.detail),
    },
    executiveSummary: executiveSummary(briefing),
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
        "Identity assessment keeps the base candidate score separate from any evidence-weighted context-corroboration score. Both are rule-based decision scores, not probabilities. Finding confidence is computed from candidate-bound evidence, independent source families, contradictions, reliability, and spoofability caps. Model prose is never finding authority.",
      graphStandard:
        "The search graph records actual frontier execution, including rejected and exhausted paths. Best-first path scores guide which legal action runs next but never increase finding confidence.",
      safetyNote:
        "Atlas excludes private contact enrichment, home addresses, personal phone lookup, family mapping, precise location, credentials, financial data, and high-impact decisioning. The scope is public professional intelligence only.",
    },
  };
}

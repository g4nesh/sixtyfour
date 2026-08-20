import type { Clock, IdFactory } from "./runtime";
import { labelOccursAsTokenPhrase, normalizeWhitespace } from "./runtime";
import {
  SCHEMA_VERSION,
  type Candidate,
  type EvidenceRecord,
  type Finding,
  type FindingDraft,
  type InvestigationState,
} from "./types";
import { assessConfidence } from "./confidence";
import { candidateStatus, identitySignalGroundedByEvidence, scoreCandidate } from "./candidates";
import { containsRestrictedPublicContent } from "./content-policy";
import { sourceLaneForFrontierEntry, sourceTierForUrl } from "../search/source-hierarchy";

export interface IntegrityIssue {
  code:
    | "duplicate_candidate_id"
    | "duplicate_evidence_id"
    | "duplicate_finding_id"
    | "unknown_candidate"
    | "unknown_evidence"
    | "unknown_finding"
    | "action_evidence_join_mismatch"
    | "graph_evidence_candidate_mismatch"
    | "action_evidence_candidate_mismatch"
    | "missing_graph_entity_node"
    | "duplicate_graph_entity_node"
    | "graph_entity_projection_mismatch"
    | "evidence_source_lane_mismatch"
    | "candidate_signal_provenance_mismatch"
    | "candidate_score_mismatch"
    | "missing_candidate_separation_edge"
    | "cross_candidate_evidence"
    | "discovery_only_evidence"
    | "supporting_evidence_not_supporting"
    | "counter_evidence_not_contradicting"
    | "duplicate_evidence_reference"
    | "stale_candidate_evidence_link"
    | "confidence_mismatch"
    | "ungrounded_finding"
    | "unsupported_finding_category"
    | "evidence_reused_across_categories";
  path: string;
  message: string;
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

const FINDING_CATEGORY_LABEL: Record<FindingDraft["category"], string> = {
  identity: "Identity",
  employment: "Employment",
  education: "Education",
  project: "Project",
  publication: "Publication",
  online_presence: "Online presence",
  timeline: "Timeline",
  other: "Public professional finding",
};

function materializedFindingTitle(category: FindingDraft["category"], candidate: Candidate): string {
  return `${FINDING_CATEGORY_LABEL[category]} — ${candidate.displayName}`;
}

function materializedFindingDescription(evidence: readonly EvidenceRecord[]): string {
  return [...new Set(evidence.map((item) => normalizeWhitespace(item.excerpt ?? item.claim)).filter(Boolean))]
    .slice(0, 3)
    .join(" ");
}

const EMPLOYMENT_TEXT =
  /\b(?:works?|worked|employed|joined|serves?|served|leads?|led|leadership|chair(?:man|woman)?|chief|officer|director|executive|engineer|fellow|founder|partner|curator|role|position)\b/i;
const EDUCATION_TEXT = /\b(?:university|college|school|degree|graduat(?:e|ed)|studied|education|alumn(?:us|a|i))\b/i;
const PROJECT_TEXT =
  /\b(?:created?|creator|built|developed|maintains?|project|software|language|repository|framework|product|invented?)\b/i;
const PUBLICATION_TEXT =
  /\b(?:published?|publication|paper|article|book|author(?:ed)?|wrote|writing|notes?|journal|proceedings)\b/i;
const ONLINE_TEXT = /\b(?:profile|account|website|homepage|github|repository|commit|domain|handle|online)\b/i;
const TIMELINE_TEXT =
  /\b(?:19|20)\d{2}\b|\b(?:current|currently|former|formerly|joined|since|until|historical|previously)\b/i;

/** Category admission uses quoted text plus deterministic source semantics, never model prose or metadata. */
export function evidenceSupportsFindingCategory(
  evidence: EvidenceRecord,
  candidate: Candidate,
  category: FindingDraft["category"],
): boolean {
  const text = normalizeWhitespace(evidence.excerpt ?? evidence.claim);
  if (!text) return false;
  switch (category) {
    case "identity":
      return labelOccursAsTokenPhrase(text, candidate.displayName);
    case "employment":
      return EMPLOYMENT_TEXT.test(text);
    case "education":
      return EDUCATION_TEXT.test(text);
    case "project":
      return PROJECT_TEXT.test(text);
    case "publication":
      return PUBLICATION_TEXT.test(text);
    case "online_presence":
      return (
        ONLINE_TEXT.test(text) ||
        ["official_profile", "professional_profile", "code_profile", "code_commit"].includes(evidence.sourceType)
      );
    case "timeline":
      return TIMELINE_TEXT.test(text);
    case "other":
      return true;
  }
}

/** Findings are extractive projections, never free model prose. */
export function isFindingGrounded(
  draft: Pick<FindingDraft, "title" | "description" | "category">,
  candidate: Candidate,
  supportingEvidence: readonly EvidenceRecord[],
): boolean {
  return (
    normalizeWhitespace(draft.title) === materializedFindingTitle(draft.category, candidate) &&
    normalizeWhitespace(draft.description) === materializedFindingDescription(supportingEvidence)
  );
}

export function validateReferentialIntegrity(
  state: Pick<InvestigationState, "candidates" | "evidence" | "findings"> &
    Partial<Pick<InvestigationState, "searchGraph" | "target">>,
): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const candidateIds = new Set(state.candidates.map((candidate) => candidate.id));
  const evidenceById = new Map(state.evidence.map((evidence) => [evidence.id, evidence]));
  const findingIds = new Set(state.findings.map((finding) => finding.id));

  for (const id of duplicates(state.candidates.map((candidate) => candidate.id))) {
    issues.push({
      code: "duplicate_candidate_id",
      path: "candidates",
      message: `candidate id ${id} occurs more than once`,
    });
  }
  for (const id of duplicates(state.evidence.map((evidence) => evidence.id))) {
    issues.push({
      code: "duplicate_evidence_id",
      path: "evidence",
      message: `evidence id ${id} occurs more than once`,
    });
  }
  for (const id of duplicates(state.findings.map((finding) => finding.id))) {
    issues.push({
      code: "duplicate_finding_id",
      path: "findings",
      message: `finding id ${id} occurs more than once`,
    });
  }

  state.evidence.forEach((evidence, index) => {
    if (!candidateIds.has(evidence.candidateId)) {
      issues.push({
        code: "unknown_candidate",
        path: `evidence[${index}].candidateId`,
        message: `evidence ${evidence.id} references unknown candidate ${evidence.candidateId}`,
      });
    }
  });

  state.candidates.forEach((candidate, candidateIndex) => {
    candidate.evidenceIds.forEach((evidenceId, evidenceIndex) => {
      const evidence = evidenceById.get(evidenceId);
      if (!evidence || evidence.candidateId !== candidate.id) {
        issues.push({
          code: "stale_candidate_evidence_link",
          path: `candidates[${candidateIndex}].evidenceIds[${evidenceIndex}]`,
          message: `${evidenceId} is missing or belongs to another candidate`,
        });
      }
    });
    candidate.signals.forEach((signal, signalIndex) => {
      const path = `candidates[${candidateIndex}].signals[${signalIndex}]`;
      if (signal.kind === "cross_source_match") {
        const source = signal.sourceEvidenceId ? evidenceById.get(signal.sourceEvidenceId) : undefined;
        const families = signal.sourceFamily?.startsWith("cross-source:")
          ? signal.sourceFamily.slice("cross-source:".length).split("+").filter(Boolean)
          : [];
        const candidateFamilies = new Set(
          state.evidence
            .filter(
              (evidence) =>
                evidence.candidateId === candidate.id &&
                evidence.disposition === "supports" &&
                evidence.verificationMethod === "direct_fetch",
            )
            .map((evidence) => evidence.sourceFamily),
        );
        if (
          signal.assurance !== "corroborated" ||
          signal.strength !== "strong" ||
          !source ||
          source.candidateId !== candidate.id ||
          families.length < 2 ||
          families.some((family) => !candidateFamilies.has(family))
        ) {
          issues.push({
            code: "candidate_signal_provenance_mismatch",
            path,
            message: "cross-source identity signal is not backed by two canonical candidate sources",
          });
        }
        return;
      }
      const source = signal.sourceEvidenceId ? evidenceById.get(signal.sourceEvidenceId) : undefined;
      if (
        signal.sourceEvidenceId
          ? !source || source.candidateId !== candidate.id || !identitySignalGroundedByEvidence(signal, source)
          : Boolean(signal.sourceFamily) ||
            signal.kind === "conflict" ||
            signal.assurance === "verified" ||
            signal.assurance === "corroborated"
      ) {
        issues.push({
          code: "candidate_signal_provenance_mismatch",
          path,
          message: "identity signal is not grounded by same-candidate evidence and canonical source family",
        });
      }
    });
    if (state.target) {
      const expectedScore = scoreCandidate(candidate, state.target);
      if (
        JSON.stringify(candidate.score) !== JSON.stringify(expectedScore) ||
        candidate.status !== candidateStatus(candidate.signals, expectedScore)
      ) {
        issues.push({
          code: "candidate_score_mismatch",
          path: `candidates[${candidateIndex}].score`,
          message: "candidate score/status does not match deterministic identity signals",
        });
      }
    }
  });

  state.findings.forEach((finding, findingIndex) => {
    if (!candidateIds.has(finding.candidateId)) {
      issues.push({
        code: "unknown_candidate",
        path: `findings[${findingIndex}].candidateId`,
        message: `finding ${finding.id} references unknown candidate ${finding.candidateId}`,
      });
    }
    const findingEvidence: EvidenceRecord[] = [];
    finding.evidenceIds.forEach((evidenceId, evidenceIndex) => {
      const evidence = evidenceById.get(evidenceId);
      if (!evidence) {
        issues.push({
          code: "unknown_evidence",
          path: `findings[${findingIndex}].evidenceIds[${evidenceIndex}]`,
          message: `finding ${finding.id} references unknown evidence ${evidenceId}`,
        });
        return;
      }
      findingEvidence.push(evidence);
      if (evidence.candidateId !== finding.candidateId) {
        issues.push({
          code: "cross_candidate_evidence",
          path: `findings[${findingIndex}].evidenceIds[${evidenceIndex}]`,
          message: `evidence ${evidenceId} belongs to ${evidence.candidateId}`,
        });
      }
      if (evidence.disposition === "discovery_only") {
        issues.push({
          code: "discovery_only_evidence",
          path: `findings[${findingIndex}].evidenceIds[${evidenceIndex}]`,
          message: `search/discovery evidence ${evidenceId} cannot support a finding`,
        });
      }
      if (evidence.disposition === "contradicts") {
        issues.push({
          code: "supporting_evidence_not_supporting",
          path: `findings[${findingIndex}].evidenceIds[${evidenceIndex}]`,
          message: `contradicting evidence ${evidenceId} must be listed as counter-evidence`,
        });
      }
    });

    finding.counterEvidenceIds.forEach((evidenceId, evidenceIndex) => {
      const evidence = evidenceById.get(evidenceId);
      if (!evidence) {
        issues.push({
          code: "unknown_evidence",
          path: `findings[${findingIndex}].counterEvidenceIds[${evidenceIndex}]`,
          message: `finding ${finding.id} references unknown counter-evidence ${evidenceId}`,
        });
        return;
      }
      findingEvidence.push(evidence);
      if (evidence.candidateId !== finding.candidateId) {
        issues.push({
          code: "cross_candidate_evidence",
          path: `findings[${findingIndex}].counterEvidenceIds[${evidenceIndex}]`,
          message: `counter-evidence ${evidenceId} belongs to ${evidence.candidateId}`,
        });
      }
      if (evidence.disposition !== "contradicts") {
        issues.push({
          code: "counter_evidence_not_contradicting",
          path: `findings[${findingIndex}].counterEvidenceIds[${evidenceIndex}]`,
          message: `counter-evidence ${evidenceId} is not marked as contradicting`,
        });
      }
    });

    for (const duplicateId of duplicates([...finding.evidenceIds, ...finding.counterEvidenceIds])) {
      issues.push({
        code: "duplicate_evidence_reference",
        path: `findings[${findingIndex}]`,
        message: `evidence ${duplicateId} appears more than once in the finding`,
      });
    }

    if (findingEvidence.length === finding.evidenceIds.length + finding.counterEvidenceIds.length) {
      const expected = assessConfidence(findingEvidence);
      if (
        expected.score !== finding.confidence.score ||
        expected.label !== finding.confidence.label ||
        expected.independentSourceFamilies.length !== finding.confidence.independentSourceFamilies.length ||
        !expected.independentSourceFamilies.every(
          (family, index) => family === finding.confidence.independentSourceFamilies[index],
        ) ||
        expected.supportingEvidenceIds.length !== finding.confidence.supportingEvidenceIds.length ||
        !expected.supportingEvidenceIds.every(
          (evidenceId, index) => evidenceId === finding.confidence.supportingEvidenceIds[index],
        ) ||
        expected.contradictingEvidenceIds.length !== finding.confidence.contradictingEvidenceIds.length ||
        !expected.contradictingEvidenceIds.every(
          (evidenceId, index) => evidenceId === finding.confidence.contradictingEvidenceIds[index],
        ) ||
        expected.appliedCaps.length !== finding.confidence.appliedCaps.length ||
        !expected.appliedCaps.every((cap, index) => cap === finding.confidence.appliedCaps[index])
      ) {
        issues.push({
          code: "confidence_mismatch",
          path: `findings[${findingIndex}].confidence`,
          message: "confidence metadata does not match deterministic evidence assessment",
        });
      }
    }
    const candidate = state.candidates.find((item) => item.id === finding.candidateId);
    if (
      candidate &&
      !findingEvidence
        .filter((evidence) => evidence.disposition === "supports")
        .some((evidence) => evidenceSupportsFindingCategory(evidence, candidate, finding.category))
    ) {
      issues.push({
        code: "unsupported_finding_category",
        path: `findings[${findingIndex}].category`,
        message: `finding ${finding.id} has no quoted evidence supporting ${finding.category}`,
      });
    }
    if (
      candidate &&
      !isFindingGrounded(
        finding,
        candidate,
        findingEvidence.filter((evidence) => evidence.disposition === "supports"),
      )
    ) {
      issues.push({
        code: "ungrounded_finding",
        path: `findings[${findingIndex}]`,
        message: `finding ${finding.id} introduces text not grounded in its supporting evidence`,
      });
    }
  });

  const categoriesByEvidence = new Map<string, Set<string>>();
  state.findings.forEach((finding) => {
    finding.evidenceIds.forEach((evidenceId) => {
      const categories = categoriesByEvidence.get(evidenceId) ?? new Set<string>();
      categories.add(finding.category);
      categoriesByEvidence.set(evidenceId, categories);
    });
  });
  for (const [evidenceId, categories] of categoriesByEvidence) {
    if (categories.size <= 1) continue;
    issues.push({
      code: "evidence_reused_across_categories",
      path: "findings",
      message: `evidence ${evidenceId} is reused across categories ${[...categories].sort().join(", ")}`,
    });
  }

  if (state.searchGraph) {
    const graph = state.searchGraph;
    const candidatesExplicitlySeparated = (leftCandidateId: string, rightCandidateId: string): boolean => {
      if (leftCandidateId === rightCandidateId) return false;
      const leftNode = graph.nodes.find((node) => node.kind === "candidate" && node.candidateId === leftCandidateId);
      const rightNode = graph.nodes.find((node) => node.kind === "candidate" && node.candidateId === rightCandidateId);
      if (!leftNode || !rightNode) return false;
      return graph.edges.some(
        (edge) =>
          edge.kind === "separates" &&
          ((edge.fromNodeId === leftNode.id && edge.toNodeId === rightNode.id) ||
            (edge.fromNodeId === rightNode.id && edge.toNodeId === leftNode.id)),
      );
    };
    graph.nodes.forEach((node, nodeIndex) => {
      if (node.candidateId !== null && !candidateIds.has(node.candidateId)) {
        issues.push({
          code: "unknown_candidate",
          path: `searchGraph.nodes[${nodeIndex}].candidateId`,
          message: `graph node ${node.id} references unknown candidate ${node.candidateId}`,
        });
      }
      if (node.evidenceId !== null && !evidenceById.has(node.evidenceId)) {
        issues.push({
          code: "unknown_evidence",
          path: `searchGraph.nodes[${nodeIndex}].evidenceId`,
          message: `graph node ${node.id} references unknown evidence ${node.evidenceId}`,
        });
      }
      if (node.findingId !== null && !findingIds.has(node.findingId)) {
        issues.push({
          code: "unknown_finding",
          path: `searchGraph.nodes[${nodeIndex}].findingId`,
          message: `graph node ${node.id} references unknown finding ${node.findingId}`,
        });
      }
      if (node.evidenceId !== null && node.actionId !== null) {
        const evidence = evidenceById.get(node.evidenceId);
        if (evidence && evidence.toolCallId !== node.actionId) {
          issues.push({
            code: "action_evidence_join_mismatch",
            path: `searchGraph.nodes[${nodeIndex}].actionId`,
            message: `graph action ${node.actionId} does not match evidence tool call ${evidence.toolCallId}`,
          });
        }
        if (evidence && node.candidateId !== evidence.candidateId) {
          issues.push({
            code: "graph_evidence_candidate_mismatch",
            path: `searchGraph.nodes[${nodeIndex}].candidateId`,
            message: `graph evidence candidate ${node.candidateId} does not match ${evidence.candidateId}`,
          });
        }
        const actionNode = graph.nodes.find(
          (candidate) => candidate.kind === "action" && candidate.actionId === node.actionId,
        );
        const frontierEntry = graph.frontier.find((entry) => entry.actionId === node.actionId);
        const boundCandidateId = actionNode?.candidateId ?? frontierEntry?.candidateId ?? null;
        if (
          evidence &&
          boundCandidateId !== null &&
          evidence.candidateId !== boundCandidateId &&
          !candidatesExplicitlySeparated(boundCandidateId, evidence.candidateId)
        ) {
          issues.push({
            code: "action_evidence_candidate_mismatch",
            path: `searchGraph.nodes[${nodeIndex}].candidateId`,
            message: `action ${node.actionId} is bound to ${boundCandidateId}, not ${evidence.candidateId}`,
          });
        }
      }
    });
    if (graph.seedNodeId !== null) {
      for (const candidate of state.candidates) {
        const nodes = graph.nodes.filter((node) => node.kind === "candidate" && node.candidateId === candidate.id);
        if (nodes.length !== 1) {
          issues.push({
            code: nodes.length === 0 ? "missing_graph_entity_node" : "duplicate_graph_entity_node",
            path: "searchGraph.nodes",
            message: `candidate ${candidate.id} requires exactly one entity node`,
          });
          continue;
        }
        const node = nodes[0];
        const allowedData = new Set(["entityKey"]);
        if (
          node.label !== candidate.displayName ||
          node.data.entityKey !== `candidate:${candidate.id}` ||
          Object.keys(node.data).some((key) => !allowedData.has(key))
        ) {
          issues.push({
            code: "graph_entity_projection_mismatch",
            path: `searchGraph.nodes[${graph.nodes.indexOf(node)}]`,
            message: `candidate node ${node.id} is not a canonical projection`,
          });
        }
      }
      for (const evidence of state.evidence) {
        const nodes = graph.nodes.filter((node) => node.kind === "evidence" && node.evidenceId === evidence.id);
        if (nodes.length !== 1) {
          issues.push({
            code: nodes.length === 0 ? "missing_graph_entity_node" : "duplicate_graph_entity_node",
            path: "searchGraph.nodes",
            message: `evidence ${evidence.id} requires exactly one entity node`,
          });
          continue;
        }
        const node = nodes[0];
        const allowedData = new Set([
          "classifiedSourceLaneId",
          "classifiedSourceTier",
          "classifiedSourceType",
          "contentHash",
          "disposition",
          "entityKey",
          "sourceFamily",
          "sourceType",
          "sourceUrl",
          "verificationMethod",
        ]);
        if (
          node.label !== evidence.claim ||
          node.candidateId !== evidence.candidateId ||
          node.actionId !== evidence.toolCallId ||
          node.data.sourceUrl !== evidence.sourceUrl ||
          node.data.sourceFamily !== evidence.sourceFamily ||
          node.data.sourceType !== evidence.sourceType ||
          node.data.disposition !== evidence.disposition ||
          node.data.contentHash !== evidence.contentHash ||
          node.data.classifiedSourceTier !== evidence.attributes.classifiedSourceTier ||
          node.data.classifiedSourceType !== evidence.attributes.classifiedSourceType ||
          node.data.classifiedSourceLaneId !== evidence.attributes.classifiedSourceLaneId ||
          node.data.entityKey !== `evidence:${evidence.id}` ||
          (node.data.verificationMethod !== undefined &&
            node.data.verificationMethod !== evidence.verificationMethod) ||
          Object.keys(node.data).some((key) => !allowedData.has(key))
        ) {
          issues.push({
            code: "graph_entity_projection_mismatch",
            path: `searchGraph.nodes[${graph.nodes.indexOf(node)}]`,
            message: `evidence node ${node.id} is not a canonical projection`,
          });
        }
        const sourceNodes = graph.nodes.filter(
          (candidate) => candidate.kind === "source" && candidate.evidenceId === evidence.id,
        );
        if (sourceNodes.length !== 1) {
          issues.push({
            code: sourceNodes.length === 0 ? "missing_graph_entity_node" : "duplicate_graph_entity_node",
            path: "searchGraph.nodes",
            message: `evidence ${evidence.id} requires exactly one canonical source node`,
          });
        } else {
          const sourceNode = sourceNodes[0];
          const allowedSourceData = new Set([
            "classifiedSourceLaneId",
            "classifiedSourceTier",
            "classifiedSourceType",
            "entityKey",
            "sourceFamily",
            "sourceType",
            "sourceUrl",
          ]);
          if (
            sourceNode.label !== (evidence.title ?? evidence.sourceFamily) ||
            sourceNode.candidateId !== evidence.candidateId ||
            sourceNode.actionId !== evidence.toolCallId ||
            sourceNode.frontierEntryId !== node.frontierEntryId ||
            sourceNode.sourceLaneId !== node.sourceLaneId ||
            sourceNode.sourceTier !== node.sourceTier ||
            sourceNode.data.sourceUrl !== evidence.sourceUrl ||
            sourceNode.data.sourceFamily !== evidence.sourceFamily ||
            sourceNode.data.sourceType !== evidence.sourceType ||
            sourceNode.data.classifiedSourceTier !== evidence.attributes.classifiedSourceTier ||
            sourceNode.data.classifiedSourceType !== evidence.attributes.classifiedSourceType ||
            sourceNode.data.classifiedSourceLaneId !== evidence.attributes.classifiedSourceLaneId ||
            sourceNode.data.entityKey !== `source:${evidence.id}` ||
            Object.keys(sourceNode.data).some((key) => !allowedSourceData.has(key))
          ) {
            issues.push({
              code: "graph_entity_projection_mismatch",
              path: `searchGraph.nodes[${graph.nodes.indexOf(sourceNode)}]`,
              message: `source node ${sourceNode.id} is not a canonical evidence projection`,
            });
          }
        }
        const entry = node.frontierEntryId
          ? graph.frontier.find((item) => item.id === node.frontierEntryId)
          : undefined;
        const lane = entry ? sourceLaneForFrontierEntry(entry) : undefined;
        const discoveryOnly = evidence.disposition === "discovery_only";
        const derivedTier = entry
          ? sourceTierForUrl(evidence.sourceUrl, evidence.sourceType, entry.sourceTier === 0)
          : null;
        const tierMismatch =
          entry?.sourceTier === 1
            ? false
            : derivedTier !== null && entry !== undefined && derivedTier !== entry.sourceTier;
        if (
          !entry ||
          !lane ||
          (!discoveryOnly && lane.admission === "discovery_only") ||
          (!discoveryOnly && !lane.sourceTypes.includes(evidence.sourceType)) ||
          (!discoveryOnly && tierMismatch)
        ) {
          issues.push({
            code: "evidence_source_lane_mismatch",
            path: `searchGraph.nodes[${graph.nodes.indexOf(node)}].sourceLaneId`,
            message: `evidence ${evidence.id} does not match its admitted source lane and tier`,
          });
        }
      }
      for (const finding of state.findings) {
        const nodes = graph.nodes.filter((node) => node.kind === "finding" && node.findingId === finding.id);
        if (nodes.length !== 1) {
          issues.push({
            code: nodes.length === 0 ? "missing_graph_entity_node" : "duplicate_graph_entity_node",
            path: "searchGraph.nodes",
            message: `finding ${finding.id} requires exactly one entity node`,
          });
          continue;
        }
        const node = nodes[0];
        const allowedData = new Set(["category", "confidence", "entityKey"]);
        if (
          node.label !== finding.title ||
          node.candidateId !== finding.candidateId ||
          node.data.category !== finding.category ||
          node.data.confidence !== finding.confidence.score ||
          node.data.entityKey !== `finding:${finding.id}` ||
          Object.keys(node.data).some((key) => !allowedData.has(key))
        ) {
          issues.push({
            code: "graph_entity_projection_mismatch",
            path: `searchGraph.nodes[${graph.nodes.indexOf(node)}]`,
            message: `finding node ${node.id} is not a canonical projection`,
          });
        }
      }
    }
    graph.frontier.forEach((entry, entryIndex) => {
      if (entry.candidateId !== null && !candidateIds.has(entry.candidateId)) {
        issues.push({
          code: "unknown_candidate",
          path: `searchGraph.frontier[${entryIndex}].candidateId`,
          message: `frontier ${entry.id} references unknown candidate ${entry.candidateId}`,
        });
      }
    });
    const candidateNodeById = new Map(
      graph.nodes
        .filter((node) => node.kind === "candidate" && node.candidateId !== null)
        .map((node) => [node.candidateId as string, node.id]),
    );
    const candidatesByName = new Map<string, string[]>();
    for (const candidate of state.candidates) {
      const group = candidatesByName.get(candidate.normalizedName) ?? [];
      group.push(candidate.id);
      candidatesByName.set(candidate.normalizedName, group);
    }
    for (const ids of candidatesByName.values()) {
      if (ids.length < 2 || ids.some((id) => !candidateNodeById.has(id))) continue;
      for (let leftIndex = 0; leftIndex < ids.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < ids.length; rightIndex += 1) {
          const leftNodeId = candidateNodeById.get(ids[leftIndex]) as string;
          const rightNodeId = candidateNodeById.get(ids[rightIndex]) as string;
          const separated = graph.edges.some(
            (edge) =>
              edge.kind === "separates" &&
              ((edge.fromNodeId === leftNodeId && edge.toNodeId === rightNodeId) ||
                (edge.fromNodeId === rightNodeId && edge.toNodeId === leftNodeId)),
          );
          if (!separated) {
            issues.push({
              code: "missing_candidate_separation_edge",
              path: "searchGraph.edges",
              message: `same-name candidates ${ids[leftIndex]} and ${ids[rightIndex]} are not separated`,
            });
          }
        }
      }
    }
  }

  return issues;
}

export function createFinding(
  draft: FindingDraft,
  candidates: readonly Candidate[],
  evidence: readonly EvidenceRecord[],
  ids: IdFactory,
  clock: Clock,
  allowedEmails: ReadonlySet<string> = new Set(),
  existingFindings: readonly Finding[] = [],
): Finding {
  const candidate = candidates.find((item) => item.id === draft.candidateId);
  if (!candidate) throw new Error(`unknown candidate ${draft.candidateId}`);

  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const uniqueEvidenceIds = [...new Set(draft.evidenceIds)].sort();
  const counterEvidenceIds = [...new Set(draft.counterEvidenceIds ?? [])].sort();
  if (counterEvidenceIds.some((id) => uniqueEvidenceIds.includes(id))) {
    throw new Error("the same evidence cannot be both supporting and counter-evidence");
  }
  if (uniqueEvidenceIds.length === 0) {
    throw new Error("a finding requires at least one admitted evidence record");
  }
  const findingEvidence = uniqueEvidenceIds.map((evidenceId) => {
    const record = evidenceById.get(evidenceId);
    if (!record) throw new Error(`unknown evidence ${evidenceId}`);
    if (record.candidateId !== candidate.id) {
      throw new Error(`evidence ${evidenceId} belongs to another candidate`);
    }
    if (record.disposition === "discovery_only") {
      throw new Error(`discovery-only evidence ${evidenceId} cannot support a finding`);
    }
    if (record.disposition !== "supports") {
      throw new Error(`evidence ${evidenceId} must be listed as counter-evidence`);
    }
    return record;
  });
  const counterEvidence = counterEvidenceIds.map((evidenceId) => {
    const record = evidenceById.get(evidenceId);
    if (!record) throw new Error(`unknown counter-evidence ${evidenceId}`);
    if (record.candidateId !== candidate.id) {
      throw new Error(`counter-evidence ${evidenceId} belongs to another candidate`);
    }
    if (record.disposition !== "contradicts") {
      throw new Error(`counter-evidence ${evidenceId} is not marked as contradicting`);
    }
    return record;
  });

  const title = normalizeWhitespace(draft.title);
  const description = normalizeWhitespace(draft.description);
  if (!title || !description) throw new TypeError("finding title and description are required");
  if (
    [title, description, ...(draft.caveats ?? [])].some((value) =>
      containsRestrictedPublicContent(value, { allowedEmails }),
    )
  ) {
    throw new TypeError("finding contains restricted personal content");
  }
  if (!findingEvidence.some((record) => evidenceSupportsFindingCategory(record, candidate, draft.category))) {
    throw new Error(`supporting evidence does not establish finding category ${draft.category}`);
  }
  const reusedAcrossCategory = existingFindings.find(
    (finding) =>
      finding.candidateId === candidate.id &&
      finding.category !== draft.category &&
      finding.evidenceIds.some((evidenceId) => uniqueEvidenceIds.includes(evidenceId)),
  );
  if (reusedAcrossCategory) {
    throw new Error(
      `evidence cannot be reused across finding categories (${reusedAcrossCategory.category} and ${draft.category})`,
    );
  }
  const materializedTitle = materializedFindingTitle(draft.category, candidate);
  const materializedDescription = materializedFindingDescription(findingEvidence);
  const caveats = [
    ...(findingEvidence.some((record) => record.spoofable)
      ? ["Supporting material includes spoofable or self-asserted source content."]
      : []),
    ...(counterEvidence.length > 0 ? ["Contradicting evidence is recorded separately."] : []),
  ];
  return {
    schemaVersion: SCHEMA_VERSION,
    id: ids.next("finding"),
    candidateId: candidate.id,
    title: materializedTitle,
    description: materializedDescription,
    category: draft.category,
    evidenceIds: uniqueEvidenceIds,
    counterEvidenceIds,
    confidence: assessConfidence([...findingEvidence, ...counterEvidence]),
    caveats,
    createdAt: clock.now(),
  };
}

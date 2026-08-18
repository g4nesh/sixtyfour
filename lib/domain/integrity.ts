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
import { containsRestrictedPublicContent } from "./content-policy";

export interface IntegrityIssue {
  code:
    | "duplicate_candidate_id"
    | "duplicate_evidence_id"
    | "duplicate_finding_id"
    | "unknown_candidate"
    | "unknown_evidence"
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

function materializedFindingTitle(
  category: FindingDraft["category"],
  candidate: Candidate,
): string {
  return `${FINDING_CATEGORY_LABEL[category]} — ${candidate.displayName}`;
}

function materializedFindingDescription(evidence: readonly EvidenceRecord[]): string {
  return [...new Set(evidence
    .map((item) => normalizeWhitespace(item.excerpt ?? item.claim))
    .filter(Boolean))]
    .slice(0, 3)
    .join(" ");
}

const EMPLOYMENT_TEXT = /\b(?:works?|worked|employed|joined|serves?|served|leads?|led|leadership|chair(?:man|woman)?|chief|officer|director|executive|engineer|fellow|founder|partner|curator|role|position)\b/i;
const EDUCATION_TEXT = /\b(?:university|college|school|degree|graduat(?:e|ed)|studied|education|alumn(?:us|a|i))\b/i;
const PROJECT_TEXT = /\b(?:created?|creator|built|developed|maintains?|project|software|language|repository|framework|product|invented?)\b/i;
const PUBLICATION_TEXT = /\b(?:published?|publication|paper|article|book|author(?:ed)?|wrote|writing|notes?|journal|proceedings)\b/i;
const ONLINE_TEXT = /\b(?:profile|account|website|homepage|github|repository|commit|domain|handle|online)\b/i;
const TIMELINE_TEXT = /\b(?:19|20)\d{2}\b|\b(?:current|currently|former|formerly|joined|since|until|historical|previously)\b/i;

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
      return ONLINE_TEXT.test(text)
        || ["official_profile", "professional_profile", "code_profile", "code_commit"]
          .includes(evidence.sourceType);
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
  return normalizeWhitespace(draft.title) === materializedFindingTitle(draft.category, candidate)
    && normalizeWhitespace(draft.description) === materializedFindingDescription(supportingEvidence);
}

export function validateReferentialIntegrity(
  state: Pick<InvestigationState, "candidates" | "evidence" | "findings">,
): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const candidateIds = new Set(state.candidates.map((candidate) => candidate.id));
  const evidenceById = new Map(state.evidence.map((evidence) => [evidence.id, evidence]));

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

    if (
      findingEvidence.length ===
      finding.evidenceIds.length + finding.counterEvidenceIds.length
    ) {
      const expected = assessConfidence(findingEvidence);
      if (
        expected.score !== finding.confidence.score
        || expected.label !== finding.confidence.label
        || expected.independentSourceFamilies.length !==
          finding.confidence.independentSourceFamilies.length
        || !expected.independentSourceFamilies.every((family, index) =>
          family === finding.confidence.independentSourceFamilies[index])
        || expected.supportingEvidenceIds.length !==
          finding.confidence.supportingEvidenceIds.length
        || !expected.supportingEvidenceIds.every((evidenceId, index) =>
          evidenceId === finding.confidence.supportingEvidenceIds[index])
        || expected.contradictingEvidenceIds.length !==
          finding.confidence.contradictingEvidenceIds.length
        || !expected.contradictingEvidenceIds.every((evidenceId, index) =>
          evidenceId === finding.confidence.contradictingEvidenceIds[index])
        || expected.appliedCaps.length !== finding.confidence.appliedCaps.length
        || !expected.appliedCaps.every((cap, index) =>
          cap === finding.confidence.appliedCaps[index])
      ) {
        issues.push({
          code: "confidence_mismatch",
          path: `findings[${findingIndex}].confidence`,
          message: "confidence metadata does not match deterministic evidence assessment",
        });
      }
    }
    const candidate = state.candidates.find((item) => item.id === finding.candidateId);
    if (candidate && !findingEvidence
      .filter((evidence) => evidence.disposition === "supports")
      .some((evidence) => evidenceSupportsFindingCategory(evidence, candidate, finding.category))) {
      issues.push({
        code: "unsupported_finding_category",
        path: `findings[${findingIndex}].category`,
        message: `finding ${finding.id} has no quoted evidence supporting ${finding.category}`,
      });
    }
    if (candidate && !isFindingGrounded(finding, candidate, findingEvidence.filter(
      (evidence) => evidence.disposition === "supports",
    ))) {
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
    [title, description, ...(draft.caveats ?? [])]
      .some((value) => containsRestrictedPublicContent(value, { allowedEmails }))
  ) {
    throw new TypeError("finding contains restricted personal content");
  }
  if (!findingEvidence.some((record) =>
    evidenceSupportsFindingCategory(record, candidate, draft.category))) {
    throw new Error(`supporting evidence does not establish finding category ${draft.category}`);
  }
  const reusedAcrossCategory = existingFindings.find((finding) =>
    finding.candidateId === candidate.id
    && finding.category !== draft.category
    && finding.evidenceIds.some((evidenceId) => uniqueEvidenceIds.includes(evidenceId)));
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
    ...(counterEvidence.length > 0
      ? ["Contradicting evidence is recorded separately."]
      : []),
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

import {
  clamp,
  labelOccursAsTokenPhrase,
  normalizeComparable,
  normalizeLabelTokens,
  normalizeOrganizationIdentity,
  normalizeWhitespace,
  roundScore,
} from "./runtime";
import {
  SCHEMA_VERSION,
  type Candidate,
  type CandidateDraft,
  type CandidateScoreBreakdown,
  type EvidenceRecord,
  type IdentitySignal,
  type IdentitySignalKind,
  type ParsedTarget,
} from "./types";
import { canonicalizeSourceUrl, isExactPersonalProfilePageScope } from "./evidence";
import {
  bareNameContextHypotheses,
  hasInterveningNamedSubject,
  matchBareContextRelation,
  matchPageScopedCompletedEducationRelation,
} from "./target";

const SIGNAL_WEIGHTS: Record<IdentitySignalKind, number> = {
  name: 0.18,
  email: 0.62,
  organization: 0.22,
  role: 0.14,
  location: 0.08,
  profile_url: 0.42,
  personal_domain: 0.4,
  social_handle: 0.2,
  github_commit_email: 0.34,
  keybase_proof: 0.58,
  cross_profile_link: 0.45,
  cross_source_match: 0.45,
  bio_phrase: 0.1,
  conflict: 0,
};

const MERGE_GRADE_SIGNAL_KINDS = new Set<IdentitySignalKind>([
  "email",
  "profile_url",
  "personal_domain",
  "keybase_proof",
  "cross_profile_link",
]);

const CONTEXT_CORROBORATION_SIGNAL_KINDS = new Set<IdentitySignalKind>([
  "name",
  "organization",
  "role",
  "location",
  "bio_phrase",
]);

const HUMAN_LABEL_SIGNAL_KINDS = new Set<IdentitySignalKind>([
  "name",
  "organization",
  "role",
  "location",
  "bio_phrase",
]);

export interface CandidateContextCorroboration {
  score: number;
  evidenceIds: string[];
  sourceFamilies: string[];
  authoritativeSourceFamilies: string[];
  matchedContextKeys: string[];
  allSourcesSpoofable: boolean;
  contextBasis: "explicit_target" | "bare_name_context_hypothesis";
  decision: "resolved_eligible" | "probable";
  decisionBasis:
    | "two_authoritative_families"
    | "authoritative_plus_identifier"
    | "needs_nonspoofable_authority"
    | "needs_second_family"
    | "context_only";
  identifierEvidenceIds: string[];
}

export const CONTEXT_CORROBORATION_PROBABLE_CAP = 0.77;
export const CONTEXT_CORROBORATION_ONE_FAMILY_CAP = 0.62;

const STRUCTURALLY_AUTHORITATIVE_CONTEXT_SOURCE_TYPES = new Set(["official_profile", "company_page"]);

function isResolutionGrade(signal: IdentitySignal): boolean {
  return (
    isMergeGrade(signal) ||
    (signal.kind === "cross_source_match" &&
      signal.strength === "strong" &&
      signal.assurance === "corroborated" &&
      signal.sourceFamily?.startsWith("cross-source:") === true &&
      Boolean(signal.sourceEvidenceId))
  );
}

function signalKey(signal: IdentitySignal): string {
  return [signal.kind, signal.normalizedValue, signal.sourceFamily ?? ""].join("|");
}

export function normalizeSignal(signal: IdentitySignal): IdentitySignal {
  const value = normalizeWhitespace(signal.value);
  return {
    ...signal,
    value,
    normalizedValue: signal.normalizedValue ? normalizeComparable(signal.normalizedValue) : normalizeComparable(value),
    ...(signal.sourceFamily ? { sourceFamily: signal.sourceFamily.toLocaleLowerCase("en-US") } : {}),
  };
}

export function dedupeSignals(signals: readonly IdentitySignal[]): IdentitySignal[] {
  const byKey = new Map<string, IdentitySignal>();
  const strengthRank = { weak: 0, medium: 1, strong: 2 } as const;
  const assuranceRank = {
    spoofable: 0,
    self_asserted: 1,
    corroborated: 2,
    verified: 3,
  } as const;

  for (const rawSignal of signals) {
    const signal = normalizeSignal(rawSignal);
    if (!signal.value || !signal.normalizedValue) continue;
    const key = signalKey(signal);
    const current = byKey.get(key);
    if (
      !current ||
      strengthRank[signal.strength] > strengthRank[current.strength] ||
      (strengthRank[signal.strength] === strengthRank[current.strength] &&
        assuranceRank[signal.assurance] > assuranceRank[current.assurance])
    ) {
      byKey.set(key, signal);
    }
  }

  return [...byKey.values()].sort((left, right) => {
    const leftKey = signalKey(left);
    const rightKey = signalKey(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function matchesTarget(signal: IdentitySignal, target: ParsedTarget): boolean {
  switch (signal.kind) {
    case "name":
      return Boolean(target.normalizedName && signal.normalizedValue === target.normalizedName);
    case "email":
    case "github_commit_email":
      return target.identifiers.some(
        (identifier) => identifier.kind === "email" && identifier.normalizedValue === signal.normalizedValue,
      );
    case "organization":
      return target.organizationHints.some((organization) => organization.normalizedName === signal.normalizedValue);
    case "role":
      return target.roleHints.some((role) => normalizeComparable(role) === signal.normalizedValue);
    case "location":
      return target.locationHints.some((location) => normalizeComparable(location) === signal.normalizedValue);
    case "conflict":
      return true;
    default:
      // Proof/link signals are useful because their meaning is the connection
      // itself, not because their value was present in the original query.
      return true;
  }
}

function isIndependent(signal: IdentitySignal): boolean {
  return Boolean(signal.sourceFamily && signal.sourceEvidenceId) || signal.kind === "email" || signal.kind === "name";
}

/**
 * Tool-proposed identity signals become trust-bearing only when their value,
 * candidate, and source family are all grounded by one admitted record.
 */
export function identitySignalGroundedByEvidence(signal: IdentitySignal, evidence: EvidenceRecord): boolean {
  if (
    evidence.disposition !== (signal.kind === "conflict" ? "contradicts" : "supports") ||
    evidence.sourceType === "search_result" ||
    signal.sourceEvidenceId !== evidence.id ||
    signal.sourceFamily?.toLocaleLowerCase("en-US") !== evidence.sourceFamily
  )
    return false;
  const needle = normalizeComparable(signal.value);
  const compactNeedle = needle.replace(/\s+/g, "");
  const codePointLength = Array.from(compactNeedle).length;
  const shortNonLatinName = signal.kind === "name" && codePointLength >= 2 && /[^\p{ASCII}]/u.test(compactNeedle);
  if (codePointLength < 3 && !shortNonLatinName) return false;
  const rawMaterial = [
    evidence.claim,
    evidence.excerpt ?? "",
    evidence.title ?? "",
    evidence.publisher ?? "",
    evidence.sourceUrl,
    evidence.canonicalUrl,
    evidence.canonicalSubset ? JSON.stringify(evidence.canonicalSubset) : "",
    JSON.stringify(evidence.attributes),
  ];
  if (signal.kind === "profile_url" || signal.kind === "personal_domain") {
    try {
      const proposed = new URL(signal.value);
      if (proposed.protocol !== "https:") return false;
      if (signal.kind === "profile_url") {
        const canonical = proposed.toString().replace(/\/$/, "");
        return [evidence.sourceUrl, evidence.canonicalUrl]
          .map((value) => {
            try {
              return new URL(value).toString().replace(/\/$/, "");
            } catch {
              return "";
            }
          })
          .includes(canonical);
      }
      const host = proposed.hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
      return [evidence.sourceUrl, evidence.canonicalUrl].some((value) => {
        try {
          const evidenceHost = new URL(value).hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
          return evidenceHost === host;
        } catch {
          return false;
        }
      });
    } catch {
      return false;
    }
  }
  if (signal.kind === "email" || signal.kind === "github_commit_email") {
    const email = signal.value.toLocaleLowerCase("en-US");
    return rawMaterial.some((value) => value.toLocaleLowerCase("en-US").includes(email));
  }
  if (HUMAN_LABEL_SIGNAL_KINDS.has(signal.kind)) {
    return rawMaterial.some((value) => labelOccursAsTokenPhrase(value, signal.value));
  }
  const tokenPhrase = ` ${needle} `;
  return rawMaterial.some((value) => ` ${normalizeComparable(value)} `.includes(tokenPhrase));
}

interface RequestedContextSignal {
  key: string;
  kind: Extract<IdentitySignalKind, "name" | "organization" | "role" | "location" | "bio_phrase">;
  value: string;
  normalizedValue: string;
}

function requestedContextSignals(
  candidate: Candidate,
  target: ParsedTarget,
): { basis: CandidateContextCorroboration["contextBasis"]; signals: RequestedContextSignal[] } | null {
  if (target.kind !== "named_person" || !target.normalizedName) return null;
  if (candidate.normalizedName !== target.normalizedName) {
    const hypothesis = bareNameContextHypotheses(target).find(
      (item) => item.normalizedSubjectName === candidate.normalizedName,
    );
    if (!hypothesis) return null;
    return {
      basis: "bare_name_context_hypothesis",
      signals: [
        {
          key: `name:${hypothesis.normalizedSubjectName}`,
          kind: "name",
          value: hypothesis.subjectName,
          normalizedValue: hypothesis.normalizedSubjectName,
        },
        {
          key: `bio_phrase:${hypothesis.normalizedContextPhrase}`,
          kind: "bio_phrase",
          value: hypothesis.contextPhrase,
          normalizedValue: hypothesis.normalizedContextPhrase,
        },
      ],
    };
  }
  const requested: RequestedContextSignal[] = [
    {
      key: `name:${target.normalizedName}`,
      kind: "name",
      value: target.name ?? target.normalizedName,
      normalizedValue: target.normalizedName,
    },
    ...target.organizationHints.map((organization) => ({
      key: `organization:${organization.normalizedName}`,
      kind: "organization" as const,
      value: organization.name,
      normalizedValue: organization.normalizedName,
    })),
    ...target.roleHints.map((role) => ({
      key: `role:${normalizeComparable(role)}`,
      kind: "role" as const,
      value: role,
      normalizedValue: normalizeComparable(role),
    })),
    ...target.locationHints.map((location) => ({
      key: `location:${normalizeComparable(location)}`,
      kind: "location" as const,
      value: location,
      normalizedValue: normalizeComparable(location),
    })),
  ];
  return {
    basis: "explicit_target",
    signals: [...new Map(requested.map((item) => [item.key, item])).values()],
  };
}

function isResolutionEvidence(record: EvidenceRecord, candidate: Candidate): boolean {
  return (
    record.candidateId === candidate.id &&
    candidate.evidenceIds.includes(record.id) &&
    record.disposition === "supports" &&
    record.sourceType !== "search_result" &&
    record.verificationMethod === "direct_fetch" &&
    record.reliability >= 0.45 &&
    record.httpStatus === 200 &&
    /^sha256:[a-f0-9]{64}$/.test(record.contentHash ?? "") &&
    Boolean(record.excerpt) &&
    record.claim === record.excerpt
  );
}

/**
 * Recompute the title/body page-scoped education contract from durable ledger
 * fields. The scope attribute selects the contract but cannot satisfy it: URL
 * shape, unchanged authorization, exact fetched title, exact body claim,
 * completion time, low trust, and candidate ownership are all checked again.
 */
export function isPageScopedCompletedEducationEvidence(
  record: EvidenceRecord,
  candidate: Candidate,
  subjectName: string,
  contextPhrase: string,
): boolean {
  const authorizedUrl = record.attributes.pageScopedAuthorizedUrl;
  const rawProof = record.canonicalSubset?.pageScopedEducationProof;
  const proof =
    typeof rawProof === "object" && rawProof !== null && !Array.isArray(rawProof)
      ? (rawProof as Record<string, unknown>)
      : null;
  const safetyWindow = proof?.safetyWindow;
  if (
    record.attributes.pageScopedSubjectScope !== "exact_fetched_title_personal_profile" ||
    record.attributes.extractionMethod !== "deterministic_page_scoped_completed_education" ||
    normalizeLabelTokens(String(record.attributes.matchedBareContextPhrase ?? "")) !==
      normalizeLabelTokens(contextPhrase) ||
    record.attributes.matchedBareContextRelation !== "alumni" ||
    record.attributes.extractiveClaim !== true ||
    typeof authorizedUrl !== "string" ||
    record.candidateId !== candidate.id ||
    !candidate.evidenceIds.includes(record.id) ||
    normalizeLabelTokens(candidate.displayName) !== normalizeLabelTokens(subjectName) ||
    record.disposition !== "supports" ||
    record.sourceType !== "other" ||
    record.verificationMethod !== "direct_fetch" ||
    record.temporalStatus !== "historical" ||
    record.httpStatus !== 200 ||
    !/^sha256:[a-f0-9]{64}$/.test(record.contentHash ?? "") ||
    record.claim !== record.excerpt ||
    record.reliability !== 0.55 ||
    record.spoofable !== true ||
    record.attributes.untrustedContent !== true ||
    record.attributes.fullBodyRetained !== false ||
    record.attributes.ownershipVerified !== false ||
    record.canonicalSubset?.mimeType !== "text/html" ||
    proof?.schemaVersion !== "page_scoped_completed_education_v1" ||
    typeof safetyWindow !== "string" ||
    safetyWindow.length === 0 ||
    safetyWindow.length > 640 ||
    proof.safetyWindowLength !== safetyWindow.length ||
    proof.fullTextContentHash !== record.contentHash ||
    typeof proof.fullTextLength !== "number" ||
    !Number.isInteger(proof.fullTextLength) ||
    proof.fullTextLength < safetyWindow.length ||
    proof.fullTextLength > 200_000 ||
    proof.fetchedTitle !== record.title ||
    proof.observedAt !== record.observedAt ||
    proof.authorizedUrl !== authorizedUrl ||
    typeof proof.finalUrl !== "string" ||
    proof.explicitMinorMarkersAbsent !== true ||
    proof.requestedContextContradictionAbsent !== true ||
    typeof record.observedAt !== "string" ||
    !record.title ||
    !isExactPersonalProfilePageScope(record.sourceUrl, record.title, subjectName) ||
    matchPageScopedCompletedEducationRelation(record.claim, contextPhrase, record.observedAt, safetyWindow) !== "alumni"
  )
    return false;
  try {
    const canonicalRecordUrl = canonicalizeSourceUrl(record.sourceUrl);
    return (
      canonicalizeSourceUrl(authorizedUrl) === canonicalRecordUrl &&
      canonicalizeSourceUrl(proof.finalUrl) === canonicalRecordUrl
    );
  } catch {
    return false;
  }
}

export interface CrossSourceEvidenceIdentityTuple {
  subject: string;
  organization: string;
  normalizedSubject: string;
  normalizedOrganization: string;
}

/**
 * Recompute the exact subject/organization tuple carried by one hardened
 * candidate-bound record. Extractor attributes are only selectors: both
 * labels must occur in the immutable exact claim before they can participate
 * in a derived cross-source identity signal.
 */
export function crossSourceEvidenceIdentityTuple(
  record: EvidenceRecord,
  candidate: Candidate,
): CrossSourceEvidenceIdentityTuple | null {
  const subjectAttribute = record.attributes.extractedSubjectName;
  const organizationAttribute = record.attributes.extractedOrganization;
  const subject = typeof subjectAttribute === "string" ? normalizeWhitespace(subjectAttribute) : "";
  const organization = typeof organizationAttribute === "string" ? normalizeWhitespace(organizationAttribute) : "";
  if (
    !subject ||
    !organization ||
    record.candidateId !== candidate.id ||
    !candidate.evidenceIds.includes(record.id) ||
    record.disposition !== "supports" ||
    record.sourceType === "search_result" ||
    record.verificationMethod !== "direct_fetch" ||
    record.attributes.untrustedContent !== true ||
    record.httpStatus !== 200 ||
    !/^sha256:[a-f0-9]{64}$/.test(record.contentHash ?? "") ||
    !record.excerpt ||
    record.claim !== record.excerpt ||
    normalizeLabelTokens(candidate.displayName) !== normalizeLabelTokens(subject) ||
    !labelOccursAsTokenPhrase(record.claim, subject) ||
    !labelOccursAsTokenPhrase(record.claim, organization)
  )
    return null;

  const normalizedSubject = normalizeLabelTokens(subject);
  const normalizedOrganization = normalizeOrganizationIdentity(organization);
  if (!normalizedSubject || !normalizedOrganization) return null;
  return { subject, organization, normalizedSubject, normalizedOrganization };
}

function regexPhrase(value: string): string {
  return normalizeWhitespace(value)
    .split(/\s+/u)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
}

function claimRelatesSubjectToContext(
  claim: string,
  subject: RequestedContextSignal,
  context: RequestedContextSignal,
): boolean {
  if (!labelOccursAsTokenPhrase(claim, subject.value) || !labelOccursAsTokenPhrase(claim, context.value)) return false;
  if (hasInterveningNamedSubject(claim, subject.value, context.value)) return false;
  const subjectPattern = regexPhrase(subject.value);
  const contextPattern = regexPhrase(context.value);
  const bounded = "[^.!?;]{0,220}";
  if (context.kind === "organization") {
    return [
      new RegExp(
        `${subjectPattern}${bounded}(?:works|worked|serves|served|researches|researched|joined|led|leads|founded|co[- ]?founded)${bounded}(?:at|for|with|of)?${bounded}${contextPattern}`,
        "iu",
      ),
      new RegExp(
        `${subjectPattern}${bounded}(?:attends|attended|studies|studied)\\s+at${bounded}${contextPattern}`,
        "iu",
      ),
      new RegExp(
        `${subjectPattern}${bounded}(?:graduated\\s+from|alumn(?:us|a|i)\\s+of)${bounded}${contextPattern}`,
        "iu",
      ),
      new RegExp(
        `${subjectPattern}${bounded}(?:is|was|became|remains)\\s+(?:(?:an?|the)\\s+)?(?:researcher|scientist|engineer|founder|executive|director|professor|employee|intern|fellow|advisor|consultant)${bounded}(?:at|for|with|of)${bounded}${contextPattern}`,
        "iu",
      ),
    ].some((pattern) => pattern.test(claim));
  }
  if (context.kind === "role") {
    return [
      new RegExp(
        `${subjectPattern}${bounded}(?:is|was|became|remains|serves\\s+as|served\\s+as|works\\s+as|worked\\s+as)${bounded}${contextPattern}`,
        "iu",
      ),
      new RegExp(`${contextPattern}\\s*(?:[,—-]\\s*)?${subjectPattern}`, "iu"),
    ].some((pattern) => pattern.test(claim));
  }
  if (context.kind === "location") {
    return new RegExp(
      `${subjectPattern}${bounded}(?:(?:is|was|works|worked|serves|served|studies|studied|lives|resides)${bounded})?(?:based\\s+in|located\\s+in|in|from)\\s+${contextPattern}`,
      "iu",
    ).test(claim);
  }
  return context.kind === "bio_phrase";
}

/**
 * Assess whether direct evidence has corroborated the exact requested person
 * context strongly enough to resolve one already-separated candidate branch.
 *
 * This is not a merge rule. The exact target name and every explicit
 * organization, role, and location constraint must be grounded by admitted
 * same-candidate signals. Every requested non-name constraint must be quoted
 * with the exact subject by at least two canonical source families. Formal
 * resolution additionally requires at least one genuinely non-spoofable
 * authoritative direct record, plus either two structurally authoritative
 * families or one such family and a strong identifier grounded by another
 * exact fetched record. Repeated arbitrary/self-asserted pages and spoofable
 * structural-looking routes remain probable leads below the formal threshold.
 * One exact direct family may surface as a bounded lead, but is capped
 * separately and can never resolve. Search snippets, forged metadata, and
 * relevant contradiction fail closed.
 */
export function assessCandidateContextCorroboration(
  candidate: Candidate,
  evidence: readonly EvidenceRecord[],
  target: ParsedTarget,
): CandidateContextCorroboration | null {
  const request = requestedContextSignals(candidate, target);
  if (!request) return null;
  const requested = request.signals;
  const requestedContext = requested.filter((item) => item.kind !== "name");
  const requestedSubject = requested.find((item) => item.kind === "name");
  if (!requestedSubject || requestedContext.length === 0 || candidate.status === "rejected") return null;

  const candidateEvidence = evidence.filter((record) => record.candidateId === candidate.id);
  const requestedContextLabels = requestedContext.map((item) => item.normalizedValue);
  if (
    candidateEvidence.some(
      (record) =>
        candidate.evidenceIds.includes(record.id) &&
        record.disposition === "contradicts" &&
        record.sourceType !== "search_result" &&
        record.verificationMethod === "direct_fetch" &&
        record.reliability >= 0.45 &&
        record.httpStatus === 200 &&
        /^sha256:[a-f0-9]{64}$/.test(record.contentHash ?? "") &&
        Boolean(record.excerpt) &&
        record.claim === record.excerpt &&
        labelOccursAsTokenPhrase(record.claim, requestedSubject.value) &&
        requestedContextLabels.some((label) => labelOccursAsTokenPhrase(record.claim, label)),
    )
  )
    return null;

  const resolutionEvidence = new Map(
    candidateEvidence.filter((record) => isResolutionEvidence(record, candidate)).map((record) => [record.id, record]),
  );
  const requestedByKind = new Map<IdentitySignalKind, RequestedContextSignal[]>();
  for (const item of requested) {
    const matches = requestedByKind.get(item.kind) ?? [];
    matches.push(item);
    requestedByKind.set(item.kind, matches);
  }

  const matchedKeys = new Set<string>();
  const matchedEvidence = new Map<string, EvidenceRecord>();
  const supportFamiliesByKey = new Map<string, Set<string>>();
  for (const signal of candidate.signals) {
    if (!CONTEXT_CORROBORATION_SIGNAL_KINDS.has(signal.kind) || !signal.sourceEvidenceId) continue;
    const record = resolutionEvidence.get(signal.sourceEvidenceId);
    if (!record || !identitySignalGroundedByEvidence(signal, record)) continue;
    const match = (requestedByKind.get(signal.kind) ?? []).find(
      (item) => item.normalizedValue === signal.normalizedValue,
    );
    const pageScopedEducationContext = requestedContext.find(
      (item) =>
        item.kind === "bio_phrase" &&
        isPageScopedCompletedEducationEvidence(record, candidate, requestedSubject.value, item.value),
    );
    const pageScopedSubject = Boolean(pageScopedEducationContext);
    const signalValueAttested =
      labelOccursAsTokenPhrase(record.claim, signal.value) || (match?.kind === "name" && pageScopedSubject);
    const subjectAttested = labelOccursAsTokenPhrase(record.claim, requestedSubject.value) || pageScopedSubject;
    const bareContextRelationAttested =
      match?.kind !== "bio_phrase" ||
      matchBareContextRelation(record.claim, requestedSubject.value, match.value) !== null ||
      isPageScopedCompletedEducationEvidence(record, candidate, requestedSubject.value, match.value);
    if (
      !match ||
      !signalValueAttested ||
      (match.kind !== "name" && !subjectAttested) ||
      (match.kind === "bio_phrase" &&
        (typeof record.attributes.matchedBareContextPhrase !== "string" ||
          normalizeComparable(record.attributes.matchedBareContextPhrase) !== match.normalizedValue ||
          !bareContextRelationAttested)) ||
      (match.kind !== "name" &&
        match.kind !== "bio_phrase" &&
        !claimRelatesSubjectToContext(record.claim, requestedSubject, match))
    )
      continue;
    matchedKeys.add(match.key);
    matchedEvidence.set(record.id, record);
    const supportFamilies = supportFamiliesByKey.get(match.key) ?? new Set<string>();
    supportFamilies.add(record.sourceFamily);
    supportFamiliesByKey.set(match.key, supportFamilies);
  }

  if (requested.some((item) => !matchedKeys.has(item.key))) return null;
  const families = [...new Set([...matchedEvidence.values()].map((record) => record.sourceFamily))].sort();
  if (families.length === 0) return null;
  const hasTwoFamiliesPerRequestedSignal = requested.every(
    (item) => (supportFamiliesByKey.get(item.key)?.size ?? 0) >= 2,
  );
  const authoritativeFamilies = [
    ...new Set(
      [...matchedEvidence.values()]
        .filter((record) => STRUCTURALLY_AUTHORITATIVE_CONTEXT_SOURCE_TYPES.has(record.sourceType))
        .map((record) => record.sourceFamily),
    ),
  ].sort();
  const nonSpoofableAuthoritativeFamilies = [
    ...new Set(
      [...matchedEvidence.values()]
        .filter(
          (record) =>
            record.spoofable === false && STRUCTURALLY_AUTHORITATIVE_CONTEXT_SOURCE_TYPES.has(record.sourceType),
        )
        .map((record) => record.sourceFamily),
    ),
  ].sort();
  const allSourcesSpoofable = [...matchedEvidence.values()].every((record) => record.spoofable);
  const evidenceById = new Map(candidateEvidence.map((record) => [record.id, record]));
  const identifierEvidenceIds = [
    ...new Set(
      candidate.signals.filter(isMergeGrade).flatMap((signal) => {
        if (!signal.sourceEvidenceId) return [];
        const record = evidenceById.get(signal.sourceEvidenceId);
        return record &&
          isResolutionEvidence(record, candidate) &&
          record.reliability >= 0.55 &&
          labelOccursAsTokenPhrase(record.claim, requestedSubject.value) &&
          identitySignalGroundedByEvidence(signal, record)
          ? [record.id]
          : [];
      }),
    ),
  ].sort();
  const hasIndependentIdentifier = identifierEvidenceIds.some((evidenceId) => {
    const identifierFamily = evidenceById.get(evidenceId)?.sourceFamily;
    return Boolean(identifierFamily && !authoritativeFamilies.includes(identifierFamily));
  });
  const resolutionEligible =
    hasTwoFamiliesPerRequestedSignal &&
    nonSpoofableAuthoritativeFamilies.length >= 1 &&
    (authoritativeFamilies.length >= 2 || (authoritativeFamilies.length >= 1 && hasIndependentIdentifier));
  const decisionBasis: CandidateContextCorroboration["decisionBasis"] = !hasTwoFamiliesPerRequestedSignal
    ? "needs_second_family"
    : nonSpoofableAuthoritativeFamilies.length === 0 && authoritativeFamilies.length >= 1
      ? "needs_nonspoofable_authority"
      : authoritativeFamilies.length >= 2
        ? "two_authoritative_families"
        : authoritativeFamilies.length >= 1 && hasIndependentIdentifier
          ? "authoritative_plus_identifier"
          : "context_only";

  const records = [...matchedEvidence.values()];
  const averageReliability = records.reduce((total, record) => total + record.reliability, 0) / records.length;
  // Evidence-weighted identity decision score: exact name and complete requested
  // context form the base, while independent families, source reliability,
  // and structural-authority breadth determine how far above the resolution threshold
  // the candidate can move. Eligibility gates above do the safety work; this
  // score only ranks eligible candidate branches against one another.
  const rawScore = roundScore(
    clamp(
      0.32 +
        0.22 +
        Math.min(1, families.length / 3) * 0.18 +
        averageReliability * 0.16 +
        Math.min(1, authoritativeFamilies.length / 2) * 0.12,
    ),
  );
  const score = resolutionEligible
    ? rawScore
    : Math.min(
        rawScore,
        hasTwoFamiliesPerRequestedSignal ? CONTEXT_CORROBORATION_PROBABLE_CAP : CONTEXT_CORROBORATION_ONE_FAMILY_CAP,
      );
  return {
    score,
    evidenceIds: [...matchedEvidence.keys()].sort(),
    sourceFamilies: families,
    authoritativeSourceFamilies: authoritativeFamilies,
    matchedContextKeys: [...matchedKeys].sort(),
    allSourcesSpoofable,
    contextBasis: request.basis,
    decision: resolutionEligible ? "resolved_eligible" : "probable",
    decisionBasis,
    identifierEvidenceIds,
  };
}

export const QUERY_SUBJECT_ANCHOR_ATTRIBUTE = "querySubjectAnchor" as const;

export type QuerySubjectAnchorResolution =
  | { kind: "none"; candidates: [] }
  | { kind: "unique"; candidates: [Candidate]; candidate: Candidate; evidence: EvidenceRecord }
  | { kind: "ambiguous"; candidates: Candidate[] };

/**
 * Locate the run-local neutral subject created for a named-person query.
 *
 * This is intentionally not a same-name merge rule. An eligible anchor must
 * retain the exact weak/self-asserted target-name signal and own an admitted
 * discovery record carrying Atlas's server-authored query-anchor marker. A
 * quarantined fetched subject is never eligible, even if later data happens
 * to repeat the target name. Multiple eligible anchors fail closed.
 */
export function resolveQuerySubjectAnchor(
  state: Pick<{ candidates: Candidate[]; evidence: EvidenceRecord[] }, "candidates" | "evidence">,
  target: ParsedTarget,
): QuerySubjectAnchorResolution {
  if (target.kind !== "named_person" || !target.normalizedName) return { kind: "none", candidates: [] };

  const evidenceByCandidate = new Map<string, EvidenceRecord[]>();
  for (const evidence of state.evidence) {
    const records = evidenceByCandidate.get(evidence.candidateId) ?? [];
    records.push(evidence);
    evidenceByCandidate.set(evidence.candidateId, records);
  }

  const anchors = state.candidates.filter((candidate) => {
    if (candidate.normalizedName !== target.normalizedName) return false;
    if (
      !candidate.signals.some(
        (signal) =>
          signal.kind === "name" &&
          signal.normalizedValue === target.normalizedName &&
          signal.strength === "weak" &&
          signal.assurance === "self_asserted" &&
          !signal.sourceEvidenceId,
      )
    )
      return false;

    const records = evidenceByCandidate.get(candidate.id) ?? [];
    if (
      records.some(
        (evidence) =>
          typeof evidence.attributes.quarantinedFromCandidateId === "string" &&
          evidence.attributes.quarantinedFromCandidateId.length > 0,
      )
    )
      return false;

    return records.some(
      (evidence) =>
        candidate.evidenceIds.includes(evidence.id) &&
        evidence.sourceType === "search_result" &&
        evidence.disposition === "discovery_only" &&
        evidence.verificationMethod === "search_discovery" &&
        evidence.attributes[QUERY_SUBJECT_ANCHOR_ATTRIBUTE] === true &&
        typeof evidence.attributes.querySubjectName === "string" &&
        normalizeComparable(evidence.attributes.querySubjectName) === target.normalizedName,
    );
  });

  if (anchors.length === 0) return { kind: "none", candidates: [] };
  if (anchors.length > 1) return { kind: "ambiguous", candidates: anchors };
  const candidate = anchors[0];
  const evidence = (evidenceByCandidate.get(candidate.id) ?? []).find(
    (record) =>
      record.sourceType === "search_result" &&
      record.disposition === "discovery_only" &&
      record.verificationMethod === "search_discovery" &&
      record.attributes[QUERY_SUBJECT_ANCHOR_ATTRIBUTE] === true &&
      typeof record.attributes.querySubjectName === "string" &&
      normalizeComparable(record.attributes.querySubjectName) === target.normalizedName,
  );
  if (!evidence) return { kind: "none", candidates: [] };
  return { kind: "unique", candidates: [candidate], candidate, evidence };
}

function isMergeGrade(signal: IdentitySignal): boolean {
  return (
    MERGE_GRADE_SIGNAL_KINDS.has(signal.kind) &&
    signal.strength === "strong" &&
    (signal.assurance === "verified" || signal.assurance === "corroborated")
  );
}

export function scoreCandidate(
  candidate: Pick<Candidate, "displayName" | "signals">,
  target: ParsedTarget,
): CandidateScoreBreakdown {
  const signals = dedupeSignals(candidate.signals);
  const nameSignal: IdentitySignal | undefined = target.normalizedName
    ? {
        kind: "name",
        value: candidate.displayName,
        normalizedValue: normalizeComparable(candidate.displayName),
        strength: "weak",
        assurance: "self_asserted",
      }
    : undefined;
  const scoredSignals = dedupeSignals(nameSignal ? [nameSignal, ...signals] : signals);
  const positiveByFamily = new Map<string, { weight: number; signal: IdentitySignal }>();
  const conflicting: IdentitySignal[] = [];
  if (target.normalizedName && normalizeComparable(candidate.displayName) !== target.normalizedName) {
    conflicting.push({
      kind: "conflict",
      value: `name mismatch: ${candidate.displayName}`,
      normalizedValue: normalizeComparable(candidate.displayName),
      strength: "strong",
      assurance: "verified",
    });
  }

  for (const signal of scoredSignals) {
    if (!matchesTarget(signal, target)) continue;
    if (signal.kind === "conflict") {
      conflicting.push(signal);
      continue;
    }

    let weight = SIGNAL_WEIGHTS[signal.kind];
    if (signal.strength === "weak") weight *= 0.65;
    if (signal.strength === "strong") weight *= 1.08;
    if (signal.assurance === "spoofable") weight *= 0.82;
    if (signal.assurance === "self_asserted") weight *= 0.9;
    weight = clamp(weight);

    // Multiple A+B / A+C reconciliations for the same candidate are alternate
    // observations of one derived cross-source identity feature, not new
    // independent evidence families. Direct evidence remains the source of
    // family breadth for contextual resolution.
    const family =
      signal.kind === "cross_source_match"
        ? "cross_source_match"
        : isIndependent(signal)
          ? (signal.sourceFamily ?? `${signal.kind}:${signal.normalizedValue}`)
          : signal.kind;
    const current = positiveByFamily.get(family);
    if (!current || weight > current.weight) {
      positiveByFamily.set(family, { weight, signal });
    }
  }

  const positive = 1 - [...positiveByFamily.values()].reduce((remaining, item) => remaining * (1 - item.weight), 1);
  const penalty = Math.min(0.75, conflicting.length * 0.3);
  let total = clamp(positive - penalty);

  const supporting = [...positiveByFamily.values()].map((item) => item.signal);
  const identityBearing = supporting.filter((signal) => signal.kind !== "name");
  const hasSpoofableIdentity = identityBearing.some(
    (signal) => signal.assurance === "spoofable" || signal.kind === "github_commit_email",
  );
  const hasIndependentCorroboration = identityBearing.some(
    (signal) =>
      signal.kind !== "github_commit_email" &&
      signal.kind !== "cross_source_match" &&
      (signal.assurance === "verified" || signal.assurance === "corroborated"),
  );
  const onlySpoofableIdentity = hasSpoofableIdentity && !hasIndependentCorroboration;
  if (onlySpoofableIdentity) total = Math.min(total, 0.69);

  return {
    total: roundScore(total),
    positive: roundScore(positive),
    penalty: roundScore(penalty),
    independentFamilies: [...positiveByFamily.keys()].sort(),
    matchedSignals: [...new Set(supporting.map((signal) => signal.kind))].sort(),
    conflictingSignals: [...new Set(conflicting.map((signal) => signal.kind))].sort(),
    cappedBecauseSpoofable: onlySpoofableIdentity && positive - penalty > 0.69,
  };
}

export function candidateStatus(
  signals: readonly IdentitySignal[],
  score: CandidateScoreBreakdown,
): Candidate["status"] {
  if (signals.some((signal) => signal.kind === "conflict" && signal.strength === "strong")) {
    return "rejected";
  }
  // A cross-source match may resolve one already-separated candidate, but it
  // is deliberately excluded from canMergeCandidates: two people are never
  // merged merely because pages repeat the same name and organization.
  const mergeGradeCount = dedupeSignals(signals).filter(isResolutionGrade).length;
  const corroboratingFamilies = new Set(
    signals
      .filter(
        (signal) =>
          signal.assurance !== "spoofable" &&
          signal.kind !== "name" &&
          signal.kind !== "conflict" &&
          signal.sourceFamily &&
          signal.sourceEvidenceId,
      )
      .map((signal) => signal.sourceFamily),
  ).size;
  if (score.total >= 0.78 && (mergeGradeCount >= 1 || corroboratingFamilies >= 2)) {
    return "resolved";
  }
  if (score.total >= 0.38 || mergeGradeCount >= 1) return "plausible";
  return "separate";
}

export function createCandidate(draft: CandidateDraft, target: ParsedTarget, id: string, timestamp: string): Candidate {
  const displayName = normalizeWhitespace(draft.displayName);
  if (!displayName) throw new TypeError("candidate displayName must not be empty");
  const signals = dedupeSignals(draft.signals ?? []);
  const score = scoreCandidate({ displayName, signals }, target);
  return {
    schemaVersion: SCHEMA_VERSION,
    id,
    displayName,
    normalizedName: normalizeComparable(displayName),
    status: candidateStatus(signals, score),
    signals,
    evidenceIds: [],
    score,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export interface CandidateMergeDecision {
  allowed: boolean;
  reason: "strong_identifier_match" | "name_only" | "no_strong_identifier" | "conflict";
  matchedSignal?: IdentitySignalKind;
}

/** Name equality is explicitly insufficient: a shared strong identifier is required. */
export function canMergeCandidates(left: Candidate, right: Candidate): CandidateMergeDecision {
  if (
    left.signals.some((signal) => signal.kind === "conflict" && signal.strength === "strong") ||
    right.signals.some((signal) => signal.kind === "conflict" && signal.strength === "strong")
  ) {
    return { allowed: false, reason: "conflict" };
  }

  for (const leftSignal of left.signals.filter(isMergeGrade)) {
    const match = right.signals.find(
      (rightSignal) =>
        isMergeGrade(rightSignal) &&
        rightSignal.kind === leftSignal.kind &&
        rightSignal.normalizedValue === leftSignal.normalizedValue,
    );
    if (match) {
      return {
        allowed: true,
        reason: "strong_identifier_match",
        matchedSignal: leftSignal.kind,
      };
    }
  }

  if (left.normalizedName === right.normalizedName) {
    return { allowed: false, reason: "name_only" };
  }
  return { allowed: false, reason: "no_strong_identifier" };
}

export function mergeCandidates(left: Candidate, right: Candidate, target: ParsedTarget, timestamp: string): Candidate {
  const decision = canMergeCandidates(left, right);
  if (!decision.allowed) {
    throw new Error(`candidate merge rejected: ${decision.reason}`);
  }
  const signals = dedupeSignals([...left.signals, ...right.signals]);
  const score = scoreCandidate({ displayName: left.displayName, signals }, target);
  return {
    ...left,
    signals,
    evidenceIds: [...new Set([...left.evidenceIds, ...right.evidenceIds])].sort(),
    score,
    status: candidateStatus(signals, score),
    updatedAt: timestamp,
  };
}

export function addCandidateSignals(
  candidate: Candidate,
  newSignals: readonly IdentitySignal[],
  target: ParsedTarget,
  timestamp: string,
): Candidate {
  const signals = dedupeSignals([...candidate.signals, ...newSignals]);
  const score = scoreCandidate({ displayName: candidate.displayName, signals }, target);
  return {
    ...candidate,
    signals,
    score,
    status: candidateStatus(signals, score),
    updatedAt: timestamp,
  };
}

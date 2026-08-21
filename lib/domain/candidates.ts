import { clamp, normalizeComparable, normalizeWhitespace, roundScore } from "./runtime";
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
  const tokenPhrase = ` ${needle} `;
  return rawMaterial.some((value) => ` ${normalizeComparable(value)} `.includes(tokenPhrase));
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

    const family = isIndependent(signal)
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
      signal.kind !== "github_commit_email" && (signal.assurance === "verified" || signal.assurance === "corroborated"),
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

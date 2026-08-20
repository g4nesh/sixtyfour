import { clamp, roundScore } from "./runtime";
import type { ConfidenceAssessment, ConfidenceLabel, EvidenceRecord, EvidenceSourceType } from "./types";

export const SPOOFABLE_CONFIDENCE_CAP = 0.69;
export const SINGLE_FAMILY_CONFIDENCE_CAP = 0.79;

const SOURCE_WEIGHTS: Record<EvidenceSourceType, number> = {
  official_profile: 0.64,
  company_page: 0.58,
  professional_profile: 0.42,
  code_profile: 0.4,
  // A directly fetched immutable commit/API record can support a moderate
  // observation, while spoofable Git authorship remains capped below high.
  code_commit: 0.48,
  keybase_proof: 0.68,
  news: 0.52,
  web_archive: 0.44,
  search_result: 0,
  public_document: 0.56,
  other: 0.3,
};

export function confidenceLabel(score: number): ConfidenceLabel {
  if (score >= 0.9) return "very_high";
  if (score >= 0.75) return "high";
  if (score >= 0.45) return "moderate";
  return "low";
}

function evidenceWeight(evidence: EvidenceRecord): number {
  return clamp(SOURCE_WEIGHTS[evidence.sourceType] * evidence.reliability);
}

/**
 * Independent source families combine by noisy-or. Multiple URLs from the
 * same publisher contribute only their strongest item, preventing artificial
 * confidence inflation from mirrors, profiles, or repeated GitHub pages.
 */
export function assessConfidence(evidence: readonly EvidenceRecord[]): ConfidenceAssessment {
  const usable = evidence.filter((item) => item.disposition !== "discovery_only");
  const supporting = usable.filter((item) => item.disposition === "supports");
  const contradicting = usable.filter((item) => item.disposition === "contradicts");
  const byFamily = new Map<string, EvidenceRecord>();

  for (const item of supporting) {
    const current = byFamily.get(item.sourceFamily);
    if (!current || evidenceWeight(item) > evidenceWeight(current)) {
      byFamily.set(item.sourceFamily, item);
    }
  }

  const supportScore =
    1 - [...byFamily.values()].reduce((remaining, item) => remaining * (1 - evidenceWeight(item)), 1);
  const contradictionPenalty = Math.min(
    0.8,
    contradicting.reduce((sum, item) => sum + evidenceWeight(item) * 0.65, 0),
  );
  let score = clamp(supportScore - contradictionPenalty);
  const appliedCaps: string[] = [];

  if (byFamily.size === 1 && score > SINGLE_FAMILY_CONFIDENCE_CAP) {
    score = SINGLE_FAMILY_CONFIDENCE_CAP;
    appliedCaps.push("single_source_family");
  }

  if (supporting.length > 0 && supporting.every((item) => item.spoofable) && score > SPOOFABLE_CONFIDENCE_CAP) {
    score = SPOOFABLE_CONFIDENCE_CAP;
    appliedCaps.push("spoofable_only");
  }

  score = roundScore(score);
  return {
    score,
    label: confidenceLabel(score),
    independentSourceFamilies: [...byFamily.keys()].sort(),
    supportingEvidenceIds: supporting.map((item) => item.id).sort(),
    contradictingEvidenceIds: contradicting.map((item) => item.id).sort(),
    appliedCaps,
  };
}

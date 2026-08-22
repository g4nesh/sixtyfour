import { isJsonValue } from "../domain/runtime";
import type {
  EvidenceDraft,
  EvidenceDisposition,
  EvidenceSourceType,
  JsonObject,
  TemporalStatus,
  VerificationMethod,
} from "../domain/types";

/** Structural subset of lib/tools/contracts.ts; no runtime coupling is required. */
export interface PublicToolEvidenceLike {
  sourceUrl: string;
  sourceType: string;
  title: string;
  observedAt: string;
  excerpt?: string;
  attributes: Readonly<Record<string, unknown>>;
  candidate?: { candidateId: string; basis: string };
  confidenceCap?: number;
}

export interface ToolEvidenceBridgeContext {
  claim: string;
  candidateId?: string;
  candidateRef?: string;
  queryUrl?: string | null;
  httpStatus?: number | null;
  toolCallId: string;
}

interface SourceMapping {
  sourceType: EvidenceSourceType;
  verificationMethod: VerificationMethod;
  temporalStatus: TemporalStatus;
  spoofable: boolean;
  disposition?: EvidenceDisposition;
}

const SOURCE_MAPPINGS: Record<string, SourceMapping> = {
  github_public_commit: {
    sourceType: "code_commit",
    verificationMethod: "api_response",
    temporalStatus: "historical",
    spoofable: true,
  },
  keybase_github_proof: {
    sourceType: "keybase_proof",
    verificationMethod: "cryptographic_proof",
    temporalStatus: "unknown",
    spoofable: false,
  },
  wayback_cdx_capture: {
    sourceType: "web_archive",
    verificationMethod: "archive_snapshot",
    temporalStatus: "historical",
    spoofable: false,
    disposition: "discovery_only",
  },
  wayback_snapshot: {
    sourceType: "web_archive",
    verificationMethod: "archive_snapshot",
    temporalStatus: "historical",
    // The archive transport authenticates a capture, not the truth or
    // ownership of the page-authored content inside that capture.
    spoofable: true,
  },
};

const UNKNOWN_MAPPING: SourceMapping = {
  sourceType: "other",
  verificationMethod: "unverified",
  temporalStatus: "unknown",
  spoofable: true,
};

/**
 * Converts public adapter evidence into the strict admission draft. Unknown
 * transport facts remain explicit nulls; adapter attributes are retained only
 * when they are already JSON-safe.
 */
export function toolEvidenceToDraft(
  evidence: PublicToolEvidenceLike,
  context: ToolEvidenceBridgeContext,
): EvidenceDraft {
  const mapping = SOURCE_MAPPINGS[evidence.sourceType] ?? UNKNOWN_MAPPING;
  const canonicalSubset = isJsonValue(evidence.attributes) ? (evidence.attributes as JsonObject) : null;
  return {
    ...(context.candidateId ? { candidateId: context.candidateId } : {}),
    ...(context.candidateRef ? { candidateRef: context.candidateRef } : {}),
    claim: context.claim,
    sourceUrl: evidence.sourceUrl,
    queryUrl: context.queryUrl ?? null,
    sourceType: mapping.sourceType,
    disposition: mapping.disposition ?? "supports",
    title: evidence.title,
    publisher: null,
    observedAt: evidence.observedAt,
    httpStatus: context.httpStatus ?? null,
    excerpt: evidence.excerpt,
    canonicalSubset,
    toolCallId: context.toolCallId,
    verificationMethod: mapping.verificationMethod,
    temporalStatus: mapping.temporalStatus,
    spoofable: mapping.spoofable,
    attributes: {
      adapterSourceType: evidence.sourceType,
      candidateBasis: evidence.candidate?.basis ?? null,
      confidenceCap: evidence.confidenceCap ?? null,
    },
  };
}

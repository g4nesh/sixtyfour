import type { EvidenceDraft, EvidenceRecord, JsonObject, JsonValue } from "../lib/domain/types.ts";

export const VERIFIED_CAPTURED_AT = "2026-08-18T22:08:17.000Z";

interface VerifiedCapture {
  bodySha256: string;
  directExcerpts?: readonly string[];
  apiClaim?: string;
  canonicalSubset?: JsonObject;
  requestFingerprint?: string;
}

export const VERIFIED_GITHUB_STRONGEST_SHA = "3a0dd7ba4f44cdc116d83712f61e7c1a95be3588";

const VERIFIED_GITHUB_SEARCH_FINGERPRINT =
  "GET https://api.github.com/search/commits?q=repo%3Atorvalds%2Flinux+author-email%3Atorvalds%40linux-foundation.org+is%3Apublic&sort=committer-date&order=desc&per_page=3 accept:application/vnd.github+json";

const VERIFIED_GITHUB_COMMIT_FINGERPRINT = `GET https://api.github.com/repos/torvalds/linux/commits/${VERIFIED_GITHUB_STRONGEST_SHA} accept:application/vnd.github+json`;

/**
 * Manually verified public-response projections used by the deterministic
 * examples. Full response bodies are intentionally not committed; these
 * hashes and exact excerpts/subsets are the durable capture boundary.
 */
export const VERIFIED_PUBLIC_CAPTURES = {
  "req-linux-doc": {
    bodySha256: "9fe3ae362aecea69b6572e5f82f0993ef339f682f71ebd1d90c85127fe8e4d4f",
    directExcerpts: [
      "Linus Torvalds is the final arbiter of all changes accepted into the Linux kernel. His e-mail address is < torvalds@linux-foundation.org >.",
    ],
  },
  "req-linux-foundation": {
    bodySha256: "47755209930ef267697a78716d40833eee2c929d00024014cca643c92d551d6b",
    directExcerpts: ["Linus Torvalds Fellow"],
  },
  "req-github-search": {
    bodySha256: "4b10a4dc0458eb4142cdb6ab845e1e5057dbc3e2f6c96881048f977ac460a8ea",
    requestFingerprint: VERIFIED_GITHUB_SEARCH_FINGERPRINT,
    apiClaim: `GitHub's public commit search returned 29,714 indexed matches, was complete, and identified ${VERIFIED_GITHUB_STRONGEST_SHA} as the top commit linked to @torvalds.`,
    canonicalSubset: {
      total_count: 29714,
      incomplete_results: false,
      strongest_sha: VERIFIED_GITHUB_STRONGEST_SHA,
      linked_login: "torvalds",
      exact_author_email_match: true,
    },
  },
  "req-github-commit": {
    bodySha256: "1a026a26e3a858e8926bef60e5c0115e61a0995d19653d1f4a260bb707f73b89",
    requestFingerprint: VERIFIED_GITHUB_COMMIT_FINGERPRINT,
    apiClaim: `GitHub's commit API returned ${VERIFIED_GITHUB_STRONGEST_SHA} in torvalds/linux, linked it to @torvalds with an exact author-email match, and reported the signature as unsigned.`,
    canonicalSubset: {
      sha: VERIFIED_GITHUB_STRONGEST_SHA,
      repository: "torvalds/linux",
      githubAccount: "torvalds",
      exactAuthorEmailMatch: true,
      authoredAt: "2026-08-18T21:13:43.000Z",
      signatureVerified: false,
      signatureReason: "unsigned",
    },
  },
  "req-keybase": {
    bodySha256: "eeba1ce1f1043422a2f1f5bf4b043a50b0ecef324fde0ca4b64d127c25a9984a",
    canonicalSubset: {
      status: "OK",
      matching_user: false,
    },
  },
  "req-ted-selected": {
    bodySha256: "7649b3991c54edd2cae6a9f073d5fd6e25112b9100d9612de1ede665d0df124b",
    directExcerpts: ["Chris Anderson Chairman, TED", "Chris Anderson became the curator of the TED Conference in 2002"],
  },
  "req-ted-decoy": {
    bodySha256: "75ee0b44d5acb892a647f0093d5d8ba7605f6b139cb4bf3b0d78868dd30668a1",
    directExcerpts: ["(He is not, however, to be confused with the curator of TED, who has the same name.)"],
  },
  "req-wired-decoy": {
    bodySha256: "bfae98bbe1b74d6963875a80ed9f394d12a5a8506f8ccfadf4c3235dd503c063",
    directExcerpts: [
      "Chris Anderson, CEO of the world's third-largest producer of drones (and a former editor-in-chief of WIRED US)",
    ],
  },
  "req-python-foreword": {
    bodySha256: "82f7fb2a0f4c38ba0e957394baa99435c21982fc367663307c0002c0587123c8",
    directExcerpts: ["As Python's creator, I'd like to say a few words about its origins"],
  },
  "req-guido-bio": {
    bodySha256: "0af6e624fcf05dfc7a8a2c6b8437a1b1705289283a9c8e617d6d2577180b938c",
    directExcerpts: ["Guido van Rossum is the creator of the Python programming language."],
  },
} as const satisfies Record<string, VerifiedCapture>;

export type VerifiedRequestId = keyof typeof VERIFIED_PUBLIC_CAPTURES;

type DirectDraft = Omit<EvidenceDraft, "claim" | "excerpt" | "contentHash" | "toolCallId" | "verificationMethod">;

export function verifiedDirectEvidence(
  requestId: VerifiedRequestId,
  excerptIndex: number,
  actionId: string,
  draft: DirectDraft,
): EvidenceDraft {
  const capture = VERIFIED_PUBLIC_CAPTURES[requestId];
  const excerpts = "directExcerpts" in capture ? capture.directExcerpts : undefined;
  const excerpt = excerpts?.[excerptIndex];
  if (!excerpt) throw new Error(`capture ${requestId} has no direct excerpt at ${excerptIndex}`);
  return {
    ...draft,
    claim: excerpt,
    excerpt,
    contentHash: `sha256:${capture.bodySha256}`,
    toolCallId: actionId,
    verificationMethod: "direct_fetch",
  };
}

type ApiDraft = Omit<
  EvidenceDraft,
  "claim" | "excerpt" | "canonicalSubset" | "contentHash" | "toolCallId" | "verificationMethod"
>;

export function verifiedApiEvidence(requestId: VerifiedRequestId, actionId: string, draft: ApiDraft): EvidenceDraft {
  const capture = VERIFIED_PUBLIC_CAPTURES[requestId];
  if (!("apiClaim" in capture) || !capture.apiClaim || !("canonicalSubset" in capture)) {
    throw new Error(`capture ${requestId} has no canonical API projection`);
  }
  return {
    ...draft,
    claim: capture.apiClaim,
    canonicalSubset: capture.canonicalSubset,
    contentHash: `sha256:${capture.bodySha256}`,
    toolCallId: actionId,
    verificationMethod: "api_response",
  };
}

export function applyVerifiedCaptureMetadata(cassette: JsonObject): void {
  cassette.capturedAt = VERIFIED_CAPTURED_AT;
  if (!Array.isArray(cassette.requests)) throw new Error("cassette requests are missing");
  for (const request of cassette.requests) {
    if (request === null || Array.isArray(request) || typeof request !== "object") {
      throw new Error("cassette request is invalid");
    }
    const requestId = request.id;
    const captureId = request.captureId ?? requestId;
    if (typeof requestId !== "string" || typeof captureId !== "string" || !(captureId in VERIFIED_PUBLIC_CAPTURES)) {
      throw new Error(`cassette request ${String(requestId)} has no verified capture`);
    }
    const response = request.response;
    if (response === null || Array.isArray(response) || typeof response !== "object") {
      throw new Error(`cassette request ${requestId} has no response`);
    }
    const capture = VERIFIED_PUBLIC_CAPTURES[captureId as VerifiedRequestId];
    request.captureId = captureId;
    if ("requestFingerprint" in capture && capture.requestFingerprint) {
      request.fingerprint = capture.requestFingerprint;
    }
    response.bodySha256 = capture.bodySha256;
    if ("canonicalSubset" in capture && capture.canonicalSubset) {
      response.canonicalSubset = capture.canonicalSubset;
    } else {
      delete response.canonicalSubset;
    }
  }
}

function sameJson(left: JsonValue, right: JsonValue): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function assertVerifiedEvidenceContract(
  evidence: readonly EvidenceRecord[],
  actionCaptureIds: Readonly<Record<string, VerifiedRequestId>> = {},
): void {
  for (const record of evidence) {
    const captureId = record.toolCallId
      ? (actionCaptureIds[record.toolCallId] ??
        (record.toolCallId in VERIFIED_PUBLIC_CAPTURES ? (record.toolCallId as VerifiedRequestId) : undefined))
      : undefined;
    if (!captureId) {
      throw new Error(`evidence ${record.id} has no verified capture request`);
    }
    const capture = VERIFIED_PUBLIC_CAPTURES[captureId];
    if (record.contentHash !== `sha256:${capture.bodySha256}`) {
      throw new Error(`evidence ${record.id} does not use the verified response hash`);
    }
    if (record.verificationMethod === "direct_fetch") {
      const excerpts = "directExcerpts" in capture ? capture.directExcerpts : undefined;
      if (
        !record.excerpt ||
        !excerpts?.some((excerpt) => excerpt === record.excerpt) ||
        record.claim !== record.excerpt
      ) {
        throw new Error(`evidence ${record.id} is not an exact verified source excerpt`);
      }
      continue;
    }
    if (record.verificationMethod === "api_response") {
      if (
        !("apiClaim" in capture) ||
        record.excerpt !== null ||
        record.claim !== capture.apiClaim ||
        !("canonicalSubset" in capture) ||
        !sameJson(record.canonicalSubset, capture.canonicalSubset)
      ) {
        throw new Error(`evidence ${record.id} is not the verified canonical API projection`);
      }
      continue;
    }
    throw new Error(`evidence ${record.id} uses an unsupported capture verification method`);
  }
}

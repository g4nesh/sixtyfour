import type { Clock, IdFactory } from "./runtime";
import { clamp, normalizeComparable, normalizeWhitespace } from "./runtime";
import {
  containsRestrictedPublicContent,
  restrictedJsonContentPaths,
  urlContainsRestrictedParameters,
} from "./content-policy";
import {
  SCHEMA_VERSION,
  type EvidenceAdmission,
  type EvidenceDraft,
  type EvidenceRecord,
  type EvidenceSourceType,
} from "./types";

const TRACKING_QUERY_KEYS = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "ref",
  "ref_src",
  "source",
]);

const COMMON_TWO_PART_SUFFIXES = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "com.au",
  "net.au",
  "co.jp",
  "co.in",
  "com.br",
]);

const DEFAULT_RELIABILITY: Record<EvidenceSourceType, number> = {
  official_profile: 0.82,
  company_page: 0.78,
  professional_profile: 0.58,
  code_profile: 0.55,
  code_commit: 0.48,
  keybase_proof: 0.86,
  news: 0.7,
  web_archive: 0.64,
  search_result: 0.2,
  public_document: 0.72,
  other: 0.45,
};

const METADATA_OBSERVATION_CANONICAL_KEYS = new Set([
  "mimeType",
  "truncated",
  "pageFootprint",
  "pageFootprintHash",
]);

const METADATA_OBSERVATION_ATTRIBUTE_KEYS = new Set([
  "metadataObservation",
  "findingAuthority",
  "identityBinding",
  "untrustedContent",
  "fullBodyRetained",
  "ownershipVerified",
]);

function isValidPassiveMetadataObservation(draft: EvidenceDraft): boolean {
  if (draft.attributes?.metadataObservation !== true) return true;
  const canonical = draft.canonicalSubset;
  const footprint = canonical?.pageFootprint;
  const footprintHash = canonical?.pageFootprintHash;
  return draft.disposition === "discovery_only"
    && draft.verificationMethod === "unverified"
    && draft.sourceType === "other"
    && !normalizeWhitespace(draft.excerpt ?? "")
    && draft.publisher == null
    && draft.reliability === 0
    && draft.spoofable === true
    && draft.attributes.findingAuthority === false
    && draft.attributes.identityBinding === false
    && draft.attributes.untrustedContent === true
    && draft.attributes.fullBodyRetained === false
    && draft.attributes.ownershipVerified === false
    && Object.keys(draft.attributes).every((key) => METADATA_OBSERVATION_ATTRIBUTE_KEYS.has(key))
    && canonical !== null
    && canonical !== undefined
    && Object.keys(canonical).every((key) => METADATA_OBSERVATION_CANONICAL_KEYS.has(key))
    && typeof footprint === "object"
    && footprint !== null
    && !Array.isArray(footprint)
    && footprint.schemaVersion === "public_page_footprint_v1"
    && typeof footprintHash === "string"
    && /^sha256:[a-f0-9]{64}$/.test(footprintHash);
}

function registrableFamily(hostname: string): string {
  const host = hostname
    .toLocaleLowerCase("en-US")
    .replace(/^(?:www\d*|m|amp)\./, "")
    .replace(/\.$/, "");
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2 || host === "localhost") return host;
  const suffix = labels.slice(-2).join(".");
  return COMMON_TWO_PART_SUFFIXES.has(suffix)
    ? labels.slice(-3).join(".")
    : labels.slice(-2).join(".");
}

function unwrapWayback(url: URL): URL | undefined {
  if (registrableFamily(url.hostname) !== "archive.org") return undefined;
  const match = url.pathname.match(/^\/web\/[^/]+\/(https?:\/\/.*)$/i);
  if (!match?.[1]) return undefined;
  try {
    return new URL(match[1]);
  } catch {
    return undefined;
  }
}

export function canonicalizeSourceUrl(rawUrl: string): string {
  const url = new URL(normalizeWhitespace(rawUrl));
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new TypeError("evidence URL must use http or https");
  }
  if (url.username || url.password) {
    throw new TypeError("evidence URL must not contain credentials");
  }
  if (urlContainsRestrictedParameters(url.toString())) {
    throw new TypeError("evidence URL contains a sensitive query parameter");
  }
  url.hash = "";
  url.hostname = url.hostname.toLocaleLowerCase("en-US");
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }
  for (const key of [...url.searchParams.keys()]) {
    const normalizedKey = key.toLocaleLowerCase("en-US");
    if (normalizedKey.startsWith("utm_") || TRACKING_QUERY_KEYS.has(normalizedKey)) {
      url.searchParams.delete(key);
    }
  }
  url.searchParams.sort();
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

function decodedUrlContent(rawUrl: string): string {
  const url = new URL(normalizeWhitespace(rawUrl));
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    throw new TypeError("evidence URL has invalid percent encoding");
  }
  const queryParts = [...url.searchParams.entries()].flatMap(([key, value]) => [key, value]);
  return [decodedPath.replaceAll("/", " "), ...queryParts].join(" ");
}

function decodedUrlContainsRestrictedContent(
  rawUrl: string,
  allowedEmails: ReadonlySet<string> | undefined,
): boolean {
  const content = decodedUrlContent(rawUrl);
  return containsRestrictedPublicContent(content, { allowedEmails })
    || /\b(?:call|cell|contact|mobile|phone|tel|telephone)\s+\d{7,15}\b/i.test(content);
}

export function inferSourceFamily(rawUrl: string, override?: string): string {
  const url = new URL(canonicalizeSourceUrl(rawUrl));
  const unwrapped = unwrapWayback(url);
  const derived = registrableFamily((unwrapped ?? url).hostname);
  if (override) {
    const normalized = normalizeWhitespace(override).toLocaleLowerCase("en-US");
    if (!normalized || /[\s/@]/.test(normalized) || normalized !== derived) {
      throw new TypeError("sourceFamily override must match the canonical source URL");
    }
  }
  return derived;
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function defaultSpoofable(sourceType: EvidenceSourceType): boolean {
  return ["professional_profile", "code_profile", "code_commit", "search_result"].includes(
    sourceType,
  );
}

function defaultVerificationMethod(
  sourceType: EvidenceSourceType,
): EvidenceRecord["verificationMethod"] {
  if (sourceType === "search_result") return "search_discovery";
  if (sourceType === "keybase_proof") return "cryptographic_proof";
  if (sourceType === "web_archive") return "archive_snapshot";
  return "direct_fetch";
}

export interface EvidenceAdmissionContext {
  candidateIds: ReadonlySet<string>;
  existing: readonly EvidenceRecord[];
  ids: IdFactory;
  clock: Clock;
  allowedEmails?: ReadonlySet<string>;
}

export function admitEvidence(
  draft: EvidenceDraft,
  context: EvidenceAdmissionContext,
): EvidenceAdmission {
  const proposedClaim = normalizeWhitespace(draft.claim);
  if (!proposedClaim) return { admitted: false, reason: "missing_claim" };
  if (!isValidPassiveMetadataObservation(draft)) {
    return { admitted: false, reason: "discovery_only_source" };
  }
  const excerpt = draft.excerpt ? normalizeWhitespace(draft.excerpt) : "";
  if (!excerpt && !draft.canonicalSubset) {
    return { admitted: false, reason: "missing_canonical_content" };
  }
  if (!draft.candidateId || !context.candidateIds.has(draft.candidateId)) {
    return { admitted: false, reason: "unknown_candidate" };
  }
  const textualContent = [proposedClaim, excerpt, draft.title ?? "", draft.publisher ?? ""];
  if (textualContent.some((value) => containsRestrictedPublicContent(value, {
    allowedEmails: context.allowedEmails,
  }))) {
    return { admitted: false, reason: "sensitive_content" };
  }
  if (
    (draft.canonicalSubset && restrictedJsonContentPaths(
      draft.canonicalSubset,
      { allowedEmails: context.allowedEmails },
      "canonicalSubset",
    ).length > 0)
    || (draft.attributes && restrictedJsonContentPaths(
      draft.attributes,
      { allowedEmails: context.allowedEmails },
      "attributes",
    ).length > 0)
  ) {
    return { admitted: false, reason: "sensitive_content" };
  }

  const verificationMethod = draft.verificationMethod ?? defaultVerificationMethod(draft.sourceType);
  if (verificationMethod === "direct_fetch" && !excerpt) {
    return { admitted: false, reason: "missing_canonical_content" };
  }
  // Direct-fetch facts are extractive by construction. A tool may propose a
  // paraphrase, but only the exact admitted quote becomes the durable claim.
  const claim = verificationMethod === "direct_fetch" ? excerpt : proposedClaim;

  let canonicalUrl: string;
  let sourceFamily: string;
  let queryUrl: string | null;
  try {
    canonicalUrl = canonicalizeSourceUrl(draft.sourceUrl);
    queryUrl = draft.queryUrl ? canonicalizeSourceUrl(draft.queryUrl) : null;
    if (
      decodedUrlContainsRestrictedContent(draft.sourceUrl, context.allowedEmails)
      || (draft.queryUrl && decodedUrlContainsRestrictedContent(draft.queryUrl, context.allowedEmails))
    ) {
      return { admitted: false, reason: "sensitive_content" };
    }
    sourceFamily = inferSourceFamily(canonicalUrl, draft.sourceFamily);
  } catch (error) {
    return {
      admitted: false,
      reason:
        error instanceof TypeError && /credentials|http or https|sensitive query parameter/.test(error.message)
          ? "unsafe_url"
          : "invalid_url",
    };
  }

  const normalizedClaim = normalizeComparable(claim);
  const exactDuplicate = context.existing.find(
    (item) =>
      item.candidateId === draft.candidateId &&
      item.normalizedClaim === normalizedClaim &&
      item.canonicalUrl === canonicalUrl,
  );
  if (exactDuplicate) {
    return {
      admitted: false,
      reason: "duplicate_url",
      duplicateOf: exactDuplicate.id,
    };
  }

  const familyDuplicate = context.existing.find(
    (item) =>
      item.candidateId === draft.candidateId &&
      item.normalizedClaim === normalizedClaim &&
      item.sourceFamily === sourceFamily,
  );
  if (familyDuplicate) {
    return {
      admitted: false,
      reason: "duplicate_source_family",
      duplicateOf: familyDuplicate.id,
    };
  }

  const timestamp = context.clock.now();
  const disposition =
    draft.sourceType === "search_result" ? "discovery_only" : draft.disposition ?? "supports";
  const fingerprint = stableHash(
    [draft.candidateId, normalizedClaim, canonicalUrl, disposition].join("|"),
  );
  const canonicalSubset = draft.canonicalSubset ?? null;
  const contentHash =
    draft.contentHash ??
    (excerpt || canonicalSubset
      ? `fnv1a32:${stableHash(excerpt || JSON.stringify(canonicalSubset))}`
      : null);
  const httpStatus =
    draft.httpStatus !== null &&
    draft.httpStatus !== undefined &&
    Number.isInteger(draft.httpStatus) &&
    draft.httpStatus >= 100 &&
    draft.httpStatus <= 599
      ? draft.httpStatus
      : null;
  const evidence: EvidenceRecord = {
    schemaVersion: SCHEMA_VERSION,
    id: context.ids.next("evidence"),
    candidateId: draft.candidateId,
    claim,
    normalizedClaim,
    disposition,
    // Persist the sanitized canonical URL, never a provider-supplied tracking
    // or credential-bearing variant. The evidence still retains a stable
    // auditable source address without leaking query secrets into reports.
    sourceUrl: canonicalUrl,
    canonicalUrl,
    queryUrl,
    title: draft.title ? normalizeWhitespace(draft.title) : null,
    publisher: draft.publisher ? normalizeWhitespace(draft.publisher) : null,
    sourceFamily,
    sourceType: draft.sourceType,
    publishedAt: draft.publishedAt ?? null,
    retrievedAt: timestamp,
    observedAt: draft.observedAt ?? null,
    httpStatus,
    contentHash,
    excerpt: excerpt || null,
    canonicalSubset,
    toolCallId: draft.toolCallId ?? null,
    verificationMethod,
    temporalStatus: draft.temporalStatus ?? "unknown",
    reliability: Math.round(
      clamp(draft.reliability ?? DEFAULT_RELIABILITY[draft.sourceType]) * 1000,
    ) / 1000,
    spoofable: draft.spoofable ?? defaultSpoofable(draft.sourceType),
    attributes: draft.attributes ?? {},
    fingerprint,
    createdAt: timestamp,
  };
  return { admitted: true, reason: "admitted", evidence };
}

export class EvidenceLedger {
  readonly #candidateIds: ReadonlySet<string>;
  readonly #ids: IdFactory;
  readonly #clock: Clock;
  #records: EvidenceRecord[];

  constructor(
    records: readonly EvidenceRecord[],
    candidateIds: ReadonlySet<string>,
    ids: IdFactory,
    clock: Clock,
  ) {
    this.#records = [...records];
    this.#candidateIds = candidateIds;
    this.#ids = ids;
    this.#clock = clock;
  }

  admit(draft: EvidenceDraft): EvidenceAdmission {
    const result = admitEvidence(draft, {
      candidateIds: this.#candidateIds,
      existing: this.#records,
      ids: this.#ids,
      clock: this.#clock,
    });
    if (result.admitted && result.evidence) this.#records.push(result.evidence);
    return result;
  }

  records(): EvidenceRecord[] {
    return [...this.#records];
  }
}

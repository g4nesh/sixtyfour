import {
  containsRestrictedPublicContent,
  urlContainsRestrictedParameters,
} from "../domain/content-policy";
import type { JsonObject, JsonValue } from "../domain/types";
import { cleanInlineReportText, safePublicReportUrl } from "./sanitize";
import type {
  ReportPageCanonicalStatus,
  ReportPageFootprintView,
  ReportPageProviderFamily,
  ReportTemporalComparisonView,
  ReportTemporalMetadataField,
} from "./types";

const TEMPORAL_CAVEAT = "Archive observations bind changes in retrieved response bytes and bounded static-HTML projections to this interval; they do not identify the editor or prove archive completeness, and they do not describe browser-rendered state.";
const FOOTPRINT_CAVEAT = "Page declarations are spoofable observations from the exact fetched HTML. No referenced resource was followed, and no hosting ownership or control is inferred.";
const MAXIMUM_TEMPORAL_FRAGMENT_COUNT = 256;

const TEMPORAL_METADATA_FIELDS = new Set<ReportTemporalMetadataField>([
  "title",
  "description",
  "canonicalUrl",
  "language",
  "publishedAt",
  "modifiedAt",
]);

const PAGE_PROVIDER_FAMILIES = new Set<ReportPageProviderFamily>([
  "amazon-cloudfront",
  "amazon-web-services",
  "apple-hosted-assets",
  "cloudflare",
  "fastly",
  "github",
  "google-hosted-assets",
  "jsdelivr",
  "microsoft-azure",
  "netlify",
  "unpkg",
  "vercel",
]);

const PAGE_CANONICAL_STATUSES = new Set<ReportPageCanonicalStatus>([
  "not_declared",
  "accepted_same_page",
  "discarded",
]);

interface ProjectionState {
  bounded: boolean;
}

function objectValue(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

/**
 * Discovery records may expose a page footprint only when the evidence kernel
 * explicitly marked the record as a passive, non-authoritative observation.
 * Search-result metadata and arbitrary discovery payloads remain suppressed.
 */
export function isPassivePageMetadataObservation(value: unknown): boolean {
  const evidence = objectValue(value);
  const attributes = objectValue(evidence?.attributes);
  return evidence?.disposition === "discovery_only"
    && evidence.verificationMethod === "unverified"
    && evidence.sourceType === "other"
    && (evidence.excerpt === null || evidence.excerpt === undefined || evidence.excerpt === "")
    && attributes?.metadataObservation === true
    && attributes.findingAuthority === false
    && attributes.identityBinding === false
    && attributes.ownershipVerified === false
    && attributes.fullBodyRetained === false;
}

function firstCharacters(value: string, maximum: number): string {
  return [...value].slice(0, maximum).join("");
}

function safeText(value: JsonValue | undefined, maximum: number, state: ProjectionState): string | null {
  if (typeof value !== "string") return null;
  const normalized = cleanInlineReportText(value.normalize("NFKC"));
  if (!normalized || containsRestrictedPublicContent(normalized)) return null;
  if ([...normalized].length > maximum) state.bounded = true;
  return firstCharacters(normalized, maximum).trim() || null;
}

function safeStringList(
  value: JsonValue | undefined,
  options: {
    maximumItems: number;
    maximumCharacters: number;
    state: ProjectionState;
    accept?: (item: string) => boolean;
    rejectOverlong?: boolean;
  },
): string[] {
  if (!Array.isArray(value)) return [];
  if (value.length > options.maximumItems) options.state.bounded = true;
  const items: string[] = [];
  for (const candidate of value) {
    if (options.rejectOverlong && typeof candidate === "string") {
      const normalized = cleanInlineReportText(candidate.normalize("NFKC"));
      if ([...normalized].length > options.maximumCharacters) {
        options.state.bounded = true;
        continue;
      }
    }
    const item = safeText(candidate, options.maximumCharacters, options.state);
    if (!item || options.accept && !options.accept(item) || items.includes(item)) continue;
    items.push(item);
    if (items.length === options.maximumItems) break;
  }
  return items;
}

function safeIsoInstant(value: JsonValue | undefined): string | null {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const normalized = new Date(timestamp).toISOString();
  return normalized === value ? normalized : null;
}

function safeTemporalFragmentCount(value: JsonValue | undefined): number | null {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= MAXIMUM_TEMPORAL_FRAGMENT_COUNT
    ? value
    : null;
}

function safePublicHostname(value: string): boolean {
  const hostname = value.toLocaleLowerCase("en-US").replace(/\.$/, "");
  if (
    hostname.length > 253
    || !hostname.includes(".")
    || hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || hostname.endsWith(".home.arpa")
    || /^[\d.]+$/.test(hostname)
    || hostname.includes(":")
  ) return false;
  try {
    const parsed = new URL(`https://${hostname}`);
    return parsed.hostname === hostname
      && parsed.port === ""
      && hostname.split(".").every((label) =>
        label.length >= 1
        && label.length <= 63
        && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
  } catch {
    return false;
  }
}

function safeCanonicalUrl(
  value: JsonValue | undefined,
  state: ProjectionState,
): string | null {
  if (typeof value !== "string") return null;
  if ([...value].length > 2_048) {
    state.bounded = true;
    return null;
  }
  const safe = safePublicReportUrl(value);
  if (
    !safe
    || containsRestrictedPublicContent(safe)
    || urlContainsRestrictedParameters(safe)
  ) return null;
  try {
    const url = new URL(safe);
    if (
      url.port !== ""
      || url.hash !== ""
      || !safePublicHostname(url.hostname)
    ) return null;
    return url.href;
  } catch {
    return null;
  }
}

function safeCanonicalStatus(value: JsonValue | undefined): ReportPageCanonicalStatus | null {
  return typeof value === "string"
    && PAGE_CANONICAL_STATUSES.has(value as ReportPageCanonicalStatus)
    ? value as ReportPageCanonicalStatus
    : null;
}

function safeLanguage(value: JsonValue | undefined, state: ProjectionState): string | null {
  if (typeof value !== "string") return null;
  const language = cleanInlineReportText(value.normalize("NFKC"));
  if (!language || containsRestrictedPublicContent(language)) return null;
  if ([...language].length > 35) {
    state.bounded = true;
    return null;
  }
  return /^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,2}$/i.test(language)
    ? language.toLocaleLowerCase("en-US")
    : null;
}

export function projectTemporalComparison(
  canonicalSubset: unknown,
): ReportTemporalComparisonView | null {
  const canonical = objectValue(canonicalSubset);
  const source = objectValue(canonical?.temporalComparison);
  if (!source) return null;
  const observedAfter = safeIsoInstant(source.observedAfter);
  const observedOnOrBefore = safeIsoInstant(source.observedOnOrBefore);
  if (
    !observedAfter
    || !observedOnOrBefore
    || Date.parse(observedAfter) > Date.parse(observedOnOrBefore)
  ) return null;

  const bodyChanged = source.bodyChanged;
  const visibleTextChanged = source.visibleTextChanged;
  const metadataChanged = source.metadataChanged;
  const structureChanged = source.structureChanged;
  const addedFragmentCount = safeTemporalFragmentCount(source.addedFragmentCount);
  const removedFragmentCount = safeTemporalFragmentCount(source.removedFragmentCount);
  const unchangedFragmentCount = safeTemporalFragmentCount(source.unchangedFragmentCount);
  if (
    typeof bodyChanged !== "boolean"
    || typeof visibleTextChanged !== "boolean"
    || typeof metadataChanged !== "boolean"
    || typeof structureChanged !== "boolean"
    || typeof source.comparisonBounded !== "boolean"
    || addedFragmentCount === null
    || removedFragmentCount === null
    || unchangedFragmentCount === null
    || !bodyChanged
  ) return null;

  const state: ProjectionState = { bounded: source.comparisonBounded === true };
  const changedMetadataFields = safeStringList(source.changedMetadataFields, {
    maximumItems: 6,
    maximumCharacters: 32,
    state,
    accept: (item): item is ReportTemporalMetadataField =>
      TEMPORAL_METADATA_FIELDS.has(item as ReportTemporalMetadataField),
  }) as ReportTemporalMetadataField[];
  const addedTextFragments = safeStringList(source.addedTextFragments, {
    maximumItems: 6,
    maximumCharacters: 320,
    state,
  });
  const removedTextFragments = safeStringList(source.removedTextFragments, {
    maximumItems: 6,
    maximumCharacters: 320,
    state,
  });
  if (
    metadataChanged !== (changedMetadataFields.length > 0)
    || addedFragmentCount < addedTextFragments.length
    || removedFragmentCount < removedTextFragments.length
    || (!visibleTextChanged && (addedFragmentCount > 0 || removedFragmentCount > 0))
  ) return null;

  return {
    observedAfter,
    observedOnOrBefore,
    bodyChanged,
    visibleTextChanged,
    metadataChanged,
    structureChanged,
    changedMetadataFields,
    addedTextFragments,
    removedTextFragments,
    addedFragmentCount,
    removedFragmentCount,
    unchangedFragmentCount,
    comparisonBounded: state.bounded,
    caveat: TEMPORAL_CAVEAT,
  };
}

export function projectPageFootprint(
  canonicalSubset: unknown,
): ReportPageFootprintView | null {
  const canonical = objectValue(canonicalSubset);
  const source = objectValue(canonical?.pageFootprint);
  const footprintHash = typeof canonical?.pageFootprintHash === "string"
    && /^sha256:[a-f0-9]{64}$/.test(canonical.pageFootprintHash)
    ? canonical.pageFootprintHash
    : null;
  if (!source || source.schemaVersion !== "public_page_footprint_v1" || !footprintHash) return null;
  const state: ProjectionState = { bounded: source.bounded === true };
  const title = safeText(source.title, 240, state);
  const description = safeText(source.description, 500, state);
  const declaredCanonicalStatus = safeCanonicalStatus(source.canonicalStatus);
  const acceptedCanonicalUrl = declaredCanonicalStatus === "accepted_same_page"
    ? safeCanonicalUrl(source.canonicalUrl, state)
    : null;
  const canonicalStatus = declaredCanonicalStatus === "accepted_same_page" && !acceptedCanonicalUrl
    ? null
    : declaredCanonicalStatus;
  const language = safeLanguage(source.language, state);
  const openGraph = objectValue(source.openGraph);
  const openGraphType = safeText(openGraph?.type, 80, state);
  const openGraphSiteName = safeText(openGraph?.siteName, 160, state);
  const declaredApplications = objectValue(source.declaredApplications);
  const generators = safeStringList(declaredApplications?.generators, {
    maximumItems: 4,
    maximumCharacters: 160,
    state,
  });
  const applicationNames = safeStringList(declaredApplications?.applicationNames, {
    maximumItems: 4,
    maximumCharacters: 160,
    state,
  });
  const observedProviderFamilies = safeStringList(source.observedProviderFamilies, {
    maximumItems: 8,
    maximumCharacters: 40,
    state,
    accept: (item): item is ReportPageProviderFamily =>
      PAGE_PROVIDER_FAMILIES.has(item as ReportPageProviderFamily),
  }) as ReportPageProviderFamily[];
  const observedResourceHosts = safeStringList(source.observedResourceHosts, {
    maximumItems: 12,
    maximumCharacters: 253,
    state,
    accept: safePublicHostname,
    rejectOverlong: true,
  }).map((hostname) => hostname.toLocaleLowerCase("en-US").replace(/\.$/, ""));
  const jsonLdTypes = safeStringList(source.jsonLdTypes, {
    maximumItems: 12,
    maximumCharacters: 120,
    state,
  });
  if (
    !title
    && !description
    && !canonicalStatus
    && !language
    && !openGraphType
    && !openGraphSiteName
    && generators.length === 0
    && applicationNames.length === 0
    && observedProviderFamilies.length === 0
    && observedResourceHosts.length === 0
    && jsonLdTypes.length === 0
  ) return null;
  return {
    footprintHash,
    title,
    description,
    canonicalUrl: acceptedCanonicalUrl,
    canonicalStatus,
    language,
    openGraphType,
    openGraphSiteName,
    generators,
    applicationNames,
    observedProviderFamilies,
    observedResourceHosts,
    jsonLdTypes,
    bounded: state.bounded,
    caveat: FOOTPRINT_CAVEAT,
  };
}

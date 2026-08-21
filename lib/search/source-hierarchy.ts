import { normalizeComparable, normalizeWhitespace } from "../domain/runtime";
import type { EvidenceSourceType, InvestigationState, ParsedTarget, SourceTier, TargetKind } from "../domain/types";
import { compileOsintQueries, type CompiledOsintQuery } from "./osint-query-compiler";

export type SourceAdmission = "admissible_after_fetch" | "discovery_only";

export interface SourceLane {
  id: string;
  tier: SourceTier;
  label: string;
  description: string;
  allowedTools: string[];
  targetKinds: TargetKind[];
  identifierKinds: string[];
  sourceTypes: EvidenceSourceType[];
  admission: SourceAdmission;
  requiresCandidate: boolean;
  requiresExactCandidateUrl: boolean;
  trustPrior: number;
  executionCost: number;
  policyRisk: number;
}

const ALL_TARGET_KINDS: TargetKind[] = [
  "email",
  "named_person",
  "role_query",
  "organization",
  "url",
  "domain",
  "repository",
  "publication",
  "package",
  "platform_handle",
  "unknown",
];

/**
 * Ordered public-professional source hierarchy. Tiers guide traversal cost;
 * they never alter evidence reliability or finding confidence.
 */
export const SOURCE_HIERARCHY: readonly SourceLane[] = [
  {
    id: "t0.explicit_url",
    tier: 0,
    label: "Exact supplied public URL",
    description: "Fetch only the exact HTTPS URL explicitly supplied by the user.",
    allowedTools: ["fetch_public_source"],
    targetKinds: ["url", "domain", "repository", "publication", "platform_handle"],
    identifierKinds: ["url", "profile_url"],
    sourceTypes: ["official_profile", "company_page", "code_profile", "public_document", "other"],
    admission: "admissible_after_fetch",
    requiresCandidate: false,
    requiresExactCandidateUrl: false,
    trustPrior: 0.94,
    executionCost: 0.16,
    policyRisk: 0.05,
  },
  {
    id: "t0.explicit_identifier",
    tier: 0,
    label: "Exact supplied public identifier",
    description:
      "Search only the exact domain, repository, DOI, ORCID, package, or platform handle supplied by the user.",
    allowedTools: ["search_web"],
    targetKinds: ["domain", "repository", "publication", "package", "platform_handle"],
    identifierKinds: ["domain", "repository", "doi", "orcid", "package", "platform_handle"],
    sourceTypes: ["search_result"],
    admission: "discovery_only",
    requiresCandidate: false,
    requiresExactCandidateUrl: false,
    trustPrior: 0.64,
    executionCost: 0.2,
    policyRisk: 0.08,
  },
  {
    id: "t0.explicit_email_codegraph",
    tier: 0,
    label: "Exact supplied email code graph",
    description: "Use only an exact user-supplied email with GitHub commit/code-graph search.",
    allowedTools: ["github_email_codegraph"],
    targetKinds: ["email"],
    identifierKinds: ["email"],
    sourceTypes: ["code_commit", "code_profile"],
    admission: "admissible_after_fetch",
    requiresCandidate: false,
    requiresExactCandidateUrl: false,
    trustPrior: 0.72,
    executionCost: 0.3,
    policyRisk: 0.18,
  },
  {
    id: "t1.first_party",
    tier: 1,
    label: "First-party and official pages",
    description: "Organization team pages, official biographies, and explicit personal sites.",
    allowedTools: ["search_web", "fetch_public_source"],
    targetKinds: ALL_TARGET_KINDS,
    identifierKinds: [],
    sourceTypes: ["official_profile", "company_page"],
    admission: "admissible_after_fetch",
    requiresCandidate: false,
    requiresExactCandidateUrl: false,
    trustPrior: 0.92,
    executionCost: 0.22,
    policyRisk: 0.05,
  },
  {
    id: "t1.candidate_official_profile",
    tier: 1,
    label: "Candidate-bound official profile",
    description: "Fetch an official biography already linked to one candidate.",
    allowedTools: ["fetch_public_source"],
    targetKinds: ALL_TARGET_KINDS,
    identifierKinds: [],
    sourceTypes: ["official_profile"],
    admission: "admissible_after_fetch",
    requiresCandidate: true,
    requiresExactCandidateUrl: false,
    trustPrior: 0.92,
    executionCost: 0.24,
    policyRisk: 0.05,
  },
  {
    id: "t1.candidate_company_page",
    tier: 1,
    label: "Candidate-bound organization page",
    description: "Fetch an organization biography or team page already linked to one candidate.",
    allowedTools: ["fetch_public_source"],
    targetKinds: ALL_TARGET_KINDS,
    identifierKinds: [],
    sourceTypes: ["company_page"],
    admission: "admissible_after_fetch",
    requiresCandidate: true,
    requiresExactCandidateUrl: false,
    trustPrior: 0.92,
    executionCost: 0.24,
    policyRisk: 0.05,
  },
  {
    id: "t2.structured_professional",
    tier: 2,
    label: "Structured professional records",
    description: "Public repositories, publication indexes, patents, and organization-only official filings.",
    allowedTools: ["search_web", "fetch_public_source", "keybase_identity_proofs"],
    targetKinds: ALL_TARGET_KINDS,
    // Once a candidate exists, provider-attested repositories and professional
    // profiles are eligible even when the initial query was name-only.
    identifierKinds: [],
    sourceTypes: ["professional_profile", "code_profile", "code_commit", "keybase_proof", "public_document"],
    admission: "admissible_after_fetch",
    requiresCandidate: true,
    requiresExactCandidateUrl: false,
    trustPrior: 0.84,
    executionCost: 0.3,
    policyRisk: 0.08,
  },
  {
    id: "t3.institutional",
    tier: 3,
    label: "Universities, conferences, and publishers",
    description: "Institutional pages and primary scholarly or conference publications.",
    allowedTools: ["search_web", "fetch_public_source"],
    targetKinds: ALL_TARGET_KINDS,
    identifierKinds: [],
    sourceTypes: ["official_profile", "public_document"],
    admission: "admissible_after_fetch",
    requiresCandidate: true,
    requiresExactCandidateUrl: false,
    trustPrior: 0.8,
    executionCost: 0.34,
    policyRisk: 0.06,
  },
  {
    id: "t4.reputable_media",
    tier: 4,
    label: "Reputable media and interviews",
    description: "Named interviews and reputable reporting used for corroboration and timeline context.",
    allowedTools: ["search_web", "fetch_public_source"],
    targetKinds: ALL_TARGET_KINDS,
    identifierKinds: [],
    sourceTypes: ["news", "public_document"],
    admission: "admissible_after_fetch",
    requiresCandidate: true,
    requiresExactCandidateUrl: false,
    trustPrior: 0.7,
    executionCost: 0.38,
    policyRisk: 0.08,
  },
  {
    id: "t5.candidate_wayback",
    tier: 5,
    label: "Temporal provenance diff",
    description:
      "Compare bounded raw captures of only an exact HTTPS URL already bound to the candidate by admitted evidence.",
    allowedTools: ["wayback_profile_history"],
    targetKinds: ALL_TARGET_KINDS,
    identifierKinds: [],
    sourceTypes: ["web_archive"],
    admission: "admissible_after_fetch",
    requiresCandidate: true,
    requiresExactCandidateUrl: true,
    trustPrior: 0.58,
    executionCost: 0.52,
    policyRisk: 0.12,
  },
  {
    id: "t6.candidate_public_source",
    tier: 6,
    label: "Candidate-bound public source",
    description: "Hardened fetch of a discovery lead that does not qualify for a higher-trust source lane.",
    allowedTools: ["fetch_public_source"],
    targetKinds: ALL_TARGET_KINDS,
    identifierKinds: [],
    sourceTypes: ["other"],
    admission: "admissible_after_fetch",
    requiresCandidate: true,
    requiresExactCandidateUrl: false,
    trustPrior: 0.3,
    executionCost: 0.42,
    policyRisk: 0.14,
  },
  {
    id: "t6.general_discovery",
    tier: 6,
    label: "General web discovery",
    description: "Broad discovery only; snippets cannot support findings until a hardened direct fetch succeeds.",
    allowedTools: ["search_web"],
    targetKinds: ALL_TARGET_KINDS,
    identifierKinds: [],
    sourceTypes: ["search_result"],
    admission: "discovery_only",
    requiresCandidate: false,
    requiresExactCandidateUrl: false,
    trustPrior: 0.18,
    executionCost: 0.28,
    policyRisk: 0.16,
  },
] as const;

const DENIED_HOST_SUFFIXES = [
  "411.com",
  "beenverified.com",
  "familytreenow.com",
  "fastpeoplesearch.com",
  "intelius.com",
  "peoplefinder.com",
  "peoplesearchnow.com",
  "peekyou.com",
  "pipl.com",
  "radaris.com",
  "spokeo.com",
  "truepeoplesearch.com",
  "usphonebook.com",
  "whitepages.com",
] as const;

const DENIED_SOURCE_TEXT =
  /(?:people[\s_-]*(?:finder|lookup|search)|person[\s_-]*(?:lookup|search)|phone[\s_-]*(?:book|lookup|search)|reverse[\s_-]*phone|home[\s_-]*address|residential[\s_-]*address|property[\s_-]*(?:lookup|owner|ownership|record|tax|assessor)|tax[\s_-]*assessor|family[\s_-]*(?:member|tree)|relative[\s_-]*lookup|credential[\s_-]*(?:dump|broker)|data[\s_-]*broker|private[\s_-]*contact|face[\s_-]*recognition|breach|password)/i;

const DENIED_COMPACT_MARKERS = [
  "accountenumeration",
  "accountexistence",
  "beenverified",
  "bucketbruteforce",
  "bucketenumeration",
  "cloudenumeration",
  "familytree",
  "familytreenow",
  "fastpeoplesearch",
  "homeaddress",
  "iosbinaryanalysis",
  "ipadecryption",
  "intelius",
  "peekyou",
  "peoplefinder",
  "peoplesearchnow",
  "phonelookup",
  "phonebook",
  "pipl",
  "propertylookup",
  "propertyowner",
  "propertyrecord",
  "portscan",
  "radaris",
  "residentialaddress",
  "reversephone",
  "spokeo",
  "subdomainbruteforce",
  "subdomainenumeration",
  "taxassessor",
  "testflightprobe",
  "trafficinterception",
  "truepeoplesearch",
  "usphonebook",
  "whitepages",
] as const;

function decodedTextVariants(value: string): string[] {
  const variants = [value];
  let decoded = value;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
      variants.push(decoded);
    } catch {
      break;
    }
  }
  return variants;
}

/** Shared fail-closed semantic gate for generic tool names and source text. */
export function isDeniedResearchTool(value: string): boolean {
  return decodedTextVariants(value).some((variant) => {
    if (DENIED_SOURCE_TEXT.test(variant)) return true;
    const compact = variant.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "");
    return (
      DENIED_COMPACT_MARKERS.some((marker) => compact.includes(marker)) ||
      /(?:s3|cloud)?bucket(?:bruteforce|discover|enum|list|scan)/.test(compact) ||
      /account(?:discover|enum|existence|lookup|probe|scan)/.test(compact) ||
      /subdomain(?:bruteforce|discover|enum|lookup|scan)/.test(compact) ||
      /(?:ios|ipa)(?:binary)?(?:analysis|decrypt|dump|extract|inspect)/.test(compact) ||
      /testflight(?:discover|enum|lookup|probe|scan)/.test(compact) ||
      /(?:packet|traffic)(?:capture|intercept|sniff)/.test(compact) ||
      /(?:^|lookup)411(?:com|lookup|$)/.test(compact)
    );
  });
}

export function isDeniedResearchSource(value: string): boolean {
  if (isDeniedResearchTool(value)) return true;
  try {
    const url = new URL(value);
    const host = url.hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
    return (
      DENIED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`)) ||
      isDeniedResearchTool(`${url.pathname} ${url.search}`)
    );
  } catch {
    return false;
  }
}

function genericSourceLane(tool: string): SourceLane | undefined {
  if (
    !tool ||
    tool !== tool.trim() ||
    isDeniedResearchTool(tool) ||
    SOURCE_HIERARCHY.some((lane) => lane.allowedTools.includes(tool))
  )
    return undefined;
  // Generic tool lane identifiers deliberately retain the legacy ASCII-only
  // slug grammar even though human-name comparison supports Unicode.
  const slug = Array.from(normalizeComparable(tool))
    .map((character) => (character.charCodeAt(0) <= 0x7f ? character : " "))
    .join("")
    .trim()
    .replace(/\s+/g, "_");
  if (!slug) return undefined;
  const requiresCandidate = /(?:fetch|verify|corroborate|profile|company)/i.test(tool);
  const discoveryOnly = /search/i.test(tool);
  return {
    id: `t6.tool.${slug}`,
    tier: 6,
    label: `Allowlisted ${tool} lane`,
    description: "Caller-supplied public-professional tool retained under the same source policy.",
    allowedTools: [tool],
    targetKinds: ALL_TARGET_KINDS,
    identifierKinds: [],
    sourceTypes: discoveryOnly ? ["search_result"] : ["other"],
    admission: "discovery_only",
    requiresCandidate,
    requiresExactCandidateUrl: false,
    trustPrior: 0.18,
    executionCost: 0.4,
    policyRisk: 0.15,
  };
}

export function sourceLaneById(id: string): SourceLane | undefined {
  return SOURCE_HIERARCHY.find((lane) => lane.id === id);
}

/**
 * Resolve the canonical fetch lane for a URL that has already been classified
 * mechanically. This is intentionally separate from the search action's lane:
 * discovery transport provenance must not mislabel the source that will later
 * be fetched and admitted.
 */
export function classifiedFetchLaneId(
  sourceType: EvidenceSourceType | null,
  sourceTier: SourceTier | null,
  candidateBound: boolean,
): string | null {
  if (!sourceType || sourceType === "search_result" || sourceTier === null) return null;
  const compatible = SOURCE_HIERARCHY.filter(
    (lane) =>
      lane.tier === sourceTier &&
      lane.allowedTools.includes("fetch_public_source") &&
      lane.sourceTypes.includes(sourceType),
  );
  const exactScope = compatible.find((lane) => lane.requiresCandidate === candidateBound);
  return exactScope?.id ?? compatible[0]?.id ?? null;
}

export function sourceLaneForFrontierEntry(entry: {
  sourceLaneId: string;
  sourceTier: SourceTier;
  allowedTools: readonly string[];
  candidateId: string | null;
}): SourceLane | undefined {
  const registered = sourceLaneById(entry.sourceLaneId);
  if (registered) {
    const candidateIndependentCompilerSearch =
      registered.requiresCandidate &&
      entry.candidateId === null &&
      entry.allowedTools.length === 1 &&
      entry.allowedTools[0] === "search_web" &&
      registered.allowedTools.includes("search_web");
    return registered.tier === entry.sourceTier &&
      entry.allowedTools.length > 0 &&
      entry.allowedTools.every((tool) => registered.allowedTools.includes(tool)) &&
      (registered.requiresCandidate === (entry.candidateId !== null) || candidateIndependentCompilerSearch)
      ? registered
      : undefined;
  }
  if (entry.allowedTools.length !== 1) return undefined;
  const generic = genericSourceLane(entry.allowedTools[0]);
  return generic &&
    generic.id === entry.sourceLaneId &&
    generic.tier === entry.sourceTier &&
    generic.requiresCandidate === (entry.candidateId !== null)
    ? generic
    : undefined;
}

export function laneAllowsTool(laneId: string, tool: string): boolean {
  return sourceLaneById(laneId)?.allowedTools.includes(tool) ?? false;
}

export interface SourceTierContext {
  /** Hosts established independently of the current adapter result. */
  firstPartyHosts?: readonly string[];
  /** Explicit target organization names used only for exact domain-label matches. */
  organizationNames?: readonly string[];
}

const GITHUB_HANDLE_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/**
 * Extract a GitHub login only from the canonical public-profile URL shape.
 * Repository paths, query variants, fragments, credentials, and alternate
 * hosts are deliberately excluded so this value can safely parameterize a
 * candidate-bound identity-proof lookup.
 */
export function githubHandleFromCanonicalProfileUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLocaleLowerCase("en-US") !== "github.com" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    )
      return null;
    const match = url.pathname.match(/^\/([^/]+)\/?$/);
    if (!match || !GITHUB_HANDLE_PATTERN.test(match[1])) return null;
    return match[1].toLocaleLowerCase("en-US");
  } catch {
    return null;
  }
}

function publicHostname(value: string): string | null {
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return url.protocol === "https:" ? url.hostname.toLocaleLowerCase("en-US").replace(/^www\./, "") : null;
  } catch {
    return null;
  }
}

export function sourceTierContextForState(
  state: Pick<InvestigationState, "target" | "candidates" | "evidence">,
  candidateId: string | undefined,
): SourceTierContext {
  const firstPartyHosts = new Set<string>();
  for (const identifier of state.target.identifiers) {
    if (identifier.provenance !== "user_input") continue;
    const host =
      identifier.kind === "email"
        ? (identifier.normalizedValue.split("@")[1] ?? null)
        : publicHostname(identifier.value);
    if (host) firstPartyHosts.add(host);
  }
  const candidate = candidateId ? state.candidates.find((item) => item.id === candidateId) : undefined;
  for (const signal of candidate?.signals ?? []) {
    if (
      !["profile_url", "personal_domain"].includes(signal.kind) ||
      !["verified", "corroborated"].includes(signal.assurance) ||
      !signal.sourceEvidenceId ||
      !state.evidence.some(
        (evidence) =>
          evidence.id === signal.sourceEvidenceId &&
          evidence.candidateId === candidateId &&
          evidence.disposition === "supports",
      )
    )
      continue;
    const host = publicHostname(signal.value);
    if (host) firstPartyHosts.add(host);
  }
  return {
    firstPartyHosts: [...firstPartyHosts].sort(),
    organizationNames: state.target.organizationHints.map((organization) => organization.name),
  };
}

function hostMatchesFirstPartyContext(host: string, context: SourceTierContext): boolean {
  const normalizedHosts = (context.firstPartyHosts ?? []).map((value) =>
    value.toLocaleLowerCase("en-US").replace(/^www\./, ""),
  );
  if (normalizedHosts.some((value) => host === value || host.endsWith(`.${value}`))) return true;
  const labels = host.split(".").map((label) => label.replace(/[^a-z0-9]+/g, ""));
  return (context.organizationNames ?? []).some((name) => {
    const organization = normalizeComparable(name).replace(/[^a-z0-9]+/g, "");
    return organization.length >= 3 && labels.includes(organization);
  });
}

const PROFESSIONAL_PROFILE_HOSTS = ["linkedin.com", "crunchbase.com"] as const;
const REPUTABLE_MEDIA_HOSTS = [
  "apnews.com",
  "bbc.com",
  "bloomberg.com",
  "forbes.com",
  "nytimes.com",
  "reuters.com",
  "techcrunch.com",
  "wsj.com",
] as const;

function hostMatches(host: string, suffixes: readonly string[]): boolean {
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** Only canonical public App Store product listings qualify as T2 metadata. */
function isCanonicalAppStoreListingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLocaleLowerCase("en-US") !== "apps.apple.com" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443")
    )
      return false;
    const segments = url.pathname.split("/").filter(Boolean);
    if (/^[a-z]{2}(?:-[a-z]{2})?$/i.test(segments[0] ?? "")) segments.shift();
    if (segments[0]?.toLocaleLowerCase("en-US") !== "app") return false;
    if (segments.length !== 2 && segments.length !== 3) return false;
    const listingId = segments.at(-1) ?? "";
    const slug = segments.length === 3 ? segments[1] : null;
    return /^id\d+$/.test(listingId) && (slug === null || Boolean(slug));
  } catch {
    return false;
  }
}

/** Only an exact public Scholar author page qualifies for T2 discovery. */
function isCanonicalGoogleScholarProfileUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname.toLocaleLowerCase("en-US") !== "scholar.google.com" ||
      url.pathname !== "/citations" ||
      url.username ||
      url.password ||
      (url.port && url.port !== "443")
    )
      return false;
    const user = url.searchParams.get("user") ?? "";
    const allowedParameters = new Set(["user", "hl"]);
    return (
      /^[A-Za-z0-9_-]{4,64}$/.test(user) && [...url.searchParams.keys()].every((key) => allowedParameters.has(key))
    );
  } catch {
    return false;
  }
}

/** Classify fetched URLs from host and admitted context, never model prose. */
export function deterministicSourceTypeForUrl(
  value: string,
  context: SourceTierContext = {},
  preferredFirstPartyType: Extract<EvidenceSourceType, "official_profile" | "company_page"> = "official_profile",
): EvidenceSourceType | null {
  if (isDeniedResearchSource(value)) return null;
  const host = publicHostname(value);
  if (!host) return null;
  if (hostMatches(host, PROFESSIONAL_PROFILE_HOSTS)) return "professional_profile";
  if (host === "github.com" || host.endsWith(".github.io")) return "code_profile";
  if (isCanonicalAppStoreListingUrl(value)) return "public_document";
  if (isCanonicalGoogleScholarProfileUrl(value)) return "public_document";
  if (host === "openreview.net" || host === "semanticscholar.org" || host === "openalex.org") return "public_document";
  if (hostMatches(host, REPUTABLE_MEDIA_HOSTS)) return "news";
  if (hostMatchesFirstPartyContext(host, context)) return preferredFirstPartyType;
  if (
    host.endsWith(".edu") ||
    host.endsWith(".gov") ||
    host === "sec.gov" ||
    host === "companieshouse.gov.uk" ||
    host === "uspto.gov" ||
    host === "orcid.org" ||
    host === "doi.org" ||
    host === "openalex.org" ||
    host === "openreview.net" ||
    host === "semanticscholar.org" ||
    host === "crossref.org" ||
    host === "patentsview.org" ||
    host === "npmjs.com"
  )
    return "public_document";
  return "other";
}

export function sourceTierForUrl(
  value: string,
  sourceType?: EvidenceSourceType,
  explicit = false,
  context: SourceTierContext = {},
): SourceTier | null {
  if (isDeniedResearchSource(value)) return null;
  if (explicit) return 0;
  if (sourceType === "web_archive") return 5;
  if (sourceType === "search_result") return 6;
  if (
    sourceType === "professional_profile" ||
    sourceType === "code_profile" ||
    sourceType === "code_commit" ||
    sourceType === "keybase_proof"
  )
    return 2;
  let host = "";
  try {
    host = new URL(value).hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
  } catch {
    return null;
  }
  if (host.endsWith(".gov") || host === "sec.gov" || host === "companieshouse.gov.uk" || host === "uspto.gov") return 2;
  if (
    host === "github.com" ||
    host.endsWith(".github.io") ||
    host === "orcid.org" ||
    host === "doi.org" ||
    host === "openalex.org" ||
    host === "openreview.net" ||
    host === "semanticscholar.org" ||
    host === "crossref.org" ||
    host === "patentsview.org" ||
    host === "npmjs.com" ||
    isCanonicalAppStoreListingUrl(value) ||
    isCanonicalGoogleScholarProfileUrl(value)
  )
    return 2;
  if (host.endsWith(".edu") || sourceType === "public_document") return 3;
  if (sourceType === "news") return 4;
  if (sourceType === "official_profile" || sourceType === "company_page") {
    return hostMatchesFirstPartyContext(host, context) ? 1 : 6;
  }
  return 6;
}

function laneMatchesTarget(lane: SourceLane, target: ParsedTarget): boolean {
  if (!lane.targetKinds.includes(target.kind)) return false;
  if (lane.identifierKinds.length === 0) return true;
  return target.identifiers.some(
    (identifier) => identifier.provenance === "user_input" && lane.identifierKinds.includes(identifier.kind),
  );
}

export function sourceLanesForTarget(
  target: ParsedTarget,
  availableTools: readonly string[],
  options: {
    candidateId?: string | null;
    /**
     * Expose only the search projection of candidate-gated lanes so canonical
     * compiler queries can discover a candidate. Fetch and specialist tools
     * remain unavailable until a candidate exists.
     */
    includeCompilerDiscovery?: boolean;
  } = {},
): SourceLane[] {
  const suppliedValues = target.identifiers
    .filter((identifier) => identifier.provenance === "user_input")
    .map((identifier) => identifier.value);
  if (isDeniedResearchSource(target.normalizedQuery) || suppliedValues.some((value) => isDeniedResearchSource(value)))
    return [];
  const toolSet = new Set(availableTools);
  const registered = SOURCE_HIERARCHY.filter((lane) => laneMatchesTarget(lane, target))
    .filter(
      (lane) =>
        !lane.requiresCandidate ||
        Boolean(options.candidateId) ||
        (options.includeCompilerDiscovery === true && lane.allowedTools.includes("search_web")),
    )
    .map((lane) => ({
      ...lane,
      allowedTools: lane.allowedTools.filter(
        (tool) =>
          toolSet.has(tool) && (!lane.requiresCandidate || Boolean(options.candidateId) || tool === "search_web"),
      ),
    }))
    .filter((lane) => lane.allowedTools.length > 0);

  const knownTools = new Set(SOURCE_HIERARCHY.flatMap((lane) => lane.allowedTools));
  const generic = availableTools
    .filter((tool) => !knownTools.has(tool))
    .map(genericSourceLane)
    .filter((lane): lane is SourceLane => Boolean(lane))
    .filter((lane) => (lane.requiresCandidate ? Boolean(options.candidateId) : !options.candidateId));

  return [...registered, ...generic].sort((left, right) => left.tier - right.tier || left.id.localeCompare(right.id));
}

export function sourceLaneQueryHint(target: ParsedTarget, lane: SourceLane): string {
  const explicit = target.identifiers.find(
    (identifier) => identifier.provenance === "user_input" && lane.identifierKinds.includes(identifier.kind),
  );
  const compiled = explicit ? null : compiledQueryForLane(target, lane);
  const base = explicit?.value ?? compiled?.query ?? target.normalizedQuery;
  return normalizeWhitespace(base).slice(0, 320);
}

/**
 * Project the finite compiler plan into legal source lanes. Each surviving
 * compiler query is assigned exactly once: baseline and supplied context to
 * T1, structured sites to T2, institution/document operators to T3, and
 * bounded general/name refinements to discovery-only T6. Context stays ahead
 * of generic site scopes so disambiguating user input is not stranded behind
 * broad provider work.
 */
export function compiledQueriesForLane(
  target: ParsedTarget,
  lane: Pick<SourceLane, "id" | "allowedTools">,
): CompiledOsintQuery[] {
  if (!lane.allowedTools.includes("search_web")) return [];
  const institutionDomains = target.identifiers
    .filter((identifier) => identifier.provenance === "user_input")
    .flatMap((identifier) => {
      if (identifier.kind === "email") return [identifier.normalizedValue.split("@")[1] ?? ""];
      if (identifier.kind === "domain") return [identifier.normalizedValue];
      return [];
    });
  const plan = compileOsintQueries(target, { institutionDomains });
  if (plan.status !== "compiled") return [];
  if (lane.id === "t1.first_party") {
    return plan.queries.filter((query) => query.kind === "exact_baseline" || query.kind === "exact_context");
  }
  if (lane.id === "t2.structured_professional") {
    return plan.queries.filter((query) => query.kind === "professional_site" || query.kind === "public_metadata_site");
  }
  if (lane.id === "t3.institutional") {
    return plan.queries.filter((query) => query.kind === "institution_site" || query.kind === "public_document");
  }
  if (lane.id === "t4.reputable_media") {
    return [];
  }
  if (lane.id === "t6.general_discovery") {
    return plan.queries.filter(
      (query) =>
        query.kind === "exact_refinement" || query.kind === "orthographic_name" || query.kind === "initial_name",
    );
  }
  return [];
}

/** Compatibility helper for callers that need only the first lane query. */
export function compiledQueryForLane(
  target: ParsedTarget,
  lane: Pick<SourceLane, "id" | "allowedTools">,
): CompiledOsintQuery | null {
  return compiledQueriesForLane(target, lane)[0] ?? null;
}

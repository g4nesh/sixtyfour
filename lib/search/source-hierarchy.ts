import { normalizeComparable, normalizeLabelTokens, normalizeWhitespace } from "../domain/runtime";
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
    sourceTypes: [
      "official_profile",
      "company_page",
      "professional_profile",
      "code_profile",
      "code_commit",
      "public_document",
      "other",
    ],
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
  /** Named-person labels used only for bounded lead scheduling, never source trust. */
  personNames?: readonly string[];
}

export type DiscoveryLeadSchedulingDisposition = "reject" | "deprioritize" | "neutral" | "prioritize";

export type DiscoveryLeadSchedulingReason =
  | "invalid_url"
  | "non_professional_navigation"
  | "resume_or_template"
  | "quote_content"
  | "stock_media"
  | "generic_person_homepage"
  | "candidate_bio_path"
  | "exact_subject_slug_probe"
  | "neutral";

export interface DiscoveryLeadSchedulingDecision {
  disposition: DiscoveryLeadSchedulingDisposition;
  reason: DiscoveryLeadSchedulingReason;
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
  const personNames = new Set<string>();
  if (state.target.kind === "named_person") {
    if (state.target.name) personNames.add(state.target.name);
    if (candidate?.displayName) personNames.add(candidate.displayName);
  }
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
    personNames: [...personNames].sort((left, right) => left.localeCompare(right)),
  };
}

function hostMatchesExplicitFirstPartyHost(host: string, context: SourceTierContext): boolean {
  const normalizedHosts = (context.firstPartyHosts ?? []).map((value) =>
    value.toLocaleLowerCase("en-US").replace(/^www\./, ""),
  );
  return normalizedHosts.some((value) => host === value || host.endsWith(`.${value}`));
}

function hostMatchesFirstPartyContext(host: string, context: SourceTierContext): boolean {
  if (hostMatchesExplicitFirstPartyHost(host, context)) return true;
  const labels = host.split(".").map((label) => label.replace(/[^a-z0-9]+/g, ""));
  return (context.organizationNames ?? []).some((name) => {
    const organization = normalizeComparable(name).replace(/[^a-z0-9]+/g, "");
    return organization.length >= 3 && labels.includes(organization);
  });
}

const PROFESSIONAL_PROFILE_HOSTS = ["crunchbase.com"] as const;
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

interface KnownSourceShape {
  sourceType: EvidenceSourceType;
  tier: SourceTier;
}

const GITHUB_RESERVED_ROOT_PATHS = new Set([
  "about",
  "account",
  "apps",
  "codespaces",
  "collections",
  "contact",
  "copilot",
  "customer-stories",
  "dashboard",
  "enterprise",
  "events",
  "explore",
  "features",
  "issues",
  "login",
  "marketplace",
  "new",
  "notifications",
  "organizations",
  "orgs",
  "pricing",
  "pulls",
  "readme",
  "resources",
  "search",
  "security",
  "settings",
  "signup",
  "site",
  "solutions",
  "sponsors",
  "stars",
  "team",
  "topics",
  "trending",
  "watching",
]);
const GITHUB_REPOSITORY_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
const GITHUB_COMMIT_PATTERN = /^[a-f0-9]{7,64}$/i;
const PROFESSIONAL_SLUG_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,158}[A-Za-z0-9])?$/;

function httpsUrlForKnownSourceShape(value: string): URL | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443")
      ? url
      : null;
  } catch {
    return null;
  }
}

function githubSourceShape(url: URL): KnownSourceShape {
  if (url.pathname.includes("//")) return { sourceType: "other", tier: 6 };
  const segments = url.pathname.split("/").filter(Boolean);
  const owner = segments[0] ?? "";
  if (!GITHUB_HANDLE_PATTERN.test(owner) || GITHUB_RESERVED_ROOT_PATHS.has(owner.toLocaleLowerCase("en-US"))) {
    return { sourceType: "other", tier: 6 };
  }
  if (segments.length === 1) return { sourceType: "code_profile", tier: 2 };
  const repository = segments[1] ?? "";
  if (!GITHUB_REPOSITORY_PATTERN.test(repository) || repository.toLocaleLowerCase("en-US").endsWith(".git")) {
    return { sourceType: "other", tier: 6 };
  }
  if (segments.length === 2) return { sourceType: "code_profile", tier: 2 };
  if (segments.length === 4 && segments[2] === "commit" && GITHUB_COMMIT_PATTERN.test(segments[3])) {
    return { sourceType: "code_commit", tier: 2 };
  }
  if (segments.length >= 5 && segments[2] === "blob") {
    return { sourceType: "code_profile", tier: 2 };
  }
  return { sourceType: "other", tier: 6 };
}

function isValidOrcidPath(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{4})-(\d{4})-(\d{3}[\dX])$/i);
  if (!match) return false;
  const compact = match.slice(1).join("").toLocaleUpperCase("en-US");
  let total = 0;
  for (const character of compact.slice(0, 15)) total = (total + Number(character)) * 2;
  const result = (12 - (total % 11)) % 11;
  return compact.at(-1) === (result === 10 ? "X" : String(result));
}

function decodedPathSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function isCanonicalDoi(value: string): boolean {
  return /^10\.\d{4,9}\/[\p{L}\p{N}][^\s?#]{0,300}$/iu.test(value);
}

function scholarlySourceShape(url: URL, host: string): KnownSourceShape | null {
  const segments = url.pathname.split("/").filter(Boolean);
  if (host === "orcid.org") {
    return segments.length === 1 && isValidOrcidPath(segments[0])
      ? { sourceType: "professional_profile", tier: 2 }
      : { sourceType: "other", tier: 6 };
  }
  if (host === "scholar.google.com") {
    return isCanonicalGoogleScholarProfileUrl(url.href)
      ? { sourceType: "public_document", tier: 2 }
      : { sourceType: "other", tier: 6 };
  }
  if (host === "semanticscholar.org" || host.endsWith(".semanticscholar.org")) {
    const isWebHost = host === "semanticscholar.org";
    const isApiHost = host === "api.semanticscholar.org";
    const webAuthorId =
      isWebHost && segments.length === 2 && segments[0] === "author"
        ? segments[1]
        : isWebHost && segments.length === 3 && segments[0] === "author"
          ? segments[2]
          : null;
    const apiAuthorId =
      isApiHost && segments.length === 4 && segments[0] === "graph" && segments[1] === "v1" && segments[2] === "author"
        ? segments[3]
        : null;
    if (/^\d{1,24}$/.test(webAuthorId ?? apiAuthorId ?? "")) {
      return { sourceType: "professional_profile", tier: 2 };
    }
    const webPaperId =
      isWebHost && segments.length === 2 && segments[0] === "paper"
        ? segments[1]
        : isWebHost && segments.length === 3 && segments[0] === "paper"
          ? segments[2]
          : null;
    const apiPaperId =
      isApiHost && segments.length === 4 && segments[0] === "graph" && segments[1] === "v1" && segments[2] === "paper"
        ? segments[3]
        : null;
    return /^[a-f0-9]{40}$/i.test(webPaperId ?? apiPaperId ?? "")
      ? { sourceType: "public_document", tier: 3 }
      : { sourceType: "other", tier: 6 };
  }
  if (host === "openalex.org" || host.endsWith(".openalex.org")) {
    const isWebHost = host === "openalex.org";
    const isApiHost = host === "api.openalex.org";
    const record =
      isWebHost && segments.length === 1 ? segments[0] : isApiHost && segments.length === 2 ? segments[1] : "";
    const validApiCollection =
      (isWebHost && segments.length === 1) ||
      (isApiHost &&
        segments.length === 2 &&
        ((segments[0] === "authors" && /^A\d{3,18}$/.test(record)) ||
          (segments[0] === "works" && /^W\d{3,18}$/.test(record))));
    if (!validApiCollection) return { sourceType: "other", tier: 6 };
    if (/^A\d{3,18}$/.test(record)) return { sourceType: "professional_profile", tier: 2 };
    return /^W\d{3,18}$/.test(record) ? { sourceType: "public_document", tier: 3 } : { sourceType: "other", tier: 6 };
  }
  if (host === "openreview.net" || host.endsWith(".openreview.net")) {
    if (host !== "openreview.net") return { sourceType: "other", tier: 6 };
    const exactIdParameter = url.searchParams.size === 1 && [...url.searchParams.keys()].every((key) => key === "id");
    const id = url.searchParams.get("id") ?? "";
    if (url.pathname === "/profile" && exactIdParameter && /^~[A-Za-z0-9_.-]{2,160}\d$/.test(id)) {
      return { sourceType: "professional_profile", tier: 2 };
    }
    return ["/forum", "/pdf"].includes(url.pathname) && exactIdParameter && /^[A-Za-z0-9_-]{4,128}$/.test(id)
      ? { sourceType: "public_document", tier: 3 }
      : { sourceType: "other", tier: 6 };
  }
  if (host === "crossref.org" || host.endsWith(".crossref.org")) {
    const encodedDoi =
      host === "api.crossref.org" && segments.length === 2 && segments[0] === "works" ? segments[1] : null;
    const doi = encodedDoi ? decodedPathSegment(encodedDoi) : null;
    return doi && isCanonicalDoi(doi) ? { sourceType: "public_document", tier: 3 } : { sourceType: "other", tier: 6 };
  }
  if (host === "doi.org") {
    const doi = decodedPathSegment(url.pathname.replace(/^\/+/, ""));
    return doi && isCanonicalDoi(doi) ? { sourceType: "public_document", tier: 3 } : { sourceType: "other", tier: 6 };
  }
  return null;
}

/**
 * Give known aggregators a tier only when their path identifies a concrete
 * public record. Host membership by itself is not a professional-source
 * signal: navigation, search, feeds, jobs, topics, and issue queues stay T6.
 */
function knownSourceShapeForUrl(value: string): KnownSourceShape | null {
  const url = httpsUrlForKnownSourceShape(value);
  if (!url) return null;
  const host = url.hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
  const scholarlyShape = scholarlySourceShape(url, host);
  if (scholarlyShape) return scholarlyShape;
  if (host === "github.com") return githubSourceShape(url);
  if (host.endsWith(".github.com") || host === "github.io" || host.endsWith(".github.io")) {
    return { sourceType: "other", tier: 6 };
  }
  if (hostMatches(host, ["linkedin.com"])) {
    const profile = url.pathname.match(/^\/in\/([^/]+)\/?$/i);
    return profile && PROFESSIONAL_SLUG_PATTERN.test(profile[1])
      ? { sourceType: "professional_profile", tier: 2 }
      : { sourceType: "other", tier: 6 };
  }
  if (hostMatches(host, ["researchgate.net"])) {
    const profile = url.pathname.match(/^\/profile\/([^/]+)\/?$/i);
    if (profile && PROFESSIONAL_SLUG_PATTERN.test(profile[1])) {
      return { sourceType: "professional_profile", tier: 2 };
    }
    const publication = url.pathname.match(/^\/publication\/(\d{3,}(?:[-_][^/]+)?)\/?$/i);
    return publication ? { sourceType: "public_document", tier: 3 } : { sourceType: "other", tier: 6 };
  }
  if (host === "apps.apple.com") {
    // A product listing is useful passive metadata, but a target-independent
    // URL classifier cannot establish that it identifies a person. Keep it as
    // a T3 document so it must survive ordinary candidate/content gates and
    // can never outrank canonical T2 person or code records on URL shape alone.
    return isCanonicalAppStoreListingUrl(value)
      ? { sourceType: "public_document", tier: 3 }
      : { sourceType: "other", tier: 6 };
  }
  return null;
}

/** Only canonical public App Store product listings qualify as public metadata. */
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

const NON_PROFESSIONAL_NAVIGATION_SEGMENTS = new Set([
  "category",
  "categories",
  "collections",
  "discover",
  "explore",
  "feed",
  "feeds",
  "jobs",
  "search",
  "search results",
  "tag",
  "tags",
  "topic",
  "topics",
]);
const PERSON_PAGE_PATH_SEGMENTS = new Set([
  "about",
  "bio",
  "biography",
  "executive",
  "executives",
  "founder",
  "founders",
  "leader",
  "leaders",
  "leadership",
  "management",
  "people",
  "person",
  "profile",
  "profiles",
  "team",
]);
const NON_PERSON_DOCUMENT_PATH_SEGMENTS = new Set([
  "article",
  "articles",
  "blog",
  "blogs",
  "document",
  "documents",
  "news",
  "paper",
  "papers",
  "post",
  "posts",
  "publication",
  "publications",
  "report",
  "reports",
  "story",
  "stories",
]);
const PERSON_PAGE_TITLE_SUFFIX_MARKERS = new Set([
  "author",
  "bio",
  "biography",
  "chair",
  "chairman",
  "chairperson",
  "chairwoman",
  "director",
  "engineer",
  "entrepreneur",
  "executive",
  "executives",
  "founder",
  "founders",
  "inventor",
  "leader",
  "leaders",
  "leadership",
  "management",
  "president",
  "professor",
  "profile",
  "researcher",
  "scientist",
]);
const STOCK_MEDIA_HOSTS = [
  "alamy.com",
  "depositphotos.com",
  "dreamstime.com",
  "gettyimages.com",
  "istockphoto.com",
  "shutterstock.com",
  "stock.adobe.com",
] as const;
const QUOTE_CONTENT_HOSTS = ["azquotes.com", "brainyquote.com", "quotefancy.com"] as const;
const RESUME_TEMPLATE_HOSTS = ["enhancv.com", "kickresume.com", "resume.io", "resumegenius.com", "zety.com"] as const;

function boundedComparable(value: string | null | undefined, maximum: number): string {
  if (!value) return "";
  return normalizeLabelTokens(value.normalize("NFKC").slice(0, maximum));
}

function comparableContainsPhrase(value: string, phrase: string): boolean {
  return Boolean(phrase) && ` ${value} `.includes(` ${phrase} `);
}

function decodedLeadPath(url: URL): string | null {
  let path = url.pathname;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const decoded = decodeURIComponent(path);
      if (decoded === path) break;
      path = decoded;
    } catch {
      return null;
    }
  }
  return path;
}

function normalizedRouteTokens(pathSegments: readonly string[]): string[] {
  return pathSegments.flatMap((segment) => segment.split(" ").filter(Boolean));
}

function hasPersonPageMarker(pathSegments: readonly string[]): boolean {
  return normalizedRouteTokens(pathSegments).some((token) => PERSON_PAGE_PATH_SEGMENTS.has(token));
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fetchedTitleMatchesExactPersonPagePrefix(fetchedTitle: string, personName: string): boolean {
  const normalizedTitle = normalizeWhitespace(fetchedTitle.normalize("NFKC").slice(0, 480));
  const normalizedName = normalizeWhitespace(personName.normalize("NFKC").slice(0, 160));
  if (!normalizedTitle || !normalizedName) return false;
  const prefix = normalizedTitle.match(
    new RegExp(`^${escapeRegularExpression(normalizedName)}(?:\\s*:\\s*|\\s*\\|\\s*|\\s+[—–-]\\s+)(.{1,240})$`, "iu"),
  );
  if (!prefix) return false;
  return boundedComparable(prefix[1], 240)
    .split(" ")
    .some((token) => PERSON_PAGE_TITLE_SUFFIX_MARKERS.has(token));
}

/**
 * Re-check one hardened fetched page whose provider lead was already marked as
 * a candidate-bio path. This intentionally requires either an exact fetched
 * title or an exact-name title prefix with an explicit professional marker,
 * plus an exact terminal person slug and bounded profile-route marker. Splitting
 * normalized route segments into tokens admits shapes such as
 * `/business-leaders/name` without treating `/articles/name` as a person page.
 *
 * This is a post-fetch shape predicate only. It does not classify the source,
 * change its tier or reliability, bind candidates, or authorize redirects.
 */
export function exactFetchedPersonBioPath(
  value: string,
  fetchedTitle: string | null,
  context: SourceTierContext = {},
): boolean {
  if (!fetchedTitle || value.length > 2_048 || isDeniedResearchSource(value)) return false;
  const url = httpsUrlForKnownSourceShape(value);
  if (!url) return false;
  const decodedPath = decodedLeadPath(url);
  if (decodedPath === null) return false;
  const rawPathSegments = decodedPath.split("/").filter(Boolean);
  if (decodedPath.length > 1_024 || rawPathSegments.length < 2 || rawPathSegments.length > 6) return false;

  const pathSegments = rawPathSegments.map((segment) => boundedComparable(segment, 160));
  if (pathSegments.some((segment) => !segment)) return false;
  const routeSegments = pathSegments.slice(0, -1);
  const routeTokens = normalizedRouteTokens(routeSegments);
  if (
    routeTokens.some(
      (token) => NON_PROFESSIONAL_NAVIGATION_SEGMENTS.has(token) || NON_PERSON_DOCUMENT_PATH_SEGMENTS.has(token),
    ) ||
    !hasPersonPageMarker(routeSegments)
  )
    return false;

  const titleComparable = boundedComparable(fetchedTitle, 480);
  const terminalSlug = pathSegments.at(-1) ?? "";
  return (context.personNames ?? []).some((personName) => {
    const name = boundedComparable(personName, 160);
    if (!name || name.length < 2 || name.split(" ").length > 8 || terminalSlug !== name) return false;
    return titleComparable === name || fetchedTitleMatchesExactPersonPagePrefix(fetchedTitle, personName);
  });
}

function normalizedLeadPersonNames(context: SourceTierContext): string[] {
  return [...new Set((context.personNames ?? []).map((name) => boundedComparable(name, 160)).filter(Boolean))]
    .filter((name) => name.length >= 2 && name.split(" ").length <= 8)
    .sort((left, right) => left.localeCompare(right));
}

const ORGANIZATION_ACRONYM_IGNORED_TOKENS = new Set(["and", "at", "for", "of", "the"]);
const GENERIC_ORGANIZATION_HOST_TOKENS = new Set([
  "academy",
  "college",
  "company",
  "corporation",
  "department",
  "group",
  "institute",
  "institution",
  "laboratory",
  "school",
  "state",
  "university",
]);

function organizationSchedulingSignals(context: SourceTierContext): Array<{
  acronym: string;
  hostAliases: string[];
  name: string;
}> {
  return [...new Set((context.organizationNames ?? []).map((name) => boundedComparable(name, 200)).filter(Boolean))]
    .filter((name) => name.split(" ").length <= 12)
    .map((name) => {
      const tokens = name.split(" ").filter(Boolean);
      const acronym = tokens
        .filter((token) => token.length > 0 && !ORGANIZATION_ACRONYM_IGNORED_TOKENS.has(token))
        .map((token) => token[0])
        .join("");
      const boundedAcronym = acronym.length >= 3 && acronym.length <= 8 ? acronym : "";
      const compactName = tokens.join("");
      const hostAliases = [
        compactName.length >= 3 && compactName.length <= 63 ? compactName : "",
        boundedAcronym,
        ...tokens.filter(
          (token) => token.length >= 4 && token.length <= 63 && !GENERIC_ORGANIZATION_HOST_TOKENS.has(token),
        ),
      ].filter(Boolean);
      return { acronym: boundedAcronym, hostAliases: [...new Set(hostAliases)], name };
    });
}

/**
 * Classify only discovery-lead traversal value. This result must never alter
 * source type, source tier, evidence reliability, identity binding, or finding
 * confidence. Provider titles are untrusted and are used only after bounded
 * normalization together with deterministic URL shape and target labels.
 */
export function discoveryLeadSchedulingDecision(
  value: string,
  title: string | null = null,
  context: SourceTierContext = {},
): DiscoveryLeadSchedulingDecision {
  if (value.length > 2_048 || isDeniedResearchSource(value)) {
    return { disposition: "reject", reason: "invalid_url" };
  }
  const url = httpsUrlForKnownSourceShape(value);
  if (!url) return { disposition: "reject", reason: "invalid_url" };
  const decodedPath = decodedLeadPath(url);
  if (decodedPath === null) return { disposition: "reject", reason: "invalid_url" };
  const rawPathSegments = decodedPath.split("/").filter(Boolean);
  if (decodedPath.length > 1_024 || rawPathSegments.length > 12) {
    return { disposition: "reject", reason: "non_professional_navigation" };
  }

  const host = url.hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
  const pathSegments = rawPathSegments.map((segment) => boundedComparable(segment, 160));
  const pathComparable = boundedComparable(decodedPath.replaceAll("/", " "), 1_024);
  const titleComparable = boundedComparable(title, 1_000);
  const combinedComparable = `${pathComparable} ${titleComparable}`.trim();
  const knownShape = knownSourceShapeForUrl(value);
  const protectedStructuredRecord = Boolean(
    knownShape &&
    knownShape.sourceType !== "other" &&
    (knownShape.tier === 2 || (hostMatches(host, ["researchgate.net"]) && knownShape.tier === 3)),
  );
  if (protectedStructuredRecord) return { disposition: "neutral", reason: "neutral" };

  const resumeOrTemplate =
    hostMatches(host, RESUME_TEMPLATE_HOSTS) ||
    /\b(?:resume|cv|curriculum vitae) (?:builder|example|examples|format|formats|sample|samples|template|templates)\b/.test(
      combinedComparable,
    ) ||
    /\b(?:builder|example|examples|sample|samples|template|templates) (?:resume|cv)\b/.test(combinedComparable);
  if (resumeOrTemplate) return { disposition: "reject", reason: "resume_or_template" };

  const quoteContent =
    hostMatches(host, QUOTE_CONTENT_HOSTS) ||
    pathSegments.some((segment) => segment === "quote" || segment === "quotes") ||
    /\bquotes\b|\b(?:daily|famous|inspirational|motivational) quote\b|\bquote (?:generator|maker|widget)\b/.test(
      combinedComparable,
    );
  if (quoteContent && !hostMatches(host, REPUTABLE_MEDIA_HOSTS)) {
    return { disposition: "reject", reason: "quote_content" };
  }

  const stockMedia =
    hostMatches(host, STOCK_MEDIA_HOSTS) ||
    /\b(?:royalty free|stock images|stock photos|stock photography)\b|\bgetty images\b/.test(combinedComparable);
  if (stockMedia && !hostMatches(host, REPUTABLE_MEDIA_HOSTS)) {
    return { disposition: "reject", reason: "stock_media" };
  }

  const searchQueryKeys = new Set(["keyword", "keywords", "q", "query", "search"]);
  const hasSearchQuery = [...url.searchParams.keys()].some((key) =>
    searchQueryKeys.has(key.toLocaleLowerCase("en-US")),
  );
  const navigationPath = pathSegments.some((segment) => NON_PROFESSIONAL_NAVIGATION_SEGMENTS.has(segment));
  if (navigationPath || (pathSegments.length === 0 && hasSearchQuery)) {
    return { disposition: "reject", reason: "non_professional_navigation" };
  }
  if (host === "github.com" && knownShape?.sourceType === "other") {
    return { disposition: "reject", reason: "non_professional_navigation" };
  }
  if (host === "gist.github.com") {
    return { disposition: "deprioritize", reason: "non_professional_navigation" };
  }

  const personNames = normalizedLeadPersonNames(context);
  if (personNames.length === 0) return { disposition: "neutral", reason: "neutral" };
  const titleNames = personNames.filter((name) => comparableContainsPhrase(titleComparable, name));
  const exactPersonSlug = personNames.some((name) => pathSegments.length === 1 && pathSegments[0] === name);
  const exactPersonPathSegment = personNames.some((name) => pathSegments.includes(name));
  const exactTerminalPersonSlug = personNames.some((name) => pathSegments.at(-1) === name);
  const personPagePath = hasPersonPageMarker(exactTerminalPersonSlug ? pathSegments.slice(0, -1) : pathSegments);
  const hostLabels = host
    .split(".")
    .map((label) => boundedComparable(label, 64))
    .filter(
      (label) => label.length >= 3 && !["com", "net", "org", "people", "profiles", "search", "www"].includes(label),
    );
  const titleNamesHost =
    titleNames.length > 0 && hostLabels.some((label) => comparableContainsPhrase(titleComparable, label));
  const explicitFirstPartyHost = hostMatchesExplicitFirstPartyHost(host, context);
  const organizationSignals = organizationSchedulingSignals(context);
  const organizationContextMatches = organizationSignals.some(({ acronym, hostAliases, name }) => {
    const matchingHostAlias = hostAliases.find((alias) => hostLabels.includes(alias));
    return (
      Boolean(matchingHostAlias) &&
      (comparableContainsPhrase(titleComparable, name) ||
        (acronym.length > 0 && comparableContainsPhrase(titleComparable, acronym)) ||
        comparableContainsPhrase(titleComparable, matchingHostAlias ?? ""))
    );
  });
  const requiredOrganizationContextMatches =
    organizationSignals.length === 0 || explicitFirstPartyHost || organizationContextMatches;
  const namedPersonHomepage =
    pathSegments.length === 0 &&
    titleNames.length > 0 &&
    requiredOrganizationContextMatches &&
    (explicitFirstPartyHost ||
      organizationContextMatches ||
      personNames.some((name) => name.split(" ").some((token) => token.length >= 4 && host.includes(token))));
  const boundedPersonPage =
    pathSegments.length <= 6 &&
    titleNames.length > 0 &&
    requiredOrganizationContextMatches &&
    ((exactPersonSlug && (titleNamesHost || explicitFirstPartyHost || organizationContextMatches)) ||
      (personPagePath &&
        (titleNamesHost || explicitFirstPartyHost || organizationContextMatches) &&
        (exactPersonPathSegment || titleNamesHost || explicitFirstPartyHost)));
  if (namedPersonHomepage || boundedPersonPage) {
    return { disposition: "prioritize", reason: "candidate_bio_path" };
  }
  if (pathSegments.length === 0) {
    return { disposition: "deprioritize", reason: "generic_person_homepage" };
  }
  return { disposition: "neutral", reason: "neutral" };
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
  const knownShape = knownSourceShapeForUrl(value);
  if (knownShape) return knownShape.sourceType;
  if (hostMatches(host, PROFESSIONAL_PROFILE_HOSTS)) return "professional_profile";
  if (isCanonicalGoogleScholarProfileUrl(value)) return "public_document";
  if (hostMatches(host, REPUTABLE_MEDIA_HOSTS)) return "news";
  if (hostMatchesFirstPartyContext(host, context)) return preferredFirstPartyType;
  if (
    host.endsWith(".edu") ||
    host.endsWith(".gov") ||
    host === "sec.gov" ||
    host === "companieshouse.gov.uk" ||
    host === "uspto.gov" ||
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
  const knownShape = knownSourceShapeForUrl(value);
  if (knownShape) return knownShape.tier;
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
  if (host === "patentsview.org" || host === "npmjs.com" || isCanonicalGoogleScholarProfileUrl(value)) return 2;
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
    return plan.queries.filter(
      (query) =>
        query.kind === "professional_site" ||
        query.kind === "public_scholarly_site" ||
        query.kind === "public_academic_site" ||
        query.kind === "public_metadata_site",
    );
  }
  if (lane.id === "t3.institutional") {
    const priority = (query: CompiledOsintQuery): number =>
      query.kind === "institution_site" ? 0 : query.kind === "regulatory_filing" ? 1 : 2;
    return plan.queries
      .filter(
        (query) =>
          query.kind === "regulatory_filing" || query.kind === "institution_site" || query.kind === "public_document",
      )
      .sort((left, right) => priority(left) - priority(right));
  }
  if (lane.id === "t4.reputable_media") {
    return [];
  }
  if (lane.id === "t6.general_discovery") {
    return plan.queries.filter(
      (query) =>
        query.kind === "exact_refinement" ||
        query.kind === "orthographic_name" ||
        query.kind === "initial_name" ||
        query.kind === "public_social_site",
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

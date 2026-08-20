import { normalizeComparable, normalizeWhitespace } from "../domain/runtime";
import type { EvidenceSourceType, ParsedTarget, SourceTier, TargetKind } from "../domain/types";

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
    sourceTypes: ["official_profile", "company_page", "code_profile", "public_document"],
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
    identifierKinds: ["repository", "doi", "orcid", "package", "platform_handle"],
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
    label: "Candidate-linked Wayback history",
    description: "Inspect only an exact HTTPS URL already bound to the candidate by admitted evidence.",
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
  "beenverified",
  "familytree",
  "familytreenow",
  "fastpeoplesearch",
  "homeaddress",
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
  "radaris",
  "residentialaddress",
  "reversephone",
  "spokeo",
  "taxassessor",
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
  const slug = normalizeComparable(tool).replace(/\s+/g, "_");
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

export function sourceLaneForFrontierEntry(entry: {
  sourceLaneId: string;
  sourceTier: SourceTier;
  allowedTools: readonly string[];
  candidateId: string | null;
}): SourceLane | undefined {
  const registered = sourceLaneById(entry.sourceLaneId);
  if (registered) {
    return registered.tier === entry.sourceTier &&
      entry.allowedTools.length > 0 &&
      entry.allowedTools.every((tool) => registered.allowedTools.includes(tool)) &&
      registered.requiresCandidate === (entry.candidateId !== null)
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
    host === "crossref.org" ||
    host === "patentsview.org" ||
    host === "npmjs.com"
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
  options: { candidateId?: string | null } = {},
): SourceLane[] {
  const suppliedValues = target.identifiers
    .filter((identifier) => identifier.provenance === "user_input")
    .map((identifier) => identifier.value);
  if (isDeniedResearchSource(target.normalizedQuery) || suppliedValues.some((value) => isDeniedResearchSource(value)))
    return [];
  const toolSet = new Set(availableTools);
  const registered = SOURCE_HIERARCHY.filter((lane) => laneMatchesTarget(lane, target))
    .filter((lane) => Boolean(options.candidateId) === lane.requiresCandidate || !lane.requiresCandidate)
    .map((lane) => ({ ...lane, allowedTools: lane.allowedTools.filter((tool) => toolSet.has(tool)) }))
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
  const base = explicit?.value ?? target.normalizedQuery;
  return normalizeWhitespace(base).slice(0, 320);
}

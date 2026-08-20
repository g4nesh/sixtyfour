import { normalizeWhitespace } from "../domain/runtime";
import type { ParsedTarget, TargetKind } from "../domain/types";

export const OSINT_QUERY_COMPILER_VERSION = 1 as const;
export const MAX_OSINT_QUERY_VARIANTS = 10 as const;
export const MAX_INSTITUTION_SITE_SCOPES = 2 as const;
export const MAX_COMPILED_OSINT_QUERY_CHARACTERS = 320 as const;

const COMPILER_SITE_SCOPES = [
  { site: "github.com", kind: "professional_site", derivedFrom: "compiler_professional_allowlist" },
  { site: "orcid.org", kind: "professional_site", derivedFrom: "compiler_professional_allowlist" },
  { site: "scholar.google.com", kind: "professional_site", derivedFrom: "compiler_professional_allowlist" },
  { site: "apps.apple.com", kind: "public_metadata_site", derivedFrom: "compiler_public_metadata_allowlist" },
] as const satisfies ReadonlyArray<{
  site: string;
  kind: Extract<OsintQueryVariantKind, "professional_site" | "public_metadata_site">;
  derivedFrom: Extract<
    CompiledOsintQuery["derivedFrom"],
    "compiler_professional_allowlist" | "compiler_public_metadata_allowlist"
  >;
}>;

/**
 * These are exclusions, never discovery targets. They keep broad queries away
 * from common broker/contact surfaces without attempting to enumerate them.
 */
const PUBLIC_PROFESSIONAL_EXCLUSIONS = ["-jobs", '-"resume template"', '-"name meaning"', '-"stock photo"'] as const;

export type OsintQueryVariantKind =
  | "exact_baseline"
  | "exact_refinement"
  | "exact_context"
  | "orthographic_name"
  | "initial_name"
  | "professional_site"
  | "public_metadata_site"
  | "institution_site"
  | "public_document";

export interface CompiledOsintQuery {
  id: string;
  kind: OsintQueryVariantKind;
  query: string;
  /** Exact subject phrase used by the query; never an invented alias. */
  subjectPhrase: string;
  /** Present only for a validated, compiler-admitted site scope. */
  site: string | null;
  /** Negative operators are legal only when this field names the refinement. */
  refinement: "none" | "public_web_noise_exclusions";
  /** Human-auditable derivation label; this is not evidence provenance. */
  derivedFrom:
    | "target_subject_baseline"
    | "compiler_public_professional_refinement"
    | "target_context"
    | "target_name_orthography"
    | "target_name_initials"
    | "compiler_professional_allowlist"
    | "compiler_public_metadata_allowlist"
    | "explicit_institution_domain"
    | "compiler_document_terms";
}

export interface OsintQueryCompilerDiagnostic {
  code:
    | "unsupported_target_kind"
    | "invalid_public_professional_subject"
    | "institution_domains_rejected"
    | "query_length_constraint_applied"
    | "query_limit_applied";
  message: string;
  count: number;
}

export interface OsintQueryPlan {
  compilerVersion: typeof OSINT_QUERY_COMPILER_VERSION;
  targetKind: TargetKind;
  status: "compiled" | "unsupported";
  acceptedInstitutionDomains: string[];
  queries: CompiledOsintQuery[];
  diagnostics: OsintQueryCompilerDiagnostic[];
}

export interface CompileOsintQueryOptions {
  /**
   * Candidate-bound academic domains admitted by the caller. Arbitrary public
   * domains are intentionally not accepted as institution scopes.
   */
  institutionDomains?: readonly string[];
  /** Defaults to the hard maximum and is always clamped to [1, 10]. */
  maxQueries?: number;
}

interface SubjectContext {
  subjectPhrase: string;
  contextPhrases: string[];
}

interface QueryDraft {
  kind: OsintQueryVariantKind;
  body: string;
  subjectPhrase: string;
  site: string | null;
  refinement: CompiledOsintQuery["refinement"];
  derivedFrom: CompiledOsintQuery["derivedFrom"];
}

function maximumQueryCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return MAX_OSINT_QUERY_VARIANTS;
  return Math.min(MAX_OSINT_QUERY_VARIANTS, Math.max(1, Math.trunc(value)));
}

function quotePhrase(value: string): string {
  return `"${value}"`;
}

function sanitizePersonName(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = normalizeWhitespace(value.normalize("NFKC")).replace(/["“”\\]/gu, "");
  const words = normalized.split(" ");
  if (words.length < 2 || words.length > 5 || normalized.length > 160) return null;
  return words.every((word) => /^[\p{L}\p{M}][\p{L}\p{M}'’.-]{0,63}$/u.test(word)) ? normalized : null;
}

function sanitizeProfessionalPhrase(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = normalizeWhitespace(value.normalize("NFKC")).replace(/["“”\\]/gu, "");
  if (!normalized || normalized.length > 160) return null;
  if (
    /\b(?:api[-_ ]?keys?|access[-_ ]?tokens?|passwords?|credentials?|private[-_ ]?keys?|secret(?:s|[-_ ]?keys?)?)\b/i.test(
      normalized,
    ) ||
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}\b/i.test(normalized) ||
    /(?:^|\s)\+?\d[\d(). -]{7,}\d(?:\s|$)/.test(normalized) ||
    /\b\d{1,8}\s+[\p{L}\p{M} .'-]+\s(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr)\b/iu.test(
      normalized,
    )
  )
    return null;
  const words = normalized.split(" ");
  if (words.length > 12) return null;
  return /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}&'’().,+/-]*(?: [\p{L}\p{M}\p{N}&'’().,+/-]+)*$/u.test(normalized)
    ? normalized
    : null;
}

function subjectContextForTarget(target: ParsedTarget): SubjectContext | null {
  // A name may coexist with an exact public URL/domain identifier. The
  // compiler uses only that parsed name; it never derives a name from an
  // identifier and email-primary targets remain excluded below.
  if (target.name && target.kind !== "email") {
    const subjectPhrase = sanitizePersonName(target.name);
    if (!subjectPhrase) return null;
    const organization = sanitizeProfessionalPhrase(target.organizationHints[0]?.name);
    const role = sanitizeProfessionalPhrase(target.roleHints[0]);
    return {
      subjectPhrase,
      contextPhrases: [organization, role].filter((item): item is string => Boolean(item)).slice(0, 2),
    };
  }

  if (target.kind === "role_query") {
    const role = sanitizeProfessionalPhrase(target.roleHints[0]);
    const organization = sanitizeProfessionalPhrase(target.organizationHints[0]?.name);
    if (!role || !organization) return null;
    return { subjectPhrase: role, contextPhrases: [organization] };
  }

  if (target.kind === "organization") {
    const organization = sanitizeProfessionalPhrase(target.organizationHints[0]?.name);
    return organization ? { subjectPhrase: organization, contextPhrases: [] } : null;
  }

  return null;
}

function academicDomain(value: string): string | null {
  const normalized = value.trim().toLocaleLowerCase("en-US").replace(/\.$/, "");
  if (
    !normalized ||
    normalized.length > 80 ||
    normalized.startsWith("www.") ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(normalized) ||
    normalized.includes("..")
  )
    return null;
  const labels = normalized.split(".");
  if (labels.length < 2 || labels.some((label) => label.length > 63 || label.startsWith("-") || label.endsWith("-")))
    return null;
  const isAcademic = normalized.endsWith(".edu") || /\.(?:ac|edu)\.[a-z]{2}$/.test(normalized);
  return isAcademic ? normalized : null;
}

function institutionScopes(values: readonly string[]): { accepted: string[]; rejectedCount: number } {
  const accepted: string[] = [];
  let rejectedCount = 0;
  for (const value of values) {
    const domain = academicDomain(value);
    if (!domain) {
      rejectedCount += 1;
      continue;
    }
    if (accepted.includes(domain)) continue;
    if (accepted.length >= MAX_INSTITUTION_SITE_SCOPES) {
      rejectedCount += 1;
      continue;
    }
    accepted.push(domain);
  }
  return { accepted, rejectedCount };
}

function orthographicNameVariant(name: string): string | null {
  const folded = normalizeWhitespace(
    name
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[’‘`]/g, "'")
      .replace(/['.-]+/g, " "),
  );
  return folded && folded !== name && sanitizePersonName(folded) ? folded : null;
}

function initialNameVariant(name: string): string | null {
  const words = name.split(" ");
  if (words.length < 2) return null;
  const initial = (word: string): string => `${word[0]?.toLocaleUpperCase("en-US")}.`;
  const variant =
    words.length === 2
      ? `${initial(words[0])} ${words[1]}`
      : [words[0], ...words.slice(1, -1).map(initial), words.at(-1)].join(" ");
  return variant !== name && sanitizePersonName(variant) ? variant : null;
}

function exclusions(): string {
  return PUBLIC_PROFESSIONAL_EXCLUSIONS.join(" ");
}

function withExclusions(body: string): string {
  return `${body} ${exclusions()}`;
}

function renderedQuery(draft: QueryDraft): string {
  return draft.refinement === "none" ? draft.body : withExclusions(draft.body);
}

function boundedContextBody(
  subject: string,
  phrases: readonly string[],
): {
  body: string | null;
  omitted: number;
} {
  const parts = [subject];
  let retained = 0;
  let omitted = 0;
  for (const phrase of phrases) {
    const candidate = [...parts, quotePhrase(phrase)].join(" ");
    if (withExclusions(candidate).length <= MAX_COMPILED_OSINT_QUERY_CHARACTERS) {
      parts.push(quotePhrase(phrase));
      retained += 1;
    } else {
      omitted += 1;
    }
  }
  return { body: retained > 0 ? parts.join(" ") : null, omitted };
}

function documentTerms(targetKind: TargetKind): string {
  return targetKind === "organization" || targetKind === "role_query"
    ? "filetype:pdf (intitle:team OR intitle:leadership)"
    : "filetype:pdf (intitle:profile OR intitle:biography)";
}

/**
 * Compile finite public-professional search strings. This function performs no
 * network access and does not choose or scrape a search engine. Its output is
 * discovery-only until a separate hardened fetch admits exact source content.
 */
export function compileOsintQueries(target: ParsedTarget, options: CompileOsintQueryOptions = {}): OsintQueryPlan {
  const diagnostics: OsintQueryCompilerDiagnostic[] = [];
  const supportedKinds: TargetKind[] = ["named_person", "role_query", "organization"];
  const hasSafeNameSubject = target.kind !== "email" && sanitizePersonName(target.name) !== null;
  if (!supportedKinds.includes(target.kind) && !hasSafeNameSubject) {
    diagnostics.push({
      code: "unsupported_target_kind",
      message: "OSINT query compilation is limited to public-professional person, role, and organization targets.",
      count: 1,
    });
    return {
      compilerVersion: OSINT_QUERY_COMPILER_VERSION,
      targetKind: target.kind,
      status: "unsupported",
      acceptedInstitutionDomains: [],
      queries: [],
      diagnostics,
    };
  }

  const context = subjectContextForTarget(target);
  if (!context) {
    diagnostics.push({
      code: "invalid_public_professional_subject",
      message: "The parsed target did not contain a safely quotable public-professional subject.",
      count: 1,
    });
    return {
      compilerVersion: OSINT_QUERY_COMPILER_VERSION,
      targetKind: target.kind,
      status: "unsupported",
      acceptedInstitutionDomains: [],
      queries: [],
      diagnostics,
    };
  }

  const institutions = institutionScopes(options.institutionDomains ?? []);
  if (institutions.rejectedCount > 0) {
    diagnostics.push({
      code: "institution_domains_rejected",
      message:
        "One or more institution domains were invalid, non-academic, duplicate beyond the bounded scope, or over the limit.",
      count: institutions.rejectedCount,
    });
  }

  const subject = quotePhrase(context.subjectPhrase);
  const drafts: QueryDraft[] = [
    {
      kind: "exact_baseline",
      body: subject,
      subjectPhrase: context.subjectPhrase,
      site: null,
      refinement: "none",
      derivedFrom: "target_subject_baseline",
    },
    {
      kind: "exact_refinement",
      body: `${subject} professional`,
      subjectPhrase: context.subjectPhrase,
      site: null,
      refinement: "public_web_noise_exclusions",
      derivedFrom: "compiler_public_professional_refinement",
    },
  ];

  if (context.contextPhrases.length > 0) {
    const boundedContext = boundedContextBody(subject, context.contextPhrases);
    if (boundedContext.body) {
      drafts.push({
        kind: "exact_context",
        body: boundedContext.body,
        subjectPhrase: context.subjectPhrase,
        site: null,
        refinement: "public_web_noise_exclusions",
        derivedFrom: "target_context",
      });
    }
    if (boundedContext.omitted > 0) {
      diagnostics.push({
        code: "query_length_constraint_applied",
        message: "One or more complete context phrases were omitted rather than truncating quoted search syntax.",
        count: boundedContext.omitted,
      });
    }
  }

  if (target.kind === "named_person") {
    const orthographic = orthographicNameVariant(context.subjectPhrase);
    if (orthographic) {
      drafts.push({
        kind: "orthographic_name",
        body: `${quotePhrase(orthographic)} professional`,
        subjectPhrase: orthographic,
        site: null,
        refinement: "public_web_noise_exclusions",
        derivedFrom: "target_name_orthography",
      });
    }
    const initials = initialNameVariant(context.subjectPhrase);
    if (initials) {
      drafts.push({
        kind: "initial_name",
        body: `${quotePhrase(initials)} professional`,
        subjectPhrase: initials,
        site: null,
        refinement: "public_web_noise_exclusions",
        derivedFrom: "target_name_initials",
      });
    }
  }

  for (const scope of COMPILER_SITE_SCOPES) {
    drafts.push({
      kind: scope.kind,
      body: `${subject} site:${scope.site}`,
      subjectPhrase: context.subjectPhrase,
      site: scope.site,
      refinement: "public_web_noise_exclusions",
      derivedFrom: scope.derivedFrom,
    });
  }

  for (const site of institutions.accepted) {
    drafts.push({
      kind: "institution_site",
      body: `${subject} site:${site}`,
      subjectPhrase: context.subjectPhrase,
      site,
      refinement: "public_web_noise_exclusions",
      derivedFrom: "explicit_institution_domain",
    });
  }

  drafts.push({
    kind: "public_document",
    body: `${subject} ${documentTerms(target.kind)}`,
    subjectPhrase: context.subjectPhrase,
    site: null,
    refinement: "public_web_noise_exclusions",
    derivedFrom: "compiler_document_terms",
  });

  const deduped = drafts.filter(
    (draft, index, all) => all.findIndex((candidate) => candidate.body === draft.body) === index,
  );
  const renderable = deduped.filter((draft) => {
    const fits = renderedQuery(draft).length <= MAX_COMPILED_OSINT_QUERY_CHARACTERS;
    if (!fits) {
      const diagnostic = diagnostics.find((item) => item.code === "query_length_constraint_applied");
      if (diagnostic) diagnostic.count += 1;
      else
        diagnostics.push({
          code: "query_length_constraint_applied",
          message: "A complete query variant was omitted rather than truncating quoted or operator syntax.",
          count: 1,
        });
    }
    return fits;
  });
  const limit = maximumQueryCount(options.maxQueries);
  if (renderable.length > limit) {
    diagnostics.push({
      code: "query_limit_applied",
      message: "Lower-priority deterministic variants were omitted by the bounded query limit.",
      count: renderable.length - limit,
    });
  }
  const queries = renderable.slice(0, limit).map((draft, index): CompiledOsintQuery => ({
    id: `osint_query_${String(index + 1).padStart(2, "0")}`,
    kind: draft.kind,
    query: renderedQuery(draft),
    subjectPhrase: draft.subjectPhrase,
    site: draft.site,
    refinement: draft.refinement,
    derivedFrom: draft.derivedFrom,
  }));

  return {
    compilerVersion: OSINT_QUERY_COMPILER_VERSION,
    targetKind: target.kind,
    status: "compiled",
    acceptedInstitutionDomains: institutions.accepted,
    queries,
    diagnostics,
  };
}

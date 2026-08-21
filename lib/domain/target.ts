import { containsRestrictedPublicContent } from "./content-policy";
import { normalizeComparable, normalizeWhitespace } from "./runtime";
import {
  SCHEMA_VERSION,
  type InvestigationInput,
  type OrganizationHint,
  type ParsedTarget,
  type TargetIdentifier,
} from "./types";
import { parseInvestigationInput } from "./validation";

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}\b/gi;
const HTTPS_URL_PATTERN = /https:\/\/[^\s<>"']+/gi;
const DOI_PATTERN = /\b10\.\d{4,9}\/[A-Z0-9._;()/:-]+\b/gi;
const ORCID_PATTERN = /\b(?:https:\/\/orcid\.org\/)?(\d{4}-\d{4}-\d{4}-\d{3}[\dX])\b/gi;
const REPOSITORY_PATTERN = /\b(?:repo(?:sitory)?|github)\s*[:=]?\s*([A-Z0-9_.-]+\/[A-Z0-9_.-]+)\b/gi;
const PACKAGE_PATTERN = /\b(?:npm|pypi|package)\s*[:=]\s*(@?[A-Z0-9_.-]+(?:\/[A-Z0-9_.-]+)?)\b/gi;
const PLATFORM_HANDLE_PATTERN = /\b(github|gitlab|keybase|linkedin|twitter|x)\s*[:=]\s*@?([A-Z0-9_.-]{2,64})\b/gi;
const DOMAIN_PATTERN = /\b(?:[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?\.)+[A-Z]{2,63}\b/gi;
const ORGANIZATION_MARKER =
  /\b(?:ai|labs?|inc\.?|llc|ltd\.?|corp(?:oration)?|compan(?:y|ies)|organizations?|business(?:es)?|nonprofits?|foundations?|universit(?:y|ies)|institutes?|schools?|colleges?|studio|systems?|technologies|ventures?)\b/i;
const EXPLICIT_ORGANIZATION_PREFIX =
  /^(?:organization|company|business|nonprofit)(?:\s+(?:named|called))?\s*(?::|=|-)?\s+(.+)$/i;
const NON_PERSON_MONONYMS = new Set([
  "a",
  "an",
  "company",
  "find",
  "investigate",
  "lookup",
  "organization",
  "person",
  "research",
  "someone",
  "the",
]);

const ROLE_PATTERNS: Array<{ canonical: string; pattern: RegExp }> = [
  { canonical: "Chief Technology Officer", pattern: /\b(?:cto|chief technology officer)\b/i },
  { canonical: "Chief Executive Officer", pattern: /\b(?:ceo|chief executive officer)\b/i },
  { canonical: "Chief Product Officer", pattern: /\b(?:cpo|chief product officer)\b/i },
  { canonical: "Founder", pattern: /\b(?:co[- ]?founder|founder)\b/i },
  { canonical: "Creator", pattern: /\b(?:creator|author|inventor)\b/i },
  { canonical: "Engineer", pattern: /\b(?:software|machine learning|ml|ai|founding)?\s*engineer\b/i },
  { canonical: "Product Designer", pattern: /\bproduct designer\b/i },
  { canonical: "Designer", pattern: /\bdesigner\b/i },
  { canonical: "Researcher", pattern: /\b(?:research scientist|researcher)\b/i },
  {
    canonical: "Professor",
    pattern: /\b(?:(?:assistant|associate|adjunct|visiting|emeritus)\s+)?professor\b/i,
  },
  { canonical: "Investor", pattern: /\b(?:investor|partner)\b/i },
];

const LEADING_REQUEST_PATTERN =
  /^(?:(?:please\s+)?(?:do\s+)?(?:deep\s+)?research(?:\s+on)?|investigate|look\s+up|find)\s+/i;
const TRAILING_SCOPE_PATTERN =
  /\s+(?:public\s+professional\s+(?:background|profile|research)|professional\s+(?:background|profile|research)|public\s+(?:background|profile))\s*$/i;

function titleCaseName(value: string): string {
  return value
    .split(/\s+/)
    .map((part) => {
      if (/^[A-Z]{2,5}$/.test(part)) return part;
      const [first, ...rest] = Array.from(part);
      return first ? `${first.toUpperCase()}${rest.join("").toLowerCase()}` : part;
    })
    .join(" ");
}

function looksLikePersonName(value: string): boolean {
  const words = normalizeWhitespace(value).split(" ");
  if (words.length < 1 || words.length > 5) return false;
  if (ROLE_PATTERNS.some(({ pattern }) => pattern.test(value))) return false;
  if (words.length === 1 && NON_PERSON_MONONYMS.has(normalizeComparable(words[0]))) return false;
  return words.every((word) => /^[\p{L}][\p{L}\p{M}'’.-]*$/u.test(word));
}

function leadingPersonLocation(value: string): { person: string; location: string } | null {
  const match = normalizeWhitespace(value).match(/^(.+?)\s+(?:based\s+in|from|in)\s+(.+)$/i);
  const person = normalizeWhitespace(match?.[1] ?? "");
  const location = normalizeWhitespace(match?.[2] ?? "");
  if (!person || !location || ORGANIZATION_MARKER.test(person) || !looksLikePersonName(person)) return null;
  return { person, location };
}

function leadingPersonOrganization(value: string): { person: string; organization: string } | null {
  const match = normalizeWhitespace(value).match(/^(.+?)\s+(?:at|with)\s+(.+)$/i);
  const person = normalizeWhitespace(match?.[1] ?? "");
  const organization = normalizeWhitespace(match?.[2] ?? "");
  if (!person || !organization || ORGANIZATION_MARKER.test(person) || !looksLikePersonName(person)) return null;
  return { person, organization };
}

function addLocation(locations: string[], rawLocation: string): void {
  const location = normalizeWhitespace(rawLocation.replace(/^["']|["']$/g, ""));
  if (
    !location ||
    location.length > 160 ||
    location.split(" ").length > 12 ||
    containsRestrictedPublicContent(location) ||
    /(?:^|\s)\+?\d[\d(). -]{7,}\d(?:\s|$)/.test(location)
  )
    return;
  const normalizedLocation = normalizeComparable(location);
  if (locations.some((item) => normalizeComparable(item) === normalizedLocation)) return;
  locations.push(location);
}

function addOrganization(
  organizations: OrganizationHint[],
  rawName: string,
  relationship: OrganizationHint["relationship"],
): void {
  const name = normalizeWhitespace(rawName.replace(/^["']|["']$/g, ""));
  const normalizedName = normalizeComparable(name);
  if (!name || normalizedName.length < 2) return;
  if (organizations.some((item) => item.normalizedName === normalizedName)) return;
  organizations.push({ name, normalizedName, relationship });
}

function addRole(roles: string[], value: string): void {
  for (const role of ROLE_PATTERNS) {
    if (role.pattern.test(value) && !roles.includes(role.canonical)) {
      roles.push(role.canonical);
    }
  }
}

function addIdentifier(
  identifiers: TargetIdentifier[],
  seen: Set<string>,
  value: string,
  kind: TargetIdentifier["kind"],
  normalizedValue = normalizeComparable(value),
): void {
  const key = `${kind}:${normalizedValue}`;
  if (!normalizedValue || seen.has(key)) return;
  seen.add(key);
  identifiers.push({
    kind,
    value,
    normalizedValue,
    assurance: "self_asserted",
    provenance: "user_input",
  });
}

function organizationFromRoleQuery(value: string): string | undefined {
  const match = value.match(
    /\b(?:cto|ceo|cpo|chief\s+[a-z ]+\s+officer|founder|creator|author|inventor|engineer|designer|researcher|professor|investor|partner)\s+(?:at|of|for)\s+(.+?)(?:[?.!]|$)/i,
  );
  return match?.[1] ? normalizeWhitespace(match[1]) : undefined;
}

export function parseTarget(inputValue: InvestigationInput | string): ParsedTarget {
  const input = parseInvestigationInput(inputValue);
  const rawInput = input.query;
  const normalizedQuery = normalizeWhitespace(rawInput);
  const query = normalizedQuery.replace(LEADING_REQUEST_PATTERN, "").replace(TRAILING_SCOPE_PATTERN, "");
  const emails = [...query.matchAll(EMAIL_PATTERN)].map((match) => match[0]);
  const identifiers: TargetIdentifier[] = [];
  const seenIdentifiers = new Set<string>();

  for (const email of emails) {
    const normalizedValue = email.toLocaleLowerCase("en-US");
    addIdentifier(identifiers, seenIdentifiers, email, "email", normalizedValue);
  }

  const urls = [...query.matchAll(HTTPS_URL_PATTERN)].map((match) => match[0].replace(/[),.;!?]+$/, ""));
  for (const value of urls) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password) continue;
      url.hash = "";
      const canonical = url.toString();
      addIdentifier(identifiers, seenIdentifiers, canonical, "url", canonical);
      addIdentifier(
        identifiers,
        seenIdentifiers,
        url.hostname,
        "domain",
        url.hostname.toLocaleLowerCase("en-US").replace(/^www\./, ""),
      );
      if (url.hostname.toLocaleLowerCase("en-US").replace(/^www\./, "") === "github.com") {
        const [owner, repository] = url.pathname.split("/").filter(Boolean);
        if (owner && repository) {
          addIdentifier(
            identifiers,
            seenIdentifiers,
            `${owner}/${repository.replace(/\.git$/i, "")}`,
            "repository",
            `${owner}/${repository.replace(/\.git$/i, "")}`.toLocaleLowerCase("en-US"),
          );
        }
      }
    } catch {
      // Invalid URL-like text remains ordinary query text and is not promoted.
    }
  }
  for (const match of query.matchAll(DOI_PATTERN)) {
    addIdentifier(identifiers, seenIdentifiers, match[0], "doi", match[0].toLocaleLowerCase("en-US"));
  }
  for (const match of query.matchAll(ORCID_PATTERN)) {
    const value = match[1];
    if (value) addIdentifier(identifiers, seenIdentifiers, value, "orcid", value.toUpperCase());
  }
  for (const match of query.matchAll(REPOSITORY_PATTERN)) {
    const value = match[1];
    if (value) addIdentifier(identifiers, seenIdentifiers, value, "repository", value.toLocaleLowerCase("en-US"));
  }
  for (const match of query.matchAll(PACKAGE_PATTERN)) {
    const value = match[1];
    if (value) addIdentifier(identifiers, seenIdentifiers, value, "package", value.toLocaleLowerCase("en-US"));
  }
  for (const match of query.matchAll(PLATFORM_HANDLE_PATTERN)) {
    const platform = match[1];
    const handle = match[2];
    if (platform && handle) {
      const value = `${platform.toLocaleLowerCase("en-US")}:${handle}`;
      addIdentifier(identifiers, seenIdentifiers, value, "platform_handle", value.toLocaleLowerCase("en-US"));
    }
  }

  const withoutEmails = normalizeWhitespace(
    query
      .replace(EMAIL_PATTERN, " ")
      .replace(HTTPS_URL_PATTERN, " ")
      .replace(DOI_PATTERN, " ")
      .replace(ORCID_PATTERN, " ")
      .replace(REPOSITORY_PATTERN, " ")
      .replace(PACKAGE_PATTERN, " ")
      .replace(PLATFORM_HANDLE_PATTERN, " "),
  );
  const exactDomainText = normalizeWhitespace(withoutEmails);
  if (exactDomainText && DOMAIN_PATTERN.test(exactDomainText)) {
    DOMAIN_PATTERN.lastIndex = 0;
    const matches = [...exactDomainText.matchAll(DOMAIN_PATTERN)].map((match) => match[0]);
    if (matches.length === 1 && normalizeComparable(matches[0]) === normalizeComparable(exactDomainText)) {
      addIdentifier(
        identifiers,
        seenIdentifiers,
        matches[0],
        "domain",
        matches[0].toLocaleLowerCase("en-US").replace(/^www\./, ""),
      );
    }
  }
  DOMAIN_PATTERN.lastIndex = 0;
  const commaParts = withoutEmails.split(",").map(normalizeWhitespace).filter(Boolean);
  const roleHints: string[] = [];
  const organizationHints: OrganizationHint[] = [];
  const locationHints: string[] = [];

  addRole(roleHints, withoutEmails);

  let name: string | undefined;
  const firstPart = commaParts[0];
  const explicitOrganization = firstPart?.match(EXPLICIT_ORGANIZATION_PREFIX);
  const freeformLocation = firstPart ? leadingPersonLocation(firstPart) : null;
  const freeformOrganization = firstPart && !freeformLocation ? leadingPersonOrganization(firstPart) : null;
  const leadingPersonContext = freeformLocation ?? freeformOrganization;
  const firstPartLooksOrganizational = Boolean(
    firstPart && !leadingPersonContext && ORGANIZATION_MARKER.test(firstPart),
  );
  const personPart = leadingPersonContext?.person ?? firstPart;
  if (personPart && !firstPartLooksOrganizational && looksLikePersonName(personPart)) {
    name = titleCaseName(personPart);
  }
  if (freeformLocation) addLocation(locationHints, freeformLocation.location);
  if (freeformOrganization) addOrganization(organizationHints, freeformOrganization.organization, "current");

  const roleOrganization = organizationFromRoleQuery(withoutEmails);
  if (roleOrganization) {
    addOrganization(organizationHints, roleOrganization, "current");
  }

  for (const part of commaParts.slice(name || explicitOrganization ? 1 : 0)) {
    addRole(roleHints, part);

    const former = part.match(/^(?:ex[- ]|former(?:ly)?(?:\s+at)?\s+)(.+)$/i);
    if (former?.[1]) {
      addOrganization(organizationHints, former[1], "former");
      continue;
    }

    const current = part.match(/^(?:at|with)\s+(.+)$/i);
    if (current?.[1]) {
      addOrganization(organizationHints, current[1], "current");
      continue;
    }

    const location = part.match(/^(?:in|based\s+in|from)\s+(.+)$/i);
    if (location?.[1]) {
      addLocation(locationHints, location[1]);
      continue;
    }

    if (!ROLE_PATTERNS.some(({ pattern }) => pattern.test(part))) {
      addOrganization(organizationHints, part, "unspecified");
    }
  }

  let kind: ParsedTarget["kind"] = "unknown";
  if (identifiers.some((identifier) => identifier.kind === "email")) {
    kind = "email";
  } else if (identifiers.some((identifier) => identifier.kind === "repository")) {
    kind = "repository";
  } else if (identifiers.some((identifier) => identifier.kind === "doi" || identifier.kind === "orcid")) {
    kind = "publication";
  } else if (identifiers.some((identifier) => identifier.kind === "package")) {
    kind = "package";
  } else if (identifiers.some((identifier) => identifier.kind === "platform_handle")) {
    kind = "platform_handle";
  } else if (identifiers.some((identifier) => identifier.kind === "url")) {
    kind = "url";
  } else if (identifiers.some((identifier) => identifier.kind === "domain")) {
    kind = "domain";
  } else if (name) {
    kind = "named_person";
  } else if (roleHints.length > 0 && organizationHints.length > 0) {
    kind = "role_query";
  } else if (firstPartLooksOrganizational && firstPart) {
    kind = "organization";
    addOrganization(organizationHints, explicitOrganization?.[1] ?? firstPart, "unspecified");
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    rawInput,
    normalizedQuery,
    kind,
    ...(name ? { name, normalizedName: normalizeComparable(name) } : {}),
    roleHints,
    organizationHints,
    locationHints,
    identifiers,
  };
}

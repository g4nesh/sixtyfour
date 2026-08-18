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
  { canonical: "Investor", pattern: /\b(?:investor|partner)\b/i },
];

const LEADING_REQUEST_PATTERN = /^(?:(?:please\s+)?(?:do\s+)?(?:deep\s+)?research(?:\s+on)?|investigate|look\s+up|find)\s+/i;
const TRAILING_SCOPE_PATTERN =
  /\s+(?:public\s+professional\s+(?:background|profile|research)|professional\s+(?:background|profile|research)|public\s+(?:background|profile))\s*$/i;

function titleCaseName(value: string): string {
  return value
    .split(/\s+/)
    .map((part) => {
      if (/^[A-Z]{2,5}$/.test(part)) return part;
      return part.length > 0 ? `${part[0].toUpperCase()}${part.slice(1).toLowerCase()}` : part;
    })
    .join(" ");
}

function looksLikePersonName(value: string): boolean {
  const words = normalizeWhitespace(value).split(" ");
  if (words.length < 2 || words.length > 5) return false;
  if (ROLE_PATTERNS.some(({ pattern }) => pattern.test(value))) return false;
  return words.every((word) => /^[\p{L}][\p{L}'’.-]*$/u.test(word));
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

function organizationFromRoleQuery(value: string): string | undefined {
  const match = value.match(
    /\b(?:cto|ceo|cpo|chief\s+[a-z ]+\s+officer|founder|creator|author|inventor|engineer|designer|researcher|investor|partner)\s+(?:at|of|for)\s+(.+?)(?:[?.!]|$)/i,
  );
  return match?.[1] ? normalizeWhitespace(match[1]) : undefined;
}

export function parseTarget(inputValue: InvestigationInput | string): ParsedTarget {
  const input = parseInvestigationInput(inputValue);
  const rawInput = input.query;
  const normalizedQuery = normalizeWhitespace(rawInput);
  const query = normalizedQuery
    .replace(LEADING_REQUEST_PATTERN, "")
    .replace(TRAILING_SCOPE_PATTERN, "");
  const emails = [...query.matchAll(EMAIL_PATTERN)].map((match) => match[0]);
  const identifiers: TargetIdentifier[] = [];
  const seenIdentifiers = new Set<string>();

  for (const email of emails) {
    const normalizedValue = email.toLocaleLowerCase("en-US");
    if (seenIdentifiers.has(normalizedValue)) continue;
    seenIdentifiers.add(normalizedValue);
    identifiers.push({
      kind: "email",
      value: email,
      normalizedValue,
      assurance: "self_asserted",
      provenance: "user_input",
    });
  }

  const withoutEmails = normalizeWhitespace(query.replace(EMAIL_PATTERN, " "));
  const commaParts = withoutEmails
    .split(",")
    .map(normalizeWhitespace)
    .filter(Boolean);
  const roleHints: string[] = [];
  const organizationHints: OrganizationHint[] = [];
  const locationHints: string[] = [];

  addRole(roleHints, withoutEmails);

  let name: string | undefined;
  const firstPart = commaParts[0];
  if (firstPart && looksLikePersonName(firstPart)) {
    name = titleCaseName(firstPart);
  }

  const roleOrganization = organizationFromRoleQuery(withoutEmails);
  if (roleOrganization) {
    addOrganization(organizationHints, roleOrganization, "current");
  }

  for (const part of commaParts.slice(name ? 1 : 0)) {
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

    const location = part.match(/^(?:in|based\s+in)\s+(.+)$/i);
    if (location?.[1]) {
      const normalizedLocation = normalizeWhitespace(location[1]);
      if (!locationHints.includes(normalizedLocation)) locationHints.push(normalizedLocation);
      continue;
    }

    if (!ROLE_PATTERNS.some(({ pattern }) => pattern.test(part))) {
      addOrganization(organizationHints, part, "unspecified");
    }
  }

  let kind: ParsedTarget["kind"] = "unknown";
  if (identifiers.some((identifier) => identifier.kind === "email")) {
    kind = "email";
  } else if (name) {
    kind = "named_person";
  } else if (roleHints.length > 0 && organizationHints.length > 0) {
    kind = "role_query";
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

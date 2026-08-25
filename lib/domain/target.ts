import { containsExplicitMinorPublicContent, containsRestrictedPublicContent } from "./content-policy";
import { labelOccursAsTokenPhrase, normalizeComparable, normalizeWhitespace } from "./runtime";
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

const MULTIPART_NAME_PARTICLES = new Set([
  "al",
  "bin",
  "da",
  "de",
  "del",
  "della",
  "der",
  "di",
  "dos",
  "du",
  "el",
  "ibn",
  "la",
  "le",
  "van",
  "von",
]);

export interface BareNameContextHypothesis {
  subjectName: string;
  normalizedSubjectName: string;
  contextPhrase: string;
  normalizedContextPhrase: string;
}

export type BareContextRelationKind = "professional" | "alumni";

const BARE_CONTEXT_NON_ADULT_MARKER =
  /\b(?:students?|pupils?|school[- ]?aged?|undergraduates?|enroll(?:ed|ing|ment|s)?|attends?|attending|grades?|graders?|k[- ]?12|varsity|junior[- ]varsity)\b/iu;
const BARE_CONTEXT_SCHOOL_ACTIVITY_MARKER =
  /\b(?:(?:school|student|pupil|robotics|debate|math|science|varsity|junior[- ]varsity)\s+(?:clubs?|teams?)|(?:clubs?|teams?)\s+(?:members?|captains?|presidents?|students?|pupils?)|(?:clubs?|teams?)[^.!?;]{0,100}(?:school|academy|students?|pupils?|grades?))\b/iu;
const BARE_CONTEXT_ADULT_ROLE =
  "researcher|scientist|engineer|founder|executive|director|professor|employee|faculty|staff|teacher|instructor|fellow|advisor|consultant";

function regexPhrase(value: string): string {
  return normalizeWhitespace(value)
    .split(/\s+/u)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
}

export function hasInterveningNamedSubject(excerpt: string, subjectName: string, contextPhrase: string): boolean {
  const subjectMatch = new RegExp(regexPhrase(subjectName), "iu").exec(excerpt);
  if (!subjectMatch) return false;
  const afterSubject = excerpt.slice(subjectMatch.index + subjectMatch[0].length);
  const contextMatch = new RegExp(regexPhrase(contextPhrase), "iu").exec(afterSubject);
  if (!contextMatch) return false;
  const between = afterSubject.slice(0, contextMatch.index);
  // A capitalized organization or role may legitimately sit between the
  // subject and a later location. Reject a second proper-name phrase only
  // when that phrase itself immediately owns a relation verb. The leading
  // boundary is intentionally not limited to punctuation: constructions such
  // as "Jane Doe says Bob Chen worked at Meridian" otherwise let Bob's verb
  // bind to Jane through the later broad relationship expression. Plain
  // organization/location phrases such as "Northstar Labs in Mesa" remain
  // eligible because they do not own a relation verb.
  const competingName = "(?:Dr\\.?\\s+)?\\p{Lu}[\\p{L}\\p{M}'’.-]{1,}\\s+\\p{Lu}[\\p{L}\\p{M}'’.-]{1,}";
  const competingNameOwnsRelation = new RegExp(
    `(?:^|[^\\p{L}\\p{M}'’.-])${competingName}\\s+(?:is|was|are|were|became|remains|works?|worked|serves?|served|researches?|researched|joined|leads?|led|founded|co[- ]?founded|attends?|attended|studies|studied|graduated|lives|resides)\\b`,
    "u",
  );
  const reverseRelationOwnsCompetingName = new RegExp(
    `\\b(?:alumnus|alumna|alumni|graduate|employs|employed|hired|appointed)\\b[^.!?;]{0,100}${competingName}(?:\\b|$)`,
    "u",
  );
  return competingNameOwnsRelation.test(between) || reverseRelationOwnsCompetingName.test(between);
}

/**
 * Match only an exact fetched adult-professional or completed-education
 * relationship. This shared predicate is used both before evidence admission
 * and when contextual identity resolution is recomputed from the ledger.
 */
export function matchBareContextRelation(
  exactExcerpt: string,
  subjectName: string,
  contextPhrase: string,
): BareContextRelationKind | null {
  const excerpt = normalizeWhitespace(exactExcerpt);
  if (!excerpt || !subjectName || !contextPhrase) return null;
  if (!labelOccursAsTokenPhrase(excerpt, subjectName) || !labelOccursAsTokenPhrase(excerpt, contextPhrase)) return null;
  if (
    hasInterveningNamedSubject(excerpt, subjectName, contextPhrase) ||
    hasInterveningNamedSubject(excerpt, contextPhrase, subjectName)
  )
    return null;
  const subject = regexPhrase(subjectName);
  const context = regexPhrase(contextPhrase);
  const bounded = `[^.!?;]{0,220}`;
  const clauses = excerpt
    .split(/[.!?;]+/u)
    .map((clause) => normalizeWhitespace(clause))
    .filter(
      (clause) =>
        clause && labelOccursAsTokenPhrase(clause, subjectName) && labelOccursAsTokenPhrase(clause, contextPhrase),
    );
  if (clauses.length === 0) return null;
  if (
    clauses.some(
      (clause) => BARE_CONTEXT_NON_ADULT_MARKER.test(clause) || BARE_CONTEXT_SCHOOL_ACTIVITY_MARKER.test(clause),
    )
  )
    return null;

  const alumniPatterns = [
    new RegExp(`${subject}${bounded}(?:graduated\\s+(?:from|at))${bounded}${context}`, "iu"),
    new RegExp(
      `${subject}${bounded}(?:(?:is|was)\\s+)?(?:(?:an?|the)\\s+)?(?:alumnus|alumna|alumni|graduate)${bounded}(?:of|from)${bounded}${context}`,
      "iu",
    ),
    new RegExp(`${context}${bounded}(?:alumnus|alumna|alumni|graduate)${bounded}${subject}`, "iu"),
  ];
  if (clauses.some((clause) => alumniPatterns.some((pattern) => pattern.test(clause)))) return "alumni";

  const professionalPatterns = [
    new RegExp(
      `${subject}${bounded}(?:works|worked|is\\s+employed|was\\s+employed|serves|served)${bounded}(?:at|for|with)${bounded}${context}`,
      "iu",
    ),
    new RegExp(
      `${subject}${bounded}(?:is|was|became|remains)\\s+(?:(?:an?|the)\\s+)?(?:${BARE_CONTEXT_ADULT_ROLE})${bounded}(?:at|for|with|of)${bounded}${context}`,
      "iu",
    ),
    new RegExp(`${subject}${bounded}(?:founded|co[- ]?founded)${bounded}${context}`, "iu"),
    new RegExp(`${context}${bounded}(?:employs|employed|hired|appointed)${bounded}${subject}`, "iu"),
  ];
  return clauses.some((clause) => professionalPatterns.some((pattern) => pattern.test(clause))) ? "professional" : null;
}

const PAGE_SCOPED_EDUCATION_BLOCKER =
  /\b(?:\d{1,2}[- ]year[- ]old|anticipated|attends?|attending|child(?:ren)?|current|currently|enroll(?:ed|ing|ment|s)?|expected|freshm(?:an|en)|grades?|graders?|in[- ]progress|k[- ]?12|minors?|ongoing|open[- ]ended|present|prospective|pupils?|school[- ]?aged|seniors?|sophomores?|students?|teen(?:ager)?s?|under[- ]?18|underage|undergraduates?|varsity|junior[- ]varsity)\b/iu;
const PAGE_SCOPED_EDUCATION_ACTIVITY_BLOCKER =
  /\b(?:(?:school|student|pupil|robotics|debate|math|science|varsity|junior[- ]varsity)\s+(?:clubs?|teams?)|(?:clubs?|teams?)\s+(?:members?|captains?|presidents?|students?|pupils?)|(?:clubs?|teams?)[^.!?;]{0,100}(?:school|academy|students?|pupils?|grades?))\b/iu;
const PAGE_SCOPED_EDUCATION_NON_CREDENTIAL =
  /\b(?:(?:high\s+school\s+)?diploma\s+(?:candidate|course|curriculum|program|track)|graduate\s+(?:program|studies|track)|alumni\s+(?:association|club|council|network))\b/iu;
const PAGE_SCOPED_EDUCATION_NEXT_ROW =
  /\b(?:About|Awards?|Certifications?|Contact|Employment|Experience|Honors?|Leadership|Projects?|Publications?|Research|Skills?|Volunteering|Work(?:\s+Experience)?)\b|\b\p{Lu}[\p{L}\p{M}&.'’()-]*(?:\s+\p{Lu}[\p{L}\p{M}&.'’()-]*){0,4}\s+(?:College|Institute|University)\b|\b\p{Lu}[\p{L}\p{M}&.'’()-]*(?:\s+\p{Lu}[\p{L}\p{M}&.'’()-]*){1,5}\s+(?:Associate|Bachelor|Certificate|Doctor|High\s+School\s+Diploma|Master)\b/u;
const EDUCATION_MONTH_PATTERN =
  "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const EDUCATION_MONTH_INDEX: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

function educationMonthIndex(value: string): number | null {
  return EDUCATION_MONTH_INDEX[value.replace(/\./gu, "").toLocaleLowerCase("en-US")] ?? null;
}

function completedEducationDateIsPast(monthValue: string, yearValue: string, observedAt: string): boolean {
  const month = educationMonthIndex(monthValue);
  const year = Number(yearValue);
  const observed = Date.parse(observedAt);
  if (month === null || !Number.isInteger(year) || year < 1900 || year > 2100 || !Number.isFinite(observed)) {
    return false;
  }
  // A month-only end date is treated as complete only after that entire month
  // has elapsed. This prevents same-month or future credentials from being
  // presented as completed.
  return Date.UTC(year, month + 1, 1) <= observed;
}

function isCanonicalObservedInstant(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function hasSecondEducationSubject(excerpt: string, contextPhrase: string): boolean {
  const context = new RegExp(regexPhrase(contextPhrase), "iu");
  const withoutContext = excerpt.replace(context, " ");
  const nonNameTokens = new Set([
    "about",
    "act",
    "aps",
    "aug",
    "august",
    "cumulative",
    "diploma",
    "education",
    "experience",
    "gpa",
    "high",
    "honors",
    "may",
    "projects",
    "publications",
    "research",
    "sat",
    "school",
    "skills",
    "work",
  ]);
  for (const match of withoutContext.matchAll(
    /(?=\b(\p{Lu}[\p{L}\p{M}'’.-]{1,})\s+(\p{Lu}[\p{L}\p{M}'’.-]{1,})\b)/gu,
  )) {
    if (
      nonNameTokens.has(match[1].toLocaleLowerCase("en-US")) ||
      nonNameTokens.has(match[2].toLocaleLowerCase("en-US"))
    ) {
      continue;
    }
    return true;
  }
  return false;
}

function hasDelimitedTrailingEducationSubject(value: string): boolean {
  return /^\s*[,;|—–-]\s*(?:Dr\.?\s+)?\p{Lu}[\p{L}\p{M}'’.-]{1,}\s+\p{Lu}[\p{L}\p{M}'’.-]{1,}\b/u.test(value);
}

function hasCurrentRequestedEducationContext(exactText: string, contextPhrase: string): boolean {
  const text = exactText.replace(/\b(?:alumn(?:a|i|us)|former)\s+(?:pupil|student)\b/giu, " ");
  const context = regexPhrase(contextPhrase);
  const current =
    "(?:anticipated|attends?|attending|current(?:ly)?\\s+(?:enrolled|pupil|student)|enroll(?:ed|ing)|expected|freshm(?:an|en)|grades?|graders?|in[- ]progress|ongoing|prospective|pupils?|seniors?|sophomores?|students?|stud(?:y|ies|ying)|under[- ]?18|underage)";
  return [
    new RegExp(`\\b(?:attends?|attending)\\s+${context}`, "iu"),
    new RegExp(`\\b${current}\\b[^.!?;|]{0,28}\\b(?:at|in|of)\\s+${context}`, "iu"),
    new RegExp(`${context}[^.!?;|]{0,48}\\b${current}\\b`, "iu"),
  ].some((pattern) => pattern.test(text));
}

/**
 * Select one exact, contiguous Education-section row from the hardened text
 * projection. The persisted quote begins at the nearby explicit `Education`
 * section marker (so a competing row subject before the requested context
 * cannot be discarded) and ends at an explicit, already-completed credential
 * date. It never stitches a fetched title to body text. Callers must
 * separately prove the exact-title personal-profile scope before using the
 * returned row as person evidence.
 */
export interface PageScopedCompletedEducationExtraction {
  excerpt: string;
  safetyWindow: string;
}

/**
 * Return both the concise claim and the exact bounded row screen used to prove
 * that inline suffixes did not turn it into a current-student, activity, or
 * competing-person row. The safety window is persisted in the cassette-bound
 * canonical subset and is recomputed by the domain integrity path.
 */
export function extractPageScopedCompletedEducationEvidence(
  exactText: string,
  contextPhrase: string,
  observedAt: string,
): PageScopedCompletedEducationExtraction | null {
  const text = exactText.trim();
  const observedYear = new Date(observedAt).getUTCFullYear();
  if (
    !text ||
    !contextPhrase ||
    text.length > 200_000 ||
    !isCanonicalObservedInstant(observedAt) ||
    containsExplicitMinorPublicContent(text, { currentYear: observedYear }) ||
    hasCurrentRequestedEducationContext(text, contextPhrase)
  )
    return null;
  const contextPattern = new RegExp(regexPhrase(contextPhrase), "giu");
  const dateRangePattern = new RegExp(
    `\\b(${EDUCATION_MONTH_PATTERN})\\.?\\s+((?:19|20)\\d{2})\\s*(?:-|–|—|\\bto\\b)\\s*(${EDUCATION_MONTH_PATTERN})\\.?\\s+((?:19|20)\\d{2})\\b`,
    "iu",
  );
  const completionDatePattern = new RegExp(`\\b(${EDUCATION_MONTH_PATTERN})\\.?\\s+((?:19|20)\\d{2})\\b`, "giu");

  for (const contextMatch of text.matchAll(contextPattern)) {
    const contextIndex = contextMatch.index ?? -1;
    if (contextIndex < 0) continue;
    const sectionLookbehindStart = Math.max(0, contextIndex - 160);
    const sectionLookbehind = text.slice(sectionLookbehindStart, contextIndex);
    const sectionMatches = [...sectionLookbehind.matchAll(/\bEducation\b/giu)];
    const sectionMatch = sectionMatches.at(-1);
    if (!sectionMatch || sectionMatch.index === undefined) continue;
    const sectionIndex = sectionLookbehindStart + sectionMatch.index;
    const contextOffset = contextIndex - sectionIndex;
    if (contextOffset <= 0 || contextOffset > 160) continue;
    const local = text.slice(sectionIndex, Math.min(text.length, sectionIndex + 480));
    const diploma = /\b(?:high\s+school\s+)?diploma\b/iu.exec(local);
    const alumni =
      /\b(?:alumnus|alumna|alumni|graduated|graduate(?!\s+(?:assistant|course|fellow|program|researcher|studies|student|track)\b))\b/iu.exec(
        local,
      );
    const credential = diploma ?? alumni;
    if (
      !credential ||
      credential.index < contextOffset + contextMatch[0].length ||
      credential.index > contextOffset + 220
    )
      continue;

    const dateRange = dateRangePattern.exec(local);
    let endIndex = -1;
    if (
      dateRange &&
      dateRange.index >= credential.index + credential[0].length &&
      dateRange.index <= credential.index + 160
    ) {
      const startMonth = educationMonthIndex(dateRange[1]);
      const endMonth = educationMonthIndex(dateRange[3]);
      const startYear = Number(dateRange[2]);
      const endYear = Number(dateRange[4]);
      const chronological =
        startMonth !== null &&
        endMonth !== null &&
        Date.UTC(startYear, startMonth, 1) <= Date.UTC(endYear, endMonth, 1);
      if (!chronological || !completedEducationDateIsPast(dateRange[3], dateRange[4], observedAt)) continue;
      endIndex = dateRange.index + dateRange[0].length;
    } else if (alumni) {
      const dated = [...local.matchAll(completionDatePattern)].find(
        (match) => (match.index ?? Number.POSITIVE_INFINITY) >= alumni.index - 80,
      );
      if (!dated || !completedEducationDateIsPast(dated[1], dated[2], observedAt)) continue;
      endIndex = (dated.index ?? 0) + dated[0].length;
    }
    if (endIndex <= 0 || endIndex > 480) continue;

    const excerpt = local.slice(0, endIndex).trim();
    const postCompletion = local.slice(endIndex, Math.min(local.length, endIndex + 160));
    const nextRow = PAGE_SCOPED_EDUCATION_NEXT_ROW.exec(postCompletion);
    const rowSuffix = postCompletion.slice(0, nextRow?.index ?? postCompletion.length);
    const safetyWindow = local.slice(0, endIndex + rowSuffix.length).trim();
    if (
      !excerpt ||
      excerpt.length > 480 ||
      !safetyWindow ||
      safetyWindow.length > 640 ||
      !labelOccursAsTokenPhrase(excerpt, contextPhrase) ||
      PAGE_SCOPED_EDUCATION_NON_CREDENTIAL.test(excerpt) ||
      PAGE_SCOPED_EDUCATION_BLOCKER.test(safetyWindow) ||
      PAGE_SCOPED_EDUCATION_ACTIVITY_BLOCKER.test(safetyWindow) ||
      hasSecondEducationSubject(local.slice(0, credential.index), contextPhrase) ||
      hasDelimitedTrailingEducationSubject(rowSuffix)
    )
      continue;
    return { excerpt, safetyWindow };
  }
  return null;
}

export function extractPageScopedCompletedEducationExcerpt(
  exactText: string,
  contextPhrase: string,
  observedAt: string,
): string | null {
  return extractPageScopedCompletedEducationEvidence(exactText, contextPhrase, observedAt)?.excerpt ?? null;
}

/** Recompute a persisted page-scoped row without trusting extractor metadata. */
export function matchPageScopedCompletedEducationRelation(
  exactExcerpt: string,
  contextPhrase: string,
  observedAt: string,
  exactSafetyWindow = exactExcerpt,
): BareContextRelationKind | null {
  const extracted = extractPageScopedCompletedEducationEvidence(exactSafetyWindow, contextPhrase, observedAt);
  return extracted?.excerpt === exactExcerpt.trim() && extracted.safetyWindow === exactSafetyWindow.trim()
    ? "alumni"
    : null;
}

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

/**
 * Produce bounded search hypotheses for a bare search-engine-style phrase such
 * as `alex rivera northstar labs` without rewriting the canonical parsed name.
 *
 * These hypotheses have no identity authority by themselves. Callers may use
 * them for discovery only, and may bind one only after hardened direct text
 * explicitly relates the proposed subject to the proposed context. Retaining
 * the full parsed name as the primary interpretation keeps multi-part names
 * available and prevents this convenience grammar from becoming a name split.
 */
export function bareNameContextHypotheses(target: ParsedTarget): BareNameContextHypothesis[] {
  if (
    target.kind !== "named_person" ||
    !target.name ||
    target.identifiers.length > 0 ||
    target.organizationHints.length > 0 ||
    target.roleHints.length > 0 ||
    target.locationHints.length > 0
  )
    return [];

  const query = normalizeWhitespace(
    target.rawInput.replace(LEADING_REQUEST_PATTERN, "").replace(TRAILING_SCOPE_PATTERN, ""),
  );
  const words = query.split(" ").filter(Boolean);
  if (
    words.length < 4 ||
    words.length > 5 ||
    NON_ADULT_EDUCATION_MARKER.test(query) ||
    containsRestrictedPublicContent(query) ||
    !words.every((word) => /^[\p{L}][\p{L}\p{M}'’.-]*$/u.test(word))
  )
    return [];

  const hypotheses: BareNameContextHypothesis[] = [];
  const splitPoints = words.length === 5 ? [2, 3] : [2];
  for (const splitPoint of splitPoints) {
    const subject = normalizeWhitespace(words.slice(0, splitPoint).join(" "));
    const context = normalizeWhitespace(words.slice(splitPoint).join(" "));
    const lastSubjectWord = normalizeComparable(words[splitPoint - 1] ?? "");
    const firstContextWord = normalizeComparable(words[splitPoint] ?? "");
    if (
      !looksLikePersonName(subject) ||
      context.split(" ").length < 2 ||
      MULTIPART_NAME_PARTICLES.has(lastSubjectWord) ||
      MULTIPART_NAME_PARTICLES.has(firstContextWord) ||
      ORGANIZATION_MARKER.test(subject)
    )
      continue;
    const subjectName = titleCaseName(subject);
    const contextPhrase = titleCaseName(context);
    const normalizedSubjectName = normalizeComparable(subjectName);
    const normalizedContextPhrase = normalizeComparable(contextPhrase);
    if (!normalizedSubjectName || !normalizedContextPhrase) continue;
    hypotheses.push({ subjectName, normalizedSubjectName, contextPhrase, normalizedContextPhrase });
  }
  return [
    ...new Map(
      hypotheses.map((hypothesis) => [
        `${hypothesis.normalizedSubjectName}|${hypothesis.normalizedContextPhrase}`,
        hypothesis,
      ]),
    ).values(),
  ].slice(0, 2);
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

const NON_ADULT_EDUCATION_MARKER = /\b(?:elementary|middle|high|secondary|junior[- ]high|k[- ]?12|grade)\b/i;
const NON_ADULT_EDUCATION_ACRONYMS = new Set(["ES", "HS", "JHS", "K12", "MS"]);
const ADULT_EDUCATION_MARKER =
  /\b(?:universit(?:y|ies)|college|institute|polytechnic|business\s+school|law\s+school|medical\s+school|school\s+of)\b/i;
const EDUCATION_CONTEXT_PREFIX =
  /^(?:school|college|university|education|stud(?:y|ies|ied|ying)|attends?|student)(?:\s+(?:at|with))?\s*(?::|=|-)?\s+(.+)$/i;
const LEADING_EDUCATION_CONTEXT =
  /^(.+?)\s+(stud(?:y|ies|ied|ying)\s+at|student\s+at|attends?|goes\s+to|went\s+to|graduated\s+from|alumn(?:us|a|i)\s+of|(?:school|college|university)\s*(?::|=|-)?)[ ]*(.+)$/i;

function looksLikeAdultEducationInstitution(value: string): boolean {
  const institution = normalizeWhitespace(value.replace(/^["']|["']$/g, ""));
  if (
    !institution ||
    institution.length > 160 ||
    institution.split(" ").length > 12 ||
    containsRestrictedPublicContent(institution) ||
    NON_ADULT_EDUCATION_MARKER.test(institution)
  )
    return false;
  return (
    ADULT_EDUCATION_MARKER.test(institution) ||
    (/^[A-Z][A-Z&.-]{1,15}$/.test(institution) && !NON_ADULT_EDUCATION_ACRONYMS.has(institution))
  );
}

/**
 * Parse common, explicit adult-education disambiguators without treating the
 * entire sentence as either a person's name or an organization. Ambiguous
 * bare text stays outside this grammar; school-age labels fail closed.
 */
function leadingPersonEducation(value: string): {
  person: string;
  institution: string;
  relationship: OrganizationHint["relationship"];
} | null {
  const match = normalizeWhitespace(value).match(LEADING_EDUCATION_CONTEXT);
  const person = normalizeWhitespace(match?.[1] ?? "");
  const connector = normalizeWhitespace(match?.[2] ?? "");
  const institution = normalizeWhitespace(match?.[3] ?? "");
  if (
    !person ||
    !institution ||
    ORGANIZATION_MARKER.test(person) ||
    !looksLikePersonName(person) ||
    !looksLikeAdultEducationInstitution(institution)
  )
    return null;
  return {
    person,
    institution,
    relationship: /^(?:went\s+to|graduated\s+from|alumn)/i.test(connector) ? "former" : "current",
  };
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
  const freeformEducation = firstPart && !freeformLocation ? leadingPersonEducation(firstPart) : null;
  const rejectedFreeformEducation = Boolean(
    firstPart && !freeformEducation && looksLikePersonName(firstPart.match(LEADING_EDUCATION_CONTEXT)?.[1] ?? ""),
  );
  const freeformOrganization =
    firstPart && !freeformLocation && !freeformEducation && !rejectedFreeformEducation
      ? leadingPersonOrganization(firstPart)
      : null;
  const leadingPersonContext = freeformLocation ?? freeformEducation ?? freeformOrganization;
  const firstPartLooksOrganizational = Boolean(
    firstPart && !leadingPersonContext && !rejectedFreeformEducation && ORGANIZATION_MARKER.test(firstPart),
  );
  const personPart = rejectedFreeformEducation ? undefined : (leadingPersonContext?.person ?? firstPart);
  if (personPart && !firstPartLooksOrganizational && looksLikePersonName(personPart)) {
    name = titleCaseName(personPart);
  }
  if (freeformLocation) addLocation(locationHints, freeformLocation.location);
  if (freeformEducation)
    addOrganization(organizationHints, freeformEducation.institution, freeformEducation.relationship);
  if (freeformOrganization) addOrganization(organizationHints, freeformOrganization.organization, "current");

  const roleOrganization = organizationFromRoleQuery(withoutEmails);
  if (roleOrganization) {
    addOrganization(organizationHints, roleOrganization, "current");
  }

  for (const part of commaParts.slice(name || explicitOrganization ? 1 : 0)) {
    addRole(roleHints, part);

    if (rejectedFreeformEducation && part === firstPart) {
      continue;
    }

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

    const education = part.match(EDUCATION_CONTEXT_PREFIX);
    if (education?.[1]) {
      if (looksLikeAdultEducationInstitution(education[1])) {
        addOrganization(organizationHints, education[1], "current");
      }
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

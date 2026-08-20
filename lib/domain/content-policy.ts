import type { JsonValue } from "./types";

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}\b/gi;

const CREDENTIAL_LITERAL_PATTERNS = [
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{20,255})\b/,
  /\bsk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{20,255}\b/,
  /\b(?:npm_|pypi-|hf_|glpat-|dop_v1_)[A-Za-z0-9_-]{20,255}\b/,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,255}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{16,255}\b/,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/,
  /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/,
] as const;

/** Known high-entropy credential formats that must never enter durable OSINT output. */
export function containsCredentialLiteral(value: string): boolean {
  const normalized = value.normalize("NFKC");
  return CREDENTIAL_LITERAL_PATTERNS.some((pattern) => pattern.test(normalized));
}

const RESTRICTED_URL_QUERY_KEYS = new Set([
  "accesskey",
  "accesstoken",
  "address",
  "apikey",
  "auth",
  "authorization",
  "bearer",
  "authorizationcode",
  "authcode",
  "authtoken",
  "cell",
  "children",
  "clientsecret",
  "code",
  "compensation",
  "contactnumber",
  "cookie",
  "coordinates",
  "credential",
  "credentials",
  "daughter",
  "diagnosis",
  "disability",
  "disease",
  "email",
  "ethnicity",
  "faith",
  "family",
  "father",
  "financial",
  "genderidentity",
  "gps",
  "health",
  "homeaddress",
  "homelocation",
  "husband",
  "illness",
  "income",
  "jwt",
  "jwttoken",
  "key",
  "kids",
  "livelocation",
  "mailingaddress",
  "medical",
  "medication",
  "mobile",
  "mother",
  "nationalorigin",
  "mfacode",
  "nationality",
  "nextofkin",
  "oauthcode",
  "otp",
  "parent",
  "party",
  "passcode",
  "passwd",
  "password",
  "phone",
  "phonenumber",
  "politicalaffiliation",
  "politics",
  "pregnancy",
  "privatekey",
  "pronouns",
  "race",
  "recoverycode",
  "refreshtoken",
  "relative",
  "religion",
  "residence",
  "residentialaddress",
  "salary",
  "secret",
  "secretkey",
  "session",
  "sessioncookie",
  "sessionid",
  "sessiontoken",
  "sig",
  "signature",
  "sibling",
  "son",
  "spouse",
  "tel",
  "telephone",
  "token",
  "xapikey",
  "xamzcredential",
  "xamzsecuritytoken",
  "xamzsignature",
  "wife",
  "sexualorientation",
]);

export function normalizeRestrictedUrlQueryKey(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]/g, "");
}

export function isRestrictedUrlQueryKey(value: string): boolean {
  return RESTRICTED_URL_QUERY_KEYS.has(normalizeRestrictedUrlQueryKey(value));
}

const RESTRICTED_JSON_FIELD_KEYS = new Set([
  "phone",
  "phonenumber",
  "telephone",
  "tel",
  "mobile",
  "mobilephone",
  "cell",
  "cellphone",
  "personalphone",
  "contactnumber",
  "directnumber",
  "whatsapp",
  "homeaddress",
  "residentialaddress",
  "streetaddress",
  "mailingaddress",
  "homelocation",
  "livelocation",
  "realtimelocation",
  "preciselocation",
  "gps",
  "coordinates",
  "password",
  "passcode",
  "privatekey",
  "secretkey",
  "credential",
  "credentials",
  "ssn",
  "socialsecurity",
  "authtoken",
  "sessiontoken",
  "clientsecret",
  "oauthcode",
  "spouse",
  "husband",
  "wife",
  "children",
  "kids",
  "parents",
  "siblings",
  "relatives",
  "nextofkin",
  "religion",
  "faith",
  "race",
  "ethnicity",
  "politicalaffiliation",
  "politicalbeliefs",
  "sexualorientation",
  "genderidentity",
  "diagnosis",
  "medicalhistory",
  "medication",
  "salary",
  "income",
  "compensation",
  "networth",
  "debt",
  "creditrecord",
]);

/** Field-name gate for arbitrary provider/model JSON, including numeric leaves. */
export function isRestrictedJsonFieldKey(value: string): boolean {
  return RESTRICTED_JSON_FIELD_KEYS.has(normalizeRestrictedUrlQueryKey(value));
}

/** Bare 10-15 digit values are ambiguous at best and phone-like at worst. */
export function isCompactPhoneNumberValue(value: unknown): boolean {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && /^\d{10,15}$/.test(String(value));
  }
  return typeof value === "string" && /^\p{Decimal_Number}{10,15}$/u.test(value.normalize("NFKC").trim());
}

function boundedDecode(value: string): string {
  let decoded = value;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

function containsRestrictedAssignment(value: string): boolean {
  for (const match of boundedDecode(value).matchAll(/(?:^|[?&#;])([^=&#;]{1,80})=/g)) {
    if (isRestrictedUrlQueryKey(match[1])) return true;
  }
  return false;
}

/** Credential/private-data URL gate shared by actions, evidence, trace, and fetch. */
export function urlContainsRestrictedParameters(value: string, depth = 0): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return true;
  if (containsRestrictedAssignment(url.hash.slice(1))) return true;
  for (const [key, rawValue] of url.searchParams) {
    if (isRestrictedUrlQueryKey(key)) return true;
    const decoded = boundedDecode(rawValue);
    if (containsRestrictedAssignment(decoded)) return true;
    if (depth < 2 && /^https?:\/\//i.test(decoded) && urlContainsRestrictedParameters(decoded, depth + 1)) return true;
  }
  return false;
}

const RESTRICTED_TEXT_PATTERNS = [
  /\b(?:home|residential|street)\s+address\b/i,
  /\b(?:password|passcode|api\s*key|private\s*key|seed\s*phrase|login credentials?|social security|ssn)\b/i,
  /\b(?:spouse|children|kids|family members?|family tree|romantic partner)\b/i,
  /\b(?:has|have|had|is|was)\b.{0,24}\b(?:husband|wife|spouse|parents?|children|kids)\b/i,
  /\b(?:is|was|got)\s+married\b/i,
  /\b(?:[A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*)?|[Hh]is|[Hh]er|[Tt]heir)'?s?\s+(?:mother|father|son|daughter|brothers?|sisters?|siblings?|relatives?|parents?)\b/u,
  /\b(?:mother|father|son|daughter|brothers?|sisters?|siblings?|relatives?|parents?)\s+(?:are|is|include|includes|named)\b/i,
  /\b(?:who|find|identify|research|list|tell me about)\b.{0,40}\b(?:mother(?!\s+company)|father|son|daughter|brothers?|sisters?|siblings?|relatives?|parents?)\b/i,
  /\b(?:name|identify|list)\b.{0,40}\b(?:sons?|daughters?|brothers?|sisters?|siblings?|relatives?|next of kin)\b/i,
  /\bbrothers?\s+and\s+sisters?\b/i,
  /\b(?:[A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*)?|[Hh]is|[Hh]er|[Tt]heir)'?s?\s+(?:sons?|daughters?|brothers?|sisters?)\s+(?:are|include|includes|were)\b/u,
  /\b(?:[A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*)?|[Hh]e|[Ss]he|[Tt]hey)\s+(?:is|was|were)\s+raised\s+by\b/u,
  /\b(?:medical history|diagnosis|health condition|mental health|sexual orientation|gender identity|genetic information)\b/i,
  /\b(?:has|had|diagnosed with|suffers? from|treated for)\b.{0,24}\b(?:cancer|hiv|aids|autism|depression|bipolar disorder)\b/i,
  /\b(?:bank account|credit card|routing number|credit score|bank balance|financial condition)\b/i,
  /\b(?:earns?|makes?|salary|income|compensation)\b.{0,20}(?:\$\s*)?\d[\d,]*(?:\.\d+)?(?:\s*[km])?\b/i,
  /\b(?:is|was|identifies as|affiliated with|supports?)\b.{0,24}\b(?:muslim|christian|jewish|hindu|buddhist|sikh|asian|black|white|latino|hispanic|democrat|republican)\b/i,
  /\b(?:is|was|identifies as)\b.{0,20}\b(?:gay|lesbian|bisexual|transgender|disabled|pregnant)\b/i,
  /\b(?:is|was|identifies as|affiliated with|supports?)\b.{0,24}\b(?:catholic|orthodox|mormon|atheist|left[- ]wing|right[- ]wing|neurodivergent)\b/i,
  /\b(?:is|was|whether|seems?|leans?)\b.{0,24}\b(?:conservative|liberal|progressive)\b/i,
  /\bhow\s+(?:does|did)\b.{0,36}\bvote\b/i,
  /\b(?:what|which|tell|find|determine)\b.{0,32}\b(?:heritage|ancestry|pronouns?)\b/i,
  /\b(?:heritage|ancestry|pronouns?)\s+(?:is|are|includes?)\b/i,
  /\b(?:takes?|uses?|prescribed|on)\b.{0,20}\b(?:antidepressants?|psychiatric medication)\b/i,
  /\b(?:has|have|had|diagnosed with|suffers? from)\b.{0,12}\b(?:ms|multiple sclerosis)\b/i,
  /\b(?:high[- ]school|middle[- ]school|elementary[- ]school)\s+(?:student|freshman|sophomore|junior|senior)\b/i,
  /\b(?:9th|10th|11th|12th)[ -]grader\b/i,
  /\bteen(?:age|ager)?\s+(?:person|founder|developer|student|researcher|engineer|executive)\b/i,
  /\bstudent\s+(?:aged?|age)\s+(?:[0-9]|1[0-7])\b/i,
  /\b(?:[A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*)?|[Hh]e|[Ss]he|[Tt]hey|[Ss]tudent)\s*,?\s+(?:is\s+)?(?:aged?|age)\s+(?:[0-9]|1[0-7])\b/u,
  /\b(?:[A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*)?|[Hh]e|[Ss]he|[Tt]hey)\s+is\s+under[- ]?18\b/u,
  /\b(?:[A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*)?|[Hh]e|[Ss]he|[Tt]hey|[Ss]tudent)\s+(?:turned|turns|turning)\s+(?:[0-9]|1[0-7])\b/u,
  /\b(?:[A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*)?|[Hh]e|[Ss]he|[Tt]hey|[Ss]tudent)\s*,?\s+(?:who\s+)?(?:turned|turns|turning)\s+(?:[0-9]|1[0-7])\b/u,
  /\b(?:schoolboy|schoolgirl|(?:ninth|tenth|eleventh|twelfth)[ -]grade\s+student)\b/i,
  /\b(?:where|find|locate|show|what)\b.{0,40}\b(?:house|home|residence|landline)\b/i,
  /\b(?:house|home|residence)\s+(?:address|location|whereabouts)\b/i,
  /\bdwelling\s+address\b/i,
  /\b(?:where|find|what|reveal|locate)\b.{0,36}\bdomicile\b/i,
  /\b(?:[A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*)?|[Hh]is|[Hh]er|[Tt]heir)'?s?\s+domicile\s+(?:is|was)\b/u,
  /\bmailing\s+address\b/i,
  /\bwhere\b.{0,40}\b(?:stay|stays|sleep|sleeps)\b.{0,20}\b(?:at night|tonight)\b/i,
  /\b(?:[A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*)?|[Hh]e|[Ss]he|[Tt]hey)\s+(?:stay|stays|sleep|sleeps)\s+at\s+night\b/u,
  /\blandline(?:\s+number)?\b/i,
  /\b(?:phone|telephone|contact|direct|call)\s+number\b/i,
  /\bcontact\s+details?\b/i,
  /\bnumber\b.{0,28}\b(?:reach|contact|call|whatsapp)\b/i,
  /\b(?:reach|contact|message)\b.{0,28}\b(?:on|via|using)\s+whatsapp\b/i,
  /\b(?:whatsapp)\b.{0,24}\b(?:number|contact|details?|is|account)\b/i,
  /\b(?:get|give|find|show|reveal)\b.{0,24}\b(?:mobile|cell|telephone|phone|digits)\b/i,
  /\b(?:[A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*)?|[Hh]is|[Hh]er|[Tt]heir)'?s?\s+(?:mobile|cell(?:\s+phone)?|telephone|phone|digits)\s+(?:is|are|was|were)\b/u,
  /\bnumber\b.{0,24}\bso\s+(?:that\s+)?i\s+can\s+call\b/i,
  /\bhow\s+(?:can|do)\s+i\s+ring\b/i,
  /\bGPS\s+coordinates?\b/i,
  /\b(?:location|whereabouts|coordinates?)\b.{0,20}\bright\s+this\s+second\b/i,
  /\bwhere\s+(?:is|are)\b.{0,48}\bright\s+this\s+second\b/i,
  /\b(?:[A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*)?|[Hh]e|[Ss]he|[Tt]hey)\s+is\s+at\b.{0,40}\bright\s+this\s+second\b/u,
  /\b(?:[A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*)?|[Hh]is|[Hh]er|[Tt]heir)'?s?\s+(?:house|home)\s+is\b/u,
  /\b(?:does|do)\b.{0,32}\b(?:have|has)\b.{0,18}\b(?:sons?|daughters?|brothers?|sisters?|siblings?|relatives?|next of kin)\b/i,
  /\bwho\b.{0,32}\braised\b/i,
  /\bnext\s+of\s+kin\b/i,
  /\b(?:who|how|is|was|find|identify)\b.{0,36}\brelated\s+to\b/i,
  /\bmap\b.{0,24}\bkin\b/i,
  /\b(?:[A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*)?|[Hh]e|[Ss]he|[Tt]hey)\s+(?:is|was)\s+related\s+to\b/u,
  /\b(?:what|which|find|determine|infer)\b.{0,36}\b(?:political leaning|party preference|ethnic background|national origin|sexuality|what sex)\b/i,
  /\bwhich\s+(?:political\s+)?party\b.{0,36}\bprefer(?:s|red)?\b/i,
  /\b(?:[A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*)?|he|she|they)\s+prefers?\b.{0,24}\b(?:the\s+)?(?:democratic|republican|liberal|conservative)\s+party\b/iu,
  /\b(?:political leaning|party preference|ethnic background|national origin|sexuality)\s+(?:is|are)\b/i,
  /\bwhat\s+sex\b/i,
  /\b(?:what|which|find|has|have|diagnosed with)\b.{0,28}\b(?:illness|disease)\b/i,
  /\b(?:[A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*)?|[Hh]is|[Hh]er|[Tt]heir)'?s?\s+(?:illness|disease)\s+(?:is|was)\b/u,
  /\b(?:takes?|uses?|prescribed|on)\b.{0,20}\b(?:prozac|insulin)\b/i,
  /\b(?:is|was|became)\b.{0,12}\bdiabetic\b/i,
  /\b(?:has|had|diagnosed with|suffers? from)\b.{0,12}\bdiabetes\b/i,
  /\b(?:does|do)\b.{0,32}\bhave\b.{0,12}\bdiabetes\b/i,
  /\b(?:is|was|whether)\b.{0,16}\bstraight\b/i,
  /\b(?:what|which)\b.{0,36}\bchurch\b.{0,20}\battend(?:s|ed)?\b/i,
  /\b(?:attends?|attended)\b.{0,20}\bchurch\b/i,
  /\b(?:did|does|has|have)\b.{0,36}\bvote(?:d)?\s+for\b/i,
  /\b(?:[A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*)?|[Hh]e|[Ss]he|[Tt]hey)\s+voted\s+for\b/u,
  /\b(?:how much|what)\b.{0,28}\b(?:is|was|does|did)?\s*(?:he|she|they|[A-Z][\p{L}'’-]*)\s+(?:get\s+)?paid\b/u,
  /\bhow\s+much\b.{0,16}\b(?:is|was|does|did)\b.{0,40}\bpaid\b/i,
  /\b(?:what|how\s+much)\s+(?:is|was)\b.{0,40}\bpaid\b/i,
  /\b(?:[A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*)?|[Hh]e|[Ss]he|[Tt]hey)\s+(?:is|was|gets?)\s+paid\b/u,
  /\b(?:is|was|whether|seems?)\b.{0,16}\bwealthy\b/i,
  /\bhow\s+wealthy\b/i,
  /\b(?:[A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*)?|[Hh]is|[Hh]er|[Tt]heir)'?s?\s+sex\s+(?:is|was)\b/u,
  /\b(?:current|live|real[- ]?time)\s+(?:location|coordinates)\b/i,
];

const STREET_ADDRESS_PATTERN =
  /\b\d{1,6}[ -]+(?:[A-Z][A-Za-z0-9.'-]*[ -]+){1,4}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Parkway|Pkwy|Circle|Cir|Terrace|Trail|Highway|Hwy)\.?\b/;
const CONTEXTUAL_STREET_ADDRESS_PATTERN =
  /\b(?:lives? at|resides? at|home address|mailing address|street address|located at)\b.{0,32}\b\d{1,6}[ -]+[A-Z0-9][A-Z0-9.'-]*(?:[ -]+[A-Z0-9][A-Z0-9.'-]*){0,4}[ -]+(?:street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|way|parkway|pkwy|circle|cir|terrace|trail|highway|hwy)\.?\b/i;
const POST_OFFICE_BOX_PATTERN = /\bP\.?\s*O\.?\s+Box\s+\d{1,10}\b/i;

export interface ContentPolicyOptions {
  allowedEmails?: ReadonlySet<string>;
  allowAnyEmail?: boolean;
  currentYear?: number;
}

function phoneLike(value: string): boolean {
  const withoutMachineIds = value
    .normalize("NFKC")
    .replace(/(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![0-9a-f])/gi, " ");
  // JavaScript's `\d` is ASCII-only. Mapping every Unicode decimal digit to a
  // neutral ASCII digit makes full-width and Arabic-Indic phone strings pass
  // through the same boundary without attempting to interpret their value.
  const normalizedDigits = withoutMachineIds.replace(/\p{Decimal_Number}/gu, "0");
  const candidates = normalizedDigits.match(/\+?\d[\d(). -]{7,}\d/g) ?? [];
  if (isCompactPhoneNumberValue(withoutMachineIds)) return true;
  if (
    candidates.some((candidate) => {
      const digits = candidate.replace(/\D/g, "");
      return digits.length >= 10 && digits.length <= 15 && (candidate.startsWith("+") || /[(). -]/.test(candidate));
    })
  )
    return true;
  return /\b(?:find|get|lookup|reveal|show|call|contact|reach|phone|mobile|cell|telephone|whatsapp)\b.{0,32}\b\d{10,15}\b/i.test(
    normalizedDigits,
  );
}

const NON_PERSON_AGE_SUBJECTS = new Set([
  "company",
  "organization",
  "product",
  "project",
  "program",
  "business",
  "startup",
  "language",
  "repository",
  "website",
  "system",
  "model",
  "paper",
  "conference",
]);

const WORD_AGES: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
};

/**
 * Shared intent/claim grammar for ordinary-language variants of the prohibited
 * concepts. These predicates are deliberately contextual: professional-domain
 * phrases such as “wheelchair accessibility” or “net worth estimation paper”
 * do not match unless the text asks for, or asserts, the trait about a person.
 */
const RESTRICTED_CONCEPT_PATTERNS = [
  // Minor-targeting school labels. Product release numbers remain outside this
  // grammar because the student/person noun is mandatory.
  /\b(?:secondary[- ]school|year\s+(?:[1-9]|1[0-2]))\s+student\b/i,
  /\b(?:junior[- ]high\s+student|(?:[1-9]|1[0-2]|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth)[- ]grade\s+(?:student|pupil)|school[- ]aged\s+child)\b/i,
  // Private contact and residence intents.
  /\bwhat\s+street\b.{0,36}\blive(?:s|d)?\s+on\b/i,
  /\bwhere\b.{0,16}\b(?:send|mail)\b.{0,48}\b(?:letter|something)\b/i,
  /\b(?:mobile|cell|telephone|phone)\s+digits?\b/i,
  /\b(?:best\s+way|how)\b.{0,32}\breach\b.{0,32}\bprivately\b/i,
  /\bwhat\b.{0,32}\bpostcode\b/i,
  /\bwhere\b.{0,28}\b(?:receive|receives)\s+mail\b/i,
  /\bcan\s+i\s+have\b.{0,36}\bnumber\b/i,
  /\b(?:give|show|find|get)\b.{0,36}\bprivate\s+email\b/i,
  /\b(?:contact|reach|message)\b.{0,36}\boff[- ]platform\b/i,
  // Family, household, and relationship mapping.
  /\bwho\s+are\b.{0,36}\bfolks\b/i,
  /\b(?:tell|show|find|identify)\b.{0,28}\bwho\s+lives?\s+with\b/i,
  /\bwho\b.{0,32}\b(?:shares?\s+(?:a\s+)?household|family)\b/i,
  /\bwho\s+lives?\b.{0,28}\b(?:same\s+roof|household)\b/i,
  // Protected traits, health, and political affiliation.
  /\bwhat\b.{0,32}\bsynagogue\b.{0,24}\battend(?:s|ed)?\b/i,
  /\b(?:is|was)\b.{0,32}\breligious\b/i,
  /\bwhat\s+faith\b.{0,36}\bfollow(?:s|ed)?\b/i,
  /\bwhat\b.{0,32}\bdenomination\b/i,
  /\bwhat\b.{0,32}\breligious\s+beliefs?\b/i,
  /\b(?:does|do|did)\b.{0,32}\bworship\b.{0,24}\b(?:temple|synagogue|church|mosque)\b/i,
  /\b(?:is|was)\b.{0,32}\b(?:heterosexual|queer)\b/i,
  /\b(?:is|was)\b.{0,32}\bbi\b/i,
  /\bwhat\b.{0,32}\bsexual\s+preference\b/i,
  /\bwhich\s+political\s+candidate\b.{0,36}\bsupport(?:s|ed)?\b/i,
  /\b(?:[A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*)?|[Hh]e|[Ss]he|[Tt]hey)\b.{0,24}\bbacks?\s+(?:candidate\s+)?[A-Z][\p{L}'’-]*\b/u,
  /\b(?:who|which)\b.{0,36}\bendorse(?:s|d)?\b.{0,20}\bpolitic(?:al|ally)?\b/i,
  /\b(?:[A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*)?|[Hh]e|[Ss]he|[Tt]hey)\b.{0,24}\bsupports?\b.{0,24}\bcampaign\b/u,
  /\bwhat\b.{0,32}\bpolitics\b/i,
  /\b(?:does|do|did|has|have|had|is|was)\b.{0,36}\b(?:epilepsy|hiv[- ]positive)\b/i,
  /\b(?:does|do|did)\b.{0,32}\buse(?:s|d)?\s+(?:a\s+)?wheelchair\b/i,
  /\bwhat\s+medication\b.{0,40}\bon\b/i,
  /\b(?:does|do|did|has|have|had|is|was)\b.{0,36}\b(?:suffer(?:s|ed)?\s+(?:from\s+)?seizures?|positive\s+for\s+hiv)\b/i,
  /\b(?:is|was)\b.{0,32}\bwheelchair\s+user\b/i,
  /\bwhat\s+prescriptions?\b.{0,36}\btake(?:s|n)?\b/i,
  /\b(?:does|do|did)\b.{0,32}\btake(?:s|n)?\s+metformin\b/i,
  /\b(?:find|get|show|reveal|what)\b.{0,36}\b(?:genetic\s+test\s+results?|citizenship|race)\b/i,
  // Personal finances. Research about the concepts is allowed; the grammar
  // requires a direct question or assertion about a person/value.
  /\bwhat\s+(?:is|was)\b.{0,40}\b(?:net\s+worth|wage)\b/i,
  /\bwhat\s+(?:does|did)\b.{0,40}\bearn(?:s|ed)?\b/i,
  /\b(?:[A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*)?|[Hh]e|[Ss]he|[Tt]hey)\b.{0,12}\b(?:is|was)\s+worth\s+\$?\d/u,
  /\b(?:[A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*)?|[Hh]e|[Ss]he|[Tt]hey)\b.{0,12}\bowes?\s+\$?\d/u,
  /\bwhat\b.{0,32}\bannual\s+pay\b/i,
  /\b(?:is|was)\b.{0,32}\bmillionaire\b/i,
  /\bwhat\b.{0,32}\bassets\b/i,
  /\bhow\s+much\b.{0,36}\bmake(?:s|d)?\b/i,
  // Precise/current location.
  /\bwhere\b.{0,36}\bat\s+the\s+moment\b/i,
  /\bwhere\b.{0,40}\b(?:location|whereabouts|coordinates?)\b/i,
  /\b(?:locate|track)\b.{0,40}\b(?:now|whereabouts)\b/i,
  /\b(?:show|find|reveal)\b.{0,36}\bpresent\s+location\b/i,
  /\bwhere\b.{0,36}\bcurrently\b/i,
  /\b(?:pin|find|show)\b.{0,36}\b(?:location|coordinates)\b/i,
  /\bwhere\b.{0,36}\bfound\s+tonight\b/i,
  // Credentials and account recovery data.
  /\b(?:find|get|show|reveal)\b.{0,36}\b(?:login|auth(?:entication)?\s+token|recovery\s+code)\b/i,
  /\b(?:find|get|show|reveal)\b.{0,36}\b(?:session\s+cookie|otp|two[- ]factor\s+code|mfa\s+code|recovery\s+phrase)\b/i,
];

const SAFE_PROFESSIONAL_CONTEXT_PATTERNS = [
  /\bcurrently\s+(?:employed|working)\b/i,
  /\bcurrent\s+professional\s+affiliations?\b/i,
  /\bnumber\s+of\s+publications?\b/i,
  /\bopen[- ]source\s+assets?\b/i,
  /\bassets?\b.{0,24}\bpublish(?:ed)?\b.{0,24}\bproject\b/i,
  /\bannual\s+pay\s+equity\s+research\b/i,
  /\bmake\s+available\s+as\s+open\s+source\b/i,
  /\bmillionaire[- ]algorithm\s+researcher\b/i,
  /\bpaper\s+on\s+millionaire\s+migration\b/i,
  /\breligious\s+beliefs?\s+(?:publications?|paper)\b/i,
  /\btemple\s+architecture\s+project\b/i,
  /\bdenomination\b.{0,24}\b(?:effects?\b.{0,40}\bstud(?:y|ied)|dataset)\b/i,
  /\brace\s+condition\b/i,
  /\bcitizenship\s+research\b.{0,24}\bpublish(?:ed)?\b/i,
  /\b(?:paper\s+on\s+genetic[- ]test\s+interpretation|genetic[- ]testing\s+benchmark)\b/i,
  /\bwheelchair\s+user\s+interface\s+researcher\b/i,
  /\bprescriptions?\s+database\b/i,
  /\b(?:metformin\s+into\s+account\s+in\s+the\s+study|metformin\s+research\s+analysis)\b/i,
  /\bseizure[- ]detection\s+publications?\b/i,
  /\bsession\s+cookie\s+security\s+publication\b/i,
  /\botp\s+library\b/i,
  /\btwo[- ]factor\s+code\s+sample\s+repositor(?:y|ies)\b/i,
  /\bmfa\s+code\s+generator\s+project\b/i,
  /\brecovery\s+phrase\s+research\b/i,
  /\bcoordinates\b.{0,24}\bauthorship\s+graph\b/i,
  /\blocation\s+in\s+the\s+org\s+chart\b/i,
  /\bpolitics\s+publications?\b/i,
  /\bpublished\s+comparative\s+study\b/i,
  /\bcampaign[- ]support\s+software\b/i,
];

/** Narrow exception for phrases that name a professional artifact or work topic. */
export function isClearlyProfessionalConceptContext(value: string): boolean {
  return withoutClearlyProfessionalConceptContext(value) !== value;
}

/**
 * Removes only the attested professional-topic span. It never exempts the
 * surrounding clause, so `private number and number of publications` remains
 * restricted after the safe publication phrase is masked.
 */
export function withoutClearlyProfessionalConceptContext(value: string): string {
  let policyText = value;
  for (const pattern of SAFE_PROFESSIONAL_CONTEXT_PATTERNS) {
    const flags = `${pattern.flags.replaceAll("g", "")}g`;
    policyText = policyText.replace(new RegExp(pattern.source, flags), " ");
  }
  return policyText;
}

function restrictedConceptLike(value: string): boolean {
  const policyText = withoutClearlyProfessionalConceptContext(value);
  return RESTRICTED_CONCEPT_PATTERNS.some((pattern) => pattern.test(policyText));
}

function minorAgeLike(value: string, currentYear: number): boolean {
  const normalizedAges = value.replace(
    /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)\b/gi,
    (word) => String(WORD_AGES[word.toLocaleLowerCase("en-US")] ?? word),
  );
  for (const match of normalizedAges.matchAll(
    /\b(\d{1,2})\s*(?:y\/?o|[- ]?years?[- ]?old)\s+(?:person|founder|developer|student|researcher|engineer|executive|boy|girl|teen(?:ager)?)\b/gi,
  )) {
    if (Number(match[1]) < 18) return true;
  }
  for (const match of normalizedAges.matchAll(
    /\b(?:[A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*)?|[Hh]e|[Ss]he|[Tt]hey)\s*,?\s*(\d{1,2})\s*y\/?o\b/gu,
  )) {
    if (Number(match[1]) < 18) return true;
  }
  for (const match of normalizedAges.matchAll(
    /\b(\d{1,2})\s*y\.?\/?o\.?\s+(?:[A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*)?)\b/gu,
  )) {
    if (Number(match[1]) < 18) return true;
  }
  for (const match of normalizedAges.matchAll(
    /\b(\d{1,2})[- ]?years?[- ]?old\s+(?!(?:[\p{L}'’-]+\s+)?(?:company|organization|product|project|program|business|startup|language|repository|website|system|model|paper|conference)\b)(?:[A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*)?)\b/gu,
  )) {
    if (Number(match[1]) < 18) return true;
  }
  for (const match of normalizedAges.matchAll(
    /\b([A-Z][\p{L}'’-]*|he|she|they|this person)\s+(?:is|was|aged)\s+(\d{1,2})[- ]?years?[- ]?old\b/gu,
  )) {
    if (Number(match[2]) < 18 && !NON_PERSON_AGE_SUBJECTS.has(match[1].toLocaleLowerCase("en-US"))) return true;
  }
  for (const match of normalizedAges.matchAll(
    /\b(?:[A-Z][\p{L}'’-]*(?:\s+[A-Z][\p{L}'’-]*)?|[Hh]e|[Ss]he|[Tt]hey|founder|developer|student|researcher|engineer|executive)\s*,?\s+(?:is\s+)?(?:age|aged)\s+(\d{1,2})\b/gu,
  )) {
    if (Number(match[1]) < 18) return true;
  }
  if (
    /\b(?:under[- ]?18|under\s+eighteen)\s+(?:person|founder|developer|student|researcher|engineer|executive)\b/i.test(
      normalizedAges,
    )
  ) {
    return true;
  }
  if (/\b(?:grade[- ]schooler|secondary[- ]school\s+pupil|school\s+pupil)\b/i.test(normalizedAges)) {
    return true;
  }
  for (const match of normalizedAges.matchAll(/\bborn\s+(?:(?:in|on)\s+)?((?:19|20)\d{2})\b/gi)) {
    const year = Number(match[1]);
    if (year <= currentYear && currentYear - year < 18) return true;
  }
  for (const match of normalizedAges.matchAll(/\b(?:dob|date\s+of\s+birth)\s*(?::|=|-|is)?\s*((?:19|20)\d{2})\b/gi)) {
    const year = Number(match[1]);
    if (year <= currentYear && currentYear - year < 18) return true;
  }
  return false;
}

/** Fail-closed final-output policy for content, independent of field names. */
export function containsRestrictedPublicContent(value: string, options: ContentPolicyOptions = {}): boolean {
  const normalizedValue = value.normalize("NFKC");
  const policyText = withoutClearlyProfessionalConceptContext(normalizedValue);
  if (
    RESTRICTED_TEXT_PATTERNS.some((pattern) => pattern.test(policyText)) ||
    STREET_ADDRESS_PATTERN.test(normalizedValue) ||
    CONTEXTUAL_STREET_ADDRESS_PATTERN.test(normalizedValue) ||
    POST_OFFICE_BOX_PATTERN.test(normalizedValue) ||
    containsCredentialLiteral(normalizedValue) ||
    phoneLike(normalizedValue) ||
    minorAgeLike(policyText, options.currentYear ?? new Date().getUTCFullYear()) ||
    restrictedConceptLike(normalizedValue)
  ) {
    return true;
  }
  if (options.allowAnyEmail) return false;
  const allowed = options.allowedEmails ?? new Set<string>();
  return [...normalizedValue.matchAll(EMAIL_PATTERN)].some(
    (match) => !allowed.has(match[0].toLocaleLowerCase("en-US")),
  );
}

export function redactRestrictedPublicContent(value: string, options: ContentPolicyOptions = {}): string {
  return containsRestrictedPublicContent(value, options) ? "[redacted: restricted personal content]" : value;
}

/** Recursively locates restricted strings inside durable arbitrary JSON. */
export function restrictedJsonContentPaths(value: JsonValue, options: ContentPolicyOptions = {}, root = "$"): string[] {
  const paths: string[] = [];
  const visit = (entry: JsonValue, path: string): void => {
    if (isCompactPhoneNumberValue(entry)) {
      paths.push(path);
      return;
    }
    if (typeof entry === "string") {
      if (containsRestrictedPublicContent(entry, options)) paths.push(path);
      return;
    }
    if (Array.isArray(entry)) {
      entry.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (entry === null || typeof entry !== "object") return;
    for (const [key, child] of Object.entries(entry)) {
      if (isRestrictedJsonFieldKey(key)) {
        paths.push(`${path}.${key}`);
        continue;
      }
      visit(child, `${path}.${key}`);
    }
  };
  visit(value, root);
  return paths;
}

import { normalizeWhitespace } from "./runtime";
import {
  SCHEMA_VERSION,
  type InvestigationInput,
  type SafetyDecision,
  type SafetyReason,
  type SafetyReasonCode,
} from "./types";
import { parseInvestigationInput } from "./validation";
import {
  containsRestrictedPublicContent,
  withoutClearlyProfessionalConceptContext,
} from "./content-policy";

interface SafetyRule {
  code: SafetyReasonCode;
  message: string;
  level: "caution" | "block";
  patterns: RegExp[];
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

const RULES: SafetyRule[] = [
  {
    code: "credential_or_financial_data",
    message: "Credentials, government identifiers, or financial account data are out of scope.",
    level: "block",
    patterns: [
      /\b(?:password|passcode|api\s*key|private\s*key|seed\s*phrase|login credentials?)\b/i,
      /\b(?:social security|ssn|bank account|credit card|routing number)\b/i,
      /\b(?:breach data|breached accounts?|credential dumps?|leaked passwords?|data broker lookup)\b/i,
    ],
  },
  {
    code: "illegal_or_violent_intent",
    message: "Requests facilitating violence, coercion, or illegal access are not permitted.",
    level: "block",
    patterns: [
      /\b(?:hurt|attack|kidnap|swat|blackmail|extort)\b/i,
      /\b(?:hack|break into|bypass authentication|steal identity)\b/i,
    ],
  },
  {
    code: "targeting_or_harassment",
    message: "Targeted tracking, intimidation, and harassment are not permitted.",
    level: "block",
    patterns: [
      /\b(?:stalk|harass|intimidate|doxx?|ruin their life)\b/i,
      /\b(?:track|follow)\s+(?:him|her|them|this person)\b/i,
    ],
  },
  {
    code: "precise_location_or_contact",
    message: "Private contact details and precise real-world location are out of scope.",
    level: "block",
    patterns: [
      /\b(?:home|residential|private)\s+(?:address|phone|email|location)\b/i,
      /\b(?:find|get|lookup|locate|reveal|give me)\b.{0,24}\b(?:phone number|mobile number|cell number)\b/i,
      /\b(?:phone|mobile|cell)\s+number\b/i,
      /\btelephone\s+number\b/i,
      /\b(?:find|get|lookup|locate|reveal|discover|give me|what is)\b.{0,48}\b(?:work|business|personal|private)?\s*e-?mail(?: address)?\b/i,
      /\b(?:generate|guess|infer|enumerate|derive)\b.{0,36}\be-?mails?\b/i,
      /\b(?:find|get|lookup|locate|reveal|give me)\b.{0,32}\b(?:home|residential|street)?\s*address\b/i,
      /\b(?:current|live|real[- ]?time)\s+(?:location|coordinates)\b/i,
      /\bwhere\s+(?:does|is)\s+(?:he|she|they|this person)\s+(?:live|right now)\b/i,
      /\b(?:find|tell|show|determine|discover)\b.{0,30}\bwhere\b.{0,40}\blives?\b/i,
      /\b(?:what|where)\b.{0,40}\b(?:residence|residential location|whereabouts)\b/i,
      /\b(?:place|location)\s+of\s+residence\b/i,
      /\bwhere\b.{0,48}\b(?:reside|resides|residing)\b/i,
      /\bhow\s+(?:can|do)\s+i\s+(?:call|contact|reach)\b/i,
      /\bhow\s+(?:can|do)\s+i\s+ring\b/i,
      /\b(?:get|find|reveal|lookup)\b.{0,30}\b(?:contact number|direct number)\b/i,
      /\b(?:property\s+(?:lookup|owner|ownership|records?)|property[- ]tax[- ]assessor|tax[- ]assessor)\b/i,
    ],
  },
  {
    code: "family_or_relationship_mapping",
    message: "Mapping private family or intimate relationships is out of scope.",
    level: "block",
    patterns: [
      /\b(?:find|identify|map|list|research|investigate)\b.{0,32}\b(?:spouse|partner|children|kids|parents|siblings|relatives|family members?)\b/i,
      /\b(?:dating|romantic|intimate)\s+(?:history|relationship|partner)\b/i,
      /\b(?:family tree|family relationships?|relationship map|spouse and children)\b/i,
      /\bwho\b.{0,36}\b(?:is|was)\b.{0,24}\bmarried to\b/i,
      /\b(?:husband|wife|spouse)\b.{0,20}\b(?:and|with)\b.{0,20}\b(?:kids|children)\b/i,
      /\b(?:does|do)\b.{0,32}\b(?:have|has)\b.{0,18}\b(?:husband|wife|spouse|children|kids|parents?)\b/i,
      /\b(?:is|was)\b.{0,32}\bmarried\b/i,
      /\bwho\s+(?:are|were)\b.{0,32}\b(?:parents?|children|kids|spouse)\b/i,
    ],
  },
  {
    code: "contact_automation",
    message: "Automated contact, outreach, or targeting is outside this research-only system.",
    level: "block",
    patterns: [
      /\b(?:automate|bulk|mass)\b.{0,24}\b(?:contact|outreach|email|message|call)\b/i,
      /\b(?:email|message|call|contact)\s+(?:them|him|her|everyone|all of them)\b/i,
      /\b(?:build|create|generate)\b.{0,24}\b(?:contact|outreach|prospect)\s+list\b/i,
    ],
  },
  {
    code: "high_impact_decision",
    message: "People intelligence must not drive adverse or high-impact eligibility decisions.",
    level: "block",
    patterns: [
      /\b(?:screen|rank|reject|deny|disqualify|decide|determine eligibility)\b.{0,40}\b(?:job|employment|candidate|credit|loan|insurance|housing|tenant|admission)\b/i,
      /\b(?:background check|employment screening|tenant screening|creditworthiness|insurance risk)\b/i,
      /\b(?:should (?:we|i) hire|should be fired|deny (?:them|him|her))\b/i,
      /\b(?:investigate|research|profile|check)\b.{0,40}\bbefore\b.{0,24}\b(?:employ|hire|recruit)\b/i,
      /\b(?:good|bad)\s+fit\b.{0,32}\b(?:job|role|opening|position|team)\b/i,
    ],
  },
  {
    code: "minor_or_vulnerable_person",
    message: "Research targeting minors or vulnerable people is not permitted.",
    level: "block",
    patterns: [
      /\b(?:minor|underage|child|schoolchild|teenager)\b/i,
      /\b(?:high[- ]school|middle[- ]school|elementary[- ]school)\s+(?:student|freshman|sophomore|junior|senior)\b/i,
      /\b(?:patient|victim|refugee)\s+(?:address|location|identity|details)\b/i,
    ],
  },
  {
    code: "sensitive_personal_data",
    message: "Sensitive personal traits must not be inferred or compiled.",
    level: "block",
    patterns: [
      /\b(?:medical history|diagnosis|health condition|sexual orientation)\b/i,
      /\b(?:mental health|disability|pregnan(?:t|cy)|medication|treatment|genetic information)\b/i,
      /\b(?:has|had|diagnosed with|suffers? from|treated for)\b.{0,24}\b(?:depression|bipolar|autism|cancer|hiv|aids)\b/i,
      /\b(?:what|find|reveal|calculate|estimate|tell me)\b.{0,48}\b(?:debt|income|salary|compensation|net worth|financial condition|bank balance|credit score)\b/i,
      /\b(?:infer|identify|determine|prove|find|guess)\b.{0,40}\b(?:religion|ethnicity|race|nationality|citizenship|political affiliation|political beliefs|sexual orientation|gender identity|disability)\b/i,
      /\b(?:religion|ethnicity|race|nationality|citizenship|political affiliation|political beliefs|sexual orientation|gender identity|disability)\b.{0,40}\b(?:infer|identify|determine|prove|find|guess)\b/i,
      /\b(?:is|are|whether)\b.{0,20}\b(?:gay|lesbian|bisexual|transgender|disabled|pregnant)\b/i,
      /\b(?:is|are|was|whether)\b.{0,28}\b(?:catholic|orthodox|mormon|atheist|left[- ]wing|right[- ]wing|neurodivergent)\b/i,
      /\bhow much\b.{0,24}\b(?:earn|make|owe)\b/i,
      /\b(?:what|which)\b.{0,36}\b(?:faith|religion|ethnicity|race|political party|politics)\b/i,
      /\b(?:tell|show|explain)\b.{0,32}\b(?:faith|religion|ethnicity|race|politics)\b/i,
      /\b(?:is|was|whether)\b.{0,32}\b(?:muslim|christian|jewish|hindu|buddhist|sikh|asian|black|white|latino|hispanic|democrat|republican)\b/i,
    ],
  },
];

function matchesForRule(text: string, rule: SafetyRule): string[] {
  const matches: string[] = [];
  for (const pattern of rule.patterns) {
    const match = text.match(pattern);
    if (match?.[0]) matches.push(normalizeWhitespace(match[0]).toLocaleLowerCase("en-US"));
  }
  return [...new Set(matches)].sort();
}

function explicitMinorMatches(text: string, currentYear: number): string[] {
  const matches: string[] = [];
  for (const match of text.matchAll(
    /\b(\d{1,2})\s*(?:y\/?o|[- ]?years?[- ]?old)\s+(?:person|founder|developer|student|researcher|engineer|executive|boy|girl|teen(?:ager)?)\b/gi,
  )) {
    const age = Number(match[1]);
    if (Number.isInteger(age) && age >= 0 && age < 18 && match[0]) {
      matches.push(normalizeWhitespace(match[0]).toLocaleLowerCase("en-US"));
    }
  }
  const wordAges: Record<string, number> = {
    zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
    eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
    fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  };
  for (const match of text.matchAll(
    /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)[- ]years?[- ]old\s+(?:person|founder|developer|student|researcher|engineer|executive|boy|girl|teen(?:ager)?)\b/gi,
  )) {
    const age = wordAges[match[1].toLocaleLowerCase("en-US")];
    if (age < 18 && match[0]) matches.push(normalizeWhitespace(match[0]).toLocaleLowerCase("en-US"));
  }
  for (const match of text.matchAll(
    /\b([A-Z][\p{L}'’-]*|he|she|they|this person)\s+(?:is|was|aged)\s+(\d{1,2})[- ]?years?[- ]?old\b/gu,
  )) {
    const subject = match[1].toLocaleLowerCase("en-US");
    const age = Number(match[2]);
    if (
      Number.isInteger(age)
      && age >= 0
      && age < 18
      && !["company", "organization", "product", "project", "program", "business", "startup"].includes(subject)
      && match[0]
    ) {
      matches.push(normalizeWhitespace(match[0]).toLocaleLowerCase("en-US"));
    }
  }
  for (const match of text.matchAll(/\bborn\s+(?:(?:in|on)\s+)?((?:19|20)\d{2})\b/gi)) {
    const year = Number(match[1]);
    const maximumPossibleAge = currentYear - year;
    if (Number.isInteger(year) && maximumPossibleAge >= 0 && maximumPossibleAge < 18 && match[0]) {
      matches.push(normalizeWhitespace(match[0]).toLocaleLowerCase("en-US"));
    }
  }
  return [...new Set(matches)].sort();
}

export interface SafetyClassifierOptions {
  currentYear?: number;
}

/**
 * Conservative, deterministic request gate. Tool adapters must separately
 * enforce source-level policies; this classifier only decides whether a run
 * may begin and constrains every allowed run to public professional material.
 */
export function classifySafety(
  inputValue: InvestigationInput | string,
  options: SafetyClassifierOptions = {},
): SafetyDecision {
  const input = parseInvestigationInput(inputValue);
  const text = boundedDecode(`${input.query} ${input.objective ?? ""}`);
  const policyText = withoutClearlyProfessionalConceptContext(text);
  const reasons: SafetyReason[] = [];

  for (const rule of RULES) {
    const matchedTerms = matchesForRule(policyText, rule);
    if (matchedTerms.length > 0) {
      reasons.push({ code: rule.code, message: rule.message, matchedTerms });
    }
  }

  const currentYear = options.currentYear ?? new Date().getUTCFullYear();
  const minorMatches = explicitMinorMatches(text, currentYear);
  if (
    minorMatches.length > 0
    && !reasons.some((reason) => reason.code === "minor_or_vulnerable_person")
  ) {
    reasons.push({
      code: "minor_or_vulnerable_person",
      message: "Research targeting minors or vulnerable people is not permitted.",
      matchedTerms: minorMatches,
    });
  }

  if (
    containsRestrictedPublicContent(text, {
      allowAnyEmail: true,
      currentYear,
    })
    && reasons.length === 0
  ) {
    reasons.push({
      code: "sensitive_personal_data",
      message: "The request includes personal contact, family, minor, health, or protected-trait content outside public professional scope.",
      matchedTerms: ["restricted personal content"],
    });
  }

  if (reasons.length > 0) {
    return {
      schemaVersion: SCHEMA_VERSION,
      level: "block",
      permittedScope: "none",
      reasons,
      redactions: reasons.flatMap((reason) => reason.matchedTerms),
    };
  }

  const hasEmail = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}\b/i.test(input.query);
  if (hasEmail) {
    return {
      schemaVersion: SCHEMA_VERSION,
      level: "caution",
      permittedScope: "public_professional_only",
      reasons: [
        {
          code: "exact_identifier_supplied",
          message:
            "A user-supplied email may be used only as an exact public-source correlation key.",
          matchedTerms: [],
        },
      ],
      redactions: [],
    };
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    level: "allow",
    permittedScope: "public_professional_only",
    reasons: [
      {
        code: "public_professional_research",
        message: "The request is limited to auditable public professional information.",
        matchedTerms: [],
      },
    ],
    redactions: [],
  };
}

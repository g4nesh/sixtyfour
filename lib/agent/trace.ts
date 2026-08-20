import type { Clock, IdFactory } from "../domain/runtime";
import { cloneJson, isJsonValue } from "../domain/runtime";
import { SCHEMA_VERSION, type JsonObject, type JsonValue, type ResearchPhase } from "../domain/types";
import {
  containsRestrictedPublicContent,
  isCompactPhoneNumberValue,
  redactRestrictedPublicContent,
  type ContentPolicyOptions,
  isRestrictedUrlQueryKey,
  urlContainsRestrictedParameters,
} from "../domain/content-policy";

export type TraceEventKind = "event" | "span_start" | "span_end";
export type TraceStatus = "recorded" | "started" | "succeeded" | "partial" | "failed" | "skipped" | "canceled";
export type TraceSpanStatus = Exclude<TraceStatus, "recorded" | "started">;

/** Normalized on every event; unavailable counters are null, never guessed. */
export interface TraceUsage {
  durationMs: number | null;
  llmCalls: number | null;
  toolCalls: number | null;
  searchCalls: number | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  thinkingTokens: number | null;
  costUsd: number | null;
  networkRequests: number | null;
  bytesRead: number | null;
  unavailableReason: string | null;
}

export type TraceUsageInput = Partial<Omit<TraceUsage, "unavailableReason">> & {
  unavailableReason?: string | null;
};

export interface TraceEventV1 {
  schemaVersion: typeof SCHEMA_VERSION;
  seq: number;
  eventId: string;
  runId: string;
  timestamp: string;
  /** Cumulative monotonic time since recorder construction. */
  elapsedMs: number;
  kind: TraceEventKind;
  name: string;
  phase: ResearchPhase;
  spanId: string | null;
  parentSpanId: string | null;
  attempt: number;
  status: TraceStatus;
  payload: JsonObject;
  usage: TraceUsage;
}

export type TraceEvent = TraceEventV1;

export interface TraceEnvelopeV1 {
  schemaVersion: typeof SCHEMA_VERSION;
  runId: string;
  events: TraceEvent[];
}

export interface TraceEventOptions {
  phase: ResearchPhase;
  payload?: JsonObject;
  parentSpanId?: string | null;
  attempt?: number;
  usage?: TraceUsageInput;
}

export interface TraceSpanOptions extends TraceEventOptions {
  name: string;
}

export interface TraceSpanEndOptions {
  status: TraceSpanStatus;
  payload?: JsonObject;
  usage?: TraceUsageInput;
}

interface OpenSpan {
  spanId: string;
  name: string;
  phase: ResearchPhase;
  parentSpanId: string | null;
  attempt: number;
  startedMonotonicMs: number;
}

const FORBIDDEN_CONTENT_KEYS = new Set([
  "analysis",
  "chainofthought",
  "cot",
  "hiddenreasoning",
  "internalmonologue",
  "reasoning",
  "reasoningcontent",
  "scratchpad",
  "thinking",
  "thinkingcontent",
]);

const SENSITIVE_TRACE_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "apikey",
  "xapikey",
  "xauthtoken",
  "xaccesstoken",
  "xsessiontoken",
  "accesskey",
  "accesstoken",
  "refreshtoken",
  "sessiontoken",
  "bearertoken",
  "token",
  "cookie",
  "setcookie",
  "password",
  "passwd",
  "privatekey",
  "clientsecret",
  "secret",
  "secretkey",
  "credential",
  "credentials",
  "body",
  "requestbody",
  "responsebody",
  "rawbody",
  "fetchedbody",
  "normalizedtext",
  "fulltext",
  "fullhtml",
  "htmlbody",
  "sourcetext",
  "phone",
  "phonenumber",
  "mobile",
  "mobilephone",
  "personalphone",
  "address",
  "homeaddress",
  "residentialaddress",
  "streetaddress",
  "preciselocation",
  "realtimelocation",
]);

const TRACE_KINDS: readonly TraceEventKind[] = ["event", "span_start", "span_end"];
const TRACE_STATUSES: readonly TraceStatus[] = [
  "recorded",
  "started",
  "succeeded",
  "partial",
  "failed",
  "skipped",
  "canceled",
];
const RESEARCH_PHASES: readonly ResearchPhase[] = [
  "intake",
  "classify",
  "plan",
  "discover",
  "separate_candidates",
  "corroborate",
  "calibrate",
  "report",
  "terminal",
];
const TRACE_USAGE_COUNTERS: ReadonlyArray<keyof Omit<TraceUsage, "unavailableReason">> = [
  "durationMs",
  "llmCalls",
  "toolCalls",
  "searchCalls",
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "thinkingTokens",
  "costUsd",
  "networkRequests",
  "bytesRead",
];

function normalizedKey(key: string): string {
  return key.toLocaleLowerCase("en-US").replace(/[^a-z0-9]/g, "");
}

function shouldRemoveTraceKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return FORBIDDEN_CONTENT_KEYS.has(normalized) || SENSITIVE_TRACE_KEYS.has(normalized);
}

const STRUCTURAL_ID_KEYS = new Set([
  "id",
  "runid",
  "eventid",
  "spanid",
  "parentspanid",
  "candidateid",
  "evidenceid",
  "findingid",
  "toolcallid",
  "sourceevidenceid",
]);
const STRUCTURAL_HASH_KEYS = new Set(["fingerprint", "contenthash", "sha"]);
const STRUCTURAL_TIMESTAMP_KEYS = new Set([
  "timestamp",
  "at",
  "createdat",
  "updatedat",
  "retrievedat",
  "observedat",
  "publishedat",
  "generatedat",
]);

const TRACE_URL_KEYS = new Set(["sourceurl", "canonicalurl", "queryurl", "url"]);

function isMachineIdentifier(value: string): boolean {
  return (
    value.length <= 180 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value) &&
    !/^\d{10,15}$/.test(value) &&
    !/^\d{2,4}(?:-\d{2,4}){2,4}$/.test(value) &&
    !/(?:^|[_:.-])\d{3}-\d{3}-\d{4}(?:$|[_:.-])/.test(value)
  );
}

function isCanonicalTimestamp(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const instant = new Date(value);
  return !Number.isNaN(instant.valueOf()) && instant.toISOString() === value;
}

function isTraceName(value: string): boolean {
  return value.length > 0 && value.length <= 160 && /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/.test(value);
}

function isStructuralHash(value: string): boolean {
  return /^(?:(?:sha(?:1|256|384|512):)?[a-f0-9]{8,128}|fnv1a32:[a-f0-9]{8})$/i.test(value);
}

function structuralTraceStringIsValid(key: string | undefined, value: string): boolean {
  if (!key) return true;
  const normalized = normalizedKey(key);
  if (STRUCTURAL_ID_KEYS.has(normalized)) return isMachineIdentifier(value);
  if (STRUCTURAL_HASH_KEYS.has(normalized)) return isStructuralHash(value);
  if (STRUCTURAL_TIMESTAMP_KEYS.has(normalized)) return isCanonicalTimestamp(value);
  return true;
}

function isStructuralTraceStringKey(key: string): boolean {
  const normalized = normalizedKey(key);
  return (
    STRUCTURAL_ID_KEYS.has(normalized) ||
    STRUCTURAL_HASH_KEYS.has(normalized) ||
    STRUCTURAL_TIMESTAMP_KEYS.has(normalized)
  );
}

function isTraceUrlKey(key: string | undefined): boolean {
  return Boolean(key) && TRACE_URL_KEYS.has(normalizedKey(key!));
}

function decodedUrlPrivacyText(value: string): string {
  try {
    const url = new URL(value);
    const path = decodeURIComponent(url.pathname).replaceAll("/", " ");
    return [path, ...[...url.searchParams.entries()].flat()].join(" ");
  } catch {
    return value;
  }
}

function allowedEmailsFromPayload(value: JsonValue): ReadonlySet<string> {
  if (value === null || Array.isArray(value) || typeof value !== "object") return new Set();
  const report = value.report;
  if (report === null || Array.isArray(report) || typeof report !== "object") return new Set();
  const target = report.target;
  if (target === null || Array.isArray(target) || typeof target !== "object") return new Set();
  const identifiers = target.identifiers;
  if (!Array.isArray(identifiers)) return new Set();
  return new Set(
    identifiers.flatMap((identifier) => {
      if (
        identifier === null ||
        Array.isArray(identifier) ||
        typeof identifier !== "object" ||
        identifier.kind !== "email" ||
        identifier.provenance !== "user_input" ||
        typeof identifier.normalizedValue !== "string"
      )
        return [];
      return [identifier.normalizedValue.toLocaleLowerCase("en-US")];
    }),
  );
}

function redactCredentialQueryParams(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return value;
  if (url.username || url.password) return "[redacted: credential URL]";
  let changed = false;
  for (const key of [...url.searchParams.keys()]) {
    if (!isRestrictedUrlQueryKey(key)) continue;
    url.searchParams.delete(key);
    changed = true;
  }
  // Direct sensitive parameters can be removed while preserving ordinary
  // provenance such as `q=public`. Nested redirect values and OAuth fragments
  // are not safely reconstructible, so those URLs remain fully redacted.
  if (urlContainsRestrictedParameters(url.toString())) {
    return "[redacted: credential URL]";
  }
  return changed ? url.toString() : value;
}

function containsForbiddenContentKey(value: JsonValue, key?: string, options: ContentPolicyOptions = {}): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => containsForbiddenContentKey(item, key, options));
  }
  if (isCompactPhoneNumberValue(value)) return true;
  if (typeof value === "string") {
    const urlRedacted = redactCredentialQueryParams(value);
    if (urlRedacted !== value) return true;
    const privacyText = isTraceUrlKey(key) ? decodedUrlPrivacyText(value) : value;
    return containsRestrictedPublicContent(privacyText, options) || !structuralTraceStringIsValid(key, value);
  }
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, child]) => shouldRemoveTraceKey(key) || containsForbiddenContentKey(child, key, options),
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNullableCounter(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function isTraceUsage(value: unknown): value is TraceUsage {
  if (value === null || Array.isArray(value) || typeof value !== "object") return false;
  const usage = value as Record<string, unknown>;
  if (!TRACE_USAGE_COUNTERS.every((key) => isNullableCounter(usage[key]))) return false;
  if (!(
    usage.unavailableReason === null ||
    (isNonEmptyString(usage.unavailableReason) &&
      usage.unavailableReason.length <= 500 &&
      !containsRestrictedPublicContent(usage.unavailableReason))
  ))
    return false;
  const hasUnavailable = TRACE_USAGE_COUNTERS.some((key) => usage[key] === null);
  return !hasUnavailable || isNonEmptyString(usage.unavailableReason);
}

/**
 * Defense in depth against accidental chain-of-thought persistence. Numeric
 * `thinkingTokens` telemetry is kept; hidden content fields are removed
 * recursively before an event can enter the append-only log.
 */
function sanitizeTraceValueInternal(value: JsonValue, options: ContentPolicyOptions, key?: string): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeTraceValueInternal(item, options, key));
  }
  if (isCompactPhoneNumberValue(value)) {
    return "[redacted: restricted personal content]";
  }
  if (typeof value === "string") {
    const urlRedacted = redactCredentialQueryParams(value);
    if (isTraceUrlKey(key) && containsRestrictedPublicContent(decodedUrlPrivacyText(urlRedacted), options)) {
      return "[redacted: restricted personal content]";
    }
    return redactRestrictedPublicContent(urlRedacted, options);
  }
  if (value !== null && typeof value === "object") {
    const result: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
      if (shouldRemoveTraceKey(key)) continue;
      if (typeof child === "string" && isStructuralTraceStringKey(key) && !structuralTraceStringIsValid(key, child))
        continue;
      result[key] = sanitizeTraceValueInternal(child, options, key);
    }
    return result;
  }
  return value;
}

export function sanitizeTraceValue(value: JsonValue, options: ContentPolicyOptions = {}): JsonValue {
  return sanitizeTraceValueInternal(value, options);
}

function mergedContentPolicyOptions(value: JsonObject, options: ContentPolicyOptions): ContentPolicyOptions {
  return {
    ...options,
    // A caller-supplied set is authoritative. Report-shaped hostile payloads
    // must never be able to self-authorize an arbitrary email address.
    allowedEmails: options.allowedEmails ?? allowedEmailsFromPayload(value),
  };
}

function sanitizePayload(value: JsonObject | undefined, options: ContentPolicyOptions = {}): JsonObject {
  if (!value) return {};
  if (!isJsonValue(value)) throw new TypeError("trace payload must be JSON serializable");
  return sanitizeTraceValue(value, mergedContentPolicyOptions(value, options)) as JsonObject;
}

function nullableCounter(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function normalizeUsage(value: TraceUsageInput | undefined): TraceUsage {
  const usage: TraceUsage = {
    durationMs: nullableCounter(value?.durationMs),
    llmCalls: nullableCounter(value?.llmCalls),
    toolCalls: nullableCounter(value?.toolCalls),
    searchCalls: nullableCounter(value?.searchCalls),
    inputTokens: nullableCounter(value?.inputTokens),
    cachedInputTokens: nullableCounter(value?.cachedInputTokens),
    outputTokens: nullableCounter(value?.outputTokens),
    thinkingTokens: nullableCounter(value?.thinkingTokens),
    costUsd: nullableCounter(value?.costUsd),
    networkRequests: nullableCounter(value?.networkRequests),
    bytesRead: nullableCounter(value?.bytesRead),
    unavailableReason: value?.unavailableReason ?? null,
  };
  const hasUnavailable = Object.entries(usage).some(([key, entry]) => key !== "unavailableReason" && entry === null);
  if (hasUnavailable && !usage.unavailableReason) usage.unavailableReason = "not_reported";
  return usage;
}

function validAttempt(attempt: number | undefined): number {
  const value = attempt ?? 1;
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError("trace attempt must be a positive integer");
  }
  return value;
}

export function isTraceEvent(value: unknown, options: ContentPolicyOptions = {}): value is TraceEvent {
  if (!isJsonValue(value) || value === null || Array.isArray(value) || typeof value !== "object") {
    return false;
  }
  const event = value as unknown as Record<string, unknown>;
  if (!(
    event.schemaVersion === SCHEMA_VERSION &&
    typeof event.seq === "number" &&
    Number.isInteger(event.seq) &&
    event.seq > 0 &&
    isNonEmptyString(event.eventId) &&
    isMachineIdentifier(event.eventId) &&
    isNonEmptyString(event.runId) &&
    isMachineIdentifier(event.runId) &&
    isNonEmptyString(event.timestamp) &&
    isCanonicalTimestamp(event.timestamp) &&
    typeof event.elapsedMs === "number" &&
    Number.isFinite(event.elapsedMs) &&
    event.elapsedMs >= 0 &&
    TRACE_KINDS.includes(event.kind as TraceEventKind) &&
    isNonEmptyString(event.name) &&
    isTraceName(event.name) &&
    RESEARCH_PHASES.includes(event.phase as ResearchPhase) &&
    (event.spanId === null || (isNonEmptyString(event.spanId) && isMachineIdentifier(event.spanId))) &&
    (event.parentSpanId === null ||
      (isNonEmptyString(event.parentSpanId) && isMachineIdentifier(event.parentSpanId))) &&
    typeof event.attempt === "number" &&
    Number.isInteger(event.attempt) &&
    event.attempt > 0 &&
    TRACE_STATUSES.includes(event.status as TraceStatus) &&
    event.payload !== null &&
    !Array.isArray(event.payload) &&
    typeof event.payload === "object" &&
    isTraceUsage(event.usage)
  )) {
    return false;
  }

  const kind = event.kind as TraceEventKind;
  const status = event.status as TraceStatus;
  if (kind === "event" && event.spanId !== null) return false;
  if (kind === "span_start" && (!isNonEmptyString(event.spanId) || status !== "started")) return false;
  if (kind === "span_end" && (!isNonEmptyString(event.spanId) || status === "started" || status === "recorded")) {
    return false;
  }
  if (event.spanId !== null && event.spanId === event.parentSpanId) return false;
  const payload = event.payload as JsonObject;
  return !containsForbiddenContentKey(payload, undefined, mergedContentPolicyOptions(payload, options));
}

export class TraceRecorder {
  readonly runId: string;
  readonly #clock: Clock;
  readonly #ids: IdFactory;
  readonly #startedMonotonicMs: number;
  readonly #events: TraceEvent[] = [];
  readonly #openSpans = new Map<string, OpenSpan>();
  readonly #contentPolicyOptions: ContentPolicyOptions;

  constructor(runId: string, clock: Clock, ids: IdFactory, contentPolicyOptions: ContentPolicyOptions = {}) {
    if (!isMachineIdentifier(runId)) throw new TypeError("runId must be a safe machine identifier");
    this.runId = runId;
    this.#clock = clock;
    this.#ids = ids;
    this.#contentPolicyOptions = contentPolicyOptions;
    this.#startedMonotonicMs = clock.monotonicMs();
  }

  #append(
    event: Omit<TraceEvent, "schemaVersion" | "seq" | "eventId" | "runId" | "timestamp" | "elapsedMs">,
  ): TraceEvent {
    const eventId = this.#ids.next("event");
    const timestamp = this.#clock.now();
    if (!isMachineIdentifier(eventId)) throw new TypeError("trace eventId must be a safe machine identifier");
    if (!isCanonicalTimestamp(timestamp)) throw new TypeError("trace clock must return a canonical timestamp");
    const complete: TraceEvent = {
      schemaVersion: SCHEMA_VERSION,
      seq: this.#events.length + 1,
      eventId,
      runId: this.runId,
      timestamp,
      elapsedMs: Math.max(0, Math.round(this.#clock.monotonicMs() - this.#startedMonotonicMs)),
      ...event,
      payload: sanitizePayload(event.payload, this.#contentPolicyOptions),
      usage: normalizeUsage(event.usage),
    };
    if (!isTraceEvent(complete, this.#contentPolicyOptions)) {
      throw new TypeError("trace recorder produced an invalid event");
    }
    this.#events.push(complete);
    return cloneJson(complete);
  }

  record(name: string, options: TraceEventOptions): TraceEvent {
    if (!isTraceName(name)) throw new TypeError("trace event name must be a safe dotted identifier");
    if (options.parentSpanId && !this.#openSpans.has(options.parentSpanId)) {
      throw new Error(`parent span ${options.parentSpanId} is not open`);
    }
    return this.#append({
      kind: "event",
      name,
      phase: options.phase,
      spanId: null,
      parentSpanId: options.parentSpanId ?? null,
      attempt: validAttempt(options.attempt),
      status: "recorded",
      payload: options.payload ?? {},
      usage: normalizeUsage(options.usage),
    });
  }

  startSpan(options: TraceSpanOptions): string {
    if (!isTraceName(options.name)) throw new TypeError("trace span name must be a safe dotted identifier");
    if (options.parentSpanId && !this.#openSpans.has(options.parentSpanId)) {
      throw new Error(`parent span ${options.parentSpanId} is not open`);
    }
    const spanId = this.#ids.next("span");
    if (!isMachineIdentifier(spanId)) throw new TypeError("trace spanId must be a safe machine identifier");
    const attempt = validAttempt(options.attempt);
    this.#openSpans.set(spanId, {
      spanId,
      name: options.name,
      phase: options.phase,
      parentSpanId: options.parentSpanId ?? null,
      attempt,
      startedMonotonicMs: this.#clock.monotonicMs(),
    });
    this.#append({
      kind: "span_start",
      name: options.name,
      phase: options.phase,
      spanId,
      parentSpanId: options.parentSpanId ?? null,
      attempt,
      status: "started",
      payload: options.payload ?? {},
      usage: normalizeUsage(options.usage),
    });
    return spanId;
  }

  endSpan(spanId: string, options: TraceSpanEndOptions): TraceEvent {
    const span = this.#openSpans.get(spanId);
    if (!span) throw new Error(`span ${spanId} is not open`);
    const durationMs = Math.max(0, Math.round(this.#clock.monotonicMs() - span.startedMonotonicMs));
    this.#openSpans.delete(spanId);
    return this.#append({
      kind: "span_end",
      name: span.name,
      phase: span.phase,
      spanId,
      parentSpanId: span.parentSpanId,
      attempt: span.attempt,
      status: options.status,
      payload: options.payload ?? {},
      usage: normalizeUsage({ ...(options.usage ?? {}), durationMs }),
    });
  }

  snapshot(): TraceEvent[] {
    return cloneJson(this.#events);
  }

  eventsSince(seq: number): TraceEvent[] {
    if (!Number.isInteger(seq) || seq < 0) {
      throw new TypeError("trace cursor must be a non-negative integer");
    }
    return cloneJson(this.#events.slice(seq));
  }

  openSpanIds(): string[] {
    return [...this.#openSpans.keys()].sort();
  }

  assertBalanced(): void {
    const open = this.openSpanIds();
    if (open.length > 0) throw new Error(`unclosed trace spans: ${open.join(", ")}`);

    const balances = new Map<string, number>();
    for (const event of this.#events) {
      if (!event.spanId) continue;
      if (event.kind === "span_start") {
        balances.set(event.spanId, (balances.get(event.spanId) ?? 0) + 1);
      }
      if (event.kind === "span_end") {
        balances.set(event.spanId, (balances.get(event.spanId) ?? 0) - 1);
      }
    }
    const unbalanced = [...balances.entries()].filter(([, balance]) => balance !== 0);
    if (unbalanced.length > 0) {
      throw new Error(`unbalanced trace history: ${unbalanced.map(([id]) => id).join(", ")}`);
    }
  }

  toJSON(): TraceEnvelopeV1 {
    return {
      schemaVersion: SCHEMA_VERSION,
      runId: this.runId,
      events: this.snapshot(),
    };
  }
}

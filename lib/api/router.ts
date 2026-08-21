import { InvestigationEngine } from "../agent/engine";
import { isTraceEvent, type TraceEvent, type TraceStatus } from "../agent/trace";
import { classifySafety } from "../domain/safety";
import { evaluateStop } from "../domain/stopping";
import { parseTarget } from "../domain/target";
import { createDeterministicIdFactory, type Clock, type IdFactory } from "../domain/runtime";
import {
  SCHEMA_VERSION,
  type FindingCategory,
  type InvestigationInput,
  type InvestigationReport,
  type JsonObject,
  type ResearchDepth,
  type TerminalStatus,
} from "../domain/types";
import { isInvestigationReport, parseInvestigationInput } from "../domain/validation";
import { streamLiveResearch } from "../live/orchestrator";
import { createDohResolver } from "../tools/doh-resolver";
import { findReplayForQuery, getReplayExample, listReplayExamples } from "../replay/catalog";

export interface ApiEnvironment {
  ATLAS_LIVE_ENABLED?: string;
  /** Bearer token required by non-local live HTTP ingress. Keep server-side. */
  ATLAS_API_TOKEN?: string;
  /** Local development escape hatch. Never enable on public ingress. */
  ATLAS_ALLOW_UNAUTHENTICATED_LOCAL?: string;
  /** Force a provider: "gemini" | "openai" | "openrouter" (otherwise auto-detected). */
  LIVE_PROVIDER?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  OPENAI_SEARCH_MODEL?: string;
  OPENAI_BASE_URL?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_MODEL?: string;
  OPENROUTER_SITE_URL?: string;
  OPENROUTER_APP_NAME?: string;
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MINIMUM_API_TOKEN_BYTES = 32;

function localBypassEnabled(url: URL, environment: ApiEnvironment): boolean {
  return (
    environment.ATLAS_ALLOW_UNAUTHENTICATED_LOCAL?.trim() === "true" && LOCAL_HOSTNAMES.has(url.hostname.toLowerCase())
  );
}

function configuredApiToken(environment: ApiEnvironment): string | null {
  const token = environment.ATLAS_API_TOKEN?.trim();
  if (!token || new TextEncoder().encode(token).byteLength < MINIMUM_API_TOKEN_BYTES) return null;
  return token;
}

function liveIngressConfigured(url: URL, environment: ApiEnvironment): boolean {
  return localBypassEnabled(url, environment) || configuredApiToken(environment) !== null;
}

async function tokensMatch(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let difference = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < Math.max(leftBytes.length, rightBytes.length); index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

async function liveRequestAuthorized(request: Request, url: URL, environment: ApiEnvironment): Promise<boolean> {
  if (localBypassEnabled(url, environment)) return true;
  const expected = configuredApiToken(environment);
  if (!expected) return false;
  const authorization = request.headers.get("authorization")?.trim() ?? "";
  const match = /^Bearer ([^\s]{1,4096})$/i.exec(authorization);
  return Boolean(match && (await tokensMatch(match[1], expected)));
}

interface ResolvedLiveProvider {
  provider: "openai" | "openrouter" | "gemini";
  apiKey: string;
  model: string;
  searchModel?: string;
  endpoint?: string;
  siteUrl?: string;
  appName?: string;
  searchProvider?: "openai";
  searchApiKey?: string;
  searchEndpoint?: string;
}

/**
 * Resolve the live model provider from the environment.
 *
 * Selection: an explicit LIVE_PROVIDER wins; otherwise Gemini is used when its
 * key is present, then OpenAI, then OpenRouter. Health reports only whether a
 * usable server-side configuration exists; it never discloses this selection.
 *
 * Gemini uses its native Google Search grounding path. Keeping reasoning and
 * discovery on the same configured provider avoids turning an unrelated
 * OpenAI quota failure into a fatal Gemini run.
 */
function resolveLiveProvider(environment: ApiEnvironment): ResolvedLiveProvider | null {
  const openaiKey = environment.OPENAI_API_KEY?.trim();
  const geminiKey = environment.GEMINI_API_KEY?.trim();
  const openrouterKey = environment.OPENROUTER_API_KEY?.trim();
  const forced = environment.LIVE_PROVIDER?.trim().toLowerCase();
  const openaiSearchModel = environment.OPENAI_SEARCH_MODEL?.trim() || "gpt-4o-mini";

  const openaiConfig = (): ResolvedLiveProvider | null => {
    if (!openaiKey) return null;
    const base = environment.OPENAI_BASE_URL?.trim();
    return {
      provider: "openai",
      apiKey: openaiKey,
      model: environment.OPENAI_MODEL?.trim() || "gpt-4o-mini",
      searchModel: openaiSearchModel,
      ...(base ? { endpoint: `${base.replace(/\/+$/, "")}/chat/completions` } : {}),
    };
  };

  const geminiConfig = (): ResolvedLiveProvider | null => {
    if (!geminiKey) return null;
    return {
      provider: "gemini",
      apiKey: geminiKey,
      model: environment.GEMINI_MODEL?.trim() || "gemini-3.6-flash",
      endpoint: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    };
  };

  const openrouterConfig = (): ResolvedLiveProvider | null => {
    if (!openrouterKey) return null;
    return {
      provider: "openrouter",
      apiKey: openrouterKey,
      model: environment.OPENROUTER_MODEL?.trim() || "openai/gpt-5.4",
      siteUrl: environment.OPENROUTER_SITE_URL?.trim(),
      appName: environment.OPENROUTER_APP_NAME?.trim(),
    };
  };

  if (forced === "gemini") return geminiConfig() ?? openaiConfig() ?? openrouterConfig();
  if (forced === "openai") return openaiConfig() ?? geminiConfig() ?? openrouterConfig();
  if (forced === "openrouter") return openrouterConfig() ?? openaiConfig() ?? geminiConfig();
  return geminiConfig() ?? openaiConfig() ?? openrouterConfig();
}

const FINDING_CATEGORIES: readonly FindingCategory[] = [
  "identity",
  "employment",
  "education",
  "project",
  "publication",
  "online_presence",
  "timeline",
  "other",
];

interface ResearchRequestBody {
  query: string;
  objective?: string;
  requestedDepth?: ResearchDepth;
  requestedCategories?: FindingCategory[];
  mode: "replay" | "live";
  exampleId?: string;
}

function jsonResponse(value: unknown, status = 200, extraHeaders: HeadersInit = {}): Response {
  return new Response(`${JSON.stringify(value)}\n`, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

function parseResearchBody(value: unknown): ResearchRequestBody {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Request body must be a JSON object.");
  }
  const record = value as Record<string, unknown>;
  const query = typeof record.query === "string" ? record.query.trim() : "";
  if (query.length < 2 || query.length > 1_000) {
    throw new TypeError("query must contain 2–1,000 characters.");
  }
  const mode = record.mode === undefined ? "replay" : record.mode;
  if (mode !== "replay" && mode !== "live") {
    throw new TypeError("mode must be replay or live.");
  }
  const requestedDepth = record.requestedDepth;
  if (requestedDepth !== undefined && !["quick", "standard", "deep"].includes(String(requestedDepth))) {
    throw new TypeError("requestedDepth must be quick, standard, or deep.");
  }
  const objective =
    typeof record.objective === "string" && record.objective.trim()
      ? record.objective.trim().slice(0, 2_000)
      : undefined;
  const exampleId =
    typeof record.exampleId === "string" && record.exampleId.trim() ? record.exampleId.trim() : undefined;
  let requestedCategories: FindingCategory[] | undefined;
  if (record.requestedCategories !== undefined) {
    if (!Array.isArray(record.requestedCategories)) {
      throw new TypeError("requestedCategories must be an array of report categories.");
    }
    const unique = [...new Set(record.requestedCategories)];
    if (
      unique.length === 0 ||
      unique.some((item) => typeof item !== "string" || !FINDING_CATEGORIES.includes(item as FindingCategory))
    ) {
      throw new TypeError(`requestedCategories must contain only: ${FINDING_CATEGORIES.join(", ")}.`);
    }
    requestedCategories = unique as FindingCategory[];
  }
  return {
    query,
    mode,
    ...(objective ? { objective } : {}),
    ...(requestedDepth ? { requestedDepth: requestedDepth as ResearchDepth } : {}),
    ...(requestedCategories ? { requestedCategories } : {}),
    ...(exampleId ? { exampleId } : {}),
  };
}

async function readJsonBody(request: Request): Promise<unknown> {
  const advertised = Number(request.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > 16_384) {
    throw new RangeError("Request body exceeds 16 KiB.");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 16_384) {
    throw new RangeError("Request body exceeds 16 KiB.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new TypeError("Request body must contain valid JSON.");
  }
}

function requestInput(body: ResearchRequestBody): InvestigationInput {
  return parseInvestigationInput({
    schemaVersion: SCHEMA_VERSION,
    query: body.query,
    ...(body.objective ? { objective: body.objective } : {}),
    ...(body.requestedDepth ? { requestedDepth: body.requestedDepth } : {}),
    ...(body.requestedCategories ? { requestedCategories: body.requestedCategories } : {}),
  });
}

function runtimeClock(): Clock {
  const start = performance.now();
  return {
    now: () => new Date().toISOString(),
    monotonicMs: () => performance.now() - start,
  };
}

function runtimeIds(): IdFactory {
  if (typeof crypto?.randomUUID === "function") {
    return { next: (kind) => `${kind}_${crypto.randomUUID()}` };
  }
  return createDeterministicIdFactory(`fallback_${Date.now()}`);
}

export function immediateTerminalTrace(
  input: InvestigationInput,
  status: Extract<TerminalStatus, "blocked" | "configuration_error" | "canceled" | "failed">,
  detail: string,
  dependencies: { clock?: Clock; ids?: IdFactory; runId?: string } = {},
): TraceEvent[] {
  const clock = dependencies.clock ?? runtimeClock();
  const ids = dependencies.ids ?? runtimeIds();
  const engine = new InvestigationEngine(
    input,
    { clock, ids },
    {
      ...(dependencies.runId ? { runId: dependencies.runId } : {}),
    },
  );
  engine.transition("classify");
  if (status === "blocked") {
    engine.stopDecision(evaluateStop(engine.snapshot()), {}, "blocked");
  } else {
    engine.transition("plan");
    engine.setOpenQuestions([detail]);
    engine.stopExternal(
      status === "configuration_error" ? "configuration_error" : status === "canceled" ? "cancelled" : "fatal_error",
      detail,
      status,
    );
  }
  const report = engine.report();
  engine.trace.record("result.terminal", {
    phase: "terminal",
    payload: {
      status: report.status,
      stopReason: report.stop.reason,
      report: report as unknown as JsonObject,
    },
    usage: { unavailableReason: "no_provider_call_was_made" },
  });
  engine.trace.assertBalanced();
  return engine.trace.snapshot();
}

async function* replayEvents(events: readonly TraceEvent[]): AsyncGenerator<TraceEvent> {
  for (const event of events) yield event;
}

interface StreamSpan {
  spanId: string;
  name: string;
  phase: TraceEvent["phase"];
  parentSpanId: string | null;
  attempt: number;
}

function unavailableUsage(reason: string): TraceEvent["usage"] {
  return {
    durationMs: null,
    llmCalls: null,
    toolCalls: null,
    searchCalls: null,
    inputTokens: null,
    outputTokens: null,
    thinkingTokens: null,
    cachedInputTokens: null,
    costUsd: null,
    networkRequests: null,
    bytesRead: null,
    unavailableReason: reason,
  };
}

function fallbackTerminalEvents(
  last: TraceEvent | null,
  openSpans: readonly StreamSpan[],
  input: InvestigationInput,
  canceled: boolean,
): TraceEvent[] {
  const ids = runtimeIds();
  const clock = runtimeClock();
  const runId = last?.runId ?? ids.next("run");
  const status = canceled ? "canceled" : "failed";
  const detail = canceled
    ? "The caller canceled the investigation while the stream was active."
    : "The research stream ended after an internal error.";
  const generated = immediateTerminalTrace(input, status, detail, { clock, ids, runId });
  const generatedTerminal = generated.at(-1);
  if (!generatedTerminal) throw new Error("failed to construct terminal report");

  let sequence = last?.seq ?? 0;
  const elapsedMs = last?.elapsedMs ?? 0;
  const spanStatus: TraceStatus = canceled ? "canceled" : "failed";
  const events: TraceEvent[] = [...openSpans].reverse().map((span) => ({
    schemaVersion: SCHEMA_VERSION,
    seq: ++sequence,
    eventId: ids.next("event"),
    runId,
    timestamp: clock.now(),
    elapsedMs,
    kind: "span_end",
    name: span.name,
    phase: span.phase,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    attempt: span.attempt,
    status: spanStatus,
    payload: { code: canceled ? "stream_canceled" : "stream_failure" },
    usage: unavailableUsage(canceled ? "stream_was_canceled" : "stream_failed_before_usage_was_available"),
  }));
  events.push({
    ...generatedTerminal,
    seq: ++sequence,
    eventId: ids.next("event"),
    runId,
    elapsedMs,
    name: "result.terminal",
    status: spanStatus,
  });
  return events;
}

function reportMatchesRequest(report: InvestigationReport, input: InvestigationInput): boolean {
  if (report.status === "blocked" && classifySafety(input).level === "block") {
    return (
      report.input.query === "[redacted: restricted personal content]" &&
      report.target.rawInput === "[redacted: restricted personal content]"
    );
  }
  const leftCategories = report.input.requestedCategories ?? [];
  const rightCategories = input.requestedCategories ?? [];
  return (
    report.input.schemaVersion === input.schemaVersion &&
    report.input.query === input.query &&
    report.input.objective === input.objective &&
    report.input.requestedDepth === input.requestedDepth &&
    report.input.locale === input.locale &&
    leftCategories.length === rightCategories.length &&
    leftCategories.every((category, index) => category === rightCategories[index]) &&
    JSON.stringify(report.target) === JSON.stringify(parseTarget(input))
  );
}

function preservedTerminalEvents(
  last: TraceEvent | null,
  openSpans: readonly StreamSpan[],
  terminal: TraceEvent,
): TraceEvent[] {
  const ids = runtimeIds();
  const clock = runtimeClock();
  let sequence = last?.seq ?? 0;
  const elapsedMs = Math.max(last?.elapsedMs ?? 0, terminal.elapsedMs);
  const events: TraceEvent[] = [...openSpans].reverse().map((span) => ({
    schemaVersion: SCHEMA_VERSION,
    seq: ++sequence,
    eventId: ids.next("event"),
    runId: terminal.runId,
    timestamp: clock.now(),
    elapsedMs,
    kind: "span_end",
    name: span.name,
    phase: span.phase,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    attempt: span.attempt,
    status: "failed",
    payload: { code: "stream_envelope_failure" },
    usage: unavailableUsage("stream_envelope_failed_after_a_valid_terminal_report"),
  }));
  events.push({
    ...terminal,
    seq: ++sequence,
    eventId: ids.next("event"),
    elapsedMs,
  });
  return events;
}

export function traceNdjsonResponse(
  source: (signal: AbortSignal) => AsyncIterable<TraceEvent>,
  requestSignal: AbortSignal,
  input: InvestigationInput,
): Response {
  const localAbort = new AbortController();
  const combined = AbortSignal.any([requestSignal, localAbort.signal]);
  const encoder = new TextEncoder();
  let last: TraceEvent | null = null;
  let terminalSeen = false;
  let preservedTerminal: TraceEvent | null = null;
  const openSpans = new Map<string, StreamSpan>();
  const allowedEmails = new Set(
    parseTarget(input)
      .identifiers.filter((identifier) => identifier.kind === "email" && identifier.provenance === "user_input")
      .map((identifier) => identifier.normalizedValue),
  );
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of source(combined)) {
          if (!isTraceEvent(event, { allowedEmails })) {
            throw new TypeError("trace source emitted an invalid event");
          }
          if (!last && event.seq !== 1) throw new TypeError("trace source must begin at sequence one");
          if (last && (event.runId !== last.runId || event.seq !== last.seq + 1)) {
            throw new TypeError("trace source violated run or sequence ordering");
          }
          if (event.name === "result.terminal") {
            const report = event.payload.report;
            if (!isInvestigationReport(report) || report.runId !== event.runId) {
              throw new TypeError("terminal event did not contain a valid report for its run");
            }
            if (!reportMatchesRequest(report, input)) {
              throw new TypeError("terminal report did not match the requested investigation input");
            }
            preservedTerminal = event;
          }
          if (event.kind === "span_start" && event.spanId) {
            if (openSpans.has(event.spanId)) throw new TypeError("trace source started a duplicate span");
            openSpans.set(event.spanId, {
              spanId: event.spanId,
              name: event.name,
              phase: event.phase,
              parentSpanId: event.parentSpanId,
              attempt: event.attempt,
            });
          } else if (event.kind === "span_end" && event.spanId) {
            if (!openSpans.delete(event.spanId)) throw new TypeError("trace source ended an unknown span");
          }
          if (event.name === "result.terminal" && openSpans.size > 0) {
            throw new TypeError("trace source reached terminal with open spans");
          }
          last = event;
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          if (event.name === "result.terminal") {
            terminalSeen = true;
            break;
          }
        }
        if (!terminalSeen) throw new Error("trace source ended without a terminal event");
      } catch {
        if (!terminalSeen && !localAbort.signal.aborted) {
          const recovered =
            preservedTerminal && !combined.aborted
              ? preservedTerminalEvents(last, [...openSpans.values()], preservedTerminal)
              : fallbackTerminalEvents(last, [...openSpans.values()], input, combined.aborted);
          for (const event of recovered) {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          }
        }
      } finally {
        try {
          controller.close();
        } catch {
          // The client may have canceled the stream; outbound work is already aborted.
        }
      }
    },
    cancel(reason) {
      localAbort.abort(reason);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function handleApiRequest(request: Request, environment: ApiEnvironment): Promise<Response | null> {
  const url = new URL(request.url);

  if (url.pathname === "/api/health") {
    if (request.method !== "GET") return jsonResponse({ error: "method_not_allowed" }, 405, { allow: "GET" });
    const provider = resolveLiveProvider(environment);
    const liveConfigured =
      environment.ATLAS_LIVE_ENABLED?.trim() === "true" && Boolean(provider) && liveIngressConfigured(url, environment);
    return jsonResponse({
      schemaVersion: SCHEMA_VERSION,
      status: "ok",
      service: "atlas-people-intelligence",
      replayReady: true,
      exampleCount: listReplayExamples().length,
      liveConfigured,
    });
  }

  const exampleMatch = url.pathname.match(/^\/api\/examples\/([^/]+)$/);
  if (exampleMatch) {
    if (request.method !== "GET") return jsonResponse({ error: "method_not_allowed" }, 405, { allow: "GET" });
    let id: string;
    try {
      id = decodeURIComponent(exampleMatch[1]);
    } catch {
      return jsonResponse({ error: "invalid_example_id" }, 400);
    }
    const example = getReplayExample(id);
    if (!example)
      return jsonResponse({ error: "example_not_found", available: listReplayExamples().map((item) => item.id) }, 404);
    return jsonResponse(example);
  }

  if (url.pathname !== "/api/research") return null;
  if (request.method !== "POST") return jsonResponse({ error: "method_not_allowed" }, 405, { allow: "POST" });
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json")
    return jsonResponse({ error: "unsupported_media_type", message: "Use application/json." }, 415);

  let body: ResearchRequestBody;
  let input: InvestigationInput;
  try {
    body = parseResearchBody(await readJsonBody(request));
    input = requestInput(body);
  } catch (error) {
    const tooLarge = error instanceof RangeError;
    return jsonResponse(
      {
        error: tooLarge ? "request_too_large" : "invalid_request",
        message: error instanceof Error ? error.message : "Invalid request.",
      },
      tooLarge ? 413 : 400,
    );
  }

  const safety = classifySafety(input);
  if (safety.level === "block") {
    const events = immediateTerminalTrace(
      input,
      "blocked",
      "The request is outside Atlas's public-professional safety scope.",
    );
    return traceNdjsonResponse(() => replayEvents(events), request.signal, input);
  }
  if (request.signal.aborted) {
    const events = immediateTerminalTrace(input, "canceled", "The caller canceled the investigation before it began.");
    return traceNdjsonResponse(() => replayEvents(events), request.signal, input);
  }

  if (body.mode === "replay") {
    const example = body.exampleId ? getReplayExample(body.exampleId) : findReplayForQuery(body.query);
    if (
      !example ||
      example.input.query.trim().toLocaleLowerCase("en-US") !== body.query.trim().toLocaleLowerCase("en-US")
    ) {
      return jsonResponse(
        {
          error: "replay_not_found",
          message:
            "Replay mode accepts one of the captured example queries. Choose an example or use configured live mode.",
          examples: listReplayExamples(),
        },
        422,
      );
    }
    return traceNdjsonResponse(() => replayEvents(example.trace), request.signal, example.input);
  }

  const liveEnabled = environment.ATLAS_LIVE_ENABLED?.trim() === "true";
  const provider = resolveLiveProvider(environment);
  if (!liveEnabled || !provider || !liveIngressConfigured(url, environment)) {
    const events = immediateTerminalTrace(
      input,
      "configuration_error",
      "Live HTTP research requires explicit enablement, a server-side model key, and protected ingress.",
    );
    return traceNdjsonResponse(() => replayEvents(events), request.signal, input);
  }
  if (!(await liveRequestAuthorized(request, url, environment))) {
    return jsonResponse({ error: "unauthorized", message: "Valid live research authorization is required." }, 401, {
      "www-authenticate": 'Bearer realm="atlas-live"',
    });
  }
  return traceNdjsonResponse(
    (signal) =>
      streamLiveResearch(input, {
        provider: provider.provider,
        apiKey: provider.apiKey,
        model: provider.model,
        ...(provider.searchModel ? { searchModel: provider.searchModel } : {}),
        ...(provider.endpoint ? { endpoint: provider.endpoint } : {}),
        ...(provider.siteUrl ? { siteUrl: provider.siteUrl } : {}),
        ...(provider.appName ? { appName: provider.appName } : {}),
        ...(provider.searchProvider ? { searchProvider: provider.searchProvider } : {}),
        ...(provider.searchApiKey ? { searchApiKey: provider.searchApiKey } : {}),
        ...(provider.searchEndpoint ? { searchEndpoint: provider.searchEndpoint } : {}),
        // Injected DNS validation lets public-source fetches resolve arbitrary
        // hosts while the hardened fetch still rejects private/loopback answers.
        resolveHostname: createDohResolver(),
        signal,
      }),
    request.signal,
    input,
  );
}

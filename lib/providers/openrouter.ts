import { createHardenedFetch, HardenedFetchError } from "../tools/hardened-fetch";
import type { FetchLike } from "../tools/contracts";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface JsonSchema {
  [key: string]: JsonValue | undefined;
}

export interface OpenRouterFunctionTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: JsonSchema;
    strict?: boolean;
  };
}

export interface OpenRouterWebSearchTool {
  type: "openrouter:web_search";
  parameters?: {
    engine?: "auto" | "native" | "exa" | "firecrawl" | "parallel" | "perplexity";
    max_uses?: number;
    max_results?: number;
    max_total_results?: number;
    max_characters?: number;
    search_context_size?: "low" | "medium" | "high";
    allowed_domains?: string[];
    excluded_domains?: string[];
  };
}

export type OpenRouterTool = OpenRouterFunctionTool | OpenRouterWebSearchTool;

export interface OpenRouterToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenRouterAnnotation {
  type: string;
  [key: string]: unknown;
}

export interface OpenRouterMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenRouterToolCall[];
  /** Keep these opaque and pass them back unchanged on the next provider turn. */
  reasoning_details?: readonly unknown[];
  annotations?: OpenRouterAnnotation[];
}

export interface NormalizedUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  reasoningTokens: number | null;
  cachedInputTokens: number | null;
  costUsd: number | null;
}

export interface OpenRouterCompletion {
  id: string | null;
  model: string;
  created: number | null;
  finishReason: string | null;
  message: OpenRouterMessage;
  usage: NormalizedUsage;
  provider: string | null;
  requestId: string | null;
  latencyMs: number;
}

export interface OpenRouterReasoningConfig {
  effort?: "max" | "xhigh" | "high" | "medium" | "low" | "minimal" | "none";
  max_tokens?: number;
  enabled?: boolean;
  exclude?: boolean;
}

export interface CompleteOptions {
  messages: readonly OpenRouterMessage[];
  tools?: readonly OpenRouterTool[];
  webSearch?: false | OpenRouterWebSearchTool["parameters"];
  reasoning?: OpenRouterReasoningConfig;
  maxCompletionTokens?: number;
  temperature?: number;
  /** Defaults false; enable only when the caller will close every returned tool call. */
  parallelToolCalls?: boolean;
  signal?: AbortSignal;
}

export interface OpenRouterSafeLogEvent {
  phase: "request" | "response" | "error";
  model: string;
  status?: number;
  latencyMs?: number;
  messageCount?: number;
  functionToolCount?: number;
  webSearchEnabled?: boolean;
  returnedToolCallCount?: number;
  hasReasoningDetails?: boolean;
  usage?: NormalizedUsage;
  errorCode?: string;
}

export interface OpenRouterClientConfig {
  apiKey: string | undefined;
  model: string;
  endpoint?: string;
  appUrl?: string;
  appTitle?: string;
  fetch?: FetchLike;
  clock?: () => number;
  timeoutMs?: number;
  maxResponseBytes?: number;
  logger?: (event: OpenRouterSafeLogEvent) => void;
  /**
   * "openai" targets the OpenAI chat-completions API directly: web discovery
   * uses OpenAI's native `web_search` tool (which returns url_citation
   * annotations in the same shape) instead of the OpenRouter web_search tool,
   * and OpenRouter-only fields are omitted. "gemini" targets Google's
   * OpenAI-compatibility endpoint for chat/tool-calling and its native
   * Interactions API for Google Search grounding. "anthropic" targets the
   * native Claude Messages API and normalizes its tool-use and citation blocks
   * into this client's provider-neutral completion contract.
   */
  provider?: "openrouter" | "openai" | "gemini" | "anthropic";
  /** Search-preview model used only for the web-discovery turn (OpenAI). */
  searchModel?: string;
  /**
   * Route the web-discovery turn to a different provider than the reasoning
   * turns. Only "openai" (Responses API web_search) is supported. This enables
   * a hybrid run: a high-throughput reasoning model (e.g. Gemini) for the many
   * planner/extraction calls, plus OpenAI's web_search for the few discovery
   * calls.
   */
  searchProvider?: "openai";
  /** API key for the search provider when it differs from the reasoning key. */
  searchApiKey?: string;
  /** Chat-completions endpoint for the search provider (its /responses sibling is derived). */
  searchEndpoint?: string;
}

export class OpenRouterConfigurationError extends Error {
  readonly code = "openrouter_configuration_error";

  constructor(message: string) {
    super(message);
    this.name = "OpenRouterConfigurationError";
  }
}

export class OpenRouterError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly requestId: string | null;
  /** Server-advised wait before retrying (from a Retry-After header), if any. */
  readonly retryAfterMs: number | null;

  constructor(
    code: string,
    message: string,
    options: {
      status?: number | null;
      retryable?: boolean;
      requestId?: string | null;
      cause?: unknown;
      retryAfterMs?: number | null;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OpenRouterError";
    this.code = code;
    this.status = options.status ?? null;
    this.retryable = options.retryable ?? false;
    this.requestId = options.requestId ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) into milliseconds. */
function parseRetryAfterMs(headers: Headers): number | null {
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(600_000, Math.max(0, Math.trunc(seconds * 1_000)));
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) return Math.min(600_000, Math.max(0, dateMs - Date.now()));
  return null;
}

// A rate limit advising a wait longer than this is a sustained quota (e.g. a
// free-tier per-day cap), not a transient per-minute burst. Retrying it cannot
// succeed within a reasonable window and only burns more of the daily quota, so
// such errors are surfaced immediately instead of retried.
const MAX_RETRY_WAIT_MS = 20_000;

/** A delay that rejects promptly if the caller aborts mid-wait. */
function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new OpenRouterError("aborted", "The request was canceled before retry."));
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new OpenRouterError("aborted", "The request was canceled before retry."));
    };
    const timer = setTimeout(
      () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      },
      Math.max(0, ms),
    );
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Retry provider-side rejections (HTTP 429 / 5xx) with capped exponential
 * backoff, honoring a Retry-After header when present. Only errors that carry
 * an HTTP status are retried: an ambiguous network error may already have been
 * processed and billed, so it is surfaced immediately. Rate limits are almost
 * always per-minute, so a short wait lets an otherwise-healthy run continue
 * instead of discarding all the evidence gathered so far.
 */
async function withProviderRetry(
  attempt: () => Promise<OpenRouterCompletion>,
  options: {
    maxAttempts: number;
    signal?: AbortSignal;
    onRetry?: (info: { attempt: number; delayMs: number; status: number | null }) => void;
  },
): Promise<OpenRouterCompletion> {
  let tries = 0;
  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      tries += 1;
      const advised = error instanceof OpenRouterError ? error.retryAfterMs : null;
      const retryable =
        error instanceof OpenRouterError &&
        error.retryable &&
        error.status !== null &&
        // A long advised wait is a sustained/daily quota; failing fast avoids
        // burning more of it on retries that cannot succeed soon.
        (advised === null || advised <= MAX_RETRY_WAIT_MS);
      if (!retryable || tries >= options.maxAttempts || options.signal?.aborted) {
        throw error;
      }
      const backoff = advised ?? Math.min(8_000, 400 * 2 ** (tries - 1));
      const jitter = Math.floor((backoff / 4) * ((Date.now() % 97) / 97));
      const delayMs = backoff + jitter;
      options.onRetry?.({
        attempt: tries,
        delayMs,
        status: error instanceof OpenRouterError ? error.status : null,
      });
      await abortableDelay(delayMs, options.signal);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeNumber(value: unknown, integer = true): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return integer ? Math.trunc(parsed) : parsed;
}

function nestedNumber(record: Record<string, unknown>, path: readonly string[]): number | null {
  let cursor: unknown = record;
  for (const key of path) {
    if (!isRecord(cursor)) return null;
    cursor = cursor[key];
  }
  return safeNumber(cursor);
}

export function normalizeOpenRouterUsage(value: unknown): NormalizedUsage {
  const usage = isRecord(value) ? value : {};
  const inputTokens = safeNumber(usage.prompt_tokens) ?? safeNumber(usage.input_tokens);
  const outputTokens = safeNumber(usage.completion_tokens) ?? safeNumber(usage.output_tokens);
  const explicitTotal = safeNumber(usage.total_tokens);
  const computedTotal = inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null;
  return {
    inputTokens,
    outputTokens,
    totalTokens:
      explicitTotal === null
        ? computedTotal
        : computedTotal === null
          ? explicitTotal
          : Math.max(explicitTotal, computedTotal),
    reasoningTokens:
      safeNumber(usage.reasoning_tokens) ??
      nestedNumber(usage, ["completion_tokens_details", "reasoning_tokens"]) ??
      nestedNumber(usage, ["output_tokens_details", "reasoning_tokens"]),
    cachedInputTokens:
      nestedNumber(usage, ["prompt_tokens_details", "cached_tokens"]) ??
      nestedNumber(usage, ["input_tokens_details", "cached_tokens"]),
    costUsd: safeNumber(usage.cost, false) ?? safeNumber(usage.total_cost, false),
  };
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value as number)));
}

function normalizeDomain(value: string): string {
  const trimmed = value.trim().toLowerCase().replace(/\.$/, "");
  if (!/^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(trimmed)) {
    throw new OpenRouterConfigurationError("Web-search domain filters must contain hostnames only.");
  }
  return trimmed;
}

export function webSearchTool(parameters: OpenRouterWebSearchTool["parameters"] = {}): OpenRouterWebSearchTool {
  if (parameters.allowed_domains?.length && parameters.excluded_domains?.length) {
    throw new OpenRouterConfigurationError("allowed_domains and excluded_domains cannot be combined.");
  }
  const normalized: NonNullable<OpenRouterWebSearchTool["parameters"]> = {
    // An Atlas frontier action owns one bounded query. Prevent the provider's
    // server tool from recursively searching more than once for that action.
    max_uses: boundedInteger(parameters.max_uses, 1, 1, 1),
  };
  if (parameters.engine) normalized.engine = parameters.engine;
  if (parameters.max_results !== undefined) {
    normalized.max_results = boundedInteger(parameters.max_results, 5, 1, 20);
  }
  if (parameters.max_total_results !== undefined) {
    normalized.max_total_results = boundedInteger(parameters.max_total_results, 15, 1, 100);
  }
  if (parameters.max_characters !== undefined) {
    normalized.max_characters = boundedInteger(parameters.max_characters, 5_000, 1, 100_000);
  }
  if (parameters.search_context_size) normalized.search_context_size = parameters.search_context_size;
  if (parameters.allowed_domains?.length) {
    normalized.allowed_domains = [...new Set(parameters.allowed_domains.map(normalizeDomain))];
  }
  if (parameters.excluded_domains?.length) {
    normalized.excluded_domains = [...new Set(parameters.excluded_domains.map(normalizeDomain))];
  }
  return { type: "openrouter:web_search", parameters: normalized };
}

export function functionTool(input: {
  name: string;
  description: string;
  parameters: JsonSchema;
  strict?: boolean;
}): OpenRouterFunctionTool {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(input.name)) {
    throw new OpenRouterConfigurationError("Function tool names must be 1-64 safe identifier characters.");
  }
  if (!input.description.trim()) {
    throw new OpenRouterConfigurationError("Function tools require a description.");
  }
  if (!isRecord(input.parameters)) {
    throw new OpenRouterConfigurationError("Function tool parameters must be a JSON Schema object.");
  }
  return {
    type: "function",
    function: {
      name: input.name,
      description: input.description.trim(),
      parameters: input.parameters,
      ...(input.strict === undefined ? {} : { strict: input.strict }),
    },
  };
}

function validateTools(tools: readonly OpenRouterTool[]): void {
  const names = new Set<string>();
  for (const tool of tools) {
    if (tool.type !== "function") continue;
    if (names.has(tool.function.name)) {
      throw new OpenRouterConfigurationError(`Duplicate function tool name: ${tool.function.name}`);
    }
    names.add(tool.function.name);
  }
}

function normalizeTemperature(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 2) {
    throw new OpenRouterConfigurationError("Temperature must be a finite number between 0 and 2.");
  }
  return value;
}

function requiresDefaultTemperature(provider: OpenRouterClientConfig["provider"], model: string): boolean {
  const openAiReasoningModel = /^(?:gpt-5|o[134])(?:[.-]|$)/i;
  if (provider === "openai") return openAiReasoningModel.test(model);
  if (provider === undefined || provider === "openrouter") {
    return /^openai\//i.test(model) && openAiReasoningModel.test(model.slice("openai/".length));
  }
  return false;
}

function normalizeAnthropicTemperature(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new OpenRouterConfigurationError("Anthropic temperature must be a finite number between 0 and 1.");
  }
  return value;
}

function parseToolCalls(value: unknown): OpenRouterToolCall[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new OpenRouterError("invalid_response", "OpenRouter returned malformed tool calls.");
  return value.map((item) => {
    if (!isRecord(item) || !isRecord(item.function)) {
      throw new OpenRouterError("invalid_response", "OpenRouter returned a malformed tool call.");
    }
    const id = typeof item.id === "string" ? item.id : "";
    const name = typeof item.function.name === "string" ? item.function.name : "";
    const args = typeof item.function.arguments === "string" ? item.function.arguments : "";
    if (!id || !name) throw new OpenRouterError("invalid_response", "OpenRouter returned an incomplete tool call.");
    return { id, type: "function", function: { name, arguments: args } };
  });
}

/**
 * Coerce assistant `content` to `string | null`. OpenAI sends `content: null`
 * on pure tool-call turns; Gemini's OpenAI-compat layer omits the key entirely
 * (undefined); some providers return an array of `{type:"text",text}` parts.
 * All three are normalized here so a tool-only turn is never rejected.
 */
function normalizeAssistantContent(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const text = value.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("");
    return text.length > 0 ? text : null;
  }
  throw new OpenRouterError("invalid_response", "The model provider returned malformed assistant content.");
}

function parseMessage(value: unknown): OpenRouterMessage {
  if (!isRecord(value) || value.role !== "assistant") {
    throw new OpenRouterError("invalid_response", "OpenRouter returned no assistant message.");
  }
  const content = normalizeAssistantContent(value.content);
  const reasoningDetails = value.reasoning_details;
  if (reasoningDetails !== undefined && !Array.isArray(reasoningDetails)) {
    throw new OpenRouterError("invalid_response", "OpenRouter returned malformed reasoning continuation data.");
  }
  const annotations = value.annotations;
  const toolCalls = parseToolCalls(value.tool_calls);
  return {
    role: "assistant",
    content,
    ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }),
    ...(reasoningDetails === undefined ? {} : { reasoning_details: reasoningDetails }),
    ...(Array.isArray(annotations) ? { annotations: annotations.filter(isRecord) as OpenRouterAnnotation[] } : {}),
  };
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function stripTrackingParams(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.searchParams.delete("utm_source");
    url.searchParams.delete("utm_medium");
    url.searchParams.delete("utm_campaign");
    return url.toString();
  } catch {
    return rawUrl;
  }
}

interface OpenAiWebSearchArgs {
  endpoint: URL;
  apiKey: string;
  model: string;
  messages: readonly OpenRouterMessage[];
  maxOutputTokens?: number;
  hardenedFetch: (input: URL, init: RequestInit) => Promise<{ response: Response }>;
  clock: () => number;
  startedAt: number;
  safeLog: (event: OpenRouterSafeLogEvent) => void;
  logBase: { model: string; messageCount: number; functionToolCount: number; webSearchEnabled: boolean };
  signal?: AbortSignal;
}

interface GeminiWebSearchArgs {
  endpoint: URL;
  apiKey: string;
  model: string;
  messages: readonly OpenRouterMessage[];
  hardenedFetch: (input: URL, init: RequestInit) => Promise<{ response: Response }>;
  clock: () => number;
  startedAt: number;
  safeLog: (event: OpenRouterSafeLogEvent) => void;
  logBase: { model: string; messageCount: number; functionToolCount: number; webSearchEnabled: boolean };
  signal?: AbortSignal;
}

/**
 * Native Gemini Google Search grounding through the Interactions API. Gemini
 * returns inline url_citation annotations on model_output blocks; normalize
 * those into the same opaque annotation shape consumed by the orchestrator.
 */
async function completeGeminiWebSearch(args: GeminiWebSearchArgs): Promise<OpenRouterCompletion> {
  const interactionsEndpoint = new URL(args.endpoint.toString());
  interactionsEndpoint.pathname = "/v1beta/interactions";
  interactionsEndpoint.search = "";
  const input = args.messages
    .map((message) => `${message.role.toUpperCase()}: ${typeof message.content === "string" ? message.content : ""}`)
    .join("\n\n");
  let fetched;
  try {
    fetched = await args.hardenedFetch(interactionsEndpoint, {
      method: "POST",
      headers: { "x-goog-api-key": args.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: args.model,
        input,
        tools: [{ type: "google_search" }],
      }),
      signal: args.signal,
    });
  } catch (error) {
    const code = error instanceof HardenedFetchError ? error.code : "network_error";
    args.safeLog({ phase: "error", ...args.logBase, errorCode: code });
    throw new OpenRouterError(code, "The Gemini Google Search request failed before a valid response was received.", {
      retryable: error instanceof HardenedFetchError && error.retryable,
      cause: error,
    });
  }
  const requestId = fetched.response.headers.get("x-request-id") ?? fetched.response.headers.get("x-goog-request-id");
  if (!fetched.response.ok) {
    args.safeLog({ phase: "error", ...args.logBase, status: fetched.response.status, errorCode: "http_error" });
    throw new OpenRouterError(
      "http_error",
      fetched.response.status === 429
        ? "Gemini rate-limited the Google Search request (HTTP 429)."
        : `Gemini Google Search returned HTTP ${fetched.response.status}.`,
      {
        status: fetched.response.status,
        retryable: isRetryableStatus(fetched.response.status),
        requestId,
        retryAfterMs: parseRetryAfterMs(fetched.response.headers),
      },
    );
  }
  let payload: unknown;
  try {
    payload = await fetched.response.json();
  } catch (error) {
    throw new OpenRouterError("invalid_response", "Gemini Google Search returned invalid JSON.", {
      requestId,
      cause: error,
    });
  }
  if (!isRecord(payload)) {
    throw new OpenRouterError("invalid_response", "Gemini Google Search returned no interaction payload.", {
      requestId,
    });
  }
  const steps = Array.isArray(payload.steps) ? payload.steps : [];
  const seen = new Set<string>();
  const annotations: OpenRouterAnnotation[] = [];
  for (const step of steps) {
    if (!isRecord(step) || step.type !== "model_output" || !Array.isArray(step.content)) continue;
    for (const block of step.content) {
      if (!isRecord(block) || !Array.isArray(block.annotations)) continue;
      for (const annotation of block.annotations) {
        if (!isRecord(annotation) || annotation.type !== "url_citation") continue;
        const rawUrl = typeof annotation.url === "string" ? annotation.url : "";
        const url = stripTrackingParams(rawUrl);
        if (!/^https:\/\//i.test(url) || seen.has(url)) continue;
        seen.add(url);
        annotations.push({
          type: "url_citation",
          url_citation: {
            url,
            ...(typeof annotation.title === "string" && annotation.title.trim()
              ? { title: annotation.title.trim() }
              : {}),
          },
        });
      }
    }
  }
  const usageRecord = isRecord(payload.usage)
    ? payload.usage
    : isRecord(payload.usageMetadata)
      ? payload.usageMetadata
      : {};
  const inputTokens = safeNumber(usageRecord.input_tokens) ?? safeNumber(usageRecord.promptTokenCount);
  const outputTokens = safeNumber(usageRecord.output_tokens) ?? safeNumber(usageRecord.candidatesTokenCount);
  const explicitTotal = safeNumber(usageRecord.total_tokens) ?? safeNumber(usageRecord.totalTokenCount);
  const usage: NormalizedUsage = {
    inputTokens,
    outputTokens,
    totalTokens: explicitTotal ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null),
    reasoningTokens: safeNumber(usageRecord.thoughtsTokenCount),
    cachedInputTokens: safeNumber(usageRecord.cachedContentTokenCount),
    costUsd: null,
  };
  const latencyMs = Math.max(0, args.clock() - args.startedAt);
  args.safeLog({ phase: "response", ...args.logBase, status: fetched.response.status, latencyMs, usage });
  return {
    id: typeof payload.id === "string" ? payload.id : null,
    model: typeof payload.model === "string" ? payload.model : args.model,
    created: null,
    finishReason: "stop",
    message: { role: "assistant", content: null, annotations },
    usage,
    provider: "gemini:google_search",
    requestId,
    latencyMs,
  };
}

/**
 * Web discovery via the OpenAI Responses API. Returns a chat-shaped completion
 * whose `message.annotations` carry the server-attested search-result URLs
 * (`web_search_call.action.sources` plus inline `url_citation`s), so the
 * orchestrator's existing citation trust boundary applies unchanged.
 */
async function completeOpenAiWebSearch(args: OpenAiWebSearchArgs): Promise<OpenRouterCompletion> {
  const responsesEndpoint = new URL(args.endpoint.toString());
  responsesEndpoint.pathname = responsesEndpoint.pathname.replace(/\/chat\/completions\/?$/, "/responses");
  if (!responsesEndpoint.pathname.endsWith("/responses")) {
    responsesEndpoint.pathname = "/v1/responses";
  }
  const input = args.messages.map((message) => ({
    role: message.role === "assistant" ? "assistant" : message.role === "system" ? "system" : "user",
    content: typeof message.content === "string" ? message.content : "",
  }));
  const body = {
    model: args.model,
    tools: [{ type: "web_search" }],
    tool_choice: { type: "web_search" },
    include: ["web_search_call.action.sources"],
    input,
    ...(args.maxOutputTokens === undefined
      ? {}
      : { max_output_tokens: boundedInteger(args.maxOutputTokens, 900, 16, 4_000) }),
  };
  let fetched;
  try {
    fetched = await args.hardenedFetch(responsesEndpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${args.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: args.signal,
    });
  } catch (error) {
    const code = error instanceof HardenedFetchError ? error.code : "network_error";
    args.safeLog({ phase: "error", ...args.logBase, errorCode: code });
    throw new OpenRouterError(code, "The web-search request failed before a valid response was received.", {
      retryable: error instanceof HardenedFetchError && error.retryable,
      cause: error,
    });
  }
  const requestId = fetched.response.headers.get("x-request-id");
  if (!fetched.response.ok) {
    args.safeLog({ phase: "error", ...args.logBase, status: fetched.response.status, errorCode: "http_error" });
    throw new OpenRouterError(
      "http_error",
      fetched.response.status === 429
        ? "The model provider rate-limited the web-search request (HTTP 429)."
        : `The web-search provider returned HTTP ${fetched.response.status}.`,
      {
        status: fetched.response.status,
        retryable: isRetryableStatus(fetched.response.status),
        requestId,
        retryAfterMs: parseRetryAfterMs(fetched.response.headers),
      },
    );
  }
  let payload: unknown;
  try {
    payload = await fetched.response.json();
  } catch (error) {
    throw new OpenRouterError("invalid_response", "The web-search provider returned invalid JSON.", {
      requestId,
      cause: error,
    });
  }
  const output = isRecord(payload) && Array.isArray(payload.output) ? payload.output : [];
  const seen = new Set<string>();
  const annotations: OpenRouterAnnotation[] = [];
  const addUrl = (rawUrl: unknown, rawTitle: unknown): void => {
    if (typeof rawUrl !== "string") return;
    const url = stripTrackingParams(rawUrl);
    if (!/^https:\/\//i.test(url) || seen.has(url)) return;
    seen.add(url);
    annotations.push({
      type: "url_citation",
      url_citation: { url, ...(typeof rawTitle === "string" && rawTitle ? { title: rawTitle } : {}) },
    });
  };
  for (const item of output) {
    if (!isRecord(item)) continue;
    if (item.type === "web_search_call") {
      const action = isRecord(item.action) ? item.action : {};
      const sources = Array.isArray(action.sources) ? action.sources : [];
      for (const source of sources) {
        if (typeof source === "string") addUrl(source, undefined);
        else if (isRecord(source)) addUrl(source.url, source.title);
      }
    }
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const content of item.content) {
        if (!isRecord(content) || !Array.isArray(content.annotations)) continue;
        for (const annotation of content.annotations) {
          if (isRecord(annotation) && annotation.type === "url_citation") {
            addUrl(annotation.url, annotation.title);
          }
        }
      }
    }
  }
  const usageRecord = isRecord(payload) && isRecord(payload.usage) ? payload.usage : {};
  const usage: NormalizedUsage = {
    inputTokens: safeNumber(usageRecord.input_tokens),
    outputTokens: safeNumber(usageRecord.output_tokens),
    totalTokens: safeNumber(usageRecord.total_tokens),
    reasoningTokens: null,
    cachedInputTokens: null,
    costUsd: null,
  };
  const latencyMs = Math.max(0, args.clock() - args.startedAt);
  args.safeLog({ phase: "response", ...args.logBase, status: fetched.response.status, latencyMs, usage });
  return {
    id: isRecord(payload) && typeof payload.id === "string" ? payload.id : null,
    model: isRecord(payload) && typeof payload.model === "string" ? payload.model : args.model,
    created: null,
    finishReason: "stop",
    message: { role: "assistant", content: null, annotations },
    usage,
    provider: "openai:web_search",
    requestId,
    latencyMs,
  };
}

type AnthropicInputBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string };

interface AnthropicInputMessage {
  role: "user" | "assistant";
  content: AnthropicInputBlock[];
}

function anthropicInput(messages: readonly OpenRouterMessage[]): {
  system?: string;
  messages: AnthropicInputMessage[];
} {
  const system: string[] = [];
  const converted: AnthropicInputMessage[] = [];
  const append = (role: AnthropicInputMessage["role"], blocks: AnthropicInputBlock[]): void => {
    const previous = converted.at(-1);
    if (previous?.role === role) previous.content.push(...blocks);
    else converted.push({ role, content: [...blocks] });
  };

  for (const message of messages) {
    if (message.role === "system") {
      if (typeof message.content === "string" && message.content.trim()) system.push(message.content);
      continue;
    }
    if (message.role === "tool") {
      if (!message.tool_call_id?.trim()) {
        throw new OpenRouterConfigurationError("Anthropic tool results require the originating tool-use id.");
      }
      append("user", [
        {
          type: "tool_result",
          tool_use_id: message.tool_call_id,
          content: typeof message.content === "string" ? message.content : "",
        },
      ]);
      continue;
    }
    if (message.role === "user") {
      append("user", [{ type: "text", text: typeof message.content === "string" ? message.content : "" }]);
      continue;
    }

    const blocks: AnthropicInputBlock[] = [];
    if (typeof message.content === "string" && message.content) {
      blocks.push({ type: "text", text: message.content });
    }
    for (const call of message.tool_calls ?? []) {
      let input: unknown;
      try {
        input = JSON.parse(call.function.arguments);
      } catch {
        throw new OpenRouterConfigurationError("Anthropic tool-call arguments must contain valid JSON.");
      }
      if (!isRecord(input)) {
        throw new OpenRouterConfigurationError("Anthropic tool-call arguments must be a JSON object.");
      }
      blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input });
    }
    if (blocks.length === 0) blocks.push({ type: "text", text: "" });
    append("assistant", blocks);
  }

  if (converted.length === 0) {
    throw new OpenRouterConfigurationError("Anthropic requests require at least one non-system message.");
  }
  return {
    ...(system.length > 0 ? { system: system.join("\n\n") } : {}),
    messages: converted,
  };
}

function normalizeAnthropicUsage(value: unknown): NormalizedUsage {
  const usage = isRecord(value) ? value : {};
  const uncachedInputTokens = safeNumber(usage.input_tokens);
  const cacheReadInputTokens = safeNumber(usage.cache_read_input_tokens);
  const cacheCreationInputTokens = safeNumber(usage.cache_creation_input_tokens);
  const inputTokens =
    uncachedInputTokens === null
      ? null
      : uncachedInputTokens + (cacheReadInputTokens ?? 0) + (cacheCreationInputTokens ?? 0);
  const outputTokens = safeNumber(usage.output_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
    reasoningTokens: null,
    cachedInputTokens: cacheReadInputTokens,
    costUsd: null,
  };
}

function parseAnthropicMessage(value: unknown): {
  message: OpenRouterMessage;
  annotations: OpenRouterAnnotation[];
} {
  if (!Array.isArray(value)) {
    throw new OpenRouterError("invalid_response", "Anthropic returned malformed message content.");
  }
  const textBlocks: string[] = [];
  const toolCalls: OpenRouterToolCall[] = [];
  const annotations: OpenRouterAnnotation[] = [];
  const seenUrls = new Set<string>();
  const addCitation = (rawUrl: unknown, rawTitle: unknown): void => {
    if (typeof rawUrl !== "string") return;
    const url = stripTrackingParams(rawUrl);
    if (!/^https:\/\//i.test(url) || seenUrls.has(url)) return;
    seenUrls.add(url);
    annotations.push({
      type: "url_citation",
      url_citation: {
        url,
        ...(typeof rawTitle === "string" && rawTitle.trim() ? { title: rawTitle.trim() } : {}),
      },
    });
  };
  const inspectSearchResult = (block: unknown): void => {
    if (!isRecord(block)) return;
    if (block.type === "web_search_result") addCitation(block.url, block.title);
  };

  for (const block of value) {
    if (!isRecord(block)) continue;
    if (block.type === "text") {
      if (typeof block.text === "string") textBlocks.push(block.text);
      if (Array.isArray(block.citations)) {
        for (const citation of block.citations) {
          if (isRecord(citation) && citation.type === "web_search_result_location") {
            addCitation(citation.url, citation.title);
          }
        }
      }
      continue;
    }
    if (block.type === "tool_use") {
      const id = typeof block.id === "string" ? block.id : "";
      const name = typeof block.name === "string" ? block.name : "";
      if (!id || !name || !isRecord(block.input)) {
        throw new OpenRouterError("invalid_response", "Anthropic returned an incomplete tool-use block.");
      }
      toolCalls.push({ id, type: "function", function: { name, arguments: JSON.stringify(block.input) } });
      continue;
    }
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const result of block.content) inspectSearchResult(result);
      continue;
    }
    inspectSearchResult(block);
  }

  return {
    message: {
      role: "assistant",
      content: textBlocks.length > 0 ? textBlocks.join("") : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      ...(annotations.length > 0 ? { annotations } : {}),
    },
    annotations,
  };
}

interface AnthropicCompletionArgs {
  endpoint: URL;
  apiKey: string;
  model: string;
  messages: readonly OpenRouterMessage[];
  tools: readonly OpenRouterTool[];
  webSearch: false | OpenRouterWebSearchTool["parameters"] | undefined;
  maxCompletionTokens?: number;
  temperature?: number;
  hardenedFetch: (input: URL, init: RequestInit) => Promise<{ response: Response }>;
  clock: () => number;
  startedAt: number;
  safeLog: (event: OpenRouterSafeLogEvent) => void;
  logBase: { model: string; messageCount: number; functionToolCount: number; webSearchEnabled: boolean };
  signal?: AbortSignal;
}

async function completeAnthropic(args: AnthropicCompletionArgs): Promise<OpenRouterCompletion> {
  const input = anthropicInput(args.messages);
  const functionTools = args.tools
    .filter((tool): tool is OpenRouterFunctionTool => tool.type === "function")
    .map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: tool.function.parameters,
    }));
  const webSearchRequested = args.webSearch !== false && args.webSearch !== undefined;
  const bodyTools: Array<Record<string, unknown>> = [...functionTools];
  if (webSearchRequested) {
    bodyTools.push({
      type: "web_search_20250305",
      name: "web_search",
      // Each Atlas frontier action already owns one bounded query. Keep the
      // provider-side server tool to a single search invocation as well.
      max_uses: 1,
    });
  }
  const tokenCap = boundedInteger(args.maxCompletionTokens, 4_096, 1, 64_000);
  const body: Record<string, unknown> = {
    model: args.model,
    max_tokens: tokenCap,
    ...input,
    ...(bodyTools.length > 0 ? { tools: bodyTools, tool_choice: { type: "auto" } } : {}),
    ...(args.temperature === undefined ? {} : { temperature: normalizeAnthropicTemperature(args.temperature) }),
  };

  let fetched;
  try {
    fetched = await args.hardenedFetch(args.endpoint, {
      method: "POST",
      headers: {
        "x-api-key": args.apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: args.signal,
    });
  } catch (error) {
    const latencyMs = Math.max(0, args.clock() - args.startedAt);
    const code = error instanceof HardenedFetchError ? error.code : "network_error";
    args.safeLog({ phase: "error", ...args.logBase, latencyMs, errorCode: code });
    throw new OpenRouterError(code, "The Anthropic request failed before a valid response was received.", {
      retryable: error instanceof HardenedFetchError && error.retryable,
      cause: error,
    });
  }

  const requestId = fetched.response.headers.get("request-id") ?? fetched.response.headers.get("x-request-id");
  if (!fetched.response.ok) {
    const latencyMs = Math.max(0, args.clock() - args.startedAt);
    args.safeLog({
      phase: "error",
      ...args.logBase,
      latencyMs,
      status: fetched.response.status,
      errorCode: "http_error",
    });
    throw new OpenRouterError(
      "http_error",
      fetched.response.status === 429
        ? "Anthropic rate-limited this request (HTTP 429). Wait a moment and try again, or raise the account's rate limit."
        : `Anthropic returned HTTP ${fetched.response.status}.`,
      {
        status: fetched.response.status,
        retryable: isRetryableStatus(fetched.response.status),
        requestId,
        retryAfterMs: parseRetryAfterMs(fetched.response.headers),
      },
    );
  }

  let payload: unknown;
  try {
    payload = await fetched.response.json();
  } catch (error) {
    throw new OpenRouterError("invalid_response", "Anthropic returned invalid JSON.", { requestId, cause: error });
  }
  if (!isRecord(payload) || payload.type !== "message") {
    throw new OpenRouterError("invalid_response", "Anthropic returned no completion message.", { requestId });
  }
  const parsed = parseAnthropicMessage(payload.content);
  const usage = normalizeAnthropicUsage(payload.usage);
  const latencyMs = Math.max(0, args.clock() - args.startedAt);
  args.safeLog({
    phase: "response",
    ...args.logBase,
    status: fetched.response.status,
    latencyMs,
    returnedToolCallCount: parsed.message.tool_calls?.length ?? 0,
    usage,
  });
  return {
    id: typeof payload.id === "string" ? payload.id : null,
    model: typeof payload.model === "string" ? payload.model : args.model,
    created: null,
    finishReason: typeof payload.stop_reason === "string" ? payload.stop_reason : null,
    message: parsed.message,
    usage,
    provider: webSearchRequested ? "anthropic:web_search" : "anthropic",
    requestId,
    latencyMs,
  };
}

export function createOpenRouterClient(config: OpenRouterClientConfig) {
  const apiKey = config.apiKey?.trim();
  if (!apiKey) {
    throw new OpenRouterConfigurationError("A model provider API key is required for live investigations.");
  }
  if (!config.model.trim()) {
    throw new OpenRouterConfigurationError("A model identifier is required.");
  }
  const isOpenAi = config.provider === "openai";
  const isGemini = config.provider === "gemini";
  const isAnthropic = config.provider === "anthropic";
  // Both OpenAI and Gemini speak the OpenAI chat-completions dialect (Bearer
  // auth, strict-schema quirks, no OpenRouter attribution headers).
  const isOpenAiCompat = isOpenAi || isGemini;
  const defaultEndpoint = isOpenAi
    ? "https://api.openai.com/v1/chat/completions"
    : isGemini
      ? "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
      : isAnthropic
        ? "https://api.anthropic.com/v1/messages"
        : "https://openrouter.ai/api/v1/chat/completions";
  let endpoint: URL;
  try {
    endpoint = new URL(config.endpoint ?? defaultEndpoint);
  } catch {
    throw new OpenRouterConfigurationError("The model provider endpoint is invalid.");
  }
  if (endpoint.protocol !== "https:") {
    throw new OpenRouterConfigurationError("The model provider endpoint must use HTTPS.");
  }
  // Web discovery may be delegated to an OpenAI search provider even when the
  // reasoning provider is Gemini/OpenRouter. Resolve its endpoint/key up front
  // so the hardened fetch trusts both hosts.
  const searchDelegated = config.searchProvider === "openai" && !isOpenAi;
  let searchEndpoint = endpoint;
  if (searchDelegated) {
    try {
      searchEndpoint = new URL(config.searchEndpoint ?? "https://api.openai.com/v1/chat/completions");
    } catch {
      throw new OpenRouterConfigurationError("The search provider endpoint is invalid.");
    }
    if (searchEndpoint.protocol !== "https:") {
      throw new OpenRouterConfigurationError("The search provider endpoint must use HTTPS.");
    }
  }
  const searchApiKey = (searchDelegated ? config.searchApiKey?.trim() : undefined) || apiKey;
  const clock = config.clock ?? Date.now;
  const safeLog = (event: OpenRouterSafeLogEvent): void => {
    try {
      config.logger?.(Object.freeze({ ...event }));
    } catch {
      // Observability is non-critical and must never break a provider turn.
    }
  };
  const hardenedFetch = createHardenedFetch({
    allowedHostnames: [...new Set([endpoint.hostname, searchEndpoint.hostname])],
    allowedMethods: ["POST"],
    allowedMimeTypes: ["application/json"],
    timeoutMs: boundedInteger(config.timeoutMs, 60_000, 1_000, 120_000),
    maxBytes: boundedInteger(config.maxResponseBytes, 2_000_000, 1_024, 10_000_000),
    maxRedirects: 0,
    // Retrying a billed completion POST can duplicate cost and side effects.
    maxRetries: 0,
    fetch: config.fetch,
    clock,
  });

  return {
    async complete(options: CompleteOptions): Promise<OpenRouterCompletion> {
      if (options.messages.length === 0) {
        throw new OpenRouterConfigurationError("At least one message is required.");
      }
      const webSearchRequested = options.webSearch !== false && options.webSearch !== undefined;
      // OpenAI discovery (native or delegated) uses the Responses web_search
      // tool; the OpenRouter web_search tool is only for the OpenRouter provider.
      const useOpenAiSearch = webSearchRequested && (isOpenAi || searchDelegated);
      const useGeminiSearch = webSearchRequested && isGemini && !searchDelegated;
      const tools: OpenRouterTool[] = [...(options.tools ?? [])];
      if (!isOpenAiCompat && !isAnthropic && options.webSearch !== false && options.webSearch !== undefined) {
        tools.push(webSearchTool(options.webSearch));
      }
      validateTools(tools);
      const requestModel = useOpenAiSearch ? config.searchModel?.trim() || "gpt-4o-mini" : config.model;
      const logBase = {
        model: requestModel,
        messageCount: options.messages.length,
        functionToolCount: tools.filter((tool) => tool.type === "function").length,
        webSearchEnabled:
          useOpenAiSearch ||
          useGeminiSearch ||
          (isAnthropic && webSearchRequested) ||
          tools.some((tool) => tool.type === "openrouter:web_search"),
      };

      // One provider round-trip. Transient rate limits (429) and 5xx are retried
      // with backoff by withProviderRetry below so a healthy run is not thrown
      // away over a per-minute limit.
      const attempt = async (): Promise<OpenRouterCompletion> => {
        const startedAt = clock();
        safeLog({ phase: "request", ...logBase });

        // OpenAI web discovery uses the Responses API `web_search` tool. Its
        // server-attested `web_search_call.action.sources` and `url_citation`
        // annotations are mapped back into the chat-shaped `message.annotations`
        // the orchestrator already trusts as provider search results.
        if (useOpenAiSearch) {
          return await completeOpenAiWebSearch({
            endpoint: searchEndpoint,
            apiKey: searchApiKey,
            model: requestModel,
            messages: options.messages,
            maxOutputTokens: options.maxCompletionTokens,
            hardenedFetch,
            clock,
            startedAt,
            safeLog,
            logBase,
            signal: options.signal,
          });
        }

        if (useGeminiSearch) {
          return await completeGeminiWebSearch({
            endpoint,
            apiKey,
            model: requestModel,
            messages: options.messages,
            hardenedFetch,
            clock,
            startedAt,
            safeLog,
            logBase,
            signal: options.signal,
          });
        }

        if (isAnthropic) {
          return await completeAnthropic({
            endpoint,
            apiKey,
            model: requestModel,
            messages: options.messages,
            tools,
            webSearch: options.webSearch,
            maxCompletionTokens: options.maxCompletionTokens,
            temperature: options.temperature,
            hardenedFetch,
            clock,
            startedAt,
            safeLog,
            logBase,
            signal: options.signal,
          });
        }

        // OpenAI's strict tool-schema validation requires additionalProperties:false
        // on every nested object; OpenRouter does not. Drop `strict` for OpenAI so
        // the existing lenient schemas are accepted (arguments are still JSON-parsed
        // and validated by the orchestrator).
        const bodyTools: OpenRouterTool[] = isOpenAiCompat
          ? tools.map((tool) =>
              tool.type === "function" ? { ...tool, function: { ...tool.function, strict: false } } : tool,
            )
          : tools;
        const tokenCap =
          options.maxCompletionTokens === undefined
            ? undefined
            : boundedInteger(options.maxCompletionTokens, 4_096, 1, 200_000);
        const body: Record<string, unknown> = {
          model: requestModel,
          messages: options.messages,
          ...(!useOpenAiSearch && bodyTools.length
            ? {
                tools: bodyTools,
                tool_choice: "auto",
                parallel_tool_calls: options.parallelToolCalls ?? false,
              }
            : {}),
          // `max_uses` is forwarded only by some native providers. OpenRouter's
          // top-level budget is the provider-independent hard stop that keeps
          // one Atlas search action to one server-tool call.
          ...(!isOpenAiCompat && bodyTools.some((tool) => tool.type === "openrouter:web_search")
            ? { max_tool_calls: 1 }
            : {}),
          // `reasoning` is an OpenRouter extension; OpenAI/Gemini chat reject it.
          ...(!isOpenAiCompat && options.reasoning ? { reasoning: options.reasoning } : {}),
          // Gemini's OpenAI-compat layer expects `max_tokens`; OpenAI uses `max_completion_tokens`.
          ...(tokenCap === undefined ? {} : isGemini ? { max_tokens: tokenCap } : { max_completion_tokens: tokenCap }),
          // OpenAI GPT-5 and o-series reasoning models only accept their
          // default temperature, including when addressed through OpenRouter's
          // `openai/...` slug namespace.
          ...(options.temperature === undefined ||
          useOpenAiSearch ||
          requiresDefaultTemperature(config.provider, requestModel)
            ? {}
            : { temperature: normalizeTemperature(options.temperature) }),
        };
        let fetched;
        try {
          fetched = await hardenedFetch(endpoint, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              // Attribution headers are OpenRouter-specific.
              ...(!isOpenAiCompat && config.appUrl ? { "HTTP-Referer": config.appUrl } : {}),
              ...(!isOpenAiCompat && config.appTitle ? { "X-Title": config.appTitle } : {}),
            },
            body: JSON.stringify(body),
            signal: options.signal,
          });
        } catch (error) {
          const latencyMs = Math.max(0, clock() - startedAt);
          const code = error instanceof HardenedFetchError ? error.code : "network_error";
          safeLog({ phase: "error", ...logBase, latencyMs, errorCode: code });
          throw new OpenRouterError(code, "The OpenRouter request failed before a valid response was received.", {
            retryable: error instanceof HardenedFetchError && error.retryable,
            cause: error,
          });
        }

        const requestId =
          fetched.response.headers.get("x-request-id") ?? fetched.response.headers.get("x-openrouter-request-id");
        if (!fetched.response.ok) {
          const latencyMs = Math.max(0, clock() - startedAt);
          safeLog({
            phase: "error",
            ...logBase,
            latencyMs,
            status: fetched.response.status,
            errorCode: "http_error",
          });
          // Deliberately do not surface the provider body: it may echo prompt content.
          throw new OpenRouterError(
            "http_error",
            fetched.response.status === 429
              ? "The model provider rate-limited this request (HTTP 429). Wait a moment and try again, or raise the account's rate limit."
              : `The model provider returned HTTP ${fetched.response.status}.`,
            {
              status: fetched.response.status,
              retryable: isRetryableStatus(fetched.response.status),
              requestId,
              retryAfterMs: parseRetryAfterMs(fetched.response.headers),
            },
          );
        }

        let payload: unknown;
        try {
          payload = await fetched.response.json();
        } catch (error) {
          throw new OpenRouterError("invalid_response", "OpenRouter returned invalid JSON.", {
            requestId,
            cause: error,
          });
        }
        if (!isRecord(payload) || !Array.isArray(payload.choices) || !isRecord(payload.choices[0])) {
          throw new OpenRouterError("invalid_response", "OpenRouter returned no completion choice.", { requestId });
        }
        const choice = payload.choices[0];
        const message = parseMessage(choice.message);
        const usage = normalizeOpenRouterUsage(payload.usage);
        const latencyMs = Math.max(0, clock() - startedAt);
        const completion: OpenRouterCompletion = {
          id: typeof payload.id === "string" ? payload.id : null,
          model: typeof payload.model === "string" ? payload.model : config.model,
          created: safeNumber(payload.created),
          finishReason: typeof choice.finish_reason === "string" ? choice.finish_reason : null,
          message,
          usage,
          provider: typeof payload.provider === "string" ? payload.provider : null,
          requestId,
          latencyMs,
        };
        safeLog({
          phase: "response",
          ...logBase,
          status: fetched.response.status,
          latencyMs,
          returnedToolCallCount: message.tool_calls?.length ?? 0,
          hasReasoningDetails: Boolean(message.reasoning_details?.length),
          usage,
        });
        return completion;
      };

      return await withProviderRetry(attempt, {
        // Discovery has a deterministic structured-source fallback upstream.
        // One retry covers short bursts without burning four paid search
        // attempts when an account-level quota is exhausted.
        maxAttempts: webSearchRequested ? 2 : 4,
        signal: options.signal,
        onRetry: ({ attempt: retryNumber, delayMs, status }) =>
          safeLog({
            phase: "error",
            ...logBase,
            status: status ?? undefined,
            errorCode: `retrying_${retryNumber}_in_${delayMs}ms`,
          }),
      });
    },
  };
}

/** Appends the exact opaque assistant continuation that OpenRouter returned. */
export function appendAssistantTurn(
  messages: readonly OpenRouterMessage[],
  completion: Pick<OpenRouterCompletion, "message">,
): OpenRouterMessage[] {
  return [...messages, completion.message];
}

export function toolResultMessage(toolCallId: string, content: JsonValue): OpenRouterMessage {
  if (!toolCallId.trim()) throw new OpenRouterConfigurationError("A tool result requires its call id.");
  return {
    role: "tool",
    tool_call_id: toolCallId,
    content: JSON.stringify(content),
  };
}

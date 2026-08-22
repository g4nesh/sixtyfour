export type RunMode = "replay" | "live";

export interface TraceUsage {
  promptTokens?: number | null;
  completionTokens?: number | null;
  reasoningTokens?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  thinkingTokens?: number | null;
  cachedTokens?: number | null;
  cachedInputTokens?: number | null;
  totalTokens?: number | null;
  costUsd?: number | null;
  elapsedMs?: number | null;
  durationMs?: number | null;
}

export interface TraceEvent {
  seq?: number;
  sequence?: number;
  kind?: string;
  type?: string;
  eventType?: string;
  phase?: string;
  status?: string;
  timestamp?: string;
  elapsedMs?: number | null;
  spanId?: string;
  parentSpanId?: string | null;
  frontierId?: string | null;
  actionId?: string | null;
  attempt?: number;
  tool?: string;
  name?: string;
  decisionSummary?: string | null;
  payload?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
  metrics?: TraceUsage & { durationMs?: number | null };
  usage?: TraceUsage | null;
  report?: Report;
  result?: { report?: Report };
}

export interface TraceDiagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  retryable: boolean;
}

export type SearchTransportOutcome = "attempted" | "returned_leads" | "no_safe_leads" | "no_match" | "unavailable";

export interface SearchTransportAttempt {
  id:
    | "configured_provider"
    | "google_html"
    | "duckduckgo_html"
    | "github_exact_name"
    | "semantic_scholar_author_api"
    | "crossref_author_works_api";
  label: string;
  outcome: SearchTransportOutcome;
}

export function isStructuredSearchTransport(transport: SearchTransportAttempt): boolean {
  return transport.id === "semantic_scholar_author_api" || transport.id === "crossref_author_works_api";
}

export interface Candidate {
  id?: string;
  candidateId?: string;
  name?: string;
  displayName?: string;
  headline?: string;
  affiliation?: string;
  confidenceBand?: string;
  score?:
    | number
    | {
        total?: number;
        matchedSignals?: string[];
        conflictingSignals?: string[];
      };
  selected?: boolean;
  status?: string;
  conflicts?: string[];
  matchedSignals?: string[];
  separationReason?: string;
  signals?: Array<{ kind?: string; value?: string; strength?: string }>;
}

export interface Evidence {
  id?: string;
  evidenceId?: string;
  candidateId?: string;
  title?: string;
  excerpt?: string | null;
  minimalExcerpt?: string | null;
  url?: string;
  canonicalUrl?: string;
  sourceUrl?: string;
  queryUrl?: string | null;
  publisher?: string | null;
  sourceFamily?: string;
  sourceType?: string;
  type?: string;
  verificationMethod?: string;
  temporalStatus?: string;
  observedAt?: string | null;
  retrievedAt?: string;
  contentHash?: string | null;
  spoofable?: boolean;
  status?: string;
  disposition?: string;
  metadata?: Record<string, unknown>;
  canonicalSubset?: Record<string, unknown> | null;
  claim?: string;
  reliability?: number;
  attributes?: Record<string, unknown>;
  source?: {
    url?: string;
    canonicalUrl?: string;
    sourceFamily?: string;
    sourceType?: string;
    title?: string;
    publisher?: string;
    accessedAt?: string;
    publishedAt?: string;
  };
}

export interface Finding {
  id?: string;
  findingId?: string;
  candidateId?: string;
  title: string;
  description?: string;
  summary?: string;
  confidenceBand?: string;
  rationale?: string;
  evidenceIds?: string[];
  counterEvidenceIds?: string[];
  category?: string;
  confidence?: { label?: string; score?: number; appliedCaps?: string[] };
  caveats?: string[];
}

export interface Report {
  schemaVersion?: string | number;
  runId?: string;
  query?: string | { raw?: string; normalized?: string; kind?: string };
  status?: string;
  mode?: RunMode;
  startedAt?: string;
  completedAt?: string;
  generatedAt?: string;
  run?: {
    id?: string;
    query?: string;
    status?: string;
    mode?: RunMode;
    startedAt?: string;
    completedAt?: string;
  };
  input?: {
    query?: string;
    objective?: string;
    requestedDepth?: string;
    requestedCategories?: string[];
  };
  identity?: {
    candidates?: Candidate[];
    selectedCandidate?: Candidate | null;
    runnerUpCandidate?: Candidate | null;
    selectedCandidateId?: string | null;
    runnerUpCandidateId?: string | null;
    runnerUpMargin?: number | null;
    margin?: number | null;
    status?: string;
    rationale?: string;
  };
  candidates?: Candidate[];
  selectedCandidateId?: string | null;
  candidateMargin?: number | null;
  findings?: Finding[];
  evidence?: Evidence[];
  sources?: Evidence[] | Array<Record<string, unknown>>;
  coverage?: Record<string, unknown> | Array<Record<string, unknown>>;
  limitations?: Array<string | { code?: string; message?: string }>;
  telemetry?: {
    elapsedMs?: number | null;
    toolCalls?: number;
    sources?: number;
    candidateCount?: number;
    findingCount?: number;
    usage?: TraceUsage | null;
  };
  usage?: TraceUsage;
  stopReason?: string | { code?: string; detail?: string };
  stop?: string | { code?: string; detail?: string };
  searchGraph?: unknown;
  executionGraph?: unknown;
  graph?: unknown;
  search?: { graph?: unknown };
}

export interface ExamplePayload {
  id?: string;
  input?: { query?: string; target?: string; mode?: RunMode };
  output?: Report;
  report?: Report;
  trace?: TraceEvent[];
  manifest?: { capturedAt?: string; title?: string; description?: string };
}

export type RunStatus = "idle" | "loading" | "running" | "complete" | "error" | "canceled";

export function eventType(event: TraceEvent): string {
  return event.name ?? event.type ?? event.eventType ?? "event";
}

function traceContainer(event: TraceEvent): Record<string, unknown> | undefined {
  return event.payload ?? event.attributes;
}

/** Exact bounded query sent by a search-web span, when that event carries one. */
export function traceSearchQuery(event: TraceEvent): string | null {
  if (eventType(event) !== "tool.search_web") return null;
  const argumentsValue = traceContainer(event)?.arguments;
  if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) return null;
  const query = (argumentsValue as Record<string, unknown>).query;
  if (typeof query !== "string" || !query.trim()) return null;
  return query.trim().slice(0, 500);
}

/** Ordered, de-duplicated search program as it was actually emitted to tool spans. */
export function traceSearchQueries(trace: readonly TraceEvent[]): string[] {
  return [...new Set(trace.map(traceSearchQuery).filter((query): query is string => query !== null))];
}

function transportOutcome(
  codes: ReadonlySet<string>,
  returnedLeads: readonly string[],
  noSafeLeads: readonly string[],
  noMatch: readonly string[],
  unavailable: readonly string[],
  resultReturnedLeads = false,
): SearchTransportOutcome {
  if (resultReturnedLeads || returnedLeads.some((code) => codes.has(code))) return "returned_leads";
  if (unavailable.some((code) => codes.has(code))) return "unavailable";
  if (noMatch.some((code) => codes.has(code))) return "no_match";
  if (noSafeLeads.some((code) => codes.has(code))) return "no_safe_leads";
  return "attempted";
}

function traceSearchResultData(event: TraceEvent): {
  citationCount: number | null;
  provider: string | null;
  status: string | null;
} {
  const container = traceContainer(event);
  const value = container?.data;
  const data = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  const citationCount =
    typeof data?.citationCount === "number" && Number.isSafeInteger(data.citationCount) && data.citationCount >= 0
      ? data.citationCount
      : null;
  const provider =
    typeof data?.provider === "string" && data.provider.trim() ? data.provider.trim().slice(0, 96) : null;
  const resultStatus = container?.resultStatus;
  const status =
    typeof resultStatus === "string" ? resultStatus : typeof event.status === "string" ? event.status : null;
  return { citationCount, provider, status };
}

const FALLBACK_SEARCH_PROVIDERS = new Set([
  "google:html_search",
  "duckduckgo:html_search",
  "github:public_user_search",
  "semanticscholar:academic_graph_api",
  "crossref:rest_api",
]);

function resultReturnedByProvider(trace: readonly TraceEvent[], provider: string | "configured"): boolean {
  return trace.some((event) => {
    if (eventType(event) !== "tool.search_web") return false;
    const result = traceSearchResultData(event);
    if (
      result.citationCount === null ||
      result.citationCount < 1 ||
      !result.provider ||
      !["succeeded", "partial"].includes(result.status ?? "")
    )
      return false;
    return provider === "configured" ? !FALLBACK_SEARCH_PROVIDERS.has(result.provider) : result.provider === provider;
  });
}

/**
 * Transport attempts are intentionally distinct from verified sources. A
 * transport can return discovery leads without any page surviving hardened
 * fetch and evidence admission.
 */
export function traceSearchTransportAttempts(trace: readonly TraceEvent[]): SearchTransportAttempt[] {
  const codes = new Set(trace.flatMap(traceDiagnostics).map((diagnostic) => diagnostic.code));
  const queries = traceSearchQueries(trace);
  const semanticScholarQueryAttempted = queries.some((query) =>
    /(?:^|\s)site:semanticscholar\.org(?:\s|$)/i.test(query),
  );
  const crossrefQueryAttempted = queries.some((query) => /(?:^|\s)site:crossref\.org(?:\s|$)/i.test(query));
  const attempts: SearchTransportAttempt[] = [];
  if (trace.some((event) => eventType(event) === "tool.search_web")) {
    attempts.push({
      id: "configured_provider",
      label: "Configured web-search provider",
      outcome: transportOutcome(
        codes,
        [],
        ["search_provider_sources_not_observed", "search_provider_sources_unqualified"],
        [],
        ["search_provider_quota_exhausted", "search_provider_unavailable", "search_provider_circuit_open"],
        resultReturnedByProvider(trace, "configured"),
      ),
    });
  }
  if (
    [...codes].some((code) => code.startsWith("duckduckgo_")) ||
    resultReturnedByProvider(trace, "duckduckgo:html_search")
  ) {
    attempts.push({
      id: "duckduckgo_html",
      label: "DuckDuckGo HTML fallback",
      outcome: transportOutcome(
        codes,
        ["duckduckgo_html_fallback_used"],
        ["duckduckgo_results_not_observed"],
        [],
        [
          "duckduckgo_html_unavailable",
          "duckduckgo_html_rate_limited",
          "duckduckgo_html_http_error",
          "duckduckgo_html_decode_failed",
          "dns_validation_unavailable",
        ],
        resultReturnedByProvider(trace, "duckduckgo:html_search"),
      ),
    });
  }
  if ([...codes].some((code) => code.startsWith("google_")) || resultReturnedByProvider(trace, "google:html_search")) {
    attempts.push({
      id: "google_html",
      label: "Google HTML fallback",
      outcome: transportOutcome(
        codes,
        ["google_html_fallback_used"],
        ["google_results_not_observed"],
        [],
        [
          "google_html_unavailable",
          "google_html_rate_limited",
          "google_html_http_error",
          "google_html_decode_failed",
          "google_html_challenge_observed",
          "dns_validation_unavailable",
        ],
        resultReturnedByProvider(trace, "google:html_search"),
      ),
    });
  }
  if (
    [...codes].some((code) => code.startsWith("github_public_user_") || code.startsWith("github_exact_name_")) ||
    resultReturnedByProvider(trace, "github:public_user_search")
  ) {
    attempts.push({
      id: "github_exact_name",
      label: "GitHub exact-name fallback",
      outcome: transportOutcome(
        codes,
        ["github_public_user_fallback_used"],
        ["github_exact_name_not_observed"],
        [],
        [
          "github_public_user_unavailable",
          "github_public_user_rate_limited",
          "github_public_user_http_error",
          "github_public_user_invalid_json",
          "github_public_user_invalid_response",
          "github_public_user_budget_exhausted",
        ],
        resultReturnedByProvider(trace, "github:public_user_search"),
      ),
    });
  }
  if (
    semanticScholarQueryAttempted ||
    [...codes].some((code) => code.startsWith("semantic_scholar_")) ||
    resultReturnedByProvider(trace, "semanticscholar:academic_graph_api")
  ) {
    attempts.push({
      id: "semantic_scholar_author_api",
      label: "Semantic Scholar author API",
      outcome: transportOutcome(
        codes,
        ["semantic_scholar_author_api_used"],
        [],
        ["semantic_scholar_exact_name_not_observed"],
        [
          "invalid_semantic_scholar_author_name",
          "semantic_scholar_unavailable",
          "semantic_scholar_rate_limited",
          "semantic_scholar_http_error",
          "semantic_scholar_invalid_json",
          "semantic_scholar_invalid_schema",
          ...(semanticScholarQueryAttempted ? ["dns_validation_unavailable"] : []),
        ],
        resultReturnedByProvider(trace, "semanticscholar:academic_graph_api"),
      ),
    });
  }
  if (
    crossrefQueryAttempted ||
    [...codes].some((code) => code.startsWith("crossref_")) ||
    resultReturnedByProvider(trace, "crossref:rest_api")
  ) {
    attempts.push({
      id: "crossref_author_works_api",
      label: "Crossref works API",
      outcome: transportOutcome(
        codes,
        ["crossref_author_works_api_used"],
        [],
        ["crossref_exact_author_not_observed"],
        [
          "invalid_crossref_author_name",
          "crossref_unavailable",
          "crossref_rate_limited",
          "crossref_http_error",
          "crossref_invalid_json",
          "crossref_invalid_schema",
          ...(crossrefQueryAttempted ? ["dns_validation_unavailable"] : []),
        ],
        resultReturnedByProvider(trace, "crossref:rest_api"),
      ),
    });
  }
  return attempts;
}

/** Read only the bounded, operator-facing diagnostic projection from a trace event. */
export function traceDiagnostics(event: TraceEvent): TraceDiagnostic[] {
  const container = event.payload ?? event.attributes;
  const value = container?.diagnostics;
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const severity = record.severity;
    if (
      typeof record.code !== "string" ||
      typeof record.message !== "string" ||
      !["info", "warning", "error"].includes(String(severity))
    )
      return [];
    return [
      {
        code: record.code,
        severity: severity as TraceDiagnostic["severity"],
        message: record.message,
        retryable: record.retryable === true,
      },
    ];
  });
}

export function humanize(value: string | undefined): string {
  if (!value) return "Update";
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

export function reportQuery(report: Report | null): string {
  if (!report) return "";
  if (typeof report.query === "string") return report.query;
  return report.query?.raw ?? report.query?.normalized ?? report.input?.query ?? report.run?.query ?? "";
}

export function reportCandidates(report: Report | null): Candidate[] {
  const candidates = report?.identity?.candidates ?? report?.candidates;
  if (candidates?.length) return candidates;
  return [report?.identity?.selectedCandidate, report?.identity?.runnerUpCandidate].filter(
    (candidate): candidate is Candidate => Boolean(candidate),
  );
}

export function candidateName(candidate: Candidate): string {
  return candidate.displayName ?? candidate.name ?? "Unknown candidate";
}

export function reportEvidence(report: Report | null): Evidence[] {
  return report?.evidence ?? [];
}

export function selectedCandidate(report: Report | null): Candidate | null {
  if (!report) return null;
  const candidates = reportCandidates(report);
  const selectedId = report.identity?.selectedCandidateId ?? report.selectedCandidateId;
  return (
    candidates.find((candidate) => (candidate.id ?? candidate.candidateId) === selectedId) ??
    report.identity?.selectedCandidate ??
    candidates.find((candidate) => candidate.selected) ??
    null
  );
}

export function limitationText(limitation: string | { code?: string; message?: string }): string {
  if (typeof limitation === "string") return limitation;
  return limitation.message ?? humanize(limitation.code);
}

export function traceUsage(event: TraceEvent | undefined): TraceUsage | null | undefined {
  return event?.usage ?? event?.metrics;
}

export function traceDuration(event: TraceEvent | undefined): number | null | undefined {
  return event?.elapsedMs ?? event?.metrics?.durationMs;
}

export function formatDuration(milliseconds: number | null | undefined): string {
  if (milliseconds == null) return "—";
  if (milliseconds < 1000) return `${milliseconds} ms`;
  return `${(milliseconds / 1000).toFixed(2)} s`;
}

export function totalUsageTokens(usage: TraceUsage | null | undefined): number | null {
  return (
    usage?.totalTokens ??
    (typeof usage?.inputTokens === "number" && typeof usage.outputTokens === "number"
      ? usage.inputTokens + usage.outputTokens
      : null)
  );
}

export function formatUsage(usage: TraceUsage | null | undefined): string {
  const total = totalUsageTokens(usage);
  if (typeof total !== "number") return "Tokens unavailable";
  return `${new Intl.NumberFormat("en", { notation: "compact" }).format(total)} tokens`;
}

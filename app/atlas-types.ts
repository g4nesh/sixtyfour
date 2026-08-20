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

export interface Candidate {
  id?: string;
  candidateId?: string;
  name?: string;
  displayName?: string;
  headline?: string;
  affiliation?: string;
  confidenceBand?: string;
  score?: number | {
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

export type RunStatus =
  | "idle"
  | "loading"
  | "running"
  | "complete"
  | "error"
  | "canceled";

export function eventType(event: TraceEvent): string {
  return event.name ?? event.type ?? event.eventType ?? "event";
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
      typeof record.code !== "string"
      || typeof record.message !== "string"
      || !["info", "warning", "error"].includes(String(severity))
    ) return [];
    return [{
      code: record.code,
      severity: severity as TraceDiagnostic["severity"],
      message: record.message,
      retryable: record.retryable === true,
    }];
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
  return [report?.identity?.selectedCandidate, report?.identity?.runnerUpCandidate]
    .filter((candidate): candidate is Candidate => Boolean(candidate));
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
  return candidates.find((candidate) => (candidate.id ?? candidate.candidateId) === selectedId)
    ?? report.identity?.selectedCandidate
    ?? candidates.find((candidate) => candidate.selected)
    ?? null;
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
  return usage?.totalTokens ?? (
    typeof usage?.inputTokens === "number" && typeof usage.outputTokens === "number"
      ? usage.inputTokens + usage.outputTokens
      : null
  );
}

export function formatUsage(usage: TraceUsage | null | undefined): string {
  const total = totalUsageTokens(usage);
  if (typeof total !== "number") return "Tokens unavailable";
  return `${new Intl.NumberFormat("en", { notation: "compact" }).format(total)} tokens`;
}

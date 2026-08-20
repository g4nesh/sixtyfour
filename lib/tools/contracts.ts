/** Runtime-neutral contracts shared by the public-data adapters. */

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type HostnameResolver = (hostname: string, signal?: AbortSignal) => Promise<readonly string[]>;

export interface ToolBudgetCost {
  tool: string;
  networkRequests: number;
  expectedBytes?: number;
}

export interface ToolContext {
  fetch?: FetchLike;
  /**
   * Runtime-provided DNS lookup used by arbitrary-host fetchers. Fixed-vendor
   * adapters may rely on an exact hostname allowlist; general web fetchers must
   * fail closed when this capability is unavailable.
   */
  resolveHostname?: HostnameResolver;
  /** Epoch milliseconds. Inject this in tests and replay runs. */
  clock?: () => number;
  signal?: AbortSignal;
  /** Return false to decline work without performing the request. */
  consumeBudget?: (cost: ToolBudgetCost) => boolean | Promise<boolean>;
}

export type ToolStatus = "succeeded" | "partial" | "not_found" | "rate_limited" | "failed" | "skipped";

export type DiagnosticSeverity = "info" | "warning" | "error";

export type DiagnosticScalar = string | number | boolean | null;

export interface ToolDiagnostic {
  code: string;
  severity: DiagnosticSeverity;
  /** Sanitized operator-facing text. Never place response bodies or secrets here. */
  message: string;
  retryable: boolean;
  details?: Readonly<Record<string, DiagnosticScalar>>;
}

export interface CandidateLink {
  candidateId: string;
  basis: string;
}

export interface ToolEvidence {
  sourceUrl: string;
  sourceType: string;
  title: string;
  observedAt: string;
  excerpt?: string;
  attributes: Readonly<Record<string, unknown>>;
  candidate?: CandidateLink;
  /** A downstream scorer must not promote this record above this cap alone. */
  confidenceCap?: number;
}

export interface ToolMeta {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  requests: number;
  bytesRead: number;
  incomplete: boolean;
}

export interface ToolResult<T> {
  ok: boolean;
  status: ToolStatus;
  data: T | null;
  evidence: ToolEvidence[];
  diagnostics: ToolDiagnostic[];
  meta: ToolMeta;
}

export function toolClock(context: ToolContext): () => number {
  return context.clock ?? Date.now;
}

export function isoTime(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

export async function reserveToolBudget(context: ToolContext, cost: ToolBudgetCost): Promise<boolean> {
  if (!context.consumeBudget) return true;
  return (await context.consumeBudget(cost)) !== false;
}

export function createToolMeta(
  startedAtMs: number,
  finishedAtMs: number,
  requests: number,
  bytesRead: number,
  incomplete: boolean,
): ToolMeta {
  return {
    startedAt: isoTime(startedAtMs),
    finishedAt: isoTime(finishedAtMs),
    durationMs: Math.max(0, finishedAtMs - startedAtMs),
    requests,
    bytesRead,
    incomplete,
  };
}

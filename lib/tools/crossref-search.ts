import { containsRestrictedPublicContent } from "../domain/content-policy";
import { normalizeComparable, normalizeWhitespace } from "../domain/runtime";
import {
  createToolMeta,
  reserveToolBudget,
  toolClock,
  type ToolContext,
  type ToolDiagnostic,
  type ToolResult,
  type ToolStatus,
} from "./contracts";
import { asHardenedFetchError, createHardenedFetch } from "./hardened-fetch";

const CROSSREF_API_HOST = "api.crossref.org";
const MAX_RESULTS = 3;
const MAX_RESPONSE_BYTES = 384_000;

export interface CrossrefWorkMatch {
  doi: string;
  title: string;
  recordUrl: string;
  attestedAuthorName: string;
}

export interface CrossrefAuthorWorksSearchData {
  exactName: string;
  matches: CrossrefWorkMatch[];
  returnedWorkCount: number;
  totalResultsReported: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finish(
  startedAt: number,
  now: () => number,
  status: ToolStatus,
  data: CrossrefAuthorWorksSearchData | null,
  diagnostics: ToolDiagnostic[],
  requests: number,
  bytesRead: number,
  incomplete: boolean,
): ToolResult<CrossrefAuthorWorksSearchData> {
  return {
    ok: status === "succeeded" || status === "partial" || status === "not_found",
    status,
    data,
    evidence: [],
    diagnostics,
    meta: createToolMeta(startedAt, now(), requests, bytesRead, incomplete),
  };
}

function exactPersonName(value: string): string | null {
  const normalized = normalizeWhitespace(value.normalize("NFKC")).replace(/["“”\\]/gu, "");
  if (!normalized || normalized.length > 160 || containsRestrictedPublicContent(normalized)) return null;
  const words = normalized.split(" ");
  return words.length >= 1 &&
    words.length <= 5 &&
    words.every((word) => /^[\p{L}\p{M}][\p{L}\p{M}'’.-]{0,63}$/u.test(word))
    ? normalized
    : null;
}

function boundedCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeDoi(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const doi = value.trim();
  return doi.length <= 300 && /^10\.\d{4,9}\/[A-Z0-9._;()/:+-]+$/i.test(doi) ? doi : null;
}

function safeTitle(value: unknown): string | null {
  if (!Array.isArray(value) || typeof value[0] !== "string") return null;
  const title = normalizeWhitespace(value[0].normalize("NFKC"));
  return title && title.length <= 500 && !containsRestrictedPublicContent(title) ? title.slice(0, 320) : null;
}

function exactAuthorName(value: unknown, requestedName: string): string | null {
  if (!Array.isArray(value)) return null;
  for (const candidate of value.slice(0, 64)) {
    if (!isRecord(candidate)) continue;
    const literal =
      typeof candidate.name === "string"
        ? candidate.name
        : [candidate.given, candidate.family].filter((part): part is string => typeof part === "string").join(" ");
    const name = exactPersonName(literal);
    if (name && normalizeComparable(name) === normalizeComparable(requestedName)) return name;
  }
  return null;
}

/**
 * Query Crossref's public REST API for a tiny set of works, then retain only
 * rows whose structured author list contains the exact normalized name. The
 * API record URL is discovery-only until Atlas hard-fetches it.
 */
export async function searchCrossrefWorksByExactAuthor(
  nameValue: string,
  context: ToolContext = {},
): Promise<ToolResult<CrossrefAuthorWorksSearchData>> {
  const now = toolClock(context);
  const startedAt = now();
  const exactName = exactPersonName(nameValue);
  if (!exactName) {
    return finish(
      startedAt,
      now,
      "skipped",
      null,
      [
        {
          code: "invalid_crossref_author_name",
          severity: "warning",
          message: "Crossref author search requires one bounded public person name.",
          retryable: false,
        },
      ],
      0,
      0,
      false,
    );
  }
  if (!context.resolveHostname) {
    return finish(
      startedAt,
      now,
      "skipped",
      null,
      [
        {
          code: "dns_validation_unavailable",
          severity: "warning",
          message: "Crossref author search was skipped because DNS answers cannot be validated.",
          retryable: false,
        },
      ],
      0,
      0,
      true,
    );
  }

  const requestUrl = new URL(`https://${CROSSREF_API_HOST}/works`);
  requestUrl.searchParams.set("query.author", exactName);
  requestUrl.searchParams.set("rows", String(MAX_RESULTS));
  requestUrl.searchParams.set("select", "DOI,title,author");
  const searchFetch = createHardenedFetch({
    allowedHostnames: [CROSSREF_API_HOST],
    resolveHostname: context.resolveHostname,
    allowedMethods: ["GET"],
    allowedMimeTypes: ["application/json"],
    timeoutMs: 8_000,
    maxBytes: MAX_RESPONSE_BYTES,
    maxRedirects: 0,
    maxRetries: 1,
    maxRetryAfterMs: 1_000,
    fetch: context.fetch,
    clock: now,
    beforeRequest: () =>
      reserveToolBudget(context, {
        tool: "crossref_author_works_search",
        networkRequests: 1,
        expectedBytes: MAX_RESPONSE_BYTES,
      }),
  });

  let fetched;
  try {
    fetched = await searchFetch(requestUrl, {
      headers: {
        Accept: "application/json",
        "User-Agent": "atlas-people-intelligence/0.1",
      },
      signal: context.signal,
    });
  } catch (error) {
    const hardened = asHardenedFetchError(error);
    const budgetExhausted = hardened?.code === "budget_exhausted";
    return finish(
      startedAt,
      now,
      budgetExhausted ? "skipped" : "failed",
      null,
      [
        {
          code: hardened?.code ?? "crossref_unavailable",
          severity: budgetExhausted || hardened?.code === "aborted" ? "info" : "warning",
          message: budgetExhausted
            ? "Crossref author search stopped at the network-request budget."
            : hardened?.code === "aborted"
              ? "Crossref author search was canceled."
              : "Crossref's public REST API could not be fetched safely.",
          retryable: hardened?.retryable ?? true,
          ...(hardened
            ? { details: { attempt: hardened.attempt, requests: hardened.requests, httpStatus: hardened.status } }
            : {}),
        },
      ],
      hardened?.requests ?? 0,
      0,
      true,
    );
  }

  if (fetched.response.status === 429) {
    return finish(
      startedAt,
      now,
      "rate_limited",
      null,
      [
        {
          code: "crossref_rate_limited",
          severity: "warning",
          message: "Crossref rate-limited its bounded public REST request.",
          retryable: true,
        },
      ],
      fetched.requests,
      fetched.bytesRead,
      true,
    );
  }
  if (!fetched.response.ok) {
    return finish(
      startedAt,
      now,
      "failed",
      null,
      [
        {
          code: "crossref_http_error",
          severity: "warning",
          message: `Crossref author search returned HTTP ${fetched.response.status}.`,
          retryable: fetched.response.status >= 500,
        },
      ],
      fetched.requests,
      fetched.bytesRead,
      true,
    );
  }

  let payload: unknown;
  try {
    payload = await fetched.response.json();
  } catch {
    return finish(
      startedAt,
      now,
      "failed",
      null,
      [
        {
          code: "crossref_invalid_json",
          severity: "warning",
          message: "Crossref returned a response that was not valid JSON.",
          retryable: false,
        },
      ],
      fetched.requests,
      fetched.bytesRead,
      true,
    );
  }
  const message = isRecord(payload) && isRecord(payload.message) ? payload.message : null;
  if (!message || !Array.isArray(message.items)) {
    return finish(
      startedAt,
      now,
      "failed",
      null,
      [
        {
          code: "crossref_invalid_schema",
          severity: "warning",
          message: "Crossref returned an unexpected works-search schema.",
          retryable: false,
        },
      ],
      fetched.requests,
      fetched.bytesRead,
      true,
    );
  }

  const matches: CrossrefWorkMatch[] = [];
  const seen = new Set<string>();
  let excludedRows = 0;
  for (const row of message.items.slice(0, MAX_RESULTS)) {
    if (!isRecord(row)) {
      excludedRows += 1;
      continue;
    }
    const doi = safeDoi(row.DOI);
    const title = safeTitle(row.title);
    const attestedAuthorName = exactAuthorName(row.author, exactName);
    if (!doi || !title || !attestedAuthorName) {
      excludedRows += 1;
      continue;
    }
    const recordUrl = `https://${CROSSREF_API_HOST}/works/${encodeURIComponent(doi)}`;
    // The final report scans the exact durable URL string. Apply that same
    // public-content predicate here, before this structured row can authorize
    // discovery evidence or a graph node. Some syntactically valid DOI suffixes
    // resemble private phone numbers only after they are embedded in the API
    // URL, so validating the DOI alone is insufficient.
    if (containsRestrictedPublicContent(recordUrl)) {
      excludedRows += 1;
      continue;
    }
    if (seen.has(recordUrl)) continue;
    seen.add(recordUrl);
    matches.push({ doi, title, recordUrl, attestedAuthorName });
  }
  const returnedWorkCount = message.items.length;
  const totalResultsReported = boundedCount(message["total-results"]);
  const incomplete = returnedWorkCount > MAX_RESULTS || (totalResultsReported ?? returnedWorkCount) > MAX_RESULTS;
  const resultDiagnostics: ToolDiagnostic[] = [];
  if (excludedRows > 0)
    resultDiagnostics.push({
      code: "crossref_rows_excluded",
      severity: "info",
      message:
        "Crossref rows without an exact structured author, safe DOI, safe title, or safe record URL were excluded.",
      retryable: false,
      details: { count: excludedRows },
    });
  if (matches.length === 0)
    resultDiagnostics.push({
      code: "crossref_exact_author_not_observed",
      severity: "info",
      message:
        "No exact author match was observed in the bounded Crossref rows; this is not evidence that no publication exists.",
      retryable: incomplete,
    });
  const data: CrossrefAuthorWorksSearchData = {
    exactName,
    matches,
    returnedWorkCount,
    totalResultsReported,
  };
  return finish(
    startedAt,
    now,
    matches.length > 0 ? (incomplete ? "partial" : "succeeded") : incomplete ? "partial" : "not_found",
    data,
    resultDiagnostics,
    fetched.requests,
    fetched.bytesRead,
    incomplete,
  );
}

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

const SEMANTIC_SCHOLAR_API_HOST = "api.semanticscholar.org";
const MAX_RESULTS = 3;
const MAX_RESPONSE_BYTES = 256_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface SemanticScholarAuthorMatch {
  authorId: string;
  name: string;
  profileUrl: string;
}

export interface SemanticScholarAuthorSearchData {
  exactName: string;
  matches: SemanticScholarAuthorMatch[];
  returnedAuthorCount: number;
  totalCountReported: number | null;
}

function finish(
  startedAt: number,
  now: () => number,
  status: ToolStatus,
  data: SemanticScholarAuthorSearchData | null,
  diagnostics: ToolDiagnostic[],
  requests: number,
  bytesRead: number,
  incomplete: boolean,
): ToolResult<SemanticScholarAuthorSearchData> {
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

/**
 * Search Semantic Scholar's official Academic Graph author endpoint. The API
 * is public without authentication but rate-limited; only exact normalized
 * public names and locally constructed canonical profile URLs survive.
 */
export async function searchSemanticScholarAuthorsByExactName(
  nameValue: string,
  context: ToolContext = {},
): Promise<ToolResult<SemanticScholarAuthorSearchData>> {
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
          code: "invalid_semantic_scholar_author_name",
          severity: "warning",
          message: "Semantic Scholar author search requires one bounded public person name.",
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
          message: "Semantic Scholar author search was skipped because DNS answers cannot be validated.",
          retryable: false,
        },
      ],
      0,
      0,
      true,
    );
  }

  const requestUrl = new URL(`https://${SEMANTIC_SCHOLAR_API_HOST}/graph/v1/author/search`);
  requestUrl.searchParams.set("query", exactName);
  requestUrl.searchParams.set("limit", String(MAX_RESULTS));
  requestUrl.searchParams.set("fields", "name");
  const searchFetch = createHardenedFetch({
    allowedHostnames: [SEMANTIC_SCHOLAR_API_HOST],
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
        tool: "semantic_scholar_author_search",
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
          code: hardened?.code ?? "semantic_scholar_unavailable",
          severity: budgetExhausted || hardened?.code === "aborted" ? "info" : "warning",
          message: budgetExhausted
            ? "Semantic Scholar author search stopped at the network-request budget."
            : hardened?.code === "aborted"
              ? "Semantic Scholar author search was canceled."
              : "Semantic Scholar's public author API could not be fetched safely.",
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
          code: "semantic_scholar_rate_limited",
          severity: "warning",
          message: "Semantic Scholar rate-limited its public unauthenticated author endpoint.",
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
          code: "semantic_scholar_http_error",
          severity: "warning",
          message: `Semantic Scholar author search returned HTTP ${fetched.response.status}.`,
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
          code: "semantic_scholar_invalid_json",
          severity: "warning",
          message: "Semantic Scholar returned a response that was not valid JSON.",
          retryable: false,
        },
      ],
      fetched.requests,
      fetched.bytesRead,
      true,
    );
  }
  if (!isRecord(payload) || !Array.isArray(payload.data)) {
    return finish(
      startedAt,
      now,
      "failed",
      null,
      [
        {
          code: "semantic_scholar_invalid_schema",
          severity: "warning",
          message: "Semantic Scholar returned an unexpected author-search schema.",
          retryable: false,
        },
      ],
      fetched.requests,
      fetched.bytesRead,
      true,
    );
  }

  const matches: SemanticScholarAuthorMatch[] = [];
  let excludedRows = 0;
  const seen = new Set<string>();
  for (const row of payload.data.slice(0, MAX_RESULTS)) {
    if (!isRecord(row)) {
      excludedRows += 1;
      continue;
    }
    const authorId = typeof row.authorId === "string" && /^\d{1,24}$/.test(row.authorId) ? row.authorId : null;
    const name = typeof row.name === "string" ? exactPersonName(row.name) : null;
    if (!authorId || !name || normalizeComparable(name) !== normalizeComparable(exactName)) {
      excludedRows += 1;
      continue;
    }
    const profileUrl = `https://www.semanticscholar.org/author/${authorId}`;
    if (seen.has(profileUrl)) continue;
    seen.add(profileUrl);
    matches.push({ authorId, name, profileUrl });
  }
  const returnedAuthorCount = payload.data.length;
  const totalCountReported = boundedCount(payload.total);
  const incomplete = returnedAuthorCount > MAX_RESULTS || (totalCountReported ?? returnedAuthorCount) > MAX_RESULTS;
  const resultDiagnostics: ToolDiagnostic[] = [];
  if (excludedRows > 0)
    resultDiagnostics.push({
      code: "semantic_scholar_rows_excluded",
      severity: "info",
      message: "Non-exact or malformed Semantic Scholar author rows were excluded.",
      retryable: false,
      details: { count: excludedRows },
    });
  if (matches.length === 0)
    resultDiagnostics.push({
      code: "semantic_scholar_exact_name_not_observed",
      severity: "info",
      message:
        "No exact public-name match was observed in the bounded Semantic Scholar author records; this is not evidence that no profile exists.",
      retryable: incomplete,
    });
  const data: SemanticScholarAuthorSearchData = {
    exactName,
    matches,
    returnedAuthorCount,
    totalCountReported,
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

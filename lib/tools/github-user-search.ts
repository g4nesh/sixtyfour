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

export interface GithubPublicUserMatch {
  login: string;
  name: string;
  htmlUrl: string;
}

export interface GithubPublicUserSearchData {
  exactName: string;
  matches: GithubPublicUserMatch[];
  returnedUserCount: number;
  totalCountReported: number | null;
  incompleteResults: boolean;
}

interface GithubSearchItem {
  login: string;
  detailUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximum = 240): string | null {
  if (typeof value !== "string") return null;
  const normalized = normalizeWhitespace(value);
  return normalized && normalized.length <= maximum ? normalized : null;
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function exactGithubApiUserUrl(value: unknown, login: string): string | null {
  const source = boundedString(value, 500);
  if (!source) return null;
  try {
    const url = new URL(source);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "api.github.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== `/users/${login}`
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

function exactGithubProfileUrl(value: unknown, login: string): string | null {
  const source = boundedString(value, 500);
  if (!source) return null;
  try {
    const url = new URL(source);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== `/${login}`
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

function githubHeaders(): Headers {
  return new Headers({
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "atlas-people-intelligence/0.1",
  });
}

function finish(
  startedAt: number,
  now: () => number,
  status: ToolStatus,
  data: GithubPublicUserSearchData | null,
  diagnostics: ToolDiagnostic[],
  requests: number,
  bytesRead: number,
  incomplete: boolean,
): ToolResult<GithubPublicUserSearchData> {
  return {
    ok: status === "succeeded" || status === "not_found" || status === "partial",
    status,
    data,
    evidence: [],
    diagnostics,
    meta: createToolMeta(startedAt, now(), requests, bytesRead, incomplete),
  };
}

/**
 * Quota-independent, public-only discovery fallback for an exact person name.
 * Search rows are authorization hints only; a bounded user-detail fetch must
 * independently return an exact public name and canonical github.com profile.
 */
export async function searchGithubPublicUsersByExactName(
  exactNameValue: string,
  context: ToolContext = {},
): Promise<ToolResult<GithubPublicUserSearchData>> {
  const now = toolClock(context);
  const startedAt = now();
  const exactName = normalizeWhitespace(exactNameValue);
  if (!exactName || exactName.length > 200 || normalizeComparable(exactName).length < 2) {
    return finish(
      startedAt,
      now,
      "skipped",
      null,
      [
        {
          code: "invalid_exact_name",
          severity: "warning",
          message: "GitHub public-user fallback requires one bounded exact person name.",
          retryable: false,
        },
      ],
      0,
      0,
      false,
    );
  }

  const maximumUsers = 3;
  const maximumBytes = 256_000;
  const fetchGithub = createHardenedFetch({
    allowedHostnames: ["api.github.com"],
    ...(context.resolveHostname ? { resolveHostname: context.resolveHostname } : {}),
    allowedMethods: ["GET"],
    allowedMimeTypes: ["application/json", "application/vnd.github+json"],
    timeoutMs: 8_000,
    maxBytes: maximumBytes,
    maxRedirects: 0,
    maxRetries: 0,
    fetch: context.fetch,
    clock: now,
    beforeRequest: () =>
      reserveToolBudget(context, {
        tool: "github_public_user_search",
        networkRequests: 1,
        expectedBytes: maximumBytes,
      }),
  });

  const searchUrl = new URL("https://api.github.com/search/users");
  searchUrl.searchParams.set("q", `${exactName} in:fullname`);
  searchUrl.searchParams.set("per_page", String(maximumUsers));

  let requests = 0;
  let bytesRead = 0;
  let search;
  try {
    search = await fetchGithub(searchUrl, { headers: githubHeaders(), signal: context.signal });
    requests += search.requests;
    bytesRead += search.bytesRead;
  } catch (error) {
    const hardened = asHardenedFetchError(error);
    return finish(
      startedAt,
      now,
      hardened?.code === "budget_exhausted" ? "skipped" : "failed",
      null,
      [
        {
          code: hardened?.code ?? "github_public_user_unavailable",
          severity: hardened?.code === "budget_exhausted" ? "info" : "warning",
          message:
            hardened?.code === "budget_exhausted"
              ? "GitHub public-user fallback stopped at the network-request budget."
              : "GitHub public-user search was unavailable.",
          retryable: hardened?.retryable ?? true,
        },
      ],
      hardened?.requests ?? requests,
      bytesRead,
      true,
    );
  }

  if (
    search.response.status === 429 ||
    (search.response.status === 403 && search.response.headers.get("x-ratelimit-remaining") === "0")
  ) {
    return finish(
      startedAt,
      now,
      "rate_limited",
      null,
      [
        {
          code: "github_public_user_rate_limited",
          severity: "warning",
          message: "GitHub rate-limited the public-user fallback.",
          retryable: true,
        },
      ],
      requests,
      bytesRead,
      true,
    );
  }
  if (!search.response.ok) {
    return finish(
      startedAt,
      now,
      "failed",
      null,
      [
        {
          code: "github_public_user_http_error",
          severity: "warning",
          message: `GitHub public-user search returned HTTP ${search.response.status}.`,
          retryable: search.response.status >= 500,
        },
      ],
      requests,
      bytesRead,
      true,
    );
  }

  let payload: unknown;
  try {
    payload = await search.response.json();
  } catch {
    return finish(
      startedAt,
      now,
      "failed",
      null,
      [
        {
          code: "github_public_user_invalid_json",
          severity: "warning",
          message: "GitHub public-user search returned malformed JSON.",
          retryable: true,
        },
      ],
      requests,
      bytesRead,
      true,
    );
  }
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    return finish(
      startedAt,
      now,
      "failed",
      null,
      [
        {
          code: "github_public_user_invalid_response",
          severity: "warning",
          message: "GitHub public-user search returned an unexpected response shape.",
          retryable: false,
        },
      ],
      requests,
      bytesRead,
      true,
    );
  }

  const totalCountReported = nonnegativeInteger(payload.total_count);
  const incompleteResults = payload.incomplete_results === true;
  const boundedResultCount = Math.min(payload.items.length, maximumUsers);
  const searchItems: GithubSearchItem[] = [];
  const seen = new Set<string>();
  let excludedRows = 0;
  for (const value of payload.items.slice(0, maximumUsers)) {
    if (!isRecord(value) || value.type !== "User") {
      excludedRows += 1;
      continue;
    }
    const login = boundedString(value.login, 39);
    if (!login || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(login)) {
      excludedRows += 1;
      continue;
    }
    const detailUrl = exactGithubApiUserUrl(value.url, login);
    if (!detailUrl || seen.has(login.toLowerCase())) {
      excludedRows += 1;
      continue;
    }
    seen.add(login.toLowerCase());
    searchItems.push({ login, detailUrl });
  }

  const matches: GithubPublicUserMatch[] = [];
  let detailIncomplete = false;
  for (const item of searchItems) {
    let detail;
    try {
      detail = await fetchGithub(item.detailUrl, { headers: githubHeaders(), signal: context.signal });
      requests += detail.requests;
      bytesRead += detail.bytesRead;
    } catch (error) {
      const hardened = asHardenedFetchError(error);
      requests += hardened?.requests ?? 0;
      if (hardened?.code === "budget_exhausted") {
        return finish(
          startedAt,
          now,
          "partial",
          {
            exactName,
            matches,
            returnedUserCount: searchItems.length,
            totalCountReported,
            incompleteResults: true,
          },
          [
            {
              code: "github_public_user_budget_exhausted",
              severity: "info",
              message: "GitHub public-user fallback stopped before every bounded detail record was checked.",
              retryable: false,
            },
          ],
          requests,
          bytesRead,
          true,
        );
      }
      detailIncomplete = true;
      excludedRows += 1;
      continue;
    }
    if (!detail.response.ok) {
      detailIncomplete = true;
      excludedRows += 1;
      continue;
    }
    let record: unknown;
    try {
      record = await detail.response.json();
    } catch {
      detailIncomplete = true;
      excludedRows += 1;
      continue;
    }
    if (!isRecord(record) || record.type !== "User") {
      detailIncomplete = true;
      excludedRows += 1;
      continue;
    }
    const login = boundedString(record.login, 39);
    const name = boundedString(record.name, 200);
    if (
      !login ||
      login.toLowerCase() !== item.login.toLowerCase() ||
      !name ||
      normalizeComparable(name) !== normalizeComparable(exactName)
    )
      continue;
    const htmlUrl = exactGithubProfileUrl(record.html_url, login);
    if (!htmlUrl) {
      excludedRows += 1;
      continue;
    }
    matches.push({ login, name, htmlUrl });
  }

  const diagnostics: ToolDiagnostic[] = [];
  if (excludedRows > 0)
    diagnostics.push({
      code: "github_public_user_rows_excluded",
      severity: "info",
      message: "GitHub rows without canonical public-user URLs or valid public detail records were excluded.",
      retryable: false,
      details: { count: excludedRows },
    });
  if (matches.length === 0)
    diagnostics.push({
      code: "github_exact_name_not_observed",
      severity: "info",
      message:
        "No exact public-name match was observed in the bounded GitHub user records; this is not evidence that no profile exists.",
      retryable: detailIncomplete || incompleteResults || (totalCountReported ?? 0) > boundedResultCount,
    });
  if (detailIncomplete)
    diagnostics.push({
      code: "github_public_user_detail_incomplete",
      severity: "warning",
      message: "At least one bounded GitHub public-user detail record could not be checked completely.",
      retryable: true,
    });

  const incomplete =
    detailIncomplete || incompleteResults || (totalCountReported ?? boundedResultCount) > boundedResultCount;
  const data: GithubPublicUserSearchData = {
    exactName,
    matches,
    returnedUserCount: searchItems.length,
    totalCountReported,
    incompleteResults,
  };
  return finish(
    startedAt,
    now,
    matches.length > 0 ? "succeeded" : incomplete ? "partial" : "not_found",
    data,
    diagnostics,
    requests,
    bytesRead,
    incomplete,
  );
}

import { containsRestrictedPublicContent, urlContainsRestrictedParameters } from "../domain/content-policy";
import { normalizeWhitespace } from "../domain/runtime";
import { isDeniedResearchSource, isDeniedResearchTool } from "../search/source-hierarchy";
import {
  createToolMeta,
  reserveToolBudget,
  toolClock,
  type ToolContext,
  type ToolDiagnostic,
  type ToolResult,
  type ToolStatus,
} from "./contracts";
import { asHardenedFetchError, createHardenedFetch, isBlockedIpAddress } from "./hardened-fetch";
import { decodeHtmlTextForPolicy } from "./inert-html";

const DUCKDUCKGO_HTML_HOST = "html.duckduckgo.com";
const DUCKDUCKGO_REDIRECT_HOSTS = new Set(["duckduckgo.com", "www.duckduckgo.com"]);
const MAX_RESULTS = 8;
const MAX_RESPONSE_BYTES = 384_000;

export interface DuckDuckGoHtmlResult {
  title: string;
  url: string;
}

export interface DuckDuckGoHtmlSearchData {
  results: DuckDuckGoHtmlResult[];
  observedResultAnchors: number;
  excludedResultAnchors: number;
  truncated: boolean;
}

function finish(
  startedAt: number,
  now: () => number,
  status: ToolStatus,
  data: DuckDuckGoHtmlSearchData | null,
  diagnostics: ToolDiagnostic[],
  requests: number,
  bytesRead: number,
  incomplete: boolean,
): ToolResult<DuckDuckGoHtmlSearchData> {
  return {
    ok: status === "succeeded" || status === "partial" || status === "not_found",
    status,
    data,
    evidence: [],
    diagnostics,
    meta: createToolMeta(startedAt, now(), requests, bytesRead, incomplete),
  };
}

function htmlAttribute(attributes: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = attributes.match(new RegExp(
    `(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`,
    "i",
  ));
  return match ? decodeHtmlTextForPolicy(match[1] ?? match[2] ?? match[3] ?? "") : null;
}

function resultTitle(innerHtml: string): string | null {
  const decoded = decodeHtmlTextForPolicy(innerHtml.replace(/<[^>]*>/g, " "));
  if (decoded === null) return null;
  const title = normalizeWhitespace(decoded.normalize("NFKC"));
  return title && !containsRestrictedPublicContent(title) ? title.slice(0, 320) : null;
}

function isDuckDuckGoHostname(hostname: string): boolean {
  const normalized = hostname.toLocaleLowerCase("en-US").replace(/\.$/, "");
  return normalized === "duckduckgo.com" || normalized.endsWith(".duckduckgo.com");
}

function isUnsafeTargetHostname(hostname: string): boolean {
  const normalized = hostname.toLocaleLowerCase("en-US").replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized.endsWith(".local")
    || normalized.endsWith(".internal")
    || normalized.endsWith(".home.arpa")
    || isBlockedIpAddress(normalized);
}

/**
 * Accept either a direct HTTPS result or DuckDuckGo's exact `/l/` wrapper.
 * The wrapper is authorization metadata only: only its single decoded `uddg`
 * target survives, and no DuckDuckGo-internal URL can become a research lead.
 */
export function unwrapDuckDuckGoResultUrl(value: string): string | null {
  const decoded = decodeHtmlTextForPolicy(value);
  if (decoded === null) return null;
  const href = decoded.trim();
  if (!href || href.length > 8_192) return null;

  let observed: URL;
  try {
    if (href.startsWith("//")) observed = new URL(`https:${href}`);
    else if (href.startsWith("/")) observed = new URL(href, "https://duckduckgo.com");
    else observed = new URL(href);
  } catch {
    return null;
  }

  let target = observed;
  const observedHost = observed.hostname.toLocaleLowerCase("en-US").replace(/\.$/, "");
  if (DUCKDUCKGO_REDIRECT_HOSTS.has(observedHost)) {
    if (
      observed.protocol !== "https:"
      || observed.username
      || observed.password
      || observed.port
      || (observed.pathname !== "/l/" && observed.pathname !== "/l")
      || observed.searchParams.getAll("uddg").length !== 1
      || [...observed.searchParams.keys()].some((key) => key !== "uddg" && key !== "rut")
    ) return null;
    const encodedTarget = observed.searchParams.get("uddg");
    if (!encodedTarget || encodedTarget.length > 8_192) return null;
    try {
      target = new URL(encodedTarget);
    } catch {
      return null;
    }
  } else if (isDuckDuckGoHostname(observedHost)) {
    return null;
  }

  if (
    target.protocol !== "https:"
    || target.username
    || target.password
    || (target.port && target.port !== "443")
    || isDuckDuckGoHostname(target.hostname)
    || isUnsafeTargetHostname(target.hostname)
    || urlContainsRestrictedParameters(target.href)
    || isDeniedResearchSource(target.href)
  ) return null;
  target.hash = "";
  return target.href;
}

function parseResults(html: string): DuckDuckGoHtmlSearchData {
  const results: DuckDuckGoHtmlResult[] = [];
  const seen = new Set<string>();
  let observedResultAnchors = 0;
  let excludedResultAnchors = 0;
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  for (const match of html.matchAll(anchorPattern)) {
    const attributes = match[1] ?? "";
    const className = htmlAttribute(attributes, "class");
    if (!className?.split(/\s+/).includes("result__a")) continue;
    observedResultAnchors += 1;
    if (results.length >= MAX_RESULTS) continue;
    const href = htmlAttribute(attributes, "href");
    const title = resultTitle(match[2] ?? "");
    const url = href ? unwrapDuckDuckGoResultUrl(href) : null;
    if (!title || !url || seen.has(url)) {
      excludedResultAnchors += 1;
      continue;
    }
    seen.add(url);
    results.push({ title, url });
  }
  return {
    results,
    observedResultAnchors,
    excludedResultAnchors,
    truncated: observedResultAnchors > results.length + excludedResultAnchors,
  };
}

/**
 * Keyless public discovery using DuckDuckGo's HTML-only search endpoint.
 * Result snippets and response HTML never leave this adapter; downstream code
 * receives at most eight bounded public titles and safely unwrapped URLs.
 */
export async function searchDuckDuckGoHtml(
  queryValue: string,
  context: ToolContext = {},
): Promise<ToolResult<DuckDuckGoHtmlSearchData>> {
  const now = toolClock(context);
  const startedAt = now();
  const query = normalizeWhitespace(queryValue);
  if (
    !query
    || query.length > 500
    || containsRestrictedPublicContent(query)
    || isDeniedResearchTool(query)
  ) {
    return finish(startedAt, now, "skipped", null, [{
      code: "unsafe_public_search_query",
      severity: "warning",
      message: "The keyless public-search fallback requires one bounded public-professional query.",
      retryable: false,
    }], 0, 0, false);
  }
  if (!context.resolveHostname) {
    return finish(startedAt, now, "skipped", null, [{
      code: "dns_validation_unavailable",
      severity: "warning",
      message: "The keyless public-search fallback was skipped because this runtime cannot validate DuckDuckGo's DNS answers.",
      retryable: false,
    }], 0, 0, true);
  }

  const searchUrl = new URL(`https://${DUCKDUCKGO_HTML_HOST}/html/`);
  searchUrl.searchParams.set("q", query);
  const searchFetch = createHardenedFetch({
    allowedHostnames: [DUCKDUCKGO_HTML_HOST],
    resolveHostname: context.resolveHostname,
    allowedMethods: ["GET"],
    allowedMimeTypes: ["text/html"],
    timeoutMs: 8_000,
    maxBytes: MAX_RESPONSE_BYTES,
    maxRedirects: 0,
    maxRetries: 1,
    maxRetryAfterMs: 1_000,
    fetch: context.fetch,
    clock: now,
    beforeRequest: () => reserveToolBudget(context, {
      tool: "duckduckgo_html_search",
      networkRequests: 1,
      expectedBytes: MAX_RESPONSE_BYTES,
    }),
  });

  let fetched;
  try {
    fetched = await searchFetch(searchUrl, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "atlas-people-intelligence/0.1",
      },
      signal: context.signal,
    });
  } catch (error) {
    const hardened = asHardenedFetchError(error);
    const budgetExhausted = hardened?.code === "budget_exhausted";
    return finish(startedAt, now, budgetExhausted ? "skipped" : "failed", null, [{
      code: hardened?.code ?? "duckduckgo_html_unavailable",
      severity: budgetExhausted || hardened?.code === "aborted" ? "info" : "warning",
      message: budgetExhausted
        ? "The keyless public-search fallback stopped at the network-request budget."
        : hardened?.code === "aborted"
          ? "The keyless public-search fallback was canceled."
          : "The keyless public-search fallback could not be fetched safely.",
      retryable: hardened?.retryable ?? true,
      ...(hardened ? {
        details: {
          attempt: hardened.attempt,
          requests: hardened.requests,
          httpStatus: hardened.status,
        },
      } : {}),
    }], hardened?.requests ?? 0, 0, true);
  }

  if (fetched.response.status === 429) {
    return finish(startedAt, now, "rate_limited", null, [{
      code: "duckduckgo_html_rate_limited",
      severity: "warning",
      message: "DuckDuckGo rate-limited the keyless public-search fallback.",
      retryable: true,
    }], fetched.requests, fetched.bytesRead, true);
  }
  if (!fetched.response.ok) {
    return finish(startedAt, now, "failed", null, [{
      code: "duckduckgo_html_http_error",
      severity: "warning",
      message: `The keyless public-search fallback returned HTTP ${fetched.response.status}.`,
      retryable: fetched.response.status >= 500,
    }], fetched.requests, fetched.bytesRead, true);
  }

  let html: string;
  try {
    html = await fetched.response.text();
  } catch {
    return finish(startedAt, now, "failed", null, [{
      code: "duckduckgo_html_decode_failed",
      severity: "warning",
      message: "The bounded public-search response could not be decoded as HTML.",
      retryable: false,
    }], fetched.requests, fetched.bytesRead, true);
  }

  const data = parseResults(html);
  const incomplete = data.excludedResultAnchors > 0 || data.truncated;
  const resultDiagnostics: ToolDiagnostic[] = [];
  if (data.excludedResultAnchors > 0) {
    resultDiagnostics.push({
      code: "duckduckgo_result_rows_excluded",
      severity: "info",
      message: "Unsafe, malformed, duplicate, or restricted public-search result rows were excluded.",
      retryable: false,
      details: { excludedResultAnchors: data.excludedResultAnchors },
    });
  }
  if (data.truncated) {
    resultDiagnostics.push({
      code: "duckduckgo_result_limit_reached",
      severity: "info",
      message: "The public-search result set was bounded to eight safe leads.",
      retryable: false,
      details: { maximumResults: MAX_RESULTS },
    });
  }
  if (data.results.length === 0) {
    resultDiagnostics.push({
      code: "duckduckgo_results_not_observed",
      severity: "info",
      message: "The bounded keyless public search returned no safe HTTPS result leads.",
      retryable: false,
    });
    return finish(startedAt, now, "not_found", data, resultDiagnostics, fetched.requests, fetched.bytesRead, incomplete);
  }
  return finish(
    startedAt,
    now,
    incomplete ? "partial" : "succeeded",
    data,
    resultDiagnostics,
    fetched.requests,
    fetched.bytesRead,
    incomplete,
  );
}

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
import { decodeHtmlTextForPolicy, projectInertHtml, replaceHtmlContainers } from "./inert-html";

const GOOGLE_SEARCH_HOST = "www.google.com";
const MAX_RESULTS = 8;
const MAX_RESPONSE_BYTES = 384_000;

export interface GoogleHtmlResult {
  title: string;
  url: string;
}

export interface GoogleHtmlSearchData {
  results: GoogleHtmlResult[];
  observedResultAnchors: number;
  excludedResultAnchors: number;
  truncated: boolean;
}

function finish(
  startedAt: number,
  now: () => number,
  status: ToolStatus,
  data: GoogleHtmlSearchData | null,
  diagnostics: ToolDiagnostic[],
  requests: number,
  bytesRead: number,
  incomplete: boolean,
): ToolResult<GoogleHtmlSearchData> {
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
  const match = attributes.match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, "i"));
  return match ? decodeHtmlTextForPolicy(match[1] ?? match[2] ?? match[3] ?? "") : null;
}

function resultTitle(innerHtml: string): string | null {
  const heading = innerHtml.match(/<h3\b[^>]*>([\s\S]*?)<\/h3\s*>/i)?.[1];
  if (!heading) return null;
  const decoded = decodeHtmlTextForPolicy(heading.replace(/<[^>]*>/g, " "));
  if (decoded === null) return null;
  const title = normalizeWhitespace(decoded.normalize("NFKC"));
  return title && !containsRestrictedPublicContent(title) ? title.slice(0, 320) : null;
}

function isGoogleHostname(hostname: string): boolean {
  const normalized = hostname.toLocaleLowerCase("en-US").replace(/\.$/, "");
  return normalized === "google.com" || normalized.endsWith(".google.com");
}

function isUnsafeTargetHostname(hostname: string): boolean {
  const normalized = hostname
    .toLocaleLowerCase("en-US")
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".home.arpa") ||
    isBlockedIpAddress(normalized)
  );
}

/**
 * Accept a direct HTTPS result or Google's exact `/url` result wrapper. No
 * Google-internal page, redirect chain, credentials, or restricted query can
 * become a research capability.
 */
export function unwrapGoogleResultUrl(value: string): string | null {
  const decoded = decodeHtmlTextForPolicy(value);
  if (decoded === null) return null;
  const href = decoded.trim();
  if (!href || href.length > 8_192) return null;

  let observed: URL;
  try {
    observed = href.startsWith("/") ? new URL(href, `https://${GOOGLE_SEARCH_HOST}`) : new URL(href);
  } catch {
    return null;
  }

  let target = observed;
  if (isGoogleHostname(observed.hostname)) {
    if (
      observed.protocol !== "https:" ||
      observed.username ||
      observed.password ||
      observed.port ||
      observed.pathname !== "/url"
    )
      return null;
    const candidates = [...observed.searchParams.getAll("q"), ...observed.searchParams.getAll("url")].filter(Boolean);
    if (candidates.length !== 1 || candidates[0].length > 8_192) return null;
    try {
      target = new URL(candidates[0]);
    } catch {
      return null;
    }
  }

  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    (target.port && target.port !== "443") ||
    isGoogleHostname(target.hostname) ||
    isUnsafeTargetHostname(target.hostname) ||
    urlContainsRestrictedParameters(target.href) ||
    isDeniedResearchSource(target.href)
  )
    return null;
  target.hash = "";
  return target.href;
}

function parseResults(html: string): GoogleHtmlSearchData {
  const results: GoogleHtmlResult[] = [];
  const seen = new Set<string>();
  let observedResultAnchors = 0;
  let excludedResultAnchors = 0;
  replaceHtmlContainers(projectInertHtml(html).passiveHtml, "a", (anchor) => {
    const title = resultTitle(anchor.body);
    if (!title) return " ";
    observedResultAnchors += 1;
    if (results.length >= MAX_RESULTS) return " ";
    const href = htmlAttribute(anchor.attributes, "href");
    const url = href ? unwrapGoogleResultUrl(href) : null;
    if (!url || seen.has(url)) {
      excludedResultAnchors += 1;
      return " ";
    }
    seen.add(url);
    results.push({ title, url });
    return " ";
  });
  return {
    results,
    observedResultAnchors,
    excludedResultAnchors,
    truncated: observedResultAnchors > results.length + excludedResultAnchors,
  };
}

function challengeObserved(html: string): boolean {
  return /(?:\/sorry\/|recaptcha|unusual traffic|automated queries|before you continue to google)/i.test(html);
}

/**
 * A bounded, keyless Google HTML fallback. It never executes JavaScript,
 * accepts cookies, submits consent/CAPTCHA forms, or retains snippets/raw HTML.
 */
export async function searchGoogleHtml(
  queryValue: string,
  context: ToolContext = {},
): Promise<ToolResult<GoogleHtmlSearchData>> {
  const now = toolClock(context);
  const startedAt = now();
  const query = normalizeWhitespace(queryValue);
  if (!query || query.length > 500 || containsRestrictedPublicContent(query) || isDeniedResearchTool(query)) {
    return finish(
      startedAt,
      now,
      "skipped",
      null,
      [
        {
          code: "unsafe_public_search_query",
          severity: "warning",
          message: "The Google public-search fallback requires one bounded public-professional query.",
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
          message: "The Google public-search fallback was skipped because DNS answers cannot be validated.",
          retryable: false,
        },
      ],
      0,
      0,
      true,
    );
  }

  const searchUrl = new URL(`https://${GOOGLE_SEARCH_HOST}/search`);
  searchUrl.searchParams.set("q", query);
  searchUrl.searchParams.set("num", "10");
  searchUrl.searchParams.set("hl", "en");
  searchUrl.searchParams.set("filter", "0");
  searchUrl.searchParams.set("safe", "active");
  const searchFetch = createHardenedFetch({
    allowedHostnames: [GOOGLE_SEARCH_HOST],
    resolveHostname: context.resolveHostname,
    allowedMethods: ["GET"],
    allowedMimeTypes: ["text/html"],
    timeoutMs: 8_000,
    maxBytes: MAX_RESPONSE_BYTES,
    maxRedirects: 0,
    maxRetries: 0,
    maxRetryAfterMs: 1_000,
    fetch: context.fetch,
    clock: now,
    beforeRequest: () =>
      reserveToolBudget(context, {
        tool: "google_html_search",
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
    return finish(
      startedAt,
      now,
      budgetExhausted ? "skipped" : "failed",
      null,
      [
        {
          code: hardened?.code ?? "google_html_unavailable",
          severity: budgetExhausted || hardened?.code === "aborted" ? "info" : "warning",
          message: budgetExhausted
            ? "Google public search stopped at the network-request budget."
            : hardened?.code === "aborted"
              ? "Google public search was canceled."
              : "Google public search could not be fetched safely.",
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
          code: "google_html_rate_limited",
          severity: "warning",
          message: "Google rate-limited the bounded public-search request; Atlas did not retry or bypass it.",
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
          code: "google_html_http_error",
          severity: "warning",
          message: `Google public search returned HTTP ${fetched.response.status}.`,
          retryable: fetched.response.status >= 500,
        },
      ],
      fetched.requests,
      fetched.bytesRead,
      true,
    );
  }

  let html: string;
  try {
    html = await fetched.response.text();
  } catch {
    return finish(
      startedAt,
      now,
      "failed",
      null,
      [
        {
          code: "google_html_decode_failed",
          severity: "warning",
          message: "The bounded Google search response could not be decoded as HTML.",
          retryable: false,
        },
      ],
      fetched.requests,
      fetched.bytesRead,
      true,
    );
  }
  if (challengeObserved(html)) {
    return finish(
      startedAt,
      now,
      "failed",
      null,
      [
        {
          code: "google_html_challenge_observed",
          severity: "warning",
          message: "Google returned a consent or anti-automation challenge; Atlas did not interact with or bypass it.",
          retryable: true,
        },
      ],
      fetched.requests,
      fetched.bytesRead,
      true,
    );
  }

  const data = parseResults(html);
  const incomplete = data.excludedResultAnchors > 0 || data.truncated;
  const resultDiagnostics: ToolDiagnostic[] = [];
  if (data.excludedResultAnchors > 0)
    resultDiagnostics.push({
      code: "google_result_rows_excluded",
      severity: "info",
      message: "Unsafe, malformed, duplicate, or restricted Google result rows were excluded.",
      retryable: false,
      details: { excludedResultAnchors: data.excludedResultAnchors },
    });
  if (data.truncated)
    resultDiagnostics.push({
      code: "google_result_limit_reached",
      severity: "info",
      message: "Google public-search results were bounded to eight safe leads.",
      retryable: false,
      details: { maximumResults: MAX_RESULTS },
    });
  if (data.results.length === 0) {
    resultDiagnostics.push({
      code: "google_results_not_observed",
      severity: "info",
      message: "The bounded Google public search returned no safe HTTPS result leads.",
      retryable: false,
    });
    return finish(
      startedAt,
      now,
      "not_found",
      data,
      resultDiagnostics,
      fetched.requests,
      fetched.bytesRead,
      incomplete,
    );
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

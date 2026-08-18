import {
  createToolMeta,
  reserveToolBudget,
  toolClock,
  type ToolContext,
  type ToolResult,
  type ToolStatus,
} from "./contracts";
import { createHardenedFetch, HardenedFetchError } from "./hardened-fetch";

export interface FetchPublicSourceInput {
  url: string;
  /** Must be copied from a provider citation or a URL already linked to the candidate. */
  allowedUrl: string;
}

export interface FetchPublicSourceOptions {
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxTextCharacters?: number;
  maxRedirects?: number;
}

export interface PublicSourceData {
  sourceUrl: string;
  finalUrl: string;
  title: string | null;
  mimeType: string;
  httpStatus: number;
  contentHash: string;
  /** Bounded normalized text for inert evidence extraction; never put this field in a trace. */
  normalizedText: string;
  truncated: boolean;
  observedAt: string;
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value as number)));
}

function finish(
  startedAt: number,
  now: () => number,
  status: ToolStatus,
  data: PublicSourceData | null,
  diagnostics: ToolResult<PublicSourceData>["diagnostics"],
  requests: number,
  bytesRead: number,
  incomplete: boolean,
): ToolResult<PublicSourceData> {
  return {
    ok: status === "succeeded" || status === "partial" || status === "not_found",
    status,
    data,
    evidence: [],
    diagnostics,
    meta: createToolMeta(startedAt, now(), requests, bytesRead, incomplete),
  };
}

function normalizeAllowedUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) {
      return null;
    }
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#x")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function titleFromHtml(value: string): string | null {
  const match = value.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (!match?.[1]) return null;
  const title = decodeEntities(match[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  return title ? title.slice(0, 240) : null;
}

function normalizedText(value: string, mimeType: string): string {
  const withoutExecutableContent = mimeType === "text/html"
    ? value
        .replace(/<(?:script|style|noscript|template|svg|canvas|iframe)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|template|svg|canvas|iframe)>/gi, " ")
        .replace(/<!--([\s\S]*?)-->/g, " ")
        .replace(/<[^>]+>/g, " ")
    : value;
  // eslint-disable-next-line no-control-regex -- fetched text is inert and C0 controls must be removed
  return decodeEntities(withoutExecutableContent).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Fetches only an already-allowlisted HTTPS URL. The response body is bounded,
 * normalized as inert text, and returned to the caller for locally validated
 * extraction. No response body or secret-bearing header is logged here.
 */
export async function fetchPublicSource(
  input: FetchPublicSourceInput,
  context: ToolContext = {},
  options: FetchPublicSourceOptions = {},
): Promise<ToolResult<PublicSourceData>> {
  const now = toolClock(context);
  const startedAt = now();
  const requested = normalizeAllowedUrl(input.url);
  const allowed = normalizeAllowedUrl(input.allowedUrl);
  if (!requested || !allowed || requested.href !== allowed.href) {
    return finish(startedAt, now, "skipped", null, [{
      code: "source_url_not_allowlisted",
      severity: "warning",
      message: "Public-source fetch requires an exact HTTPS URL already returned by a provider or linked to the candidate.",
      retryable: false,
    }], 0, 0, false);
  }
  if (!context.resolveHostname) {
    return finish(startedAt, now, "skipped", null, [{
      code: "dns_validation_unavailable",
      severity: "warning",
      message: "Public-source fetch was skipped because this runtime cannot validate the destination's DNS answers.",
      retryable: false,
    }], 0, 0, true);
  }

  const maxBytes = bounded(options.maxResponseBytes, 750_000, 8_192, 2_000_000);
  const maxCharacters = bounded(options.maxTextCharacters, 24_000, 1_000, 100_000);
  const fetchSource = createHardenedFetch({
    allowedHostnames: [requested.hostname],
    resolveHostname: context.resolveHostname,
    allowedMethods: ["GET"],
    allowedMimeTypes: ["text/html", "text/plain", "application/json", "application/ld+json"],
    timeoutMs: bounded(options.timeoutMs, 10_000, 500, 30_000),
    maxBytes,
    maxRedirects: bounded(options.maxRedirects, 2, 0, 3),
    maxRetries: 2,
    maxRetryAfterMs: 5_000,
    fetch: context.fetch,
    clock: now,
    beforeRequest: () => reserveToolBudget(context, {
      tool: "fetch_public_source",
      networkRequests: 1,
      expectedBytes: maxBytes,
    }),
  });

  let fetched;
  try {
    fetched = await fetchSource(requested, { signal: context.signal });
  } catch (error) {
    const hardened = error instanceof HardenedFetchError ? error : null;
    return finish(startedAt, now, context.signal?.aborted ? "skipped" : "failed", null, [{
      code: hardened?.code ?? "public_source_unavailable",
      severity: hardened?.code === "aborted" ? "info" : "warning",
      message: hardened?.code === "aborted"
        ? "Public-source fetch was canceled."
        : "The allowlisted public source could not be fetched safely.",
      retryable: hardened?.retryable ?? false,
    }], hardened?.requests ?? 1, 0, true);
  }

  const contentType = fetched.response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!fetched.response.ok) {
    return finish(startedAt, now, fetched.response.status === 404 ? "not_found" : "failed", null, [{
      code: "public_source_http_error",
      severity: fetched.response.status === 404 ? "info" : "warning",
      message: `The public source returned HTTP ${fetched.response.status}.`,
      retryable: fetched.response.status >= 500,
    }], fetched.requests, fetched.bytesRead, fetched.response.status >= 500);
  }

  let body: string;
  try {
    body = await fetched.response.text();
  } catch {
    return finish(startedAt, now, "failed", null, [{
      code: "public_source_decode_failed",
      severity: "warning",
      message: "The bounded public response could not be decoded as text.",
      retryable: false,
    }], fetched.requests, fetched.bytesRead, true);
  }
  const normalized = normalizedText(body, contentType);
  const truncated = normalized.length > maxCharacters;
  const observedAt = new Date(now()).toISOString();
  const data: PublicSourceData = {
    sourceUrl: requested.href,
    finalUrl: fetched.finalUrl,
    title: contentType === "text/html" ? titleFromHtml(body) : null,
    mimeType: contentType,
    httpStatus: fetched.response.status,
    contentHash: await sha256(normalized),
    normalizedText: normalized.slice(0, maxCharacters),
    truncated,
    observedAt,
  };
  const status: ToolStatus = truncated ? "partial" : "succeeded";
  return finish(startedAt, now, status, data, truncated ? [{
    code: "public_source_text_truncated",
    severity: "info",
    message: "The fetched body was safely bounded before evidence extraction.",
    retryable: false,
  }] : [], fetched.requests, fetched.bytesRead, truncated);
}

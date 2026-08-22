import {
  createToolMeta,
  reserveToolBudget,
  toolClock,
  type ToolContext,
  type ToolResult,
  type ToolStatus,
} from "./contracts";
import { asHardenedFetchError, createHardenedFetch } from "./hardened-fetch";
import { extractPublicPageFootprint, type PublicPageFootprint } from "./page-footprint";
import { decodeHtmlTextForPolicy, projectInertHtml } from "./inert-html";
import { extractSameOriginProfessionalLinks, type SameOriginProfessionalLink } from "./professional-links";
import { containsRestrictedPublicContent } from "../domain/content-policy";

export interface FetchPublicSourceInput {
  url: string;
  /** Must be copied from a provider citation or a URL already linked to the candidate. */
  allowedUrl: string;
  /** Optional public subject label used only for same-origin path matching. */
  subjectName?: string;
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
  /** Inert declarations observed in the already-fetched HTML; never authorizes another request. */
  pageFootprint: PublicPageFootprint | null;
  /** SHA-256 of the deterministic JSON-safe footprint projection, when present. */
  pageFootprintHash: string | null;
  /** Inertly observed links only; each still requires a new candidate-bound authorization and fetch. */
  professionalLinks: SameOriginProfessionalLink[];
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

function titleFromHtml(value: string): string | null {
  const match = projectInertHtml(value).titleHtml.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (!match?.[1]) return null;
  const decoded = decodeHtmlTextForPolicy(match[1].replace(/<[^>]+>/g, " "));
  if (decoded === null) return null;
  const title = decoded.normalize("NFKC").replace(/\s+/g, " ").trim();
  return title && !containsRestrictedPublicContent(title) ? title.slice(0, 240) : null;
}

const TEXT_BOUNDARY_TAG =
  /<\/?(?:address|article|aside|blockquote|br|dd|div|dl|dt|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)\b[^>]*>/gi;

function safePolicySegments(value: string): string {
  const segmented = value.replace(TEXT_BOUNDARY_TAG, "\n").replace(/<[^>]+>/g, "");
  const accepted: string[] = [];
  for (const rawSegment of segmented.split(/\n+/)) {
    const decoded = decodeHtmlTextForPolicy(rawSegment);
    if (decoded === null) continue;
    const segment = decoded.normalize("NFKC").replace(/\s+/g, " ").trim();
    if (segment && !containsRestrictedPublicContent(segment)) accepted.push(segment);
  }
  return accepted.join(" ");
}

function normalizedText(value: string, mimeType: string): string {
  const title = mimeType === "text/html" ? titleFromHtml(value) : null;
  const rawBody = mimeType === "text/html" ? projectInertHtml(value).passiveHtml : value;
  return [title, safePolicySegments(rawBody)].filter(Boolean).join(" ").trim();
}

function safeTextPrefix(value: string, maximumCharacters: number): string {
  if (value.length <= maximumCharacters) return value;
  const prefix = value.slice(0, maximumCharacters);
  if (/\s$/.test(prefix) || /\s/.test(value[maximumCharacters] ?? "")) return prefix.trimEnd();
  const boundary = prefix.lastIndexOf(" ");
  return boundary < 0 ? "" : prefix.slice(0, boundary).trimEnd();
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
    return finish(
      startedAt,
      now,
      "skipped",
      null,
      [
        {
          code: "source_url_not_allowlisted",
          severity: "warning",
          message:
            "Public-source fetch requires an exact HTTPS URL already returned by a provider or linked to the candidate.",
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
          message:
            "Public-source fetch was skipped because this runtime cannot validate the destination's DNS answers.",
          retryable: false,
        },
      ],
      0,
      0,
      true,
    );
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
    beforeRequest: () =>
      reserveToolBudget(context, {
        tool: "fetch_public_source",
        networkRequests: 1,
        expectedBytes: maxBytes,
      }),
  });

  let fetched;
  try {
    fetched = await fetchSource(requested, { signal: context.signal });
  } catch (error) {
    const hardened = asHardenedFetchError(error);
    return finish(
      startedAt,
      now,
      context.signal?.aborted ? "skipped" : "failed",
      null,
      [
        {
          code: hardened?.code ?? "public_source_unavailable",
          severity: hardened?.code === "aborted" ? "info" : "warning",
          message:
            hardened?.code === "aborted"
              ? "Public-source fetch was canceled."
              : "The allowlisted public source could not be fetched safely.",
          retryable: hardened?.retryable ?? false,
          ...(hardened
            ? {
                details: {
                  attempt: hardened.attempt,
                  requests: hardened.requests,
                  httpStatus: hardened.status,
                },
              }
            : {}),
        },
      ],
      hardened?.requests ?? 1,
      0,
      true,
    );
  }

  const contentType = fetched.response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!fetched.response.ok) {
    return finish(
      startedAt,
      now,
      fetched.response.status === 404 ? "not_found" : "failed",
      null,
      [
        {
          code: "public_source_http_error",
          severity: fetched.response.status === 404 ? "info" : "warning",
          message: `The public source returned HTTP ${fetched.response.status}.`,
          retryable: fetched.response.status >= 500,
        },
      ],
      fetched.requests,
      fetched.bytesRead,
      fetched.response.status >= 500,
    );
  }

  let body: string;
  try {
    body = await fetched.response.text();
  } catch {
    return finish(
      startedAt,
      now,
      "failed",
      null,
      [
        {
          code: "public_source_decode_failed",
          severity: "warning",
          message: "The bounded public response could not be decoded as text.",
          retryable: false,
        },
      ],
      fetched.requests,
      fetched.bytesRead,
      true,
    );
  }
  const normalized = normalizedText(body, contentType);
  const truncated = normalized.length > maxCharacters;
  const observedAt = new Date(now()).toISOString();
  const pageFootprint =
    contentType === "text/html" ? extractPublicPageFootprint({ html: body, finalUrl: fetched.finalUrl }) : null;
  const professionalLinks =
    contentType === "text/html"
      ? extractSameOriginProfessionalLinks({
          html: body,
          finalUrl: fetched.finalUrl,
          subjectName: input.subjectName,
          maxLinks: 3,
        })
      : [];
  const data: PublicSourceData = {
    sourceUrl: requested.href,
    finalUrl: fetched.finalUrl,
    title: contentType === "text/html" ? titleFromHtml(body) : null,
    mimeType: contentType,
    httpStatus: fetched.response.status,
    contentHash: await sha256(normalized),
    normalizedText: safeTextPrefix(normalized, maxCharacters),
    pageFootprint,
    pageFootprintHash: pageFootprint ? await sha256(JSON.stringify(pageFootprint)) : null,
    professionalLinks,
    truncated,
    observedAt,
  };
  const status: ToolStatus = truncated ? "partial" : "succeeded";
  return finish(
    startedAt,
    now,
    status,
    data,
    truncated
      ? [
          {
            code: "public_source_text_truncated",
            severity: "info",
            message: "The fetched body was safely bounded before evidence extraction.",
            retryable: false,
          },
        ]
      : [],
    fetched.requests,
    fetched.bytesRead,
    truncated,
  );
}

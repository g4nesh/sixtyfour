import {
  createToolMeta,
  isoTime,
  reserveToolBudget,
  toolClock,
  type CandidateLink,
  type ToolContext,
  type ToolDiagnostic,
  type ToolEvidence,
  type ToolResult,
  type ToolStatus,
} from "./contracts";
import { createHardenedFetch, HardenedFetchError, isBlockedIpAddress } from "./hardened-fetch";

export type WaybackCandidateBasis =
  | "resolved_candidate_profile"
  | "verified_organization_domain"
  | "user_supplied_candidate_url"
  | "cross_source_url_match";

export interface WaybackHistoryInput {
  url: string;
  candidate: CandidateLink & { basis: WaybackCandidateBasis };
}

export interface WaybackHistoryOptions {
  maxCaptures?: number;
  maxSnapshots?: number;
  from?: string;
  to?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxSnapshotBytes?: number;
  maxExcerptCharacters?: number;
}

export interface WaybackCaptureGroup {
  digest: string;
  originalUrl: string;
  mimeType: string;
  firstTimestamp: string;
  lastTimestamp: string;
  firstCaptureUrl: string;
  lastCaptureUrl: string;
  adjacentCaptureCount: number;
  reportedLength: number | null;
}

export interface WaybackHistoryData {
  targetUrl: string;
  candidate: CandidateLink;
  captures: WaybackCaptureGroup[];
  rawRowsAccepted: number;
  uniqueDigests: number;
  snapshots: WaybackSnapshot[];
  temporalChange: WaybackTemporalChange | null;
  bounded: boolean;
  scopeNote: string;
}

export interface WaybackSnapshot {
  digest: string;
  timestamp: string;
  captureUrl: string;
  contentHashSha256: string;
  textExcerpt: string | null;
}

export interface WaybackTemporalChange {
  then: WaybackSnapshot;
  now: WaybackSnapshot;
}

const CANDIDATE_BASES = new Set<WaybackCandidateBasis>([
  "resolved_candidate_profile",
  "verified_organization_domain",
  "user_supplied_candidate_url",
  "cross_source_url_match",
]);

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value as number)));
}

function finish(
  startedAt: number,
  now: () => number,
  status: ToolStatus,
  data: WaybackHistoryData | null,
  evidence: ToolEvidence[],
  diagnostics: ToolDiagnostic[],
  requests: number,
  bytesRead: number,
  incomplete: boolean,
): ToolResult<WaybackHistoryData> {
  const finishedAt = now();
  return {
    ok: status !== "failed" && status !== "rate_limited",
    status,
    data,
    evidence,
    diagnostics,
    meta: createToolMeta(startedAt, finishedAt, requests, bytesRead, incomplete),
  };
}

function normalizeTarget(value: string): URL | null {
  if (value.length > 2_048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    const port = url.port ? Number(url.port) : 443;
    if (port !== 443) return null;
    const hostname = url.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "");
    if (
      !hostname ||
      !hostname.includes(".") ||
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname.endsWith(".local") ||
      hostname.endsWith(".internal") ||
      hostname.endsWith(".home.arpa") ||
      isBlockedIpAddress(hostname)
    )
      return null;
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function validCdxDate(value: string | undefined): string | null {
  if (value === undefined) return null;
  return /^\d{1,14}$/.test(value) ? value : null;
}

function parseTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{14}$/.test(value)) return null;
  const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(8, 10)}:${value.slice(10, 12)}:${value.slice(12, 14)}.000Z`;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

function compactTimestamp(timestamp: string): string {
  return timestamp.replace(/[-:T.Z]/g, "").slice(0, 14);
}

function captureUrl(timestamp: string, original: string, raw = false): string {
  return `https://web.archive.org/web/${compactTimestamp(timestamp)}${raw ? "id_" : ""}/${original}`;
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const hexadecimal = entity[1]?.toLowerCase() === "x";
      const codePoint = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      if (Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff) {
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return match;
        }
      }
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function stripUnsafeControls(value: string): string {
  return [...value]
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      const disallowedAscii = (codePoint < 32 && ![9, 10, 13].includes(codePoint)) || codePoint === 127;
      const directionalOverride =
        (codePoint >= 0x202a && codePoint <= 0x202e) || (codePoint >= 0x2066 && codePoint <= 0x2069);
      return !disallowedAscii && !directionalOverride;
    })
    .join("");
}

/** Small dependency-free extractor; output is corroborating context, never a full-page quote. */
export function extractSnapshotText(html: string, maximumCharacters = 360): string | null {
  const withoutInactiveContent = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  const text = stripUnsafeControls(decodeHtmlEntities(withoutInactiveContent.replace(/<[^>]+>/g, " ")))
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.slice(0, Math.max(80, Math.min(20_000, Math.trunc(maximumCharacters))));
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

interface SnapshotSelection {
  capture: WaybackCaptureGroup;
  timestamp: string;
}

function selectSnapshots(captures: readonly WaybackCaptureGroup[], maximum: number): SnapshotSelection[] {
  if (captures.length === 0 || maximum <= 0) return [];
  const oldest = [...captures].sort((left, right) => left.firstTimestamp.localeCompare(right.firstTimestamp))[0];
  const newest = [...captures].sort((left, right) => right.lastTimestamp.localeCompare(left.lastTimestamp))[0];
  if (maximum === 1) return [{ capture: newest, timestamp: newest.lastTimestamp }];
  const selected: SnapshotSelection[] = [
    { capture: oldest, timestamp: oldest.firstTimestamp },
    { capture: newest, timestamp: newest.lastTimestamp },
  ];
  return selected
    .filter(
      (item, index) =>
        selected.findIndex(
          (candidate) => candidate.capture.digest === item.capture.digest && candidate.timestamp === item.timestamp,
        ) === index,
    )
    .slice(0, maximum);
}

interface AcceptedRow {
  digest: string;
  timestamp: string;
  original: string;
  mimeType: string;
  length: number | null;
}

function parseRows(payload: unknown): { rows: AcceptedRow[]; malformed: number } | null {
  if (!Array.isArray(payload) || payload.length === 0 || !Array.isArray(payload[0])) return null;
  const header = payload[0].map((value) => String(value));
  const index = (field: string) => header.indexOf(field);
  const required = ["timestamp", "original", "mimetype", "statuscode", "digest", "length"];
  if (required.some((field) => index(field) < 0)) return null;
  const rows: AcceptedRow[] = [];
  let malformed = 0;
  for (const item of payload.slice(1)) {
    if (!Array.isArray(item)) {
      malformed += 1;
      continue;
    }
    const timestamp = parseTimestamp(item[index("timestamp")]);
    const original = typeof item[index("original")] === "string" ? normalizeTarget(item[index("original")]) : null;
    const mimeType = typeof item[index("mimetype")] === "string" ? item[index("mimetype")].toLowerCase() : "";
    const statusCode = String(item[index("statuscode")] ?? "");
    const digest = typeof item[index("digest")] === "string" ? item[index("digest")].trim() : "";
    const rawLength = Number(item[index("length")]);
    if (!timestamp || !original || statusCode !== "200" || mimeType !== "text/html" || !digest) {
      malformed += 1;
      continue;
    }
    rows.push({
      timestamp,
      original: original.href,
      mimeType,
      digest,
      length: Number.isFinite(rawLength) && rawLength >= 0 ? Math.trunc(rawLength) : null,
    });
  }
  return { rows, malformed };
}

function collapseDigests(rows: readonly AcceptedRow[], limit: number): WaybackCaptureGroup[] {
  const groups = new Map<string, WaybackCaptureGroup>();
  for (const row of rows) {
    const key = row.digest === "-" ? `${row.timestamp}|${row.original}` : row.digest;
    const existing = groups.get(key);
    if (existing) {
      existing.adjacentCaptureCount += 1;
      if (row.timestamp > existing.lastTimestamp) {
        existing.lastTimestamp = row.timestamp;
        existing.lastCaptureUrl = captureUrl(row.timestamp, row.original);
      }
      continue;
    }
    groups.set(key, {
      digest: row.digest,
      originalUrl: row.original,
      mimeType: row.mimeType,
      firstTimestamp: row.timestamp,
      lastTimestamp: row.timestamp,
      firstCaptureUrl: captureUrl(row.timestamp, row.original),
      lastCaptureUrl: captureUrl(row.timestamp, row.original),
      adjacentCaptureCount: 1,
      reportedLength: row.length,
    });
  }
  return [...groups.values()]
    .sort((left, right) => left.firstTimestamp.localeCompare(right.firstTimestamp))
    .slice(0, limit);
}

/** Bounded temporal corroboration for a URL already linked to one candidate. */
export async function inspectWaybackHistory(
  input: WaybackHistoryInput,
  context: ToolContext = {},
  options: WaybackHistoryOptions = {},
): Promise<ToolResult<WaybackHistoryData>> {
  const now = toolClock(context);
  const startedAt = now();
  if (!input.candidate?.candidateId?.trim() || !CANDIDATE_BASES.has(input.candidate.basis)) {
    return finish(
      startedAt,
      now,
      "skipped",
      null,
      [],
      [
        {
          code: "candidate_link_required",
          severity: "warning",
          message: "Wayback history may run only after the URL is linked to a resolved candidate.",
          retryable: false,
        },
      ],
      0,
      0,
      false,
    );
  }
  const target = normalizeTarget(input.url);
  if (!target) {
    return finish(
      startedAt,
      now,
      "skipped",
      null,
      [],
      [
        {
          code: "invalid_candidate_url",
          severity: "warning",
          message: "Wayback history requires a public HTTPS candidate URL on port 443.",
          retryable: false,
        },
      ],
      0,
      0,
      false,
    );
  }
  const from = validCdxDate(options.from);
  const to = validCdxDate(options.to);
  if ((options.from !== undefined && from === null) || (options.to !== undefined && to === null)) {
    return finish(
      startedAt,
      now,
      "skipped",
      null,
      [],
      [
        {
          code: "invalid_wayback_range",
          severity: "warning",
          message: "Wayback date bounds must contain 1-14 digits in CDX timestamp format.",
          retryable: false,
        },
      ],
      0,
      0,
      false,
    );
  }
  const maxCaptures = bounded(options.maxCaptures, 6, 1, 12);
  const maxSnapshots = bounded(options.maxSnapshots, 2, 0, 2);
  const queryLimit = Math.min(48, maxCaptures * 4);
  const maxResponseBytes = bounded(options.maxResponseBytes, 600_000, 8_192, 2_000_000);

  const query = new URL("https://web.archive.org/cdx/search/cdx");
  query.searchParams.set("url", target.href);
  query.searchParams.set("matchType", "exact");
  query.searchParams.set("output", "json");
  query.searchParams.set("fl", "timestamp,original,mimetype,statuscode,digest,length");
  query.searchParams.append("filter", "statuscode:200");
  query.searchParams.append("filter", "mimetype:text/html");
  query.searchParams.set("collapse", "digest");
  query.searchParams.set("limit", String(queryLimit));
  query.searchParams.set("gzip", "false");
  if (from) query.searchParams.set("from", from);
  if (to) query.searchParams.set("to", to);

  const fetchWayback = createHardenedFetch({
    allowedHostnames: ["web.archive.org"],
    allowedMethods: ["GET"],
    allowedMimeTypes: ["application/json", "text/json", "text/plain"],
    timeoutMs: bounded(options.timeoutMs, 10_000, 500, 30_000),
    maxBytes: maxResponseBytes,
    maxRedirects: 0,
    maxRetries: 2,
    maxRetryAfterMs: 5_000,
    fetch: context.fetch,
    clock: now,
    beforeRequest: () =>
      reserveToolBudget(context, {
        tool: "wayback_candidate_history",
        networkRequests: 1,
        expectedBytes: maxResponseBytes,
      }),
  });
  let response;
  try {
    response = await fetchWayback(query, { signal: context.signal });
  } catch (error) {
    const budgetExhausted = error instanceof HardenedFetchError && error.code === "budget_exhausted";
    return finish(
      startedAt,
      now,
      budgetExhausted ? "skipped" : "failed",
      null,
      [],
      [
        {
          code: error instanceof HardenedFetchError ? error.code : "wayback_unavailable",
          severity: budgetExhausted ? "info" : "warning",
          message: budgetExhausted
            ? "Wayback lookup was skipped because the network budget was exhausted."
            : "Wayback history was unavailable; the investigation can continue without temporal corroboration.",
          retryable: error instanceof HardenedFetchError && error.retryable,
        },
      ],
      error instanceof HardenedFetchError ? error.requests : 0,
      0,
      true,
    );
  }
  if (response.response.status === 429) {
    return finish(
      startedAt,
      now,
      "rate_limited",
      null,
      [],
      [
        {
          code: "wayback_rate_limited",
          severity: "warning",
          message: "Wayback rate-limited temporal history; the investigation can continue without it.",
          retryable: true,
        },
      ],
      response.requests,
      response.bytesRead,
      true,
    );
  }
  if (!response.response.ok) {
    return finish(
      startedAt,
      now,
      "failed",
      null,
      [],
      [
        {
          code: "wayback_http_error",
          severity: "warning",
          message: `Wayback history returned HTTP ${response.response.status}; temporal corroboration is unavailable.`,
          retryable: response.response.status >= 500,
        },
      ],
      response.requests,
      response.bytesRead,
      true,
    );
  }
  let payload: unknown;
  try {
    payload = await response.response.json();
  } catch {
    return finish(
      startedAt,
      now,
      "failed",
      null,
      [],
      [
        {
          code: "wayback_invalid_json",
          severity: "warning",
          message: "Wayback returned malformed history data; the investigation can continue without it.",
          retryable: true,
        },
      ],
      response.requests,
      response.bytesRead,
      true,
    );
  }
  const parsed = parseRows(payload);
  if (!parsed) {
    return finish(
      startedAt,
      now,
      "failed",
      null,
      [],
      [
        {
          code: "wayback_invalid_response",
          severity: "warning",
          message: "Wayback returned an unexpected history schema.",
          retryable: false,
        },
      ],
      response.requests,
      response.bytesRead,
      true,
    );
  }
  const captures = collapseDigests(parsed.rows, maxCaptures);
  const boundedResult = parsed.rows.length >= queryLimit || captures.length >= maxCaptures;
  const diagnostics: ToolDiagnostic[] = [];
  if (parsed.malformed)
    diagnostics.push({
      code: "wayback_rows_discarded",
      severity: "warning",
      message: "Malformed or out-of-policy Wayback rows were discarded.",
      retryable: false,
      details: { count: parsed.malformed },
    });
  if (boundedResult)
    diagnostics.push({
      code: "wayback_bounded_results",
      severity: "info",
      message: "Wayback history was intentionally bounded and may not include every archived version.",
      retryable: false,
      details: { returned: captures.length },
    });
  if (captures.length === 0)
    diagnostics.push({
      code: "wayback_captures_not_observed",
      severity: "info",
      message:
        "No qualifying HTML captures were observed in this bounded query; this does not prove no archive history exists.",
      retryable: false,
    });

  let requests = response.requests;
  let bytesRead = response.bytesRead;
  let snapshotIncomplete = false;
  const snapshots: WaybackSnapshot[] = [];
  const maximumSnapshotBytes = bounded(options.maxSnapshotBytes, 220_000, 8_192, 500_000);
  const maximumExcerptCharacters = bounded(options.maxExcerptCharacters, 360, 80, 1_000);
  const selectedSnapshots = selectSnapshots(captures, maxSnapshots);
  const fetchSnapshot = createHardenedFetch({
    allowedHostnames: ["web.archive.org"],
    allowedMethods: ["GET"],
    allowedMimeTypes: ["text/html", "application/xhtml+xml"],
    timeoutMs: bounded(options.timeoutMs, 10_000, 500, 30_000),
    maxBytes: maximumSnapshotBytes,
    maxRedirects: 1,
    maxRetries: 1,
    maxRetryAfterMs: 5_000,
    fetch: context.fetch,
    clock: now,
    beforeRequest: () =>
      reserveToolBudget(context, {
        tool: "wayback_snapshot",
        networkRequests: 1,
        expectedBytes: maximumSnapshotBytes,
      }),
  });
  for (const { capture, timestamp } of selectedSnapshots) {
    const rawUrl = captureUrl(timestamp, capture.originalUrl, true);
    try {
      const snapshotResponse = await fetchSnapshot(rawUrl, { signal: context.signal });
      requests += snapshotResponse.requests;
      bytesRead += snapshotResponse.bytesRead;
      if (snapshotResponse.response.status === 429) {
        snapshotIncomplete = true;
        diagnostics.push({
          code: "wayback_snapshot_rate_limited",
          severity: "warning",
          message: "Wayback rate-limited bounded snapshot retrieval; no temporal comparison was inferred.",
          retryable: true,
        });
        break;
      }
      if (!snapshotResponse.response.ok) {
        snapshotIncomplete = true;
        diagnostics.push({
          code: "wayback_snapshot_http_error",
          severity: "warning",
          message: `A selected Wayback snapshot returned HTTP ${snapshotResponse.response.status}.`,
          retryable: snapshotResponse.response.status >= 500,
        });
        continue;
      }
      const html = await snapshotResponse.response.text();
      const normalizedText = extractSnapshotText(html, 20_000);
      const contentHashSha256 = await sha256(normalizedText ?? html);
      snapshots.push({
        digest: capture.digest,
        timestamp,
        captureUrl: captureUrl(timestamp, capture.originalUrl),
        contentHashSha256,
        textExcerpt: normalizedText?.slice(0, maximumExcerptCharacters) ?? null,
      });
    } catch (error) {
      if (error instanceof HardenedFetchError) requests += error.requests;
      snapshotIncomplete = true;
      const budgetExhausted = error instanceof HardenedFetchError && error.code === "budget_exhausted";
      diagnostics.push({
        code: budgetExhausted ? "wayback_snapshot_budget_exhausted" : "wayback_snapshot_unavailable",
        severity: budgetExhausted ? "info" : "warning",
        message: budgetExhausted
          ? "Remaining Wayback snapshots were skipped because the network budget was exhausted."
          : "A selected Wayback snapshot was unavailable; no change was inferred from that capture.",
        retryable: error instanceof HardenedFetchError && error.retryable,
      });
      if (budgetExhausted) break;
    }
  }
  snapshots.sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const temporalChange =
    snapshots.length >= 2 &&
    snapshots[0].textExcerpt !== null &&
    snapshots[snapshots.length - 1].textExcerpt !== null &&
    snapshots[0].contentHashSha256 !== snapshots[snapshots.length - 1].contentHashSha256
      ? { then: snapshots[0], now: snapshots[snapshots.length - 1] }
      : null;

  const observedAt = isoTime(now());
  const evidence: ToolEvidence[] = captures.map((capture) => ({
    sourceUrl: capture.lastCaptureUrl,
    sourceType: "wayback_cdx_capture",
    title: `Wayback index record for ${target.hostname}`,
    observedAt,
    attributes: {
      targetUrl: target.href,
      digest: capture.digest,
      firstTimestamp: capture.firstTimestamp,
      lastTimestamp: capture.lastTimestamp,
      duplicateRowsCollapsed: Math.max(0, capture.adjacentCaptureCount - 1),
      reportedLength: capture.reportedLength,
    },
    candidate: input.candidate,
    // Archive presence corroborates URL history, not the person's identity.
    confidenceCap: 0.66,
  }));
  for (const snapshot of snapshots) {
    evidence.push({
      sourceUrl: snapshot.captureUrl,
      sourceType: "wayback_snapshot",
      title: `Retrieved archived snapshot of ${target.hostname}`,
      observedAt,
      ...(snapshot.textExcerpt ? { excerpt: snapshot.textExcerpt } : {}),
      attributes: {
        targetUrl: target.href,
        digest: snapshot.digest,
        timestamp: snapshot.timestamp,
        contentHashSha256: snapshot.contentHashSha256,
        temporalChangeObserved: temporalChange !== null,
        untrustedContent: true,
      },
      candidate: input.candidate,
      confidenceCap: 0.66,
    });
  }
  const data: WaybackHistoryData = {
    targetUrl: target.href,
    candidate: input.candidate,
    captures,
    rawRowsAccepted: parsed.rows.length,
    uniqueDigests: captures.length,
    snapshots,
    temporalChange,
    bounded: boundedResult,
    scopeNote:
      "CDX metadata establishes archive presence. Snapshot excerpts can show page changes but do not establish who controlled the page.",
  };
  const status: ToolStatus =
    captures.length === 0
      ? "not_found"
      : boundedResult || parsed.malformed > 0 || snapshotIncomplete
        ? "partial"
        : "succeeded";
  return finish(
    startedAt,
    now,
    status,
    data,
    evidence,
    diagnostics,
    requests,
    bytesRead,
    boundedResult || parsed.malformed > 0 || snapshotIncomplete,
  );
}

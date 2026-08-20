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
import { containsRestrictedPublicContent, urlContainsRestrictedParameters } from "../domain/content-policy";
import { createHardenedFetch, HardenedFetchError, isBlockedIpAddress } from "./hardened-fetch";
import { decodeHtmlTextForPolicy, projectInertHtml } from "./inert-html";

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
  maxComparisonCharacters?: number;
  maxChangedFragments?: number;
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
  /** Exact hardened CDX URL dispatched by this adapter, including every bound and filter. */
  cdxRequestUrl: string;
  candidate: CandidateLink;
  captures: WaybackCaptureGroup[];
  rawRowsAccepted: number;
  uniqueDigests: number;
  captureTimeline: WaybackCaptureObservation[];
  snapshotSelection: WaybackSnapshotSelection;
  snapshots: WaybackSnapshot[];
  temporalChange: WaybackTemporalChange | null;
  bounded: boolean;
  scopeNote: string;
}

export interface WaybackCaptureObservation {
  digest: string;
  timestamp: string;
  captureUrl: string;
  reportedLength: number | null;
}

export interface WaybackSnapshotSelection {
  strategy:
    | "none"
    | "latest_only"
    | "single_observed_capture"
    | "earliest_to_latest_same_digest"
    | "earliest_distinct_digest_to_latest";
  /** Selection is deterministic only within the bounded exact CDX rows returned. */
  boundedToReturnedRows: true;
  earliestObservedTimestamp: string | null;
  latestObservedTimestamp: string | null;
  selectedTimestamps: string[];
}

export interface WaybackSnapshotMetadata {
  title: string | null;
  description: string | null;
  canonicalUrl: string | null;
  language: string | null;
  publishedAt: string | null;
  modifiedAt: string | null;
}

export interface WaybackSnapshotStructure {
  tagCount: number;
  headingCount: number;
  paragraphCount: number;
  linkCount: number;
  imageCount: number;
  formCount: number;
  inputCount: number;
  scriptCount: number;
  stylesheetCount: number;
  iframeCount: number;
  headingLevels: string[];
  sequenceTruncated: boolean;
}

export interface WaybackSnapshot {
  digest: string;
  timestamp: string;
  captureUrl: string;
  /** SHA-256 of the exact bounded raw response body returned by the archive. */
  bodyHashSha256: string;
  /** SHA-256 of the bounded normalized static-HTML text projection. */
  contentHashSha256: string;
  metadataHashSha256: string;
  structureHashSha256: string;
  responseContentType: string;
  decodedCharset: string;
  metadata: WaybackSnapshotMetadata;
  structure: WaybackSnapshotStructure;
  /** Characters retained in the bounded normalized static-HTML text projection. */
  textLength: number;
  textTruncated: boolean;
  textExcerpt: string | null;
}

export interface WaybackTemporalChange {
  then: WaybackSnapshot;
  now: WaybackSnapshot;
  bodyChanged: boolean;
  visibleTextChanged: boolean;
  metadataChanged: boolean;
  structureChanged: boolean;
  changedMetadataFields: Array<keyof WaybackSnapshotMetadata>;
  addedTextFragments: string[];
  removedTextFragments: string[];
  addedFragmentCount: number;
  removedFragmentCount: number;
  unchangedFragmentCount: number;
  comparisonBounded: boolean;
  scopeNote: string;
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
    if (urlContainsRestrictedParameters(url.href)) return null;
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

function escapeCdxFilterLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizedSnapshotText(html: string): string {
  const withoutInactiveContent = stripInactiveMarkup(html);
  const decoded = decodeHtmlTextForPolicy(withoutInactiveContent.replace(/<[^>]+>/g, " "));
  if (decoded === null) return "";
  return decoded.normalize("NFKC").replace(/\s+/g, " ").trim();
}

/** Small dependency-free extractor; output is corroborating context, never a full-page quote. */
export function extractSnapshotText(html: string, maximumCharacters = 360): string | null {
  const text = normalizedSnapshotText(html);
  if (!text) return null;
  return text.slice(0, Math.max(80, Math.min(50_001, Math.trunc(maximumCharacters))));
}

async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const ownedBytes = new Uint8Array(bytes.byteLength);
  ownedBytes.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", ownedBytes.buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safePageText(value: string | undefined, maximum: number): string | null {
  if (!value) return null;
  const text = normalizedSnapshotText(value);
  if (!text || containsRestrictedPublicContent(text)) return null;
  return text.slice(0, maximum);
}

function stripInactiveMarkup(html: string, retainContainerTags = false): string {
  const projection = projectInertHtml(html);
  return retainContainerTags ? projection.structuralHtml : projection.passiveHtml;
}

function parseTagAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1]?.toLowerCase();
    if (!name || attributes.has(name)) continue;
    const decoded = decodeHtmlTextForPolicy(match[2] ?? match[3] ?? match[4] ?? "");
    if (decoded !== null) attributes.set(name, decoded);
  }
  return attributes;
}

function pageDeclaredDate(value: string | null): string | null {
  if (!value || value.length > 80) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function exactCanonicalMetadata(value: string | null, target: URL): string | null {
  if (!value || value.length > 2_048) return null;
  try {
    const candidate = new URL(value, target);
    candidate.hash = "";
    if (
      candidate.protocol !== "https:" ||
      candidate.username ||
      candidate.password ||
      urlContainsRestrictedParameters(candidate.href) ||
      candidate.href !== target.href
    )
      return null;
    return candidate.href;
  } catch {
    return null;
  }
}

function extractSnapshotMetadata(html: string, target: URL): WaybackSnapshotMetadata {
  const projection = projectInertHtml(html);
  const passiveHtml = projection.passiveHtml;
  const metadataHtml = passiveHtml.match(/<head\b[^>]*>([\s\S]*?)<\/head\s*>/i)?.[1] ?? passiveHtml.slice(0, 50_000);
  const titleMetadataHtml =
    projection.titleHtml.match(/<head\b[^>]*>([\s\S]*?)<\/head\s*>/i)?.[1] ?? projection.titleHtml;
  const title = safePageText(titleMetadataHtml.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1], 240);
  let description: string | null = null;
  let publishedAt: string | null = null;
  let modifiedAt: string | null = null;
  for (const match of metadataHtml.matchAll(/<meta\b([^>]*)>/gi)) {
    const attributes = parseTagAttributes(match[1] ?? "");
    const key = (attributes.get("name") ?? attributes.get("property") ?? attributes.get("itemprop") ?? "")
      .trim()
      .toLowerCase();
    const content = attributes.get("content") ?? null;
    if (!description && (key === "description" || key === "og:description")) {
      description = safePageText(content ?? undefined, 500);
    }
    if (!publishedAt && ["article:published_time", "datepublished", "publishdate"].includes(key)) {
      publishedAt = pageDeclaredDate(content);
    }
    if (!modifiedAt && ["article:modified_time", "datemodified", "last-modified"].includes(key)) {
      modifiedAt = pageDeclaredDate(content);
    }
  }
  let canonicalUrl: string | null = null;
  for (const match of metadataHtml.matchAll(/<link\b([^>]*)>/gi)) {
    const attributes = parseTagAttributes(match[1] ?? "");
    const relations = (attributes.get("rel") ?? "").toLowerCase().split(/\s+/);
    if (!relations.includes("canonical")) continue;
    canonicalUrl = exactCanonicalMetadata(attributes.get("href") ?? null, target);
    if (canonicalUrl) break;
  }
  const htmlAttributes = parseTagAttributes(passiveHtml.match(/<html\b([^>]*)>/i)?.[1] ?? "");
  const declaredLanguage = htmlAttributes.get("lang")?.trim() ?? "";
  const language = /^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,2}$/i.test(declaredLanguage)
    ? declaredLanguage.toLowerCase()
    : null;
  return { title, description, canonicalUrl, language, publishedAt, modifiedAt };
}

const STRUCTURE_TAGS = new Set([
  "a",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "iframe",
  "img",
  "input",
  "link",
  "p",
  "script",
]);

function extractSnapshotStructure(html: string): { summary: WaybackSnapshotStructure; signature: string } {
  const structuralHtml = stripInactiveMarkup(html, true);
  const sequence: string[] = [];
  const counts = new Map<string, number>();
  let tagCount = 0;
  let structuralTagCount = 0;
  let stylesheetCount = 0;
  for (const match of structuralHtml.matchAll(/<\s*([a-z][a-z0-9:-]*)\b([^>]*)>/gi)) {
    const tag = match[1].toLowerCase();
    tagCount += 1;
    counts.set(tag, (counts.get(tag) ?? 0) + 1);
    if (STRUCTURE_TAGS.has(tag)) {
      structuralTagCount += 1;
      if (sequence.length < 4_096) sequence.push(tag);
    }
    if (tag === "link") {
      const relations = (parseTagAttributes(match[2] ?? "").get("rel") ?? "").toLowerCase().split(/\s+/);
      if (relations.includes("stylesheet")) stylesheetCount += 1;
    }
  }
  const headingLevels = sequence.filter((tag) => /^h[1-6]$/.test(tag)).slice(0, 32);
  const summary: WaybackSnapshotStructure = {
    tagCount,
    headingCount: [...counts.entries()].reduce((total, [tag, count]) => total + (/^h[1-6]$/.test(tag) ? count : 0), 0),
    paragraphCount: counts.get("p") ?? 0,
    linkCount: counts.get("a") ?? 0,
    imageCount: counts.get("img") ?? 0,
    formCount: counts.get("form") ?? 0,
    inputCount: counts.get("input") ?? 0,
    scriptCount: counts.get("script") ?? 0,
    stylesheetCount,
    iframeCount: counts.get("iframe") ?? 0,
    headingLevels,
    sequenceTruncated: structuralTagCount > sequence.length,
  };
  return { summary, signature: JSON.stringify({ ...summary, sequence }) };
}

function extractTextFragments(html: string, maximumCharacters: number): { fragments: string[]; truncated: boolean } {
  const fragments: string[] = [];
  let consumed = 0;
  let truncated = false;
  const passiveHtml = stripInactiveMarkup(html);
  const pattern = /<(h[1-6]|p|li|dt|dd|blockquote|figcaption|td|th)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  for (const match of passiveHtml.matchAll(pattern)) {
    if (fragments.length >= 256 || consumed >= maximumCharacters) {
      truncated = true;
      continue;
    }
    const fragment = safePageText(match[2], 320);
    if (!fragment) continue;
    const boundedFragment = fragment.slice(0, Math.min(320, Math.max(0, maximumCharacters - consumed)));
    if (!boundedFragment) continue;
    fragments.push(boundedFragment);
    consumed += boundedFragment.length;
  }
  return { fragments, truncated };
}

interface SnapshotAnalysis {
  snapshot: WaybackSnapshot;
  fragments: string[];
  fragmentsTruncated: boolean;
}

function snapshotDecoder(contentType: string): { decoder: TextDecoder; charset: string; mimeType: string } {
  const declaredMimeType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  const mimeType = declaredMimeType === "application/xhtml+xml" ? declaredMimeType : "text/html";
  const declared = contentType.match(/(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/i)?.[1]?.toLowerCase() ?? "utf-8";
  const permitted = new Set(["utf-8", "utf8", "us-ascii", "windows-1252", "iso-8859-1"]);
  const charset = permitted.has(declared) ? declared : "utf-8";
  try {
    return { decoder: new TextDecoder(charset, { fatal: false }), charset, mimeType };
  } catch {
    return { decoder: new TextDecoder("utf-8", { fatal: false }), charset: "utf-8", mimeType };
  }
}

async function analyzeSnapshot(
  body: Uint8Array,
  responseContentType: string,
  target: URL,
  identity: Pick<WaybackSnapshot, "digest" | "timestamp" | "captureUrl">,
  maximumExcerptCharacters: number,
  maximumComparisonCharacters: number,
): Promise<SnapshotAnalysis> {
  const decoding = snapshotDecoder(responseContentType);
  const html = decoding.decoder.decode(body);
  const projectedText = extractSnapshotText(html, maximumComparisonCharacters + 1);
  const textTruncated = (projectedText?.length ?? 0) > maximumComparisonCharacters;
  const visibleText = projectedText?.slice(0, maximumComparisonCharacters) ?? "";
  const metadata = extractSnapshotMetadata(html, target);
  const structure = extractSnapshotStructure(html);
  const fragmentProjection = extractTextFragments(html, maximumComparisonCharacters);
  const safeFallbackFragment = safePageText(html, 320);
  const snapshot: WaybackSnapshot = {
    ...identity,
    bodyHashSha256: await sha256(body),
    contentHashSha256: await sha256(visibleText),
    metadataHashSha256: await sha256(JSON.stringify(metadata)),
    structureHashSha256: await sha256(structure.signature),
    responseContentType: `${decoding.mimeType}; charset=${decoding.charset}`,
    decodedCharset: decoding.charset,
    metadata,
    structure: structure.summary,
    textLength: visibleText.length,
    textTruncated,
    textExcerpt: safePageText(html, maximumExcerptCharacters),
  };
  return {
    snapshot,
    fragments:
      fragmentProjection.fragments.length > 0
        ? fragmentProjection.fragments
        : safeFallbackFragment
          ? [safeFallbackFragment]
          : [],
    fragmentsTruncated: fragmentProjection.truncated || textTruncated,
  };
}

function multisetDifference(
  source: readonly string[],
  comparison: readonly string[],
  maximumSamples: number,
): { count: number; samples: string[] } {
  const remaining = new Map<string, number>();
  for (const fragment of comparison) remaining.set(fragment, (remaining.get(fragment) ?? 0) + 1);
  let count = 0;
  const samples: string[] = [];
  for (const fragment of source) {
    const available = remaining.get(fragment) ?? 0;
    if (available > 0) {
      remaining.set(fragment, available - 1);
      continue;
    }
    count += 1;
    if (samples.length < maximumSamples) samples.push(fragment.slice(0, 320));
  }
  return { count, samples };
}

const METADATA_FIELDS: Array<keyof WaybackSnapshotMetadata> = [
  "title",
  "description",
  "canonicalUrl",
  "language",
  "publishedAt",
  "modifiedAt",
];

function compareSnapshots(
  then: SnapshotAnalysis,
  now: SnapshotAnalysis,
  maximumChangedFragments: number,
): WaybackTemporalChange | null {
  const bodyChanged = then.snapshot.bodyHashSha256 !== now.snapshot.bodyHashSha256;
  const visibleTextChanged = then.snapshot.contentHashSha256 !== now.snapshot.contentHashSha256;
  const metadataChanged = then.snapshot.metadataHashSha256 !== now.snapshot.metadataHashSha256;
  const structureChanged = then.snapshot.structureHashSha256 !== now.snapshot.structureHashSha256;
  if (!bodyChanged && !visibleTextChanged && !metadataChanged && !structureChanged) return null;
  const removed = multisetDifference(then.fragments, now.fragments, maximumChangedFragments);
  const added = multisetDifference(now.fragments, then.fragments, maximumChangedFragments);
  const thenCounts = new Map<string, number>();
  const nowCounts = new Map<string, number>();
  for (const fragment of then.fragments) thenCounts.set(fragment, (thenCounts.get(fragment) ?? 0) + 1);
  for (const fragment of now.fragments) nowCounts.set(fragment, (nowCounts.get(fragment) ?? 0) + 1);
  const unchangedFragmentCount = [...thenCounts].reduce(
    (total, [fragment, count]) => total + Math.min(count, nowCounts.get(fragment) ?? 0),
    0,
  );
  return {
    then: then.snapshot,
    now: now.snapshot,
    bodyChanged,
    visibleTextChanged,
    metadataChanged,
    structureChanged,
    changedMetadataFields: METADATA_FIELDS.filter(
      (field) => then.snapshot.metadata[field] !== now.snapshot.metadata[field],
    ),
    addedTextFragments: added.samples,
    removedTextFragments: removed.samples,
    addedFragmentCount: added.count,
    removedFragmentCount: removed.count,
    unchangedFragmentCount,
    comparisonBounded:
      then.fragmentsTruncated ||
      now.fragmentsTruncated ||
      added.count > added.samples.length ||
      removed.count > removed.samples.length,
    scopeNote:
      "The body hash compares exact retrieved raw capture bytes. Text and structure are bounded deterministic HTML projections; missing assets, client-side API state, archive completeness, authorship, and page control are not inferred.",
  };
}

interface AcceptedRow {
  digest: string;
  timestamp: string;
  original: string;
  mimeType: string;
  length: number | null;
}

function parseRows(payload: unknown, exactTargetUrl: string): { rows: AcceptedRow[]; malformed: number } | null {
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
    if (
      !timestamp ||
      !original ||
      original.href !== exactTargetUrl ||
      statusCode !== "200" ||
      mimeType !== "text/html" ||
      !digest ||
      digest.length > 128 ||
      !/^[a-z0-9._:+\-=]+$/i.test(digest)
    ) {
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
  const deduplicated = [
    ...new Map(
      rows
        .sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.digest.localeCompare(right.digest))
        .map((row) => [`${row.timestamp}|${row.digest}|${row.original}`, row]),
    ).values(),
  ];
  malformed += rows.length - deduplicated.length;
  return { rows: deduplicated, malformed };
}

function digestIdentity(row: AcceptedRow): string {
  return row.digest === "-" ? `unknown:${row.timestamp}` : row.digest;
}

function selectSnapshots(
  rows: readonly AcceptedRow[],
  maximum: number,
): { rows: AcceptedRow[]; selection: WaybackSnapshotSelection } {
  const ordered = [...rows].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const base = {
    boundedToReturnedRows: true as const,
    earliestObservedTimestamp: ordered[0]?.timestamp ?? null,
    latestObservedTimestamp: ordered.at(-1)?.timestamp ?? null,
  };
  if (ordered.length === 0 || maximum <= 0)
    return {
      rows: [],
      selection: { ...base, strategy: "none", selectedTimestamps: [] },
    };
  const newest = ordered[ordered.length - 1];
  if (maximum === 1)
    return {
      rows: [newest],
      selection: { ...base, strategy: "latest_only", selectedTimestamps: [newest.timestamp] },
    };
  // Compare the newest capture with the earliest observed different digest.
  // This keeps the pair temporally broad while avoiding a false "unchanged"
  // result when content changed and later reverted to its original digest.
  const earliestDifferent = ordered.find((row) => digestIdentity(row) !== digestIdentity(newest));
  const earlier = earliestDifferent ?? ordered[0];
  const selected = [earlier, newest].filter(
    (row, index, values) =>
      values.findIndex((candidate) => candidate.timestamp === row.timestamp && candidate.digest === row.digest) ===
      index,
  );
  const strategy =
    selected.length === 1
      ? "single_observed_capture"
      : earliestDifferent
        ? "earliest_distinct_digest_to_latest"
        : "earliest_to_latest_same_digest";
  return {
    rows: selected,
    selection: { ...base, strategy, selectedTimestamps: selected.map((row) => row.timestamp) },
  };
}

function boundWithEndpoints<T>(values: readonly T[], limit: number): T[] {
  if (values.length <= limit) return [...values];
  if (limit <= 1) return [values[values.length - 1]];
  const indexes = new Set<number>([0, values.length - 1]);
  for (let position = 1; position < limit - 1; position += 1) {
    indexes.add(Math.round((position * (values.length - 1)) / (limit - 1)));
  }
  return [...indexes]
    .sort((left, right) => left - right)
    .map((index) => values[index])
    .slice(0, limit);
}

function captureTimeline(rows: readonly AcceptedRow[], limit: number): WaybackCaptureObservation[] {
  const changes: AcceptedRow[] = [];
  for (const row of [...rows].sort((left, right) => left.timestamp.localeCompare(right.timestamp))) {
    if (changes.length > 0 && digestIdentity(changes[changes.length - 1]) === digestIdentity(row)) continue;
    changes.push(row);
  }
  return boundWithEndpoints(changes, limit).map((row) => ({
    digest: row.digest,
    timestamp: row.timestamp,
    captureUrl: captureUrl(row.timestamp, row.original),
    reportedLength: row.length,
  }));
}

function collapseDigests(rows: readonly AcceptedRow[], limit: number): WaybackCaptureGroup[] {
  const groups = new Map<string, WaybackCaptureGroup>();
  for (const row of rows) {
    const key = row.digest === "-" ? `${row.timestamp}|${row.original}` : row.digest;
    const existing = groups.get(key);
    if (existing) {
      existing.adjacentCaptureCount += 1;
      if (row.timestamp < existing.firstTimestamp) {
        existing.firstTimestamp = row.timestamp;
        existing.firstCaptureUrl = captureUrl(row.timestamp, row.original);
      }
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
  const ordered = [...groups.values()].sort((left, right) => left.firstTimestamp.localeCompare(right.firstTimestamp));
  if (ordered.length <= limit) return ordered;
  const oldest = ordered[0];
  const newest = [...ordered].sort(
    (left, right) =>
      right.lastTimestamp.localeCompare(left.lastTimestamp) || left.firstTimestamp.localeCompare(right.firstTimestamp),
  )[0];
  const retained = new Map<string, WaybackCaptureGroup>();
  for (const group of [oldest, newest, ...boundWithEndpoints(ordered, limit)]) {
    retained.set(`${group.digest}|${group.originalUrl}`, group);
    if (retained.size >= limit) break;
  }
  return [...retained.values()].sort((left, right) => left.firstTimestamp.localeCompare(right.firstTimestamp));
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
  const reversedRange = from !== null && to !== null && from.padEnd(14, "0").localeCompare(to.padEnd(14, "9")) > 0;
  if ((options.from !== undefined && from === null) || (options.to !== undefined && to === null) || reversedRange) {
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
          message: "Wayback date bounds must contain 1-14 digits in CDX timestamp format and form a forward range.",
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
  // CDX canonicalization can mix http/https, credentials, or host aliases even
  // with matchType=exact. Constrain the server-side window and still enforce
  // byte-for-byte URL equality again in parseRows before admission.
  query.searchParams.append("filter", `original:^${escapeCdxFilterLiteral(target.href)}$`);
  query.searchParams.set("collapse", "digest");
  // A negative CDX limit returns the newest bounded rows. The client then
  // compares the newest exact row with the earliest distinct digest within
  // that returned window; it never presents the pair as complete history.
  query.searchParams.set("limit", String(-queryLimit));
  query.searchParams.set("gzip", "false");
  if (from) query.searchParams.set("from", from);
  if (to) query.searchParams.set("to", to);
  // Evidence canonicalization sorts query parameters. Dispatch that same
  // stable order so the admitted queryUrl remains byte-equal to the request.
  query.searchParams.sort();

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
  const parsed = parseRows(payload, target.href);
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
  const timeline = captureTimeline(parsed.rows, maxCaptures);
  const uniqueDigests = new Set(parsed.rows.map(digestIdentity)).size;
  let observedChangePoints = 0;
  let priorDigest: string | null = null;
  for (const row of parsed.rows) {
    const identity = digestIdentity(row);
    if (identity === priorDigest) continue;
    observedChangePoints += 1;
    priorDigest = identity;
  }
  const boundedResult =
    parsed.rows.length >= queryLimit || uniqueDigests > captures.length || observedChangePoints > timeline.length;
  const diagnostics: ToolDiagnostic[] = [];
  if (parsed.malformed)
    diagnostics.push({
      code: "wayback_rows_discarded",
      severity: "warning",
      message: "Duplicate, malformed, foreign-URL, or otherwise out-of-policy Wayback rows were discarded.",
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
  const maximumComparisonCharacters = bounded(options.maxComparisonCharacters, 20_000, 1_000, 50_000);
  const maximumChangedFragments = bounded(options.maxChangedFragments, 6, 1, 12);
  const snapshotSelection = selectSnapshots(parsed.rows, maxSnapshots);
  const selectedSnapshots = snapshotSelection.rows;
  const fetchSnapshot = createHardenedFetch({
    allowedHostnames: ["web.archive.org"],
    allowedMethods: ["GET"],
    allowedMimeTypes: ["text/html", "application/xhtml+xml"],
    timeoutMs: bounded(options.timeoutMs, 10_000, 500, 30_000),
    maxBytes: maximumSnapshotBytes,
    // CDX supplied an exact capture timestamp. A redirect could silently
    // substitute another timestamp or original, so raw capture retrieval is
    // deliberately no-redirect.
    maxRedirects: 0,
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
  const snapshotAnalyses: SnapshotAnalysis[] = [];
  for (const selected of selectedSnapshots) {
    const rawUrl = captureUrl(selected.timestamp, selected.original, true);
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
      const body = new Uint8Array(await snapshotResponse.response.arrayBuffer());
      const analysis = await analyzeSnapshot(
        body,
        snapshotResponse.response.headers.get("content-type") ?? "text/html",
        target,
        {
          digest: selected.digest,
          timestamp: selected.timestamp,
          captureUrl: captureUrl(selected.timestamp, selected.original),
        },
        maximumExcerptCharacters,
        maximumComparisonCharacters,
      );
      snapshotAnalyses.push(analysis);
      snapshots.push(analysis.snapshot);
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
  snapshotAnalyses.sort((left, right) => left.snapshot.timestamp.localeCompare(right.snapshot.timestamp));
  const temporalChange =
    snapshotAnalyses.length >= 2
      ? compareSnapshots(snapshotAnalyses[0], snapshotAnalyses[snapshotAnalyses.length - 1], maximumChangedFragments)
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
    const temporalComparison =
      temporalChange?.now.timestamp === snapshot.timestamp
        ? {
            observedAfter: temporalChange.then.timestamp,
            observedOnOrBefore: temporalChange.now.timestamp,
            thenCaptureUrl: temporalChange.then.captureUrl,
            nowCaptureUrl: temporalChange.now.captureUrl,
            bodyChanged: temporalChange.bodyChanged,
            visibleTextChanged: temporalChange.visibleTextChanged,
            metadataChanged: temporalChange.metadataChanged,
            structureChanged: temporalChange.structureChanged,
            changedMetadataFields: temporalChange.changedMetadataFields,
            addedTextFragments: temporalChange.addedTextFragments,
            removedTextFragments: temporalChange.removedTextFragments,
            addedFragmentCount: temporalChange.addedFragmentCount,
            removedFragmentCount: temporalChange.removedFragmentCount,
            unchangedFragmentCount: temporalChange.unchangedFragmentCount,
            comparisonBounded: temporalChange.comparisonBounded,
            scopeNote: temporalChange.scopeNote,
          }
        : null;
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
        bodyHashSha256: snapshot.bodyHashSha256,
        contentHashSha256: snapshot.contentHashSha256,
        metadataHashSha256: snapshot.metadataHashSha256,
        structureHashSha256: snapshot.structureHashSha256,
        responseContentType: snapshot.responseContentType,
        decodedCharset: snapshot.decodedCharset,
        metadata: snapshot.metadata,
        structure: snapshot.structure,
        textLength: snapshot.textLength,
        textTruncated: snapshot.textTruncated,
        temporalChangeObserved: temporalChange !== null,
        temporalComparison,
        untrustedContent: true,
      },
      candidate: input.candidate,
      confidenceCap: 0.66,
    });
  }
  const data: WaybackHistoryData = {
    targetUrl: target.href,
    cdxRequestUrl: response.finalUrl,
    candidate: input.candidate,
    captures,
    rawRowsAccepted: parsed.rows.length,
    uniqueDigests,
    captureTimeline: timeline,
    snapshotSelection: snapshotSelection.selection,
    snapshots,
    temporalChange,
    bounded: boundedResult,
    scopeNote:
      "CDX metadata establishes bounded archive presence only. Exact raw-body hashes and bounded text, metadata, and structure comparisons can describe retrieved page changes, but cannot establish archive completeness, page control, authorship, or whether missing client-side dependencies ever existed.",
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

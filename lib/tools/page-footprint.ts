import {
  containsRestrictedPublicContent,
  urlContainsRestrictedParameters,
} from "../domain/content-policy";
import { isBlockedIpAddress } from "./hardened-fetch";
import { decodeHtmlTextForPolicy, projectInertHtml } from "./inert-html";

export type PageCanonicalStatus =
  | "not_declared"
  | "accepted_same_page"
  | "discarded";

export type ObservedProviderFamily =
  | "amazon-cloudfront"
  | "amazon-web-services"
  | "apple-hosted-assets"
  | "cloudflare"
  | "fastly"
  | "github"
  | "google-hosted-assets"
  | "jsdelivr"
  | "microsoft-azure"
  | "netlify"
  | "unpkg"
  | "vercel";

export interface PublicPageFootprint {
  schemaVersion: "public_page_footprint_v1";
  title: string | null;
  description: string | null;
  canonicalUrl: string | null;
  canonicalStatus: PageCanonicalStatus;
  language: string | null;
  openGraph: {
    type: string | null;
    siteName: string | null;
  };
  declaredApplications: {
    generators: string[];
    applicationNames: string[];
  };
  jsonLdTypes: string[];
  observedResourceHosts: string[];
  observedProviderFamilies: ObservedProviderFamily[];
  bounded: boolean;
  spoofable: true;
  scopeNote: string;
}

export interface PublicPageFootprintInput {
  /** HTML bytes already decoded by Atlas's hardened exact-URL fetch. */
  html: string;
  /** Exact final HTTPS URL from that same hardened fetch. */
  finalUrl: string;
}

export interface PublicPageFootprintOptions {
  maxHtmlCharacters?: number;
  maxJsonLdScriptCharacters?: number;
  maxJsonLdTypes?: number;
  maxResourceHosts?: number;
  maxProviderFamilies?: number;
  maxDeclaredNames?: number;
}

interface AnalysisLimits {
  maxHtmlCharacters: number;
  maxJsonLdScriptCharacters: number;
  maxJsonLdTypes: number;
  maxResourceHosts: number;
  maxProviderFamilies: number;
  maxDeclaredNames: number;
}

interface AnalysisState {
  bounded: boolean;
}

interface InertPageMarkup {
  /** Isolated active-title surface; title RCDATA is not scanned as markup. */
  titleHtml: string;
  /** Active document markup with comments and inactive container bodies removed. */
  passiveHtml: string;
  /** Same projection, but preserves real script/iframe opening tags for src inspection. */
  resourceHtml: string;
  /** Only genuine JSON-LD script blocks outside inactive containers. */
  jsonLdHtml: string;
}

const SCOPE_NOTE = "Page declarations are inert, bounded, and spoofable. They show only what this exact fetched HTML referenced at observation time; no listed resource was fetched, and ownership, hosting, control, deployment, authorship, and completeness are not inferred.";

const PROMPT_INJECTION_PATTERN = /\b(?:ignore|disregard|override)\b.{0,32}\b(?:previous|prior|system|developer|instructions?|prompt)\b|\b(?:system|developer|assistant)\s*(?:message|prompt)\s*:|\byou\s+are\s+(?:chatgpt|an?\s+assistant)\b/i;
const SECRET_LITERAL_PATTERN = /\b(?:bearer\s+[a-z0-9._~+/=-]{8,}|(?:api|access|auth|session)[ _-]?(?:key|token|secret)\s*[:=]|(?:password|passwd|private[ _-]?key)\s*[:=]|sk-[a-z0-9_-]{12,})/i;
const URL_WITH_QUERY_PATTERN = /https?:\/\/[^\s<>"']+\?[^\s<>"']+/i;
const SENSITIVE_PATH_SEGMENT_PATTERN = /\/(?:access[-_]?token|api[-_]?key|auth|authorization|bearer|credential|email|home[-_]?address|jwt|pass(?:code|word)|phone|private[-_]?key|secret|session|token)(?:\/|$)/i;

const PROVIDER_RULES: ReadonlyArray<{
  suffixes: readonly string[];
  family: ObservedProviderFamily;
}> = [
  { suffixes: ["cloudfront.net"], family: "amazon-cloudfront" },
  { suffixes: ["amazonaws.com"], family: "amazon-web-services" },
  { suffixes: ["mzstatic.com", "apple-cloudkit.com"], family: "apple-hosted-assets" },
  { suffixes: ["cloudflare.com", "cloudflareinsights.com", "pages.dev", "workers.dev"], family: "cloudflare" },
  { suffixes: ["fastly.net", "fastlylb.net"], family: "fastly" },
  { suffixes: ["github.com", "github.io", "githubassets.com", "githubusercontent.com"], family: "github" },
  { suffixes: ["googleapis.com", "gstatic.com", "googleusercontent.com", "firebaseapp.com"], family: "google-hosted-assets" },
  { suffixes: ["jsdelivr.net"], family: "jsdelivr" },
  { suffixes: ["azureedge.net", "azurefd.net", "windows.net"], family: "microsoft-azure" },
  { suffixes: ["netlify.app", "netlify.com"], family: "netlify" },
  { suffixes: ["unpkg.com"], family: "unpkg" },
  { suffixes: ["vercel.app", "vercel.com", "vercel-storage.com"], family: "vercel" },
];

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value as number)));
}

function limitsFrom(options: PublicPageFootprintOptions): AnalysisLimits {
  return {
    maxHtmlCharacters: boundedInteger(options.maxHtmlCharacters, 1_000_000, 8_192, 2_000_000),
    maxJsonLdScriptCharacters: boundedInteger(options.maxJsonLdScriptCharacters, 64_000, 1_024, 128_000),
    maxJsonLdTypes: boundedInteger(options.maxJsonLdTypes, 12, 1, 24),
    maxResourceHosts: boundedInteger(options.maxResourceHosts, 12, 1, 24),
    maxProviderFamilies: boundedInteger(options.maxProviderFamilies, 8, 1, 12),
    maxDeclaredNames: boundedInteger(options.maxDeclaredNames, 4, 1, 8),
  };
}

/**
 * Build inert parsing surfaces before any regex-based metadata scan. Markup-
 * looking strings in scripts, templates, styles, iframes, or comments are not
 * page declarations. External script/iframe opening tags remain visible only
 * to the resource-host projection; their bodies never reach other collectors.
 */
function inertPageMarkup(html: string): InertPageMarkup {
  return projectInertHtml(html);
}

function containsPromptInjection(value: string): boolean {
  const normalized = value.normalize("NFKC").replace(/[_-]+/g, " ");
  const compact = normalized.toLowerCase().replace(/[^a-z0-9]/g, "");
  return PROMPT_INJECTION_PATTERN.test(normalized)
    || /(?:ignore|disregard|override)(?:all)?(?:previous|prior)(?:system|developer|instructions?|prompt)/.test(compact)
    || /(?:system|developer|assistant)(?:message|prompt)/.test(compact);
}

function safeText(
  rawValue: string | null | undefined,
  maximumCharacters: number,
  state: AnalysisState,
): string | null {
  if (!rawValue) return null;
  const decoded = decodeHtmlTextForPolicy(rawValue);
  if (decoded === null) return null;
  const normalized = decoded.replace(/<[^>]+>/g, " ")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return null;
  if (normalized.length > maximumCharacters) state.bounded = true;
  if (
    containsRestrictedPublicContent(normalized)
    || containsPromptInjection(normalized)
    || SECRET_LITERAL_PATTERN.test(normalized)
    || URL_WITH_QUERY_PATTERN.test(normalized)
  ) return null;
  return normalized.slice(0, maximumCharacters);
}

function parseTagAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  const boundedSource = source.slice(0, 16_384);
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of boundedSource.matchAll(pattern)) {
    const name = match[1]?.toLowerCase();
    if (!name || attributes.has(name)) continue;
    const decoded = decodeHtmlTextForPolicy(match[2] ?? match[3] ?? match[4] ?? "");
    if (decoded !== null) attributes.set(name, decoded);
  }
  return attributes;
}

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function publicHostname(value: string): boolean {
  const hostname = normalizeHostname(value);
  return Boolean(
    hostname
    && hostname.includes(".")
    && !/^[0-9.]+$/.test(hostname)
    && !hostname.includes(":")
    && hostname !== "localhost"
    && !hostname.endsWith(".localhost")
    && !hostname.endsWith(".local")
    && !hostname.endsWith(".internal")
    && !hostname.endsWith(".home.arpa")
    && !isBlockedIpAddress(hostname)
    && !containsRestrictedPublicContent(hostname)
    && hostname.split(".").every((label) =>
      label.length >= 1
      && label.length <= 63
      && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
  );
}

function normalizePublicHttpsUrl(value: string, base?: URL): URL | null {
  if (!value || value.length > 2_048) return null;
  try {
    const url = base ? new URL(value, base) : new URL(value);
    const port = url.port ? Number(url.port) : 443;
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || port !== 443
      || !publicHostname(url.hostname)
      || urlContainsRestrictedParameters(url.href)
    ) return null;
    return url;
  } catch {
    return null;
  }
}

function safeCanonicalPath(url: URL): boolean {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    return false;
  }
  return decodedPath.length <= 1_024
    && !SENSITIVE_PATH_SEGMENT_PATTERN.test(decodedPath)
    && !containsRestrictedPublicContent(decodedPath);
}

function canonicalQueryFingerprint(url: URL): string {
  const trackingKey = /^(?:utm_[a-z0-9_]+|dclid|fbclid|gclid|mc_cid|mc_eid|msclkid)$/i;
  return [...url.searchParams]
    .filter(([key]) => !trackingKey.test(key))
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

function declaredBaseUrl(html: string, finalUrl: URL, state: AnalysisState): URL | null {
  const declarations: string[] = [];
  for (const match of html.matchAll(/<base\b([^>]*)>/gi)) {
    const href = parseTagAttributes(match[1] ?? "").get("href");
    if (!href) continue;
    declarations.push(href);
    if (declarations.length > 1) {
      state.bounded = true;
      return null;
    }
  }
  return declarations.length === 0
    ? finalUrl
    : normalizePublicHttpsUrl(declarations[0], finalUrl);
}

function collectCanonical(
  html: string,
  finalUrl: URL,
  state: AnalysisState,
): Pick<PublicPageFootprint, "canonicalUrl" | "canonicalStatus"> {
  const declarations: string[] = [];
  let declarationsOverflowed = false;
  for (const match of html.matchAll(/<link\b([^>]*)>/gi)) {
    const attributes = parseTagAttributes(match[1] ?? "");
    const relations = (attributes.get("rel") ?? "").toLowerCase().split(/\s+/);
    if (!relations.includes("canonical")) continue;
    if (declarations.length >= 8) {
      state.bounded = true;
      declarationsOverflowed = true;
      continue;
    }
    declarations.push(attributes.get("href") ?? "");
  }
  if (declarations.length === 0) return { canonicalUrl: null, canonicalStatus: "not_declared" };
  if (declarationsOverflowed) return { canonicalUrl: null, canonicalStatus: "discarded" };

  const normalized = declarations.map((value) => normalizePublicHttpsUrl(value, finalUrl));
  if (normalized.some((value) => value === null)) {
    return { canonicalUrl: null, canonicalStatus: "discarded" };
  }
  const candidates = normalized as URL[];
  const finalQuery = canonicalQueryFingerprint(finalUrl);
  const samePage = candidates.every((candidate) => (
    candidate.origin === finalUrl.origin
    && candidate.pathname === finalUrl.pathname
    && canonicalQueryFingerprint(candidate) === finalQuery
    && safeCanonicalPath(candidate)
  ));
  const uniquePages = new Set(candidates.map((candidate) =>
    `${candidate.origin}${candidate.pathname}?${canonicalQueryFingerprint(candidate)}`));
  if (!samePage || uniquePages.size !== 1) {
    return { canonicalUrl: null, canonicalStatus: "discarded" };
  }
  return {
    canonicalUrl: `${candidates[0].origin}${candidates[0].pathname}`,
    canonicalStatus: "accepted_same_page",
  };
}

function firstMetaContent(
  metaTags: readonly Map<string, string>[],
  keys: readonly string[],
  maximumCharacters: number,
  state: AnalysisState,
): string | null {
  const acceptedKeys = new Set(keys);
  for (const attributes of metaTags) {
    const key = (attributes.get("name") ?? attributes.get("property") ?? "").trim().toLowerCase();
    if (!acceptedKeys.has(key)) continue;
    return safeText(attributes.get("content"), maximumCharacters, state);
  }
  return null;
}

function addBounded(
  target: Set<string>,
  value: string,
  maximum: number,
  state: AnalysisState,
): void {
  if (target.has(value)) return;
  if (target.size >= maximum) {
    state.bounded = true;
    return;
  }
  target.add(value);
}

function collectDeclaredNames(
  metaTags: readonly Map<string, string>[],
  keys: readonly string[],
  maximum: number,
  state: AnalysisState,
): string[] {
  const acceptedKeys = new Set(keys);
  const values = new Set<string>();
  for (const attributes of metaTags) {
    const key = (attributes.get("name") ?? "").trim().toLowerCase();
    if (!acceptedKeys.has(key)) continue;
    const value = safeText(attributes.get("content"), 120, state);
    if (value) addBounded(values, value, maximum, state);
  }
  return [...values];
}

function normalizeJsonLdType(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 256) return null;
  const decoded = decodeHtmlTextForPolicy(value);
  if (decoded === null) return null;
  const normalized = decoded.normalize("NFKC").trim();
  const schemaUrl = normalized.match(/^https?:\/\/schema\.org\/([A-Za-z][A-Za-z0-9_.:-]{0,63})\/?$/i);
  const candidate = schemaUrl?.[1] ?? normalized;
  if (
    !/^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(candidate)
    || containsPromptInjection(candidate)
    || SECRET_LITERAL_PATTERN.test(candidate)
    || containsRestrictedPublicContent(candidate)
  ) return null;
  return candidate;
}

function collectTypesFromJsonLd(
  root: unknown,
  types: Set<string>,
  maximum: number,
  state: AnalysisState,
): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let visited = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    visited += 1;
    if (visited > 256 || current.depth > 8) {
      state.bounded = true;
      continue;
    }
    if (Array.isArray(current.value)) {
      for (let index = Math.min(current.value.length, 64) - 1; index >= 0; index -= 1) {
        stack.push({ value: current.value[index], depth: current.depth + 1 });
      }
      if (current.value.length > 64) state.bounded = true;
      continue;
    }
    if (!current.value || typeof current.value !== "object") continue;
    const record = current.value as Record<string, unknown>;
    const declared = record["@type"];
    const declaredTypes = Array.isArray(declared) ? declared.slice(0, 24) : [declared];
    if (Array.isArray(declared) && declared.length > 24) state.bounded = true;
    for (const item of declaredTypes) {
      const type = normalizeJsonLdType(item);
      if (type) addBounded(types, type, maximum, state);
    }
    const children = Object.values(record);
    for (let index = Math.min(children.length, 64) - 1; index >= 0; index -= 1) {
      stack.push({ value: children[index], depth: current.depth + 1 });
    }
    if (children.length > 64) state.bounded = true;
  }
}

function collectJsonLdTypes(
  html: string,
  limits: AnalysisLimits,
  state: AnalysisState,
): string[] {
  const types = new Set<string>();
  let observedScripts = 0;
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attributes = parseTagAttributes(match[1] ?? "");
    if ((attributes.get("type") ?? "").trim().toLowerCase() !== "application/ld+json") continue;
    observedScripts += 1;
    if (observedScripts > 8) {
      state.bounded = true;
      continue;
    }
    const body = match[2] ?? "";
    if (body.length > limits.maxJsonLdScriptCharacters) {
      state.bounded = true;
      continue;
    }
    try {
      collectTypesFromJsonLd(JSON.parse(body), types, limits.maxJsonLdTypes, state);
    } catch {
      // Malformed declarations are not evidence and are deliberately ignored.
    }
  }
  return [...types];
}

function resourceValues(tag: string, attributes: Map<string, string>): string[] {
  if (tag === "link") {
    const relations = (attributes.get("rel") ?? "").toLowerCase().split(/\s+/);
    const resourceRelations = new Set([
      "apple-touch-icon", "dns-prefetch", "icon", "manifest", "modulepreload",
      "preconnect", "prefetch", "preload", "stylesheet",
    ]);
    if (!relations.some((relation) => resourceRelations.has(relation))) return [];
    return [attributes.get("href") ?? ""];
  }
  const direct = [attributes.get("src") ?? ""];
  if (tag === "video") direct.push(attributes.get("poster") ?? "");
  if (tag === "img" || tag === "source") {
    const srcset = attributes.get("srcset") ?? "";
    direct.push(...srcset.split(",").map((candidate) => candidate.trim().split(/\s+/, 1)[0] ?? ""));
  }
  return direct;
}

function observedProviderFamily(hostname: string): ObservedProviderFamily | null {
  for (const rule of PROVIDER_RULES) {
    if (rule.suffixes.some((suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`))) {
      return rule.family;
    }
  }
  return null;
}

function collectResourceSignals(
  html: string,
  baseUrl: URL | null,
  limits: AnalysisLimits,
  state: AnalysisState,
): Pick<PublicPageFootprint, "observedResourceHosts" | "observedProviderFamilies"> {
  const hosts = new Set<string>();
  let observedTags = 0;
  for (const match of html.matchAll(/<(script|img|source|link|iframe|video|audio)\b([^>]*)>/gi)) {
    observedTags += 1;
    if (observedTags > 2_048) {
      state.bounded = true;
      continue;
    }
    const tag = match[1].toLowerCase();
    const attributes = parseTagAttributes(match[2] ?? "");
    for (const rawValue of resourceValues(tag, attributes)) {
      const resource = baseUrl
        ? normalizePublicHttpsUrl(rawValue.trim(), baseUrl)
        : normalizePublicHttpsUrl(rawValue.trim());
      if (!resource) continue;
      addBounded(hosts, normalizeHostname(resource.hostname), limits.maxResourceHosts, state);
    }
  }
  const families = new Set<string>();
  for (const hostname of hosts) {
    const family = observedProviderFamily(hostname);
    if (family) addBounded(families, family, limits.maxProviderFamilies, state);
  }
  return {
    observedResourceHosts: [...hosts],
    observedProviderFamilies: [...families] as ObservedProviderFamily[],
  };
}

/**
 * Projects a small, inert footprint from HTML already fetched for an exact
 * public HTTPS URL. This function performs no I/O and never returns raw markup,
 * scripts, JSON-LD, contacts, URL query strings, or resource paths.
 */
export function extractPublicPageFootprint(
  input: PublicPageFootprintInput,
  options: PublicPageFootprintOptions = {},
): PublicPageFootprint | null {
  const finalUrl = normalizePublicHttpsUrl(input.finalUrl);
  if (!finalUrl || typeof input.html !== "string") return null;
  const limits = limitsFrom(options);
  const state: AnalysisState = { bounded: input.html.length > limits.maxHtmlCharacters };
  const html = input.html.slice(0, limits.maxHtmlCharacters);
  const markup = inertPageMarkup(html);

  const metaTags: Map<string, string>[] = [];
  for (const match of markup.passiveHtml.matchAll(/<meta\b([^>]*)>/gi)) {
    if (metaTags.length >= 256) {
      state.bounded = true;
      continue;
    }
    metaTags.push(parseTagAttributes(match[1] ?? ""));
  }
  const htmlAttributes = parseTagAttributes(markup.passiveHtml.match(/<html\b([^>]*)>/i)?.[1] ?? "");
  const declaredLanguage = htmlAttributes.get("lang")?.trim() ?? "";
  const language = /^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,2}$/i.test(declaredLanguage)
    ? declaredLanguage.toLowerCase()
    : null;
  const canonical = collectCanonical(markup.passiveHtml, finalUrl, state);
  const baseUrl = declaredBaseUrl(markup.passiveHtml, finalUrl, state);
  const resources = collectResourceSignals(markup.resourceHtml, baseUrl, limits, state);

  return {
    schemaVersion: "public_page_footprint_v1",
    title: safeText(markup.titleHtml.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1], 240, state),
    description: firstMetaContent(metaTags, ["description"], 500, state),
    ...canonical,
    language,
    openGraph: {
      type: firstMetaContent(metaTags, ["og:type"], 80, state),
      siteName: firstMetaContent(metaTags, ["og:site_name"], 160, state),
    },
    declaredApplications: {
      generators: collectDeclaredNames(metaTags, ["generator"], limits.maxDeclaredNames, state),
      applicationNames: collectDeclaredNames(
        metaTags,
        ["application-name", "apple-mobile-web-app-title"],
        limits.maxDeclaredNames,
        state,
      ),
    },
    jsonLdTypes: collectJsonLdTypes(markup.jsonLdHtml, limits, state),
    ...resources,
    bounded: state.bounded,
    spoofable: true,
    scopeNote: SCOPE_NOTE,
  };
}

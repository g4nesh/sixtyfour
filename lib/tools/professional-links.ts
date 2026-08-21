import { containsRestrictedPublicContent, urlContainsRestrictedParameters } from "../domain/content-policy";
import { normalizeComparable, normalizeWhitespace } from "../domain/runtime";
import { isDeniedResearchSource } from "../search/source-hierarchy";
import { decodeHtmlTextForPolicy, projectInertHtml, replaceHtmlContainers } from "./inert-html";

const PROFESSIONAL_PATH_MARKERS = new Set([
  "about",
  "bio",
  "biography",
  "media",
  "news",
  "people",
  "press",
  "profile",
  "projects",
  "publications",
  "research",
  "team",
  "work",
]);
const AUTH_PATH_MARKERS = new Set(["account", "admin", "auth", "login", "logout", "register", "signin", "signup"]);
const HTMLISH_EXTENSION = /\.(?:aspx?|html?|php)$/i;

export interface SameOriginProfessionalLink {
  url: string;
  label: string;
  reason: "professional_path" | "subject_slug";
}

export interface ExtractSameOriginProfessionalLinksInput {
  html: string;
  finalUrl: string;
  subjectName?: string | null;
  maxLinks?: number;
}

function htmlAttribute(attributes: string, name: string): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = attributes.match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, "i"));
  return match ? decodeHtmlTextForPolicy(match[1] ?? match[2] ?? match[3] ?? "") : null;
}

function linkLabel(innerHtml: string): string | null {
  const decoded = decodeHtmlTextForPolicy(innerHtml.replace(/<[^>]*>/g, " "));
  if (decoded === null) return null;
  const label = normalizeWhitespace(decoded.normalize("NFKC"));
  return label && label.length <= 320 && !containsRestrictedPublicContent(label) ? label.slice(0, 160) : null;
}

function safeBaseUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

function pathMarkers(url: URL): Set<string> {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    decodedPath = url.pathname;
  }
  return new Set(
    normalizeComparable(decodedPath)
      .split(/[^\p{L}\p{M}\p{N}]+/u)
      .filter(Boolean),
  );
}

function subjectSlugMatches(url: URL, subjectName: string | null): boolean {
  if (!subjectName) return false;
  const tokens = normalizeComparable(subjectName)
    .split(" ")
    .filter((token) => token.length >= 2);
  if (tokens.length < 2) return false;
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    return false;
  }
  const pathTokens = normalizeComparable(decodedPath)
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter(Boolean);
  return tokens.every((token) => pathTokens.includes(token));
}

function safeSameOriginTarget(hrefValue: string, base: URL): URL | null {
  if (!hrefValue || hrefValue.length > 2_048) return null;
  let target: URL;
  try {
    target = new URL(hrefValue, base);
  } catch {
    return null;
  }
  if (
    target.protocol !== "https:" ||
    target.origin !== base.origin ||
    target.username ||
    target.password ||
    (target.port && target.port !== "443") ||
    target.search ||
    urlContainsRestrictedParameters(target.href) ||
    isDeniedResearchSource(target.href)
  )
    return null;
  target.hash = "";
  if (target.href === base.href) return null;
  const finalSegment = target.pathname.split("/").filter(Boolean).at(-1) ?? "";
  if (finalSegment.includes(".") && !HTMLISH_EXTENSION.test(finalSegment)) return null;
  return target;
}

/**
 * Extract a tiny set of same-origin professional links from inert HTML. This
 * does not request them; downstream code must mint opaque candidate-bound
 * leads and pass the normal lane, DNS, transport, and budget gates.
 */
export function extractSameOriginProfessionalLinks(
  input: ExtractSameOriginProfessionalLinksInput,
): SameOriginProfessionalLink[] {
  const base = safeBaseUrl(input.finalUrl);
  if (!base) return [];
  const subjectName = input.subjectName ? normalizeWhitespace(input.subjectName.normalize("NFKC")) : null;
  const maximum = Number.isFinite(input.maxLinks) ? Math.min(5, Math.max(1, Math.trunc(input.maxLinks as number))) : 3;
  const observed: Array<SameOriginProfessionalLink & { ordinal: number; priority: number }> = [];
  const seen = new Set<string>();
  let ordinal = 0;
  replaceHtmlContainers(projectInertHtml(input.html).passiveHtml, "a", (anchor) => {
    ordinal += 1;
    const href = htmlAttribute(anchor.attributes, "href");
    const label = linkLabel(anchor.body);
    const target = href && label ? safeSameOriginTarget(href, base) : null;
    if (!target || !label || seen.has(target.href)) return " ";
    const markers = pathMarkers(target);
    if ([...markers].some((marker) => AUTH_PATH_MARKERS.has(marker))) return " ";
    const subjectMatch = subjectSlugMatches(target, subjectName);
    const professionalMatch = [...markers].some((marker) => PROFESSIONAL_PATH_MARKERS.has(marker));
    if (!subjectMatch && !professionalMatch) return " ";
    seen.add(target.href);
    observed.push({
      url: target.href,
      label,
      reason: subjectMatch ? "subject_slug" : "professional_path",
      priority: subjectMatch ? 0 : 1,
      ordinal,
    });
    return " ";
  });
  return observed
    .sort(
      (left, right) =>
        left.priority - right.priority || left.ordinal - right.ordinal || left.url.localeCompare(right.url),
    )
    .slice(0, maximum)
    .map(({ url, label, reason }) => ({ url, label, reason }));
}

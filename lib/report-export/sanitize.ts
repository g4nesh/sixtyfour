const WHITESPACE = /\s+/g;

function visibleControl(character: string): string {
  return `\\u${character.codePointAt(0)?.toString(16).padStart(4, "0") ?? "fffd"}`;
}

function escapeControlCharacters(value: string): string {
  return [...value].map((character) => {
    const code = character.codePointAt(0) ?? 0;
    const restricted = code <= 8 || code === 11 || code === 12
      || (code >= 14 && code <= 31) || (code >= 127 && code <= 159);
    return restricted ? visibleControl(character) : character;
  }).join("");
}

/** Return stable, visible text with no executable/control characters. */
export function cleanReportText(value: string): string {
  return escapeControlCharacters(value
    .toWellFormed()
    .normalize("NFC")
    .replace(/\r\n?/g, "\n"))
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/\b(?:javascript|vbscript|data)\s*:/gi, "blocked-scheme:")
    .trim();
}

export function cleanInlineReportText(value: string): string {
  return cleanReportText(value).replace(WHITESPACE, " ");
}

/**
 * Reports should already contain admitted https sources. This final boundary
 * prevents an unsafe scheme or user-info from becoming a live export link.
 */
export function safePublicReportUrl(value: string): string | null {
  const cleaned = cleanInlineReportText(value);
  try {
    const url = new URL(cleaned);
    if (url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function markdownInline(value: string): string {
  const escaped = cleanInlineReportText(value)
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\|/g, "\\|")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/</g, "\\<")
    .replace(/>/g, "\\>");
  return escaped
    .replace(/^(#{1,6})(?=\s)/, "\\$1")
    .replace(/^([+-])(?=\s)/, "\\$1")
    .replace(/^(\d+)([.)])(?=\s)/, "$1\\$2");
}

export function markdownUrl(value: string): string {
  const safe = safePublicReportUrl(value);
  if (!safe) return "";
  return safe.replace(/\(/g, "%28").replace(/\)/g, "%29");
}

export function softWrapUrl(value: string): string {
  const safe = safePublicReportUrl(value) ?? cleanInlineReportText(value);
  return safe.replace(/([/?&=#._-])/g, "$1\u200B");
}

export function stableSlug(value: string, fallback = "report"): string {
  const normalized = cleanInlineReportText(value)
    .toLocaleLowerCase("en-US")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 56)
    .replace(/-+$/g, "");
  return normalized || fallback;
}

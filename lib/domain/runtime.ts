import type { JsonValue } from "./types";

export interface Clock {
  /** Wall-clock ISO-8601 timestamp for durable records. */
  now(): string;
  /** Monotonic milliseconds for latency and budget accounting. */
  monotonicMs(): number;
}

export type IdKind =
  "run" | "candidate" | "evidence" | "finding" | "action" | "lead" | "graph_node" | "graph_edge" | "event" | "span";

export interface IdFactory {
  next(kind: IdKind): string;
}

/**
 * A reproducible ID source for tests, examples, and trace replay. Production
 * adapters may inject UUIDs, but domain code never reaches for global crypto.
 */
export function createDeterministicIdFactory(prefix = "atlas"): IdFactory {
  const counters = new Map<IdKind, number>();

  return {
    next(kind) {
      const value = (counters.get(kind) ?? 0) + 1;
      counters.set(kind, value);
      return `${prefix}_${kind}_${String(value).padStart(4, "0")}`;
    },
  };
}

/** A deterministic clock useful for replay and behavior tests. */
export function createSequenceClock(start = "2026-01-01T00:00:00.000Z", stepMs = 1): Clock {
  const startMs = Date.parse(start);
  if (!Number.isFinite(startMs)) {
    throw new TypeError("start must be a valid ISO-8601 timestamp");
  }
  if (!Number.isFinite(stepMs) || stepMs < 0) {
    throw new TypeError("stepMs must be a non-negative finite number");
  }

  let ticks = 0;
  return {
    now() {
      const value = new Date(startMs + ticks * stepMs).toISOString();
      ticks += 1;
      return value;
    },
    monotonicMs() {
      return ticks * stepMs;
    },
  };
}

/** JSON cloning also proves that no runtime-only value crossed the boundary. */
export function cloneJson<T>(value: T): T {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("value is not JSON serializable");
  }
  return JSON.parse(serialized) as T;
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
  }
  return false;
}

export function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function normalizeComparable(value: string): string {
  return normalizeWhitespace(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{M}\p{N}@.+-]+/gu, " ")
    .trim();
}

/**
 * Token normalization for human labels. Unlike normalizeComparable, every
 * punctuation mark is a boundary: `TED.` matches `TED`, while `interested`
 * cannot accidentally match the organization `TED`.
 */
export function normalizeLabelTokens(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** A deliberately tiny brand alias policy; this is not fuzzy matching. */
export function normalizeOrganizationIdentity(value: string): string {
  const normalized = normalizeLabelTokens(value)
    .replace(/\b(?:sixty\s+four|sixtyfour)\b/g, "64")
    .trim();
  return /^(?:64|64 ai)$/.test(normalized) ? "64-ai" : normalized;
}

export function labelOccursAsTokenPhrase(text: string, label: string): boolean {
  const normalizedText = normalizeLabelTokens(text);
  const normalizedLabel = normalizeLabelTokens(label);
  return Boolean(normalizedLabel) && ` ${normalizedText} `.includes(` ${normalizedLabel} `);
}

export function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function roundScore(value: number): number {
  return Math.round(clamp(value) * 1000) / 1000;
}

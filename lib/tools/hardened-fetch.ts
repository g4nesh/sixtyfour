import type { FetchLike } from "./contracts";
import { urlContainsRestrictedParameters } from "../domain/content-policy.ts";

export type HardenedFetchErrorCode =
  | "invalid_url"
  | "blocked_scheme"
  | "blocked_credentials"
  | "blocked_query_secret"
  | "blocked_port"
  | "blocked_host"
  | "dns_resolution_failed"
  | "blocked_address"
  | "budget_exhausted"
  | "method_not_allowed"
  | "redirect_missing_location"
  | "redirect_limit"
  | "unsafe_redirect"
  | "timeout"
  | "aborted"
  | "network_error"
  | "retry_exhausted"
  | "response_too_large"
  | "mime_not_allowed";

export class HardenedFetchError extends Error {
  readonly code: HardenedFetchErrorCode;
  readonly retryable: boolean;
  readonly status: number | null;
  readonly safeUrl: string | null;
  readonly attempt: number;
  readonly requests: number;

  constructor(
    code: HardenedFetchErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      status?: number | null;
      safeUrl?: string | null;
      attempt?: number;
      requests?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HardenedFetchError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status ?? null;
    this.safeUrl = options.safeUrl ?? null;
    this.attempt = options.attempt ?? 0;
    this.requests = options.requests ?? 0;
  }
}

export interface OutboundRequestAttempt {
  safeUrl: string;
  method: string;
  attempt: number;
  redirect: number;
  requestNumber: number;
}

export interface HardenedFetchPolicy {
  /** Exact names, or explicit `*.example.com` suffixes. */
  allowedHostnames?: readonly string[];
  /** Resolve and validate every answer when fetching non-fixed public hosts. */
  resolveHostname?: (hostname: string, signal?: AbortSignal) => Promise<readonly string[]>;
  allowedMethods?: readonly string[];
  allowedMimeTypes?: readonly string[];
  allowedPorts?: readonly number[];
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  maxRetries?: number;
  baseRetryMs?: number;
  maxRetryAfterMs?: number;
  allowUnsafeRetries?: boolean;
  allowUnsafeRedirects?: boolean;
  fetch?: FetchLike;
  clock?: () => number;
  random?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  /** Called immediately before every actual fetch, including retries and redirects. */
  beforeRequest?: (attempt: OutboundRequestAttempt) => boolean | Promise<boolean>;
}

export interface HardenedFetchResult {
  response: Response;
  finalUrl: string;
  attempts: number;
  requests: number;
  redirects: string[];
  bytesRead: number;
}

interface NormalizedPolicy {
  allowedHostnames: string[];
  resolveHostname?: HardenedFetchPolicy["resolveHostname"];
  allowedMethods: Set<string>;
  allowedMimeTypes: string[];
  allowedPorts: Set<number>;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
  maxRetries: number;
  baseRetryMs: number;
  maxRetryAfterMs: number;
  allowUnsafeRetries: boolean;
  allowUnsafeRedirects: boolean;
  fetch: FetchLike;
  clock: () => number;
  random: () => number;
  sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  beforeRequest?: HardenedFetchPolicy["beforeRequest"];
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const SENSITIVE_HEADERS = ["authorization", "cookie", "proxy-authorization"];
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value as number)));
}

function normalizePolicy(policy: HardenedFetchPolicy): NormalizedPolicy {
  const allowedHostnames = (policy.allowedHostnames ?? []).map(normalizeHostname);
  if (allowedHostnames.length === 0 && !policy.resolveHostname) {
    throw new HardenedFetchError("blocked_host", "A hostname allowlist or a DNS validation callback is required.");
  }

  return {
    allowedHostnames,
    resolveHostname: policy.resolveHostname,
    allowedMethods: new Set((policy.allowedMethods ?? ["GET", "HEAD"]).map((value) => value.toUpperCase())),
    allowedMimeTypes: (policy.allowedMimeTypes ?? ["application/json", "text/*"]).map((value) => value.toLowerCase()),
    allowedPorts: new Set(policy.allowedPorts ?? [443]),
    timeoutMs: clampInteger(policy.timeoutMs, 10_000, 1, 120_000),
    maxBytes: clampInteger(policy.maxBytes, 1_000_000, 1, 20_000_000),
    maxRedirects: clampInteger(policy.maxRedirects, 3, 0, 10),
    maxRetries: clampInteger(policy.maxRetries, 2, 0, 5),
    baseRetryMs: clampInteger(policy.baseRetryMs, 250, 0, 30_000),
    maxRetryAfterMs: clampInteger(policy.maxRetryAfterMs, 10_000, 0, 120_000),
    allowUnsafeRetries: policy.allowUnsafeRetries ?? false,
    allowUnsafeRedirects: policy.allowUnsafeRedirects ?? false,
    fetch: policy.fetch ?? fetch,
    clock: policy.clock ?? Date.now,
    random: policy.random ?? Math.random,
    sleep: policy.sleep ?? abortableSleep,
    beforeRequest: policy.beforeRequest,
  };
}

function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, "");
}

function unbracketHostname(value: string): string {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

function safeUrl(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

function hostnameAllowed(hostname: string, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true;
  return allowed.some((rule) => {
    if (!rule.startsWith("*.")) return hostname === rule;
    const suffix = rule.slice(1);
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
  });
}

function parseIpv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^(0|[1-9]\d{0,2})$/.test(part) ? Number(part) : -1));
  return octets.every((part) => part >= 0 && part <= 255) ? octets : null;
}

function expandIpv6(value: string): number[] | null {
  if (value.includes("%")) return null;
  let source = value.toLowerCase();
  const embeddedMatch = source.match(/(?:^|:)(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (embeddedMatch) {
    const ipv4 = parseIpv4(embeddedMatch[1]);
    if (!ipv4) return null;
    const replacement = `${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
    source = source.slice(0, source.length - embeddedMatch[1].length) + replacement;
  }

  if ((source.match(/::/g) ?? []).length > 1) return null;
  const halves = source.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return groups.map((part) => Number.parseInt(part, 16));
}

/** Returns true for loopback, private, link-local, reserved, documentation, or multicast space. */
export function isBlockedIpAddress(address: string): boolean {
  const normalized = unbracketHostname(normalizeHostname(address));
  const ipv4 = parseIpv4(normalized);
  if (ipv4) {
    const [a, b, c] = ipv4;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }

  const ipv6 = expandIpv6(normalized);
  if (!ipv6) return false;
  const allZero = ipv6.every((part) => part === 0);
  const loopback = ipv6.slice(0, 7).every((part) => part === 0) && ipv6[7] === 1;
  const mappedV4 = ipv6.slice(0, 5).every((part) => part === 0) && ipv6[5] === 0xffff;
  const compatibleV4 = ipv6.slice(0, 6).every((part) => part === 0);
  if (mappedV4 || compatibleV4) {
    const embedded = `${ipv6[6] >> 8}.${ipv6[6] & 0xff}.${ipv6[7] >> 8}.${ipv6[7] & 0xff}`;
    if (isBlockedIpAddress(embedded)) return true;
  }
  return (
    allZero ||
    loopback ||
    (ipv6[0] & 0xfe00) === 0xfc00 ||
    (ipv6[0] & 0xffc0) === 0xfe80 ||
    (ipv6[0] & 0xff00) === 0xff00 ||
    (ipv6[0] === 0x2001 && ipv6[1] === 0x0db8) ||
    (ipv6[0] === 0x2001 && (ipv6[1] & 0xfff0) === 0x0010)
  );
}

function isIpLiteral(hostname: string): boolean {
  const unbracketed = unbracketHostname(hostname);
  return parseIpv4(unbracketed) !== null || expandIpv6(unbracketed) !== null;
}

function isBlockedHostname(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa")
  );
}

function containsSensitiveQueryKey(url: URL): boolean {
  return urlContainsRestrictedParameters(url.toString());
}

export async function validateOutboundUrl(
  value: string | URL,
  policy: Pick<NormalizedPolicy, "allowedHostnames" | "allowedPorts" | "resolveHostname">,
  signal?: AbortSignal,
): Promise<URL> {
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value.href) : new URL(value);
  } catch (error) {
    throw new HardenedFetchError("invalid_url", "The outbound URL is invalid.", { cause: error });
  }
  if (url.protocol !== "https:") {
    throw new HardenedFetchError("blocked_scheme", "Only HTTPS outbound requests are allowed.", {
      safeUrl: safeUrl(url),
    });
  }
  if (url.username || url.password) {
    throw new HardenedFetchError("blocked_credentials", "Credentials in outbound URLs are not allowed.", {
      safeUrl: safeUrl(url),
    });
  }
  if (containsSensitiveQueryKey(url)) {
    throw new HardenedFetchError(
      "blocked_query_secret",
      "Credential-like query parameters are not allowed in outbound URLs.",
      { safeUrl: `${url.origin}${url.pathname}` },
    );
  }
  const port = url.port ? Number(url.port) : 443;
  if (!policy.allowedPorts.has(port)) {
    throw new HardenedFetchError("blocked_port", "The outbound URL uses a disallowed port.", {
      safeUrl: safeUrl(url),
    });
  }
  const hostname = normalizeHostname(unbracketHostname(url.hostname));
  if (isBlockedHostname(hostname) || !hostnameAllowed(hostname, policy.allowedHostnames)) {
    throw new HardenedFetchError("blocked_host", "The outbound hostname is not permitted.", {
      safeUrl: safeUrl(url),
    });
  }
  if (isIpLiteral(hostname) && isBlockedIpAddress(hostname)) {
    throw new HardenedFetchError("blocked_address", "The outbound address is not public.", {
      safeUrl: safeUrl(url),
    });
  }

  if (policy.resolveHostname && !isIpLiteral(hostname)) {
    let addresses: readonly string[];
    try {
      addresses = await policy.resolveHostname(hostname, signal);
    } catch (error) {
      throw new HardenedFetchError("dns_resolution_failed", "The outbound hostname could not be validated.", {
        retryable: true,
        safeUrl: safeUrl(url),
        cause: error,
      });
    }
    if (addresses.length === 0 || addresses.some((address) => !isIpLiteral(address))) {
      throw new HardenedFetchError("dns_resolution_failed", "The outbound hostname had no valid address answers.", {
        retryable: true,
        safeUrl: safeUrl(url),
      });
    }
    if (addresses.some(isBlockedIpAddress)) {
      throw new HardenedFetchError("blocked_address", "The outbound hostname resolves to non-public address space.", {
        safeUrl: safeUrl(url),
      });
    }
  }
  url.hash = "";
  return url;
}

function mimeAllowed(contentType: string, allowed: readonly string[]): boolean {
  const mime = contentType.split(";", 1)[0].trim().toLowerCase();
  return allowed.some((rule) => {
    if (rule.endsWith("/*")) return mime.startsWith(rule.slice(0, -1));
    return mime === rule;
  });
}

async function readBoundedResponse(response: Response, maxBytes: number, safeResponseUrl: string): Promise<Uint8Array> {
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > maxBytes) {
    await response.body?.cancel();
    throw new HardenedFetchError("response_too_large", "The response exceeds the configured byte limit.", {
      status: response.status,
      safeUrl: safeResponseUrl,
    });
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new HardenedFetchError("response_too_large", "The response exceeded the configured byte limit.", {
          status: response.status,
          safeUrl: safeResponseUrl,
        });
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function createAttemptSignal(
  external: AbortSignal | undefined,
  timeoutMs: number,
): {
  signal: AbortSignal;
  didTimeout: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort(external?.reason);
  if (external?.aborted) controller.abort(external.reason);
  else external?.addEventListener("abort", onExternalAbort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Outbound request timed out."));
  }, timeoutMs);
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", onExternalAbort);
    },
  };
}

function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

export function parseRetryAfter(value: string | null, nowMs: number, maximumMs: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  let delay: number;
  if (/^\d+$/.test(trimmed)) delay = Number(trimmed) * 1_000;
  else {
    const timestamp = Date.parse(trimmed);
    if (!Number.isFinite(timestamp)) return null;
    delay = Math.max(0, timestamp - nowMs);
  }
  if (!Number.isFinite(delay)) return null;
  return Math.min(maximumMs, Math.max(0, Math.trunc(delay)));
}

function backoffDelay(attempt: number, policy: NormalizedPolicy, retryAfter: string | null): number {
  const providerDelay = parseRetryAfter(retryAfter, policy.clock(), policy.maxRetryAfterMs);
  if (providerDelay !== null) return providerDelay;
  const exponential = policy.baseRetryMs * 2 ** Math.max(0, attempt - 1);
  const jitter = 0.75 + Math.min(1, Math.max(0, policy.random())) * 0.5;
  return Math.min(policy.maxRetryAfterMs, Math.trunc(exponential * jitter));
}

function canRetry(method: string, policy: NormalizedPolicy): boolean {
  return IDEMPOTENT_METHODS.has(method) || policy.allowUnsafeRetries;
}

function redirectedMethod(status: number, method: string, policy: NormalizedPolicy): string {
  if (method === "GET" || method === "HEAD") return method;
  if (!policy.allowUnsafeRedirects) {
    throw new HardenedFetchError("unsafe_redirect", "Redirecting a non-idempotent request is disabled.");
  }
  return status === 303 || ((status === 301 || status === 302) && method === "POST") ? "GET" : method;
}

function withTransportCounts(error: HardenedFetchError, requests: number, attempt: number): HardenedFetchError {
  if (error.requests === requests && error.attempt === attempt) return error;
  return new HardenedFetchError(error.code, error.message, {
    retryable: error.retryable,
    status: error.status,
    safeUrl: error.safeUrl,
    attempt,
    requests,
    cause: error,
  });
}

/**
 * Fetch with explicit redirect handling and bounded response buffering.
 *
 * Fixed vendor adapters should pass an exact hostname allowlist. General web
 * fetchers must additionally inject a resolver so every DNS answer is checked.
 * The Fetch API cannot pin an address, so runtimes needing rebinding resistance
 * should also enforce the same egress policy at their network boundary.
 */
export function createHardenedFetch(policyInput: HardenedFetchPolicy) {
  const policy = normalizePolicy(policyInput);

  return async function hardenedFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<HardenedFetchResult> {
    let original: Request;
    try {
      original = new Request(input, init);
    } catch (error) {
      throw new HardenedFetchError("invalid_url", "The outbound request is invalid.", { cause: error });
    }
    let method = original.method.toUpperCase();
    if (!policy.allowedMethods.has(method)) {
      throw new HardenedFetchError("method_not_allowed", "The outbound HTTP method is not allowed.");
    }
    let currentUrl = await validateOutboundUrl(original.url, policy, init.signal ?? undefined);
    const requestBody = method === "GET" || method === "HEAD" ? undefined : await original.clone().arrayBuffer();
    let headers = new Headers(original.headers);
    const redirects: string[] = [];
    let attempt = 0;
    let requestCount = 0;
    let lastError: HardenedFetchError | null = null;

    while (attempt <= policy.maxRetries) {
      attempt += 1;
      let redirectCount = 0;
      let attemptUrl = currentUrl;
      let attemptMethod = method;

      while (true) {
        if (policy.beforeRequest) {
          let granted = false;
          try {
            granted =
              (await policy.beforeRequest({
                safeUrl: safeUrl(attemptUrl),
                method: attemptMethod,
                attempt,
                redirect: redirectCount,
                requestNumber: requestCount + 1,
              })) !== false;
          } catch (error) {
            throw new HardenedFetchError("budget_exhausted", "The outbound request budget check failed closed.", {
              safeUrl: safeUrl(attemptUrl),
              attempt,
              requests: requestCount,
              cause: error,
            });
          }
          if (!granted) {
            throw new HardenedFetchError("budget_exhausted", "The outbound request budget is exhausted.", {
              safeUrl: safeUrl(attemptUrl),
              attempt,
              requests: requestCount,
            });
          }
        }
        const attemptSignal = createAttemptSignal(init.signal ?? undefined, policy.timeoutMs);
        let response: Response;
        try {
          const body = attemptMethod === "GET" || attemptMethod === "HEAD" ? undefined : requestBody;
          requestCount += 1;
          response = await policy.fetch(attemptUrl, {
            method: attemptMethod,
            headers,
            body,
            redirect: "manual",
            signal: attemptSignal.signal,
          });
        } catch (error) {
          const externalAbort = init.signal?.aborted === true;
          const mapped = new HardenedFetchError(
            externalAbort ? "aborted" : attemptSignal.didTimeout() ? "timeout" : "network_error",
            externalAbort
              ? "The outbound request was aborted."
              : attemptSignal.didTimeout()
                ? "The outbound request timed out."
                : "The outbound request failed at the network boundary.",
            {
              retryable: !externalAbort,
              safeUrl: safeUrl(attemptUrl),
              attempt,
              requests: requestCount,
              cause: error,
            },
          );
          attemptSignal.cleanup();
          if (!mapped.retryable || !canRetry(method, policy) || attempt > policy.maxRetries) throw mapped;
          lastError = mapped;
          await policy.sleep(backoffDelay(attempt, policy, null), init.signal ?? undefined);
          break;
        }
        if (REDIRECT_STATUSES.has(response.status)) {
          await response.body?.cancel();
          attemptSignal.cleanup();
          const location = response.headers.get("location");
          if (!location) {
            throw new HardenedFetchError("redirect_missing_location", "The redirect response omitted Location.", {
              status: response.status,
              safeUrl: safeUrl(attemptUrl),
              attempt,
              requests: requestCount,
            });
          }
          if (redirectCount >= policy.maxRedirects) {
            throw new HardenedFetchError("redirect_limit", "The outbound request exceeded its redirect limit.", {
              status: response.status,
              safeUrl: safeUrl(attemptUrl),
              attempt,
              requests: requestCount,
            });
          }
          let next: URL;
          let nextMethod: string;
          try {
            next = await validateOutboundUrl(new URL(location, attemptUrl), policy, init.signal ?? undefined);
            nextMethod = redirectedMethod(response.status, attemptMethod, policy);
          } catch (error) {
            if (error instanceof HardenedFetchError) {
              throw withTransportCounts(error, requestCount, attempt);
            }
            throw error;
          }
          if (next.origin !== attemptUrl.origin) {
            headers = new Headers(headers);
            for (const header of SENSITIVE_HEADERS) headers.delete(header);
          }
          if (nextMethod === "GET" && attemptMethod !== "GET") {
            headers.delete("content-length");
            headers.delete("content-type");
          }
          attemptMethod = nextMethod;
          attemptUrl = next;
          currentUrl = next;
          method = nextMethod;
          redirectCount += 1;
          redirects.push(safeUrl(next));
          continue;
        }

        if (RETRYABLE_STATUSES.has(response.status) && canRetry(method, policy) && attempt <= policy.maxRetries) {
          await response.body?.cancel();
          attemptSignal.cleanup();
          await policy.sleep(
            backoffDelay(attempt, policy, response.headers.get("retry-after")),
            init.signal ?? undefined,
          );
          break;
        }

        const hasBody = ![204, 205, 304].includes(response.status) && attemptMethod !== "HEAD";
        if (hasBody && !mimeAllowed(response.headers.get("content-type") ?? "", policy.allowedMimeTypes)) {
          await response.body?.cancel();
          attemptSignal.cleanup();
          throw new HardenedFetchError("mime_not_allowed", "The response Content-Type is not allowed.", {
            status: response.status,
            safeUrl: safeUrl(attemptUrl),
            attempt,
            requests: requestCount,
          });
        }
        let bytes: Uint8Array;
        try {
          bytes = hasBody
            ? await readBoundedResponse(response, policy.maxBytes, safeUrl(attemptUrl))
            : new Uint8Array();
        } catch (error) {
          attemptSignal.cleanup();
          if (error instanceof HardenedFetchError) {
            throw withTransportCounts(error, requestCount, attempt);
          }
          const externalAbort = init.signal?.aborted === true;
          const mapped = new HardenedFetchError(
            externalAbort ? "aborted" : attemptSignal.didTimeout() ? "timeout" : "network_error",
            externalAbort
              ? "The outbound response read was aborted."
              : attemptSignal.didTimeout()
                ? "The outbound response read timed out."
                : "The outbound response failed while being read.",
            {
              retryable: !externalAbort,
              status: response.status,
              safeUrl: safeUrl(attemptUrl),
              attempt,
              requests: requestCount,
              cause: error,
            },
          );
          if (!mapped.retryable || !canRetry(method, policy) || attempt > policy.maxRetries) throw mapped;
          lastError = mapped;
          await policy.sleep(backoffDelay(attempt, policy, null), init.signal ?? undefined);
          break;
        }
        attemptSignal.cleanup();
        const responseBody = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(responseBody).set(bytes);
        const boundedResponse = new Response(responseBody, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
        return {
          response: boundedResponse,
          finalUrl: attemptUrl.href,
          attempts: attempt,
          requests: requestCount,
          redirects,
          bytesRead: bytes.byteLength,
        };
      }
    }

    throw new HardenedFetchError("retry_exhausted", "The outbound request exhausted its retry budget.", {
      retryable: true,
      safeUrl: safeUrl(currentUrl),
      attempt,
      requests: requestCount,
      cause: lastError ?? undefined,
    });
  };
}

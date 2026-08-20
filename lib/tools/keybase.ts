import {
  createToolMeta,
  isoTime,
  reserveToolBudget,
  toolClock,
  type ToolContext,
  type ToolDiagnostic,
  type ToolResult,
  type ToolStatus,
} from "./contracts";
import { createHardenedFetch, HardenedFetchError } from "./hardened-fetch";

export type KeybaseProofStatus = "verified" | "stale" | "mismatch" | "revoked" | "unverified";

export interface KeybaseGithubProof {
  keybaseUsername: string;
  githubHandle: string;
  status: KeybaseProofStatus;
  proofUrl: string | null;
  profileUrl: string;
  observedAt: string;
  proofUpdatedAt: string | null;
}

export interface KeybaseLookupData {
  githubHandle: string;
  proofs: KeybaseGithubProof[];
  ambiguous: boolean;
}

export interface KeybaseLookupOptions {
  staleAfterDays?: number;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function proofState(value: unknown): "valid" | "revoked" | "unknown" {
  if (value === 1 || value === "1") return "valid";
  if (typeof value !== "string") return typeof value === "number" && [5, 7, 8].includes(value) ? "revoked" : "unknown";
  const state = value.toLowerCase();
  if (state === "ok" || state === "valid" || state === "verified") return "valid";
  if (["revoked", "deleted", "superseded", "failed", "perm_failure"].includes(state)) return "revoked";
  return "unknown";
}

function proofTimestamp(value: unknown): number | null {
  const seconds = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return seconds < 10_000_000_000 ? seconds * 1_000 : seconds;
}

function safeProofUrl(value: unknown): string | null {
  const text = asString(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || !["github.com", "gist.github.com", "keybase.io"].includes(hostname)) return null;
    url.username = "";
    url.password = "";
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function collectProofRecords(user: Record<string, unknown>): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const summary = isRecord(user.proofs_summary) ? user.proofs_summary : null;
  const byType = summary && isRecord(summary.by_proof_type) ? summary.by_proof_type : null;
  const github = byType && Array.isArray(byType.github) ? byType.github : [];
  const all = summary && Array.isArray(summary.all) ? summary.all : [];
  const remote = Array.isArray(user.remote_key_proofs) ? user.remote_key_proofs : [];
  for (const item of [...github, ...all, ...remote]) {
    if (!isRecord(item)) continue;
    const kind = asString(item.proof_type) ?? asString(item.key) ?? "github";
    if (kind.toLowerCase() !== "github") continue;
    records.push(item);
  }
  return records;
}

function uniqueProofRecords(records: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = [record.sig_id, record.proof_id, record.proof_url, record.nametag, record.value]
      .map((value) => String(value ?? ""))
      .join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value as number)));
}

function finish(
  startedAt: number,
  now: () => number,
  status: ToolStatus,
  data: KeybaseLookupData | null,
  diagnostics: ToolDiagnostic[],
  requests: number,
  bytesRead: number,
  incomplete: boolean,
): ToolResult<KeybaseLookupData> {
  const finishedAt = now();
  return {
    ok: status !== "failed" && status !== "rate_limited",
    status,
    data,
    evidence: [],
    diagnostics,
    meta: createToolMeta(startedAt, finishedAt, requests, bytesRead, incomplete),
  };
}

/** Optional public proof-edge lookup. Failures are returned as data-safe results. */
export async function lookupKeybaseGithub(
  githubHandleInput: string,
  context: ToolContext = {},
  options: KeybaseLookupOptions = {},
): Promise<ToolResult<KeybaseLookupData>> {
  const now = toolClock(context);
  const startedAt = now();
  const githubHandle = githubHandleInput.trim();
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(githubHandle)) {
    return finish(
      startedAt,
      now,
      "skipped",
      null,
      [
        {
          code: "invalid_github_handle",
          severity: "warning",
          message: "Keybase lookup was skipped because the GitHub handle is invalid.",
          retryable: false,
        },
      ],
      0,
      0,
      false,
    );
  }
  const maxResponseBytes = bounded(options.maxResponseBytes, 256_000, 1_024, 1_000_000);
  const url = new URL("https://keybase.io/_/api/1.0/user/lookup.json");
  url.searchParams.set("github", githubHandle);
  url.searchParams.set("fields", "basics,proofs_summary,remote_key_proofs");
  const hardenedFetch = createHardenedFetch({
    allowedHostnames: ["keybase.io"],
    allowedMethods: ["GET"],
    allowedMimeTypes: ["application/json", "text/json"],
    timeoutMs: bounded(options.timeoutMs, 8_000, 500, 30_000),
    maxBytes: maxResponseBytes,
    maxRedirects: 0,
    maxRetries: 1,
    maxRetryAfterMs: 3_000,
    fetch: context.fetch,
    clock: now,
    beforeRequest: () =>
      reserveToolBudget(context, {
        tool: "keybase_github_proof",
        networkRequests: 1,
        expectedBytes: maxResponseBytes,
      }),
  });

  let response;
  try {
    response = await hardenedFetch(url, { signal: context.signal });
  } catch (error) {
    const retryable = error instanceof HardenedFetchError && error.retryable;
    const budgetExhausted = error instanceof HardenedFetchError && error.code === "budget_exhausted";
    return finish(
      startedAt,
      now,
      budgetExhausted ? "skipped" : "failed",
      null,
      [
        {
          code: error instanceof HardenedFetchError ? error.code : "keybase_unavailable",
          severity: budgetExhausted ? "info" : "warning",
          message: budgetExhausted
            ? "Keybase lookup was skipped because the network budget was exhausted."
            : "The optional Keybase proof lookup was unavailable.",
          retryable,
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
      [
        {
          code: "keybase_rate_limited",
          severity: "warning",
          message: "Keybase rate-limited the optional proof lookup.",
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
      [
        {
          code: "keybase_http_error",
          severity: "warning",
          message: `Keybase returned HTTP ${response.response.status}.`,
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
      [
        {
          code: "keybase_invalid_json",
          severity: "warning",
          message: "Keybase returned malformed JSON.",
          retryable: true,
        },
      ],
      response.requests,
      response.bytesRead,
      true,
    );
  }
  if (
    !isRecord(payload) ||
    !isRecord(payload.status) ||
    Number(payload.status.code) !== 0 ||
    !Array.isArray(payload.them)
  ) {
    return finish(
      startedAt,
      now,
      "failed",
      null,
      [
        {
          code: "keybase_invalid_response",
          severity: "warning",
          message: "Keybase returned an unexpected proof response.",
          retryable: false,
        },
      ],
      response.requests,
      response.bytesRead,
      true,
    );
  }

  const observedAtMs = now();
  const observedAt = isoTime(observedAtMs);
  const staleAfterMs = bounded(options.staleAfterDays, 1_095, 1, 20_000) * 86_400_000;
  const proofs: KeybaseGithubProof[] = [];
  const diagnostics: ToolDiagnostic[] = [];
  for (const item of payload.them) {
    if (!isRecord(item)) continue;
    const basics = isRecord(item.basics) ? item.basics : {};
    const keybaseUsername = asString(basics.username);
    if (!keybaseUsername || !/^[a-z0-9_]{1,32}$/i.test(keybaseUsername)) continue;
    const records = uniqueProofRecords(collectProofRecords(item));
    if (records.length === 0) {
      // The external-identity lookup itself is evidence, but without proof
      // state details it is deliberately not promoted to a verified edge.
      proofs.push({
        keybaseUsername,
        githubHandle,
        status: "unverified",
        proofUrl: null,
        profileUrl: `https://keybase.io/${encodeURIComponent(keybaseUsername)}`,
        observedAt,
        proofUpdatedAt: null,
      });
      continue;
    }
    for (const record of records) {
      const nametag = asString(record.nametag) ?? asString(record.value) ?? githubHandle;
      const state = proofState(record.state ?? record.proof_state ?? record.status);
      const updatedMs = proofTimestamp(record.mtime) ?? proofTimestamp(record.ctime);
      const mismatched = nametag.toLowerCase() !== githubHandle.toLowerCase();
      const stale = updatedMs !== null && observedAtMs - updatedMs > staleAfterMs;
      const status: KeybaseProofStatus = mismatched
        ? "mismatch"
        : state === "revoked"
          ? "revoked"
          : state === "valid" && stale
            ? "stale"
            : state === "valid"
              ? "verified"
              : "unverified";
      proofs.push({
        keybaseUsername,
        githubHandle: nametag,
        status,
        proofUrl: safeProofUrl(record.proof_url ?? record.human_url ?? record.service_url),
        profileUrl: `https://keybase.io/${encodeURIComponent(keybaseUsername)}`,
        observedAt,
        proofUpdatedAt: updatedMs === null ? null : isoTime(updatedMs),
      });
    }
  }

  const mismatches = proofs.filter((proof) => proof.status === "mismatch").length;
  const stale = proofs.filter((proof) => proof.status === "stale").length;
  if (mismatches)
    diagnostics.push({
      code: "keybase_handle_mismatch",
      severity: "warning",
      message: "Keybase returned proof records whose GitHub handle did not match the queried account.",
      retryable: false,
      details: { count: mismatches },
    });
  if (stale)
    diagnostics.push({
      code: "keybase_stale_proof",
      severity: "info",
      message: "Some Keybase proof records are old and must not be treated as fresh corroboration.",
      retryable: false,
      details: { count: stale },
    });
  const usernames = new Set(proofs.map((proof) => proof.keybaseUsername.toLowerCase()));
  const ambiguous = usernames.size > 1;
  if (ambiguous)
    diagnostics.push({
      code: "multiple_keybase_accounts",
      severity: "warning",
      message: "Multiple Keybase accounts reference the same GitHub handle; no account was selected automatically.",
      retryable: false,
      details: { count: usernames.size },
    });

  const data = { githubHandle, proofs, ambiguous };
  return finish(
    startedAt,
    now,
    proofs.length ? "succeeded" : "not_found",
    data,
    diagnostics,
    response.requests,
    response.bytesRead,
    false,
  );
}

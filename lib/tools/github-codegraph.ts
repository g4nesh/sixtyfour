import {
  createToolMeta,
  isoTime,
  reserveToolBudget,
  toolClock,
  type ToolContext,
  type ToolDiagnostic,
  type ToolEvidence,
  type ToolResult,
  type ToolStatus,
} from "./contracts";
import { createHardenedFetch, HardenedFetchError } from "./hardened-fetch";
import { lookupKeybaseGithub, type KeybaseGithubProof } from "./keybase";

export interface CommitSignatureSummary {
  verified: boolean;
  reason: string | null;
  verifiedAt: string | null;
  committerAccount: string | null;
  identityMatch: boolean;
}

export interface ExplicitGithubEmailTarget {
  email: string;
  /** Required guardrail: this adapter may not enumerate model-inferred emails. */
  provenance: "explicit_user_input";
}

export interface GithubCodegraphCommit {
  sha: string;
  url: string;
  repository: string;
  repositoryUrl: string;
  authoredAt: string | null;
  authorName: string | null;
  githubAccount: string | null;
  signature: CommitSignatureSummary;
}

export interface GithubAccountCluster {
  login: string;
  accountId: number | null;
  url: string;
  commitCount: number;
  repositories: string[];
  strongestSignature: (CommitSignatureSummary & { commitUrl: string }) | null;
  keybaseProofs: KeybaseGithubProof[];
}

export interface GithubCodegraphData {
  exactEmail: string;
  commits: GithubCodegraphCommit[];
  accounts: GithubAccountCluster[];
  unattributedCommitCount: number;
  totalCountReported: number | null;
  incompleteResults: boolean;
  capped: boolean;
  rateLimitRemaining: number | null;
  scopeNote: string;
}

export interface GithubCodegraphOptions {
  githubToken?: string;
  maxCommits?: number;
  maxSignatureChecks?: number;
  includeKeybase?: boolean;
  maxKeybaseAccounts?: number;
  keybaseStaleAfterDays?: number;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

interface SearchCommitItem extends GithubCodegraphCommit {
  accountId: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nonnegativeInteger(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : null;
}

function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value as number)));
}

function validIsoDate(value: unknown): string | null {
  const date = asString(value);
  if (!date || !Number.isFinite(Date.parse(date))) return null;
  return new Date(date).toISOString();
}

function parseSignature(
  value: unknown,
  authorAccount: string | null,
  committerAccount: string | null,
): CommitSignatureSummary {
  if (!isRecord(value))
    return {
      verified: false,
      reason: null,
      verifiedAt: null,
      committerAccount,
      identityMatch: false,
    };
  const verified = value.verified === true && value.reason === "valid";
  return {
    verified,
    reason: asString(value.reason),
    verifiedAt: validIsoDate(value.verified_at),
    committerAccount,
    identityMatch:
      verified &&
      authorAccount !== null &&
      committerAccount !== null &&
      authorAccount.toLowerCase() === committerAccount.toLowerCase(),
  };
}

function parseSearchCommit(
  item: unknown,
  expectedEmail: string,
): { commit: SearchCommitItem | null; mismatch: boolean } {
  if (!isRecord(item) || !isRecord(item.commit) || !isRecord(item.repository)) {
    return { commit: null, mismatch: false };
  }
  const rawAuthor = isRecord(item.commit.author) ? item.commit.author : null;
  const returnedEmail = rawAuthor ? asString(rawAuthor.email) : null;
  if (!returnedEmail || returnedEmail.toLowerCase() !== expectedEmail.toLowerCase()) {
    return { commit: null, mismatch: true };
  }
  const sha = asString(item.sha);
  const repository = asString(item.repository.full_name);
  const repositoryUrl = asString(item.repository.html_url);
  const url = asString(item.html_url);
  if (
    !sha ||
    !/^[0-9a-f]{7,64}$/i.test(sha) ||
    !repository ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !repositoryUrl?.startsWith("https://github.com/") ||
    !url?.startsWith("https://github.com/")
  ) {
    return { commit: null, mismatch: false };
  }
  const account = isRecord(item.author) ? item.author : null;
  const login = account ? asString(account.login) : null;
  const accountId = account ? nonnegativeInteger(account.id) : null;
  const normalizedLogin = login && /^[A-Za-z0-9-]{1,39}$/.test(login) ? login : null;
  const committer = isRecord(item.committer) ? item.committer : null;
  const rawCommitterLogin = committer ? asString(committer.login) : null;
  const committerLogin = rawCommitterLogin && /^[A-Za-z0-9-]{1,39}$/.test(rawCommitterLogin) ? rawCommitterLogin : null;
  return {
    mismatch: false,
    commit: {
      sha,
      url,
      repository,
      repositoryUrl,
      authoredAt: rawAuthor ? validIsoDate(rawAuthor.date) : null,
      authorName: rawAuthor ? asString(rawAuthor.name) : null,
      githubAccount: normalizedLogin,
      accountId,
      signature: parseSignature(item.commit.verification, normalizedLogin, committerLogin),
    },
  };
}

function makeGithubHeaders(token?: string): Headers {
  const headers = new Headers({
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "atlas-people-intelligence/0.1",
  });
  if (token?.trim()) headers.set("Authorization", `Bearer ${token.trim()}`);
  return headers;
}

function isRateLimited(response: Response): boolean {
  return response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0");
}

function finish(
  startedAt: number,
  now: () => number,
  status: ToolStatus,
  data: GithubCodegraphData | null,
  evidence: ToolEvidence[],
  diagnostics: ToolDiagnostic[],
  requests: number,
  bytesRead: number,
  incomplete: boolean,
): ToolResult<GithubCodegraphData> {
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

function strongestSignature(
  commits: readonly GithubCodegraphCommit[],
): (CommitSignatureSummary & { commitUrl: string }) | null {
  const verified = commits.find((commit) => commit.signature.verified && commit.signature.identityMatch);
  if (verified) return { ...verified.signature, commitUrl: verified.url };
  const withReason = commits.find((commit) => commit.signature.reason !== null);
  return withReason ? { ...withReason.signature, commitUrl: withReason.url } : null;
}

function selectSignatureChecks(
  commits: readonly SearchCommitItem[],
  maximum: number,
): { selected: SearchCommitItem[]; eligible: number } {
  const eligible = commits.filter((commit) => !commit.signature.verified);
  if (maximum <= 0) return { selected: [], eligible: eligible.length };
  const selected: SearchCommitItem[] = [];
  const represented = new Set<string>();
  for (const commit of eligible) {
    const group = commit.githubAccount?.toLowerCase() ?? `unattributed:${commit.repository}`;
    if (represented.has(group)) continue;
    represented.add(group);
    selected.push(commit);
    if (selected.length >= maximum) return { selected, eligible: eligible.length };
  }
  for (const commit of eligible) {
    if (selected.includes(commit)) continue;
    selected.push(commit);
    if (selected.length >= maximum) break;
  }
  return { selected, eligible: eligible.length };
}

/**
 * Maps an exact user-supplied email to public default-branch commit metadata.
 * Git author metadata is spoofable, so unsigned metadata never becomes a
 * high-confidence identity edge without separate corroboration.
 */
export async function investigateGithubEmailCodegraph(
  target: ExplicitGithubEmailTarget,
  context: ToolContext = {},
  options: GithubCodegraphOptions = {},
): Promise<ToolResult<GithubCodegraphData>> {
  const now = toolClock(context);
  const startedAt = now();
  const exactEmail = typeof target?.email === "string" ? target.email.trim() : "";
  if (target?.provenance !== "explicit_user_input") {
    return finish(
      startedAt,
      now,
      "skipped",
      null,
      [],
      [
        {
          code: "explicit_email_provenance_required",
          severity: "warning",
          message: "GitHub email correlation is restricted to an email explicitly supplied by the user.",
          retryable: false,
        },
      ],
      0,
      0,
      false,
    );
  }
  if (exactEmail.length > 254 || /[\r\n\s]/.test(exactEmail) || !/^[^@<>]+@[^@<>]+\.[^@<>]+$/.test(exactEmail)) {
    return finish(
      startedAt,
      now,
      "skipped",
      null,
      [],
      [
        {
          code: "invalid_email",
          severity: "warning",
          message: "GitHub commit correlation requires one syntactically valid exact email address.",
          retryable: false,
        },
      ],
      0,
      0,
      false,
    );
  }

  const maxCommits = bounded(options.maxCommits, 30, 1, 100);
  const maxResponseBytes = bounded(options.maxResponseBytes, 1_500_000, 8_192, 5_000_000);
  const fetchGithub = createHardenedFetch({
    allowedHostnames: ["api.github.com"],
    allowedMethods: ["GET"],
    allowedMimeTypes: ["application/json", "application/vnd.github+json"],
    timeoutMs: bounded(options.timeoutMs, 10_000, 500, 30_000),
    maxBytes: maxResponseBytes,
    maxRedirects: 0,
    maxRetries: 2,
    maxRetryAfterMs: 5_000,
    fetch: context.fetch,
    clock: now,
    beforeRequest: ({ safeUrl: outboundUrl }) =>
      reserveToolBudget(context, {
        tool: outboundUrl.endsWith("/search/commits") ? "github_email_codegraph" : "github_commit_signature",
        networkRequests: 1,
        expectedBytes: maxResponseBytes,
      }),
  });
  const searchUrl = new URL("https://api.github.com/search/commits");
  searchUrl.searchParams.set("q", `author-email:${exactEmail} is:public`);
  searchUrl.searchParams.set("sort", "committer-date");
  searchUrl.searchParams.set("order", "desc");
  searchUrl.searchParams.set("per_page", String(maxCommits));

  let requests = 0;
  let bytesRead = 0;
  let search;
  try {
    search = await fetchGithub(searchUrl, {
      headers: makeGithubHeaders(options.githubToken),
      signal: context.signal,
    });
  } catch (error) {
    const retryable = error instanceof HardenedFetchError && error.retryable;
    const budgetExhausted = error instanceof HardenedFetchError && error.code === "budget_exhausted";
    return finish(
      startedAt,
      now,
      budgetExhausted ? "skipped" : "failed",
      null,
      [],
      [
        {
          code: error instanceof HardenedFetchError ? error.code : "github_unavailable",
          severity: budgetExhausted ? "info" : "error",
          message: budgetExhausted
            ? "GitHub correlation was skipped because the network budget was exhausted."
            : "GitHub commit search was unavailable.",
          retryable,
        },
      ],
      error instanceof HardenedFetchError ? error.requests : requests,
      bytesRead,
      true,
    );
  }
  requests += search.requests;
  bytesRead += search.bytesRead;
  if (isRateLimited(search.response)) {
    return finish(
      startedAt,
      now,
      "rate_limited",
      null,
      [],
      [
        {
          code: "github_rate_limited",
          severity: "warning",
          message: "GitHub rate-limited commit search; absence cannot be assessed.",
          retryable: true,
          details: { resetEpochSeconds: nonnegativeInteger(search.response.headers.get("x-ratelimit-reset")) },
        },
      ],
      requests,
      bytesRead,
      true,
    );
  }
  if (!search.response.ok) {
    return finish(
      startedAt,
      now,
      "failed",
      null,
      [],
      [
        {
          code: "github_http_error",
          severity: "error",
          message: `GitHub commit search returned HTTP ${search.response.status}.`,
          retryable: search.response.status >= 500,
        },
      ],
      requests,
      bytesRead,
      true,
    );
  }

  let payload: unknown;
  try {
    payload = await search.response.json();
  } catch {
    return finish(
      startedAt,
      now,
      "failed",
      null,
      [],
      [
        {
          code: "github_invalid_json",
          severity: "error",
          message: "GitHub commit search returned malformed JSON.",
          retryable: true,
        },
      ],
      requests,
      bytesRead,
      true,
    );
  }
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    return finish(
      startedAt,
      now,
      "failed",
      null,
      [],
      [
        {
          code: "github_invalid_response",
          severity: "error",
          message: "GitHub commit search returned an unexpected response shape.",
          retryable: false,
        },
      ],
      requests,
      bytesRead,
      true,
    );
  }

  const totalCountReported = nonnegativeInteger(payload.total_count);
  const incompleteResults = payload.incomplete_results === true;
  const capped = totalCountReported !== null && totalCountReported > payload.items.length;
  const rateLimitRemaining = nonnegativeInteger(search.response.headers.get("x-ratelimit-remaining"));
  const commits: SearchCommitItem[] = [];
  let mismatchCount = 0;
  for (const item of payload.items) {
    const parsed = parseSearchCommit(item, exactEmail);
    if (parsed.mismatch) mismatchCount += 1;
    if (parsed.commit) commits.push(parsed.commit);
  }
  const diagnostics: ToolDiagnostic[] = [];
  if (mismatchCount)
    diagnostics.push({
      code: "github_email_mismatch",
      severity: "warning",
      message:
        "GitHub returned commit rows whose author email did not exactly match the requested identifier; they were excluded.",
      retryable: false,
      details: { count: mismatchCount },
    });
  if (incompleteResults)
    diagnostics.push({
      code: "github_incomplete_results",
      severity: "warning",
      message: "GitHub marked the commit search incomplete; the returned graph is not exhaustive.",
      retryable: true,
    });
  if (capped)
    diagnostics.push({
      code: "github_bounded_results",
      severity: "info",
      message: "The commit graph was intentionally capped; account and repository counts describe only returned rows.",
      retryable: false,
      details: { returned: payload.items.length, totalReported: totalCountReported },
    });

  const signatureSelection = selectSignatureChecks(commits, bounded(options.maxSignatureChecks, 6, 0, 20));
  const checks = signatureSelection.selected;
  let signatureChecksIncomplete = checks.length < signatureSelection.eligible;
  if (signatureChecksIncomplete)
    diagnostics.push({
      code: "signature_checks_bounded",
      severity: "info",
      message: "Commit signature checks were bounded; unchecked rows remain unverified.",
      retryable: false,
      details: { checked: checks.length, eligible: signatureSelection.eligible },
    });
  for (const commit of checks) {
    const [owner, repositoryName] = commit.repository.split("/");
    const detailUrl = new URL(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repositoryName)}/commits/${encodeURIComponent(commit.sha)}`,
      "https://api.github.com",
    );
    try {
      const detail = await fetchGithub(detailUrl, {
        headers: makeGithubHeaders(options.githubToken),
        signal: context.signal,
      });
      requests += detail.requests;
      bytesRead += detail.bytesRead;
      if (isRateLimited(detail.response)) {
        signatureChecksIncomplete = true;
        diagnostics.push({
          code: "signature_check_rate_limited",
          severity: "warning",
          message: "GitHub rate-limited bounded signature verification; remaining checks were stopped.",
          retryable: true,
        });
        break;
      }
      if (!detail.response.ok) {
        signatureChecksIncomplete = true;
        diagnostics.push({
          code: "signature_check_http_error",
          severity: "warning",
          message: `A bounded commit signature check returned HTTP ${detail.response.status}.`,
          retryable: detail.response.status >= 500,
        });
        continue;
      }
      const detailPayload: unknown = await detail.response.json();
      if (isRecord(detailPayload) && isRecord(detailPayload.commit)) {
        const detailAuthor = isRecord(detailPayload.author) ? asString(detailPayload.author.login) : null;
        const detailCommitter = isRecord(detailPayload.committer) ? asString(detailPayload.committer.login) : null;
        commit.signature = parseSignature(
          detailPayload.commit.verification,
          detailAuthor ?? commit.githubAccount,
          detailCommitter,
        );
      }
    } catch (error) {
      signatureChecksIncomplete = true;
      if (error instanceof HardenedFetchError) requests += error.requests;
      const budgetExhausted = error instanceof HardenedFetchError && error.code === "budget_exhausted";
      diagnostics.push({
        code: budgetExhausted
          ? "signature_check_budget_exhausted"
          : error instanceof HardenedFetchError
            ? error.code
            : "signature_check_failed",
        severity: budgetExhausted ? "info" : "warning",
        message: budgetExhausted
          ? "Remaining commit signature checks were skipped because the network budget was exhausted."
          : "A bounded commit signature check failed; the commit remains unverified.",
        retryable: error instanceof HardenedFetchError && error.retryable,
      });
      if (budgetExhausted) break;
    }
  }

  const signatureIdentityMismatches = commits.filter(
    (commit) => commit.signature.verified && !commit.signature.identityMatch,
  ).length;
  if (signatureIdentityMismatches)
    diagnostics.push({
      code: "signature_identity_mismatch",
      severity: "warning",
      message:
        "Verified signatures with a different or missing committer account did not strengthen the author-email identity edge.",
      retryable: false,
      details: { count: signatureIdentityMismatches },
    });

  const grouped = new Map<string, SearchCommitItem[]>();
  for (const commit of commits) {
    if (!commit.githubAccount) continue;
    const key = commit.githubAccount.toLowerCase();
    grouped.set(key, [...(grouped.get(key) ?? []), commit]);
  }
  const accounts: GithubAccountCluster[] = [...grouped.values()].map((accountCommits) => {
    const first = accountCommits[0];
    return {
      login: first.githubAccount as string,
      accountId: first.accountId,
      url: `https://github.com/${encodeURIComponent(first.githubAccount as string)}`,
      commitCount: accountCommits.length,
      repositories: [...new Set(accountCommits.map((commit) => commit.repository))].sort(),
      strongestSignature: strongestSignature(accountCommits),
      keybaseProofs: [],
    };
  });
  if (accounts.length > 1)
    diagnostics.push({
      code: "multiple_github_accounts",
      severity: "warning",
      message:
        "The exact email appears in commits attributed to multiple GitHub accounts; the accounts remain separate candidates.",
      retryable: false,
      details: { count: accounts.length },
    });
  const unattributedCommitCount = commits.filter((commit) => commit.githubAccount === null).length;
  if (unattributedCommitCount)
    diagnostics.push({
      code: "github_author_null",
      severity: "info",
      message: "Some exact-email commits have no GitHub account association and remain metadata-only edges.",
      retryable: false,
      details: { count: unattributedCommitCount },
    });

  let optionalIncomplete = false;
  if (options.includeKeybase) {
    const keybaseAccounts = accounts.slice(0, bounded(options.maxKeybaseAccounts, 3, 0, 10));
    for (const account of keybaseAccounts) {
      const keybase = await lookupKeybaseGithub(account.login, context, {
        staleAfterDays: options.keybaseStaleAfterDays,
        timeoutMs: options.timeoutMs,
      });
      requests += keybase.meta.requests;
      bytesRead += keybase.meta.bytesRead;
      account.keybaseProofs = keybase.data?.proofs ?? [];
      diagnostics.push(...keybase.diagnostics);
      optionalIncomplete ||= keybase.meta.incomplete;
    }
  }

  const observedAt = isoTime(now());
  const evidence: ToolEvidence[] = commits.map((commit) => ({
    sourceUrl: commit.url,
    sourceType: "github_public_commit",
    title: `Public commit metadata in ${commit.repository}`,
    observedAt,
    attributes: {
      sha: commit.sha,
      repository: commit.repository,
      authoredAt: commit.authoredAt,
      githubAccount: commit.githubAccount,
      exactAuthorEmailMatch: true,
      signatureVerified: commit.signature.verified,
      signatureIdentityMatch: commit.signature.identityMatch,
      signatureCommitterAccount: commit.signature.committerAccount,
      signatureReason: commit.signature.reason,
    },
    candidate: {
      candidateId: commit.githubAccount
        ? `github:${commit.githubAccount.toLowerCase()}`
        : `email:${exactEmail.toLowerCase()}`,
      basis: commit.githubAccount ? "github_commit_account_association" : "exact_git_author_email",
    },
    confidenceCap: commit.signature.identityMatch ? 0.84 : commit.githubAccount ? 0.68 : 0.52,
  }));
  for (const account of accounts) {
    for (const proof of account.keybaseProofs.filter((item) => item.status === "verified" || item.status === "stale")) {
      evidence.push({
        sourceUrl: proof.proofUrl ?? proof.profileUrl,
        sourceType: "keybase_github_proof",
        title: `Keybase proof edge for GitHub account ${account.login}`,
        observedAt: proof.observedAt,
        attributes: {
          githubHandle: proof.githubHandle,
          keybaseUsername: proof.keybaseUsername,
          status: proof.status,
          proofUpdatedAt: proof.proofUpdatedAt,
        },
        candidate: { candidateId: `github:${account.login.toLowerCase()}`, basis: "keybase_github_proof" },
        confidenceCap: proof.status === "verified" ? 0.9 : 0.72,
      });
    }
  }

  const incomplete = incompleteResults || capped || optionalIncomplete || signatureChecksIncomplete;
  if (commits.length === 0)
    diagnostics.push({
      code: "github_commits_not_observed",
      severity: "info",
      message: incomplete
        ? "No exact-email commits were observed in this incomplete search window."
        : "No exact-email commits were observed on indexed public default branches; this is not evidence of no GitHub activity.",
      retryable: incomplete,
    });
  const data: GithubCodegraphData = {
    exactEmail,
    commits: commits.map((commit) => ({
      sha: commit.sha,
      url: commit.url,
      repository: commit.repository,
      repositoryUrl: commit.repositoryUrl,
      authoredAt: commit.authoredAt,
      authorName: commit.authorName,
      githubAccount: commit.githubAccount,
      signature: commit.signature,
    })),
    accounts,
    unattributedCommitCount,
    totalCountReported,
    incompleteResults,
    capped,
    rateLimitRemaining,
    scopeNote:
      "GitHub commit search covers indexed commits on public repositories' default branches; metadata can be spoofed.",
  };
  const status: ToolStatus =
    commits.length === 0 ? (incomplete ? "partial" : "not_found") : incomplete ? "partial" : "succeeded";
  return finish(startedAt, now, status, data, evidence, diagnostics, requests, bytesRead, incomplete);
}

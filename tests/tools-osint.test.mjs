import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "vite";

const vite = await createServer({
  configFile: false,
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true },
});
after(async () => vite.close());

const { investigateGithubEmailCodegraph } = await vite.ssrLoadModule("/lib/tools/github-codegraph.ts");
const { lookupKeybaseGithub } = await vite.ssrLoadModule("/lib/tools/keybase.ts");
const { inspectWaybackHistory } = await vite.ssrLoadModule("/lib/tools/wayback.ts");

const jsonResponse = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });

function commitItem({ sha, email, login, accountId, repo, verified = false, committerLogin = login }) {
  return {
    sha,
    html_url: `https://github.com/${repo}/commit/${sha}`,
    commit: {
      author: { name: "Public Commit Author", email, date: "2026-07-01T00:00:00Z" },
      verification: {
        verified,
        reason: verified ? "valid" : "unsigned",
        verified_at: verified ? "2026-07-02T00:00:00Z" : null,
      },
    },
    author: login === null ? null : { login, id: accountId },
    committer: committerLogin === null ? null : { login: committerLogin, id: accountId },
    repository: { full_name: repo, html_url: `https://github.com/${repo}` },
  };
}

test("GitHub exact-email codegraph separates accounts, null authors, mismatches, and strongest signatures", async () => {
  const email = "person@example.com";
  const calls = [];
  const fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.hostname === "api.github.com" && url.pathname === "/search/commits") {
      assert.equal(url.searchParams.get("q"), `author-email:${email} is:public`);
      return jsonResponse(
        {
          total_count: 4,
          incomplete_results: false,
          items: [
            commitItem({ sha: "a".repeat(40), email, login: "alice", accountId: 1, repo: "org/alpha" }),
            commitItem({ sha: "b".repeat(40), email, login: null, accountId: null, repo: "org/beta", verified: true }),
            commitItem({
              sha: "c".repeat(40),
              email: "other@example.com",
              login: "wrong",
              accountId: 9,
              repo: "org/wrong",
            }),
            commitItem({ sha: "d".repeat(40), email, login: "bob", accountId: 2, repo: "org/delta", verified: true }),
          ],
        },
        { headers: { "x-ratelimit-remaining": "8" } },
      );
    }
    if (url.hostname === "api.github.com" && url.pathname.includes("/commits/")) {
      return jsonResponse({
        commit: {
          verification: { verified: true, reason: "valid", verified_at: "2026-07-03T00:00:00Z" },
        },
        author: { login: "alice" },
        committer: { login: "alice" },
      });
    }
    if (url.hostname === "keybase.io") {
      const handle = url.searchParams.get("github");
      return jsonResponse({
        status: { code: 0 },
        them: [
          {
            basics: { username: `kb_${handle}` },
            proofs_summary: {
              by_proof_type: {
                github: [
                  {
                    proof_type: "github",
                    nametag: handle,
                    state: 1,
                    mtime: 1_783_036_800,
                    proof_url: `https://gist.github.com/${handle}/proof`,
                  },
                ],
              },
            },
          },
        ],
      });
    }
    throw new Error(`Unexpected mock request: ${url.origin}${url.pathname}`);
  };

  const result = await investigateGithubEmailCodegraph(
    { email, provenance: "explicit_user_input" },
    {
      fetch,
      clock: () => Date.parse("2026-08-18T00:00:00Z"),
    },
    {
      maxCommits: 10,
      maxSignatureChecks: 1,
      includeKeybase: true,
      maxKeybaseAccounts: 2,
    },
  );

  assert.equal(result.status, "succeeded");
  assert.equal(result.data.commits.length, 3);
  assert.equal(result.data.accounts.length, 2);
  assert.deepEqual(result.data.accounts.map((account) => account.login).sort(), ["alice", "bob"]);
  assert.equal(result.data.unattributedCommitCount, 1);
  assert.equal(result.data.accounts.find((account) => account.login === "alice").strongestSignature.verified, true);
  assert.equal(
    result.data.accounts.every((account) => account.keybaseProofs[0].status === "verified"),
    true,
  );
  assert.ok(result.diagnostics.some((item) => item.code === "github_email_mismatch"));
  assert.ok(result.diagnostics.some((item) => item.code === "multiple_github_accounts"));
  assert.ok(result.diagnostics.some((item) => item.code === "github_author_null"));
  assert.equal(result.evidence.filter((item) => item.sourceType === "github_public_commit").length, 3);
  assert.equal(
    calls.filter((url) => url.hostname === "api.github.com" && url.pathname.includes("/commits/")).length,
    1,
  );
});

test("GitHub incomplete empty results never become a definitive absence claim", async () => {
  const result = await investigateGithubEmailCodegraph(
    {
      email: "nobody@example.com",
      provenance: "explicit_user_input",
    },
    {
      fetch: async () => jsonResponse({ total_count: 0, incomplete_results: true, items: [] }),
      clock: () => Date.parse("2026-08-18T00:00:00Z"),
    },
  );
  assert.equal(result.status, "partial");
  assert.equal(result.meta.incomplete, true);
  assert.match(result.diagnostics.find((item) => item.code === "github_commits_not_observed").message, /incomplete/i);
});

test("GitHub rate limits and null search data are explicit", async () => {
  const result = await investigateGithubEmailCodegraph(
    {
      email: "person@example.com",
      provenance: "explicit_user_input",
    },
    {
      fetch: async () =>
        jsonResponse(
          { message: "rate limited" },
          {
            status: 403,
            headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000000" },
          },
        ),
    },
  );
  assert.equal(result.status, "rate_limited");
  assert.equal(result.data, null);
  assert.equal(result.meta.incomplete, true);
});

test("ToolContext reserves budget before each transport retry", async () => {
  let reservations = 0;
  let fetchCalls = 0;
  const result = await investigateGithubEmailCodegraph(
    {
      email: "person@example.com",
      provenance: "explicit_user_input",
    },
    {
      consumeBudget: async () => {
        reservations += 1;
        return reservations === 1;
      },
      fetch: async () => {
        fetchCalls += 1;
        return jsonResponse({ message: "slow down" }, { status: 429, headers: { "retry-after": "0" } });
      },
    },
  );
  assert.equal(reservations, 2);
  assert.equal(fetchCalls, 1);
  assert.equal(result.meta.requests, 1);
  assert.equal(result.diagnostics[0].code, "budget_exhausted");
});

test("GitHub rejects inferred emails and signer-account mismatches cannot strengthen identity", async () => {
  let calls = 0;
  const inferred = await investigateGithubEmailCodegraph(
    {
      email: "inferred@example.com",
      provenance: "model_inference",
    },
    {
      fetch: async () => {
        calls += 1;
        throw new Error("unexpected");
      },
    },
  );
  assert.equal(inferred.status, "skipped");
  assert.equal(inferred.diagnostics[0].code, "explicit_email_provenance_required");
  assert.equal(calls, 0);

  const mismatch = await investigateGithubEmailCodegraph(
    {
      email: "person@example.com",
      provenance: "explicit_user_input",
    },
    {
      fetch: async () => {
        calls += 1;
        return jsonResponse({
          total_count: 1,
          incomplete_results: false,
          items: [
            commitItem({
              sha: "e".repeat(40),
              email: "person@example.com",
              login: "alice",
              committerLogin: "release-bot",
              accountId: 1,
              repo: "org/signed-by-bot",
              verified: true,
            }),
          ],
        });
      },
    },
  );
  assert.equal(mismatch.data.commits[0].signature.verified, true);
  assert.equal(mismatch.data.commits[0].signature.identityMatch, false);
  assert.ok(mismatch.diagnostics.some((item) => item.code === "signature_identity_mismatch"));
  assert.equal(mismatch.evidence[0].confidenceCap, 0.68);
});

test("Keybase rejects mismatched and stale proof edges as strong corroboration", async () => {
  const result = await lookupKeybaseGithub(
    "alice",
    {
      fetch: async () =>
        jsonResponse({
          status: { code: "0" },
          them: [
            {
              basics: { username: "alice_kb" },
              proofs_summary: {
                by_proof_type: {
                  github: [
                    { proof_type: "github", nametag: "mallory", state: 1, mtime: 1_700_000_000 },
                    { proof_type: "github", nametag: "alice", state: 1, mtime: 1_500_000_000 },
                  ],
                },
              },
            },
          ],
        }),
      clock: () => Date.parse("2026-08-18T00:00:00Z"),
    },
    { staleAfterDays: 365 },
  );
  assert.deepEqual(result.data.proofs.map((proof) => proof.status).sort(), ["mismatch", "stale"]);
  assert.ok(result.diagnostics.some((item) => item.code === "keybase_handle_mismatch"));
  assert.ok(result.diagnostics.some((item) => item.code === "keybase_stale_proof"));
});

test("Wayback runs only for candidate-linked URLs and globally collapses digests", async () => {
  let calls = 0;
  const result = await inspectWaybackHistory(
    {
      url: "https://person.example/about",
      candidate: { candidateId: "candidate-1", basis: "resolved_candidate_profile" },
    },
    {
      clock: () => Date.parse("2026-08-18T00:00:00Z"),
      fetch: async (input) => {
        calls += 1;
        const url = new URL(String(input));
        if (url.pathname === "/cdx/search/cdx") {
          assert.equal(url.searchParams.get("collapse"), "digest");
          assert.deepEqual(url.searchParams.getAll("filter"), ["statuscode:200", "mimetype:text/html"]);
          return jsonResponse([
            ["timestamp", "original", "mimetype", "statuscode", "digest", "length"],
            ["20200101000000", "https://person.example/about", "text/html", "200", "DIGEST-A", "100"],
            ["20210101000000", "https://person.example/about", "text/html", "200", "DIGEST-B", "110"],
            ["20200102000000", "https://person.example/about", "text/html", "200", "DIGEST-A", "105"],
            ["20220101000000", "https://person.example/about", "text/html", "200", "DIGEST-C", "115"],
            ["bad", "https://person.example/about", "text/html", "200", "BROKEN", "0"],
          ]);
        }
        const archivedText = url.pathname.includes("20200101000000")
          ? "<html><body><main>Then: independent designer in Phoenix.</main></body></html>"
          : "<html><body><main>Now: product lead in New York.</main></body></html>";
        return new Response(archivedText, { headers: { "content-type": "text/html" } });
      },
    },
    { maxCaptures: 10 },
  );

  assert.equal(calls, 3);
  assert.equal(result.status, "partial");
  assert.equal(result.data.captures.length, 3);
  const digestA = result.data.captures.find((capture) => capture.digest === "DIGEST-A");
  assert.equal(digestA.adjacentCaptureCount, 2);
  assert.equal(digestA.firstTimestamp, "2020-01-01T00:00:00.000Z");
  assert.equal(digestA.lastTimestamp, "2020-01-02T00:00:00.000Z");
  assert.equal(
    result.evidence.every((item) => item.candidate.candidateId === "candidate-1"),
    true,
  );
  assert.equal(result.data.snapshots.length, 2);
  assert.ok(result.data.temporalChange);
  assert.match(result.data.temporalChange.then.textExcerpt, /Then:/);
  assert.match(result.data.temporalChange.now.textExcerpt, /Now:/);
  assert.equal(result.evidence.filter((item) => item.sourceType === "wayback_snapshot").length, 2);
});

test("Wayback validation and outages are soft failures", async () => {
  let calls = 0;
  const missingCandidate = await inspectWaybackHistory(
    {
      url: "https://person.example/",
      candidate: { candidateId: "", basis: "resolved_candidate_profile" },
    },
    {
      fetch: async () => {
        calls += 1;
        throw new Error("unexpected");
      },
    },
  );
  assert.equal(missingCandidate.status, "skipped");

  const privateTarget = await inspectWaybackHistory(
    {
      url: "http://person.example/private",
      candidate: { candidateId: "candidate-1", basis: "user_supplied_candidate_url" },
    },
    {
      fetch: async () => {
        calls += 1;
        throw new Error("unexpected");
      },
    },
  );
  assert.equal(privateTarget.status, "skipped");
  assert.equal(calls, 0);

  const outage = await inspectWaybackHistory(
    {
      url: "https://person.example/",
      candidate: { candidateId: "candidate-1", basis: "resolved_candidate_profile" },
    },
    {
      fetch: async () => {
        throw new Error("offline");
      },
    },
    { timeoutMs: 100, maxCaptures: 2 },
  );
  assert.equal(outage.status, "failed");
  assert.equal(outage.meta.incomplete, true);
});

test("Wayback does not surface Then/Now when selected snapshot text is unchanged", async () => {
  const result = await inspectWaybackHistory(
    {
      url: "https://person.example/",
      candidate: { candidateId: "candidate-1", basis: "resolved_candidate_profile" },
    },
    {
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/cdx/search/cdx") {
          return jsonResponse([
            ["timestamp", "original", "mimetype", "statuscode", "digest", "length"],
            ["20200101000000", "https://person.example/", "text/html", "200", "DIGEST-A", "100"],
            ["20220101000000", "https://person.example/", "text/html", "200", "DIGEST-B", "110"],
          ]);
        }
        return new Response("<html><body>Same public biography.</body></html>", {
          headers: { "content-type": "text/html" },
        });
      },
    },
  );
  assert.equal(result.data.snapshots.length, 2);
  assert.equal(result.data.temporalChange, null);
  assert.equal(
    result.evidence
      .filter((item) => item.sourceType === "wayback_snapshot")
      .every((item) => item.attributes.temporalChangeObserved === false),
    true,
  );
});

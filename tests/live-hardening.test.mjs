import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "vite";

const vite = await createServer({
  configFile: false,
  cacheDir: `node_modules/.vite-atlas-ssr/${process.pid}`,
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true },
});
after(async () => vite.close());

const domain = await vite.ssrLoadModule("/lib/domain/index.ts");
const agent = await vite.ssrLoadModule("/lib/agent/index.ts");
const search = await vite.ssrLoadModule("/lib/search/index.ts");
const { createLiveDependencies, positiveSiteScopesFromCompilerQuery, sourceAllowedForCandidate, streamLiveResearch } =
  await vite.ssrLoadModule("/lib/live/orchestrator.ts");
const { fetchPublicSource } = await vite.ssrLoadModule("/lib/tools/public-source.ts");
const reportExport = await vite.ssrLoadModule("/lib/report-export/index.ts");

const TOKEN_FIELDS = ["inputTokens", "cachedInputTokens", "outputTokens", "thinkingTokens", "costUsd"];

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function completion(
  callNumber,
  argumentsValue,
  usage = {
    prompt_tokens: 1,
    completion_tokens: 1,
    reasoning_tokens: 1,
    prompt_tokens_details: { cached_tokens: 1 },
    cost: 0.001,
  },
) {
  return jsonResponse({
    id: `gen-${callNumber}`,
    model: "test/model",
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: `call-${callNumber}`,
              type: "function",
              function: { name: "propose_research_batch", arguments: argumentsValue },
            },
          ],
        },
      },
    ],
    ...(usage === null ? {} : { usage }),
  });
}

async function liveEvents(fetch, signal) {
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: "Grace Hopper public professional background",
    requestedDepth: "quick",
  });
  const events = [];
  for await (const event of streamLiveResearch(input, {
    apiKey: "test-key",
    model: "test/model",
    fetch,
    ...(signal ? { signal } : {}),
  }))
    events.push(event);
  return events;
}

test("arbitrary-host public fetches require DNS validation and block private answers", async () => {
  let fetchCalls = 0;
  const fetchStub = async () => {
    fetchCalls += 1;
    return new Response("<title>Public profile</title><p>Public professional text.</p>", {
      headers: { "content-type": "text/html" },
    });
  };
  const input = { url: "https://profile.example/person", allowedUrl: "https://profile.example/person" };

  const unavailable = await fetchPublicSource(input, { fetch: fetchStub });
  assert.equal(unavailable.status, "skipped");
  assert.equal(unavailable.diagnostics[0].code, "dns_validation_unavailable");
  assert.equal(fetchCalls, 0);

  const privateAnswer = await fetchPublicSource(input, {
    fetch: fetchStub,
    resolveHostname: async () => ["10.0.0.9", "93.184.216.34"],
  });
  assert.equal(privateAnswer.status, "failed");
  assert.equal(privateAnswer.diagnostics[0].code, "blocked_address");
  assert.equal(fetchCalls, 0);

  const publicAnswer = await fetchPublicSource(input, {
    fetch: fetchStub,
    resolveHostname: async () => ["93.184.216.34"],
  });
  assert.equal(publicAnswer.status, "succeeded");
  assert.equal(fetchCalls, 1);

  const blockedResponse = new Response("LinkedIn request blocked", {
    headers: { "content-type": "text/html" },
  });
  Object.defineProperty(blockedResponse, "status", { value: 999 });
  const nonstandard = await fetchPublicSource(input, {
    fetch: async () => blockedResponse,
    resolveHostname: async () => ["93.184.216.34"],
  });
  assert.equal(nonstandard.status, "failed");
  assert.equal(nonstandard.diagnostics[0].code, "nonstandard_http_status");
  assert.equal(nonstandard.diagnostics[0].details.httpStatus, 999);
  assert.equal(nonstandard.diagnostics[0].details.requests, 1);
  assert.notEqual(nonstandard.diagnostics[0].code, "public_source_unavailable");
  assert.equal(nonstandard.meta.requests, 1);
  assert.equal(nonstandard.meta.bytesRead, 0);
});

test("public fetch text and title ignore nested or unclosed inactive markup", async () => {
  const input = { url: "https://profile.example/person", allowedUrl: "https://profile.example/person" };
  const nested = await fetchPublicSource(input, {
    resolveHostname: async () => ["93.184.216.34"],
    fetch: async () =>
      new Response(
        "<html><head><script><title>Ganesh Talluri</title></script><title>Real Page</title></head><body><p>Visible Other</p><template><template></template><p>Ganesh Talluri</p></template></body></html>",
        { headers: { "content-type": "text/html" } },
      ),
  });
  assert.equal(nested.status, "succeeded");
  assert.equal(nested.data.title, "Real Page");
  assert.equal(nested.data.normalizedText, "Real Page Visible Other");
  assert.equal(JSON.stringify(nested.data).includes("Ganesh Talluri"), false);

  const unclosed = await fetchPublicSource(input, {
    resolveHostname: async () => ["93.184.216.34"],
    fetch: async () =>
      new Response(
        "<html><head><title>Real Page</title></head><body><p>Visible Other</p><script><p>Ganesh Talluri</p>",
        { headers: { "content-type": "text/html" } },
      ),
  });
  assert.equal(unclosed.data.title, "Real Page");
  assert.equal(unclosed.data.normalizedText, "Real Page Visible Other");
  assert.equal(JSON.stringify(unclosed.data).includes("Ganesh Talluri"), false);

  const crossType = await fetchPublicSource(input, {
    resolveHostname: async () => ["93.184.216.34"],
    fetch: async () =>
      new Response(
        '<title>Real Page</title><p>Visible Other</p><template><script>const x="</template>";<p>Ganesh Talluri</p></script></template>',
        { headers: { "content-type": "text/html" } },
      ),
  });
  assert.equal(crossType.data.title, "Real Page");
  assert.equal(crossType.data.normalizedText, "Real Page Visible Other");

  const plaintext = await fetchPublicSource(input, {
    resolveHostname: async () => ["93.184.216.34"],
    fetch: async () =>
      new Response(
        "<title>Real Page</title><p>Visible Other</p><plaintext>hidden</plaintext><p>Ganesh Talluri</p><title>Forged Page</title>",
        { headers: { "content-type": "text/html" } },
      ),
  });
  assert.equal(plaintext.data.title, "Real Page");
  assert.equal(plaintext.data.normalizedText, "Real Page Visible Other");
  assert.equal(JSON.stringify(plaintext.data).includes("Ganesh Talluri"), false);

  const declarations = await fetchPublicSource(input, {
    resolveHostname: async () => ["93.184.216.34"],
    fetch: async () =>
      new Response(
        '<!DOCTYPE html PUBLIC "<title>Ganesh Talluri</title>"><?xml value="<p>Ganesh Talluri</p>"><![CDATA[<p>Ganesh Talluri</p>]]><title>Real Page</title><p>Visible Other</p>',
        { headers: { "content-type": "text/html" } },
      ),
  });
  assert.equal(declarations.data.title, "Real Page");
  assert.equal(declarations.data.normalizedText, "Real Page Visible Other");
  assert.equal(JSON.stringify(declarations.data).includes("Ganesh Talluri"), false);

  const quotedAttribute = await fetchPublicSource(input, {
    resolveHostname: async () => ["93.184.216.34"],
    fetch: async () =>
      new Response(
        '<title>Real Page</title><div data-note=">Ganesh Talluri is CEO of Forged Labs">Visible harmless biography.</div>',
        { headers: { "content-type": "text/html" } },
      ),
  });
  assert.equal(quotedAttribute.data.title, "Real Page");
  assert.equal(quotedAttribute.data.normalizedText, "Real Page Visible harmless biography.");
  assert.equal(JSON.stringify(quotedAttribute.data).includes("Forged Labs"), false);

  const titleCredential = await fetchPublicSource(input, {
    resolveHostname: async () => ["93.184.216.34"],
    fetch: async () =>
      new Response(`<title>${"A".repeat(233)} ghp_${"B".repeat(36)}</title><p>Visible Other</p>`, {
        headers: { "content-type": "text/html" },
      }),
  });
  assert.equal(titleCredential.data.title, null);
  assert.equal(titleCredential.data.normalizedText, "Visible Other");
  assert.equal(JSON.stringify(titleCredential.data).includes("ghp_"), false);
});

test("public fetch decodes references, strips format controls, and honors strict inactive closes", async () => {
  const input = { url: "https://profile.example/person", allowedUrl: "https://profile.example/person" };
  const fetchHtml = (html) =>
    fetchPublicSource(input, {
      resolveHostname: async () => ["93.184.216.34"],
      fetch: async () => new Response(html, { headers: { "content-type": "text/html" } }),
    });

  const obfuscated = [
    `ghp&#x5f${"G".repeat(36)}`,
    `ghp&#95${"H".repeat(36)}`,
    `ghp&amp;#x5f;${"I".repeat(36)}`,
    `ghp&lowbar;${"J".repeat(36)}`,
    "private&commat;example.com",
    ...["\u200b", "\u200c", "\u200d", "\u2060", "\ufeff"].map((control) => `ghp_${control}${"K".repeat(36)}`),
  ];
  for (const value of obfuscated) {
    const result = await fetchHtml(`<title>Safe Profile</title><p>${value}</p>`);
    assert.equal(result.data.title, "Safe Profile", value);
    assert.equal(result.data.normalizedText, "Safe Profile", value);
    assert.equal(JSON.stringify(result.data).includes("ghp_"), false, value);
    assert.equal(JSON.stringify(result.data).includes("private@example.com"), false, value);
  }

  const common = await fetchHtml(
    "<title>&Eacute;lodie&rsquo;s R&eacute;sum&eacute; &mdash; Research &copy;</title><p>&ldquo;Registered&rdquo; &reg; profile.</p>",
  );
  assert.equal(common.data.title, "Élodie’s Résumé — Research ©");
  assert.equal(common.data.normalizedText, "Élodie’s Résumé — Research © “Registered” ® profile.");

  const footerContact = await fetchHtml(
    "<title>Safe Profile</title><main><p>Public systems researcher and founder.</p></main><footer>private&commat;example.com</footer>",
  );
  assert.equal(footerContact.data.normalizedText, "Safe Profile Public systems researcher and founder.");
  assert.equal(JSON.stringify(footerContact.data).includes("private@example.com"), false);

  const unresolved = await fetchHtml("<title>Unresolved &madeup; title</title><p>Unresolved &madeup; body</p>");
  assert.equal(unresolved.data.title, null);
  assert.equal(unresolved.data.normalizedText, "");

  for (const tag of ["script", "textarea", "template"]) {
    for (const invalidClose of [`</${tag}!>`, `</ ${tag}>`, `</${tag}\u00a0>`]) {
      const result = await fetchHtml(
        `<title>Safe Profile</title><p>Visible Before</p><${tag}><p>Hidden Before</p>${invalidClose}<p>Hidden After</p></${tag}><p>Visible After</p>`,
      );
      assert.equal(
        result.data.normalizedText,
        "Safe Profile Visible Before Visible After",
        `${tag} ${JSON.stringify(invalidClose)}`,
      );
      assert.equal(JSON.stringify(result.data).includes("Hidden"), false, `${tag} ${JSON.stringify(invalidClose)}`);
    }
  }
});

test("candidate source authorization is exact, candidate-scoped, and rejects secret query keys", () => {
  const state = {
    evidence: [{ candidateId: "candidate-1", sourceUrl: "https://example.com/profile?view=public" }],
    candidates: [
      {
        id: "candidate-1",
        signals: [{ kind: "profile_url", value: "https://profiles.example/person" }],
      },
    ],
  };
  assert.equal(
    sourceAllowedForCandidate(state, "https://example.com/profile?view=public", "candidate-1"),
    "https://example.com/profile?view=public",
  );
  assert.equal(sourceAllowedForCandidate(state, "https://example.com/profile?view=private", "candidate-1"), null);
  assert.equal(sourceAllowedForCandidate(state, "https://example.com/profile?view=public", "candidate-2"), null);
  assert.equal(sourceAllowedForCandidate(state, "https://example.com/profile?view=public", undefined), null);
  assert.equal(sourceAllowedForCandidate(state, "https://example.com/profile?access_token=model", "candidate-1"), null);
  assert.equal(
    sourceAllowedForCandidate(state, "https://profiles.example/person", "candidate-1"),
    "https://profiles.example/person",
  );
});

test("candidate-linked Wayback action emits exact hashes and a bounded visible temporal diff", async () => {
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: "Denise Hilary",
    requestedDepth: "standard",
  });
  const engine = new agent.InvestigationEngine(input, {
    clock: domain.createSequenceClock("2026-08-20T20:20:00.000Z", 1),
    ids: domain.createDeterministicIdFactory("wayback-live-bridge"),
  });
  const targetUrl = "https://portfolio.example/denise";
  const candidate = engine.addCandidate({
    displayName: "Denise Hilary",
    signals: [
      {
        kind: "profile_url",
        value: targetUrl,
        normalizedValue: targetUrl,
        strength: "weak",
        assurance: "self_asserted",
        sourceFamily: "portfolio.example",
      },
    ],
  }).candidate;
  assert.equal(
    engine.admitEvidence({
      candidateId: candidate.id,
      claim: "A hardened public fetch bound this exact portfolio URL to the separated candidate branch.",
      sourceUrl: targetUrl,
      sourceType: "other",
      excerpt: "Denise Hilary maintains this public professional portfolio.",
      reliability: 0.55,
      spoofable: true,
    }).admitted,
    true,
  );
  let requests = 0;
  let cdxRequestUrl = null;
  const dependencies = createLiveDependencies(input, {
    apiKey: "test-key",
    model: "test/model",
    resolveHostname: async (hostname) => {
      assert.equal(hostname, "web.archive.org");
      return ["207.241.237.3"];
    },
    fetch: async (request) => {
      requests += 1;
      const url = new URL(String(request));
      assert.equal(url.hostname, "web.archive.org");
      if (url.pathname === "/cdx/search/cdx") {
        cdxRequestUrl = url.href;
        assert.equal(url.searchParams.get("url"), targetUrl);
        assert.equal(url.searchParams.get("matchType"), "exact");
        return jsonResponse([
          ["timestamp", "original", "mimetype", "statuscode", "digest", "length"],
          ["20200101000000", targetUrl, "text/html", "200", "DIGEST-A", "100"],
          ["20240101000000", targetUrl, "text/html", "200", "DIGEST-B", "120"],
        ]);
      }
      if (url.pathname.includes("20200101000000id_")) {
        return new Response(
          '<html lang="en"><title>Denise Hilary — Researcher</title><p>Denise Hilary worked on Project One.</p></html>',
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      if (url.pathname.includes("20240101000000id_")) {
        return new Response(
          '<html lang="en"><title>Denise Hilary — Founder</title><p>Denise Hilary launched Project Two.</p></html>',
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      }
      throw new Error(`Unexpected Wayback request ${url.href}`);
    },
  });
  const result = await dependencies.executeAction(
    {
      schemaVersion: domain.SCHEMA_VERSION,
      id: "action-wayback-diff",
      frontierEntryId: "action-wayback-diff",
      tool: "wayback_profile_history",
      purpose: "Compare exact candidate-linked captures.",
      arguments: { url: targetUrl },
      candidateId: candidate.id,
      budgetClass: "search",
      sourceTier: 5,
      sourceLaneId: "t5.candidate_wayback",
      pathCost: 5,
      mutated: false,
    },
    {
      schemaVersion: domain.SCHEMA_VERSION,
      state: engine.snapshot(),
      modelAccounting: { reserve: () => true, settle: () => {} },
    },
  );

  assert.equal(requests, 3);
  assert.equal(result.meta.requests, 3);
  assert.ok(cdxRequestUrl);
  assert.equal(result.data.cdxRequestUrl, cdxRequestUrl);
  assert.equal(
    result.evidence.every((item) => item.queryUrl === cdxRequestUrl),
    true,
    "orchestrator evidence must retain the adapter's exact dispatched CDX request URL",
  );
  const cdxRequest = new URL(cdxRequestUrl);
  assert.deepEqual(cdxRequest.searchParams.getAll("filter"), [
    "statuscode:200",
    "mimetype:text/html",
    "original:^https://portfolio\\.example/denise$",
  ]);
  assert.equal(cdxRequest.searchParams.get("limit"), "-48");
  const snapshots = result.evidence.filter(
    (item) =>
      item.sourceType === "web_archive" &&
      item.verificationMethod === "archive_snapshot" &&
      item.disposition !== "discovery_only",
  );
  assert.equal(snapshots.length, 2);
  const changed = snapshots.find((item) => item.canonicalSubset?.temporalComparison);
  assert.ok(changed);
  const admittedSnapshot = engine.admitEvidence(changed);
  assert.equal(admittedSnapshot.admitted, true);
  assert.equal(
    admittedSnapshot.evidence.queryUrl,
    cdxRequestUrl,
    "durable evidence must stay byte-bound to the exact dispatched CDX request",
  );
  assert.match(changed.contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(changed.spoofable, true, "archived page content remains page-authored and spoofable");
  assert.match(changed.claim, /bounded raw captures/i);
  assert.equal(changed.canonicalSubset.temporalComparison.observedAfter, "2020-01-01T00:00:00.000Z");
  assert.equal(changed.canonicalSubset.temporalComparison.observedOnOrBefore, "2024-01-01T00:00:00.000Z");
  assert.deepEqual(changed.canonicalSubset.temporalComparison.addedTextFragments, [
    "Denise Hilary launched Project Two.",
  ]);
  assert.deepEqual(changed.canonicalSubset.temporalComparison.removedTextFragments, [
    "Denise Hilary worked on Project One.",
  ]);
});

test("Wayback retains a hash-bound metadata-only temporal observation without inventing an excerpt", async () => {
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: "Denise Hilary",
    requestedDepth: "standard",
  });
  const engine = new agent.InvestigationEngine(input, {
    clock: domain.createSequenceClock("2026-08-20T20:25:00.000Z", 1),
    ids: domain.createDeterministicIdFactory("wayback-metadata-only"),
  });
  const targetUrl = "https://portfolio.example/metadata-only";
  const candidate = engine.addCandidate({ displayName: "Denise Hilary", signals: [] }).candidate;
  assert.equal(
    engine.admitEvidence({
      candidateId: candidate.id,
      claim: "A hardened public fetch bound this exact portfolio URL to the candidate branch.",
      sourceUrl: targetUrl,
      sourceType: "other",
      excerpt: "Denise Hilary maintains this public professional portfolio.",
      reliability: 0.55,
      spoofable: true,
    }).admitted,
    true,
  );
  const dependencies = createLiveDependencies(input, {
    apiKey: "test-key",
    model: "test/model",
    fetch: async (request) => {
      const url = new URL(String(request));
      if (url.pathname === "/cdx/search/cdx")
        return jsonResponse([
          ["timestamp", "original", "mimetype", "statuscode", "digest", "length"],
          ["20200101000000", targetUrl, "text/html", "200", "DIGEST-META-A", "100"],
          ["20240101000000", targetUrl, "text/html", "200", "DIGEST-META-B", "120"],
        ]);
      const description = url.pathname.includes("20200101000000id_") ? "Researcher" : "Founder";
      return new Response(`<html><head><meta name="description" content="${description}"></head><body></body></html>`, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });
  const result = await dependencies.executeAction(
    {
      schemaVersion: domain.SCHEMA_VERSION,
      id: "action-wayback-metadata-only",
      frontierEntryId: "action-wayback-metadata-only",
      tool: "wayback_profile_history",
      purpose: "Compare exact candidate-linked captures.",
      arguments: { url: targetUrl },
      candidateId: candidate.id,
      budgetClass: "search",
      sourceTier: 5,
      sourceLaneId: "t5.candidate_wayback",
      pathCost: 5,
      mutated: false,
    },
    {
      schemaVersion: domain.SCHEMA_VERSION,
      state: engine.snapshot(),
      modelAccounting: { reserve: () => true, settle: () => {} },
    },
  );

  const snapshots = result.evidence.filter(
    (item) => item.verificationMethod === "archive_snapshot" && item.disposition !== "discovery_only",
  );
  assert.equal(snapshots.length, 1, "only the comparison-bearing metadata-only snapshot is retained");
  assert.equal(snapshots[0].excerpt, undefined);
  assert.match(snapshots[0].contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(snapshots[0].canonicalSubset.temporalComparison.metadataChanged, true);
  assert.deepEqual(snapshots[0].canonicalSubset.temporalComparison.changedMetadataFields, ["description"]);
});

test("GitHub codegraph accepts every exact email explicitly present in the request", async () => {
  let observedQuery = null;
  const dependencies = createLiveDependencies(
    {
      schemaVersion: domain.SCHEMA_VERSION,
      query: "first@example.com second@example.com",
      requestedDepth: "quick",
    },
    {
      apiKey: "test-key",
      model: "test/model",
      fetch: async (url) => {
        observedQuery = new URL(String(url)).searchParams.get("q");
        return jsonResponse(
          { total_count: 0, incomplete_results: false, items: [] },
          {
            headers: { "x-ratelimit-remaining": "9" },
          },
        );
      },
    },
  );
  const result = await dependencies.executeAction(
    {
      schemaVersion: domain.SCHEMA_VERSION,
      id: "action-email",
      tool: "github_email_codegraph",
      purpose: "Use the second exact supplied email.",
      arguments: { email: "second@example.com" },
      budgetClass: "search",
    },
    {
      schemaVersion: domain.SCHEMA_VERSION,
      state: {
        target: {
          identifiers: [
            { kind: "email", normalizedValue: "first@example.com", provenance: "user_input" },
            { kind: "email", normalizedValue: "second@example.com", provenance: "user_input" },
          ],
        },
      },
      modelAccounting: {
        reserve: () => false,
        settle: () => assert.fail("GitHub should not use model accounting"),
      },
    },
  );
  assert.equal(result.status, "not_found");
  assert.equal(observedQuery, "author-email:second@example.com is:public");
});

test("provider quota plus no exact GitHub public-user match returns an honest bounded not-found", async () => {
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: "Ganesh Talluri",
    requestedDepth: "quick",
  });
  const engine = new agent.InvestigationEngine(input, {
    clock: domain.createSequenceClock("2026-08-20T18:00:00.000Z", 1),
    ids: domain.createDeterministicIdFactory("github-no-match"),
  });
  let providerSettlements = 0;
  const dependencies = createLiveDependencies(input, {
    apiKey: "test-key",
    model: "test/model",
    resolveHostname: async () => ["140.82.112.5"],
    fetch: async (request) => {
      const url = new URL(String(request));
      if (url.hostname === "openrouter.ai")
        return jsonResponse(
          {
            error: { message: "RESOURCE_EXHAUSTED" },
          },
          { status: 429, headers: { "retry-after": "0" } },
        );
      if (url.hostname === "html.duckduckgo.com") {
        return new Response("<html><body>No safe results observed.</body></html>", {
          headers: { "content-type": "text/html" },
        });
      }
      if (url.pathname === "/search/users")
        return jsonResponse({
          total_count: 1,
          incomplete_results: false,
          items: [
            {
              login: "different-person",
              type: "User",
              url: "https://api.github.com/users/different-person",
            },
          ],
        });
      if (url.pathname === "/users/different-person")
        return jsonResponse({
          login: "different-person",
          name: "Different Person",
          type: "User",
          html_url: "https://github.com/different-person",
        });
      throw new Error(`Unexpected fallback request ${url.href}`);
    },
  });
  const result = await dependencies.executeAction(
    {
      schemaVersion: domain.SCHEMA_VERSION,
      id: "action-search-no-match",
      frontierEntryId: "action-search-no-match",
      tool: "search_web",
      purpose: "Find an exact public professional source.",
      arguments: { query: "Ganesh Talluri public professional profile" },
      budgetClass: "search",
      sourceTier: 1,
      sourceLaneId: "t1.first_party",
      pathCost: 1,
      mutated: false,
    },
    {
      schemaVersion: domain.SCHEMA_VERSION,
      state: engine.snapshot(),
      modelAccounting: {
        reserve: () => true,
        settle: () => {
          providerSettlements += 1;
        },
      },
    },
  );

  assert.equal(result.status, "not_found");
  assert.deepEqual(result.evidence, []);
  assert.equal(
    result.meta.requests,
    4,
    "DuckDuckGo, fail-soft Google, GitHub search, and one bounded detail are request-accounted",
  );
  assert.equal(providerSettlements, 1, "the failed provider attempt is settled separately from fallback requests");
  assert.ok(result.diagnostics.some((item) => item.code === "search_provider_quota_exhausted"));
  assert.ok(result.diagnostics.some((item) => item.code === "duckduckgo_results_not_observed"));
  assert.ok(result.diagnostics.some((item) => item.code === "secondary_public_search_failed_soft"));
  assert.ok(result.diagnostics.some((item) => item.code === "github_exact_name_not_observed"));
});

test("configured-provider citations obey complete positive site scopes without changing unscoped discovery", async () => {
  assert.deepEqual(
    positiveSiteScopesFromCompilerQuery('"Denise Hilary" (site:openalex.org OR site:researchgate.net) -jobs'),
    ["openalex.org", "researchgate.net"],
  );
  assert.deepEqual(
    positiveSiteScopesFromCompilerQuery(
      '"site:quoted.example" -site:negative.example site:path.example/profile website:embedded.example site:.invalid',
    ),
    [],
    "quoted literals, exclusions, paths, embedded tokens, and malformed domains are not positive compiler scopes",
  );

  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: "Denise Hilary",
    requestedDepth: "standard",
  });
  const engine = new agent.InvestigationEngine(input, {
    clock: domain.createSequenceClock("2026-08-20T18:10:00.000Z", 1),
    ids: domain.createDeterministicIdFactory("provider-site-scope-engine"),
  });
  const candidate = engine.addCandidate({ displayName: "Denise Hilary", signals: [] }).candidate;
  const annotationSets = [
    [
      ["https://scholar.google.com/citations?user=denise", "Exact Scholar host"],
      ["https://profiles.scholar.google.com/denise", "Scholar subdomain"],
      ["https://www.berkeley.edu/people/denise", "Off-site university result"],
    ],
    [
      ["https://api.openalex.org/authors/A123", "OpenAlex subdomain"],
      ["https://www.researchgate.net/profile/Denise-Hilary", "ResearchGate profile"],
      ["https://openalex.org.evil.example/denise", "Lookalike academic host"],
    ],
    [
      ["https://www.instagram.com/denise", "Instagram profile"],
      ["https://x.com/denise", "X profile"],
      ["https://m.facebook.com/denise", "Facebook subdomain"],
      ["https://facebook.com.evil.example/denise", "Lookalike social host"],
    ],
    [
      ["https://www.berkeley.edu/people/denise", "University profile"],
      ["https://profiles.example/denise", "Independent profile"],
    ],
  ];
  let providerCall = 0;
  const dependencies = createLiveDependencies(input, {
    apiKey: "test-key",
    model: "test/model",
    ids: domain.createDeterministicIdFactory("provider-site-scope-live"),
    fetch: async (request, init = {}) => {
      const url = new URL(String(request));
      assert.equal(url.hostname, "openrouter.ai");
      const body = JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body));
      const systemPrompt = body.messages.find((message) => message.role === "system")?.content ?? "";
      assert.match(systemPrompt, /Prioritize first-party biographies/);
      assert.match(systemPrompt, /Exclude navigation, search, jobs, topics, tags, quote collections, resume templates/);
      const annotations = annotationSets[providerCall++];
      assert.ok(annotations, "unexpected extra configured-provider search");
      return jsonResponse({
        id: `generation-site-scope-${providerCall}`,
        model: "test/model",
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "Bounded provider results.",
              annotations: annotations.map(([urlValue, title]) => ({
                type: "url_citation",
                url_citation: { url: urlValue, title },
              })),
            },
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      });
    },
  });

  const execute = (id, query) =>
    dependencies.executeAction(
      {
        schemaVersion: domain.SCHEMA_VERSION,
        id,
        tool: "search_web",
        purpose: "Exercise configured-provider site-scope admission.",
        arguments: { query },
        candidateId: candidate.id,
        budgetClass: "search",
      },
      {
        schemaVersion: domain.SCHEMA_VERSION,
        state: engine.snapshot(),
        modelAccounting: { reserve: () => true, settle: () => {} },
      },
    );

  const scholar = await execute("action-provider-scholar-scope", '"Denise Hilary" site:scholar.google.com');
  assert.deepEqual(
    scholar.evidence.map((item) => new URL(item.sourceUrl).hostname),
    ["scholar.google.com", "profiles.scholar.google.com"],
    "the exact Scholar host and its subdomain are admitted while an off-site result is discarded",
  );
  const scholarMismatch = scholar.diagnostics.find((item) => item.code === "search_provider_site_scope_mismatch");
  assert.deepEqual(scholarMismatch?.details, { rejectedCitationCount: 1, positiveSiteScopeCount: 1 });
  assert.equal(JSON.stringify(scholarMismatch).includes("berkeley.edu"), false, "diagnostics must not leak URLs");

  const academic = await execute(
    "action-provider-academic-scopes",
    '"Denise Hilary" (site:openalex.org OR site:researchgate.net)',
  );
  assert.deepEqual(
    academic.evidence.map((item) => new URL(item.sourceUrl).hostname),
    ["api.openalex.org", "www.researchgate.net"],
  );
  assert.deepEqual(academic.diagnostics.find((item) => item.code === "search_provider_site_scope_mismatch")?.details, {
    rejectedCitationCount: 1,
    positiveSiteScopeCount: 2,
  });

  const social = await execute(
    "action-provider-social-scopes",
    '"Denise Hilary" (site:instagram.com OR site:x.com OR site:facebook.com)',
  );
  assert.deepEqual(
    social.evidence.map((item) => new URL(item.sourceUrl).hostname),
    ["www.instagram.com", "x.com", "m.facebook.com"],
  );
  assert.deepEqual(social.diagnostics.find((item) => item.code === "search_provider_site_scope_mismatch")?.details, {
    rejectedCitationCount: 1,
    positiveSiteScopeCount: 3,
  });

  const unscoped = await execute("action-provider-unscoped", '"Denise Hilary" professional');
  assert.deepEqual(
    unscoped.evidence.map((item) => new URL(item.sourceUrl).hostname),
    ["www.berkeley.edu", "profiles.example"],
    "queries without a positive site operator preserve configured-provider citations",
  );
  assert.equal(
    unscoped.diagnostics.some((item) => item.code === "search_provider_site_scope_mismatch"),
    false,
  );
  assert.equal(providerCall, 4);
});

test("compiled Deep social searches reject platform profiles and navigation while admitting exact public content", async () => {
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: "Denise Hilary",
    requestedDepth: "deep",
  });
  const engine = new agent.InvestigationEngine(input, {
    clock: domain.createSequenceClock("2026-08-20T18:20:00.000Z", 1),
    ids: domain.createDeterministicIdFactory("provider-social-result-shapes"),
  });
  const plan = search.compileOsintQueries(engine.snapshot().target);
  assert.equal(plan.status, "compiled");
  const queryByKind = new Map(plan.queries.map((query) => [query.kind, query]));
  const annotationSets = {
    professional_content: [
      [
        "https://www.linkedin.com/posts/denise-hilary_public-research-activity-1234567890123456789-aaaa",
        "Denise Hilary on public research",
      ],
      ["https://www.linkedin.com/in/denise-hilary", "Denise Hilary profile"],
      ["https://www.linkedin.com/jobs/search/?keywords=Denise", "LinkedIn jobs"],
    ],
    public_thread: [
      ["https://x.com/denise/status/1234567890123456789", "Denise Hilary thread"],
      ["https://x.com/denise", "Denise Hilary profile"],
      ["https://twitter.com/explore", "Explore"],
    ],
    public_forum: [
      ["https://www.reddit.com/r/MachineLearning/comments/abc123/denise_hilary_ama/", "Denise Hilary AMA"],
      ["https://www.reddit.com/r/MachineLearning/", "Machine Learning forum"],
      ["https://www.reddit.com/user/denise-hilary/", "Reddit user profile"],
    ],
  };
  let providerCall = 0;
  const dependencies = createLiveDependencies(input, {
    apiKey: "test-key",
    model: "test/model",
    ids: domain.createDeterministicIdFactory("provider-social-result-shapes-live"),
    fetch: async (request, init = {}) => {
      const url = new URL(String(request));
      assert.equal(url.hostname, "openrouter.ai");
      const body = JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body));
      const query = body.tools?.[0]?.web_search?.search_context_size ? null : body.messages.at(-1)?.content;
      const orderedKinds = ["professional_content", "public_thread", "public_forum"];
      const kind = orderedKinds[providerCall++];
      assert.ok(kind, `unexpected provider call for ${query ?? "compiled social query"}`);
      return jsonResponse({
        id: `generation-social-result-shape-${providerCall}`,
        model: "test/model",
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "Bounded public content results.",
              annotations: annotationSets[kind].map(([urlValue, title]) => ({
                type: "url_citation",
                url_citation: { url: urlValue, title },
              })),
            },
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      });
    },
  });

  const expectedUrls = [
    "https://www.linkedin.com/posts/denise-hilary_public-research-activity-1234567890123456789-aaaa",
    "https://x.com/denise/status/1234567890123456789",
    "https://www.reddit.com/r/MachineLearning/comments/abc123/denise_hilary_ama/",
  ];
  for (const [ordinal, kind] of ["professional_content", "public_thread", "public_forum"].entries()) {
    const compiled = queryByKind.get(kind);
    assert.ok(compiled);
    const result = await dependencies.executeAction(
      {
        schemaVersion: domain.SCHEMA_VERSION,
        id: `action-social-result-shape-${ordinal}`,
        frontierEntryId: `action-social-result-shape-${ordinal}`,
        tool: "search_web",
        purpose: "Exercise exact public-content result-shape admission.",
        arguments: { query: compiled.query },
        budgetClass: "search",
        sourceTier: 6,
        sourceLaneId: "t6.general_discovery",
        pathCost: 1,
        mutated: false,
      },
      {
        schemaVersion: domain.SCHEMA_VERSION,
        state: engine.snapshot(),
        modelAccounting: { reserve: () => true, settle: () => {} },
      },
    );
    assert.equal(result.status, "succeeded");
    assert.deepEqual(
      result.evidence.map((evidence) => evidence.sourceUrl),
      [expectedUrls[ordinal]],
    );
    const rejected = result.diagnostics.find(
      (diagnostic) => diagnostic.code === "discovery_leads_rejected_as_non_professional",
    );
    assert.deepEqual(rejected?.details?.reasons, [{ reason: "query_result_shape_mismatch", count: 2 }]);
  }
  assert.equal(providerCall, 3);
});

test("exact T1 baseline persists at most one generic-title exact-subject slug probe", async () => {
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: "Elon Musk",
    requestedDepth: "deep",
  });
  const engine = new agent.InvestigationEngine(input, {
    clock: domain.createSequenceClock("2026-08-21T19:00:00.000Z", 1),
    ids: domain.createDeterministicIdFactory("exact-subject-slug-provider"),
  });
  const urls = [
    "https://www.tesla.com/elon-musk",
    "https://company.example/elon-musk",
    "https://random.example/articles/elon-musk",
  ];
  let providerCalls = 0;
  const dependencies = createLiveDependencies(input, {
    apiKey: "test-key",
    model: "test/model",
    ids: domain.createDeterministicIdFactory("exact-subject-slug-live"),
    fetch: async () => {
      providerCalls += 1;
      return jsonResponse({
        id: `generation-exact-subject-slug-${providerCalls}`,
        model: "test/model",
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "Bounded provider results.",
              annotations: urls.map((url) => ({
                type: "url_citation",
                url_citation: { url, title: `Public source at ${new URL(url).hostname}` },
              })),
            },
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      });
    },
  });
  const execute = (id, query) =>
    dependencies.executeAction(
      {
        schemaVersion: domain.SCHEMA_VERSION,
        id,
        frontierEntryId: id,
        tool: "search_web",
        purpose: "Exercise exact-subject slug scheduling metadata.",
        arguments: { query },
        candidateId: undefined,
        budgetClass: "search",
        sourceTier: 1,
        sourceLaneId: "t1.first_party",
        pathCost: 1,
        mutated: false,
      },
      {
        schemaVersion: domain.SCHEMA_VERSION,
        state: engine.snapshot(),
        modelAccounting: { reserve: () => true, settle: () => {} },
      },
    );

  const baseline = await execute("action-exact-subject-baseline", '"Elon Musk"');
  assert.equal(baseline.status, "succeeded");
  assert.equal(baseline.evidence.length, 3);
  const prioritized = baseline.evidence.filter(
    (evidence) => evidence.attributes.leadSchedulingDisposition === "prioritize",
  );
  assert.equal(prioritized.length, 1, "one exact baseline action may mint only one neutral quality probe");
  assert.equal(prioritized[0].sourceUrl, urls[0]);
  assert.equal(prioritized[0].attributes.leadSchedulingReason, "exact_subject_slug_probe");
  assert.equal(
    baseline.evidence.find((evidence) => evidence.sourceUrl === urls[1]).attributes.leadSchedulingDisposition,
    "neutral",
  );
  assert.equal(
    baseline.evidence.find((evidence) => evidence.sourceUrl === urls[2]).attributes.leadSchedulingDisposition,
    "neutral",
  );

  const refinement = await execute("action-exact-subject-refinement", '"Elon Musk" professional');
  assert.equal(
    refinement.evidence.some((evidence) => evidence.attributes.leadSchedulingReason === "exact_subject_slug_probe"),
    false,
    "a broad/refined query cannot use the exact-baseline exception",
  );
  assert.equal(providerCalls, 2);
});

test("only a prioritized Deep public-source probe receives the bounded two-megabyte response cap", async () => {
  const sourceUrl = "https://profile.example/alex-rivera";
  const largeBody = `<html><head><title>Alex Rivera</title></head><body><p>Alex Rivera</p><!--${"x".repeat(
    800_000,
  )}--></body></html>`;

  const executeCase = async (requestedDepth, query, responseBody = largeBody) => {
    const input = domain.parseInvestigationInput({
      schemaVersion: domain.SCHEMA_VERSION,
      query: "Alex Rivera",
      requestedDepth,
    });
    const engine = new agent.InvestigationEngine(input, {
      clock: domain.createSequenceClock("2026-08-21T20:20:00.000Z", 1),
      ids: domain.createDeterministicIdFactory(`large-priority-probe-${requestedDepth}-${query.length}`),
    });
    const dependencies = createLiveDependencies(input, {
      apiKey: "test-key",
      model: "test/model",
      resolveHostname: async () => ["93.184.216.34"],
      fetch: async (request) => {
        const url = new URL(String(request));
        if (url.hostname === "openrouter.ai") {
          return jsonResponse({
            id: `generation-large-priority-${requestedDepth}`,
            model: "test/model",
            choices: [
              {
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: "One bounded public source was observed.",
                  annotations: [
                    {
                      type: "url_citation",
                      url_citation: { url: sourceUrl, title: "Public source at profile.example" },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 2, completion_tokens: 1 },
          });
        }
        if (url.href === sourceUrl) {
          return new Response(responseBody, {
            headers: {
              "content-type": "text/html",
              "content-length": String(new TextEncoder().encode(responseBody).byteLength),
            },
          });
        }
        throw new Error(`Unexpected large prioritized probe request ${url.href}`);
      },
    });
    const searchResult = await dependencies.executeAction(
      {
        schemaVersion: domain.SCHEMA_VERSION,
        id: `action-large-search-${requestedDepth}-${query.length}`,
        frontierEntryId: `action-large-search-${requestedDepth}-${query.length}`,
        tool: "search_web",
        purpose: "Discover one exact public profile path.",
        arguments: { query },
        budgetClass: "search",
        sourceTier: 1,
        sourceLaneId: "t1.first_party",
        pathCost: 1,
        mutated: false,
      },
      {
        schemaVersion: domain.SCHEMA_VERSION,
        state: engine.snapshot(),
        modelAccounting: { reserve: () => true, settle: () => {} },
      },
    );
    assert.equal(searchResult.status, "succeeded");
    const candidate = engine.addCandidate(searchResult.candidates[0]).candidate;
    for (const evidence of searchResult.evidence) {
      const bound = { ...evidence, candidateId: candidate.id };
      delete bound.candidateRef;
      assert.equal(engine.admitEvidence(bound).admitted, true);
    }
    const lead = engine.snapshot().evidence.find((evidence) => evidence.sourceUrl === sourceUrl);
    assert.ok(lead);
    const result = await dependencies.executeAction(
      {
        schemaVersion: domain.SCHEMA_VERSION,
        id: `action-large-fetch-${requestedDepth}-${query.length}`,
        frontierEntryId: `action-large-fetch-${requestedDepth}-${query.length}`,
        tool: "fetch_public_source",
        purpose: "Fetch the exact bounded public profile path.",
        arguments: { leadId: lead.attributes.leadId, claimFocus: "Public professional identity" },
        candidateId: candidate.id,
        budgetClass: "fetch",
        sourceTier: lead.attributes.classifiedSourceTier,
        sourceLaneId: lead.attributes.classifiedSourceLaneId,
        pathCost: 1.4,
        mutated: false,
        executionRole: "quality_probe",
      },
      {
        schemaVersion: domain.SCHEMA_VERSION,
        state: engine.snapshot(),
        modelAccounting: { reserve: () => true, settle: () => {} },
      },
    );
    return { lead, result };
  };

  const deepPriority = await executeCase("deep", '"Alex Rivera"');
  assert.equal(deepPriority.lead.attributes.leadSchedulingDisposition, "prioritize");
  assert.ok(["succeeded", "partial"].includes(deepPriority.result.status));
  assert.ok(deepPriority.result.meta.bytesRead > 750_000);
  assert.equal(
    deepPriority.result.diagnostics.some((item) => item.code === "response_too_large"),
    false,
  );

  const deepNeutral = await executeCase("deep", '"Alex Rivera" professional');
  assert.equal(deepNeutral.lead.attributes.leadSchedulingDisposition, "neutral");
  assert.equal(deepNeutral.result.status, "failed");
  assert.ok(deepNeutral.result.diagnostics.some((item) => item.code === "response_too_large"));

  const standardPriority = await executeCase("standard", '"Alex Rivera"');
  assert.equal(standardPriority.lead.attributes.leadSchedulingDisposition, "prioritize");
  assert.equal(standardPriority.result.status, "failed");
  assert.ok(standardPriority.result.diagnostics.some((item) => item.code === "response_too_large"));

  const overAdapterCap = await executeCase(
    "deep",
    '"Alex Rivera"',
    `<html><title>Alex Rivera</title><body>${"x".repeat(2_000_001)}</body></html>`,
  );
  assert.equal(overAdapterCap.lead.attributes.leadSchedulingDisposition, "prioritize");
  assert.equal(overAdapterCap.result.status, "failed");
  assert.ok(overAdapterCap.result.diagnostics.some((item) => item.code === "response_too_large"));
  assert.equal(
    overAdapterCap.result.meta.bytesRead,
    0,
    "an advertised body over the hard cap must fail before reading",
  );
});

test("provider-only navigation noise triggers the bounded public fallback before fetch authorization", async () => {
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: "Alex Rivera",
    requestedDepth: "deep",
  });
  const engine = new agent.InvestigationEngine(input, {
    clock: domain.createSequenceClock("2026-08-21T19:05:00.000Z", 1),
    ids: domain.createDeterministicIdFactory("provider-unqualified-fallback"),
  });
  const officialUrl = "https://robotics.example/alex-rivera";
  let providerCalls = 0;
  let duckDuckGoCalls = 0;
  let githubCalls = 0;
  const dependencies = createLiveDependencies(input, {
    apiKey: "test-key",
    model: "test/model",
    resolveHostname: async () => ["93.184.216.34"],
    fetch: async (request) => {
      const url = new URL(String(request));
      if (url.hostname === "openrouter.ai") {
        providerCalls += 1;
        return jsonResponse({
          id: "generation-unqualified-provider",
          model: "test/model",
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "Search results.",
                annotations: [
                  ["https://github.com/topics/alex-rivera", "Alex Rivera · GitHub Topics"],
                  ["https://linkedin.com/jobs/search/?keywords=Alex%20Rivera", "Alex Rivera jobs"],
                  ["https://brainyquote.com/authors/alex-rivera-quotes", "Alex Rivera quotes"],
                ].map(([value, title]) => ({
                  type: "url_citation",
                  url_citation: { url: value, title },
                })),
              },
            },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        });
      }
      if (url.hostname === "html.duckduckgo.com") {
        duckDuckGoCalls += 1;
        const wrapped = `//duckduckgo.com/l/?uddg=${encodeURIComponent(officialUrl)}&amp;rut=official`;
        return new Response(`<a class="result__a" href="${wrapped}">Alex Rivera | Robotics</a>`, {
          headers: { "content-type": "text/html" },
        });
      }
      if (url.hostname === "api.github.com") {
        githubCalls += 1;
        return jsonResponse({ total_count: 0, incomplete_results: false, items: [] });
      }
      throw new Error(`Unexpected provider-noise request ${url.href}`);
    },
  });

  const result = await dependencies.executeAction(
    {
      schemaVersion: domain.SCHEMA_VERSION,
      id: "action-provider-unqualified-fallback",
      frontierEntryId: "action-provider-unqualified-fallback",
      tool: "search_web",
      purpose: "Find one bounded official public source.",
      arguments: { query: '"Alex Rivera"' },
      candidateId: undefined,
      budgetClass: "search",
      sourceTier: 1,
      sourceLaneId: "t1.first_party",
      pathCost: 1,
      mutated: false,
    },
    {
      schemaVersion: domain.SCHEMA_VERSION,
      state: engine.snapshot(),
      modelAccounting: { reserve: () => true, settle: () => {} },
    },
  );

  assert.equal(result.status, "succeeded");
  assert.equal(providerCalls, 1);
  assert.equal(duckDuckGoCalls, 1);
  assert.ok(githubCalls <= 1);
  assert.deepEqual(
    result.evidence.map((evidence) => evidence.sourceUrl),
    [officialUrl],
  );
  assert.equal(result.evidence[0].attributes.provider, "duckduckgo:html_search");
  assert.equal(result.evidence[0].attributes.leadSchedulingDisposition, "prioritize");
  assert.equal(result.evidence[0].attributes.leadSchedulingReason, "candidate_bio_path");
  assert.ok(result.diagnostics.some((item) => item.code === "search_provider_sources_unqualified"));
  assert.ok(result.diagnostics.some((item) => item.code === "duckduckgo_html_fallback_used"));
  const rejected = result.diagnostics.find((item) => item.code === "discovery_leads_rejected_as_non_professional");
  assert.equal(rejected?.details?.rejectedLeadCount, 3);
  assert.equal(
    JSON.stringify(rejected).includes("github.com"),
    false,
    "count-only rejection details must not leak URLs",
  );
});

test("concurrent canonical searches and a later site query share one explicit run query anchor", async () => {
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: "Avery Stone, Example University",
    requestedDepth: "deep",
  });
  const sourceByQuery = (query) => {
    if (query.includes("site:github.com")) return "https://github.com/avery-stone-professional";
    if (query.includes("site:linkedin.com")) return "https://www.linkedin.com/in/avery-stone-professional";
    if (query.includes('"Example University"')) return "https://context.example/people/avery-stone";
    return "https://official.example/people/avery-stone";
  };
  const providerQueries = [];
  const executedActions = [];
  const live = createLiveDependencies(input, {
    apiKey: "test-key",
    model: "test/model",
    clock: domain.createSequenceClock("2026-08-20T18:12:00.000Z", 1),
    ids: domain.createDeterministicIdFactory("concurrent-query-subject-anchor"),
    fetch: async (_request, init = {}) => {
      const body = JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body));
      const query = body.messages.at(-1)?.content;
      assert.equal(typeof query, "string");
      providerQueries.push(query);
      const sourceUrl = sourceByQuery(query);
      return jsonResponse({
        id: `query-anchor-provider-${providerQueries.length}`,
        model: "test/model",
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "Bounded public-professional source.",
              annotations: [
                {
                  type: "url_citation",
                  url_citation: { url: sourceUrl, title: `Avery Stone at ${new URL(sourceUrl).hostname}` },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      });
    },
  });
  const plannerBatches = [];
  const updates = [];
  for await (const update of agent.runResearch(
    input,
    {
      clock: live.clock,
      ids: live.ids,
      planner: async ({ state, selectedFrontierEntries }) => {
        if (
          state.evidence.some(
            (evidence) => evidence.canonicalUrl === "https://www.linkedin.com/in/avery-stone-professional",
          )
        ) {
          return { kind: "stop", decisionSummary: "The bounded anchor regression is complete." };
        }
        plannerBatches.push(
          selectedFrontierEntries.map((entry) => ({
            queryHint: entry.queryHint,
            canonical: search.isCanonicalCompilerSearchEntry(entry),
          })),
        );
        return {
          kind: "actions",
          decisionSummary: "Execute the selected focused public-source capability.",
          actions: selectedFrontierEntries.map((entry) => ({
            frontierEntryId: entry.id,
            tool: entry.allowedTools[0],
            purpose: "Exercise run-local query-subject admission.",
            arguments:
              entry.allowedTools[0] === "search_web" ? { query: entry.queryHint } : { leadId: entry.queryHint },
            ...(entry.candidateId ? { candidateId: entry.candidateId } : {}),
          })),
        };
      },
      executeAction: async (action, context) => {
        executedActions.push({ tool: action.tool, query: String(action.arguments.query ?? "") });
        return live.executeAction(action, context);
      },
      synthesize: async () => ({
        decisionSummary: "Discovery leads remain non-factual until hardened fetches bind them.",
        findings: [],
        openQuestions: [],
      }),
    },
    {
      availableTools: ["search_web", "fetch_public_source"],
      budget: {
        maxTurns: 12,
        maxLlmCalls: 20,
        maxToolCalls: 24,
        maxSearchCalls: 20,
        maxEvidenceAttempts: 32,
        maxConsecutiveNoProgress: 8,
        maxActionsPerTurn: 2,
        phaseCaps: { plan: 2, discover: 8, separate_candidates: 4, corroborate: 6, calibrate: 4, report: 1 },
      },
    },
  ))
    updates.push(update);

  const completed = updates.at(-1);
  assert.equal(completed.type, "completed");
  assert.ok(plannerBatches.length > 0, "candidate-bound or mixed batches still cross the planner boundary");
  assert.equal(
    plannerBatches.some((batch) => batch.every((entry) => entry.canonical)),
    false,
    "canonical-only Deep batches bypass the model planner",
  );
  const deterministicRoutes = completed.trace.events.filter(
    (event) => event.name === "scheduler.canonical_batch_routed",
  );
  assert.ok(deterministicRoutes.length >= 1);
  const executedSearchActions = executedActions.filter((action) => action.tool === "search_web");
  const executedFetchActions = executedActions.filter((action) => action.tool === "fetch_public_source");
  assert.ok(
    deterministicRoutes.reduce((sum, event) => sum + event.payload.entryCount, 0) <= executedSearchActions.length,
    "mechanically routed canonical-only work is a subset of all executed focused searches",
  );
  assert.ok(executedActions.some((action) => action.query === '"Avery Stone"'));
  assert.ok(executedActions.some((action) => action.query.includes('"Example University"')));
  assert.ok(
    executedActions.some((action) => action.query.includes("site:github.com")),
    JSON.stringify({ executedActions, stop: completed.report.stop, plannerBatches }),
  );
  assert.ok(executedActions.some((action) => action.query.includes("site:linkedin.com")));
  assert.ok(executedFetchActions.length >= 1, "focused opaque leads may be fetched while exact queries continue");
  const interleavedProbe = completed.trace.events.find(
    (event) =>
      event.name === "frontier.quality_probe_selected" && event.payload.interleavedBeforeCanonicalBreadth === true,
  );
  assert.ok(interleavedProbe);
  const executedQueries = executedSearchActions.map((action) => action.query);
  assert.deepEqual(
    providerQueries,
    executedQueries.slice(0, providerQueries.length),
    "each available provider call must preserve the exact mechanically routed adapter query and order",
  );
  assert.ok(providerQueries.length <= executedQueries.length);

  const queryCandidates = completed.report.candidates.filter((candidate) => candidate.normalizedName === "avery stone");
  assert.equal(queryCandidates.length, 1, "the concurrent action-local refs must resolve to one run anchor");
  const queryCandidate = queryCandidates[0];
  const discovery = completed.report.evidence.filter(
    (evidence) => evidence.sourceType === "search_result" && evidence.attributes.querySubjectAnchor === true,
  );
  assert.equal(discovery.length, 4);
  assert.ok(discovery.every((evidence) => evidence.candidateId === queryCandidate.id));
  assert.ok(discovery.every((evidence) => evidence.attributes.querySubjectName === "Avery Stone"));
  assert.deepEqual(
    new Set(discovery.map((evidence) => evidence.canonicalUrl)),
    new Set([
      "https://official.example/people/avery-stone",
      "https://context.example/people/avery-stone",
      "https://github.com/avery-stone-professional",
      "https://www.linkedin.com/in/avery-stone-professional",
    ]),
  );
  const ownersByCanonicalUrl = new Map();
  for (const evidence of completed.report.evidence) {
    const owners = ownersByCanonicalUrl.get(evidence.canonicalUrl) ?? new Set();
    owners.add(evidence.candidateId);
    ownersByCanonicalUrl.set(evidence.canonicalUrl, owners);
  }
  assert.ok(
    [...ownersByCanonicalUrl.values()].every((owners) => owners.size === 1),
    "no canonical source may be attached to two candidates through query-anchor reuse",
  );
  const queryAnchorReuse = completed.trace.events.filter(
    (event) => event.name === "candidate.reused" && event.payload.reason === "same_run_query_subject_anchor",
  );
  assert.equal(queryAnchorReuse.length, 1);
  assert.equal(queryAnchorReuse[0].payload.candidateId, queryCandidate.id);
  assert.equal(
    completed.trace.events.filter(
      (event) => event.name === "candidate.created" && event.payload.displayName === "Avery Stone",
    ).length,
    1,
  );
  assert.equal(
    completed.report.searchGraph.nodes.filter(
      (node) => node.kind === "candidate" && node.candidateId === queryCandidate.id,
    ).length,
    1,
  );
  const queryCandidateNode = completed.report.searchGraph.nodes.find(
    (node) => node.kind === "candidate" && node.candidateId === queryCandidate.id,
  );
  const discoveryEvidenceNodeIds = new Set(
    completed.report.searchGraph.nodes
      .filter((node) => node.kind === "evidence" && discovery.some((evidence) => evidence.id === node.evidenceId))
      .map((node) => node.id),
  );
  assert.equal(
    completed.report.searchGraph.edges.filter(
      (edge) =>
        edge.kind === "supports" &&
        edge.status === "exhausted" &&
        discoveryEvidenceNodeIds.has(edge.fromNodeId) &&
        edge.toNodeId === queryCandidateNode.id,
    ).length,
    discovery.length,
    "every discovery node must remain exhausted and bind to the single explicit query anchor",
  );
  assert.deepEqual(search.validateSearchGraph(completed.report.searchGraph), []);
  assert.deepEqual(domain.validateReferentialIntegrity(completed.state), []);
  assert.doesNotThrow(() => domain.parseInvestigationState(completed.state));
  assert.doesNotThrow(() => domain.parseInvestigationReport(completed.report));

  const duplicateAnchorEvidence = {
    ...discovery[0],
    id: "evidence_duplicate_query_anchor",
    candidateId: "candidate_duplicate_query_anchor",
  };
  const duplicateAnchorCandidate = {
    ...queryCandidate,
    id: duplicateAnchorEvidence.candidateId,
    evidenceIds: [duplicateAnchorEvidence.id],
  };
  assert.equal(
    domain.resolveQuerySubjectAnchor(
      {
        candidates: [queryCandidate, duplicateAnchorCandidate],
        evidence: [...discovery, duplicateAnchorEvidence],
      },
      completed.state.target,
    ).kind,
    "ambiguous",
    "two independently marked anchors must fail closed instead of falling back to same-name ordering",
  );
  const quarantinedMarker = {
    ...discovery[0],
    id: "evidence_quarantined_query_subject",
    attributes: { ...discovery[0].attributes, quarantinedFromCandidateId: "candidate_parent" },
  };
  assert.equal(
    domain.resolveQuerySubjectAnchor(
      {
        candidates: [{ ...queryCandidate, evidenceIds: [...queryCandidate.evidenceIds, quarantinedMarker.id] }],
        evidence: [...discovery, quarantinedMarker],
      },
      completed.state.target,
    ).kind,
    "none",
    "a fetched-subject quarantine marker must make a candidate ineligible as the neutral query anchor",
  );
});

test("provider and public-HTML outages still admit exact Semantic Scholar API discovery", async () => {
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: "Denise Hilary",
    requestedDepth: "standard",
  });
  const engine = new agent.InvestigationEngine(input, {
    clock: domain.createSequenceClock("2026-08-20T18:15:00.000Z", 1),
    ids: domain.createDeterministicIdFactory("semantic-scholar-provider-independent"),
  });
  let providerRequests = 0;
  const dependencies = createLiveDependencies(input, {
    apiKey: "test-key",
    model: "test/model",
    resolveHostname: async () => ["93.184.216.34"],
    fetch: async (request) => {
      const url = new URL(String(request));
      if (url.hostname === "openrouter.ai") {
        providerRequests += 1;
        return jsonResponse(
          { error: { message: "provider quota exhausted" } },
          { status: 429, headers: { "retry-after": "0" } },
        );
      }
      if (url.hostname === "api.semanticscholar.org") {
        return jsonResponse({ total: 1, data: [{ authorId: "123456", name: "Denise Hilary" }] });
      }
      if (url.hostname === "html.duckduckgo.com") {
        return new Response("<html><body>No safe results observed.</body></html>", {
          headers: { "content-type": "text/html" },
        });
      }
      if (url.hostname === "www.google.com") {
        return new Response('<html><form action="/sorry/"><p>Unusual traffic</p></form></html>', {
          headers: { "content-type": "text/html" },
        });
      }
      throw new Error(`Unexpected structured fallback request ${url.href}`);
    },
  });

  const result = await dependencies.executeAction(
    {
      schemaVersion: domain.SCHEMA_VERSION,
      id: "action-semantic-scholar-fallback",
      frontierEntryId: "action-semantic-scholar-fallback",
      tool: "search_web",
      purpose: "Search the canonical scholarly-author lane.",
      arguments: { query: '"Denise Hilary" site:semanticscholar.org' },
      budgetClass: "search",
      sourceTier: 2,
      sourceLaneId: "t2.structured_professional",
      pathCost: 1,
      mutated: false,
    },
    {
      schemaVersion: domain.SCHEMA_VERSION,
      state: engine.snapshot(),
      modelAccounting: { reserve: () => true, settle: () => {} },
    },
  );

  assert.equal(result.status, "succeeded");
  assert.ok(providerRequests > 0);
  assert.equal(result.meta.requests, 3, "Semantic Scholar, DuckDuckGo, and Google are each request-accounted");
  assert.equal(result.meta.incomplete, true, "the optional Google challenge remains visible as incomplete");
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].sourceUrl, "https://www.semanticscholar.org/author/123456");
  assert.equal(result.evidence[0].attributes.provider, "semanticscholar:academic_graph_api");
  assert.equal(result.evidence[0].attributes.attestedSubjectName, "Denise Hilary");
  assert.equal(result.evidence[0].attributes.classifiedSourceType, "professional_profile");
  assert.equal(result.evidence[0].attributes.classifiedSourceLaneId, "t2.structured_professional");
  assert.equal(result.evidence[0].canonicalSubset.officialApiObservedUrl, true);
  assert.ok(result.diagnostics.some((item) => item.code === "semantic_scholar_author_api_used"));
  assert.ok(result.diagnostics.some((item) => item.code === "google_html_challenge_observed"));
  assert.ok(result.diagnostics.some((item) => item.code === "secondary_public_search_failed_soft"));
});

test("Crossref exact-author metadata is independently accounted and rejects off-scope provider discovery", async () => {
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: "Denise Hilary",
    requestedDepth: "standard",
  });
  const engine = new agent.InvestigationEngine(input, {
    clock: domain.createSequenceClock("2026-08-20T18:17:00.000Z", 1),
    ids: domain.createDeterministicIdFactory("crossref-provider-independent"),
  });
  let providerSettlements = 0;
  const crossrefUrl = "https://api.crossref.org/works/10.5555%2Fatlas.2026.2";
  const providerUrl = "https://profiles.example/denise-hilary";
  const dependencies = createLiveDependencies(input, {
    apiKey: "test-key",
    model: "test/model",
    resolveHostname: async () => ["93.184.216.34"],
    fetch: async (request) => {
      const url = new URL(String(request));
      if (url.hostname === "openrouter.ai") {
        return jsonResponse({
          id: "generation-crossref-provider",
          model: "test/model",
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "One provider result.",
                annotations: [
                  {
                    type: "url_citation",
                    url_citation: { url: crossrefUrl, title: "Provider-observed duplicate Crossref record" },
                  },
                  {
                    type: "url_citation",
                    url_citation: { url: providerUrl, title: "Denise Hilary — Public profile" },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        });
      }
      if (url.hostname === "api.crossref.org") {
        return jsonResponse({
          message: {
            "total-results": 1,
            items: [
              {
                DOI: "10.5555/atlas.2026.2",
                title: ["Provider-Independent Public Metadata"],
                author: [{ given: "Denise", family: "Hilary" }],
              },
            ],
          },
        });
      }
      throw new Error(`Unexpected Crossref integration request ${url.href}`);
    },
  });

  const result = await dependencies.executeAction(
    {
      schemaVersion: domain.SCHEMA_VERSION,
      id: "action-crossref-fallback",
      frontierEntryId: "action-crossref-fallback",
      tool: "search_web",
      purpose: "Search the canonical Crossref lane.",
      arguments: { query: '"Denise Hilary" site:crossref.org' },
      budgetClass: "search",
      sourceTier: 2,
      sourceLaneId: "t2.structured_professional",
      pathCost: 1,
      mutated: false,
    },
    {
      schemaVersion: domain.SCHEMA_VERSION,
      state: engine.snapshot(),
      modelAccounting: {
        reserve: () => true,
        settle: () => {
          providerSettlements += 1;
        },
      },
    },
  );

  assert.equal(result.status, "succeeded");
  assert.equal(providerSettlements, 1, "the configured-provider completion is accounted separately");
  assert.equal(result.meta.requests, 1, "the Crossref request is charged to the tool transport budget");
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].attributes.provider, "crossref:rest_api");
  assert.equal(result.evidence[0].sourceUrl, crossrefUrl);
  assert.equal(result.evidence[0].canonicalSubset.officialApiObservedUrl, true);
  assert.equal(
    result.evidence.some((evidence) => evidence.sourceUrl === providerUrl),
    false,
    "a provider citation outside the explicit Crossref site scope is not admitted",
  );
  assert.deepEqual(result.diagnostics.find((item) => item.code === "search_provider_site_scope_mismatch")?.details, {
    rejectedCitationCount: 1,
    positiveSiteScopeCount: 1,
  });
  assert.ok(result.diagnostics.some((item) => item.code === "crossref_author_works_api_used"));
});

test("one search action caps citations deterministically with exact official structured matches first", async () => {
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: "Denise Hilary",
    requestedDepth: "standard",
  });
  const engine = new agent.InvestigationEngine(input, {
    clock: domain.createSequenceClock("2026-08-20T18:20:00.000Z", 1),
    ids: domain.createDeterministicIdFactory("citation-cap-order"),
  });
  const providerUrls = Array.from(
    { length: 8 },
    (_, index) => `https://provider-${index + 1}.semanticscholar.org/person`,
  );
  const dependencies = createLiveDependencies(input, {
    apiKey: "test-key",
    model: "test/model",
    resolveHostname: async () => ["93.184.216.34"],
    fetch: async (request) => {
      const url = new URL(String(request));
      if (url.hostname === "openrouter.ai") {
        return jsonResponse({
          id: "generation-citation-cap",
          model: "test/model",
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "Bounded provider results.",
                annotations: providerUrls.map((providerUrl, index) => ({
                  type: "url_citation",
                  url_citation: { url: providerUrl, title: `Provider result ${index + 1}` },
                })),
              },
            },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        });
      }
      if (url.hostname === "api.semanticscholar.org") {
        return jsonResponse({
          total: 3,
          data: [
            { authorId: "101", name: "Denise Hilary" },
            { authorId: "102", name: "Denise Hilary" },
            { authorId: "103", name: "Denise Hilary" },
          ],
        });
      }
      throw new Error(`Unexpected citation-cap request ${url.href}`);
    },
  });

  const result = await dependencies.executeAction(
    {
      schemaVersion: domain.SCHEMA_VERSION,
      id: "action-citation-cap",
      frontierEntryId: "action-citation-cap",
      tool: "search_web",
      purpose: "Search the canonical scholarly-author lane.",
      arguments: { query: '"Denise Hilary" site:semanticscholar.org' },
      budgetClass: "search",
      sourceTier: 2,
      sourceLaneId: "t2.structured_professional",
      pathCost: 1,
      mutated: false,
    },
    {
      schemaVersion: domain.SCHEMA_VERSION,
      state: engine.snapshot(),
      modelAccounting: { reserve: () => true, settle: () => {} },
    },
  );

  assert.equal(result.status, "succeeded");
  assert.equal(result.data.citationCount, 10);
  assert.equal(result.data.observedCitationCount, 11);
  assert.deepEqual(
    result.evidence.slice(0, 3).map((evidence) => evidence.attributes.provider),
    ["semanticscholar:academic_graph_api", "semanticscholar:academic_graph_api", "semanticscholar:academic_graph_api"],
  );
  assert.deepEqual(
    result.evidence.slice(3).map((evidence) => evidence.sourceUrl),
    providerUrls.slice(0, 7),
  );
  assert.equal(
    result.evidence.some((evidence) => evidence.sourceUrl === providerUrls[7]),
    false,
  );
  const cap = result.diagnostics.find((item) => item.code === "discovery_citation_limit_applied");
  assert.deepEqual(cap?.details, { maximumCitations: 10, omittedCitations: 1 });
});

test("provider 429 falls back to DuckDuckGo and keeps a non-profile name mention discovery-only", async () => {
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: "Ganesh Talluri",
    requestedDepth: "quick",
  });
  const engine = new agent.InvestigationEngine(input, {
    clock: domain.createSequenceClock("2026-08-20T18:30:00.000Z", 1),
    ids: domain.createDeterministicIdFactory("duckduckgo-fallback"),
  });
  const candidate = engine.addCandidate({
    displayName: "Ganesh Talluri",
    signals: [
      {
        kind: "name",
        value: "Ganesh Talluri",
        normalizedValue: "ganesh talluri",
        strength: "weak",
        assurance: "self_asserted",
      },
    ],
  }).candidate;
  let duckDuckGoCalls = 0;
  let pageFetchCalls = 0;
  let extractionReservations = 0;
  const sourceUrl = "https://portfolio.example/ganesh";
  const dependencies = createLiveDependencies(input, {
    apiKey: "test-key",
    model: "test/model",
    resolveHostname: async (hostname) => {
      if (hostname === "html.duckduckgo.com") return ["52.149.246.39"];
      if (hostname === "portfolio.example") return ["93.184.216.34"];
      throw new Error(`Unexpected DNS request ${hostname}`);
    },
    fetch: async (request) => {
      const url = new URL(String(request));
      if (url.hostname === "openrouter.ai") {
        return jsonResponse(
          { error: { message: "provider quota exhausted" } },
          {
            status: 429,
            headers: { "retry-after": "0" },
          },
        );
      }
      if (url.hostname === "html.duckduckgo.com") {
        duckDuckGoCalls += 1;
        const wrapped = `//duckduckgo.com/l/?uddg=${encodeURIComponent(sourceUrl)}&amp;rut=opaque`;
        return new Response(
          `<html><body><a class="result__a" href="${wrapped}">Ganesh Talluri — Portfolio</a><div class="result__snippet">Snippet must not be evidence.</div></body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      }
      if (url.href === sourceUrl) {
        pageFetchCalls += 1;
        return new Response("<html><title>Ganesh Talluri — Portfolio</title><p>Ganesh Talluri</p></html>", {
          headers: { "content-type": "text/html" },
        });
      }
      throw new Error(`Unexpected outbound request ${url.href}`);
    },
  });
  const searchAccounting = {
    reserve: () => true,
    settle: () => {},
  };
  const search = await dependencies.executeAction(
    {
      schemaVersion: domain.SCHEMA_VERSION,
      id: "action-ddg-search",
      frontierEntryId: "action-ddg-search",
      tool: "search_web",
      purpose: "Find a direct public professional source.",
      arguments: { query: "Ganesh Talluri public professional profile" },
      candidateId: candidate.id,
      budgetClass: "search",
      sourceTier: 6,
      sourceLaneId: "t6.general_discovery",
      pathCost: 1,
      mutated: false,
    },
    {
      schemaVersion: domain.SCHEMA_VERSION,
      state: engine.snapshot(),
      modelAccounting: searchAccounting,
    },
  );

  assert.equal(search.status, "succeeded");
  assert.equal(search.meta.requests, 1, "only the keyless fallback request is tool-accounted");
  assert.equal(duckDuckGoCalls, 1);
  assert.equal(search.evidence.length, 1);
  assert.equal(search.evidence[0].attributes.provider, "duckduckgo:html_search");
  assert.equal(search.evidence[0].attributes.upstreamProvider, null);
  assert.equal(search.evidence[0].attributes.classifiedSourceType, "other");
  assert.equal(search.evidence[0].attributes.classifiedSourceTier, 6);
  assert.equal(search.evidence[0].attributes.classifiedSourceLaneId, "t6.candidate_public_source");
  assert.equal(search.evidence[0].canonicalSubset.publicHtmlSearchObservedUrl, true);
  assert.match(search.evidence[0].claim, /DuckDuckGo's public HTML search/);
  assert.equal(JSON.stringify(search).includes("Snippet must not be evidence"), false);
  assert.ok(search.diagnostics.some((item) => item.code === "search_provider_quota_exhausted"));
  assert.ok(search.diagnostics.some((item) => item.code === "duckduckgo_html_fallback_used"));
  assert.ok(search.diagnostics.some((item) => item.code === "public_web_fallback_used"));
  assert.equal(engine.admitEvidence(search.evidence[0]).admitted, true);

  const direct = await dependencies.executeAction(
    {
      schemaVersion: domain.SCHEMA_VERSION,
      id: "action-ddg-fetch",
      frontierEntryId: "action-ddg-fetch",
      tool: "fetch_public_source",
      purpose: "Fetch the exact keyless-search lead.",
      arguments: {
        leadId: search.evidence[0].attributes.leadId,
        claimFocus: "Public professional identity",
      },
      candidateId: candidate.id,
      budgetClass: "fetch",
      sourceTier: 6,
      sourceLaneId: "t6.candidate_public_source",
      pathCost: 1.4,
      mutated: false,
    },
    {
      schemaVersion: domain.SCHEMA_VERSION,
      state: engine.snapshot(),
      modelAccounting: {
        reserve: () => {
          extractionReservations += 1;
          return true;
        },
        settle: () => {},
      },
    },
  );

  assert.equal(direct.status, "partial", "a non-profile name mention cannot become an identity branch");
  assert.equal(pageFetchCalls, 1);
  assert.equal(extractionReservations, 0, "exact fetched-title extraction does not invoke the model");
  const directQuote = direct.evidence.find((item) => item.verificationMethod === "direct_fetch");
  assert.ok(directQuote);
  assert.equal(directQuote.sourceUrl, sourceUrl);
  assert.equal(directQuote.claim, "Ganesh Talluri — Portfolio");
  assert.equal(directQuote.excerpt, directQuote.claim);
  assert.equal(directQuote.attributes.extractionMethod, "deterministic_public_html_named_person_quote");
  assert.equal(directQuote.attributes.extractedOrganization, null);
  assert.equal(directQuote.candidateId, candidate.id);
  assert.equal(directQuote.candidateRef, undefined);
  assert.equal(directQuote.disposition, "discovery_only");
  assert.equal(directQuote.attributes.identityBinding, false);
  assert.equal(directQuote.attributes.findingAuthority, false);
  assert.equal(direct.candidateBranches, undefined);
  assert.deepEqual(direct.candidateSignals, []);
  assert.ok(direct.diagnostics.some((item) => item.code === "deterministic_public_html_extraction"));
  assert.ok(direct.diagnostics.some((item) => item.code === "non_profile_subject_mention_discovery_only"));
});

test("configured-provider person leads use exact fetched quotes and quarantine a wrong-school namesake", async () => {
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: "Michael Jordan, professor at UC Berkeley",
    requestedDepth: "deep",
  });
  const engine = new agent.InvestigationEngine(input, {
    clock: domain.createSequenceClock("2026-08-20T18:31:00.000Z", 1),
    ids: domain.createDeterministicIdFactory("provider-query-bound-school-context"),
  });
  const candidate = engine.addCandidate({
    displayName: "Michael Jordan",
    signals: [
      {
        kind: "name",
        value: "Michael Jordan",
        normalizedValue: "michael jordan",
        strength: "weak",
        assurance: "self_asserted",
      },
    ],
  }).candidate;
  assert.equal(
    engine.admitEvidence({
      candidateId: candidate.id,
      claim: "An earlier bounded search established this run's neutral query subject.",
      disposition: "discovery_only",
      sourceUrl: "https://search-anchor.example/michael-jordan",
      sourceType: "search_result",
      canonicalSubset: { providerAttestedUrl: true },
      verificationMethod: "search_discovery",
      temporalStatus: "unknown",
      reliability: 0,
      spoofable: true,
      attributes: { querySubjectAnchor: true, querySubjectName: "Michael Jordan" },
    }).admitted,
    true,
  );
  const matchingUrl = "https://profiles.berkeley.edu/michael-jordan";
  const conflictingUrl = "https://orcid.org/0000-0002-1825-0097";
  let providerRequests = 0;
  let extractionReservations = 0;
  const dependencies = createLiveDependencies(input, {
    apiKey: "test-key",
    model: "test/model",
    resolveHostname: async () => ["93.184.216.34"],
    fetch: async (request) => {
      const url = new URL(String(request));
      if (url.hostname === "openrouter.ai") {
        providerRequests += 1;
        assert.ok(providerRequests <= 2, "a page fetch must not fall through to model extraction");
        return jsonResponse({
          id: "generation-provider-school-context",
          model: "test/model",
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "Two public pages were observed.",
                annotations: [
                  {
                    type: "url_citation",
                    url_citation: { url: matchingUrl, title: "Michael Jordan — UC Berkeley" },
                  },
                  {
                    type: "url_citation",
                    url_citation: { url: conflictingUrl, title: "Michael Jordan — Example University" },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        });
      }
      if (url.href === matchingUrl) {
        return new Response(
          "<html><title>Michael Jordan — Professor at UC Berkeley</title><main><p>Michael Jordan is a Professor at UC Berkeley.</p></main></html>",
          { headers: { "content-type": "text/html" } },
        );
      }
      if (url.href === conflictingUrl) {
        return new Response(
          "<html><title>Michael Jordan — Professor at Example University</title><main><p>Michael Jordan is a Professor at Example University.</p></main></html>",
          { headers: { "content-type": "text/html" } },
        );
      }
      throw new Error(`Unexpected provider-context request ${url.href}`);
    },
  });

  const searchResult = await dependencies.executeAction(
    {
      schemaVersion: domain.SCHEMA_VERSION,
      id: "action-provider-school-search",
      frontierEntryId: "action-provider-school-search",
      tool: "search_web",
      purpose: "Find exact public university pages for the named professor.",
      arguments: { query: '"Michael Jordan" "UC Berkeley" "Professor"' },
      budgetClass: "search",
      sourceTier: 1,
      sourceLaneId: "t1.first_party",
      pathCost: 1,
      mutated: false,
    },
    {
      schemaVersion: domain.SCHEMA_VERSION,
      state: engine.snapshot(),
      modelAccounting: { reserve: () => true, settle: () => {} },
    },
  );

  assert.equal(searchResult.status, "succeeded");
  assert.equal(searchResult.evidence.length, 2);
  assert.ok(
    searchResult.evidence.every(
      (evidence) =>
        evidence.attributes.provider === "openrouter:web_search" &&
        evidence.attributes.querySubjectName === "Michael Jordan" &&
        evidence.canonicalSubset.providerAttestedUrl === true,
    ),
  );
  const candidateBoundSearch = await dependencies.executeAction(
    {
      schemaVersion: domain.SCHEMA_VERSION,
      id: "action-provider-school-candidate-search",
      frontierEntryId: "action-provider-school-candidate-search",
      tool: "search_web",
      purpose: "Search one candidate-bound refinement.",
      arguments: { query: '"Michael Jordan" university profile' },
      candidateId: candidate.id,
      budgetClass: "search",
      sourceTier: 6,
      sourceLaneId: "t6.general_discovery",
      pathCost: 1.2,
      mutated: false,
    },
    {
      schemaVersion: domain.SCHEMA_VERSION,
      state: engine.snapshot(),
      modelAccounting: { reserve: () => true, settle: () => {} },
    },
  );
  assert.equal(candidateBoundSearch.status, "succeeded");
  assert.ok(
    candidateBoundSearch.evidence.every((evidence) => evidence.attributes.querySubjectName === undefined),
    "only candidate-free named-person discovery may mint deterministic query-subject provenance",
  );
  for (const evidence of searchResult.evidence) assert.equal(engine.admitEvidence(evidence).admitted, true);

  const fetchLead = async (lead) =>
    dependencies.executeAction(
      {
        schemaVersion: domain.SCHEMA_VERSION,
        id: `action-provider-fetch-${lead.attributes.leadId}`,
        frontierEntryId: `action-provider-fetch-${lead.attributes.leadId}`,
        tool: "fetch_public_source",
        purpose: "Fetch the exact provider-attested university page.",
        arguments: { leadId: lead.attributes.leadId, claimFocus: "Public professional identity and university" },
        candidateId: candidate.id,
        budgetClass: "fetch",
        sourceTier: lead.attributes.classifiedSourceTier,
        sourceLaneId: lead.attributes.classifiedSourceLaneId,
        pathCost: 1.4,
        mutated: false,
      },
      {
        schemaVersion: domain.SCHEMA_VERSION,
        state: engine.snapshot(),
        modelAccounting: {
          reserve: () => {
            extractionReservations += 1;
            return true;
          },
          settle: () => {},
        },
      },
    );

  const matchingLead = searchResult.evidence.find((evidence) => evidence.sourceUrl === matchingUrl);
  const conflictingLead = searchResult.evidence.find((evidence) => evidence.sourceUrl === conflictingUrl);
  assert.ok(matchingLead);
  assert.ok(conflictingLead);
  const matchingResult = await fetchLead(matchingLead);
  const conflictingResult = await fetchLead(conflictingLead);

  assert.equal(extractionReservations, 0, "provider-cited exact pages do not invoke model extraction");
  assert.equal(providerRequests, 2, "the only provider requests are the two explicit search actions");
  assert.equal(matchingResult.status, "succeeded");
  const matchingQuote = matchingResult.evidence.find((evidence) => evidence.verificationMethod === "direct_fetch");
  assert.ok(matchingQuote);
  assert.equal(matchingQuote.candidateId, candidate.id);
  assert.equal(matchingQuote.candidateRef, undefined);
  assert.equal(matchingQuote.claim, "Michael Jordan is a Professor at UC Berkeley.");
  assert.equal(matchingQuote.excerpt, matchingQuote.claim);
  assert.equal(matchingQuote.attributes.matchedTargetOrganization, "UC Berkeley");
  assert.equal(matchingQuote.attributes.matchedTargetRole, "Professor");
  assert.equal(matchingQuote.attributes.extractionMethod, "deterministic_public_html_named_person_quote");
  assert.equal(matchingQuote.reliability, 0.55);
  assert.equal(matchingQuote.spoofable, true);

  assert.equal(conflictingResult.status, "partial");
  const conflictingQuote = conflictingResult.evidence.find(
    (evidence) => evidence.verificationMethod === "direct_fetch",
  );
  assert.ok(conflictingQuote);
  assert.equal(conflictingQuote.candidateId, undefined);
  assert.notEqual(conflictingQuote.candidateRef, undefined);
  assert.equal(conflictingQuote.claim, "Michael Jordan is a Professor at Example University.");
  assert.equal(conflictingQuote.excerpt, conflictingQuote.claim);
  assert.equal(conflictingQuote.attributes.quarantinedFromCandidateId, candidate.id);
  assert.equal(conflictingQuote.reliability, 0.55);
  assert.equal(conflictingQuote.spoofable, true);
  assert.equal(conflictingResult.candidateBranches.length, 1);
  assert.equal(conflictingResult.candidateBranches[0].parentCandidateId, candidate.id);
  assert.ok(conflictingResult.diagnostics.some((item) => item.code === "candidate_binding_organization_missing"));
});

test("non-profile name mentions stay discovery-only while canonical profiles and biographies remain separated", async () => {
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: "Elon Musk",
    requestedDepth: "deep",
  });
  const engine = new agent.InvestigationEngine(input, {
    clock: domain.createSequenceClock("2026-08-21T12:00:00.000Z", 1),
    ids: domain.createDeterministicIdFactory("non-profile-person-admission"),
  });
  const sources = [
    {
      key: "crossref",
      url: "https://api.crossref.org/works/10.5555%2Felon.musk",
      title: "A systems paper authored by Elon Musk — Crossref metadata",
      body: "The public work record lists Elon Musk among its authors.",
      profileLike: false,
    },
    {
      key: "app-store",
      url: "https://apps.apple.com/us/app/example-app/id123456789",
      title: "Example App by Elon Musk",
      body: "The product listing credits Elon Musk.",
      profileLike: false,
    },
    {
      key: "article",
      url: "https://www.bbc.com/news/articles/elon-musk-company-update",
      title: "Elon Musk discussed in a company update",
      body: "The article mentions Elon Musk in reporting about the company.",
      profileLike: false,
    },
    {
      key: "homepage",
      url: "https://example.com/",
      title: "Elon Musk",
      body: "This generic homepage contains the exact name Elon Musk.",
      profileLike: false,
    },
    {
      key: "github-repository",
      url: "https://github.com/example/quotes",
      title: "Quotes project mentioning Elon Musk",
      body: "This repository README mentions Elon Musk.",
      profileLike: false,
    },
    {
      key: "github-profile",
      url: "https://github.com/elonmusk",
      title: "Elon Musk — GitHub",
      body: "Elon Musk",
      profileLike: true,
    },
    {
      key: "first-party-biography",
      url: "https://www.tesla.com/elon-musk",
      title: "Elon Musk | Tesla",
      body: "Elon Musk",
      profileLike: true,
    },
  ];
  const resumeUrl = "https://resume.io/resume-examples/elon-musk";
  const sourceByUrl = new Map(sources.map((source) => [source.url, source]));
  let providerRequests = 0;
  let directFetchRequests = 0;
  const dependencies = createLiveDependencies(input, {
    apiKey: "test-key",
    model: "test/model",
    resolveHostname: async () => ["93.184.216.34"],
    fetch: async (request) => {
      const url = new URL(String(request));
      if (url.hostname === "openrouter.ai") {
        providerRequests += 1;
        assert.equal(providerRequests, 1, "every fetched exact-name page should use deterministic extraction");
        return jsonResponse({
          id: "generation-non-profile-person-admission",
          model: "test/model",
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "Public source leads were observed.",
                annotations: [
                  ...sources.map((source) => ({
                    type: "url_citation",
                    url_citation: { url: source.url, title: source.title },
                  })),
                  {
                    type: "url_citation",
                    url_citation: { url: resumeUrl, title: "Elon Musk resume example and template" },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        });
      }
      const source = sourceByUrl.get(url.href);
      if (!source) throw new Error(`Unexpected non-profile admission request ${url.href}`);
      directFetchRequests += 1;
      return new Response(
        `<html><head><title>${source.title}</title></head><body><main><p>${source.body}</p><a href="/people/elon-musk">Biography</a></main></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });

  const searchResult = await dependencies.executeAction(
    {
      schemaVersion: domain.SCHEMA_VERSION,
      id: "action-non-profile-person-search",
      frontierEntryId: "action-non-profile-person-search",
      tool: "search_web",
      purpose: "Discover exact public professional sources for the named subject.",
      arguments: { query: '"Elon Musk" public professional profile' },
      budgetClass: "search",
      sourceTier: 1,
      sourceLaneId: "t1.first_party",
      pathCost: 1,
      mutated: false,
    },
    {
      schemaVersion: domain.SCHEMA_VERSION,
      state: engine.snapshot(),
      modelAccounting: { reserve: () => true, settle: () => {} },
    },
  );

  assert.equal(searchResult.status, "succeeded");
  assert.equal(searchResult.candidates.length, 1);
  assert.equal(searchResult.evidence.length, sources.length);
  assert.equal(
    searchResult.evidence.some((evidence) => evidence.sourceUrl === resumeUrl),
    false,
  );
  assert.ok(
    searchResult.diagnostics.some((diagnostic) => diagnostic.code === "discovery_leads_rejected_as_non_professional"),
  );
  const candidate = engine.addCandidate(searchResult.candidates[0]).candidate;
  for (const draft of searchResult.evidence) {
    const bound = { ...draft, candidateId: candidate.id };
    delete bound.candidateRef;
    assert.equal(engine.admitEvidence(bound).admitted, true);
  }

  const leads = new Map(engine.snapshot().evidence.map((evidence) => [evidence.sourceUrl, evidence]));
  assert.equal(leads.get("https://www.tesla.com/elon-musk")?.attributes.leadSchedulingDisposition, "prioritize");
  assert.equal(leads.get("https://www.tesla.com/elon-musk")?.attributes.leadSchedulingReason, "candidate_bio_path");
  assert.equal(leads.get("https://example.com/")?.attributes.leadSchedulingDisposition, "deprioritize");
  assert.equal(leads.get("https://example.com/")?.attributes.leadSchedulingReason, "generic_person_homepage");
  assert.equal(leads.get("https://github.com/example/quotes")?.attributes.classifiedSourceType, "code_profile");
  assert.equal(leads.get("https://github.com/elonmusk")?.attributes.classifiedSourceType, "code_profile");

  for (const source of sources) {
    const lead = leads.get(source.url);
    assert.ok(lead, source.key);
    const direct = await dependencies.executeAction(
      {
        schemaVersion: domain.SCHEMA_VERSION,
        id: `action-fetch-${source.key}`,
        frontierEntryId: `action-fetch-${source.key}`,
        tool: "fetch_public_source",
        purpose: "Fetch the exact discovery lead without assuming person identity.",
        arguments: { leadId: lead.attributes.leadId, claimFocus: "Public professional identity" },
        candidateId: candidate.id,
        budgetClass: "fetch",
        sourceTier: lead.attributes.classifiedSourceTier,
        sourceLaneId: lead.attributes.classifiedSourceLaneId,
        pathCost: 1.4,
        mutated: false,
      },
      {
        schemaVersion: domain.SCHEMA_VERSION,
        state: engine.snapshot(),
        modelAccounting: { reserve: () => true, settle: () => {} },
      },
    );

    assert.equal(direct.status, "partial", source.key);
    const quote = direct.evidence.find((evidence) => evidence.verificationMethod === "direct_fetch");
    assert.ok(quote, source.key);
    if (source.profileLike) {
      assert.equal(direct.candidateBranches.length, 1, source.key);
      assert.equal(quote.candidateId, undefined, source.key);
      assert.ok(quote.candidateRef, source.key);
      assert.equal(quote.disposition ?? "supports", "supports", source.key);
      assert.ok(
        direct.candidateBranches[0].candidate.signals.some(
          (signal) => signal.kind === "profile_url" && signal.value === source.url && signal.strength === "strong",
        ),
        source.key,
      );
    } else {
      assert.deepEqual(direct.candidates, [], source.key);
      assert.deepEqual(direct.candidateSignals, [], source.key);
      assert.equal(direct.candidateBranches, undefined, source.key);
      assert.equal(quote.candidateId, candidate.id, source.key);
      assert.equal(quote.candidateRef, undefined, source.key);
      assert.equal(quote.disposition, "discovery_only", source.key);
      assert.equal(quote.reliability, 0, source.key);
      assert.equal(quote.attributes.identityBinding, false, source.key);
      assert.equal(quote.attributes.findingAuthority, false, source.key);
      assert.equal(quote.attributes.nonProfileSubjectMention, true, source.key);
      assert.equal(
        direct.evidence.some((evidence) => evidence.attributes.sameOriginProfessionalLink === true),
        false,
        `${source.key}: ${JSON.stringify((direct.diagnostics ?? []).map((diagnostic) => diagnostic.code))}`,
      );
      assert.ok(
        direct.diagnostics.some((diagnostic) => diagnostic.code === "non_profile_subject_mention_discovery_only"),
        source.key,
      );

      const admission = engine.admitEvidence(quote);
      assert.equal(admission.admitted, true, source.key);
      const wayback = await dependencies.executeAction(
        {
          schemaVersion: domain.SCHEMA_VERSION,
          id: `action-wayback-${source.key}`,
          frontierEntryId: `action-wayback-${source.key}`,
          tool: "wayback_profile_history",
          purpose: "Attempt an archive pivot only if the source is candidate-established.",
          arguments: { url: source.url },
          candidateId: candidate.id,
          budgetClass: "fetch",
          sourceTier: 5,
          sourceLaneId: "t5.candidate_wayback",
          pathCost: 2,
          mutated: false,
        },
        {
          schemaVersion: domain.SCHEMA_VERSION,
          state: engine.snapshot(),
          modelAccounting: { reserve: () => true, settle: () => {} },
        },
      );
      assert.equal(wayback.status, "skipped", source.key);
      assert.equal(wayback.meta.requests, 0, source.key);
      assert.ok(wayback.diagnostics.some((diagnostic) => diagnostic.code === "admitted_candidate_link_required"));
    }
  }

  assert.equal(providerRequests, 1);
  assert.equal(directFetchRequests, sources.length, "the rejected resume/template lead must never be fetched");
});

test("only the persisted exact-subject-slug scheduling pair authorizes generic-title person admission", async () => {
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: "Elon Musk",
    requestedDepth: "standard",
  });
  const engine = new agent.InvestigationEngine(input, {
    clock: domain.createSequenceClock("2026-08-21T12:05:00.000Z", 1),
    ids: domain.createDeterministicIdFactory("persisted-exact-subject-slug-probe"),
  });
  const sources = [
    {
      key: "persisted-pair",
      url: "https://www.tesla.com/elon-musk?utm_source=atlas",
      redirectTo: "https://www.tesla.com/elon-musk/",
      expectedProfileUrl: "https://www.tesla.com/elon-musk/",
      disposition: "prioritize",
      reason: "exact_subject_slug_probe",
      profileLike: true,
    },
    {
      key: "reason-only",
      url: "https://publisher.example/elon-musk",
      disposition: "neutral",
      reason: "exact_subject_slug_probe",
      profileLike: false,
    },
    {
      key: "disposition-only",
      url: "https://organization.example/elon-musk",
      disposition: "prioritize",
      reason: "neutral",
      profileLike: false,
    },
    {
      key: "changed-identity-path",
      url: "https://profile.example/elon-musk",
      redirectTo: "https://profile.example/",
      disposition: "prioritize",
      reason: "exact_subject_slug_probe",
      profileLike: false,
      directQuoteExpected: false,
    },
  ];
  const sourceByUrl = new Map(sources.map((source) => [source.url, source]));
  const redirectedSourceByUrl = new Map(
    sources.filter((source) => source.redirectTo).map((source) => [source.redirectTo, source]),
  );
  let providerRequests = 0;
  let directFetchRequests = 0;
  const dependencies = createLiveDependencies(input, {
    apiKey: "test-key",
    model: "test/model",
    resolveHostname: async () => ["93.184.216.34"],
    fetch: async (request) => {
      const url = new URL(String(request));
      if (url.hostname === "openrouter.ai") {
        providerRequests += 1;
        return jsonResponse({
          id: "generation-persisted-exact-subject-slug-probe",
          model: "test/model",
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "Public pages were observed.",
                annotations: sources.map((source) => ({
                  type: "url_citation",
                  url_citation: { url: source.url, title: "Leadership" },
                })),
              },
            },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        });
      }
      const source = sourceByUrl.get(url.href);
      const redirectedSource = redirectedSourceByUrl.get(url.href);
      if (!source && !redirectedSource) throw new Error(`Unexpected exact-subject-slug request ${url.href}`);
      directFetchRequests += 1;
      if (source?.redirectTo) {
        return new Response(null, { status: 302, headers: { location: source.redirectTo } });
      }
      return new Response("<html><title>Leadership</title><main><p>Elon Musk</p></main></html>", {
        headers: { "content-type": "text/html" },
      });
    },
  });

  const searchResult = await dependencies.executeAction(
    {
      schemaVersion: domain.SCHEMA_VERSION,
      id: "action-exact-subject-slug-search",
      frontierEntryId: "action-exact-subject-slug-search",
      tool: "search_web",
      purpose: "Find exact first-party public pages for the named subject.",
      arguments: { query: '"Elon Musk" official biography' },
      budgetClass: "search",
      sourceTier: 1,
      sourceLaneId: "t1.first_party",
      pathCost: 1,
      mutated: false,
    },
    {
      schemaVersion: domain.SCHEMA_VERSION,
      state: engine.snapshot(),
      modelAccounting: { reserve: () => true, settle: () => {} },
    },
  );

  assert.equal(searchResult.status, "succeeded");
  assert.equal(searchResult.evidence.length, sources.length);
  const candidate = engine.addCandidate(searchResult.candidates[0]).candidate;
  const leads = new Map();
  for (const draft of searchResult.evidence) {
    const source = sourceByUrl.get(draft.sourceUrl);
    assert.ok(source);
    const persisted = {
      ...draft,
      candidateId: candidate.id,
      attributes: {
        ...draft.attributes,
        leadSchedulingDisposition: source.disposition,
        leadSchedulingReason: source.reason,
      },
    };
    delete persisted.candidateRef;
    const admission = engine.admitEvidence(persisted);
    assert.equal(admission.admitted, true);
    leads.set(source.key, admission.evidence);
  }

  for (const source of sources) {
    const lead = leads.get(source.key);
    assert.ok(lead, source.key);
    const direct = await dependencies.executeAction(
      {
        schemaVersion: domain.SCHEMA_VERSION,
        id: `action-exact-subject-slug-fetch-${source.key}`,
        frontierEntryId: `action-exact-subject-slug-fetch-${source.key}`,
        tool: "fetch_public_source",
        // The purpose is deliberately identical across cases. Only persisted
        // discovery evidence may authorize the narrow profile-like exception.
        purpose: "Fetch the exact-subject-slug profile probe.",
        arguments: { leadId: lead.attributes.leadId, claimFocus: "Public professional identity" },
        candidateId: candidate.id,
        budgetClass: "fetch",
        sourceTier: lead.attributes.classifiedSourceTier,
        sourceLaneId: lead.attributes.classifiedSourceLaneId,
        pathCost: 1.4,
        mutated: false,
      },
      {
        schemaVersion: domain.SCHEMA_VERSION,
        state: engine.snapshot(),
        modelAccounting: { reserve: () => true, settle: () => {} },
      },
    );

    assert.equal(direct.status, "partial", source.key);
    const quote = direct.evidence.find((evidence) => evidence.verificationMethod === "direct_fetch");
    if (source.directQuoteExpected === false) {
      assert.equal(quote, undefined, source.key);
      assert.equal(direct.candidateBranches, undefined, source.key);
      assert.equal(direct.candidateSignals, undefined, source.key);
      assert.ok(
        direct.evidence.every((evidence) => evidence.disposition === "discovery_only"),
        source.key,
      );
      assert.ok(
        direct.diagnostics.some((diagnostic) => diagnostic.code === "evidence_extraction_invalid"),
        source.key,
      );
      for (const evidence of direct.evidence) assert.equal(engine.admitEvidence(evidence).admitted, true, source.key);
      const wayback = await dependencies.executeAction(
        {
          schemaVersion: domain.SCHEMA_VERSION,
          id: `action-exact-subject-slug-wayback-${source.key}`,
          frontierEntryId: `action-exact-subject-slug-wayback-${source.key}`,
          tool: "wayback_profile_history",
          purpose: "Verify that a changed identity path cannot authorize archive fanout.",
          arguments: { url: source.redirectTo },
          candidateId: candidate.id,
          budgetClass: "fetch",
          sourceTier: 5,
          sourceLaneId: "t5.candidate_wayback",
          pathCost: 2,
          mutated: false,
        },
        {
          schemaVersion: domain.SCHEMA_VERSION,
          state: engine.snapshot(),
          modelAccounting: { reserve: () => true, settle: () => {} },
        },
      );
      assert.equal(wayback.status, "skipped", source.key);
      assert.equal(wayback.meta.requests, 0, source.key);
      continue;
    }
    assert.ok(quote, source.key);
    if (source.profileLike) {
      assert.equal(direct.candidateBranches.length, 1, source.key);
      assert.ok(quote.candidateRef, source.key);
      assert.equal(quote.disposition ?? "supports", "supports", source.key);
      assert.ok(
        direct.candidateBranches[0].candidate.signals.some(
          (signal) =>
            signal.kind === "profile_url" &&
            signal.value === (source.expectedProfileUrl ?? source.url) &&
            signal.strength === "strong",
        ),
        source.key,
      );
    } else {
      assert.equal(direct.candidateBranches, undefined, source.key);
      assert.deepEqual(direct.candidateSignals, [], source.key);
      assert.equal(quote.candidateId, candidate.id, source.key);
      assert.equal(quote.candidateRef, undefined, source.key);
      assert.equal(quote.disposition, "discovery_only", source.key);
      assert.equal(quote.attributes.identityBinding, false, source.key);
      assert.ok(
        direct.diagnostics.some((diagnostic) => diagnostic.code === "non_profile_subject_mention_discovery_only"),
        source.key,
      );
    }
  }

  assert.equal(providerRequests, 3, "only the changed identity path should exercise bounded extraction retries");
  assert.equal(directFetchRequests, sources.length + 2, "each bounded same-host redirect is charged explicitly");
});

test("exact fetched titles requalify only canonical candidate-bio paths with exact fictional person slugs", async () => {
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: "Alex Rivera",
    requestedDepth: "standard",
  });
  const engine = new agent.InvestigationEngine(input, {
    clock: domain.createSequenceClock("2026-08-21T17:55:00.000Z", 1),
    ids: domain.createDeterministicIdFactory("exact-fetched-person-bio-path"),
  });
  const sources = [
    {
      key: "profile",
      url: "https://registry.example/profile/alex-rivera",
      searchTitle: "Alex Rivera | Registry",
      fetchedTitle: "Alex Rivera",
      body: "Alex Rivera founded Northstar Labs.",
      expectedProfileLike: true,
    },
    {
      key: "hyphenated-route",
      url: "https://biographies.example/business-leaders/alex-rivera",
      searchTitle: "Alex Rivera | Biographies",
      fetchedTitle: "Alex Rivera: Biography, Entrepreneur and Founder",
      body: "Alex Rivera founded Meridian Systems.",
      expectedProfileLike: true,
    },
    {
      key: "wrong-fetched-title",
      url: "https://directory.example/profile/alex-rivera",
      searchTitle: "Alex Rivera | Directory",
      fetchedTitle: "Morgan Lee",
      body: "Alex Rivera founded Cedar Research.",
      expectedProfileLike: false,
    },
    {
      key: "changed-redirect-path",
      url: "https://leaders.example/profile/alex-rivera",
      redirectTo: "https://leaders.example/profile/alex-rivera-updated",
      searchTitle: "Alex Rivera | Leaders",
      fetchedTitle: "Alex Rivera",
      body: "Alex Rivera founded Harbor Robotics.",
      expectedProfileLike: false,
    },
    {
      key: "generic-article",
      url: "https://gazette.example/articles/alex-rivera",
      searchTitle: "Alex Rivera | Gazette",
      fetchedTitle: "Alex Rivera",
      body: "Alex Rivera founded Juniper Works.",
      expectedProfileLike: false,
    },
    {
      key: "document-container",
      url: "https://bulletin.example/articles/profile/alex-rivera",
      searchTitle: "Alex Rivera | Bulletin",
      fetchedTitle: "Alex Rivera",
      body: "Alex Rivera founded Kestrel Engines.",
      expectedProfileLike: false,
    },
  ];
  const sourceByUrl = new Map(sources.map((source) => [source.url, source]));
  const sourceByRedirectUrl = new Map(
    sources.filter((source) => source.redirectTo).map((source) => [source.redirectTo, source]),
  );
  let searchProviderCalls = 0;
  let extractionProviderCalls = 0;
  const dependencies = createLiveDependencies(input, {
    apiKey: "test-key",
    model: "test/model",
    resolveHostname: async () => ["93.184.216.34"],
    fetch: async (request, init = {}) => {
      const url = new URL(String(request));
      if (url.hostname === "openrouter.ai") {
        const body = JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body));
        if (body.tools?.some((tool) => tool.function?.name === "submit_evidence_extraction")) {
          extractionProviderCalls += 1;
          return jsonResponse({
            id: `generation-fictional-bio-extraction-${extractionProviderCalls}`,
            model: "test/model",
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: `call-fictional-bio-extraction-${extractionProviderCalls}`,
                      type: "function",
                      function: {
                        name: "submit_evidence_extraction",
                        arguments: JSON.stringify({
                          claim: "Alex Rivera founded Harbor Robotics.",
                          excerpt: "Alex Rivera founded Harbor Robotics.",
                          publisher: "Leaders Example",
                          sourceType: "other",
                          temporalStatus: "unknown",
                          subjectName: "Alex Rivera",
                          organization: null,
                        }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 2, completion_tokens: 2 },
          });
        }
        searchProviderCalls += 1;
        return jsonResponse({
          id: "generation-fictional-bio-search",
          model: "test/model",
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "Public professional pages were observed.",
                annotations: sources.map((source) => ({
                  type: "url_citation",
                  url_citation: { url: source.url, title: source.searchTitle },
                })),
              },
            },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        });
      }
      const source = sourceByUrl.get(url.href);
      const redirectedSource = sourceByRedirectUrl.get(url.href);
      if (!source && !redirectedSource) throw new Error(`Unexpected fictional bio request ${url.href}`);
      if (source?.redirectTo) {
        return new Response(null, { status: 302, headers: { location: source.redirectTo } });
      }
      const page = source ?? redirectedSource;
      return new Response(
        `<html><head><title>${page.fetchedTitle}</title></head><body><main><p>${page.body}</p></main></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });

  const searchResult = await dependencies.executeAction(
    {
      schemaVersion: domain.SCHEMA_VERSION,
      id: "action-fictional-bio-search",
      frontierEntryId: "action-fictional-bio-search",
      tool: "search_web",
      purpose: "Discover bounded fictional public-professional pages.",
      arguments: { query: '"Alex Rivera" public professional biography' },
      budgetClass: "search",
      sourceTier: 6,
      sourceLaneId: "t6.general_discovery",
      pathCost: 1,
      mutated: false,
    },
    {
      schemaVersion: domain.SCHEMA_VERSION,
      state: engine.snapshot(),
      modelAccounting: { reserve: () => true, settle: () => {} },
    },
  );

  assert.equal(searchResult.status, "succeeded");
  assert.equal(searchResult.candidates.length, 1);
  assert.equal(searchResult.evidence.length, sources.length);
  const candidate = engine.addCandidate(searchResult.candidates[0]).candidate;
  const leads = new Map();
  for (const draft of searchResult.evidence) {
    const persisted = { ...draft, candidateId: candidate.id };
    delete persisted.candidateRef;
    const admission = engine.admitEvidence(persisted);
    assert.equal(admission.admitted, true, `${draft.sourceUrl}: ${admission.reason}`);
    leads.set(draft.sourceUrl, admission.evidence);
  }

  assert.equal(
    leads.get("https://biographies.example/business-leaders/alex-rivera")?.attributes.leadSchedulingReason,
    "candidate_bio_path",
  );
  assert.equal(
    leads.get("https://gazette.example/articles/alex-rivera")?.attributes.leadSchedulingDisposition,
    "neutral",
  );

  const acceptedCandidateRefs = new Set();
  for (const source of sources) {
    const lead = leads.get(source.url);
    assert.ok(lead, source.key);
    assert.equal(lead.attributes.classifiedSourceType, "other", source.key);
    assert.equal(lead.attributes.classifiedSourceTier, 6, source.key);
    const direct = await dependencies.executeAction(
      {
        schemaVersion: domain.SCHEMA_VERSION,
        id: `action-fictional-bio-fetch-${source.key}`,
        frontierEntryId: `action-fictional-bio-fetch-${source.key}`,
        tool: "fetch_public_source",
        purpose: "Fetch the exact fictional discovery lead.",
        arguments: { leadId: lead.attributes.leadId, claimFocus: "Public professional identity" },
        candidateId: candidate.id,
        budgetClass: "fetch",
        sourceTier: 6,
        sourceLaneId: "t6.candidate_public_source",
        pathCost: 1.4,
        mutated: false,
      },
      {
        schemaVersion: domain.SCHEMA_VERSION,
        state: engine.snapshot(),
        modelAccounting: { reserve: () => true, settle: () => {} },
      },
    );

    assert.equal(direct.status, "partial", source.key);
    const quote = direct.evidence.find((evidence) => evidence.verificationMethod === "direct_fetch");
    assert.ok(quote, source.key);
    assert.equal(quote.sourceType, "other", source.key);
    assert.equal(quote.spoofable, true, source.key);
    if (source.expectedProfileLike) {
      assert.equal(direct.candidateBranches.length, 1, source.key);
      assert.equal(quote.candidateId, undefined, source.key);
      assert.ok(quote.candidateRef, source.key);
      assert.equal(quote.disposition ?? "supports", "supports", source.key);
      assert.equal(quote.reliability, 0.55, source.key);
      assert.equal(quote.attributes.extractionMethod, "deterministic_public_html_named_person_quote", source.key);
      assert.equal(quote.claim, source.body, source.key);
      acceptedCandidateRefs.add(quote.candidateRef);
    } else {
      assert.equal(direct.candidateBranches, undefined, source.key);
      assert.deepEqual(direct.candidateSignals, [], source.key);
      assert.equal(quote.candidateId, candidate.id, source.key);
      assert.equal(quote.candidateRef, undefined, source.key);
      assert.equal(quote.disposition, "discovery_only", source.key);
      assert.equal(quote.reliability, 0, source.key);
      assert.equal(quote.attributes.identityBinding, false, source.key);
      assert.equal(quote.attributes.findingAuthority, false, source.key);
    }
  }

  assert.equal(acceptedCandidateRefs.size, 2, "separate fetched pages remain separate candidate branches");
  assert.equal(searchProviderCalls, 1);
  assert.equal(extractionProviderCalls, 1, "only the changed redirect requires model extraction");
});

test("an exact hardened page emits only bounded same-origin professional links as candidate discovery leads", async () => {
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: "Ganesh Talluri",
    requestedDepth: "standard",
  });
  const engine = new agent.InvestigationEngine(input, {
    clock: domain.createSequenceClock("2026-08-20T18:32:00.000Z", 1),
    ids: domain.createDeterministicIdFactory("same-origin-professional-links"),
  });
  const candidate = engine.addCandidate({
    displayName: "Ganesh Talluri",
    signals: [
      {
        kind: "name",
        value: "Ganesh Talluri",
        normalizedValue: "ganesh talluri",
        strength: "weak",
        assurance: "self_asserted",
      },
    ],
  }).candidate;
  const sourceUrl = "https://portfolio.example/people/ganesh-talluri/profile";
  let sourceRequests = 0;
  const dependencies = createLiveDependencies(input, {
    apiKey: "test-key",
    model: "test/model",
    resolveHostname: async () => ["93.184.216.34"],
    fetch: async (request) => {
      const url = new URL(String(request));
      if (url.hostname === "openrouter.ai") {
        return jsonResponse(
          { error: { message: "provider quota exhausted" } },
          { status: 429, headers: { "retry-after": "0" } },
        );
      }
      if (url.hostname === "html.duckduckgo.com") {
        const wrapped = `//duckduckgo.com/l/?uddg=${encodeURIComponent(sourceUrl)}&amp;rut=opaque`;
        return new Response(`<a class="result__a" href="${wrapped}">Ganesh Talluri — Portfolio</a>`, {
          headers: { "content-type": "text/html" },
        });
      }
      if (url.href === sourceUrl) {
        sourceRequests += 1;
        return new Response(
          `<!doctype html><title>Ganesh Talluri — Portfolio</title><main><p>Ganesh Talluri</p>
          <a href="/people/ganesh-talluri">Ganesh Talluri bio</a>
          <a href="/about">About</a>
          <a href="/publications">Publications</a>
          <a href="/news">News beyond the page cap</a>
          <a href="/login">Login</a>
          <a href="https://other.example/team">Other origin</a></main>`,
          { headers: { "content-type": "text/html" } },
        );
      }
      throw new Error(`Unexpected same-origin test request ${url.href}`);
    },
  });
  const modelAccounting = { reserve: () => true, settle: () => {} };
  const searchResult = await dependencies.executeAction(
    {
      schemaVersion: domain.SCHEMA_VERSION,
      id: "action-page-link-search",
      frontierEntryId: "action-page-link-search",
      tool: "search_web",
      purpose: "Find the exact public page.",
      arguments: { query: "Ganesh Talluri public professional profile" },
      candidateId: candidate.id,
      budgetClass: "search",
      sourceTier: 6,
      sourceLaneId: "t6.general_discovery",
      pathCost: 1,
      mutated: false,
    },
    { schemaVersion: domain.SCHEMA_VERSION, state: engine.snapshot(), modelAccounting },
  );
  assert.equal(engine.admitEvidence(searchResult.evidence[0]).admitted, true);

  const fetched = await dependencies.executeAction(
    {
      schemaVersion: domain.SCHEMA_VERSION,
      id: "action-page-link-fetch",
      frontierEntryId: "action-page-link-fetch",
      tool: "fetch_public_source",
      purpose: "Fetch the exact candidate-bound discovery lead.",
      arguments: {
        leadId: searchResult.evidence[0].attributes.leadId,
        claimFocus: "Public professional identity",
      },
      candidateId: candidate.id,
      budgetClass: "fetch",
      sourceTier: 6,
      sourceLaneId: "t6.candidate_public_source",
      pathCost: 1.4,
      mutated: false,
    },
    { schemaVersion: domain.SCHEMA_VERSION, state: engine.snapshot(), modelAccounting },
  );

  assert.equal(sourceRequests, 1, "link discovery performs no hidden child-page request");
  assert.equal(fetched.meta.requests, 1);
  const direct = fetched.evidence.find((evidence) => evidence.verificationMethod === "direct_fetch");
  const leads = fetched.evidence.filter(
    (evidence) => evidence.attributes.provider === "page:same_origin_professional_links",
  );
  assert.ok(direct);
  assert.equal(leads.length, 3);
  assert.deepEqual(
    leads.map((evidence) => evidence.sourceUrl),
    [
      "https://portfolio.example/people/ganesh-talluri",
      "https://portfolio.example/about",
      "https://portfolio.example/publications",
    ],
  );
  assert.ok(leads.every((evidence) => evidence.disposition === "discovery_only"));
  assert.ok(leads.every((evidence) => evidence.verificationMethod === "search_discovery"));
  assert.ok(leads.every((evidence) => evidence.candidateRef === direct.candidateRef));
  assert.ok(
    leads.every((evidence) => evidence.attributes.classifiedSourceLaneId === "t6.candidate_public_source"),
    "same-origin does not promote an otherwise unclassified host into a first-party tier",
  );
  assert.ok(leads.every((evidence) => evidence.canonicalSubset.sourcePageUrl === sourceUrl));
  assert.ok(leads.every((evidence) => evidence.canonicalSubset.sourcePageContentHash === direct.contentHash));
  assert.equal(JSON.stringify(leads).includes("/login"), false);
  assert.equal(JSON.stringify(leads).includes("other.example"), false);
  assert.ok(fetched.diagnostics.some((item) => item.code === "same_origin_professional_links_discovered"));
});

test("successful provider response without grounded URLs uses the bounded public-web fallback", async () => {
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: "Ganesh Talluri",
    requestedDepth: "quick",
  });
  const engine = new agent.InvestigationEngine(input, {
    clock: domain.createSequenceClock("2026-08-20T18:35:00.000Z", 1),
    ids: domain.createDeterministicIdFactory("ungrounded-provider-fallback"),
  });
  const candidate = engine.addCandidate({
    displayName: "Ganesh Talluri",
    signals: [
      {
        kind: "name",
        value: "Ganesh Talluri",
        normalizedValue: "ganesh talluri",
        strength: "weak",
        assurance: "self_asserted",
      },
    ],
  }).candidate;
  let providerSettlements = 0;
  let publicSearchCalls = 0;
  const sourceUrl = "https://portfolio.example/ganesh";
  const dependencies = createLiveDependencies(input, {
    apiKey: "test-key",
    model: "test/model",
    resolveHostname: async (hostname) => {
      assert.equal(hostname, "html.duckduckgo.com");
      return ["52.149.246.39"];
    },
    fetch: async (request) => {
      const url = new URL(String(request));
      if (url.hostname === "openrouter.ai") {
        return jsonResponse({
          id: "generation-without-sources",
          model: "test/model",
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "No grounded annotations were returned.",
              },
            },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        });
      }
      if (url.hostname === "html.duckduckgo.com") {
        publicSearchCalls += 1;
        const wrapped = `//duckduckgo.com/l/?uddg=${encodeURIComponent(sourceUrl)}&amp;rut=opaque`;
        return new Response(`<a class="result__a" href="${wrapped}">Ganesh Talluri — Portfolio</a>`, {
          headers: { "content-type": "text/html" },
        });
      }
      throw new Error(`Unexpected outbound request ${url.href}`);
    },
  });

  const result = await dependencies.executeAction(
    {
      schemaVersion: domain.SCHEMA_VERSION,
      id: "action-ungrounded-provider-search",
      frontierEntryId: "action-ungrounded-provider-search",
      tool: "search_web",
      purpose: "Find a direct public professional source.",
      arguments: { query: "Ganesh Talluri public professional profile" },
      candidateId: candidate.id,
      budgetClass: "search",
      sourceTier: 6,
      sourceLaneId: "t6.general_discovery",
      pathCost: 1,
      mutated: false,
    },
    {
      schemaVersion: domain.SCHEMA_VERSION,
      state: engine.snapshot(),
      modelAccounting: {
        reserve: () => true,
        settle: () => {
          providerSettlements += 1;
        },
      },
    },
  );

  assert.equal(result.status, "succeeded");
  assert.equal(result.meta.requests, 1, "only the bounded public-search request is tool-accounted");
  assert.equal(providerSettlements, 1, "the successful provider request is model-accounted");
  assert.equal(publicSearchCalls, 1);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0].sourceUrl, sourceUrl);
  assert.equal(result.evidence[0].attributes.provider, "duckduckgo:html_search");
  assert.ok(result.diagnostics.some((item) => item.code === "search_provider_sources_not_observed"));
  assert.ok(result.diagnostics.some((item) => item.code === "duckduckgo_html_fallback_used"));
  assert.ok(result.diagnostics.some((item) => item.code === "public_web_fallback_used"));
  assert.equal(
    result.diagnostics.some((item) => item.code === "search_provider_quota_exhausted"),
    false,
  );
  assert.equal(
    result.diagnostics.some((item) => item.code === "search_provider_unavailable"),
    false,
  );
});

test("qualified public-web fallback does not supplement same-name GitHub accounts", async () => {
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: "Ganesh Talluri",
    requestedDepth: "quick",
  });
  const engine = new agent.InvestigationEngine(input, {
    clock: domain.createSequenceClock("2026-08-20T18:40:00.000Z", 1),
    ids: domain.createDeterministicIdFactory("ddg-github-supplement"),
  });
  const linkedInUrl = "https://www.linkedin.com/in/ganesh-talluri";
  const dependencies = createLiveDependencies(input, {
    apiKey: "test-key",
    model: "test/model",
    resolveHostname: async () => ["93.184.216.34"],
    fetch: async (request) => {
      const url = new URL(String(request));
      if (url.hostname === "openrouter.ai") {
        return jsonResponse(
          { error: { message: "provider quota exhausted" } },
          {
            status: 429,
            headers: { "retry-after": "0" },
          },
        );
      }
      if (url.hostname === "html.duckduckgo.com") {
        return new Response(
          `<a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(linkedInUrl)}&amp;rut=opaque">Ganesh Talluri — LinkedIn</a>`,
          { headers: { "content-type": "text/html" } },
        );
      }
      if (url.hostname === "api.github.com") throw new Error("GitHub must remain a true zero-qualified-lead fallback");
      throw new Error(`Unexpected public fallback request ${url.href}`);
    },
  });

  const result = await dependencies.executeAction(
    {
      schemaVersion: domain.SCHEMA_VERSION,
      id: "action-ddg-github-supplement",
      frontierEntryId: "action-ddg-github-supplement",
      tool: "search_web",
      purpose: "Find direct public professional sources.",
      arguments: { query: "Ganesh Talluri public professional profile" },
      budgetClass: "search",
      sourceTier: 1,
      sourceLaneId: "t1.first_party",
      pathCost: 1,
      mutated: false,
    },
    {
      schemaVersion: domain.SCHEMA_VERSION,
      state: engine.snapshot(),
      modelAccounting: { reserve: () => true, settle: () => {} },
    },
  );

  assert.equal(result.status, "succeeded");
  assert.equal(result.meta.requests, 1, "only the successful DuckDuckGo request is tool-accounted");
  assert.ok(
    result.evidence.some(
      (evidence) => evidence.sourceUrl === linkedInUrl && evidence.attributes.provider === "duckduckgo:html_search",
    ),
  );
  assert.equal(result.evidence.length, 1);
  assert.equal(
    result.diagnostics.some((item) => item.code === "github_public_user_fallback_used"),
    false,
  );
});

test("concurrent primary searches suppress exact-name GitHub fallback after any qualified lead", async () => {
  for (const [caseName, qualifiedUrl] of [
    ["professional", "https://www.linkedin.com/in/alex-rivera"],
    ["github", "https://github.com/alex-rivera"],
  ]) {
    const input = domain.parseInvestigationInput({
      schemaVersion: domain.SCHEMA_VERSION,
      query: "Alex Rivera studies at Example University",
      requestedDepth: "deep",
    });
    const engine = new agent.InvestigationEngine(input, {
      clock: domain.createSequenceClock("2026-08-21T21:00:00.000Z", 1),
      ids: domain.createDeterministicIdFactory(`concurrent-primary-github-barrier-${caseName}`),
    });
    let providerCalls = 0;
    let duckDuckGoCalls = 0;
    let googleCalls = 0;
    let githubCalls = 0;
    let releaseQualifiedProvider;
    const qualifiedProviderGate = new Promise((resolve) => {
      releaseQualifiedProvider = resolve;
    });
    let markBaselineGoogleObserved;
    const baselineGoogleObserved = new Promise((resolve) => {
      markBaselineGoogleObserved = resolve;
    });
    const dependencies = createLiveDependencies(input, {
      apiKey: "test-key",
      model: "test/model",
      resolveHostname: async () => ["93.184.216.34"],
      fetch: async (request, init = {}) => {
        const url = new URL(String(request));
        if (url.hostname === "openrouter.ai") {
          providerCalls += 1;
          const body = JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body));
          const query = body.messages.at(-1)?.content ?? "";
          if (query.includes('"Example University"')) {
            await qualifiedProviderGate;
            return jsonResponse({
              id: `generation-concurrent-primary-qualified-${caseName}`,
              model: "test/model",
              choices: [
                {
                  finish_reason: "stop",
                  message: {
                    role: "assistant",
                    content: "One qualified public source was observed.",
                    annotations: [
                      {
                        type: "url_citation",
                        url_citation: { url: qualifiedUrl, title: "Alex Rivera — public professional profile" },
                      },
                    ],
                  },
                },
              ],
              usage: { prompt_tokens: 2, completion_tokens: 1 },
            });
          }
          return jsonResponse({
            id: `generation-concurrent-primary-empty-${caseName}`,
            model: "test/model",
            choices: [
              {
                finish_reason: "stop",
                message: { role: "assistant", content: "No source annotations were observed.", annotations: [] },
              },
            ],
            usage: { prompt_tokens: 2, completion_tokens: 1 },
          });
        }
        if (url.hostname === "html.duckduckgo.com") {
          duckDuckGoCalls += 1;
          return new Response("<html><body>No matching public links.</body></html>", {
            headers: { "content-type": "text/html" },
          });
        }
        if (url.hostname === "www.google.com") {
          googleCalls += 1;
          markBaselineGoogleObserved();
          return new Response("<html><body>No matching public links.</body></html>", {
            headers: { "content-type": "text/html" },
          });
        }
        if (url.hostname === "api.github.com") {
          githubCalls += 1;
          return jsonResponse({ total_count: 0, incomplete_results: false, items: [] });
        }
        throw new Error(`Unexpected concurrent primary-search request ${url.href}`);
      },
    });
    const action = (id, query) => ({
      schemaVersion: domain.SCHEMA_VERSION,
      id,
      frontierEntryId: id,
      tool: "search_web",
      purpose: "Exercise the investigation-wide primary-search fallback barrier.",
      arguments: { query },
      budgetClass: "search",
      sourceTier: 1,
      sourceLaneId: "t1.first_party",
      pathCost: 1,
      mutated: false,
    });
    const actionContext = () => ({
      schemaVersion: domain.SCHEMA_VERSION,
      state: engine.snapshot(),
      modelAccounting: { reserve: () => true, settle: () => {} },
    });
    const concurrentSearches = Promise.all([
      dependencies.executeAction(
        action(`action-concurrent-primary-empty-${caseName}`, '"Alex Rivera"'),
        actionContext(),
      ),
      dependencies.executeAction(
        action(`action-concurrent-primary-qualified-${caseName}`, '"Alex Rivera" "Example University"'),
        actionContext(),
      ),
    ]);
    await baselineGoogleObserved;
    // Drain the current turn after the empty baseline's last public transport.
    // Without the barrier it would reach GitHub before this deferred provider
    // result is released; with the barrier it must remain pending.
    await new Promise((resolve) => setImmediate(resolve));
    releaseQualifiedProvider();
    const [emptyBaseline, qualifiedContext] = await concurrentSearches;

    assert.equal(emptyBaseline.status, "not_found", caseName);
    assert.equal(qualifiedContext.status, "succeeded", caseName);
    assert.equal(qualifiedContext.evidence.length, 1, caseName);
    assert.equal(qualifiedContext.evidence[0].sourceUrl, qualifiedUrl, caseName);
    assert.equal(githubCalls, 0, caseName);
    assert.equal(providerCalls, 2, caseName);
    assert.equal(duckDuckGoCalls, 1, caseName);
    assert.equal(googleCalls, 1, caseName);
    assert.equal(
      emptyBaseline.diagnostics.some((item) => item.code === "github_public_user_fallback_used"),
      false,
      caseName,
    );
  }
});

test("successful keyless fallback is charged as one search call with every transport request", async () => {
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: "Ganesh Talluri",
    requestedDepth: "standard",
  });
  const sourceUrl = "https://portfolio.example/ganesh";
  let providerRequests = 0;
  let duckDuckGoRequests = 0;
  let githubRequests = 0;
  let sourceRequests = 0;
  const live = createLiveDependencies(input, {
    apiKey: "test-key",
    model: "test/model",
    resolveHostname: async (hostname) => (hostname === "html.duckduckgo.com" ? ["52.149.246.39"] : ["93.184.216.34"]),
    fetch: async (request) => {
      const url = new URL(String(request));
      if (url.hostname === "openrouter.ai") {
        providerRequests += 1;
        return jsonResponse(
          { error: { message: "provider quota exhausted" } },
          {
            status: 429,
            headers: { "retry-after": "0" },
          },
        );
      }
      if (url.hostname === "html.duckduckgo.com") {
        duckDuckGoRequests += 1;
        return new Response(
          `<a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(sourceUrl)}&amp;rut=opaque">Ganesh Talluri — Portfolio</a>`,
          { headers: { "content-type": "text/html" } },
        );
      }
      if (url.hostname === "api.github.com") {
        githubRequests += 1;
        return jsonResponse({ total_count: 0, incomplete_results: false, items: [] });
      }
      if (url.href === sourceUrl) {
        sourceRequests += 1;
        return new Response("<title>Ganesh Talluri — Portfolio</title><p>Ganesh Talluri</p>", {
          headers: { "content-type": "text/html" },
        });
      }
      throw new Error(`Unexpected request ${url.href}`);
    },
  });
  const updates = [];
  for await (const update of agent.runResearch(
    input,
    {
      clock: domain.createSequenceClock("2026-08-20T18:45:00.000Z", 1),
      ids: domain.createDeterministicIdFactory("duckduckgo-usage"),
      planner: async ({ state, selectedFrontierEntries }) => {
        const hasDirect = state.evidence.some((evidence) => evidence.verificationMethod === "direct_fetch");
        if (hasDirect) {
          return {
            kind: "stop",
            decisionSummary: "Retain the quarantined exact fetched-name quote.",
            actions: [],
          };
        }
        const lead = state.evidence.find(
          (evidence) =>
            evidence.verificationMethod === "search_discovery" && typeof evidence.attributes.leadId === "string",
        );
        return {
          kind: "actions",
          decisionSummary: lead ? "Inspect the exact lead." : "Discover a public source.",
          actions: selectedFrontierEntries.map((entry) => ({
            frontierEntryId: entry.id,
            tool: lead ? "fetch_public_source" : "search_web",
            purpose: lead ? "Inspect the exact discovery lead." : "Find a public professional source.",
            arguments: lead
              ? { leadId: lead.attributes.leadId, claimFocus: "Public professional identity" }
              : { query: "Ganesh Talluri public professional profile" },
            ...(entry.candidateId ? { candidateId: entry.candidateId } : {}),
          })),
        };
      },
      executeAction: live.executeAction,
      synthesize: async () => ({
        decisionSummary: "Name-only evidence remains quarantined pending corroboration.",
        openQuestions: ["Which independent source binds this page to the intended person?"],
        findings: [],
      }),
    },
    { availableTools: ["search_web", "fetch_public_source"] },
  ))
    updates.push(update);

  const completed = updates.at(-1);
  assert.equal(completed.type, "completed");
  assert.ok(
    completed.report.evidence.some(
      (evidence) =>
        evidence.verificationMethod === "direct_fetch" &&
        evidence.attributes.extractionMethod === "deterministic_public_html_named_person_quote",
    ),
  );
  assert.equal(completed.report.usage.searchCalls, 1);
  assert.equal(duckDuckGoRequests, 1);
  assert.equal(sourceRequests, 1);
  assert.equal(
    completed.report.usage.networkRequests,
    providerRequests + duckDuckGoRequests + githubRequests + sourceRequests,
  );
  assert.deepEqual(completed.report.findings, [], "successful empty synthesis must remain an intentional abstention");
  assert.ok(
    !completed.trace.events.some((event) =>
      event.payload?.diagnostics?.some((item) => item.code === "deterministic_finding_fallback_used"),
    ),
  );
  const fallbackSpan = completed.trace.events.find(
    (event) =>
      event.kind === "span_end" &&
      event.name === "tool.search_web" &&
      event.payload.diagnostics?.some((item) => item.code === "public_web_fallback_used"),
  );
  assert.ok(fallbackSpan);
  assert.equal(fallbackSpan.usage.searchCalls, 1);
  assert.equal(fallbackSpan.usage.networkRequests, providerRequests + duckDuckGoRequests + githubRequests);
});

test("planner repairs charge every provider request, token class, and cached input token", async () => {
  let calls = 0;
  const events = await liveEvents(async () => {
    calls += 1;
    const argumentsValue =
      calls % 2 === 1
        ? JSON.stringify({})
        : JSON.stringify({
            kind: "stop",
            decisionSummary: "No additional bounded action.",
            nextPhase: null,
            actions: [],
          });
    return completion(calls, argumentsValue);
  });
  const terminal = events.findLast((event) => event.name === "result.terminal");
  assert.equal(calls, 4);
  assert.equal(terminal.payload.report.usage.llmCalls, 4);
  assert.equal(terminal.payload.report.usage.networkRequests, 4);
  assert.equal(terminal.payload.report.usage.inputTokens, 4);
  assert.equal(terminal.payload.report.usage.cachedInputTokens, 4);
  assert.equal(terminal.payload.report.usage.outputTokens, 4);
  assert.equal(terminal.payload.report.usage.thinkingTokens, 4);
  assert.equal(terminal.payload.report.usage.costUsd, 0.004);
  assert.equal(terminal.usage.cachedInputTokens, 4);
  const plannerSpans = events.filter((event) => event.kind === "span_end" && event.name === "planner.decision");
  assert.deepEqual(
    plannerSpans.map((event) => event.usage.llmCalls),
    [2, 2],
  );
  assert.deepEqual(
    plannerSpans.map((event) => event.usage.networkRequests),
    [2, 2],
  );
});

test("concurrent model actions cannot reserve beyond the shared LLM budget", async () => {
  const clock = domain.createSequenceClock();
  const ids = domain.createDeterministicIdFactory("model-budget");
  let actionReservations = 0;
  const updates = [];
  for await (const update of agent.runResearch(
    { schemaVersion: domain.SCHEMA_VERSION, query: "Grace Hopper, US Navy", requestedDepth: "quick" },
    {
      clock,
      ids,
      planner: async (context) => {
        assert.equal(context.modelAccounting.reserve(), true);
        context.modelAccounting.settle({
          networkRequests: 1,
          tokenUsage: { inputTokens: 1, cachedInputTokens: 1, outputTokens: 1, thinkingTokens: 1, costUsd: 0 },
          reportedUsageFields: TOKEN_FIELDS,
        });
        return {
          kind: "actions",
          decisionSummary: "Attempt a bounded concurrent batch.",
          actions: context.selectedFrontierEntries.map((entry, index) => ({
            frontierEntryId: entry.id,
            tool: entry.allowedTools[0],
            purpose: `Probe ${index + 1}`,
            arguments: { index },
            budgetClass: "compute",
          })),
        };
      },
      executeAction: async (_action, context) => {
        if (!context.modelAccounting.reserve()) {
          return { status: "skipped", meta: { requests: 0 } };
        }
        actionReservations += 1;
        await new Promise((resolve) => queueMicrotask(resolve));
        context.modelAccounting.settle({
          networkRequests: 1,
          tokenUsage: { inputTokens: 1, cachedInputTokens: 1, outputTokens: 1, thinkingTokens: 1, costUsd: 0 },
          reportedUsageFields: TOKEN_FIELDS,
        });
        return { status: "not_found", meta: { requests: 0 } };
      },
    },
    {
      availableTools: ["model_probe_1", "model_probe_2", "model_probe_3", "model_probe_4"],
      budget: { maxLlmCalls: 3, maxActionsPerTurn: 4 },
    },
  ))
    updates.push(update);
  const report = updates.at(-1).report;
  assert.equal(actionReservations, 2);
  assert.equal(report.usage.llmCalls, 3);
  assert.equal(report.usage.networkRequests, 3);
  assert.equal(report.usage.inputTokens, 3);
  assert.equal(report.usage.cachedInputTokens, 3);
  assert.equal(report.stop.reason, "budget_exhausted");
});

test("missing provider usage remains null in the terminal aggregate", async () => {
  let calls = 0;
  const events = await liveEvents(async () => {
    calls += 1;
    return completion(
      calls,
      JSON.stringify({
        kind: "stop",
        decisionSummary: "No additional bounded action.",
        nextPhase: null,
        actions: [],
      }),
      null,
    );
  });
  const terminal = events.findLast((event) => event.name === "result.terminal");
  assert.ok(calls > 0);
  assert.equal(terminal.usage.inputTokens, null);
  assert.equal(terminal.usage.cachedInputTokens, null);
  assert.equal(terminal.usage.outputTokens, null);
  assert.equal(terminal.usage.thinkingTokens, null);
  assert.equal(terminal.usage.costUsd, null);
  assert.match(terminal.usage.unavailableReason, /provider_usage_counters_unavailable/);
});

test("an abort during an in-flight planner request terminates as canceled", async () => {
  const controller = new AbortController();
  const blockedFetch = (_request, init = {}) =>
    new Promise((_resolve, reject) => {
      const rejectAbort = () => reject(new DOMException("Aborted", "AbortError"));
      if (init.signal?.aborted) rejectAbort();
      else init.signal?.addEventListener("abort", rejectAbort, { once: true });
    });
  setTimeout(() => controller.abort("test cancellation"), 20);
  const events = await liveEvents(blockedFetch, controller.signal);
  const terminals = events.filter((event) => event.name === "result.terminal");
  assert.equal(terminals.length, 1);
  assert.equal(terminals[0].payload.report.status, "canceled");
  assert.equal(terminals[0].payload.report.stop.reason, "cancelled");
  const plannerEnds = events.filter((event) => event.kind === "span_end" && event.name === "planner.decision");
  assert.equal(plannerEnds.length, 1);
  assert.equal(plannerEnds[0].status, "canceled");
});

test("a provider failure after discovery preserves a legal partial graph instead of becoming fatal", async () => {
  let plannerCalls = 0;
  const updates = [];
  for await (const update of agent.runResearch(
    {
      schemaVersion: domain.SCHEMA_VERSION,
      query: "Ganesh Talluri",
      requestedDepth: "standard",
    },
    {
      clock: domain.createSequenceClock("2026-08-20T18:00:00.000Z", 2),
      ids: domain.createDeterministicIdFactory("provider-partial"),
      planner: async ({ selectedFrontierEntries }) => {
        plannerCalls += 1;
        if (plannerCalls > 1) throw new Error("provider rate limited the follow-up planner request");
        return {
          kind: "actions",
          decisionSummary: "Discover one provider-attested public lead.",
          actions: [
            {
              frontierEntryId: selectedFrontierEntries[0].id,
              tool: "search_web",
              purpose: "Find a public professional source.",
              arguments: { query: "Ganesh Talluri public professional profile" },
            },
          ],
        };
      },
      executeAction: async () => ({
        status: "succeeded",
        candidates: [
          {
            ref: "search-subject",
            displayName: "Ganesh Talluri",
            signals: [
              {
                kind: "name",
                value: "Ganesh Talluri",
                normalizedValue: "ganesh talluri",
                strength: "weak",
                assurance: "self_asserted",
              },
            ],
          },
        ],
        evidence: [
          {
            candidateRef: "search-subject",
            claim: "Web search surfaced a possible LinkedIn profile; it is a discovery lead only.",
            disposition: "discovery_only",
            sourceUrl: "https://www.linkedin.com/in/ganesh-talluri",
            sourceType: "search_result",
            title: "Public source at linkedin.com",
            excerpt:
              "Provider search surfaced this URL as a discovery lead; its contents have not been fetched or quoted.",
            verificationMethod: "search_discovery",
            temporalStatus: "unknown",
            reliability: 0,
            spoofable: true,
            attributes: { leadId: "lead_provider_partial" },
          },
        ],
        meta: { requests: 0 },
      }),
    },
    { availableTools: ["search_web", "fetch_public_source"] },
  ))
    updates.push(update);

  const completed = updates.at(-1);
  assert.equal(completed.type, "completed");
  assert.equal(completed.report.status, "partial");
  assert.notEqual(completed.report.stop.reason, "fatal_error");
  assert.equal(completed.report.evidence.length, 1);
  assert.ok(completed.report.searchGraph.nodes.length > 0);
  assert.deepEqual(completed.report.searchGraph.selectedFrontierEntryIds, []);
  assert.ok(
    completed.trace.events.some(
      (event) =>
        event.name === "frontier.exhausted" && event.payload.reason === "upstream_failure_after_partial_results",
    ),
  );
});

test("non-tool network accounting never increments tool calls", () => {
  const ledger = new domain.BudgetLedger(domain.resolveBudgetLimits("quick"), 0);
  ledger.recordNetworkRequests(2, 1);
  const usage = ledger.snapshot(2);
  assert.equal(usage.networkRequests, 2);
  assert.equal(usage.toolCalls, 0);
});

test("exact live name streams graph snapshots, classifies fetch lanes, and preserves its partial report", async () => {
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: "Ganesh Talluri",
    requestedDepth: "standard",
  });
  const githubUrl = "https://github.com/g4nesh";
  let providerCalls = 0;
  let extractionProviderCalls = 0;
  let githubApiCalls = 0;
  let duckDuckGoCalls = 0;
  let pageFetchCalls = 0;
  const fetch = async (request, init = {}) => {
    const url = new URL(String(request));
    if (url.hostname === "html.duckduckgo.com") {
      duckDuckGoCalls += 1;
      return new Response("<html><body>No safe results observed.</body></html>", {
        headers: { "content-type": "text/html" },
      });
    }
    if (url.hostname === "api.github.com") {
      githubApiCalls += 1;
      if (url.pathname === "/search/users") {
        assert.equal(url.searchParams.get("q"), "Ganesh Talluri in:fullname");
        assert.equal(url.searchParams.get("per_page"), "3");
        return jsonResponse({
          total_count: 2,
          incomplete_results: false,
          items: [
            { login: "g4nesh", type: "User", url: "https://api.github.com/users/g4nesh" },
            { login: "not-ganesh", type: "User", url: "https://api.github.com/users/not-ganesh" },
          ],
        });
      }
      if (url.pathname === "/users/g4nesh")
        return jsonResponse({
          login: "g4nesh",
          name: "Ganesh Talluri",
          type: "User",
          html_url: githubUrl,
        });
      if (url.pathname === "/users/not-ganesh")
        return jsonResponse({
          login: "not-ganesh",
          name: "Another Person",
          type: "User",
          html_url: "https://github.com/not-ganesh",
        });
      throw new Error(`Unexpected GitHub API request ${url.href}`);
    }
    if (url.hostname === "github.com") {
      pageFetchCalls += 1;
      assert.equal(url.href, githubUrl);
      return new Response(
        '<html lang="en"><title>g4nesh (Ganesh Talluri) · GitHub</title><meta name="generator" content="Next.js"><script src="https://cdn.jsdelivr.net/npm/example.js"></script><p>Ganesh Talluri builds public machine learning projects at LuxenAI.</p></html>',
        { headers: { "content-type": "text/html" } },
      );
    }
    assert.equal(url.hostname, "generativelanguage.googleapis.com");

    providerCalls += 1;
    const body = JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body));
    if (url.pathname === "/v1beta/interactions") {
      assert.ok(body.tools?.some((tool) => tool.type === "google_search"));
      return jsonResponse(
        { error: { message: "RESOURCE_EXHAUSTED" } },
        {
          status: 429,
          headers: { "retry-after": "0" },
        },
      );
    }
    assert.equal(url.pathname, "/v1beta/openai/chat/completions");
    if (body.tools?.some((tool) => tool.function?.name === "submit_evidence_extraction")) {
      extractionProviderCalls += 1;
      throw new Error("GitHub fallback must not call model extraction");
    }
    if (body.tools?.some((tool) => tool.function?.name === "submit_findings")) {
      return jsonResponse({
        id: `findings-${providerCalls}`,
        model: "test/model",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call-findings-ganesh",
                  type: "function",
                  function: {
                    name: "submit_findings",
                    arguments: JSON.stringify({
                      decisionSummary: "Keep the fetched page quarantined pending independent identity corroboration.",
                      openQuestions: [
                        "Which independently verified source binds this profile to the requested person?",
                      ],
                      findings: [],
                    }),
                  },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 2,
          completion_tokens: 2,
          reasoning_tokens: 1,
          prompt_tokens_details: { cached_tokens: 1 },
          cost: 0.001,
        },
      });
    }

    const plannerMessage = [...body.messages]
      .reverse()
      .find(
        (message) =>
          message.role === "user" &&
          typeof message.content === "string" &&
          message.content.startsWith("Choose the next legal decision"),
      );
    assert.ok(plannerMessage);
    const plannerState = JSON.parse(plannerMessage.content.split("\n").slice(1).join("\n"));
    const selected = plannerState.selectedFrontier;
    const leadId = plannerState.state.evidence.find((evidence) => evidence.leadId)?.leadId;
    const hasFetchedEvidence = plannerState.state.evidence.some(
      (evidence) => evidence.disposition !== "discovery_only",
    );
    const decision = hasFetchedEvidence
      ? {
          kind: "stop",
          decisionSummary: "Preserve the valid partial graph while awaiting independent corroboration.",
          nextPhase: null,
          actions: [],
        }
      : {
          kind: "actions",
          decisionSummary: leadId
            ? "Inspect the provider-attested lead only in its selected deterministic lane."
            : "Discover provider-attested public sources first.",
          nextPhase: null,
          actions: selected.map((entry) => ({
            frontierEntryId: entry.frontierEntryId,
            tool: leadId ? "fetch_public_source" : "search_web",
            purpose: leadId ? "Inspect the exact discovery lead." : "Find public professional sources.",
            arguments: leadId
              ? { leadId, claimFocus: "Public professional identity and organization" }
              : { query: "Ganesh Talluri public professional profile" },
            ...(entry.candidateId ? { candidateId: entry.candidateId } : {}),
          })),
        };
    return completion(providerCalls, JSON.stringify(decision));
  };

  const events = [];
  for await (const event of streamLiveResearch(input, {
    apiKey: "test-key",
    model: "test/model",
    provider: "gemini",
    fetch,
    resolveHostname: async () => ["108.174.10.10"],
  }))
    events.push(event);

  assert.deepEqual(
    events.map((event) => event.seq),
    events.map((_, index) => index + 1),
  );
  assert.equal(
    events.every((event) => agent.isTraceEvent(event, { allowedEmails: new Set() })),
    true,
  );
  const preterminalGraphs = events
    .slice(0, -1)
    .map((event) => event.payload?.searchGraph)
    .filter((graph) => graph?.schemaVersion === 2);
  assert.ok(preterminalGraphs.some((graph) => graph.nodes.length > 0));
  assert.equal(
    JSON.stringify(events).includes("lead_lane_mismatch"),
    false,
    "lead-specific fetch frontiers must not spend turns on incompatible source lanes",
  );
  assert.ok(JSON.stringify(events).includes("search_provider_quota_exhausted"));
  assert.ok(JSON.stringify(events).includes("deterministic_github_extraction"));
  assert.equal(duckDuckGoCalls, 1, "keyless public search runs before the exact-name GitHub fallback");
  assert.equal(githubApiCalls, 3, "one bounded official search and two returned user details are checked");
  assert.equal(pageFetchCalls, 1, "T1 GitHub leads must be rejected before network; only T2 may fetch the HTML page");
  assert.equal(extractionProviderCalls, 0, "exact API-attested GitHub profiles require no model extraction call");
  assert.ok(providerCalls >= 3, "planner, retryable search failure, and terminal planning remain provider-accounted");

  const terminal = events.at(-1);
  assert.equal(terminal.name, "result.terminal");
  assert.notEqual(terminal.payload.report.stop.reason, "fatal_error");
  assert.ok(terminal.payload.report.searchGraph.nodes.length > 0);
  const discovery = terminal.payload.report.evidence.find(
    (evidence) => evidence.verificationMethod === "search_discovery",
  );
  assert.ok(discovery);
  assert.equal(discovery.title, "Ganesh Talluri (@g4nesh) — GitHub");
  assert.equal(discovery.excerpt, null, "provider discovery metadata is not a source quote");
  assert.equal(discovery.attributes.provider, "github:public_user_search");
  assert.equal(discovery.attributes.upstreamProvider, null);
  assert.equal(discovery.attributes.classifiedSourceType, "code_profile");
  assert.equal(discovery.attributes.classifiedSourceTier, 2);
  assert.equal(discovery.attributes.classifiedSourceLaneId, "t2.structured_professional");
  assert.doesNotMatch(
    discovery.claim,
    /web search/i,
    "GitHub API fallback provenance must not be described as web search",
  );
  assert.ok(discovery.contentHash.startsWith("fnv1a32:"));
  assert.notEqual(
    terminal.payload.report.searchGraph.frontier.find((entry) => entry.actionId === discovery.toolCallId)?.status,
    "verified",
    "discovery metadata alone must not verify a source-ladder step",
  );

  const direct = terminal.payload.report.evidence.find((evidence) => evidence.verificationMethod === "direct_fetch");
  assert.ok(direct, "a safely fetched name-only page must survive on an isolated candidate branch");
  assert.equal(direct.title, "g4nesh (Ganesh Talluri) · GitHub");
  assert.equal(direct.sourceUrl, githubUrl);
  assert.equal(direct.excerpt, "g4nesh (Ganesh Talluri) · GitHub");
  assert.equal(direct.claim, direct.excerpt);
  assert.equal(direct.attributes.extractionMethod, "deterministic_github_profile_quote");
  assert.equal(direct.canonicalSubset.pageFootprint.schemaVersion, "public_page_footprint_v1");
  assert.deepEqual(direct.canonicalSubset.pageFootprint.declaredApplications.generators, ["Next.js"]);
  assert.deepEqual(direct.canonicalSubset.pageFootprint.observedProviderFamilies, ["jsdelivr"]);
  assert.equal(direct.canonicalSubset.pageFootprint.spoofable, true);
  assert.match(direct.canonicalSubset.pageFootprintHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(direct.attributes.extractedOrganization, null);
  assert.equal(direct.attributes.extractedOrganizationLabel, null);
  assert.equal(direct.attributes.quarantinedFromCandidateId, discovery.candidateId);
  const matchingCandidates = terminal.payload.report.candidates.filter(
    (candidate) => candidate.normalizedName === "ganesh talluri",
  );
  assert.equal(matchingCandidates.length, 2, "the fetched subject must remain separate from the name-only seed");
  assert.notEqual(direct.candidateId, discovery.candidateId);
  const directCandidate = matchingCandidates.find((candidate) => candidate.id === direct.candidateId);
  assert.ok(
    directCandidate.signals.some(
      (signal) =>
        signal.kind === "social_handle" &&
        signal.normalizedValue === "g4nesh" &&
        signal.sourceFamily === "github.com" &&
        signal.sourceEvidenceId === direct.id,
    ),
    "the canonical GitHub profile must derive its exact evidence-grounded public handle",
  );
  assert.equal(
    terminal.payload.report.searchGraph.frontier.some(
      (entry) => entry.candidateId === directCandidate.id && entry.allowedTools.includes("keybase_identity_proofs"),
    ),
    false,
    "a quarantined candidate branch must never expand into a Keybase specialist",
  );
  const candidateNodeById = new Map(
    terminal.payload.report.searchGraph.nodes
      .filter((node) => node.kind === "candidate")
      .map((node) => [node.candidateId, node.id]),
  );
  assert.ok(
    terminal.payload.report.searchGraph.edges.some(
      (edge) =>
        edge.kind === "separates" &&
        new Set([edge.fromNodeId, edge.toNodeId]).has(candidateNodeById.get(discovery.candidateId)) &&
        new Set([edge.fromNodeId, edge.toNodeId]).has(candidateNodeById.get(direct.candidateId)),
    ),
  );
  assert.ok(
    terminal.payload.report.searchGraph.nodes
      .filter((node) => node.evidenceId === discovery.id)
      .every((node) => node.status !== "verified"),
  );
  const metadataObservation = terminal.payload.report.evidence.find(
    (evidence) => evidence.attributes.metadataObservation === true,
  );
  assert.ok(
    metadataObservation,
    "a candidate-binding quarantine must not discard the independently observed page footprint",
  );
  assert.equal(metadataObservation.candidateId, discovery.candidateId);
  assert.equal(metadataObservation.disposition, "discovery_only");
  assert.equal(metadataObservation.verificationMethod, "unverified");
  assert.equal(metadataObservation.canonicalSubset.pageFootprint.schemaVersion, "public_page_footprint_v1");
  assert.ok(JSON.stringify(events).includes("candidate_binding_strong_binding_missing"));
});

test("mechanical planning fetches every exact same-name lead after earlier direct evidence", async () => {
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: "Alex Kim",
    requestedDepth: "deep",
  });
  const leads = [
    { leadId: "lead_alex_one", sourceUrl: "https://github.com/alex-one", excerpt: "Alex Kim — One Labs" },
    { leadId: "lead_alex_two", sourceUrl: "https://github.com/alex-two", excerpt: "Alex Kim — Two Labs" },
    { leadId: "lead_alex_three", sourceUrl: "https://github.com/alex-three", excerpt: "Alex Kim — Three Labs" },
  ];
  const leadById = new Map(leads.map((lead) => [lead.leadId, lead]));
  let plannerProviderCalls = 0;
  let plannerCallsAfterDirectEvidence = 0;
  const live = createLiveDependencies(input, {
    apiKey: "test-key",
    model: "test/model",
    clock: domain.createSequenceClock("2026-08-20T22:30:00.000Z", 1),
    ids: domain.createDeterministicIdFactory("sequential-same-name-leads"),
    fetch: async (request, init = {}) => {
      const url = new URL(String(request));
      assert.equal(url.hostname, "openrouter.ai");
      const body = JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body));
      const plannerMessage = [...body.messages]
        .reverse()
        .find(
          (message) =>
            message.role === "user" &&
            typeof message.content === "string" &&
            message.content.startsWith("Choose the next legal decision"),
        );
      assert.ok(plannerMessage);
      const plannerState = JSON.parse(plannerMessage.content.split("\n").slice(1).join("\n"));
      const selected = plannerState.selectedFrontier[0];
      assert.ok(selected);
      plannerProviderCalls += 1;
      if (
        selected.leadId &&
        plannerState.state.evidence.some((evidence) => evidence.disposition !== "discovery_only")
      ) {
        plannerCallsAfterDirectEvidence += 1;
        return completion(
          plannerProviderCalls,
          JSON.stringify({
            kind: "stop",
            decisionSummary: "Stop if policy routing incorrectly asks the model after the first direct record.",
            nextPhase: null,
            actions: [],
          }),
        );
      }
      return completion(
        plannerProviderCalls,
        JSON.stringify({
          kind: "actions",
          decisionSummary: `Execute the selected ${selected.allowedTools[0]} frontier.`,
          nextPhase: null,
          actions: [
            {
              frontierEntryId: selected.frontierEntryId,
              tool: selected.allowedTools[0],
              purpose: "Exercise the selected deterministic frontier.",
              arguments: selected.allowedTools[0] === "search_web" ? { query: selected.queryHint } : {},
              ...(selected.candidateId ? { candidateId: selected.candidateId } : {}),
            },
          ],
        }),
      );
    },
  });
  let discoveryCalls = 0;
  const exactFetchActions = [];
  const updates = [];
  for await (const update of agent.runResearch(
    input,
    {
      ...live,
      executeAction: async (action) => {
        if (action.tool === "search_web" && discoveryCalls === 0) {
          discoveryCalls += 1;
          return {
            status: "succeeded",
            candidates: leads.map((lead, index) => ({
              ref: `alex-${index + 1}`,
              displayName: "Alex Kim",
              signals: [
                {
                  kind: "name",
                  value: "Alex Kim",
                  normalizedValue: "alex kim",
                  strength: "weak",
                  assurance: "self_asserted",
                  sourceFamily: new URL(lead.sourceUrl).hostname,
                },
              ],
            })),
            evidence: leads.map((lead, index) => ({
              candidateRef: `alex-${index + 1}`,
              claim: `Search surfaced exact public lead ${index + 1}.`,
              disposition: "discovery_only",
              sourceUrl: lead.sourceUrl,
              sourceType: "search_result",
              canonicalSubset: { providerAttestedUrl: true },
              verificationMethod: "search_discovery",
              temporalStatus: "unknown",
              reliability: 0,
              spoofable: true,
              attributes: {
                leadId: lead.leadId,
                classifiedSourceLaneId: "t2.structured_professional",
                classifiedSourceTier: 2,
                classifiedSourceType: "code_profile",
              },
            })),
            meta: { requests: 1 },
          };
        }
        if (action.tool === "fetch_public_source" && typeof action.arguments.leadId === "string") {
          const lead = leadById.get(action.arguments.leadId);
          assert.ok(lead, `unknown exact lead ${action.arguments.leadId}`);
          assert.ok(action.candidateId);
          exactFetchActions.push({
            frontierEntryId: action.frontierEntryId,
            candidateId: action.candidateId,
            leadId: action.arguments.leadId,
          });
          return {
            status: "succeeded",
            evidence: [
              {
                candidateId: action.candidateId,
                claim: lead.excerpt,
                excerpt: lead.excerpt,
                sourceUrl: lead.sourceUrl,
                sourceType: "code_profile",
                verificationMethod: "direct_fetch",
                temporalStatus: "current",
                reliability: 0.7,
                spoofable: true,
              },
            ],
            meta: { requests: 1 },
          };
        }
        return { status: "not_found", meta: { requests: 0 } };
      },
      // This regression isolates deterministic lead routing; synthesis would
      // spend model budget without affecting the three fetch dependencies.
      synthesize: undefined,
    },
    {
      availableTools: ["search_web", "fetch_public_source"],
      // One action per turn makes the ordering observable. Leave enough
      // explicit test-only turns for full canonical Deep breadth plus all
      // three exact lead dependencies; production Deep presets are unchanged.
      budget: { maxActionsPerTurn: 1, maxTurns: 20 },
    },
  ))
    updates.push(update);

  const completed = updates.at(-1);
  assert.equal(completed.type, "completed");
  assert.equal(discoveryCalls, 1);
  assert.equal(
    plannerProviderCalls,
    0,
    "canonical discovery and exact opaque lead routing must not spend model planner calls",
  );
  assert.equal(
    plannerCallsAfterDirectEvidence,
    0,
    "later exact lead pivots must remain mechanical after direct evidence",
  );
  assert.deepEqual(
    new Set(exactFetchActions.map((action) => action.leadId)),
    new Set(leads.map((lead) => lead.leadId)),
    JSON.stringify({
      stop: completed.report.stop,
      usage: completed.report.usage,
      evidence: completed.report.evidence,
      frontier: completed.report.searchGraph.frontier,
      admissions: completed.trace.events.filter(
        (event) => event.name === "evidence.admission" || event.name.startsWith("frontier."),
      ),
    }),
  );
  assert.equal(new Set(exactFetchActions.map((action) => action.frontierEntryId)).size, 3);
  assert.equal(new Set(exactFetchActions.map((action) => action.candidateId)).size, 3);
  assert.equal(
    completed.report.evidence.filter((evidence) => evidence.verificationMethod === "direct_fetch").length,
    3,
  );
  assert.equal(completed.report.candidates.filter((candidate) => candidate.normalizedName === "alex kim").length, 3);
  const exactFetchSpanIds = new Set(
    completed.trace.events
      .filter(
        (event) =>
          event.kind === "span_start" &&
          event.name === "tool.fetch_public_source" &&
          typeof event.payload.arguments?.leadId === "string",
      )
      .map((event) => event.spanId),
  );
  const exactFetchSpans = completed.trace.events.filter(
    (event) =>
      event.kind === "span_end" && event.name === "tool.fetch_public_source" && exactFetchSpanIds.has(event.spanId),
  );
  assert.equal(exactFetchSpans.length, 3);
  assert.ok(exactFetchSpans.every((event) => event.usage.networkRequests === 1));
  assert.equal(JSON.stringify(exactFetchSpans).includes("lead_lane_mismatch"), false);
  assert.deepEqual(search.validateSearchGraph(completed.report.searchGraph), []);
  assert.deepEqual(domain.validateReferentialIntegrity(completed.state), []);
});

test("repeated T1 and T2 profile leads reuse only the evidence-backed isolated candidate", async () => {
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: "Chinmay Bhat",
    requestedDepth: "deep",
  });
  const repeatedUrl = "https://github.com/chinmay-bhat";
  const repeatedVariant = "https://GitHub.com/chinmay-bhat/?utm_source=atlas#profile";
  const distinctUrl = "https://github.com/chinmay-bhat-distinct";
  const ungroundedUrl = "https://github.com/chinmay-bhat-ungrounded";
  const ungroundedVariant = "https://github.com/chinmay-bhat-ungrounded/?utm_source=atlas";
  const ambiguousUrl = "https://github.com/chinmay-bhat-ambiguous";
  const ambiguousVariant = "https://github.com/chinmay-bhat-ambiguous/#repeat";
  const unrelatedUrl = "https://github.com/unrelated-cross-url";
  const leads = new Map([
    ["lead_chinmay_t1_exact", { sourceUrl: repeatedUrl, excerpt: "Chinmay Bhat · GitHub", candidateRef: "chinmay-t1" }],
    [
      "lead_chinmay_t1_ungrounded",
      {
        sourceUrl: ungroundedUrl,
        excerpt: "Chinmay Bhat · Ungrounded GitHub",
        candidateRef: "chinmay-t1-ungrounded",
        groundProfile: false,
      },
    ],
    [
      "lead_chinmay_t1_ambiguous",
      {
        sourceUrl: ambiguousUrl,
        excerpt: "Chinmay Bhat · Ambiguous GitHub",
        candidateRef: "chinmay-t1-ambiguous",
        branchCount: 2,
      },
    ],
    [
      "lead_chinmay_t2_repeat",
      {
        sourceUrl: repeatedVariant,
        excerpt: "Chinmay Bhat · GitHub",
        candidateRef: "chinmay-t2-repeat",
        addCrossUrlEvidence: true,
      },
    ],
    [
      "lead_chinmay_t2_distinct",
      { sourceUrl: distinctUrl, excerpt: "Chinmay Bhat · Distinct GitHub", candidateRef: "chinmay-t2-distinct" },
    ],
    [
      "lead_chinmay_t2_ungrounded_repeat",
      {
        sourceUrl: ungroundedVariant,
        excerpt: "Chinmay Bhat · Ungrounded GitHub",
        candidateRef: "chinmay-t2-ungrounded-repeat",
      },
    ],
    [
      "lead_chinmay_t2_ambiguous_repeat",
      {
        sourceUrl: ambiguousVariant,
        excerpt: "Chinmay Bhat · Ambiguous GitHub",
        candidateRef: "chinmay-t2-ambiguous-repeat",
      },
    ],
  ]);
  let exactSearchCalls = 0;
  let githubSiteSearchCalls = 0;
  const fetchCalls = [];
  const dependencies = {
    clock: domain.createSequenceClock("2026-08-21T02:00:00.000Z", 1),
    ids: domain.createDeterministicIdFactory("chinmay-repeat-profile"),
    planner: async ({ selectedFrontierEntries }) => ({
      kind: "actions",
      decisionSummary: "Execute every selected deterministic frontier entry.",
      actions: selectedFrontierEntries.map((entry) => ({
        frontierEntryId: entry.id,
        tool: entry.allowedTools[0],
        purpose: "Exercise exact hierarchy and candidate-bound lead admission.",
        arguments: entry.allowedTools[0] === "search_web" ? { query: entry.queryHint } : {},
        ...(entry.candidateId ? { candidateId: entry.candidateId } : {}),
      })),
    }),
    executeAction: async (action) => {
      if (action.tool === "search_web") {
        const isExactT1 = action.sourceLaneId === "t1.first_party" && action.arguments.query === '"Chinmay Bhat"';
        const isGithubT2 =
          action.sourceLaneId === "t2.structured_professional" &&
          String(action.arguments.query).includes("site:github.com");
        if (!isExactT1 && !isGithubT2) return { status: "not_found", meta: { requests: 0 } };

        if (isExactT1) exactSearchCalls += 1;
        if (isGithubT2) githubSiteSearchCalls += 1;
        const surfacedLeadIds = isExactT1
          ? ["lead_chinmay_t1_exact", "lead_chinmay_t1_ungrounded", "lead_chinmay_t1_ambiguous"]
          : [
              "lead_chinmay_t2_repeat",
              "lead_chinmay_t2_distinct",
              "lead_chinmay_t2_ungrounded_repeat",
              "lead_chinmay_t2_ambiguous_repeat",
            ];
        return {
          status: "succeeded",
          candidates: surfacedLeadIds.map((leadId) => {
            const lead = leads.get(leadId);
            assert.ok(lead);
            return {
              ref: `search:${leadId}`,
              displayName: "Chinmay Bhat",
              signals: [
                {
                  kind: "name",
                  value: "Chinmay Bhat",
                  normalizedValue: "chinmay bhat",
                  strength: "weak",
                  assurance: "self_asserted",
                  sourceFamily: "github.com",
                },
              ],
            };
          }),
          evidence: surfacedLeadIds.map((leadId) => {
            const lead = leads.get(leadId);
            assert.ok(lead);
            return {
              candidateRef: `search:${leadId}`,
              claim: `Search surfaced ${leadId}.`,
              disposition: "discovery_only",
              sourceUrl: lead.sourceUrl,
              sourceType: "search_result",
              canonicalSubset: { providerAttestedUrl: true },
              verificationMethod: "search_discovery",
              temporalStatus: "unknown",
              reliability: 0,
              spoofable: true,
              attributes: {
                leadId,
                classifiedSourceLaneId: "t2.structured_professional",
                classifiedSourceTier: 2,
                classifiedSourceType: "code_profile",
              },
            };
          }),
          meta: { requests: 1 },
        };
      }

      if (action.tool === "fetch_public_source" && typeof action.arguments.leadId === "string") {
        const lead = leads.get(action.arguments.leadId);
        assert.ok(lead, `unknown Chinmay lead ${String(action.arguments.leadId)}`);
        assert.ok(action.candidateId);
        fetchCalls.push(action.arguments.leadId);
        const candidateRefs = Array.from(
          { length: lead.branchCount ?? 1 },
          (_, index) => `${lead.candidateRef}${lead.branchCount ? `-${index + 1}` : ""}`,
        );
        return {
          status: "partial",
          candidateBranches: candidateRefs.map((candidateRef) => ({
            parentCandidateId: action.candidateId,
            reason: "fetched_subject_unverified",
            candidate: {
              ref: candidateRef,
              displayName: "Chinmay Bhat",
              signals: [
                {
                  kind: "name",
                  value: "Chinmay Bhat",
                  normalizedValue: "chinmay bhat",
                  strength: "strong",
                  assurance: "spoofable",
                  sourceFamily: "github.com",
                },
                ...(lead.groundProfile === false
                  ? []
                  : [
                      {
                        kind: "profile_url",
                        value: lead.sourceUrl,
                        normalizedValue: lead.sourceUrl,
                        strength: "strong",
                        assurance: "spoofable",
                        sourceFamily: "github.com",
                      },
                    ]),
              ],
            },
          })),
          evidence: [
            ...candidateRefs.map((candidateRef) => ({
              candidateRef,
              claim: lead.excerpt,
              excerpt: lead.excerpt,
              sourceUrl: lead.sourceUrl,
              sourceType: "code_profile",
              verificationMethod: "direct_fetch",
              disposition: "supports",
              temporalStatus: "current",
              reliability: 0.7,
              spoofable: true,
            })),
            ...(lead.addCrossUrlEvidence
              ? [
                  {
                    candidateRef: lead.candidateRef,
                    claim: "A reused candidate ref must not authorize a different page.",
                    excerpt: "A reused candidate ref must not authorize a different page.",
                    sourceUrl: unrelatedUrl,
                    sourceType: "code_profile",
                    verificationMethod: "direct_fetch",
                    disposition: "supports",
                    temporalStatus: "current",
                    reliability: 0.7,
                    spoofable: true,
                  },
                ]
              : []),
          ],
          meta: { requests: 1 },
        };
      }
      return { status: "not_found", meta: { requests: 0 } };
    },
    synthesize: async () => ({
      decisionSummary: "Retain exact page identities without name-only candidate merging.",
      openQuestions: [],
      findings: [],
    }),
  };

  const updates = [];
  for await (const update of agent.runResearch(input, dependencies, {
    availableTools: ["search_web", "fetch_public_source"],
    budget: {
      maxTurns: 24,
      maxLlmCalls: 40,
      maxToolCalls: 64,
      maxSearchCalls: 48,
      maxEvidenceAttempts: 64,
      maxConsecutiveNoProgress: 8,
      maxActionsPerTurn: 6,
      phaseCaps: { plan: 4, discover: 12, separate_candidates: 12, corroborate: 20, calibrate: 4, report: 1 },
    },
  }))
    updates.push(update);

  const completed = updates.at(-1);
  assert.equal(completed.type, "completed");
  assert.equal(exactSearchCalls, 1);
  assert.equal(githubSiteSearchCalls, 1);
  assert.deepEqual(new Set(fetchCalls), new Set(leads.keys()));

  const directEvidence = completed.report.evidence.filter(
    (evidence) => evidence.verificationMethod === "direct_fetch" && evidence.disposition === "supports",
  );
  assert.equal(directEvidence.length, 7);
  const repeatedEvidence = directEvidence.filter((evidence) => evidence.canonicalUrl === repeatedUrl);
  const distinctEvidence = directEvidence.filter((evidence) => evidence.canonicalUrl === distinctUrl);
  const ungroundedEvidence = directEvidence.filter((evidence) => evidence.canonicalUrl === ungroundedUrl);
  const ambiguousEvidence = directEvidence.filter((evidence) => evidence.canonicalUrl === ambiguousUrl);
  assert.equal(repeatedEvidence.length, 1);
  assert.equal(distinctEvidence.length, 1);
  assert.equal(ungroundedEvidence.length, 2, "direct evidence without a grounded profile signal must not be reused");
  assert.equal(
    new Set(ungroundedEvidence.map((evidence) => evidence.candidateId)).size,
    2,
    "ungrounded same-page candidates must stay separate",
  );
  assert.equal(ambiguousEvidence.length, 3, "two prior grounded subjects make later reuse ambiguous and fail closed");
  assert.equal(new Set(ambiguousEvidence.map((evidence) => evidence.candidateId)).size, 3);
  assert.equal(
    directEvidence.some((evidence) => evidence.canonicalUrl === unrelatedUrl),
    false,
  );
  assert.notEqual(repeatedEvidence[0].candidateId, distinctEvidence[0].candidateId);

  const directCandidateIds = new Set(directEvidence.map((evidence) => evidence.candidateId));
  assert.equal(directCandidateIds.size, 7, "only the unique grounded exact-page subject may be reused");
  const discoveryCandidateIds = new Set(
    completed.report.evidence
      .filter(
        (evidence) =>
          evidence.verificationMethod === "search_discovery" && typeof evidence.attributes.leadId === "string",
      )
      .map((evidence) => evidence.candidateId),
  );
  assert.equal(discoveryCandidateIds.size, leads.size, "generic same-name search candidates must remain separate");
  assert.ok(
    [...directCandidateIds].every((candidateId) => !discoveryCandidateIds.has(candidateId)),
    "name-only discovery candidates cannot be reused without prior same-page direct evidence",
  );
  assert.equal(
    completed.report.candidates.filter((candidate) =>
      candidate.evidenceIds.some((evidenceId) => directEvidence.some((evidence) => evidence.id === evidenceId)),
    ).length,
    7,
  );
  assert.equal(
    completed.report.candidates.filter((candidate) =>
      candidate.signals.some(
        (signal) => signal.kind === "profile_url" && signal.sourceEvidenceId === repeatedEvidence[0].id,
      ),
    ).length,
    1,
    "only one evidence-grounded candidate may represent the repeated canonical profile",
  );

  const reused = completed.trace.events.filter((event) => event.name === "candidate.reused");
  assert.equal(reused.length, 1);
  assert.equal(reused[0].payload.candidateId, repeatedEvidence[0].candidateId);
  assert.equal(reused[0].payload.canonicalProfileUrl, repeatedUrl);
  assert.equal(reused[0].payload.groundedProfileSignal, true);
  assert.equal(reused[0].payload.reason, "same_canonical_profile_direct_fetch");
  assert.ok(
    completed.trace.events.some(
      (event) =>
        event.name === "evidence.admission" &&
        event.payload.reason === "duplicate_url" &&
        event.payload.duplicateOf === repeatedEvidence[0].id,
    ),
  );
  assert.equal(completed.report.telemetry.evidence.duplicate, 1);
  assert.ok(
    completed.trace.events.some(
      (event) =>
        event.name === "evidence.admission" &&
        event.payload.reason === "candidate_reuse_source_mismatch" &&
        event.payload.expectedSourceUrl === repeatedUrl,
    ),
    "a reused candidate ref must stay scoped to its exact canonical page",
  );

  const graph = completed.report.searchGraph;
  assert.equal(
    graph.nodes.filter((node) => node.kind === "evidence" && node.evidenceId === repeatedEvidence[0].id).length,
    1,
  );
  assert.equal(
    graph.nodes.filter((node) => node.kind === "candidate" && node.candidateId === repeatedEvidence[0].candidateId)
      .length,
    1,
  );
  assert.ok(graph.edges.every((edge) => edge.kind !== "separates" || edge.fromNodeId !== edge.toNodeId));
  const candidateNodeById = new Map(
    graph.nodes.filter((node) => node.kind === "candidate").map((node) => [node.candidateId, node.id]),
  );
  assert.ok(
    graph.edges.some(
      (edge) =>
        edge.kind === "separates" &&
        new Set([edge.fromNodeId, edge.toNodeId]).has(candidateNodeById.get(repeatedEvidence[0].candidateId)) &&
        new Set([edge.fromNodeId, edge.toNodeId]).has(candidateNodeById.get(distinctEvidence[0].candidateId)),
    ),
    "different canonical profile URLs must preserve an explicit candidate-separation edge",
  );
  assert.deepEqual(search.validateSearchGraph(graph), []);
  assert.deepEqual(domain.validateReferentialIntegrity(completed.state), []);
});

test("planner quota outage mechanically reaches DuckDuckGo and preserves a hardened direct-fetch partial", async () => {
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: "Ganesh Talluri",
    requestedDepth: "quick",
  });
  const linkedInUrl = "https://www.linkedin.com/in/ganesh-talluri";
  const sourceUrl = "https://github.com/g4nesh";
  let plannerProviderRequests = 0;
  let synthesisProviderRequests = 0;
  let searchProviderRequests = 0;
  let duckDuckGoRequests = 0;
  let sourceRequests = 0;
  let linkedInRequests = 0;
  const fetch = async (request, init = {}) => {
    const url = new URL(String(request));
    if (url.hostname === "html.duckduckgo.com") {
      duckDuckGoRequests += 1;
      return new Response(
        [
          `<a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(linkedInUrl)}&amp;rut=opaque">Ganesh Talluri — LinkedIn</a>`,
          `<a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(sourceUrl)}&amp;rut=opaque">g4nesh (Ganesh Talluri) — GitHub</a>`,
        ].join(""),
        { headers: { "content-type": "text/html" } },
      );
    }
    if (url.href === linkedInUrl) {
      linkedInRequests += 1;
      return new Response("LinkedIn requires authentication", { status: 999 });
    }
    if (url.href === sourceUrl) {
      sourceRequests += 1;
      return new Response("<title>g4nesh (Ganesh Talluri) · GitHub</title><p>Ganesh Talluri</p>", {
        headers: { "content-type": "text/html" },
      });
    }
    assert.equal(url.hostname, "generativelanguage.googleapis.com");
    if (url.pathname === "/v1beta/interactions") {
      searchProviderRequests += 1;
      return jsonResponse(
        { error: { message: "search quota exhausted" } },
        {
          status: 429,
          headers: { "retry-after": "100" },
        },
      );
    }
    assert.equal(url.pathname, "/v1beta/openai/chat/completions");
    const body = JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body));
    if (body.tools?.some((tool) => tool.function?.name === "propose_research_batch")) {
      plannerProviderRequests += 1;
    } else if (body.tools?.some((tool) => tool.function?.name === "submit_findings")) {
      synthesisProviderRequests += 1;
    } else {
      assert.fail("planner-outage fallback must not invoke model evidence extraction");
    }
    return jsonResponse(
      { error: { message: "planner quota exhausted" } },
      {
        status: 429,
        headers: { "retry-after": "100" },
      },
    );
  };

  const events = [];
  for await (const event of streamLiveResearch(input, {
    apiKey: "test-key",
    model: "test/model",
    provider: "gemini",
    fetch,
    resolveHostname: async (hostname) => (hostname === "html.duckduckgo.com" ? ["52.149.246.39"] : ["93.184.216.34"]),
    clock: domain.createSequenceClock("2026-08-20T19:30:00.000Z", 1),
    ids: domain.createDeterministicIdFactory("planner-quota-fallback"),
  }))
    events.push(event);

  assert.deepEqual(
    events.map((event) => event.seq),
    events.map((_, index) => index + 1),
  );
  assert.equal(plannerProviderRequests, 1, "the first exhausted planner attempt opens the run-scoped circuit breaker");
  assert.ok(searchProviderRequests >= 1, "mechanical planning must still reach the configured search transport");
  assert.ok(duckDuckGoRequests >= 1, "retryable search failure must fall through to keyless public discovery");
  assert.ok(
    sourceRequests >= 1,
    JSON.stringify({
      message: "the classified code-profile lead must reach its legal hardened-fetch lane",
      leadFrontiers: events
        .at(-1)
        ?.payload.report.searchGraph.frontier.filter((entry) => entry.leadId)
        .map((entry) => ({ leadId: entry.leadId, lane: entry.sourceLaneId, status: entry.status })),
      diagnostics: events.flatMap((event) => event.payload?.diagnostics ?? []).map((item) => item.code),
    }),
  );
  assert.ok(
    linkedInRequests <= 3,
    "a blocked professional profile may consume only its own bounded hardened-fetch retries",
  );
  assert.ok(synthesisProviderRequests <= 2, "later synthesis failure remains bounded and cannot erase direct evidence");

  const plannerSpans = events.filter((event) => event.kind === "span_end" && event.name === "planner.decision");
  assert.ok(
    plannerSpans.some(
      (event) =>
        event.status === "succeeded" &&
        /planner provider quota was exhausted/i.test(event.payload.decisionSummary) &&
        /search_web in t1\.first_party/.test(event.payload.decisionSummary),
    ),
  );
  assert.ok(
    plannerSpans.some((event) => event.status === "succeeded" && event.usage.llmCalls === 0),
    "mechanical follow-up routing must not consume phantom model calls",
  );
  assert.ok(JSON.stringify(events).includes("public_web_fallback_used"));
  assert.equal(JSON.stringify(events).includes("lead_lane_mismatch"), false);

  const terminal = events.at(-1);
  assert.equal(terminal.name, "result.terminal");
  assert.equal(terminal.payload.report.status, "partial");
  assert.notEqual(terminal.payload.report.stop.reason, "fatal_error");
  assert.ok(terminal.payload.report.searchGraph.nodes.length > 0);
  assert.ok(
    terminal.payload.report.evidence.some(
      (evidence) =>
        evidence.verificationMethod === "search_discovery" && evidence.attributes.provider === "duckduckgo:html_search",
    ),
  );
  const direct = terminal.payload.report.evidence.find(
    (evidence) => evidence.verificationMethod === "direct_fetch" && evidence.sourceUrl === sourceUrl,
  );
  assert.ok(direct, "the valid direct-fetch record must survive later model unavailability");
  assert.equal(direct.claim, "g4nesh (Ganesh Talluri) · GitHub");
  assert.equal(direct.excerpt, direct.claim);
  assert.equal(direct.attributes.extractionMethod, "deterministic_public_html_named_person_quote");
  assert.equal(
    terminal.payload.report.findings.length,
    1,
    "provider-unavailable synthesis may retain one exact low-confidence observation",
  );
  const finding = terminal.payload.report.findings[0];
  assert.equal(finding.candidateId, direct.candidateId);
  assert.deepEqual(finding.evidenceIds, [direct.id]);
  assert.equal(finding.description, direct.excerpt);
  assert.equal(finding.confidence.label, "low");
  assert.ok(finding.confidence.score < 0.45);
  assert.equal(
    terminal.payload.report.coverage.supportedFindingCount,
    0,
    "the degraded observation must not satisfy supported coverage",
  );
  const findingNode = terminal.payload.report.searchGraph.nodes.find(
    (node) => node.kind === "finding" && node.findingId === finding.id,
  );
  const evidenceNode = terminal.payload.report.searchGraph.nodes.find(
    (node) => node.kind === "evidence" && node.evidenceId === direct.id,
  );
  assert.ok(findingNode);
  assert.ok(evidenceNode);
  assert.ok(
    terminal.payload.report.searchGraph.edges.some(
      (edge) => edge.kind === "grounds" && edge.fromNodeId === evidenceNode.id && edge.toNodeId === findingNode.id,
    ),
  );
  assert.ok(
    events.some((event) =>
      event.payload?.diagnostics?.some((item) => item.code === "deterministic_finding_fallback_used"),
    ),
  );
});

test("provider outage preserves adult school context and binds only a matching institutional page", async () => {
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: "Chinmay Bhat studies at Arizona State University",
    requestedDepth: "deep",
  });
  const matchingUrl = "https://search.asu.edu/profile/chinmay-bhat";
  const conflictingUrl = "https://orcid.org/0000-0002-1825-0097";
  const duckDuckGoQueries = [];
  let contextResultsReturned = false;
  let matchingFetches = 0;
  let conflictingFetches = 0;
  let providerRequests = 0;
  let searchProviderRequests = 0;

  const fetch = async (request) => {
    const url = new URL(String(request));
    if (url.hostname === "html.duckduckgo.com") {
      const query = url.searchParams.get("q") ?? "";
      duckDuckGoQueries.push(query);
      if (!contextResultsReturned && query.includes('"Arizona State University"')) {
        contextResultsReturned = true;
        return new Response(
          [
            `<a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(matchingUrl)}&amp;rut=match">Chinmay Bhat | Arizona State University</a>`,
            `<a class="result__a" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(conflictingUrl)}&amp;rut=conflict">Chinmay Bhat | Example University</a>`,
          ].join(""),
          { headers: { "content-type": "text/html" } },
        );
      }
      return new Response("<html><body>No safe results observed.</body></html>", {
        headers: { "content-type": "text/html" },
      });
    }
    if (url.hostname === "api.github.com") {
      assert.equal(url.pathname, "/search/users");
      return jsonResponse({ total_count: 0, incomplete_results: false, items: [] });
    }
    if (url.hostname === "www.google.com") {
      return new Response("rate limited", {
        status: 429,
        headers: { "content-type": "text/html", "retry-after": "0" },
      });
    }
    if (url.hostname === "api.semanticscholar.org") {
      return jsonResponse({ total: 0, data: [] });
    }
    if (url.hostname === "api.crossref.org") {
      return jsonResponse({ message: { "total-results": 0, items: [] } });
    }
    if (url.href === matchingUrl) {
      matchingFetches += 1;
      return new Response(
        "<html><title>Chinmay Bhat | Arizona State University</title><main><h1>Chinmay Bhat</h1><p>Student researcher at Arizona State University.</p></main></html>",
        { headers: { "content-type": "text/html" } },
      );
    }
    if (url.href === conflictingUrl) {
      conflictingFetches += 1;
      return new Response(
        "<html><title>Chinmay Bhat | Example University</title><main><h1>Chinmay Bhat</h1><p>Researcher at Example University.</p></main></html>",
        { headers: { "content-type": "text/html" } },
      );
    }
    assert.equal(url.hostname, "generativelanguage.googleapis.com");
    providerRequests += 1;
    if (url.pathname === "/v1beta/interactions") searchProviderRequests += 1;
    return jsonResponse(
      { error: { message: "forced provider quota exhaustion" } },
      { status: 429, headers: { "retry-after": "0" } },
    );
  };

  const events = [];
  for await (const event of streamLiveResearch(input, {
    apiKey: "test-key",
    model: "test/model",
    provider: "gemini",
    fetch,
    resolveHostname: async () => ["93.184.216.34"],
    clock: domain.createSequenceClock("2026-08-21T03:00:00.000Z", 1),
    ids: domain.createDeterministicIdFactory("school-context-provider-outage"),
  }))
    events.push(event);

  const terminal = events.at(-1);
  assert.equal(terminal.name, "result.terminal");
  assert.notEqual(terminal.payload.report.stop.reason, "fatal_error");
  assert.ok(providerRequests >= 2, "planner and configured search failure remain explicitly accounted");
  assert.ok(
    duckDuckGoQueries.some((query) => query.includes('"Chinmay Bhat"') && query.includes('"Arizona State University"')),
    JSON.stringify(duckDuckGoQueries),
  );
  assert.ok(
    duckDuckGoQueries.some(
      (query) => query.includes('"Arizona State University"') && query.includes("site:linkedin.com"),
    ),
    "the bounded fallback must execute a school-qualified professional-site query",
  );
  assert.ok(
    duckDuckGoQueries.some(
      (query) => query.includes('"Arizona State University"') && query.includes("site:scholar.google.com"),
    ),
    "the bounded fallback must execute a school-qualified scholarly-index query",
  );
  const contextFrontier = terminal.payload.report.searchGraph.frontier.filter(
    (entry) => entry.queryHint.includes('"Chinmay Bhat"') && entry.queryHint.includes('"Arizona State University"'),
  );
  assert.ok(contextFrontier.length > 0);
  assert.ok(
    contextFrontier.every((entry) => entry.status === "exhausted"),
    "a completed discovery query is exhausted after its finite leads are expanded; this is not a path-cost rejection",
  );
  assert.ok(contextFrontier.every((entry) => Number.isFinite(entry.pathCost) && entry.pathCost > 0));
  assert.equal(matchingFetches, 1);
  assert.equal(conflictingFetches, 1);

  const runDiagnostics = events.flatMap((event) => event.payload?.diagnostics ?? []);
  assert.equal(
    searchProviderRequests,
    4,
    "one bounded four-attempt provider retry sequence must open the circuit for all later searches",
  );
  assert.ok(runDiagnostics.some((item) => item.code === "search_provider_quota_exhausted"));
  assert.ok(runDiagnostics.some((item) => item.code === "search_provider_circuit_open"));
  assert.ok(
    runDiagnostics.some((item) => item.code === "google_html_rate_limited"),
    "an optional secondary-search rate limit stays visible without rejecting a completed DuckDuckGo query",
  );
  assert.ok(runDiagnostics.some((item) => item.code === "secondary_public_search_failed_soft"));
  assert.equal(
    runDiagnostics.some((item) => item.code === "lead_lane_mismatch"),
    false,
  );

  const directEvidence = terminal.payload.report.evidence.filter(
    (evidence) => evidence.verificationMethod === "direct_fetch",
  );
  const matchingEvidence = directEvidence.find((evidence) => evidence.canonicalUrl === matchingUrl);
  const conflictingEvidence = directEvidence.find((evidence) => evidence.canonicalUrl === conflictingUrl);
  assert.ok(matchingEvidence, "the exact name-plus-school institutional page must survive the provider outage");
  assert.ok(conflictingEvidence, "the same-name wrong-school page remains auditable on a quarantined branch");
  const matchingDiscovery = terminal.payload.report.evidence.find(
    (evidence) => evidence.sourceType === "search_result" && evidence.canonicalUrl === matchingUrl,
  );
  const matchingFetchFrontier = terminal.payload.report.searchGraph.frontier.find(
    (entry) => entry.leadId === matchingDiscovery.attributes.leadId,
  );
  assert.equal(matchingFetchFrontier.sourceLaneId, "t3.institutional");
  assert.equal(matchingFetchFrontier.status, "verified");
  assert.equal(matchingEvidence.attributes.matchedTargetOrganization, "Arizona State University");
  assert.notEqual(matchingEvidence.candidateId, conflictingEvidence.candidateId);
  const matchingCandidate = terminal.payload.report.candidates.find(
    (candidate) => candidate.id === matchingEvidence.candidateId,
  );
  assert.ok(
    matchingCandidate.signals.some(
      (signal) =>
        signal.kind === "organization" &&
        signal.normalizedValue === "arizona state university" &&
        signal.sourceEvidenceId === matchingEvidence.id,
    ),
  );
  const conflictingCandidate = terminal.payload.report.candidates.find(
    (candidate) => candidate.id === conflictingEvidence.candidateId,
  );
  assert.equal(conflictingCandidate.normalizedName, "chinmay bhat");
  assert.ok(runDiagnostics.some((item) => item.code === "candidate_binding_organization_missing"));
  const candidateNodes = new Map(
    terminal.payload.report.searchGraph.nodes
      .filter((node) => node.kind === "candidate")
      .map((node) => [node.candidateId, node.id]),
  );
  assert.ok(
    terminal.payload.report.searchGraph.edges.some(
      (edge) =>
        edge.kind === "separates" &&
        new Set([edge.fromNodeId, edge.toNodeId]).has(candidateNodes.get(matchingEvidence.candidateId)) &&
        new Set([edge.fromNodeId, edge.toNodeId]).has(candidateNodes.get(conflictingEvidence.candidateId)),
    ),
    "same-name evidence without the requested school must remain on an explicitly separated branch",
  );
  assert.deepEqual(search.validateSearchGraph(terminal.payload.report.searchGraph), []);
  assert.doesNotThrow(() => domain.parseInvestigationReport(terminal.payload.report));
});

test("planner and search outage executes every bounded standard OSINT query exactly once", async () => {
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: "Ganesh Talluri, Example Labs, Researcher",
    requestedDepth: "standard",
  });
  const duckDuckGoQueries = [];
  let githubSearchRequests = 0;
  const fetch = async (request) => {
    const url = new URL(String(request));
    if (url.hostname === "html.duckduckgo.com") {
      duckDuckGoQueries.push(url.searchParams.get("q"));
      return new Response("", { headers: { "content-type": "text/html" } });
    }
    if (url.hostname === "api.github.com") {
      githubSearchRequests += 1;
      return jsonResponse({ total_count: 0, incomplete_results: false, items: [] });
    }
    assert.equal(url.hostname, "generativelanguage.googleapis.com");
    return jsonResponse(
      { error: { message: "forced provider outage" } },
      {
        status: 429,
        headers: { "retry-after": "0" },
      },
    );
  };

  const events = [];
  for await (const event of streamLiveResearch(input, {
    apiKey: "test-key",
    model: "test/model",
    provider: "gemini",
    fetch,
    resolveHostname: async () => ["93.184.216.34"],
    clock: domain.createSequenceClock("2026-08-20T22:00:00.000Z", 1),
    ids: domain.createDeterministicIdFactory("planner-search-outage-queries"),
  }))
    events.push(event);

  const terminal = events.at(-1);
  assert.equal(terminal.name, "result.terminal");
  assert.notEqual(terminal.payload.report.stop.reason, "fatal_error");
  const compilerEntries = terminal.payload.report.searchGraph.frontier.filter((entry) =>
    entry.intent.startsWith("OSINT query "),
  );
  assert.ok(compilerEntries.length >= 9);
  assert.equal(duckDuckGoQueries.length, compilerEntries.length);
  assert.deepEqual(
    new Set(duckDuckGoQueries),
    new Set(compilerEntries.map((entry) => entry.queryHint)),
    "every advertised query must reach a real search transport before terminal exhaustion",
  );
  assert.ok(
    githubSearchRequests <= 1,
    "the bounded exact-name GitHub fallback must not repeat for scoped query variants",
  );
  assert.ok(compilerEntries.every((entry) => entry.status === "exhausted"));
});

test("query-bound HTML extraction prefers durable professional relationships and retains a neutral fallback", async () => {
  const runCase = async ({ id, path, html, expectedExcerpt }) => {
    const input = domain.parseInvestigationInput({
      schemaVersion: domain.SCHEMA_VERSION,
      query: "Avery Stone",
      requestedDepth: "deep",
    });
    const engine = new agent.InvestigationEngine(input, {
      clock: domain.createSequenceClock("2026-08-21T18:10:00.000Z", 1),
      ids: domain.createDeterministicIdFactory(`professional-excerpt-${id}`),
    });
    const candidate = engine.addCandidate({
      displayName: "Avery Stone",
      signals: [
        {
          kind: "name",
          value: "Avery Stone",
          normalizedValue: "avery stone",
          strength: "weak",
          assurance: "self_asserted",
        },
      ],
    }).candidate;
    assert.equal(
      engine.admitEvidence({
        candidateId: candidate.id,
        claim: "A bounded search established this run's neutral query subject.",
        disposition: "discovery_only",
        sourceUrl: `https://search-anchor.example/${id}`,
        sourceType: "search_result",
        canonicalSubset: { providerAttestedUrl: true },
        verificationMethod: "search_discovery",
        temporalStatus: "unknown",
        reliability: 0,
        spoofable: true,
        attributes: { querySubjectAnchor: true, querySubjectName: "Avery Stone" },
      }).admitted,
      true,
    );

    const sourceUrl = `https://profiles-${id}.example/${path}/avery-stone`;
    let providerCalls = 0;
    const dependencies = createLiveDependencies(input, {
      apiKey: "test-key",
      model: "test/model",
      resolveHostname: async () => ["93.184.216.34"],
      fetch: async (request) => {
        const url = new URL(String(request));
        if (url.hostname === "openrouter.ai") {
          providerCalls += 1;
          return jsonResponse({
            id: `generation-professional-excerpt-${id}`,
            model: "test/model",
            choices: [
              {
                finish_reason: "stop",
                message: {
                  role: "assistant",
                  content: "One exact public page was observed.",
                  annotations: [
                    {
                      type: "url_citation",
                      url_citation: { url: sourceUrl, title: "Avery Stone — Public profile" },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 2, completion_tokens: 1 },
          });
        }
        assert.equal(url.href, sourceUrl);
        return new Response(html, { headers: { "content-type": "text/html" } });
      },
    });

    const searchResult = await dependencies.executeAction(
      {
        schemaVersion: domain.SCHEMA_VERSION,
        id: `action-professional-excerpt-search-${id}`,
        frontierEntryId: `action-professional-excerpt-search-${id}`,
        tool: "search_web",
        purpose: "Find the exact public page for the named subject.",
        arguments: { query: '"Avery Stone"' },
        budgetClass: "search",
        sourceTier: 1,
        sourceLaneId: "t1.first_party",
        pathCost: 1,
        mutated: false,
      },
      {
        schemaVersion: domain.SCHEMA_VERSION,
        state: engine.snapshot(),
        modelAccounting: { reserve: () => true, settle: () => {} },
      },
    );
    assert.equal(searchResult.status, "succeeded");
    assert.equal(searchResult.evidence.length, 1);
    const admission = engine.admitEvidence(searchResult.evidence[0]);
    assert.equal(admission.admitted, true);
    const lead = admission.evidence;

    const direct = await dependencies.executeAction(
      {
        schemaVersion: domain.SCHEMA_VERSION,
        id: `action-professional-excerpt-fetch-${id}`,
        frontierEntryId: `action-professional-excerpt-fetch-${id}`,
        tool: "fetch_public_source",
        purpose: "Fetch the exact query-bound public page.",
        arguments: { leadId: lead.attributes.leadId, claimFocus: "Public professional identity" },
        candidateId: candidate.id,
        budgetClass: "fetch",
        sourceTier: lead.attributes.classifiedSourceTier,
        sourceLaneId: lead.attributes.classifiedSourceLaneId,
        pathCost: 1.4,
        mutated: false,
      },
      {
        schemaVersion: domain.SCHEMA_VERSION,
        state: engine.snapshot(),
        modelAccounting: {
          reserve: () => {
            throw new Error("deterministic query-bound extraction must not invoke the model");
          },
          settle: () => {},
        },
      },
    );

    const quote = direct.evidence.find((evidence) => evidence.verificationMethod === "direct_fetch");
    assert.ok(quote);
    assert.equal(quote.claim, expectedExcerpt);
    assert.equal(quote.excerpt, expectedExcerpt);
    assert.equal(html.includes(expectedExcerpt), true, "the selected excerpt must remain an exact fetched substring");
    assert.ok(expectedExcerpt.length <= 480);
    assert.equal(quote.attributes.extractionMethod, "deterministic_public_html_named_person_quote");
    assert.equal(providerCalls, 1, "only the explicit search turn may call the configured provider");
    return quote;
  };

  const durable = "Avery Stone is the founder and chief executive officer of Northstar Robotics.";
  await runCase({
    id: "durable",
    path: "bio",
    html: `<html><title>Avery Stone | Public profile</title><main><p>Avery Stone is ranked #1 in the world today.</p><p>By Editorial Staff: Avery Stone has a net worth of $123 billion. Last Updated August 21, 2026.</p><p>${durable}</p></main></html>`,
    expectedExcerpt: durable,
  });

  const neutralFallback = "Avery Stone attended a public conference.";
  await runCase({
    id: "fallback",
    path: "profile",
    html: `<html><title>Avery Stone | Public profile</title><main><p>${neutralFallback}</p></main></html>`,
    expectedExcerpt: neutralFallback,
  });
});

test("bare name-context discovery binds only exact adult professional relations and rejects current-student adjacency", async () => {
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: "alex rivera meridian collective",
    requestedDepth: "deep",
  });
  const engine = new agent.InvestigationEngine(input, {
    clock: domain.createSequenceClock("2026-08-25T03:10:00.000Z", 1),
    ids: domain.createDeterministicIdFactory("bare-context-live-binding"),
  });
  const hypothesisQuery = search
    .compileOsintQueries(engine.snapshot().target)
    .queries.find((query) => query.kind === "bare_context_hypothesis");
  assert.ok(hypothesisQuery);
  assert.equal(hypothesisQuery.subjectPhrase, "Alex Rivera");
  assert.equal(hypothesisQuery.hypothesisContextPhrase, "Meridian Collective");

  const sources = [
    {
      key: "linkedin",
      url: "https://www.linkedin.com/in/alex-rivera-meridian",
      excerpt: "Alex Rivera worked at Meridian Collective as a researcher.",
      accepted: true,
    },
    {
      key: "researchgate",
      url: "https://www.researchgate.net/profile/Alex-Rivera-Meridian",
      excerpt: "Alex Rivera was a researcher at Meridian Collective.",
      accepted: true,
    },
    {
      key: "biography",
      url: "https://profiles.example/profile/alex-rivera",
      excerpt: "Alex Rivera graduated from Meridian Collective.",
      accepted: true,
    },
    {
      key: "current-student",
      url: "https://students.example/profile/alex-rivera",
      excerpt: "Alex Rivera is currently a student at Meridian Collective.",
      accepted: false,
    },
  ];
  const sourceByUrl = new Map(sources.map((source) => [source.url, source]));
  let providerCalls = 0;
  const dependencies = createLiveDependencies(input, {
    apiKey: "test-key",
    model: "test/model",
    resolveHostname: async () => ["93.184.216.34"],
    fetch: async (request, init = {}) => {
      const url = new URL(String(request));
      if (url.hostname === "openrouter.ai") {
        providerCalls += 1;
        const body = JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body));
        assert.equal(
          body.tools?.some((tool) => tool.function?.name === "submit_evidence_extraction"),
          false,
          "exact query-bound HTML must not invoke model extraction",
        );
        return jsonResponse({
          id: "generation-bare-context-search",
          model: "test/model",
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "Bounded public-professional pages were observed.",
                annotations: sources.map((source) => ({
                  type: "url_citation",
                  url_citation: { url: source.url, title: `Alex Rivera | ${source.key}` },
                })),
              },
            },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        });
      }
      const source = sourceByUrl.get(url.href);
      if (!source) throw new Error(`Unexpected bare-context request ${url.href}`);
      return new Response(
        `<html><head><title>Alex Rivera</title></head><body><main><p>${source.excerpt}</p></main></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });

  const searchResult = await dependencies.executeAction(
    {
      schemaVersion: domain.SCHEMA_VERSION,
      id: "action-bare-context-search",
      frontierEntryId: "action-bare-context-search",
      tool: "search_web",
      purpose: "Execute the bounded compiler hypothesis.",
      arguments: { query: hypothesisQuery.query },
      budgetClass: "search",
      sourceTier: 1,
      sourceLaneId: "t1.first_party",
      pathCost: 1,
      mutated: false,
    },
    {
      schemaVersion: domain.SCHEMA_VERSION,
      state: engine.snapshot(),
      modelAccounting: { reserve: () => true, settle: () => {} },
    },
  );

  assert.equal(searchResult.status, "succeeded");
  assert.equal(searchResult.candidates.length, 1);
  assert.equal(searchResult.candidates[0].displayName, "Alex Rivera");
  assert.equal(searchResult.evidence.length, sources.length);
  const candidate = engine.addCandidate(searchResult.candidates[0]).candidate;
  const leads = new Map();
  for (const draft of searchResult.evidence) {
    assert.equal(draft.attributes.querySubjectName, "Alex Rivera");
    assert.equal(draft.attributes.querySubjectContext, "Meridian Collective");
    assert.equal(draft.attributes.querySubjectHypothesis, true);
    assert.notEqual(draft.attributes.querySubjectAnchor, true);
    const persisted = { ...draft, candidateId: candidate.id };
    delete persisted.candidateRef;
    const admission = engine.admitEvidence(persisted);
    assert.equal(admission.admitted, true);
    leads.set(draft.sourceUrl, admission.evidence);
  }

  for (const source of sources) {
    const lead = leads.get(source.url);
    assert.ok(lead, source.key);
    const direct = await dependencies.executeAction(
      {
        schemaVersion: domain.SCHEMA_VERSION,
        id: `action-bare-context-fetch-${source.key}`,
        frontierEntryId: `action-bare-context-fetch-${source.key}`,
        tool: "fetch_public_source",
        purpose: "Fetch the exact hypothesis-bound lead.",
        arguments: { leadId: lead.attributes.leadId, claimFocus: "Exact public professional relationship" },
        candidateId: candidate.id,
        budgetClass: "fetch",
        sourceTier: lead.attributes.classifiedSourceTier,
        sourceLaneId: lead.attributes.classifiedSourceLaneId,
        pathCost: 1.4,
        mutated: false,
      },
      {
        schemaVersion: domain.SCHEMA_VERSION,
        state: engine.snapshot(),
        modelAccounting: { reserve: () => true, settle: () => {} },
      },
    );
    const quote = direct.evidence.find((evidence) => evidence.verificationMethod === "direct_fetch");
    assert.ok(quote, source.key);
    assert.equal(quote.claim, source.excerpt, source.key);
    if (source.accepted) {
      assert.equal(quote.disposition ?? "supports", "supports", source.key);
      assert.equal(quote.candidateId, undefined, source.key);
      assert.ok(quote.candidateRef, source.key);
      assert.equal(quote.attributes.matchedBareContextPhrase, "Meridian Collective", source.key);
      assert.ok(["professional", "alumni"].includes(quote.attributes.matchedBareContextRelation), source.key);
      assert.equal(quote.attributes.isolatedFromCandidateId, candidate.id, source.key);
      assert.equal(quote.attributes.isolationBasis, "bare_context_source", source.key);
      assert.equal(direct.candidateBranches?.length, 1, source.key);
      assert.equal(direct.candidateBranches[0].parentCandidateId, candidate.id, source.key);
      assert.equal(direct.candidateBranches[0].reason, "bare_context_source_isolated", source.key);
      assert.equal(direct.candidateBranches[0].candidate.ref, quote.candidateRef, source.key);
      assert.ok(
        direct.candidateBranches[0].candidate.signals.some(
          (signal) => signal.kind === "bio_phrase" && signal.value === "Meridian Collective",
        ),
        source.key,
      );
      assert.deepEqual(direct.candidateSignals, [], source.key);
    } else {
      assert.equal(quote.disposition, "discovery_only", source.key);
      assert.equal(quote.reliability, 0, source.key);
      assert.equal(quote.candidateId, candidate.id, source.key);
      assert.equal(direct.candidateBranches, undefined, source.key);
      assert.deepEqual(direct.candidateSignals, [], source.key);
      assert.ok(
        direct.diagnostics.some((diagnostic) => diagnostic.code === "bare_context_relation_not_attested"),
        source.key,
      );
    }
  }
  assert.equal(providerCalls, 1);
});

test("bare-context HTML without an exact adult relation stays discovery-only without reserving an extractor call", async () => {
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: "alex rivera meridian collective",
    requestedDepth: "deep",
  });
  const engine = new agent.InvestigationEngine(input, {
    clock: domain.createSequenceClock("2026-08-25T03:30:00.000Z", 1),
    ids: domain.createDeterministicIdFactory("bare-context-no-relation-no-extractor"),
  });
  const hypothesisQuery = search
    .compileOsintQueries(engine.snapshot().target)
    .queries.find((query) => query.kind === "bare_context_hypothesis");
  assert.ok(hypothesisQuery);

  const sourceUrl = "https://alexrivera.example/profile";
  let providerCalls = 0;
  const dependencies = createLiveDependencies(input, {
    apiKey: "test-key",
    model: "test/model",
    resolveHostname: async () => ["93.184.216.34"],
    fetch: async (request, init = {}) => {
      const url = new URL(String(request));
      if (url.hostname === "openrouter.ai") {
        providerCalls += 1;
        const body = JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body));
        assert.equal(
          body.tools?.some((tool) => tool.function?.name === "submit_evidence_extraction"),
          false,
          "the missing deterministic relationship must never fall through to model extraction",
        );
        return jsonResponse({
          id: "generation-bare-context-no-relation",
          model: "test/model",
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "One bounded fictional profile path was observed.",
                annotations: [
                  {
                    type: "url_citation",
                    url_citation: { url: sourceUrl, title: "Alex Rivera" },
                  },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        });
      }
      assert.equal(url.href, sourceUrl);
      return new Response(
        "<html><head><title>Public portfolio</title></head><body><main><p>Selected public projects and contact-free professional notes.</p></main></body></html>",
        { headers: { "content-type": "text/html" } },
      );
    },
  });

  const searchResult = await dependencies.executeAction(
    {
      schemaVersion: domain.SCHEMA_VERSION,
      id: "action-bare-context-no-relation-search",
      frontierEntryId: "action-bare-context-no-relation-search",
      tool: "search_web",
      purpose: "Execute the bounded fictional compiler hypothesis.",
      arguments: { query: hypothesisQuery.query },
      budgetClass: "search",
      sourceTier: 1,
      sourceLaneId: "t1.first_party",
      pathCost: 1,
      mutated: false,
    },
    {
      schemaVersion: domain.SCHEMA_VERSION,
      state: engine.snapshot(),
      modelAccounting: { reserve: () => true, settle: () => {} },
    },
  );
  assert.equal(searchResult.status, "succeeded");
  assert.equal(searchResult.candidates.length, 1);
  assert.equal(searchResult.evidence.length, 1);
  assert.equal(searchResult.evidence[0].attributes.leadSchedulingDisposition, "prioritize");
  assert.equal(searchResult.evidence[0].attributes.leadSchedulingReason, "candidate_bio_path");

  const candidate = engine.addCandidate(searchResult.candidates[0]).candidate;
  const leadDraft = { ...searchResult.evidence[0], candidateId: candidate.id };
  delete leadDraft.candidateRef;
  const admitted = engine.admitEvidence(leadDraft);
  assert.equal(admitted.admitted, true);

  let modelReservations = 0;
  let modelSettlements = 0;
  const direct = await dependencies.executeAction(
    {
      schemaVersion: domain.SCHEMA_VERSION,
      id: "action-bare-context-no-relation-fetch",
      frontierEntryId: "action-bare-context-no-relation-fetch",
      tool: "fetch_public_source",
      purpose: "Fetch the exact hypothesis-bound fictional profile.",
      arguments: {
        leadId: admitted.evidence.attributes.leadId,
        claimFocus: "Exact adult professional or alumni relationship",
      },
      candidateId: candidate.id,
      budgetClass: "fetch",
      sourceTier: admitted.evidence.attributes.classifiedSourceTier,
      sourceLaneId: admitted.evidence.attributes.classifiedSourceLaneId,
      pathCost: 1.4,
      mutated: false,
    },
    {
      schemaVersion: domain.SCHEMA_VERSION,
      state: engine.snapshot(),
      modelAccounting: {
        reserve: () => {
          modelReservations += 1;
          return true;
        },
        settle: () => {
          modelSettlements += 1;
        },
      },
    },
  );

  assert.equal(direct.status, "partial");
  assert.deepEqual(direct.candidates, []);
  assert.deepEqual(direct.candidateSignals, []);
  assert.equal(modelReservations, 0);
  assert.equal(modelSettlements, 0);
  assert.equal(providerCalls, 1, "the configured provider was used only for bounded discovery");
  assert.equal(direct.meta.llmCalls, 0);
  assert.equal(
    direct.evidence.some((evidence) => evidence.verificationMethod === "direct_fetch"),
    false,
  );
  assert.ok(direct.evidence.length > 0, "the already-fetched page may retain passive discovery metadata");
  assert.ok(
    direct.evidence.every(
      (evidence) =>
        evidence.disposition === "discovery_only" &&
        evidence.verificationMethod === "unverified" &&
        evidence.attributes.identityBinding === false,
    ),
  );
  assert.ok(direct.diagnostics.some((diagnostic) => diagnostic.code === "bare_context_relation_not_attested"));
});

test("exact personal Education pages admit only completed adult rows without model extraction", async () => {
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: "alex rivera meridian academy",
    requestedDepth: "deep",
  });
  const testClock = domain.createSequenceClock("2026-08-25T04:00:00.000Z", 1);
  const engine = new agent.InvestigationEngine(input, {
    clock: testClock,
    ids: domain.createDeterministicIdFactory("page-scoped-education-live"),
  });
  const hypothesisQuery = search
    .compileOsintQueries(engine.snapshot().target)
    .queries.find((query) => query.kind === "bare_context_hypothesis");
  assert.ok(hypothesisQuery);

  const completedRow = "Education Meridian Academy High School Diploma August 2022 - May 2026";
  const sources = [
    {
      key: "completed",
      url: "https://alexrivera.example/profile",
      title: "Alex Rivera",
      body: `${completedRow} Cumulative GPA: 4.7/5.0 Experience Research Fellow`,
      accepted: true,
    },
    {
      key: "current-student",
      url: "https://alexrivera.net/profile",
      title: "Alex Rivera",
      body: "Current student at Meridian Academy. Education Meridian Academy High School Diploma August 2022 - May 2026",
    },
    {
      key: "future-expected",
      url: "https://alexrivera.org/profile",
      title: "Alex Rivera",
      body: "Education Meridian Academy Expected High School Diploma August 2022 - May 2027",
    },
    {
      key: "school-team",
      url: "https://alexrivera.dev/profile",
      title: "Alex Rivera",
      body: "Education Meridian Academy Robotics Club team High School Diploma August 2022 - May 2026",
    },
    {
      key: "nonexact-title",
      url: "https://alexrivera.io/profile",
      title: "Alex Rivera Smith",
      body: completedRow,
    },
    {
      key: "changed-redirect",
      url: "https://alexrivera.co/profile",
      title: "Alex Rivera",
      body: completedRow,
      redirectTo: "https://redirected.example/profile",
    },
    {
      key: "explicit-minor",
      url: "https://alexrivera.info/profile",
      title: "Alex Rivera",
      body: `About I am 17 years old. ${completedRow}`,
    },
    {
      key: "competing-row-subject",
      url: "https://alexrivera.xyz/profile",
      title: "Alex Rivera",
      body: "Education Jordan Lee — Meridian Academy — High School Diploma August 2022 - May 2026",
    },
  ];
  const sourceByUrl = new Map(sources.map((source) => [new URL(source.url).href, source]));
  const redirected = sources.find((source) => source.redirectTo);
  let providerCalls = 0;
  const dependencies = createLiveDependencies(input, {
    apiKey: "test-key",
    model: "test/model",
    clock: testClock,
    resolveHostname: async () => ["93.184.216.34"],
    fetch: async (request, init = {}) => {
      const url = new URL(String(request));
      if (url.hostname === "openrouter.ai") {
        providerCalls += 1;
        const body = JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body));
        assert.equal(
          body.tools?.some((tool) => tool.function?.name === "submit_evidence_extraction"),
          false,
          "query-bound HTML extraction remains deterministic",
        );
        return jsonResponse({
          id: "generation-page-scoped-education-search",
          model: "test/model",
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "Bounded fictional public pages were observed.",
                annotations: sources.map((source) => ({
                  type: "url_citation",
                  url_citation: { url: source.url, title: "Alex Rivera" },
                })),
              },
            },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        });
      }
      if (redirected?.redirectTo === url.href) {
        return new Response(
          `<html><head><title>${redirected.title}</title></head><body><main>${redirected.body}</main></body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      }
      const source = sourceByUrl.get(url.href);
      if (!source) throw new Error(`Unexpected page-scoped education request ${url.href}`);
      if (source.redirectTo) {
        return new Response(null, { status: 302, headers: { location: source.redirectTo } });
      }
      return new Response(
        `<html><head><title>${source.title}</title></head><body><main>${source.body}</main></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });

  const searchResult = await dependencies.executeAction(
    {
      schemaVersion: domain.SCHEMA_VERSION,
      id: "action-page-scoped-education-search",
      frontierEntryId: "action-page-scoped-education-search",
      tool: "search_web",
      purpose: "Execute the bounded fictional education hypothesis.",
      arguments: { query: hypothesisQuery.query },
      budgetClass: "search",
      sourceTier: 1,
      sourceLaneId: "t1.first_party",
      pathCost: 1,
      mutated: false,
    },
    {
      schemaVersion: domain.SCHEMA_VERSION,
      state: engine.snapshot(),
      modelAccounting: { reserve: () => true, settle: () => {} },
    },
  );
  assert.equal(searchResult.status, "succeeded");
  const discoveredUrls = new Set(searchResult.evidence.map((evidence) => evidence.sourceUrl));
  assert.deepEqual(discoveredUrls, new Set(sources.map((source) => source.url)));
  const candidate = engine.addCandidate(searchResult.candidates[0]).candidate;
  const leads = new Map();
  for (const draft of searchResult.evidence) {
    const persisted = { ...draft, candidateId: candidate.id };
    delete persisted.candidateRef;
    const admission = engine.admitEvidence(persisted);
    assert.equal(admission.admitted, true);
    leads.set(draft.sourceUrl, admission.evidence);
  }

  let modelReservations = 0;
  let modelSettlements = 0;
  for (const source of sources) {
    const lead = leads.get(source.url);
    assert.ok(lead, source.key);
    const direct = await dependencies.executeAction(
      {
        schemaVersion: domain.SCHEMA_VERSION,
        id: `action-page-scoped-education-fetch-${source.key}`,
        frontierEntryId: `action-page-scoped-education-fetch-${source.key}`,
        tool: "fetch_public_source",
        purpose: "Fetch one exact fictional hypothesis lead.",
        arguments: { leadId: lead.attributes.leadId, claimFocus: "Exact completed adult education relationship" },
        candidateId: candidate.id,
        budgetClass: "fetch",
        sourceTier: lead.attributes.classifiedSourceTier,
        sourceLaneId: lead.attributes.classifiedSourceLaneId,
        pathCost: 1.4,
        mutated: false,
      },
      {
        schemaVersion: domain.SCHEMA_VERSION,
        state: engine.snapshot(),
        modelAccounting: {
          reserve: () => {
            modelReservations += 1;
            return true;
          },
          settle: () => {
            modelSettlements += 1;
          },
        },
      },
    );
    assert.equal(direct.meta.llmCalls ?? 0, 0, source.key);
    assert.deepEqual(direct.candidateSignals ?? [], [], source.key);
    if (source.accepted) {
      const quote = direct.evidence.find((evidence) => evidence.disposition !== "discovery_only");
      assert.ok(quote, source.key);
      assert.equal(quote.claim, completedRow);
      assert.equal(quote.excerpt, completedRow);
      assert.ok(source.body.includes(quote.claim), "the claim is one contiguous fetched-body substring");
      assert.equal(quote.claim.includes(source.title), false, "the exact fetched title is not stitched into the quote");
      assert.equal(quote.sourceType, "other");
      assert.equal(quote.temporalStatus, "historical");
      assert.equal(quote.reliability, 0.55);
      assert.equal(quote.spoofable, true);
      assert.equal(quote.attributes.extractionMethod, "deterministic_page_scoped_completed_education");
      assert.equal(quote.attributes.matchedBareContextRelation, "alumni");
      assert.equal(quote.canonicalSubset.pageScopedEducationProof.fetchedTitle, "Alex Rivera");
      assert.ok(quote.canonicalSubset.pageScopedEducationProof.safetyWindow.startsWith(completedRow));
      assert.equal(direct.candidateBranches?.length, 1);
      assert.equal(direct.candidateBranches[0].reason, "bare_context_source_isolated");
      assert.ok(
        direct.candidateBranches[0].candidate.signals.some(
          (signal) => signal.kind === "bio_phrase" && signal.value === "Meridian Academy",
        ),
      );
      assert.ok(
        direct.diagnostics.some((diagnostic) => diagnostic.code === "deterministic_page_scoped_completed_education"),
      );
      assert.equal(
        direct.diagnostics.some((diagnostic) => diagnostic.code === "deterministic_public_html_extraction"),
        false,
      );
    } else {
      assert.equal(
        (direct.evidence ?? []).some((evidence) => evidence.disposition === "supports"),
        false,
        source.key,
      );
      assert.equal(direct.candidateBranches, undefined, source.key);
      assert.deepEqual(direct.candidates ?? [], [], source.key);
      assert.ok(
        (direct.diagnostics ?? []).some((diagnostic) =>
          [
            "bare_context_relation_not_attested",
            "bare_context_source_binding_changed",
            "blocked_host",
            "unsafe_redirect",
          ].includes(diagnostic.code),
        ),
        `${source.key}: ${JSON.stringify((direct.diagnostics ?? []).map((diagnostic) => diagnostic.code))}`,
      );
    }
  }
  assert.equal(modelReservations, 0);
  assert.equal(modelSettlements, 0);
  assert.equal(providerCalls, 1, "only bounded discovery used the provider");
});

test("full runner isolates lowercase bare name-context sources without discovery synthesis churn", async () => {
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: "alex rivera meridian collective",
    requestedDepth: "deep",
  });
  const plan = search.compileOsintQueries(domain.parseTarget(input));
  assert.equal(plan.status, "compiled");
  const hypothesisQuery = plan.queries.find((query) => query.kind === "bare_context_hypothesis");
  assert.ok(hypothesisQuery);
  assert.equal(hypothesisQuery.subjectPhrase, "Alex Rivera");
  assert.equal(hypothesisQuery.hypothesisContextPhrase, "Meridian Collective");

  const sources = [
    {
      key: "alumni",
      url: "https://portfolio.example/alex-rivera",
      excerpt: "Alex Rivera graduated from Meridian Collective.",
      accepted: true,
    },
    {
      key: "linkedin",
      url: "https://www.linkedin.com/in/alex-rivera-meridian",
      excerpt: "Alex Rivera worked at Meridian Collective as a researcher.",
      accepted: true,
    },
    {
      key: "researchgate",
      url: "https://www.researchgate.net/profile/Alex-Rivera-Meridian",
      excerpt: "Alex Rivera was a researcher at Meridian Collective.",
      accepted: true,
    },
    {
      key: "current-student",
      url: "https://students.example/alex-rivera",
      excerpt: "Alex Rivera is currently a student at Meridian Collective.",
      accepted: false,
    },
    {
      key: "cooccurrence",
      url: "https://directory.example/alex-rivera",
      excerpt: "Alex Rivera and Meridian Collective appear in this public directory.",
      accepted: false,
    },
  ];
  const sourceByUrl = new Map(sources.map((source) => [new URL(source.url).href, source]));
  let providerSearchCalls = 0;
  const providerQueries = [];
  const sourceRequests = new Map(sources.map((source) => [source.key, 0]));
  const live = createLiveDependencies(input, {
    apiKey: "test-key",
    model: "test/model",
    clock: domain.createSequenceClock("2026-08-25T04:00:00.000Z", 1),
    ids: domain.createDeterministicIdFactory("bare-context-full-run"),
    resolveHostname: async () => ["93.184.216.34"],
    fetch: async (request, init = {}) => {
      const url = new URL(String(request));
      if (url.hostname === "openrouter.ai") {
        providerSearchCalls += 1;
        const body = JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body));
        assert.equal(
          body.tools?.some((tool) => tool.function?.name === "submit_evidence_extraction"),
          false,
          "query-bound bare-context pages must stay on deterministic exact-quote extraction",
        );
        const prompt = body.messages?.at(-1)?.content ?? "";
        providerQueries.push(prompt);
        const isHypothesis = prompt.includes(hypothesisQuery.query);
        return jsonResponse({
          id: `generation-bare-context-full-run-${providerSearchCalls}`,
          model: "test/model",
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: isHypothesis ? "Bounded fictional sources were observed." : "No sources were observed.",
                annotations: isHypothesis
                  ? sources.map((source) => ({
                      type: "url_citation",
                      url_citation: { url: source.url, title: `Alex Rivera | ${source.key}` },
                    }))
                  : [],
              },
            },
          ],
          usage: { prompt_tokens: 2, completion_tokens: 1 },
        });
      }
      if (url.hostname === "html.duckduckgo.com" || url.hostname === "www.google.com") {
        return new Response("<html><body>No matching public links.</body></html>", {
          headers: { "content-type": "text/html" },
        });
      }
      if (url.hostname === "api.github.com") {
        return jsonResponse({ total_count: 0, incomplete_results: false, items: [] });
      }
      if (url.hostname === "api.semanticscholar.org") return jsonResponse({ total: 0, data: [] });
      if (url.hostname === "api.crossref.org") return jsonResponse({ message: { items: [] } });
      const source = sourceByUrl.get(url.href);
      if (!source) throw new Error(`Unexpected full-run bare-context request ${url.href}`);
      sourceRequests.set(source.key, (sourceRequests.get(source.key) ?? 0) + 1);
      return new Response(
        `<html><head><title>Alex Rivera</title></head><body><main><p>${source.excerpt}</p></main></body></html>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  });

  const synthesisSnapshots = [];
  const updates = [];
  for await (const update of agent.runResearch(
    input,
    {
      ...live,
      planner: async ({ selectedFrontierEntries }) => ({
        kind: "actions",
        decisionSummary: "Execute the selected bounded fictional public-source capabilities.",
        actions: selectedFrontierEntries.map((entry) => ({
          frontierEntryId: entry.id,
          tool: entry.allowedTools[0],
          purpose: "Exercise the selected bounded fictional public-source capability.",
          arguments:
            entry.allowedTools[0] === "search_web"
              ? { query: entry.queryHint }
              : { leadId: entry.queryHint, claimFocus: "Exact adult professional or alumni relationship" },
          ...(entry.candidateId ? { candidateId: entry.candidateId } : {}),
        })),
      }),
      synthesize: async (state) => {
        const usefulDirectIds = state.evidence
          .filter(
            (evidence) =>
              evidence.disposition === "supports" &&
              evidence.sourceType !== "search_result" &&
              evidence.verificationMethod === "direct_fetch" &&
              Boolean(evidence.contentHash || evidence.excerpt || evidence.canonicalSubset),
          )
          .map((evidence) => evidence.id)
          .sort();
        synthesisSnapshots.push({
          usefulDirectIds,
          discoveryOnlyCount: state.evidence.filter((evidence) => evidence.disposition === "discovery_only").length,
        });
        return {
          decisionSummary: "The exact sources support a candidate dossier, but no separate finding is needed here.",
          findings: [],
          openQuestions: [],
        };
      },
    },
    {
      availableTools: ["search_web", "fetch_public_source"],
      budget: {
        maxTurns: 40,
        maxLlmCalls: 64,
        maxToolCalls: 120,
        maxSearchCalls: 60,
        maxEvidenceAttempts: 240,
        maxNetworkRequests: 240,
        maxConsecutiveNoProgress: 20,
        maxActionsPerTurn: 4,
        phaseCaps: { plan: 4, discover: 16, separate_candidates: 12, corroborate: 20, calibrate: 20, report: 1 },
      },
    },
  ))
    updates.push(update);

  const completed = updates.at(-1);
  assert.equal(completed.type, "completed");
  assert.notEqual(completed.report.stop.reason, "fatal_error");
  assert.ok(providerQueries.some((query) => query.includes(hypothesisQuery.query)));
  const hypothesisSearchStart = completed.trace.events.find(
    (event) =>
      event.kind === "span_start" &&
      event.name === "tool.search_web" &&
      event.payload.arguments?.query === hypothesisQuery.query,
  );
  assert.ok(hypothesisSearchStart, "the compiled bare-context hypothesis must reach the live search adapter");

  const canonicalFrontierIds = new Set(
    completed.report.searchGraph.frontier
      .filter((entry) => search.isCanonicalCompilerSearchEntry(entry))
      .map((entry) => entry.id),
  );
  const canonicalSearchEnds = completed.trace.events.filter(
    (event) =>
      event.kind === "span_end" &&
      event.name === "tool.search_web" &&
      canonicalFrontierIds.has(event.payload.frontierEntryId),
  );
  assert.equal(canonicalSearchEnds.length, plan.queries.length);
  const leadFetchStarts = completed.trace.events.filter(
    (event) => event.kind === "span_start" && event.name === "tool.fetch_public_source",
  );
  assert.ok(leadFetchStarts.length >= sources.length);
  assert.ok(
    leadFetchStarts[0].seq < Math.max(...canonicalSearchEnds.map((event) => event.seq)),
    "one persisted-priority hypothesis probe must interleave before remaining canonical breadth",
  );
  assert.ok(
    leadFetchStarts.slice(1).some((event) => event.seq < Math.max(...canonicalSearchEnds.map((item) => item.seq))),
    "after one grounding probe, ordinary focused fetches may interleave with the remaining exact source queries",
  );
  assert.equal(
    completed.trace.events.filter((event) => event.name === "scheduler.quality_probe_routed").length,
    1,
    "only one fetch may receive the server-owned grounding-probe role",
  );

  for (const source of sources) assert.equal(sourceRequests.get(source.key), 1, source.key);
  const directByUrl = new Map(
    completed.report.evidence
      .filter((evidence) => evidence.verificationMethod === "direct_fetch")
      .map((evidence) => [evidence.sourceUrl, evidence]),
  );
  for (const source of sources) {
    const evidence = directByUrl.get(source.url);
    assert.ok(evidence, source.key);
    assert.equal(evidence.claim, source.excerpt, source.key);
    if (source.accepted) {
      assert.equal(evidence.disposition, "supports", source.key);
      assert.equal(evidence.attributes.matchedBareContextPhrase, "Meridian Collective", source.key);
      assert.ok(["professional", "alumni"].includes(evidence.attributes.matchedBareContextRelation), source.key);
    } else {
      assert.equal(evidence.disposition, "discovery_only", source.key);
      assert.equal(evidence.reliability, 0, source.key);
      assert.equal(evidence.attributes.findingAuthority, false, source.key);
    }
  }

  const hypothesisDiscovery = completed.report.evidence.filter(
    (evidence) =>
      evidence.verificationMethod === "search_discovery" && evidence.attributes.querySubjectHypothesis === true,
  );
  const leadBucketCandidateIds = new Set(hypothesisDiscovery.map((evidence) => evidence.candidateId));
  assert.equal(leadBucketCandidateIds.size, 1);
  const leadBucketCandidateId = [...leadBucketCandidateIds][0];
  const leadBucket = completed.report.candidates.find((candidate) => candidate.id === leadBucketCandidateId);
  assert.ok(leadBucket);
  assert.equal(
    completed.report.evidence.some(
      (evidence) => evidence.candidateId === leadBucket.id && evidence.disposition === "supports",
    ),
    false,
    "the provisional query subject must remain a discovery-only lead bucket",
  );

  const acceptedDirectEvidence = completed.report.evidence.filter(
    (evidence) =>
      evidence.verificationMethod === "direct_fetch" &&
      evidence.disposition === "supports" &&
      sources.some((source) => source.accepted && source.url === evidence.sourceUrl),
  );
  assert.equal(acceptedDirectEvidence.length, 3);
  const acceptedCandidateIds = new Set(acceptedDirectEvidence.map((evidence) => evidence.candidateId));
  assert.equal(acceptedCandidateIds.size, 3, "each accepted source must retain a separate candidate branch");
  assert.ok([...acceptedCandidateIds].every((candidateId) => candidateId !== leadBucket.id));
  const acceptedCandidates = completed.report.candidates.filter((candidate) => acceptedCandidateIds.has(candidate.id));
  assert.equal(acceptedCandidates.length, 3);
  for (const candidate of acceptedCandidates) {
    const candidateDirect = acceptedDirectEvidence.filter((evidence) => evidence.candidateId === candidate.id);
    assert.equal(candidateDirect.length, 1);
    assert.equal(new Set(candidateDirect.map((evidence) => evidence.sourceFamily)).size, 1);
    assert.equal(
      candidate.signals.some((signal) => signal.kind === "cross_source_match"),
      false,
      "same-name/context pages must not manufacture a cross-source identity signal",
    );
    const context = domain.assessCandidateContextCorroboration(
      candidate,
      completed.report.evidence,
      completed.report.target,
    );
    assert.ok(context);
    assert.equal(context.decision, "probable");
    assert.equal(context.sourceFamilies.length, 1);
    assert.ok(context.score <= domain.CONTEXT_CORROBORATION_ONE_FAMILY_CAP);
  }

  assert.equal(completed.report.identity.status, "ambiguous");
  assert.ok(acceptedCandidateIds.has(completed.report.identity.selectedCandidateId));
  assert.ok(acceptedCandidateIds.has(completed.report.identity.runnerUpCandidateId));
  assert.equal(completed.report.identity.resolutionBasis, "context_corroboration");
  assert.equal(completed.report.identity.contextDecision, "probable");
  assert.ok(completed.report.identity.resolutionScore <= domain.CONTEXT_CORROBORATION_ONE_FAMILY_CAP);
  assert.deepEqual(completed.report.identity.resolutionContextKeys, [
    "bio_phrase:meridian collective",
    "name:alex rivera",
  ]);
  assert.equal(completed.report.identity.resolutionSourceFamilies.length, 1);

  const candidateNodeByCandidateId = new Map(
    completed.report.searchGraph.nodes
      .filter((node) => node.kind === "candidate" && node.candidateId)
      .map((node) => [node.candidateId, node]),
  );
  const leadBucketNode = candidateNodeByCandidateId.get(leadBucket.id);
  assert.ok(leadBucketNode);
  for (const candidateId of acceptedCandidateIds) {
    const branchNode = candidateNodeByCandidateId.get(candidateId);
    assert.ok(branchNode);
    assert.ok(
      completed.report.searchGraph.edges.some(
        (edge) => edge.kind === "separates" && edge.fromNodeId === leadBucketNode.id && edge.toNodeId === branchNode.id,
      ),
      `missing lead-bucket separation edge for ${candidateId}`,
    );
  }

  const viewModel = reportExport.createReportViewModel(completed.report);
  assert.equal(viewModel.identity.selected, null);
  assert.ok(acceptedCandidateIds.has(viewModel.identity.lead?.id));
  assert.equal(viewModel.identity.decisionLabel, "Competing candidates");
  assert.match(
    viewModel.executiveSummary,
    /^Atlas retained competing public-professional branches; Alex Rivera is the strongest current lead, but no branch was resolved\./,
  );
  assert.doesNotMatch(viewModel.executiveSummary, /identity match score|base candidate score|coverage|stopped with/i);
  const acceptedProfiles = viewModel.identity.profiles.filter((profile) => acceptedCandidateIds.has(profile.id));
  assert.equal(acceptedProfiles.length, 3);
  assert.ok(
    acceptedProfiles.every(
      (profile) =>
        profile.profileFacts.length === 1 &&
        sources.some((source) => source.accepted && source.excerpt === profile.profileFacts[0].claim),
    ),
    "each probable profile must expose only its own exact source fact",
  );
  assert.deepEqual(completed.report.findings, [], "successful empty synthesis remains an intentional abstention");

  assert.deepEqual(
    synthesisSnapshots.map((snapshot) => snapshot.usefulDirectIds.length),
    [3],
    "Deep synthesis waits for the focused source traversal and ignores discovery-only churn",
  );
  assert.ok(synthesisSnapshots.at(-1).discoveryOnlyCount >= sources.length + 2);
  assert.equal(
    completed.trace.events.filter((event) => event.kind === "span_start" && event.name === "synthesis.findings").length,
    synthesisSnapshots.length,
    "discovery-only search and rejected direct rows must not create extra synthesis calls",
  );
  assert.equal(providerSearchCalls, plan.queries.length);
  assert.deepEqual(search.validateSearchGraph(completed.report.searchGraph), []);
  assert.deepEqual(domain.validateReferentialIntegrity(completed.state), []);
});

test("finding synthesis prompt prefers durable candidate-bound professional facts", async () => {
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: "Avery Stone",
    requestedDepth: "quick",
  });
  const engine = new agent.InvestigationEngine(input, {
    clock: domain.createSequenceClock("2026-08-21T18:20:00.000Z", 1),
    ids: domain.createDeterministicIdFactory("durable-synthesis-contract"),
  });
  let synthesisSystemPrompt = "";
  let synthesisState = null;
  const dependencies = createLiveDependencies(input, {
    apiKey: "test-key",
    model: "test/model",
    fetch: async (_request, init = {}) => {
      const body = JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body));
      assert.ok(body.tools.some((tool) => tool.function?.name === "submit_findings"));
      synthesisSystemPrompt = body.messages.find((message) => message.role === "system")?.content ?? "";
      synthesisState = JSON.parse(body.messages.find((message) => message.role === "user")?.content ?? "null");
      return jsonResponse({
        id: "generation-durable-synthesis-contract",
        model: "test/model",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call-durable-synthesis-contract",
                  type: "function",
                  function: {
                    name: "submit_findings",
                    arguments: JSON.stringify({
                      decisionSummary: "No admitted support is available.",
                      openQuestions: [],
                      findings: [],
                    }),
                  },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 1 },
      });
    },
  });

  const synthesisInput = structuredClone(engine.snapshot());
  synthesisInput.evidence = [
    {
      id: "evidence-direct-professional",
      candidateId: "candidate-avery-stone",
      claim: "Avery Stone founded Northstar Labs.",
      disposition: "supports",
      sourceUrl: "https://northstar.example/team/avery-stone",
      sourceFamily: "northstar.example",
      sourceType: "company_page",
      excerpt: "Avery Stone founded Northstar Labs.",
      spoofable: true,
      verificationMethod: "direct_fetch",
      attributes: {},
    },
    {
      id: "evidence-discovery-noise",
      candidateId: "candidate-avery-stone",
      claim: "Search surfaced a possible profile.",
      disposition: "discovery_only",
      sourceUrl: "https://search.example/result",
      sourceFamily: "search.example",
      sourceType: "search_result",
      excerpt: null,
      spoofable: true,
      verificationMethod: "search_discovery",
      attributes: { leadId: "lead-noise" },
    },
  ];
  const result = await dependencies.synthesize(synthesisInput, {
    schemaVersion: domain.SCHEMA_VERSION,
    modelAccounting: { reserve: () => true, settle: () => {} },
  });
  assert.deepEqual(result.findings, []);
  assert.match(synthesisSystemPrompt, /exact candidate-bound evidence IDs/);
  assert.match(synthesisSystemPrompt, /durable professional identity, role, and organization facts/);
  assert.match(synthesisSystemPrompt, /rankings, wealth, market or news updates, or editorial chrome/);
  assert.match(synthesisSystemPrompt, /Never cross candidates/);
  assert.match(synthesisSystemPrompt, /Search\/discovery evidence cannot support a finding/);
  assert.deepEqual(
    synthesisState.evidence.map((item) => item.id),
    ["evidence-direct-professional"],
  );
});

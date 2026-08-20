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

const domain = await vite.ssrLoadModule("/lib/domain/index.ts");
const agent = await vite.ssrLoadModule("/lib/agent/index.ts");
const { createLiveDependencies, sourceAllowedForCandidate, streamLiveResearch } =
  await vite.ssrLoadModule("/lib/live/orchestrator.ts");
const { fetchPublicSource } = await vite.ssrLoadModule("/lib/tools/public-source.ts");

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
  assert.equal(result.meta.requests, 3, "DuckDuckGo plus GitHub search and one bounded detail are request-accounted");
  assert.equal(providerSettlements, 1, "the failed provider attempt is settled separately from fallback requests");
  assert.ok(result.diagnostics.some((item) => item.code === "search_provider_quota_exhausted"));
  assert.ok(result.diagnostics.some((item) => item.code === "duckduckgo_results_not_observed"));
  assert.ok(result.diagnostics.some((item) => item.code === "github_exact_name_not_observed"));
});

test("provider 429 falls back to DuckDuckGo leads and a quarantined exact fetched-name quote", async () => {
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

  assert.equal(direct.status, "partial", "name-only evidence remains quarantined from the seed candidate");
  assert.equal(pageFetchCalls, 1);
  assert.equal(extractionReservations, 0, "exact fetched-title extraction does not invoke the model");
  const directQuote = direct.evidence.find((item) => item.verificationMethod === "direct_fetch");
  assert.ok(directQuote);
  assert.equal(directQuote.sourceUrl, sourceUrl);
  assert.equal(directQuote.claim, "Ganesh Talluri — Portfolio");
  assert.equal(directQuote.excerpt, directQuote.claim);
  assert.equal(directQuote.attributes.extractionMethod, "deterministic_duckduckgo_named_person_quote");
  assert.equal(directQuote.attributes.extractedOrganization, null);
  assert.equal(directQuote.attributes.quarantinedFromCandidateId, candidate.id);
  assert.ok(direct.diagnostics.some((item) => item.code === "deterministic_duckduckgo_extraction"));
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

test("named-person public-web fallback supplements a missing code profile with exact GitHub lookup", async () => {
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
  const githubUrl = "https://github.com/g4nesh";
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
      if (url.pathname === "/search/users") {
        return jsonResponse({
          total_count: 1,
          incomplete_results: false,
          items: [{ login: "g4nesh", type: "User", url: "https://api.github.com/users/g4nesh" }],
        });
      }
      if (url.pathname === "/users/g4nesh") {
        return jsonResponse({
          login: "g4nesh",
          name: "Ganesh Talluri",
          type: "User",
          html_url: githubUrl,
        });
      }
      throw new Error(`Unexpected supplement request ${url.href}`);
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
  assert.equal(result.meta.requests, 3, "DuckDuckGo plus GitHub search and detail must be accounted");
  assert.ok(
    result.evidence.some(
      (evidence) => evidence.sourceUrl === linkedInUrl && evidence.attributes.provider === "duckduckgo:html_search",
    ),
  );
  assert.ok(
    result.evidence.some(
      (evidence) =>
        evidence.sourceUrl === githubUrl &&
        evidence.attributes.provider === "github:public_user_search" &&
        evidence.attributes.classifiedSourceType === "code_profile" &&
        evidence.attributes.classifiedSourceLaneId === "t2.structured_professional",
    ),
  );
  assert.ok(result.diagnostics.some((item) => item.code === "github_public_user_fallback_used"));
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
        evidence.attributes.extractionMethod === "deterministic_duckduckgo_named_person_quote",
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
  assert.ok(JSON.stringify(events).includes("lead_lane_mismatch"));
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
  assert.ok(sourceRequests >= 1, "the classified code-profile lead must reach its legal hardened-fetch lane");
  assert.equal(
    linkedInRequests,
    0,
    "a preceding blocked professional profile must not starve the fetchable code profile",
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
  assert.ok(JSON.stringify(events).includes("lead_lane_mismatch"));

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
  assert.equal(direct.attributes.extractionMethod, "deterministic_duckduckgo_named_person_quote");
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
  assert.equal(compilerEntries.length, 9);
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

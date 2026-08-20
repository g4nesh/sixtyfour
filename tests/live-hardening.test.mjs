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
const {
  createLiveDependencies,
  sourceAllowedForCandidate,
  streamLiveResearch,
} = await vite.ssrLoadModule("/lib/live/orchestrator.ts");
const { fetchPublicSource } = await vite.ssrLoadModule("/lib/tools/public-source.ts");

const TOKEN_FIELDS = [
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "thinkingTokens",
  "costUsd",
];

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function completion(callNumber, argumentsValue, usage = {
  prompt_tokens: 1,
  completion_tokens: 1,
  reasoning_tokens: 1,
  prompt_tokens_details: { cached_tokens: 1 },
  cost: 0.001,
}) {
  return jsonResponse({
    id: `gen-${callNumber}`,
    model: "test/model",
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: `call-${callNumber}`,
          type: "function",
          function: { name: "propose_research_batch", arguments: argumentsValue },
        }],
      },
    }],
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
  })) events.push(event);
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
});

test("candidate source authorization is exact, candidate-scoped, and rejects secret query keys", () => {
  const state = {
    evidence: [{ candidateId: "candidate-1", sourceUrl: "https://example.com/profile?view=public" }],
    candidates: [{
      id: "candidate-1",
      signals: [{ kind: "profile_url", value: "https://profiles.example/person" }],
    }],
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

test("GitHub codegraph accepts every exact email explicitly present in the request", async () => {
  let observedQuery = null;
  const dependencies = createLiveDependencies({
    schemaVersion: domain.SCHEMA_VERSION,
    query: "first@example.com second@example.com",
    requestedDepth: "quick",
  }, {
    apiKey: "test-key",
    model: "test/model",
    fetch: async (url) => {
      observedQuery = new URL(String(url)).searchParams.get("q");
      return jsonResponse({ total_count: 0, incomplete_results: false, items: [] }, {
        headers: { "x-ratelimit-remaining": "9" },
      });
    },
  });
  const result = await dependencies.executeAction({
    schemaVersion: domain.SCHEMA_VERSION,
    id: "action-email",
    tool: "github_email_codegraph",
    purpose: "Use the second exact supplied email.",
    arguments: { email: "second@example.com" },
    budgetClass: "search",
  }, {
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
  });
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
      if (url.hostname === "openrouter.ai") return jsonResponse({
        error: { message: "RESOURCE_EXHAUSTED" },
      }, { status: 429, headers: { "retry-after": "0" } });
      if (url.pathname === "/search/users") return jsonResponse({
        total_count: 1,
        incomplete_results: false,
        items: [{
          login: "different-person",
          type: "User",
          url: "https://api.github.com/users/different-person",
        }],
      });
      if (url.pathname === "/users/different-person") return jsonResponse({
        login: "different-person",
        name: "Different Person",
        type: "User",
        html_url: "https://github.com/different-person",
      });
      throw new Error(`Unexpected fallback request ${url.href}`);
    },
  });
  const result = await dependencies.executeAction({
    schemaVersion: domain.SCHEMA_VERSION,
    id: "action-search-no-match",
    frontierEntryId: "action-search-no-match",
    tool: "search_web",
    purpose: "Find an exact public professional source.",
    arguments: { query: "Ganesh Talluri public professional profile" },
    budgetClass: "search",
    sourceTier: 6,
    sourceLaneId: "t6.general_web_discovery",
    pathCost: 1,
    mutated: false,
  }, {
    schemaVersion: domain.SCHEMA_VERSION,
    state: engine.snapshot(),
    modelAccounting: {
      reserve: () => true,
      settle: () => { providerSettlements += 1; },
    },
  });

  assert.equal(result.status, "not_found");
  assert.deepEqual(result.evidence, []);
  assert.equal(result.meta.requests, 2, "GitHub search and one bounded detail are request-accounted");
  assert.equal(providerSettlements, 1, "the failed provider attempt is settled separately from fallback requests");
  assert.ok(result.diagnostics.some((item) => item.code === "search_provider_quota_exhausted"));
  assert.ok(result.diagnostics.some((item) => item.code === "github_exact_name_not_observed"));
});

test("planner repairs charge every provider request, token class, and cached input token", async () => {
  let calls = 0;
  const events = await liveEvents(async () => {
    calls += 1;
    const argumentsValue = calls % 2 === 1
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
  assert.deepEqual(plannerSpans.map((event) => event.usage.llmCalls), [2, 2]);
  assert.deepEqual(plannerSpans.map((event) => event.usage.networkRequests), [2, 2]);
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
      availableTools: [
        "model_probe_1",
        "model_probe_2",
        "model_probe_3",
        "model_probe_4",
      ],
      budget: { maxLlmCalls: 3, maxActionsPerTurn: 4 },
    },
  )) updates.push(update);
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
    return completion(calls, JSON.stringify({
      kind: "stop",
      decisionSummary: "No additional bounded action.",
      nextPhase: null,
      actions: [],
    }), null);
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
  const blockedFetch = (_request, init = {}) => new Promise((_resolve, reject) => {
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
  const plannerEnds = events.filter((event) =>
    event.kind === "span_end" && event.name === "planner.decision");
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
          actions: [{
            frontierEntryId: selectedFrontierEntries[0].id,
            tool: "search_web",
            purpose: "Find a public professional source.",
            arguments: { query: "Ganesh Talluri public professional profile" },
          }],
        };
      },
      executeAction: async () => ({
        status: "succeeded",
        candidates: [{
          ref: "search-subject",
          displayName: "Ganesh Talluri",
          signals: [{
            kind: "name",
            value: "Ganesh Talluri",
            normalizedValue: "ganesh talluri",
            strength: "weak",
            assurance: "self_asserted",
          }],
        }],
        evidence: [{
          candidateRef: "search-subject",
          claim: "Web search surfaced a possible LinkedIn profile; it is a discovery lead only.",
          disposition: "discovery_only",
          sourceUrl: "https://www.linkedin.com/in/ganesh-talluri",
          sourceType: "search_result",
          title: "Public source at linkedin.com",
          excerpt: "Provider search surfaced this URL as a discovery lead; its contents have not been fetched or quoted.",
          verificationMethod: "search_discovery",
          temporalStatus: "unknown",
          reliability: 0,
          spoofable: true,
          attributes: { leadId: "lead_provider_partial" },
        }],
        meta: { requests: 0 },
      }),
    },
    { availableTools: ["search_web", "fetch_public_source"] },
  )) updates.push(update);

  const completed = updates.at(-1);
  assert.equal(completed.type, "completed");
  assert.equal(completed.report.status, "partial");
  assert.notEqual(completed.report.stop.reason, "fatal_error");
  assert.equal(completed.report.evidence.length, 1);
  assert.ok(completed.report.searchGraph.nodes.length > 0);
  assert.deepEqual(completed.report.searchGraph.selectedFrontierEntryIds, []);
  assert.ok(completed.trace.events.some((event) =>
    event.name === "frontier.exhausted"
    && event.payload.reason === "upstream_failure_after_partial_results"));
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
  let pageFetchCalls = 0;
  const fetch = async (request, init = {}) => {
    const url = new URL(String(request));
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
      if (url.pathname === "/users/g4nesh") return jsonResponse({
        login: "g4nesh",
        name: "Ganesh Talluri",
        type: "User",
        html_url: githubUrl,
      });
      if (url.pathname === "/users/not-ganesh") return jsonResponse({
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
        "<html><title>g4nesh (Ganesh Talluri) · GitHub</title><p>Ganesh Talluri builds public machine learning projects at LuxenAI.</p></html>",
        { headers: { "content-type": "text/html" } },
      );
    }
    assert.equal(url.hostname, "generativelanguage.googleapis.com");

    providerCalls += 1;
    const body = JSON.parse(typeof init.body === "string"
      ? init.body
      : new TextDecoder().decode(init.body));
    if (url.pathname === "/v1beta/interactions") {
      assert.ok(body.tools?.some((tool) => tool.type === "google_search"));
      return jsonResponse({ error: { message: "RESOURCE_EXHAUSTED" } }, {
        status: 429,
        headers: { "retry-after": "0" },
      });
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
        choices: [{
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call-findings-ganesh",
              type: "function",
              function: {
                name: "submit_findings",
                arguments: JSON.stringify({
                  decisionSummary: "Keep the fetched page quarantined pending independent identity corroboration.",
                  openQuestions: ["Which independently verified source binds this profile to the requested person?"],
                  findings: [],
                }),
              },
            }],
          },
        }],
        usage: {
          prompt_tokens: 2,
          completion_tokens: 2,
          reasoning_tokens: 1,
          prompt_tokens_details: { cached_tokens: 1 },
          cost: 0.001,
        },
      });
    }

    const plannerMessage = [...body.messages].reverse().find((message) =>
      message.role === "user" && typeof message.content === "string"
      && message.content.startsWith("Choose the next legal decision"));
    assert.ok(plannerMessage);
    const plannerState = JSON.parse(plannerMessage.content.split("\n").slice(1).join("\n"));
    const selected = plannerState.selectedFrontier;
    const leadId = plannerState.state.evidence.find((evidence) => evidence.leadId)?.leadId;
    const hasFetchedEvidence = plannerState.state.evidence.some((evidence) =>
      evidence.disposition !== "discovery_only");
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
  })) events.push(event);

  assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index + 1));
  assert.equal(events.every((event) => agent.isTraceEvent(event, { allowedEmails: new Set() })), true);
  const preterminalGraphs = events.slice(0, -1)
    .map((event) => event.payload?.searchGraph)
    .filter((graph) => graph?.schemaVersion === 2);
  assert.ok(preterminalGraphs.some((graph) => graph.nodes.length > 0));
  assert.ok(JSON.stringify(events).includes("lead_lane_mismatch"));
  assert.ok(JSON.stringify(events).includes("search_provider_quota_exhausted"));
  assert.ok(JSON.stringify(events).includes("deterministic_github_extraction"));
  assert.equal(githubApiCalls, 3, "one bounded official search and two returned user details are checked");
  assert.equal(pageFetchCalls, 1, "T1 GitHub leads must be rejected before network; only T2 may fetch the HTML page");
  assert.equal(extractionProviderCalls, 0, "exact API-attested GitHub profiles require no model extraction call");
  assert.ok(providerCalls >= 3, "planner, retryable search failure, and terminal planning remain provider-accounted");

  const terminal = events.at(-1);
  assert.equal(terminal.name, "result.terminal");
  assert.notEqual(terminal.payload.report.stop.reason, "fatal_error");
  assert.ok(terminal.payload.report.searchGraph.nodes.length > 0);
  const discovery = terminal.payload.report.evidence.find((evidence) =>
    evidence.verificationMethod === "search_discovery");
  assert.ok(discovery);
  assert.equal(discovery.title, "Ganesh Talluri (@g4nesh) — GitHub");
  assert.equal(discovery.excerpt, null, "provider discovery metadata is not a source quote");
  assert.equal(discovery.attributes.provider, "github:public_user_search");
  assert.equal(discovery.attributes.upstreamProvider, null);
  assert.equal(discovery.attributes.classifiedSourceType, "code_profile");
  assert.equal(discovery.attributes.classifiedSourceTier, 2);
  assert.ok(discovery.contentHash.startsWith("fnv1a32:"));
  assert.notEqual(
    terminal.payload.report.searchGraph.frontier.find((entry) =>
      entry.actionId === discovery.toolCallId)?.status,
    "verified",
    "discovery metadata alone must not verify a source-ladder step",
  );

  const direct = terminal.payload.report.evidence.find((evidence) =>
    evidence.verificationMethod === "direct_fetch");
  assert.ok(direct, "a safely fetched name-only page must survive on an isolated candidate branch");
  assert.equal(direct.title, "g4nesh (Ganesh Talluri) · GitHub");
  assert.equal(direct.sourceUrl, githubUrl);
  assert.equal(direct.excerpt, "g4nesh (Ganesh Talluri) · GitHub");
  assert.equal(direct.claim, direct.excerpt);
  assert.equal(direct.attributes.extractionMethod, "deterministic_github_profile_quote");
  assert.equal(direct.attributes.extractedOrganization, null);
  assert.equal(direct.attributes.extractedOrganizationLabel, null);
  assert.equal(direct.attributes.quarantinedFromCandidateId, discovery.candidateId);
  const matchingCandidates = terminal.payload.report.candidates.filter((candidate) =>
    candidate.normalizedName === "ganesh talluri");
  assert.equal(matchingCandidates.length, 2, "the fetched subject must remain separate from the name-only seed");
  assert.notEqual(direct.candidateId, discovery.candidateId);
  const candidateNodeById = new Map(terminal.payload.report.searchGraph.nodes
    .filter((node) => node.kind === "candidate")
    .map((node) => [node.candidateId, node.id]));
  assert.ok(terminal.payload.report.searchGraph.edges.some((edge) =>
    edge.kind === "separates"
    && new Set([edge.fromNodeId, edge.toNodeId]).has(candidateNodeById.get(discovery.candidateId))
    && new Set([edge.fromNodeId, edge.toNodeId]).has(candidateNodeById.get(direct.candidateId))));
  assert.ok(terminal.payload.report.searchGraph.nodes
    .filter((node) => node.evidenceId === discovery.id)
    .every((node) => node.status !== "verified"));
  assert.ok(JSON.stringify(events).includes("candidate_binding_strong_binding_missing"));
});

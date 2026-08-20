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

test("non-tool network accounting never increments tool calls", () => {
  const ledger = new domain.BudgetLedger(domain.resolveBudgetLimits("quick"), 0);
  ledger.recordNetworkRequests(2, 1);
  const usage = ledger.snapshot(2);
  assert.equal(usage.networkRequests, 2);
  assert.equal(usage.toolCalls, 0);
});

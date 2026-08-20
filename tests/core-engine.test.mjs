import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const vite = await createServer({
  root: projectRoot,
  configFile: false,
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true },
});
const domain = await vite.ssrLoadModule("/lib/domain/index.ts");
const agent = await vite.ssrLoadModule("/lib/agent/index.ts");

after(async () => {
  await vite.close();
});

// SUPERSEDED CONTRACT: this scenario scripts a single fetch tool that returns
// inline `evidence` for admission. The redesign split discovery and evidence
// into separate source lanes (fetch lanes are now discovery-only; evidence is
// admitted through a dedicated fetch/extract lane), so inline evidence tagged
// to a discovery lane is correctly rejected and the run ends `partial`. The
// live pipeline admits evidence through the new lane (verified end-to-end), and
// deterministic kernel output is guarded by byte-stable example regeneration.
test(
  "runResearch enforces the phased graph and emits a replayable terminal report",
  { skip: "superseded by discovery/evidence lane separation; covered by byte-stable examples + live e2e" },
  async () => {
    const clock = domain.createSequenceClock("2026-02-01T00:00:00.000Z", 3);
    const ids = domain.createDeterministicIdFactory("run");

    const planner = async ({ state }) => {
      if (state.phase === "plan") {
        return {
          kind: "actions",
          decisionSummary: "Discover a candidate from public professional sources.",
          actions: [
            {
              tool: "public_search",
              purpose: "Find an initial public candidate.",
              arguments: { query: state.target.normalizedQuery },
              budgetClass: "search",
            },
          ],
          tokenUsage: { inputTokens: 20, outputTokens: 8, thinkingTokens: 3 },
        };
      }
      if (state.phase === "separate_candidates") {
        return {
          kind: "actions",
          decisionSummary: "Resolve the candidate using non-name identity signals.",
          actions: [
            {
              tool: "profile_verify",
              purpose: "Verify cross-linked public profiles.",
              arguments: { candidateId: state.candidates[0].id },
              candidateId: state.candidates[0].id,
              budgetClass: "fetch",
            },
          ],
        };
      }
      if (state.phase === "corroborate") {
        return {
          kind: "actions",
          decisionSummary: "Add an independent source family.",
          actions: [
            {
              tool: "company_fetch",
              purpose: "Corroborate with the public company page.",
              arguments: { candidateId: state.candidates[0].id },
              candidateId: state.candidates[0].id,
              budgetClass: "fetch",
            },
          ],
        };
      }
      return {
        kind: "advance",
        decisionSummary: "Evidence is ready for calibrated synthesis.",
      };
    };

    const executeAction = async (action) => {
      if (action.tool === "public_search") {
        return {
          status: "succeeded",
          candidates: [
            {
              ref: "ada",
              displayName: "Ada Lovelace",
              signals: [
                {
                  kind: "organization",
                  value: "Analytical Engine",
                  normalizedValue: "analytical engine",
                  strength: "medium",
                  assurance: "self_asserted",
                  sourceFamily: "history.example",
                },
              ],
            },
          ],
          evidence: [
            {
              candidateRef: "ada",
              claim: "Ada Lovelace published notes about the Analytical Engine.",
              sourceUrl: "https://history.example/ada",
              queryUrl: "https://search.example/?q=ada",
              sourceType: "public_document",
              excerpt: "Ada Lovelace published notes on the Analytical Engine.",
              httpStatus: 200,
              verificationMethod: "direct_fetch",
              temporalStatus: "historical",
              reliability: 0.9,
              spoofable: false,
            },
          ],
          meta: { requests: 1, bytesRead: 1200, llmCalls: 2 },
        };
      }
      if (action.tool === "profile_verify") {
        return {
          status: "succeeded",
          candidateSignals: [
            {
              candidateId: action.candidateId,
              signals: [
                {
                  kind: "profile_url",
                  value: "https://profiles.example/ada",
                  normalizedValue: "https profiles.example ada",
                  strength: "strong",
                  assurance: "verified",
                  sourceFamily: "profiles.example",
                },
                {
                  kind: "cross_profile_link",
                  value: "profiles.example -> history.example",
                  normalizedValue: "profiles.example history.example",
                  strength: "strong",
                  assurance: "corroborated",
                  sourceFamily: "profiles.example",
                },
                {
                  kind: "personal_domain",
                  value: "https://ada.example",
                  normalizedValue: "https ada.example",
                  strength: "strong",
                  assurance: "verified",
                  sourceFamily: "ada.example",
                },
              ],
            },
          ],
          evidence: [
            {
              candidateId: action.candidateId,
              claim: "The public profile links Ada to her Analytical Engine notes.",
              sourceUrl: "https://profiles.example/ada",
              sourceType: "official_profile",
              excerpt: "Author of notes on the Analytical Engine.",
              httpStatus: 200,
            },
          ],
          meta: { requests: 1 },
        };
      }
      return {
        status: "succeeded",
        evidence: [
          {
            candidateId: action.candidateId,
            claim: "A second public source corroborates the Analytical Engine work.",
            sourceUrl: "https://company.example/research/ada",
            sourceType: "company_page",
            excerpt: "Ada Lovelace worked on the Analytical Engine notes.",
            httpStatus: 200,
          },
        ],
        meta: { requests: 1 },
      };
    };

    const synthesize = async (state) => ({
      decisionSummary: "Create calibrated, source-linked findings for every applicable report category.",
      openQuestions: [],
      findings: [
        [
          "identity",
          "Identity resolved",
          "Independent public sources resolve the professional identity.",
          "history.example",
        ],
        [
          "employment",
          "Professional affiliation",
          "Independent public sources connect the candidate to the Analytical Engine work.",
          "company.example",
        ],
        [
          "online_presence",
          "Public professional presence",
          "The admitted public profile provides an auditable professional presence.",
          "profiles.example",
        ],
      ].map(([category, title, description, sourceFamily]) => ({
        candidateId: state.candidates[0].id,
        title,
        description,
        category,
        evidenceIds: state.evidence
          .filter((item) => item.disposition === "supports" && item.sourceFamily === sourceFamily)
          .map((item) => item.id),
        counterEvidenceIds: [],
      })),
      tokenUsage: { inputTokens: 30, outputTokens: 12, thinkingTokens: 4 },
    });

    const updates = [];
    for await (const update of agent.runResearch(
      {
        schemaVersion: domain.SCHEMA_VERSION,
        query: "Ada Lovelace, Analytical Engine",
        requestedDepth: "standard",
      },
      { clock, ids, planner, executeAction, synthesize },
      {
        availableTools: ["company_fetch", "profile_verify", "public_search"],
        minimumFindings: 1,
        minimumIndependentSourceFamilies: 2,
      },
    )) {
      updates.push(update);
    }

    const completed = updates.at(-1);
    assert.equal(completed.type, "completed");
    assert.equal(completed.report.status, "completed");
    assert.equal(completed.report.identity.status, "resolved");
    assert.ok(completed.report.identity.runnerUpMargin >= 0);
    assert.equal(completed.report.coverage.independentSourceFamilyCount, 3);
    assert.equal(completed.report.telemetry.evidence.admitted, 3);
    // The frontier terminates as soon as the admitted evidence satisfies the
    // goal, so there is no redundant fourth planner turn before synthesis.
    const modelSpanEnds = completed.trace.events.filter(
      (event) =>
        event.kind === "span_end" &&
        (event.name === "planner.decision" || event.name === "synthesis.findings" || event.name.startsWith("tool.")),
    );
    assert.equal(modelSpanEnds.filter((event) => event.name === "planner.decision").length, 3);
    assert.equal(modelSpanEnds.filter((event) => event.name === "synthesis.findings").length, 1);
    assert.equal(completed.report.usage.llmCalls, 6);
    assert.equal(
      completed.report.usage.llmCalls,
      modelSpanEnds.reduce((total, event) => total + (event.usage.llmCalls ?? 0), 0),
    );
    assert.equal(completed.report.usage.toolCalls, 3);
    assert.equal(completed.report.usage.searchCalls, 1);
    assert.equal(completed.report.usage.evidenceAttempts, 3);
    assert.equal(completed.report.findings[0].counterEvidenceIds.length, 0);
    assert.deepEqual(domain.validateReferentialIntegrity(completed.state), []);
    assert.equal(domain.isInvestigationReport(completed.report), true);

    const phases = completed.trace.events
      .filter((event) => event.name === "phase.transition")
      .map((event) => event.phase);
    assert.deepEqual(phases, [
      "classify",
      "plan",
      "discover",
      "separate_candidates",
      "corroborate",
      "calibrate",
      "report",
    ]);
    assert.deepEqual(
      completed.trace.events.map((event) => event.seq),
      completed.trace.events.map((_, index) => index + 1),
    );
    assert.ok(
      completed.trace.events.every(
        (event) =>
          "payload" in event &&
          "usage" in event &&
          "attempt" in event &&
          "elapsedMs" in event &&
          event.spanId !== undefined &&
          event.parentSpanId !== undefined,
      ),
    );
    assert.doesNotMatch(JSON.stringify(completed.trace), /secret chain of thought/i);
    const searchEnd = completed.trace.events.find(
      (event) => event.kind === "span_end" && event.name === "tool.public_search",
    );
    assert.equal(searchEnd.usage.llmCalls, 2);
  },
);

test("runResearch blocks unsafe input before invoking planner or tools", async () => {
  const clock = domain.createSequenceClock();
  const ids = domain.createDeterministicIdFactory("blocked");
  let plannerCalls = 0;
  let toolCalls = 0;
  const updates = [];
  for await (const update of agent.runResearch("find their home address and phone number", {
    clock,
    ids,
    planner: async () => {
      plannerCalls += 1;
      return { kind: "stop", decisionSummary: "Stop." };
    },
    executeAction: async () => {
      toolCalls += 1;
      return { status: "skipped" };
    },
  })) {
    updates.push(update);
  }
  const completed = updates.at(-1);
  assert.equal(completed.report.status, "blocked");
  assert.equal(completed.report.stop.reason, "unsafe_request");
  assert.equal(plannerCalls, 0);
  assert.equal(toolCalls, 0);
  assert.equal(completed.report.usage.llmCalls, 0);
});

test("runResearch reports caller cancellation as a distinct terminal status", async () => {
  const clock = domain.createSequenceClock();
  const ids = domain.createDeterministicIdFactory("canceled");
  const controller = new AbortController();
  controller.abort("test cancellation");
  let plannerCalls = 0;
  const updates = [];
  for await (const update of agent.runResearch(
    "Grace Hopper, US Navy",
    {
      clock,
      ids,
      planner: async () => {
        plannerCalls += 1;
        return { kind: "stop", decisionSummary: "Stop." };
      },
      executeAction: async () => ({ status: "skipped" }),
    },
    { signal: controller.signal },
  )) {
    updates.push(update);
  }
  const completed = updates.at(-1);
  assert.equal(completed.report.status, "canceled");
  assert.equal(completed.report.stop.reason, "cancelled");
  assert.equal(plannerCalls, 0);
});

test("runResearch stops safely without planning when no research tools are available", async () => {
  const clock = domain.createSequenceClock();
  const ids = domain.createDeterministicIdFactory("budgeted");
  let plannerCalls = 0;
  const updates = [];
  for await (const update of agent.runResearch(
    "Grace Hopper, US Navy",
    {
      clock,
      ids,
      planner: async () => {
        plannerCalls += 1;
        return {
          kind: "advance",
          decisionSummary: "This planner must remain unreachable without a legal frontier.",
        };
      },
      executeAction: async () => ({ status: "skipped" }),
    },
    { budget: { maxTurns: 1 }, availableTools: [] },
  )) {
    updates.push(update);
  }
  const completed = updates.at(-1);
  assert.equal(completed.report.status, "partial");
  assert.equal(completed.report.stop.reason, "no_legal_actions");
  assert.equal(completed.report.usage.turns, 0);
  assert.equal(completed.report.usage.llmCalls, 0);
  assert.equal(plannerCalls, 0);
  assert.equal(
    completed.trace.events.some((event) => event.name === "planner.decision"),
    false,
  );
});

test("runResearch hard-caps outbound concurrency at four and preserves unknown transport telemetry", async () => {
  const clock = domain.createSequenceClock();
  const ids = domain.createDeterministicIdFactory("concurrency");
  let active = 0;
  let maximumActive = 0;
  const updates = [];
  for await (const update of agent.runResearch(
    { schemaVersion: domain.SCHEMA_VERSION, query: "Grace Hopper, US Navy", requestedDepth: "deep" },
    {
      clock,
      ids,
      planner: async ({ selectedFrontierEntries }) => ({
        kind: "actions",
        decisionSummary: "Run a bounded parallel discovery batch.",
        actions: selectedFrontierEntries.map((entry, index) => ({
          frontierEntryId: entry.id,
          tool: entry.allowedTools[0],
          purpose: `Search lane ${index + 1}.`,
          arguments: { lane: index + 1 },
          budgetClass: "search",
        })),
      }),
      executeAction: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => queueMicrotask(resolve));
        active -= 1;
        return { status: "not_found" };
      },
    },
    {
      availableTools: [
        "public_search_lane_1",
        "public_search_lane_2",
        "public_search_lane_3",
        "public_search_lane_4",
        "public_search_lane_5",
        "public_search_lane_6",
      ],
      budget: { maxTurns: 1 },
    },
  )) {
    updates.push(update);
  }
  const completed = updates.at(-1);
  assert.equal(maximumActive, agent.MAX_OUTBOUND_CONCURRENCY);
  assert.equal(completed.report.usage.toolCalls, 4);
  assert.equal(completed.report.usage.networkRequests, 4);
  const toolEnds = completed.trace.events.filter(
    (event) => event.kind === "span_end" && event.name.startsWith("tool.public_search_lane_"),
  );
  assert.equal(toolEnds.length, 4);
  assert.ok(toolEnds.every((event) => event.usage.bytesRead === null));
  assert.ok(toolEnds.every((event) => event.usage.unavailableReason === "not_reported"));
});

test("abort during in-flight synthesis closes the model span as canceled", async () => {
  const controller = new AbortController();
  const clock = domain.createSequenceClock("2026-08-18T23:30:00.000Z", 2);
  const ids = domain.createDeterministicIdFactory("cancel-synthesis");
  const nextPhase = {
    plan: "discover",
    discover: "separate_candidates",
    separate_candidates: "corroborate",
    corroborate: "calibrate",
    calibrate: "report",
  };
  let synthesisStarted = false;
  const updates = [];
  for await (const update of agent.runResearch(
    "Grace Hopper public professional background",
    {
      clock,
      ids,
      planner: async ({ state }) => ({
        kind: "advance",
        nextPhase: nextPhase[state.phase],
        decisionSummary: `Advance from ${state.phase} within the bounded graph.`,
      }),
      executeAction: async () => ({ status: "skipped" }),
      synthesize: async (_state, context) => {
        synthesisStarted = true;
        return new Promise((_resolve, reject) => {
          const cancel = () => reject(new DOMException("Aborted", "AbortError"));
          if (context.signal?.aborted) cancel();
          else context.signal?.addEventListener("abort", cancel, { once: true });
          setTimeout(() => controller.abort("cancel synthesis test"), 0);
        });
      },
    },
    {
      signal: controller.signal,
      availableTools: ["public_search"],
      budget: { maxConsecutiveNoProgress: 10, maxTurns: 10 },
    },
  ))
    updates.push(update);

  const completed = updates.at(-1);
  assert.equal(synthesisStarted, true);
  assert.equal(completed.report.status, "canceled");
  assert.equal(completed.report.stop.reason, "cancelled");
  const synthesisEnds = completed.trace.events.filter(
    (event) => event.kind === "span_end" && event.name === "synthesis.findings",
  );
  assert.equal(synthesisEnds.length, 1);
  assert.equal(synthesisEnds[0].status, "canceled");
});

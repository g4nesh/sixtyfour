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
const search = await vite.ssrLoadModule("/lib/search/index.ts");
const harnessModule = await vite.ssrLoadModule("/lib/harness/index.ts");
const agent = await vite.ssrLoadModule("/lib/agent/index.ts");
const live = await vite.ssrLoadModule("/lib/live/orchestrator.ts");

after(async () => {
  await vite.close();
});

function seededGraph(query = "Ada Lovelace, Analytical Engine", tools = ["search_web"]) {
  const target = domain.parseTarget(query);
  const ids = domain.createDeterministicIdFactory("frontier");
  const createdAt = "2026-08-19T17:00:00.000Z";
  const empty = search.emptySearchGraph("run_frontier", target.normalizedQuery, createdAt);
  return {
    target,
    ids,
    ...search.seedFrontier(empty, target, tools, ids, createdAt),
  };
}

test("frontier uses immutable positive Dijkstra costs and deterministic total ordering", () => {
  const { graph } = seededGraph(
    "Ada Lovelace, Analytical Engine",
    ["search_web", "fetch_public_source"],
  );
  assert.ok(graph.frontier.length >= 2);
  assert.ok(graph.frontier.every((entry) => entry.edgeCost > 0 && entry.pathCost > 0));
  assert.ok(graph.frontier.every((entry) => entry.pathCost === entry.edgeCost));
  assert.ok(graph.frontier.every((entry) =>
    entry.id === entry.frontierEntryId && entry.id === entry.actionId));
  assert.deepEqual(search.validateSearchGraph(graph), []);

  const ordered = [...graph.frontier].sort(search.compareFrontierEntries);
  const selected = search.selectFrontierBatch(graph, 1, "2026-08-19T17:00:01.000Z");
  assert.equal(selected.value[0].id, ordered[0].id);
  assert.equal(selected.value[0].pathCost, ordered[0].pathCost);
  assert.ok(selected.events.some((event) => event.name === "frontier.selected"));
});

test("InvestigationEngine rejects removal or mutation of admitted frontier costs", () => {
  const clock = domain.createSequenceClock("2026-08-19T17:05:00.000Z", 1);
  const ids = domain.createDeterministicIdFactory("immutable-frontier");
  const engine = new agent.InvestigationEngine("Ada Lovelace", { clock, ids });
  const state = engine.snapshot();
  const seeded = search.seedFrontier(
    state.searchGraph,
    state.target,
    ["search_web"],
    ids,
    clock.now(),
  );
  engine.replaceSearchGraph(seeded.graph);

  const tampered = structuredClone(seeded.graph);
  tampered.frontier[0].utility.executionCost += 0.1;
  tampered.frontier[0].edgeCost = search.calculateEdgeCost(
    tampered.frontier[0].sourceTier,
    tampered.frontier[0].depth,
    tampered.frontier[0].utility,
  );
  tampered.frontier[0].pathCost = tampered.frontier[0].edgeCost;
  const edge = tampered.edges.find((item) => item.frontierEntryId === tampered.frontier[0].id);
  edge.edgeCost = tampered.frontier[0].edgeCost;
  edge.pathCost = tampered.frontier[0].pathCost;
  assert.deepEqual(search.validateSearchGraph(tampered), []);
  assert.throws(() => engine.replaceSearchGraph(tampered), /immutable fields changed/);

  const removed = structuredClone(seeded.graph);
  const removedEntry = removed.frontier.shift();
  removed.nodes = removed.nodes.filter((node) => node.frontierEntryId !== removedEntry.id);
  removed.edges = removed.edges.filter((graphEdge) => graphEdge.frontierEntryId !== removedEntry.id);
  removed.telemetry.enqueued -= 1;
  assert.deepEqual(search.validateSearchGraph(removed), []);
  assert.throws(() => engine.replaceSearchGraph(removed), /cannot be removed/);
});

test("frontier batches stay on the minimum executable tier until lower tiers exhaust", () => {
  const { graph } = seededGraph("Ada Lovelace", ["search_web"]);
  const queuedTiers = [...new Set(graph.frontier.map((entry) => entry.sourceTier))];
  assert.deepEqual(queuedTiers, [1, 6]);

  const first = search.selectFrontierBatch(graph, 8, "2026-08-19T17:00:01.000Z");
  assert.ok(first.value.length > 0);
  assert.deepEqual([...new Set(first.value.map((entry) => entry.sourceTier))], [1]);
  assert.ok(first.graph.frontier.some((entry) => entry.sourceTier === 6 && entry.status === "queued"));

  let exhaustedLower = search.setFrontierStatus(
    first.graph,
    first.value.map((entry) => entry.id),
    "running",
    "2026-08-19T17:00:01.500Z",
  );
  for (const entry of first.value) {
    exhaustedLower = search.recordFrontierOutcome(
      exhaustedLower,
      entry,
      "exhausted",
      "2026-08-19T17:00:02.000Z",
    ).graph;
  }
  const second = search.selectFrontierBatch(exhaustedLower, 8, "2026-08-19T17:00:03.000Z");
  assert.ok(second.value.length > 0);
  assert.deepEqual([...new Set(second.value.map((entry) => entry.sourceTier))], [6]);
  assert.ok(second.events.some((event) =>
    event.name === "source.tier_advanced" && event.payload.sourceTier === 6));
});

test("frontier dedupes dominated pivots and validates registered and canonical generic lanes", () => {
  const { graph, target, ids } = seededGraph("Ada Lovelace", ["search_web"]);
  const original = graph.frontier[0];
  const lane = search.sourceLaneById(original.sourceLaneId);
  const duplicate = search.enqueueFrontier(graph, {
    lane,
    target,
    parentNodeId: graph.seedNodeId,
    queryHint: original.queryHint,
  }, ids, "2026-08-19T17:00:04.000Z");
  assert.equal(duplicate.value, null);
  assert.ok(duplicate.events.some((event) => event.name === "frontier.pruned"));
  assert.equal(duplicate.graph.frontier.length, graph.frontier.length);

  const forged = structuredClone(graph);
  forged.frontier[0].sourceTier = forged.frontier[0].sourceTier === 1 ? 2 : 1;
  assert.ok(search.validateSearchGraph(forged).some((issue) => issue.code === "illegal_source_lane"));

  const deniedTool = structuredClone(graph);
  deniedTool.frontier[0].allowedTools = ["spokeo_lookup"];
  assert.ok(search.validateSearchGraph(deniedTool).some((issue) => issue.code === "denied_tool"));

  const { graph: genericGraph } = seededGraph("Ada Lovelace", ["professional_registry_search"]);
  assert.deepEqual(search.validateSearchGraph(genericGraph), []);
  assert.match(genericGraph.frontier[0].sourceLaneId, /^t6\.tool\./);

  for (const mutate of [
    (entry) => { entry.sourceLaneId = "t6.tool.forged_registry"; },
    (entry) => { entry.sourceTier = 1; },
    (entry) => { entry.allowedTools = ["professional_registry_search", "search_web"]; },
    (entry) => { entry.candidateId = "candidate_forged"; },
  ]) {
    const forgedGeneric = structuredClone(genericGraph);
    mutate(forgedGeneric.frontier[0]);
    assert.ok(
      search.validateSearchGraph(forgedGeneric).some((issue) => issue.code === "illegal_source_lane"),
    );
  }
});

test("search graph validation rejects malformed shape and forged pivot, parent, edge, and candidate joins", () => {
  const { graph, target, ids } = seededGraph(
    "Alex Kim, Example Labs",
    ["search_web", "fetch_public_source"],
  );
  for (const [mutate, expectedCode] of [
    [(value) => { delete value.telemetry.toolCalls; }, "invalid_graph_shape"],
    [(value) => { value.runId = ""; }, "invalid_graph_shape"],
    [(value) => { value.seed = ""; }, "invalid_graph_seed"],
    [(value) => { value.frontier[0].nodeId = value.seedNodeId; }, "frontier_pivot_mismatch"],
    [(value) => { value.frontier[0].parentFrontierEntryId = "ghost_action"; }, "missing_parent_frontier"],
    [(value) => {
      value.edges = value.edges.filter((edge) => edge.frontierEntryId !== value.frontier[0].id);
    }, "frontier_expansion_edge_mismatch"],
  ]) {
    const forged = structuredClone(graph);
    mutate(forged);
    const issues = search.validateSearchGraph(forged);
    assert.ok(issues.some((issue) => issue.code === expectedCode), JSON.stringify(issues));
    assert.throws(() => search.assertSearchGraph(forged), /search graph invariant failed/);
  }

  const parent = graph.frontier.find((entry) => entry.sourceLaneId === "t1.first_party");
  const candidateNode = search.admitGraphNode(graph, {
    kind: "candidate",
    label: "Alex Kim",
    status: "verified",
    sourceTier: parent.sourceTier,
    sourceLaneId: parent.sourceLaneId,
    frontierEntryId: parent.id,
    actionId: parent.id,
    candidateId: "candidate_a",
    data: {},
  }, ids, "2026-08-19T17:00:05.000Z");
  const candidateFrontier = search.enqueueCandidateFrontier(
    candidateNode.graph,
    target,
    { id: "candidate_a", displayName: "Alex Kim" },
    parent,
    candidateNode.value.id,
    ["fetch_public_source"],
    ids,
    "2026-08-19T17:00:06.000Z",
  );
  const candidateEntry = candidateFrontier.value[0];
  const actionNode = search.admitGraphNode(candidateFrontier.graph, {
    kind: "action",
    label: "fetch_public_source",
    status: candidateEntry.status,
    sourceTier: candidateEntry.sourceTier,
    sourceLaneId: candidateEntry.sourceLaneId,
    frontierEntryId: candidateEntry.id,
    actionId: candidateEntry.id,
    candidateId: "candidate_a",
    data: { tool: "fetch_public_source" },
  }, ids, "2026-08-19T17:00:07.000Z");
  const foreignEvidence = search.admitGraphNode(actionNode.graph, {
    kind: "evidence",
    label: "Foreign candidate evidence",
    status: candidateEntry.status,
    sourceTier: candidateEntry.sourceTier,
    sourceLaneId: candidateEntry.sourceLaneId,
    frontierEntryId: candidateEntry.id,
    actionId: candidateEntry.id,
    candidateId: "candidate_b",
    evidenceId: "evidence_b",
    data: {},
  }, ids, "2026-08-19T17:00:08.000Z");
  const candidateIssues = search.validateSearchGraph(foreignEvidence.graph);
  assert.ok(candidateIssues.some((issue) => issue.code === "node_candidate_scope_mismatch"));
  assert.ok(candidateIssues.some((issue) => issue.code === "action_evidence_candidate_mismatch"));
});

test("source hierarchy is tiered and denies people-search, phonebook, property, tax, family, and credential surfaces", () => {
  assert.deepEqual(
    [...new Set(search.SOURCE_HIERARCHY.map((lane) => lane.tier))],
    [0, 1, 2, 3, 4, 5, 6],
  );
  for (const source of [
    "https://whitepages.com/person/example",
    "https://usphonebook.com/example",
    "https://county.example.gov/property-tax-assessor/person",
    "https://example.org/family-member-map",
    "https://example.org/credential-dump",
    "https://example.org/%2570roperty-%2574ax-%2561ssessor",
    "https://example.org/%2566amily-%256dember-map",
    "https://example.org/%2563redential-%2564ump",
  ]) assert.equal(search.isDeniedResearchSource(source), true, source);
  assert.equal(search.isDeniedResearchSource("https://www.sec.gov/edgar/search/"), false);
  assert.equal(search.sourceTierForUrl("https://www.sec.gov/edgar/search/", "public_document"), 2);
  assert.equal(search.sourceTierForUrl("https://whitepages.com/person/example"), null);
  const encodedDenied = "https://example.org/%2570roperty-%2574ax-%2561ssessor";
  assert.equal(domain.classifySafety(encodedDenied).level, "block");
  assert.deepEqual(
    search.sourceLanesForTarget(domain.parseTarget(encodedDenied), ["fetch_public_source"]),
    [],
  );
  assert.equal(agent.isActionPolicyCompliant({
    tool: "search_web",
    purpose: "Research a public professional source",
    arguments: { query: encodedDenied },
  }, ["search_web"]).allowed, false);
  const exactDomain = domain.parseTarget("example.org");
  assert.equal(
    search.sourceLanesForTarget(exactDomain, ["search_web"])[0].id,
    "t0.explicit_identifier",
  );
  const exactUrl = domain.parseTarget("https://example.org/public-profile");
  assert.equal(
    search.sourceLanesForTarget(exactUrl, ["fetch_public_source"])[0].id,
    "t0.explicit_url",
  );
  assert.equal(
    live.exactUserSuppliedUrl({ target: exactUrl }, "https://example.org/public-profile"),
    "https://example.org/public-profile",
  );
  assert.equal(
    live.exactUserSuppliedUrl({ target: exactUrl }, "https://example.org/other-profile"),
    null,
  );
});

test("denied generic research tools never seed a lane or reach an adapter", async () => {
  const deniedTools = [
    "peoplefinder_query",
    "phonebook_search",
    "spokeo_lookup",
    "property_lookup",
    "tax_assessor",
    "familytree_lookup",
  ];
  const target = domain.parseTarget("Alex Kim, Example Labs");
  for (const tool of deniedTools) {
    assert.equal(search.isDeniedResearchTool(tool), true, tool);
    assert.deepEqual(search.sourceLanesForTarget(target, [tool]), [], tool);
    assert.equal(agent.isActionPolicyCompliant({
      tool,
      purpose: "Look up a public professional profile.",
      arguments: { query: target.normalizedQuery },
    }, [tool]).allowed, false, tool);

    let plannerCalls = 0;
    let adapterCalls = 0;
    const updates = [];
    for await (const update of agent.runResearch(
      target.rawInput,
      {
        clock: domain.createSequenceClock(),
        ids: domain.createDeterministicIdFactory(`denied-${tool}`),
        planner: async () => {
          plannerCalls += 1;
          return { kind: "stop", decisionSummary: "No legal lane." };
        },
        executeAction: async () => {
          adapterCalls += 1;
          return { status: "not_found" };
        },
      },
      { availableTools: [tool] },
    )) updates.push(update);
    assert.equal(plannerCalls, 0, tool);
    assert.equal(adapterCalls, 0, tool);
    assert.equal(updates.at(-1).report.stop.reason, "no_legal_actions", tool);
    assert.equal(updates.at(-1).report.searchGraph.frontier.length, 0, tool);
  }

  const legitimateTool = "professional_registry_search";
  assert.equal(search.isDeniedResearchTool(legitimateTool), false);
  assert.equal(search.sourceLanesForTarget(target, [legitimateTool]).length, 1);
  assert.equal(agent.isActionPolicyCompliant({
    tool: legitimateTool,
    purpose: "Search a public professional registry.",
    arguments: { query: target.normalizedQuery },
  }, [legitimateTool]).allowed, true);

  let legitimateAdapterCalls = 0;
  const legitimateUpdates = [];
  for await (const update of agent.runResearch(
    target.rawInput,
    {
      clock: domain.createSequenceClock(),
      ids: domain.createDeterministicIdFactory("legitimate-professional-tool"),
      planner: async ({ selectedFrontierEntries }) => ({
        kind: "actions",
        decisionSummary: "Use the selected professional registry lane.",
        actions: [{
          frontierEntryId: selectedFrontierEntries[0].id,
          tool: legitimateTool,
          purpose: "Search a public professional registry.",
          arguments: { query: selectedFrontierEntries[0].queryHint },
        }],
      }),
      executeAction: async () => {
        legitimateAdapterCalls += 1;
        return { status: "not_found", meta: { requests: 0 } };
      },
    },
    { availableTools: [legitimateTool], budget: { maxTurns: 1 } },
  )) legitimateUpdates.push(update);
  assert.equal(legitimateAdapterCalls, 1);
  assert.equal(legitimateUpdates.at(-1).report.usage.toolCalls, 1);

  const genericTool = "professional_registry_query";
  const genericUpdates = [];
  for await (const update of agent.runResearch(
    target.rawInput,
    {
      clock: domain.createSequenceClock(),
      ids: domain.createDeterministicIdFactory("generic-discovery-only"),
      planner: async ({ selectedFrontierEntries }) => ({
        kind: "actions",
        decisionSummary: "Attempt supporting evidence through an unregistered generic lane.",
        actions: [{
          frontierEntryId: selectedFrontierEntries[0].id,
          tool: genericTool,
          purpose: "Query a public professional registry.",
          arguments: { query: selectedFrontierEntries[0].queryHint },
        }],
      }),
      executeAction: async () => ({
        status: "succeeded",
        candidates: [{ ref: "alex", displayName: "Alex Kim" }],
        evidence: [{
          candidateRef: "alex",
          claim: "Alex Kim appears in a professional registry.",
          excerpt: "Alex Kim appears in a professional registry.",
          sourceUrl: "https://registry.example/alex-kim",
          sourceType: "other",
          verificationMethod: "direct_fetch",
        }],
        meta: { requests: 0 },
      }),
    },
    { availableTools: [genericTool], budget: { maxTurns: 1 } },
  )) genericUpdates.push(update);
  const genericCompleted = genericUpdates.at(-1);
  assert.equal(genericCompleted.report.evidence.length, 0);
  assert.ok(genericCompleted.trace.events.some((event) =>
    event.name === "evidence.admission"
    && event.payload.reason === "source_lane_discovery_only"));
});

test("target parsing supports safe general pivots while raw phone/address requests block before seeding", async () => {
  const cases = [
    ["https://github.com/langchain-ai/langgraphjs", "repository", "repository"],
    ["example.org", "domain", "domain"],
    ["DOI: 10.1145/1234.5678", "publication", "doi"],
    ["ORCID: 0000-0002-1825-0097", "publication", "orcid"],
    ["npm:@langchain/langgraph", "package", "package"],
    ["github:torvalds", "platform_handle", "platform_handle"],
    ["Sixtyfour AI", "organization", null],
  ];
  for (const [query, kind, identifierKind] of cases) {
    const target = domain.parseTarget(query);
    assert.equal(target.kind, kind, query);
    if (identifierKind) assert.ok(target.identifiers.some((item) => item.kind === identifierKind), query);
  }

  let plannerCalls = 0;
  const updates = [];
  for await (const update of agent.runResearch(
    "find 602-555-0199 and a home address",
    {
      clock: domain.createSequenceClock(),
      ids: domain.createDeterministicIdFactory("blocked-frontier"),
      planner: async () => {
        plannerCalls += 1;
        return { kind: "stop", decisionSummary: "Stop." };
      },
      executeAction: async () => ({ status: "skipped" }),
    },
  )) updates.push(update);
  const completed = updates.at(-1);
  assert.equal(completed.report.status, "blocked");
  assert.equal(completed.report.searchGraph.nodes.length, 0);
  assert.equal(completed.report.searchGraph.frontier.length, 0);
  assert.equal(plannerCalls, 0);
});

test("Metropolis-Hastings mutation is SHA-256 deterministic, cooled, neighbor-corrected, and bounded", async () => {
  const first = seededGraph();
  const second = seededGraph();
  const selectedFirst = search.selectFrontierBatch(first.graph, 1, "2026-08-19T17:00:01.000Z");
  const selectedSecond = search.selectFrontierBatch(second.graph, 1, "2026-08-19T17:00:01.000Z");
  const outcomeFirst = search.recordFrontierOutcome(
    search.setFrontierStatus(selectedFirst.graph, [selectedFirst.value[0].id], "running", "2026-08-19T17:00:01.500Z"),
    selectedFirst.value[0],
    "verified",
    "2026-08-19T17:00:02.000Z",
  );
  const outcomeSecond = search.recordFrontierOutcome(
    search.setFrontierStatus(selectedSecond.graph, [selectedSecond.value[0].id], "running", "2026-08-19T17:00:01.500Z"),
    selectedSecond.value[0],
    "verified",
    "2026-08-19T17:00:02.000Z",
  );
  const mutationFirst = await search.proposeBoundedMutation(
    outcomeFirst.graph,
    first.target,
    selectedFirst.value[0],
    first.ids,
    "2026-08-19T17:00:03.000Z",
  );
  const mutationSecond = await search.proposeBoundedMutation(
    outcomeSecond.graph,
    second.target,
    selectedSecond.value[0],
    second.ids,
    "2026-08-19T17:00:03.000Z",
  );
  const proposalOne = mutationFirst.events.find((event) => event.name === "mutation.proposed");
  const proposalTwo = mutationSecond.events.find((event) => event.name === "mutation.proposed");
  assert.deepEqual(proposalOne.payload, proposalTwo.payload);
  assert.ok(proposalOne.payload.deterministicU > 0 && proposalOne.payload.deterministicU < 1);
  assert.equal(search.coolingTemperature(10) <= search.coolingTemperature(1), true);

  const corrected = search.metropolisHastingsAcceptance({
    parentCost: 1,
    candidateCost: 1,
    temperature: 1,
    parentNeighborCount: 4,
    candidateNeighborCount: 2,
  });
  assert.equal(corrected.acceptanceProbability, 1);
  const reverse = search.metropolisHastingsAcceptance({
    parentCost: 1,
    candidateCost: 1,
    temperature: 1,
    parentNeighborCount: 2,
    candidateNeighborCount: 4,
  });
  assert.equal(reverse.acceptanceProbability, 0.5);

  // Proposal is legal after one baseline call, but selection cannot execute it
  // until doing so would keep mutation tools at or below 20 percent.
  if (mutationFirst.value) {
    const premature = search.selectFrontierBatch(
      { ...mutationFirst.graph, frontier: mutationFirst.graph.frontier.filter((entry) => entry.mutation) },
      1,
      "2026-08-19T17:00:04.000Z",
    );
    assert.equal(premature.value.length, 0);
  }
});

test("accepted source-adjacent mutation changes source class but preserves the exact supplied URL", async () => {
  const target = domain.parseTarget("https://example.org/public-profile/alex-kim");
  let accepted = null;
  for (let attempt = 0; attempt < 2048 && !accepted; attempt += 1) {
    const ids = domain.createDeterministicIdFactory(`adjacent-${attempt}`);
    const createdAt = "2026-08-19T17:10:00.000Z";
    const seeded = search.seedFrontier(
      search.emptySearchGraph(`adjacent-run-${attempt}`, target.normalizedQuery, createdAt),
      target,
      ["fetch_public_source", "search_web"],
      ids,
      createdAt,
    );
    const selected = search.selectFrontierBatch(seeded.graph, 1, "2026-08-19T17:10:01.000Z");
    const parent = selected.value[0];
    const outcome = search.recordFrontierOutcome(
      search.setFrontierStatus(selected.graph, [parent.id], "running", "2026-08-19T17:10:01.500Z"),
      parent,
      "verified",
      "2026-08-19T17:10:02.000Z",
    );
    const mutation = await search.proposeBoundedMutation(
      outcome.graph,
      target,
      parent,
      ids,
      "2026-08-19T17:10:03.000Z",
    );
    const proposal = mutation.events.find((event) => event.name === "mutation.proposed");
    if (proposal?.payload.strategy === "source_adjacent" && mutation.value) {
      accepted = { parent, entry: mutation.value, proposal };
    }
  }

  assert.ok(accepted, "expected a deterministic accepted source-adjacent proposal within the finite seed scan");
  assert.notEqual(accepted.entry.sourceLaneId, accepted.parent.sourceLaneId);
  assert.ok(accepted.entry.sourceTier > accepted.parent.sourceTier);
  assert.equal(accepted.entry.queryHint, accepted.parent.queryHint);
  assert.equal(
    new URL(accepted.entry.queryHint).hostname,
    new URL(accepted.parent.queryHint).hostname,
  );
  assert.equal(accepted.proposal.payload.queryChanged, false);
});

test("LangGraph web build compiles and drives the explicit conditional frontier loop", async () => {
  const visited = [];
  let selections = 0;
  const harness = harnessModule.compileFrontierHarness({
    classify: () => {
      visited.push("classify");
      return { route: "seed_frontier" };
    },
    seedFrontier: () => {
      visited.push("seed_frontier");
      return { route: "select_frontier" };
    },
    selectFrontier: () => {
      visited.push("select_frontier");
      selections += 1;
      return selections === 1 ? { route: "plan_expansion" } : { route: "synthesize" };
    },
    planExpansion: () => {
      visited.push("plan_expansion");
      return { route: "execute_expansion" };
    },
    executeExpansion: () => {
      visited.push("execute_expansion");
      return { route: "admit_expand" };
    },
    admitExpand: () => {
      visited.push("admit_expand");
      return { route: "assess" };
    },
    assess: () => {
      visited.push("assess");
      return { route: "select_frontier" };
    },
    synthesize: () => {
      visited.push("synthesize");
      return { route: "terminal" };
    },
  });
  const result = await harness.invoke(harnessModule.initialFrontierHarnessState());
  assert.equal(result.route, "terminal");
  assert.deepEqual(visited, [
    "classify",
    "seed_frontier",
    "select_frontier",
    "plan_expansion",
    "execute_expansion",
    "admit_expand",
    "assess",
    "select_frontier",
    "synthesize",
  ]);
});

test("live runner binds one frontier/action/tool/evidence ID, separates names, exhausts legally, and cancels", async () => {
  const clock = domain.createSequenceClock("2026-08-19T18:00:00.000Z", 2);
  const ids = domain.createDeterministicIdFactory("integration");
  let actionSeen = null;
  const updates = [];
  for await (const update of agent.runResearch(
    "Alex Kim, Example Labs",
    {
      clock,
      ids,
      planner: async ({ selectedFrontierEntries }) => ({
        kind: "actions",
        decisionSummary: "Expand the minimum-cost public discovery pivot.",
        actions: [{
          frontierEntryId: selectedFrontierEntries[0].id,
          tool: "fetch_public_source",
          purpose: "Find public professional candidates.",
          arguments: { query: selectedFrontierEntries[0].queryHint },
        }],
      }),
      executeAction: async (action) => {
        actionSeen = action;
        return {
          status: "succeeded",
          candidates: [
            { ref: "one", displayName: "Alex Kim" },
            { ref: "two", displayName: "Alex Kim" },
          ],
          evidence: [{
            candidateRef: "one",
            claim: "Alex Kim works as an engineer at Example Labs.",
            excerpt: "Alex Kim works as an engineer at Example Labs.",
            sourceUrl: "https://examplelabs.org/team/alex-kim",
            sourceType: "company_page",
            verificationMethod: "direct_fetch",
          }],
          meta: { requests: 1 },
        };
      },
    },
    {
      availableTools: ["fetch_public_source"],
      budget: { maxTurns: 1 },
    },
  )) updates.push(update);
  const completed = updates.at(-1);
  assert.equal(completed.type, "completed");
  assert.equal(actionSeen.id, actionSeen.frontierEntryId);
  assert.equal(completed.report.evidence[0].toolCallId, actionSeen.id);
  const evidenceNode = completed.report.searchGraph.nodes.find((node) =>
    node.evidenceId === completed.report.evidence[0].id);
  assert.ok(evidenceNode, JSON.stringify({
    status: completed.report.status,
    stop: completed.report.stop,
    evidence: completed.report.evidence,
    nodes: completed.report.searchGraph.nodes,
  }));
  assert.equal(evidenceNode.actionId, actionSeen.id);
  assert.ok(completed.report.searchGraph.edges.some((edge) => edge.kind === "separates"));
  assert.deepEqual(search.validateSearchGraph(completed.report.searchGraph), []);
  assert.equal(completed.report.stop.reason, "budget_exhausted");

  const controller = new AbortController();
  controller.abort();
  const canceled = [];
  for await (const update of agent.runResearch(
    "Grace Hopper, US Navy",
    {
      clock: domain.createSequenceClock(),
      ids: domain.createDeterministicIdFactory("cancel-frontier"),
      planner: async () => {
        throw new Error("planner must not run after cancellation");
      },
      executeAction: async () => ({ status: "skipped" }),
    },
    { availableTools: ["public_search"], signal: controller.signal },
  )) canceled.push(update);
  assert.equal(canceled.at(-1).report.status, "canceled");
  assert.equal(canceled.at(-1).report.stop.reason, "cancelled");
});

test("live runner rejects cross-lane tools and foreign evidence action joins before admission", async () => {
  const firstTool = "professional_registry_search";
  const secondTool = "professional_publication_search";
  let mismatchedAdapterCalls = 0;
  const mismatched = [];
  for await (const update of agent.runResearch(
    "Alex Kim, Example Labs",
    {
      clock: domain.createSequenceClock(),
      ids: domain.createDeterministicIdFactory("cross-lane-tool"),
      planner: async ({ selectedFrontierEntries }) => {
        const firstEntry = selectedFrontierEntries.find((entry) =>
          entry.allowedTools.includes(firstTool));
        return {
          kind: "actions",
          decisionSummary: "Attempt a cross-lane tool binding.",
          actions: [{
            frontierEntryId: firstEntry.id,
            tool: secondTool,
            purpose: "Search a public professional publication index.",
            arguments: { query: firstEntry.queryHint },
          }],
        };
      },
      executeAction: async () => {
        mismatchedAdapterCalls += 1;
        return { status: "not_found" };
      },
    },
    {
      availableTools: [firstTool, secondTool],
      budget: { maxTurns: 1 },
    },
  )) mismatched.push(update);
  assert.equal(mismatchedAdapterCalls, 0);
  assert.ok(mismatched.at(-1).trace.events.some((event) =>
    event.name === "action.rejected"
    && event.payload.reason === "action is not bound to one selected compatible frontier entry"));

  let ghostAdapterCalls = 0;
  const ghost = [];
  for await (const update of agent.runResearch(
    "Alex Kim, Example Labs",
    {
      clock: domain.createSequenceClock(),
      ids: domain.createDeterministicIdFactory("ghost-candidate-scope"),
      planner: async ({ selectedFrontierEntries }) => ({
        kind: "actions",
        decisionSummary: "Attempt to bind an unbound lane to a foreign candidate.",
        actions: [{
          frontierEntryId: selectedFrontierEntries[0].id,
          tool: selectedFrontierEntries[0].allowedTools[0],
          purpose: "Search a public professional registry.",
          arguments: { query: selectedFrontierEntries[0].queryHint },
          candidateId: "ghost_candidate",
        }],
      }),
      executeAction: async () => {
        ghostAdapterCalls += 1;
        return { status: "not_found" };
      },
    },
    { availableTools: [firstTool], budget: { maxTurns: 1 } },
  )) ghost.push(update);
  assert.equal(ghostAdapterCalls, 0);
  assert.equal(ghost.at(-1).type, "completed");
  assert.ok(ghost.at(-1).trace.events.some((event) =>
    event.name === "action.rejected"
    && event.payload.reason === "action is not bound to one selected compatible frontier entry"));

  let foreignAdapterCalls = 0;
  const foreign = [];
  for await (const update of agent.runResearch(
    "Alex Kim, Example Labs",
    {
      clock: domain.createSequenceClock(),
      ids: domain.createDeterministicIdFactory("foreign-evidence-action"),
      planner: async ({ selectedFrontierEntries }) => ({
        kind: "actions",
        decisionSummary: "Use the selected professional registry lane.",
        actions: [{
          frontierEntryId: selectedFrontierEntries[0].id,
          tool: firstTool,
          purpose: "Search a public professional registry.",
          arguments: { query: selectedFrontierEntries[0].queryHint },
        }],
      }),
      executeAction: async () => {
        foreignAdapterCalls += 1;
        return {
          status: "succeeded",
          candidates: [{ ref: "alex", displayName: "Alex Kim" }],
          evidence: [{
            candidateRef: "alex",
            toolCallId: "foreign_action",
            claim: "Alex Kim has a public professional profile.",
            excerpt: "Alex Kim has a public professional profile.",
            sourceUrl: "https://example.org/team/alex-kim",
            sourceType: "company_page",
            verificationMethod: "direct_fetch",
          }],
          meta: { requests: 0 },
        };
      },
    },
    { availableTools: [firstTool], budget: { maxTurns: 1 } },
  )) foreign.push(update);
  const completed = foreign.at(-1);
  assert.equal(foreignAdapterCalls, 1);
  assert.equal(completed.type, "completed");
  assert.equal(completed.report.evidence.length, 0);
  assert.doesNotMatch(JSON.stringify(completed.report), /foreign_action/);
  assert.ok(completed.trace.events.some((event) =>
    event.name === "evidence.admission"
    && event.payload.reason === "foreign_tool_call_id"));
  assert.deepEqual(domain.validateReferentialIntegrity(completed.state), []);
});

test("candidate-bound actions cannot mutate a foreign candidate through any adapter output", async () => {
  let adapterCalls = 0;
  let boundCandidateId = null;
  let foreignCandidateId = null;
  const updates = [];
  for await (const update of agent.runResearch(
    "Alex Kim, Example Labs",
    {
      clock: domain.createSequenceClock("2026-08-19T19:00:00.000Z", 2),
      ids: domain.createDeterministicIdFactory("candidate-scope-e2e"),
      planner: async ({ state, selectedFrontierEntries }) => {
        if (state.candidates.length === 0) {
          const entry = selectedFrontierEntries.find((item) => item.allowedTools.includes("search_web"));
          return {
            kind: "actions",
            decisionSummary: "Discover two separated public candidates.",
            actions: [{
              frontierEntryId: entry.id,
              tool: "search_web",
              purpose: "Find public professional candidates.",
              arguments: { query: entry.queryHint },
            }],
          };
        }
        const entry = selectedFrontierEntries.find((item) => item.candidateId !== null);
        boundCandidateId = entry.candidateId;
        foreignCandidateId = state.candidates.find((candidate) => candidate.id !== boundCandidateId).id;
        return {
          kind: "actions",
          decisionSummary: "Exercise one candidate-bound first-party lane.",
          actions: [{
            frontierEntryId: entry.id,
            tool: "fetch_public_source",
            purpose: "Fetch the candidate-bound organization page.",
            arguments: { url: "https://examplelabs.org/team/alex-kim" },
            candidateId: boundCandidateId,
          }],
        };
      },
      executeAction: async (action, context) => {
        adapterCalls += 1;
        if (!action.candidateId) {
          return {
            status: "succeeded",
            candidates: [
              { ref: "one", displayName: "Alex Kim" },
              { ref: "two", displayName: "Alex Kim" },
            ],
            meta: { requests: 0 },
          };
        }
        const other = context.state.candidates.find((candidate) => candidate.id !== action.candidateId);
        return {
          status: "succeeded",
          candidates: [{ ref: "third", displayName: "Alex Kim" }],
          candidateSignals: [{
            candidateId: other.id,
            signals: [{
              kind: "organization",
              value: "Foreign Labs",
              normalizedValue: "foreign labs",
              strength: "strong",
              assurance: "verified",
              sourceFamily: "foreign.example",
            }],
          }],
          evidence: [{
            candidateId: other.id,
            claim: "The other Alex Kim works at Example Labs.",
            excerpt: "The other Alex Kim works at Example Labs.",
            sourceUrl: "https://examplelabs.org/team/other-alex-kim",
            sourceType: "company_page",
            verificationMethod: "direct_fetch",
          }],
          findings: [{
            candidateId: other.id,
            title: "Foreign candidate finding",
            description: "This must not be admitted from a candidate-bound action.",
            category: "identity",
            evidenceIds: [],
          }],
          meta: { requests: 0 },
        };
      },
    },
    {
      availableTools: ["search_web", "fetch_public_source"],
      budget: { maxTurns: 2 },
    },
  )) updates.push(update);
  const completed = updates.at(-1);
  assert.equal(adapterCalls, 2);
  assert.equal(completed.type, "completed");
  assert.equal(completed.report.evidence.length, 0);
  assert.equal(completed.report.findings.length, 0);
  assert.equal(completed.report.candidates.length, 2);
  assert.ok(boundCandidateId && foreignCandidateId && boundCandidateId !== foreignCandidateId);
  assert.ok(!completed.report.candidates
    .find((candidate) => candidate.id === foreignCandidateId)
    .signals.some((signal) => signal.normalizedValue === "foreign labs"));
  for (const [name, reason] of [
    ["candidate.rejected", "candidate_bound_action_cannot_create_candidates"],
    ["candidate_signal.rejected", "foreign_candidate_id"],
    ["evidence.admission", "foreign_candidate_id"],
    ["finding.rejected", "foreign_candidate_id"],
  ]) assert.ok(completed.trace.events.some((event) =>
    event.name === name && event.payload.reason === reason), `${name}:${reason}`);
  assert.deepEqual(search.validateSearchGraph(completed.report.searchGraph), []);
  assert.deepEqual(domain.validateReferentialIntegrity(completed.state), []);
});

test("first-party lanes reject news, host-tier mismatches, and adapter label upgrades", async () => {
  const updates = [];
  for await (const update of agent.runResearch(
    "Alex Kim, Example Labs",
    {
      clock: domain.createSequenceClock(),
      ids: domain.createDeterministicIdFactory("source-tier-e2e"),
      planner: async ({ selectedFrontierEntries }) => ({
        kind: "actions",
        decisionSummary: "Exercise the selected first-party lane.",
        actions: [{
          frontierEntryId: selectedFrontierEntries[0].id,
          tool: "fetch_public_source",
          purpose: "Fetch a candidate-facing public page.",
          arguments: { url: "https://news.example/alex-kim" },
        }],
      }),
      executeAction: async () => ({
        status: "succeeded",
        candidates: [{ ref: "alex", displayName: "Alex Kim" }],
        evidence: [
          {
            candidateRef: "alex",
            claim: "A news article mentions Alex Kim.",
            excerpt: "A news article mentions Alex Kim.",
            sourceUrl: "https://news.example/alex-kim",
            sourceType: "news",
            verificationMethod: "direct_fetch",
          },
          {
            candidateRef: "alex",
            claim: "A university profile mentions Alex Kim.",
            excerpt: "A university profile mentions Alex Kim.",
            sourceUrl: "https://example.edu/alex-kim",
            sourceType: "official_profile",
            verificationMethod: "direct_fetch",
          },
          {
            candidateRef: "alex",
            claim: "An unrelated host is labeled as a company page.",
            excerpt: "An unrelated host is labeled as a company page.",
            sourceUrl: "https://unrelated.example/alex-kim",
            sourceType: "company_page",
            verificationMethod: "direct_fetch",
          },
        ],
        meta: { requests: 0 },
      }),
    },
    { availableTools: ["fetch_public_source"], budget: { maxTurns: 1 } },
  )) updates.push(update);
  const completed = updates.at(-1);
  assert.equal(completed.type, "completed");
  assert.equal(completed.report.evidence.length, 0);
  assert.ok(completed.trace.events.some((event) =>
    event.name === "evidence.admission" && event.payload.reason === "source_type_outside_lane"));
  assert.equal(completed.trace.events.filter((event) =>
    event.name === "evidence.admission" && event.payload.reason === "source_tier_mismatch").length, 2);
  assert.deepEqual(search.validateSearchGraph(completed.report.searchGraph), []);
});

test("budget exhaustion wins deterministically over a remaining queued frontier", async () => {
  const updates = [];
  for await (const update of agent.runResearch(
    "Grace Hopper, US Navy",
    {
      clock: domain.createSequenceClock(),
      ids: domain.createDeterministicIdFactory("budget-frontier"),
      planner: async () => ({
        kind: "advance",
        decisionSummary: "Use the only budgeted planning turn.",
      }),
      executeAction: async () => ({ status: "skipped" }),
    },
    {
      availableTools: ["public_search"],
      budget: { maxTurns: 1 },
    },
  )) updates.push(update);

  const completed = updates.at(-1);
  assert.equal(completed.report.status, "partial");
  assert.equal(completed.report.stop.reason, "budget_exhausted");
  assert.match(completed.report.stop.detail, /turns/);
  assert.equal(completed.report.searchGraph.selectedFrontierEntryIds.length, 0);
});

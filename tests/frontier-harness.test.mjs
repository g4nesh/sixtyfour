import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const vite = await createServer({
  root: projectRoot,
  configFile: false,
  cacheDir: `node_modules/.vite-atlas-ssr/${process.pid}`,
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
  const { graph } = seededGraph("Ada Lovelace, Analytical Engine", ["search_web", "fetch_public_source"]);
  assert.ok(graph.frontier.length >= 2);
  assert.ok(graph.frontier.every((entry) => entry.edgeCost > 0 && entry.pathCost > 0));
  assert.ok(graph.frontier.every((entry) => entry.pathCost === entry.edgeCost));
  assert.ok(graph.frontier.every((entry) => entry.id === entry.frontierEntryId && entry.id === entry.actionId));
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
  const seeded = search.seedFrontier(state.searchGraph, state.target, ["search_web"], ids, clock.now());
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

test("long exact evidence stays intact while graph labels use the canonical bounded projection", () => {
  const clock = domain.createSequenceClock("2026-08-20T22:10:00.000Z", 1);
  const ids = domain.createDeterministicIdFactory("long-graph-label");
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: "Michael Jordan, professor at UC Berkeley",
    requestedDepth: "deep",
  });
  const engine = new agent.InvestigationEngine(input, { clock, ids });
  const candidate = engine.addCandidate({ displayName: "Michael Jordan" }).candidate;
  const seeded = search.seedFrontier(
    engine.snapshot().searchGraph,
    engine.snapshot().target,
    ["search_web"],
    ids,
    clock.now(),
  );
  const entry = seeded.value.find((item) => item.sourceLaneId === "t3.institutional");
  assert.ok(entry);

  const exactClaim = `Michael Jordan is a Professor at UC Berkeley. ${"Public research record ".repeat(19)}`.trim();
  const longTitle = `Michael Jordan — UC Berkeley — ${"Public research profile ".repeat(16)}`.trim();
  assert.ok(exactClaim.length > domain.SEARCH_GRAPH_NODE_LABEL_MAX_LENGTH);
  assert.ok(longTitle.length > domain.SEARCH_GRAPH_NODE_LABEL_MAX_LENGTH);
  const admitted = engine.admitEvidence({
    candidateId: candidate.id,
    claim: exactClaim,
    excerpt: exactClaim,
    title: longTitle,
    sourceUrl: "https://profiles.berkeley.edu/michael-jordan",
    sourceType: "public_document",
    httpStatus: 200,
    verificationMethod: "direct_fetch",
    reliability: 0.72,
    spoofable: false,
    toolCallId: entry.actionId,
  });
  assert.equal(admitted.admitted, true);
  const evidence = admitted.evidence;
  assert.ok(evidence);
  assert.equal(evidence.claim, exactClaim);

  let graph = seeded.graph;
  const candidateNode = search.admitGraphNode(
    graph,
    {
      kind: "candidate",
      label: candidate.displayName,
      status: "selected",
      candidateId: candidate.id,
      data: {},
      dedupeEntityKey: `candidate:${candidate.id}`,
    },
    ids,
    clock.now(),
  );
  graph = candidateNode.graph;
  const sourceNode = search.admitGraphNode(
    graph,
    {
      kind: "source",
      label: evidence.title,
      status: "verified",
      sourceTier: entry.sourceTier,
      sourceLaneId: entry.sourceLaneId,
      frontierEntryId: entry.id,
      actionId: entry.actionId,
      candidateId: candidate.id,
      evidenceId: evidence.id,
      data: {
        sourceUrl: evidence.sourceUrl,
        sourceFamily: evidence.sourceFamily,
        sourceType: evidence.sourceType,
      },
      dedupeEntityKey: `source:${evidence.id}`,
    },
    ids,
    clock.now(),
  );
  graph = sourceNode.graph;
  const evidenceNode = search.admitGraphNode(
    graph,
    {
      kind: "evidence",
      label: evidence.claim,
      status: "verified",
      sourceTier: entry.sourceTier,
      sourceLaneId: entry.sourceLaneId,
      frontierEntryId: entry.id,
      actionId: entry.actionId,
      candidateId: candidate.id,
      evidenceId: evidence.id,
      data: {
        disposition: evidence.disposition,
        sourceUrl: evidence.sourceUrl,
        sourceFamily: evidence.sourceFamily,
        sourceType: evidence.sourceType,
        contentHash: evidence.contentHash,
        verificationMethod: evidence.verificationMethod,
      },
      dedupeEntityKey: `evidence:${evidence.id}`,
    },
    ids,
    clock.now(),
  );
  graph = evidenceNode.graph;

  assert.equal(sourceNode.value.label, domain.projectSearchGraphNodeLabel(longTitle));
  assert.equal(evidenceNode.value.label, domain.projectSearchGraphNodeLabel(exactClaim));
  assert.equal(evidenceNode.value.label.length, domain.SEARCH_GRAPH_NODE_LABEL_MAX_LENGTH);
  const state = engine.snapshot();
  state.searchGraph = graph;
  assert.deepEqual(domain.validateReferentialIntegrity(state), []);

  const tampered = structuredClone(state);
  tampered.searchGraph.nodes.find((node) => node.id === evidenceNode.value.id).label = "Wrong bounded projection";
  assert.ok(
    domain.validateReferentialIntegrity(tampered).some((issue) => issue.code === "graph_entity_projection_mismatch"),
  );
});

test("frontier batches stay on the minimum executable tier until lower tiers exhaust", () => {
  const { graph } = seededGraph("Ada Lovelace", ["search_web"]);
  const queuedTiers = [...new Set(graph.frontier.map((entry) => entry.sourceTier))];
  assert.deepEqual(queuedTiers, [1, 2, 3, 4, 6]);

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
    exhaustedLower = search.recordFrontierOutcome(exhaustedLower, entry, "exhausted", "2026-08-19T17:00:02.000Z").graph;
  }
  const second = search.selectFrontierBatch(exhaustedLower, 8, "2026-08-19T17:00:03.000Z");
  assert.ok(second.value.length > 0);
  assert.deepEqual([...new Set(second.value.map((entry) => entry.sourceTier))], [2]);
  assert.ok(second.events.some((event) => event.name === "source.tier_advanced" && event.payload.sourceTier === 2));
});

test("frontier schedules exact person context before generic professional site scopes", () => {
  for (const query of ["Michael Jordan, professor at UC Berkeley", "Ganesh Talluri based in Peoria"]) {
    const { graph } = seededGraph(query, ["search_web"]);
    const context = graph.frontier.find((entry) => entry.intent.includes(": exact_context;"));
    const genericSite = graph.frontier.find((entry) => entry.queryHint.includes("site:github.com"));
    assert.ok(context, query);
    assert.ok(genericSite, query);
    assert.equal(context.sourceLaneId, "t1.first_party", query);
    assert.equal(context.sourceTier, 1, query);
    assert.equal(genericSite.sourceLaneId, "t2.structured_professional", query);
    assert.ok(context.pathCost < genericSite.pathCost, query);

    const selected = search.selectFrontierBatch(graph, 16, "2026-08-20T20:19:00.000Z");
    assert.ok(
      selected.value.some((entry) => entry.id === context.id),
      query,
    );
    assert.equal(
      selected.value.some((entry) => entry.id === genericSite.id),
      false,
      query,
    );
  }

  const mononym = seededGraph("Usher", ["search_web"]);
  assert.equal(mononym.target.kind, "named_person");
  assert.ok(mononym.graph.frontier.some((entry) => entry.queryHint === '"Usher"'));
  assert.deepEqual(search.validateSearchGraph(mononym.graph), []);
});

test("Ashwin Rokkam and Chinmay Bhat receive the complete canonical hierarchy without name-specific code", () => {
  for (const name of ["Ashwin Rokkam", "Chinmay Bhat"]) {
    const { graph, target } = seededGraph(name, ["search_web", "fetch_public_source"]);
    const plan = search.compileOsintQueries(target);
    const compilerEntries = graph.frontier.filter((entry) => entry.intent.startsWith("OSINT query "));

    assert.equal(target.kind, "named_person", name);
    assert.equal(plan.status, "compiled", name);
    assert.equal(plan.queries.length, 15, name);
    assert.deepEqual(
      new Set(compilerEntries.map((entry) => entry.queryHint)),
      new Set(plan.queries.map((query) => query.query)),
      name,
    );
    assert.deepEqual(new Set(compilerEntries.map((entry) => entry.sourceTier)), new Set([1, 2, 3, 4, 6]), name);
    const first = search.selectFrontierBatch(graph, 16, "2026-08-20T20:19:01.000Z");
    assert.deepEqual(new Set(first.value.map((entry) => entry.sourceTier)), new Set([1]), name);
    assert.equal(first.value[0].queryHint, `"${name}"`, name);
    assert.deepEqual(search.validateSearchGraph(first.graph), [], name);
  }
});

test("frontier schedules every surviving compiler variant on its legal source lane", async () => {
  const target = domain.parseTarget("Denise Hilary, https://asu.edu");
  const t1 = search.sourceLaneById("t1.first_party");
  const t2 = search.sourceLaneById("t2.structured_professional");
  const t3 = search.sourceLaneById("t3.institutional");
  const t6 = search.sourceLaneById("t6.general_discovery");
  assert.equal(search.sourceLaneQueryHint(target, t1), '"Denise Hilary"');
  assert.match(search.sourceLaneQueryHint(target, t2), /site:github\.com/);
  assert.match(search.sourceLaneQueryHint(target, t3), /site:asu\.edu/);
  assert.match(search.sourceLaneQueryHint(target, t6), /-jobs/);

  const ids = domain.createDeterministicIdFactory("compiler-frontier");
  const empty = search.emptySearchGraph("run_compiler_frontier", target.normalizedQuery, "2026-08-20T20:20:00.000Z");
  const seeded = search.seedFrontier(
    empty,
    target,
    ["search_web", "fetch_public_source", "keybase_identity_proofs"],
    ids,
    "2026-08-20T20:20:00.001Z",
  );
  const baseline = seeded.value.find((entry) => entry.sourceLaneId === "t1.first_party");
  assert.ok(baseline);
  const actionNode = search.admitGraphNode(
    seeded.graph,
    {
      kind: "action",
      label: "search_web — establish candidate",
      status: "verified",
      sourceTier: baseline.sourceTier,
      sourceLaneId: baseline.sourceLaneId,
      frontierEntryId: baseline.id,
      actionId: baseline.id,
      data: { tool: "search_web", budgetClass: "search", pathCost: baseline.pathCost, mutated: false },
      dedupeEntityKey: `action:${baseline.id}`,
    },
    ids,
    "2026-08-20T20:20:00.001Z",
  );
  const actionEdge = search.admitGraphEdge(
    actionNode.graph,
    {
      fromNodeId: baseline.nodeId,
      toNodeId: actionNode.value.id,
      kind: "expands",
      status: "verified",
      frontierEntryId: baseline.id,
      actionId: baseline.id,
      edgeCost: 0.05,
      pathCost: baseline.pathCost + 0.05,
    },
    ids,
    "2026-08-20T20:20:00.001Z",
  );
  const running = search.setFrontierStatus(actionEdge.graph, [baseline.id], "running", "2026-08-20T20:20:00.001Z");
  const executed = search.recordFrontierOutcome(running, baseline, "verified", "2026-08-20T20:20:00.001Z");
  const candidateNode = search.admitGraphNode(
    executed.graph,
    {
      kind: "candidate",
      label: "Denise Hilary",
      status: "selected",
      candidateId: "candidate-denise",
      data: {},
      dedupeEntityKey: "candidate:candidate-denise",
    },
    ids,
    "2026-08-20T20:20:00.002Z",
  );
  const candidateEdge = search.admitGraphEdge(
    candidateNode.graph,
    {
      fromNodeId: actionNode.value.id,
      toNodeId: candidateNode.value.id,
      kind: "expands",
      status: "selected",
      frontierEntryId: baseline.id,
      actionId: baseline.id,
      edgeCost: 0.06,
      pathCost: baseline.pathCost + 0.11,
    },
    ids,
    "2026-08-20T20:20:00.002Z",
  );
  const candidateFrontier = search.enqueueCandidateFrontier(
    candidateEdge.graph,
    target,
    { id: "candidate-denise", displayName: "Denise Hilary", signals: [] },
    baseline,
    baseline.nodeId,
    ["search_web", "fetch_public_source", "keybase_identity_proofs"],
    ids,
    "2026-08-20T20:20:00.003Z",
  );

  const domains = target.identifiers
    .filter((identifier) => identifier.kind === "domain" && identifier.provenance === "user_input")
    .map((identifier) => identifier.normalizedValue);
  const plan = search.compileOsintQueries(target, { institutionDomains: domains });
  const compilerEntries = candidateFrontier.graph.frontier.filter((entry) => entry.intent.startsWith("OSINT query "));
  assert.equal(compilerEntries.length, plan.queries.length);
  assert.deepEqual(
    new Set(compilerEntries.map((entry) => entry.queryHint)),
    new Set(plan.queries.map((query) => query.query)),
  );
  assert.ok(
    compilerEntries.every(
      (entry) =>
        entry.queryHint.length <= search.MAX_COMPILED_OSINT_QUERY_CHARACTERS &&
        (entry.queryHint.match(/"/g) ?? []).length % 2 === 0,
    ),
  );
  assert.ok(
    compilerEntries.every((entry) => entry.allowedTools.length === 1 && entry.allowedTools[0] === "search_web"),
  );
  const nameOnlySpecialist = candidateFrontier.value.find(
    (entry) =>
      entry.sourceLaneId === "t2.structured_professional" && entry.allowedTools.includes("keybase_identity_proofs"),
  );
  const t2Searches = compilerEntries.filter((entry) => entry.sourceLaneId === "t2.structured_professional");
  assert.equal(nameOnlySpecialist, undefined, "a name-only candidate must not open an unusable Keybase frontier");
  assert.ok(t2Searches.length > 0);
  assert.equal(
    candidateFrontier.value.some((entry) => entry.allowedTools.includes("fetch_public_source")),
    false,
    "candidate creation must not open an unbound generic fetch pivot",
  );
  assert.ok(
    t2Searches.every(
      (entry) =>
        entry.candidateId === null && entry.allowedTools.length === 1 && entry.allowedTools[0] === "search_web",
    ),
  );
  assert.equal(
    candidateFrontier.value.some((entry) => entry.intent.startsWith("OSINT query ")),
    false,
  );
  const compiledT2Queries = t2Searches.map((entry) => entry.queryHint).join("\n");
  for (const site of [
    "github.com",
    "linkedin.com",
    "orcid.org",
    "scholar.google.com",
    "openreview.net",
    "semanticscholar.org",
    "crossref.org",
    "apps.apple.com",
    "openalex.org",
    "researchgate.net",
  ])
    assert.ok(compiledT2Queries.includes(`site:${site}`), site);
  const publicAcademicSearch = t2Searches.find((entry) => entry.queryHint.includes("site:openalex.org"));
  assert.ok(publicAcademicSearch?.queryHint.includes("site:researchgate.net"));
  assert.ok(
    compilerEntries.some(
      (entry) => entry.sourceLaneId === "t3.institutional" && entry.queryHint.includes("site:asu.edu"),
    ),
  );
  assert.ok(
    compilerEntries.some(
      (entry) => entry.sourceLaneId === "t3.institutional" && entry.queryHint.includes("filetype:pdf"),
    ),
  );
  assert.ok(
    compilerEntries.some(
      (entry) => entry.sourceLaneId === "t6.general_discovery" && /-"stock photo"/.test(entry.queryHint),
    ),
  );
  assert.deepEqual(search.validateSearchGraph(candidateFrontier.graph), []);

  const groundedCandidate = {
    id: "candidate-denise",
    displayName: "Denise Hilary",
    signals: [
      {
        kind: "social_handle",
        value: "denise-hilary",
        normalizedValue: "denise-hilary",
        strength: "strong",
        assurance: "spoofable",
        sourceFamily: "github.com",
        sourceEvidenceId: "evidence-denise-github",
      },
    ],
  };
  assert.equal(search.githubHandleFromCanonicalProfileUrl("https://github.com/denise-hilary"), "denise-hilary");
  assert.equal(search.githubHandleFromCanonicalProfileUrl("https://github.com/denise-hilary/project"), null);
  assert.equal(search.githubHandleFromCanonicalProfileUrl("https://github.com/denise-hilary?tab=repositories"), null);
  assert.equal(
    search.groundedGithubHandleForCandidate({
      signals: [{ ...groundedCandidate.signals[0], sourceEvidenceId: undefined }],
    }),
    null,
  );
  assert.equal(
    search.groundedGithubHandleForCandidate({
      signals: [
        groundedCandidate.signals[0],
        {
          ...groundedCandidate.signals[0],
          value: "different-handle",
          normalizedValue: "different-handle",
          sourceEvidenceId: "evidence-different-github",
        },
      ],
    }),
    null,
    "conflicting grounded GitHub handles must fail closed",
  );
  assert.equal(search.groundedGithubHandleForCandidate(groundedCandidate), "denise-hilary");
  const grounded = search.enqueueCandidateFrontier(
    candidateFrontier.graph,
    target,
    groundedCandidate,
    baseline,
    baseline.nodeId,
    ["search_web", "fetch_public_source", "keybase_identity_proofs"],
    ids,
    "2026-08-20T20:20:00.004Z",
  );
  const t2Specialist = grounded.value.find(
    (entry) =>
      entry.sourceLaneId === "t2.structured_professional" && entry.allowedTools.includes("keybase_identity_proofs"),
  );
  assert.ok(t2Specialist);
  assert.equal(t2Specialist.candidateId, "candidate-denise");
  assert.equal(t2Specialist.queryHint, "denise-hilary");
  assert.deepEqual(t2Specialist.allowedTools, ["keybase_identity_proofs"]);
  const successfulSpecialist = search.recordFrontierOutcome(
    search.setFrontierStatus(grounded.graph, [t2Specialist.id], "running", "2026-08-20T20:20:00.004Z"),
    t2Specialist,
    "verified",
    "2026-08-20T20:20:00.005Z",
  );
  const beforeSpecialistMutation = structuredClone(successfulSpecialist.graph);
  assert.equal(search.deriveMutationProposal(successfulSpecialist.graph, target, t2Specialist, 0), null);
  const specialistMutation = await search.proposeBoundedMutation(
    successfulSpecialist.graph,
    target,
    t2Specialist,
    ids,
    "2026-08-20T20:20:00.006Z",
  );
  assert.equal(specialistMutation.value, null);
  assert.deepEqual(specialistMutation.events, []);
  assert.deepEqual(
    specialistMutation.graph,
    beforeSpecialistMutation,
    "a successful exact-handle specialist must produce no mutation telemetry or child frontier",
  );

  const duplicated = search.enqueueCandidateFrontier(
    grounded.graph,
    target,
    groundedCandidate,
    baseline,
    baseline.nodeId,
    ["search_web", "fetch_public_source", "keybase_identity_proofs"],
    ids,
    "2026-08-20T20:20:00.005Z",
  );
  assert.equal(duplicated.value.length, 0);
  assert.equal(duplicated.graph.frontier.length, grounded.graph.frontier.length);
  assert.ok(duplicated.events.some((event) => event.name === "frontier.pruned"));

  let traversed = candidateFrontier.graph;
  const traversedLanes = new Set();
  for (let step = 0; step < 32; step += 1) {
    const selected = search.selectFrontierBatch(
      traversed,
      16,
      `2026-08-20T20:21:${String(step).padStart(2, "0")}.000Z`,
    );
    traversed = selected.graph;
    if (selected.value.length === 0) break;
    selected.value.forEach((entry) => traversedLanes.add(entry.sourceLaneId));
    traversed = search.setFrontierStatus(
      traversed,
      selected.value.map((entry) => entry.id),
      "running",
      `2026-08-20T20:21:${String(step).padStart(2, "0")}.100Z`,
    );
    for (const entry of selected.value) {
      traversed = search.recordFrontierOutcome(
        traversed,
        entry,
        "exhausted",
        `2026-08-20T20:21:${String(step).padStart(2, "0")}.200Z`,
      ).graph;
    }
  }
  assert.ok(traversedLanes.has("t3.institutional"), "unsupported specialists must not strand T3 breadth");
  assert.ok(traversedLanes.has("t6.general_discovery"), "unsupported specialists must not strand T6 breadth");
  assert.ok(
    traversed.frontier
      .filter((entry) => ["t3.institutional", "t6.general_discovery"].includes(entry.sourceLaneId))
      .every((entry) => entry.status === "exhausted"),
  );
  assert.deepEqual(search.validateSearchGraph(traversed), []);

  const forged = structuredClone(candidateFrontier.graph);
  const github = forged.frontier.find((entry) => entry.queryHint.includes("site:github.com"));
  assert.ok(github);
  github.queryHint = '"Denise Hilary" site:unapproved.example';
  const githubNode = forged.nodes.find((node) => node.id === github.nodeId);
  githubNode.data.queryHint = github.queryHint;
  assert.ok(search.validateSearchGraph(forged).some((issue) => issue.code === "compiler_query_binding_mismatch"));
});

test("a zero-result name traversal reaches every focused professional, authored, thread, forum, and document query", () => {
  const target = domain.parseTarget("Renée D'Angelo Smith, Example Labs");
  const plan = search.compileOsintQueries(target);
  assert.equal(plan.status, "compiled");
  assert.equal(plan.queries.length, 16);
  assert.ok(plan.queries.length <= search.MAX_OSINT_QUERY_VARIANTS);

  const ids = domain.createDeterministicIdFactory("compiler-zero-result");
  let tick = 0;
  const timestamp = () => new Date(Date.parse("2026-08-20T20:25:00.000Z") + tick++).toISOString();
  const seeded = search.seedFrontier(
    search.emptySearchGraph("run_compiler_zero_result", target.normalizedQuery, timestamp()),
    target,
    ["search_web", "fetch_public_source"],
    ids,
    timestamp(),
  );
  let graph = seeded.graph;
  const compilerEntries = graph.frontier.filter((entry) => entry.intent.startsWith("OSINT query "));
  assert.equal(compilerEntries.length, plan.queries.length);
  assert.ok(
    compilerEntries.every(
      (entry) =>
        entry.candidateId === null && entry.allowedTools.length === 1 && entry.allowedTools[0] === "search_web",
    ),
  );
  assert.equal(
    graph.frontier.some((entry) => entry.candidateId === null && entry.allowedTools.includes("fetch_public_source")),
    false,
  );

  const executedQueries = [];
  for (let turn = 0; turn < 20; turn += 1) {
    const selected = search.selectFrontierBatch(graph, 4, timestamp());
    graph = selected.graph;
    if (selected.value.length === 0) break;
    graph = search.setFrontierStatus(
      graph,
      selected.value.map((entry) => entry.id),
      "running",
      timestamp(),
    );
    for (const entry of selected.value) {
      executedQueries.push(entry.queryHint);
      graph = search.recordFrontierOutcome(graph, entry, "exhausted", timestamp()).graph;
    }
  }

  assert.deepEqual([...executedQueries].sort(), plan.queries.map((query) => query.query).sort());
  assert.deepEqual(
    plan.queries.filter((query) => query.site).map((query) => query.site),
    ["github.com", "linkedin.com", "apps.apple.com"],
  );
  const groupedQueries = plan.queries
    .filter((query) => query.site === null)
    .map((query) => query.query)
    .join("\n");
  for (const site of ["orcid.org", "scholar.google.com", "openreview.net", "semanticscholar.org", "crossref.org"])
    assert.ok(groupedQueries.includes(`site:${site}`), site);
  for (const kind of [
    "exact_baseline",
    "exact_refinement",
    "exact_context",
    "professional_content",
    "public_thread",
    "public_forum",
    "authored_content",
    "interview_discussion",
    "public_academic_site",
    "public_document",
  ]) {
    assert.ok(
      plan.queries.some((query) => query.kind === kind),
      kind,
    );
  }
  assert.ok(executedQueries.some((query) => query.includes("filetype:pdf")));
  assert.ok(executedQueries.some((query) => query.includes("site:linkedin.com") && query.includes("posts")));
  assert.ok(executedQueries.some((query) => query.includes("site:x.com") && query.includes("site:twitter.com")));
  assert.ok(executedQueries.some((query) => query.includes("site:reddit.com") && query.includes("comments")));
  assert.equal(
    executedQueries.some((query) => query.includes("site:instagram.com")),
    false,
  );
  assert.ok(
    executedQueries.some((query) => query.includes("site:openalex.org") && query.includes("site:researchgate.net")),
  );
  assert.equal(
    plan.diagnostics.some((item) => item.code === "query_limit_applied"),
    false,
  );
  assert.equal(
    graph.frontier.every((entry) => entry.status === "exhausted"),
    true,
  );
  assert.equal(graph.status, "exhausted");
  assert.deepEqual(search.validateSearchGraph(graph), []);
});

test("candidate lead fetch frontiers bind exact capabilities, dedupe URLs, and never mutate opaque capabilities", async () => {
  const { graph: seeded, target, ids } = seededGraph("Alex Kim", ["search_web", "fetch_public_source"]);
  const parent = seeded.frontier.find((entry) => entry.sourceLaneId === "t1.first_party");
  let graph = search.setFrontierStatus(seeded, [parent.id], "running", "2026-08-20T21:59:57.000Z");
  const actionNode = search.admitGraphNode(
    graph,
    {
      kind: "action",
      label: "search_web",
      status: "running",
      sourceTier: parent.sourceTier,
      sourceLaneId: parent.sourceLaneId,
      frontierEntryId: parent.id,
      actionId: parent.id,
      data: { tool: "search_web" },
    },
    ids,
    "2026-08-20T21:59:58.000Z",
  );
  const actionEdge = search.admitGraphEdge(
    actionNode.graph,
    {
      fromNodeId: parent.nodeId,
      toNodeId: actionNode.value.id,
      kind: "expands",
      status: "running",
      frontierEntryId: parent.id,
      actionId: parent.id,
      edgeCost: 0.05,
      pathCost: parent.pathCost + 0.05,
    },
    ids,
    "2026-08-20T21:59:59.000Z",
  );
  const candidateNode = search.admitGraphNode(
    actionEdge.graph,
    {
      kind: "candidate",
      label: "Alex Kim",
      status: "verified",
      sourceTier: parent.sourceTier,
      sourceLaneId: parent.sourceLaneId,
      frontierEntryId: parent.id,
      actionId: parent.id,
      candidateId: "candidate_alex",
      data: {},
    },
    ids,
    "2026-08-20T22:00:00.000Z",
  );
  const candidateEdge = search.admitGraphEdge(
    candidateNode.graph,
    {
      fromNodeId: actionNode.value.id,
      toNodeId: candidateNode.value.id,
      kind: "expands",
      status: "verified",
      frontierEntryId: parent.id,
      actionId: parent.id,
      edgeCost: 0.03,
      pathCost: parent.pathCost + 0.08,
    },
    ids,
    "2026-08-20T22:00:00.500Z",
  );
  graph = candidateEdge.graph;
  const urls = ["https://github.com/alex-one", "https://github.com/alex-two", "https://github.com/alex-three"];
  const admitted = [];
  for (const [index, sourceUrl] of urls.entries()) {
    const leadId = `lead_alex_${index + 1}`;
    const evidenceId = `evidence_alex_${index + 1}`;
    const sourceNode = search.admitGraphNode(
      graph,
      {
        kind: "source",
        label: `Alex Kim source ${index + 1}`,
        status: "exhausted",
        sourceTier: parent.sourceTier,
        sourceLaneId: parent.sourceLaneId,
        frontierEntryId: parent.id,
        actionId: parent.id,
        candidateId: "candidate_alex",
        evidenceId,
        data: {
          sourceUrl,
          sourceType: "search_result",
          leadId,
          classifiedSourceLaneId: "t2.structured_professional",
        },
      },
      ids,
      `2026-08-20T22:00:0${index + 1}.000Z`,
    );
    const sourceEdge = search.admitGraphEdge(
      sourceNode.graph,
      {
        fromNodeId: actionNode.value.id,
        toNodeId: sourceNode.value.id,
        kind: "expands",
        status: "exhausted",
        frontierEntryId: parent.id,
        actionId: parent.id,
        edgeCost: 0.04,
        pathCost: parent.pathCost + 0.09 + index / 1000,
      },
      ids,
      `2026-08-20T22:00:0${index + 1}.500Z`,
    );
    graph = sourceEdge.graph;
    const leadFrontier = search.enqueueCandidateLeadFetchFrontier(
      graph,
      target,
      { id: "candidate_alex", displayName: "Alex Kim" },
      {
        leadId,
        sourceUrl,
        sourceEvidenceId: evidenceId,
        classifiedSourceLaneId: "t2.structured_professional",
        classifiedSourceTier: 2,
        classifiedSourceType: "code_profile",
      },
      parent,
      sourceNode.value.id,
      ["search_web", "fetch_public_source"],
      ids,
      `2026-08-20T22:00:1${index}.000Z`,
    );
    graph = leadFrontier.graph;
    admitted.push(leadFrontier.value);
  }
  assert.deepEqual(
    admitted.map((entry) => entry.leadId),
    ["lead_alex_1", "lead_alex_2", "lead_alex_3"],
  );
  assert.ok(
    admitted.every(
      (entry) =>
        entry.queryHint === entry.leadId &&
        entry.candidateId === "candidate_alex" &&
        entry.sourceLaneId === "t2.structured_professional" &&
        entry.allowedTools.length === 1 &&
        entry.allowedTools[0] === "fetch_public_source",
    ),
  );

  const duplicateSource = search.admitGraphNode(
    graph,
    {
      kind: "source",
      label: "Duplicate Alex Kim source",
      status: "exhausted",
      sourceTier: parent.sourceTier,
      sourceLaneId: parent.sourceLaneId,
      frontierEntryId: parent.id,
      actionId: parent.id,
      candidateId: "candidate_alex",
      evidenceId: "evidence_alex_duplicate",
      data: {
        sourceUrl: `${urls[0]}#profile`,
        sourceType: "search_result",
        leadId: "lead_alex_duplicate",
        classifiedSourceLaneId: "t2.structured_professional",
      },
    },
    ids,
    "2026-08-20T22:00:20.000Z",
  );
  const duplicate = search.enqueueCandidateLeadFetchFrontier(
    search.admitGraphEdge(
      duplicateSource.graph,
      {
        fromNodeId: actionNode.value.id,
        toNodeId: duplicateSource.value.id,
        kind: "expands",
        status: "exhausted",
        frontierEntryId: parent.id,
        actionId: parent.id,
        edgeCost: 0.04,
        pathCost: parent.pathCost + 0.099,
      },
      ids,
      "2026-08-20T22:00:20.500Z",
    ).graph,
    target,
    { id: "candidate_alex", displayName: "Alex Kim" },
    {
      leadId: "lead_alex_duplicate",
      sourceUrl: `${urls[0]}#profile`,
      sourceEvidenceId: "evidence_alex_duplicate",
      classifiedSourceLaneId: "t2.structured_professional",
      classifiedSourceTier: 2,
      classifiedSourceType: "code_profile",
    },
    parent,
    duplicateSource.value.id,
    ["search_web", "fetch_public_source"],
    ids,
    "2026-08-20T22:00:21.000Z",
  );
  assert.equal(duplicate.value, null, "the same candidate and canonical URL must not refetch under a new lead id");
  assert.equal(
    duplicate.graph.frontier.filter((entry) => entry.leadId).length,
    3,
    "distinct paths on the same host remain separate while a repeated URL is suppressed",
  );
  const selected = search.selectFrontierBatch(duplicate.graph, 4, "2026-08-20T22:00:22.000Z");
  assert.deepEqual(
    new Set(selected.value.map((entry) => entry.leadId)),
    new Set(["lead_alex_1", "lead_alex_2", "lead_alex_3"]),
  );

  const lateDiscovery = structuredClone(duplicate.graph);
  lateDiscovery.currentSourceTier = 6;
  assert.ok(
    lateDiscovery.frontier.some(
      (entry) =>
        entry.sourceTier === 2 &&
        entry.intent.startsWith("OSINT query ") &&
        entry.status === "queued" &&
        entry.leadId === undefined,
    ),
    "the fixture must retain arbitrary nondependency T2 breadth below the T6 cursor",
  );
  const selectedAfterBreadthAdvance = search.selectFrontierBatch(lateDiscovery, 4, "2026-08-20T22:00:23.000Z");
  assert.deepEqual(
    new Set(selectedAfterBreadthAdvance.value.map((entry) => entry.leadId)),
    new Set(["lead_alex_1", "lead_alex_2", "lead_alex_3"]),
    "a late T6 query may expose an exact T2 lead dependency without reopening arbitrary T2 breadth",
  );
  assert.deepEqual(new Set(selectedAfterBreadthAdvance.value.map((entry) => entry.sourceTier)), new Set([2]));
  assert.ok(
    selectedAfterBreadthAdvance.graph.frontier.some(
      (entry) =>
        entry.sourceTier === 2 &&
        entry.intent.startsWith("OSINT query ") &&
        entry.status === "queued" &&
        entry.leadId === undefined,
    ),
    "late dependency execution must not reopen arbitrary T2 breadth below the cursor",
  );
  assert.ok(
    selectedAfterBreadthAdvance.graph.frontier.some(
      (entry) => entry.sourceTier === 6 && entry.intent.startsWith("OSINT query ") && entry.status === "queued",
    ),
    "unrelated T6 breadth must remain queued while the exact dependency runs",
  );
  assert.equal(
    selectedAfterBreadthAdvance.graph.currentSourceTier,
    6,
    "executing an exact lead dependency must not regress the breadth cursor",
  );
  assert.deepEqual(search.validateSearchGraph(selectedAfterBreadthAdvance.graph), []);

  const parentOutcome = search.recordFrontierOutcome(duplicate.graph, parent, "verified", "2026-08-20T22:00:24.000Z");
  const runningLead = search.setFrontierStatus(
    parentOutcome.graph,
    [admitted[0].id],
    "running",
    "2026-08-20T22:00:24.500Z",
  );
  const leadOutcome = search.recordFrontierOutcome(runningLead, admitted[0], "verified", "2026-08-20T22:00:25.000Z");
  assert.equal(search.deriveMutationProposal(leadOutcome.graph, target, admitted[0], 0), null);
  const beforeMutation = structuredClone(leadOutcome.graph);
  const mutation = await search.proposeBoundedMutation(
    leadOutcome.graph,
    target,
    admitted[0],
    ids,
    "2026-08-20T22:00:26.000Z",
  );
  assert.equal(mutation.value, null);
  assert.deepEqual(mutation.events, []);
  assert.deepEqual(mutation.graph, beforeMutation, "opaque lead mutation rejection must emit no telemetry");
  assert.deepEqual(search.validateSearchGraph(duplicate.graph), []);
});

test("the standard runner exhausts every canonical name query before terminating", async () => {
  const targetRaw = "Renée D'Angelo Smith, Example Labs";
  const target = domain.parseTarget(targetRaw);
  const plan = search.compileOsintQueries(target);
  assert.equal(plan.status, "compiled");
  assert.equal(plan.queries.length, 16);
  assert.ok(plan.queries.length <= search.MAX_OSINT_QUERY_VARIANTS);

  const executedQueries = [];
  const updates = [];
  for await (const update of agent.runResearch(
    targetRaw,
    {
      clock: domain.createSequenceClock("2026-08-20T20:27:00.000Z", 1),
      ids: domain.createDeterministicIdFactory("compiler-zero-result-runner"),
      planner: async ({ selectedFrontierEntries }) => ({
        kind: "actions",
        decisionSummary: "Exhaust the selected canonical public-professional queries.",
        actions: selectedFrontierEntries.map((entry) => ({
          frontierEntryId: entry.id,
          tool: "search_web",
          purpose: "Search public professional sources with the canonical query.",
          arguments: { query: entry.queryHint },
        })),
      }),
      executeAction: async (action) => {
        executedQueries.push(action.arguments.query);
        return {
          status: "not_found",
          evidence: [],
          meta: { requests: 1, bytesRead: 0, incomplete: false, llmCalls: 0 },
        };
      },
    },
    { availableTools: ["search_web"] },
  ))
    updates.push(update);

  const completed = updates.at(-1);
  assert.equal(completed.type, "completed");
  assert.deepEqual([...executedQueries].sort(), plan.queries.map((query) => query.query).sort());
  assert.equal(new Set(executedQueries).size, plan.queries.length);
  assert.ok(executedQueries.some((query) => query.includes("site:github.com")));
  assert.ok(executedQueries.some((query) => query.includes("site:linkedin.com")));
  assert.ok(executedQueries.some((query) => query.includes("site:orcid.org")));
  assert.ok(executedQueries.some((query) => query.includes("site:scholar.google.com")));
  assert.ok(executedQueries.some((query) => query.includes("site:openreview.net")));
  assert.ok(executedQueries.some((query) => query.includes("site:semanticscholar.org")));
  assert.ok(executedQueries.some((query) => query.includes("site:openalex.org")));
  assert.ok(executedQueries.some((query) => query.includes("site:researchgate.net")));
  assert.ok(executedQueries.some((query) => query.includes("site:crossref.org")));
  assert.ok(executedQueries.some((query) => query.includes("site:apps.apple.com")));
  assert.ok(executedQueries.some((query) => query.includes("site:linkedin.com") && query.includes("posts")));
  assert.ok(executedQueries.some((query) => query.includes("site:x.com") && query.includes("site:twitter.com")));
  assert.ok(executedQueries.some((query) => query.includes("site:reddit.com") && query.includes("comments")));
  assert.ok(executedQueries.some((query) => query.includes("filetype:pdf")));
  assert.ok(plan.queries.some((query) => query.kind === "exact_context"));
  assert.equal(new Set(plan.queries.map((query) => query.subjectPhrase)).size, 1);
  assert.equal(
    plan.queries.some((query) => ["orthographic_name", "initial_name"].includes(query.kind)),
    false,
  );
  assert.equal(
    plan.diagnostics.some((item) => item.code === "query_limit_applied"),
    false,
  );
  assert.notEqual(completed.report.stop.reason, "diminishing_returns");
  assert.equal(
    completed.report.stop.reason,
    "budget_exhausted",
    "the standard turn budget may settle exactly as the bounded sixteen-query focus program finishes",
  );
  assert.equal(
    completed.report.searchGraph.frontier.every((entry) => entry.status === "exhausted"),
    true,
  );
  assert.deepEqual(search.validateSearchGraph(completed.report.searchGraph), []);
});

test("deep provider fanout reserves every canonical search before candidate fetch extraction", async () => {
  const targetRaw = "Taylor Morgan, Example University";
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: targetRaw,
    requestedDepth: "deep",
  });
  const plan = search.compileOsintQueries(domain.parseTarget(input));
  assert.equal(plan.status, "compiled");
  assert.ok(plan.queries.length > 4, "the regression needs more searches than one outbound batch");

  let searchOrdinal = 0;
  let successfulProviderSearches = 0;
  let successfulExtractionAttempts = 0;
  const updates = [];
  for await (const update of agent.runResearch(
    input,
    {
      clock: domain.createSequenceClock("2026-08-20T20:27:15.000Z", 1),
      ids: domain.createDeterministicIdFactory("deep-provider-fanout-reservation"),
      planner: async ({ selectedFrontierEntries, modelAccounting }) => {
        assert.equal(modelAccounting.reserve(), true);
        modelAccounting.settle({ networkRequests: 1 });
        return {
          kind: "actions",
          decisionSummary: "Execute every selected canonical capability.",
          actions: selectedFrontierEntries.map((entry) => ({
            frontierEntryId: entry.id,
            tool: entry.allowedTools[0],
            purpose: entry.allowedTools[0] === "search_web" ? "Run canonical discovery." : "Fetch one opaque lead.",
            arguments: entry.allowedTools[0] === "search_web" ? { query: entry.queryHint } : { leadId: entry.leadId },
            ...(entry.candidateId ? { candidateId: entry.candidateId } : {}),
          })),
        };
      },
      executeAction: async (action, context) => {
        if (action.tool === "search_web") {
          assert.equal(context.modelAccounting.reserve(), true, "canonical provider search must remain budgeted");
          context.modelAccounting.settle({ networkRequests: 1 });
          successfulProviderSearches += 1;
          searchOrdinal += 1;
          const candidateRef = `provider_candidate_${searchOrdinal}`;
          return {
            status: "succeeded",
            candidates: [{ ref: candidateRef, displayName: targetRaw }],
            evidence: [1, 2].map((leadOrdinal) => ({
              candidateRef,
              claim: "The configured provider surfaced one bounded public code-profile lead.",
              disposition: "discovery_only",
              sourceUrl: `https://github.com/taylor-morgan-${searchOrdinal}-${leadOrdinal}`,
              sourceType: "search_result",
              canonicalSubset: { providerAttestedUrl: true },
              verificationMethod: "search_discovery",
              attributes: {
                leadId: `lead_provider_${searchOrdinal}_${leadOrdinal}`,
                classifiedSourceLaneId: "t2.structured_professional",
                classifiedSourceTier: 2,
                classifiedSourceType: "code_profile",
              },
            })),
            meta: { requests: 0, bytesRead: 0, incomplete: false },
          };
        }
        if (action.tool === "fetch_public_source") {
          if (context.modelAccounting.reserve()) {
            context.modelAccounting.settle({ networkRequests: 1 });
            successfulExtractionAttempts += 1;
          }
          return {
            status: "not_found",
            evidence: [],
            meta: { requests: 0, bytesRead: 0, incomplete: false },
          };
        }
        return { status: "not_found", evidence: [], meta: { requests: 0, bytesRead: 0 } };
      },
    },
    { availableTools: ["search_web", "fetch_public_source"] },
  ))
    updates.push(update);

  const completed = updates.at(-1);
  assert.equal(completed.type, "completed");
  assert.equal(successfulProviderSearches, plan.queries.length);
  assert.ok(successfulExtractionAttempts > 0, "candidate fetches may use only the budget left after breadth");

  const toolStarts = completed.trace.events.filter(
    (event) => event.kind === "span_start" && event.name.startsWith("tool."),
  );
  const searchStarts = toolStarts.filter((event) => event.name === "tool.search_web");
  const fetchStarts = toolStarts.filter((event) => event.name === "tool.fetch_public_source");
  assert.equal(searchStarts.length, plan.queries.length);
  assert.ok(fetchStarts.length > 0);
  assert.ok(
    Math.max(...searchStarts.map((event) => event.seq)) < Math.min(...fetchStarts.map((event) => event.seq)),
    "optional candidate fanout must begin only after canonical breadth",
  );

  const compilerEntries = completed.report.searchGraph.frontier.filter((entry) =>
    search.isCanonicalCompilerSearchEntry(entry),
  );
  const startsByFrontier = new Map();
  for (const event of toolStarts) {
    const frontierEntryId = event.payload.frontierEntryId;
    startsByFrontier.set(frontierEntryId, (startsByFrontier.get(frontierEntryId) ?? 0) + 1);
  }
  assert.equal(compilerEntries.length, plan.queries.length);
  assert.ok(compilerEntries.every((entry) => startsByFrontier.get(entry.id) === 1));
  assert.deepEqual(
    searchStarts.map((event) => event.payload.arguments.query).sort(),
    plan.queries.map((query) => query.query).sort(),
  );

  const neverExecuted = completed.report.searchGraph.frontier.filter((entry) => !startsByFrontier.has(entry.id));
  assert.ok(neverExecuted.length > 0, "the bounded run should leave some optional fanout unexecuted");
  assert.ok(
    neverExecuted.every(
      (entry) =>
        !completed.trace.events.some(
          (event) =>
            event.kind === "span_end" && event.name.startsWith("tool.") && event.payload.frontierEntryId === entry.id,
        ),
    ),
    "terminal exhaustion must never be represented as a tool execution",
  );
  assert.deepEqual(search.validateSearchGraph(completed.report.searchGraph), []);
  assert.deepEqual(domain.validateReferentialIntegrity(completed.state), []);
});

test("deep runner routes canonical batches mechanically without synthesizing discovery-only search rows", async () => {
  const targetRaw = "Elon Musk";
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: targetRaw,
    requestedDepth: "deep",
  });
  const plan = search.compileOsintQueries(domain.parseTarget(input));
  assert.equal(plan.status, "compiled");
  assert.ok(plan.queries.length > 4, "the regression needs more than one selected compiler batch");

  let canonicalPlannerCalls = 0;
  let nonCanonicalPlannerCalls = 0;
  let discoverySearches = 0;
  let opaqueFetchCalls = 0;
  let fetchExtractionAttempts = 0;
  let synthesisCalls = 0;
  const adapterQueries = [];
  const updates = [];
  for await (const update of agent.runResearch(
    input,
    {
      clock: domain.createSequenceClock("2026-08-21T09:00:00.000Z", 1),
      ids: domain.createDeterministicIdFactory("deep-partial-planner-completion"),
      planner: async ({ selectedFrontierEntries }) => {
        const selectedSearches = selectedFrontierEntries.filter((entry) =>
          search.isCanonicalCompilerSearchEntry(entry),
        );
        if (selectedSearches.length > 0) {
          canonicalPlannerCalls += 1;
          return {
            kind: "stop",
            decisionSummary: "This no-op must never control a mechanically complete canonical batch.",
          };
        }
        nonCanonicalPlannerCalls += 1;
        const opaqueLeads = selectedFrontierEntries.filter(
          (entry) =>
            entry.candidateId &&
            entry.leadId &&
            entry.allowedTools.length === 1 &&
            entry.allowedTools[0] === "fetch_public_source",
        );
        if (opaqueLeads.length > 0) {
          return {
            kind: "actions",
            decisionSummary: "Fetch the selected exact candidate-scoped opaque leads after canonical breadth.",
            actions: opaqueLeads.map((entry) => ({
              frontierEntryId: entry.id,
              tool: "fetch_public_source",
              purpose: "Fetch the exact selected public-professional discovery capability.",
              arguments: { leadId: entry.leadId },
              candidateId: entry.candidateId,
            })),
          };
        }
        return { kind: "advance", decisionSummary: "No mechanically bound test action is selected." };
      },
      executeAction: async (action, context) => {
        if (action.tool === "search_web") {
          adapterQueries.push(action.arguments.query);
          discoverySearches += 1;
          if (discoverySearches <= 3) {
            const candidateRef = `elon_query_subject_${discoverySearches}`;
            return {
              status: "succeeded",
              candidates: [{ ref: candidateRef, displayName: targetRaw }],
              evidence: Array.from({ length: 3 }, (_, index) => {
                const leadOrdinal = (discoverySearches - 1) * 3 + index + 1;
                return {
                  candidateRef,
                  claim: `A bounded provider search surfaced public code-profile lead ${leadOrdinal}.`,
                  disposition: "discovery_only",
                  sourceUrl: `https://github.com/elon-musk-regression-${leadOrdinal}`,
                  sourceType: "search_result",
                  canonicalSubset: { providerAttestedUrl: true },
                  verificationMethod: "search_discovery",
                  attributes: {
                    leadId: `lead_elon_regression_${leadOrdinal}`,
                    classifiedSourceLaneId: "t2.structured_professional",
                    classifiedSourceTier: 2,
                    classifiedSourceType: "code_profile",
                  },
                };
              }),
              meta: { requests: 1, bytesRead: 0, incomplete: false, llmCalls: 0 },
            };
          }
          return {
            status: "not_found",
            evidence: [],
            meta: { requests: 1, bytesRead: 0, incomplete: false, llmCalls: 0 },
          };
        }
        if (action.tool === "fetch_public_source") {
          opaqueFetchCalls += 1;
          assert.match(action.arguments.leadId, /^lead_elon_regression_/);
          assert.ok(action.candidateId, "opaque lead fetch stays candidate-bound");
          if (context.modelAccounting.reserve()) {
            fetchExtractionAttempts += 1;
            context.modelAccounting.settle({ networkRequests: 1 });
          }
          return {
            status: "not_found",
            evidence: [],
            meta: { requests: 1, bytesRead: 0, incomplete: false, llmCalls: 0 },
          };
        }
        throw new Error(`Unexpected test action ${action.tool}`);
      },
      synthesize: async (_state, context) => {
        synthesisCalls += 1;
        assert.equal(context.modelAccounting.reserve(), true, "the final reserved synthesis call must remain usable");
        context.modelAccounting.settle({ networkRequests: 1 });
        return {
          decisionSummary: "The remaining public evidence does not support a higher-confidence finding.",
          findings: [],
          openQuestions: [],
        };
      },
    },
    {
      availableTools: ["search_web", "fetch_public_source"],
      budget: { maxLlmCalls: 9 },
    },
  ))
    updates.push(update);

  const completed = updates.at(-1);
  assert.equal(completed.type, "completed");
  assert.equal(new Set(adapterQueries).size, plan.queries.length);
  assert.deepEqual(
    [...adapterQueries].sort(),
    plan.queries.map((query) => query.query).sort(),
    "every finite canonical query must reach the real adapter without spending a planner call",
  );
  assert.ok(opaqueFetchCalls > 0, "remaining Deep budget must reach at least one legal opaque lead fetch");
  assert.ok(fetchExtractionAttempts > 0, "noncanonical lead extraction may use budget above the final reserve");
  assert.equal(
    completed.state.evidence.filter(
      (evidence) => evidence.disposition === "discovery_only" && evidence.sourceType === "search_result",
    ).length,
    9,
    "the regression must retain enough discovery rows to expose raw evidence-count scheduling",
  );
  assert.equal(synthesisCalls, 0, "discovery-only search rows must never spend a finding-synthesis call");
  assert.ok(completed.report.usage.toolCalls < completed.state.budget.limits.maxToolCalls);
  assert.ok(completed.report.usage.searchCalls < completed.state.budget.limits.maxSearchCalls);
  assert.equal(
    completed.report.usage.llmCalls,
    nonCanonicalPlannerCalls + fetchExtractionAttempts,
    "LLM accounting must contain only planner and fetch work, with no discovery-triggered synthesis charge",
  );

  const compilerEntries = completed.report.searchGraph.frontier.filter((entry) =>
    search.isCanonicalCompilerSearchEntry(entry),
  );
  const searchStarts = completed.trace.events.filter(
    (event) => event.kind === "span_start" && event.name === "tool.search_web",
  );
  const searchEnds = completed.trace.events.filter(
    (event) => event.kind === "span_end" && event.name === "tool.search_web",
  );
  assert.equal(compilerEntries.length, plan.queries.length);
  for (const entry of compilerEntries) {
    assert.ok(["verified", "exhausted"].includes(entry.status));
    assert.equal(
      searchStarts.filter((event) => event.payload.frontierEntryId === entry.id).length,
      1,
      `compiler entry ${entry.id} must have one real adapter span start`,
    );
    assert.equal(
      searchEnds.filter((event) => event.payload.frontierEntryId === entry.id).length,
      1,
      `compiler entry ${entry.id} must have one real adapter span end`,
    );
  }
  const fetchStarts = completed.trace.events.filter(
    (event) => event.kind === "span_start" && event.name === "tool.fetch_public_source",
  );
  assert.ok(fetchStarts.length > 0);
  assert.ok(
    Math.max(...searchStarts.map((event) => event.seq)) < Math.min(...fetchStarts.map((event) => event.seq)),
    "Deep breadth reservation must finish every canonical search before optional opaque fanout",
  );
  const synthesisStarts = completed.trace.events.filter(
    (event) => event.kind === "span_start" && event.name === "synthesis.findings",
  );
  assert.equal(synthesisStarts.length, 0);
  assert.equal(completed.trace.events.filter((event) => event.name === "synthesis.final_call_reserved").length, 0);
  const deterministicRoutes = completed.trace.events.filter(
    (event) => event.name === "scheduler.canonical_batch_routed",
  );
  assert.ok(deterministicRoutes.length > 1);
  assert.equal(
    deterministicRoutes.reduce((sum, event) => sum + event.payload.entryCount, 0),
    plan.queries.length,
  );
  assert.equal(canonicalPlannerCalls, 0, "canonical-only selection must bypass the model planner entirely");
  assert.ok(nonCanonicalPlannerCalls > 0, "opaque lead capabilities still use their existing planner boundary");
  assert.deepEqual(search.validateSearchGraph(completed.report.searchGraph), []);
  assert.deepEqual(domain.validateReferentialIntegrity(completed.state), []);
});

test("deep runner consumes one persisted exact-subject slug probe before neutral and deprioritized fanout", async () => {
  const targetRaw = "Alex Rivera";
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: targetRaw,
    requestedDepth: "deep",
  });
  const plan = search.compileOsintQueries(domain.parseTarget(input));
  assert.equal(plan.status, "compiled");

  const leadSpecs = [
    {
      leadId: "lead_alex_official_bio",
      sourceUrl: "https://example-robotics.com/alex-rivera",
      title: "Public source at example-robotics.com",
      classifiedSourceLaneId: "t6.candidate_public_source",
      classifiedSourceTier: 6,
      classifiedSourceType: "other",
      persistedScheduling: {
        disposition: "prioritize",
        reason: "exact_subject_slug_probe",
      },
    },
    {
      leadId: "lead_alex_media_profile",
      sourceUrl: "https://media.example/profile/alex-rivera",
      title: "Alex Rivera | Media",
      classifiedSourceLaneId: "t4.reputable_media",
      classifiedSourceTier: 4,
      classifiedSourceType: "news",
    },
    {
      leadId: "lead_alex_github_profile",
      sourceUrl: "https://github.com/alex-rivera",
      title: "Alex Rivera · GitHub",
      classifiedSourceLaneId: "t2.structured_professional",
      classifiedSourceTier: 2,
      classifiedSourceType: "code_profile",
    },
    {
      leadId: "lead_wrong_person_slug",
      sourceUrl: "https://evil.example/profile/jordan-lee",
      title: "Jordan Lee | Evil",
      classifiedSourceLaneId: "t6.candidate_public_source",
      classifiedSourceTier: 6,
      classifiedSourceType: "other",
    },
    {
      leadId: "lead_random_subject_article",
      sourceUrl: "https://example-robotics.com/articles/alex-rivera",
      title: "Public source at example-robotics.com — article",
      classifiedSourceLaneId: "t6.candidate_public_source",
      classifiedSourceTier: 6,
      classifiedSourceType: "other",
    },
    {
      leadId: "lead_alex_gist_noise",
      sourceUrl: "https://gist.github.com/example/0123456789abcdef",
      title: "Alex Rivera notes",
      classifiedSourceLaneId: "t6.candidate_public_source",
      classifiedSourceTier: 6,
      classifiedSourceType: "other",
    },
  ].map((lead) => ({
    ...lead,
    deterministicScheduling: search.discoveryLeadSchedulingDecision(lead.sourceUrl, lead.title, {
      personNames: [targetRaw],
    }),
    scheduling:
      lead.persistedScheduling ??
      search.discoveryLeadSchedulingDecision(lead.sourceUrl, lead.title, {
        personNames: [targetRaw],
      }),
  }));
  assert.deepEqual(
    leadSpecs.map((lead) => lead.deterministicScheduling.disposition),
    ["neutral", "prioritize", "neutral", "neutral", "neutral", "deprioritize"],
    "the matching media bio is eligible, while generic titles, an evil wrong-person slug, and an article path must not manufacture priority",
  );
  assert.deepEqual(
    leadSpecs.map((lead) => lead.scheduling.disposition),
    ["prioritize", "prioritize", "neutral", "neutral", "neutral", "deprioritize"],
  );

  let emittedLeads = false;
  let synthesisCalls = 0;
  let fetchedCountAtFirstSynthesis = null;
  const fetchedLeadIds = [];
  const adapterQueries = [];
  const updates = [];
  for await (const update of agent.runResearch(
    input,
    {
      clock: domain.createSequenceClock("2026-08-21T10:00:00.000Z", 1),
      ids: domain.createDeterministicIdFactory("deep-quality-probe"),
      planner: async ({ selectedFrontierEntries }) => ({
        kind: "actions",
        decisionSummary: "Execute the remaining exact opaque lead capabilities.",
        actions: selectedFrontierEntries.map((entry) => ({
          frontierEntryId: entry.id,
          tool: entry.allowedTools[0],
          purpose: "Execute one selected public capability.",
          arguments: entry.allowedTools[0] === "search_web" ? { query: entry.queryHint } : { leadId: entry.queryHint },
          ...(entry.candidateId ? { candidateId: entry.candidateId } : {}),
        })),
      }),
      executeAction: async (action) => {
        if (action.tool === "search_web") {
          adapterQueries.push(action.arguments.query);
          if (!emittedLeads && action.sourceLaneId === "t1.first_party") {
            emittedLeads = true;
            return {
              status: "succeeded",
              candidates: [{ ref: "alex_query_subject", displayName: targetRaw }],
              evidence: leadSpecs.map((lead) => ({
                candidateRef: "alex_query_subject",
                claim: `Public discovery surfaced ${lead.title}.`,
                disposition: "discovery_only",
                sourceUrl: lead.sourceUrl,
                title: lead.title,
                sourceType: "search_result",
                canonicalSubset: { providerAttestedUrl: true },
                verificationMethod: "search_discovery",
                attributes: {
                  leadId: lead.leadId,
                  classifiedSourceLaneId: lead.classifiedSourceLaneId,
                  classifiedSourceTier: lead.classifiedSourceTier,
                  classifiedSourceType: lead.classifiedSourceType,
                  leadSchedulingDisposition: lead.scheduling.disposition,
                  leadSchedulingReason: lead.scheduling.reason,
                },
              })),
              meta: { requests: 1, bytesRead: 0, incomplete: false, llmCalls: 0 },
            };
          }
          return {
            status: "not_found",
            evidence: [],
            meta: { requests: 1, bytesRead: 0, incomplete: false, llmCalls: 0 },
          };
        }
        if (action.tool === "fetch_public_source") {
          fetchedLeadIds.push(action.arguments.leadId);
          const lead = leadSpecs.find((item) => item.leadId === action.arguments.leadId);
          assert.ok(lead);
          if (lead.leadId !== "lead_alex_official_bio") {
            return {
              status: "not_found",
              evidence: [],
              meta: { requests: 1, bytesRead: 0, incomplete: false, llmCalls: 0 },
            };
          }
          return {
            status: "succeeded",
            evidence: [
              {
                candidateId: action.candidateId,
                claim: "Alex Rivera leads Example Robotics as its founder.",
                excerpt: "Alex Rivera leads Example Robotics as its founder.",
                title: lead.title,
                sourceUrl: lead.sourceUrl,
                sourceType: lead.classifiedSourceType,
                httpStatus: 200,
                verificationMethod: "direct_fetch",
              },
            ],
            meta: { requests: 1, bytesRead: 128, incomplete: false, llmCalls: 0 },
          };
        }
        throw new Error(`Unexpected test action ${action.tool}`);
      },
      synthesize: async (state, context) => {
        synthesisCalls += 1;
        if (fetchedCountAtFirstSynthesis === null) fetchedCountAtFirstSynthesis = fetchedLeadIds.length;
        const directEvidence = state.evidence.find(
          (evidence) =>
            evidence.sourceUrl === leadSpecs[0].sourceUrl &&
            evidence.disposition === "supports" &&
            evidence.verificationMethod === "direct_fetch",
        );
        assert.ok(directEvidence, "quality-triggered synthesis must follow admitted direct supporting evidence");
        assert.equal(context.modelAccounting.reserve(), true);
        context.modelAccounting.settle({ networkRequests: 1 });
        return {
          decisionSummary: "The bounded official-page probe was synthesized.",
          findings: [
            {
              candidateId: directEvidence.candidateId,
              title: `Employment — ${targetRaw}`,
              description: directEvidence.excerpt,
              category: "employment",
              evidenceIds: [directEvidence.id],
            },
          ],
          openQuestions: [],
        };
      },
    },
    {
      availableTools: ["search_web", "fetch_public_source"],
      budget: { maxTurns: 16, maxLlmCalls: 6 },
    },
  ))
    updates.push(update);

  const completed = updates.at(-1);
  assert.equal(completed.type, "completed");
  assert.deepEqual(
    [...adapterQueries].sort(),
    plan.queries.map((query) => query.query).sort(),
    "quality scheduling must not trade away finite canonical breadth",
  );
  assert.equal(
    fetchedLeadIds[0],
    "lead_alex_official_bio",
    JSON.stringify({
      stop: completed.report.stop,
      usage: completed.report.usage,
      leads: completed.report.searchGraph.frontier
        .filter((entry) => entry.leadId)
        .map((entry) => ({ leadId: entry.leadId, status: entry.status, lane: entry.sourceLaneId })),
      qualityEvents: completed.trace.events.filter((event) => event.name.includes("quality_probe")),
    }),
  );
  assert.ok(fetchedLeadIds.includes("lead_alex_github_profile"), JSON.stringify(fetchedLeadIds));
  assert.ok(fetchedLeadIds.includes("lead_alex_media_profile"), JSON.stringify(fetchedLeadIds));
  assert.ok(fetchedLeadIds.includes("lead_wrong_person_slug"), JSON.stringify(fetchedLeadIds));
  assert.ok(fetchedLeadIds.includes("lead_random_subject_article"), JSON.stringify(fetchedLeadIds));
  assert.ok(fetchedLeadIds.includes("lead_alex_gist_noise"), JSON.stringify(fetchedLeadIds));
  assert.ok(
    fetchedLeadIds.indexOf("lead_alex_official_bio") < fetchedLeadIds.indexOf("lead_wrong_person_slug") &&
      fetchedLeadIds.indexOf("lead_alex_official_bio") < fetchedLeadIds.indexOf("lead_random_subject_article"),
    "wrong-name and random-article leads must remain ordinary neutral fanout, never the quality probe",
  );
  assert.ok(
    fetchedLeadIds.indexOf("lead_alex_github_profile") < fetchedLeadIds.indexOf("lead_alex_gist_noise"),
    "neutral structured leads must remain ahead of explicitly deprioritized optional noise",
  );
  assert.equal(
    fetchedCountAtFirstSynthesis,
    leadSpecs.length,
    "deep synthesis must follow the focused source traversal rather than stopping after its first useful page",
  );
  assert.equal(synthesisCalls, 1, "the same evidence snapshot must not trigger repeated intermediate synthesis");
  assert.equal(completed.report.findings.length, 1);
  assert.equal(completed.report.findings[0].category, "employment");
  const qualityProbeEvents = completed.trace.events.filter((event) => event.name === "frontier.quality_probe_selected");
  assert.equal(qualityProbeEvents.length, 1, "one durable professional quote must stop the backup quality-probe route");
  assert.equal(qualityProbeEvents[0].payload.leadId, "lead_alex_official_bio");
  assert.equal(qualityProbeEvents[0].payload.schedulingDisposition, "prioritize");
  assert.equal(qualityProbeEvents[0].payload.schedulingReason, "exact_subject_slug_probe");
  const qualityFrontier = completed.report.searchGraph.frontier.find(
    (entry) => entry.leadId === "lead_alex_official_bio",
  );
  const mediaFrontier = completed.report.searchGraph.frontier.find(
    (entry) => entry.leadId === "lead_alex_media_profile",
  );
  assert.ok(qualityFrontier && mediaFrontier);
  assert.ok(
    mediaFrontier.pathCost < qualityFrontier.pathCost,
    "the persisted exact-subject probe must win by probe rank even when Dijkstra would select the lower-tier media bio",
  );
  assert.equal(
    completed.trace.events.filter(
      (event) =>
        event.kind === "span_start" &&
        event.name === "tool.fetch_public_source" &&
        event.payload.frontierEntryId === qualityProbeEvents[0].payload.frontierEntryId,
    ).length,
    1,
    "the quality selection event must join to one real hardened-fetch adapter span",
  );
  assert.equal(completed.trace.events.filter((event) => event.name === "scheduler.quality_probe_routed").length, 1);
  assert.equal(completed.trace.events.filter((event) => event.name === "synthesis.quality_probe_ready").length, 1);
  assert.deepEqual(search.validateSearchGraph(completed.report.searchGraph), []);
  assert.deepEqual(domain.validateReferentialIntegrity(completed.state), []);
});

test("Deep focus keeps alternate candidates auditable while exhausting their candidate-bound work", () => {
  const clock = domain.createSequenceClock("2026-08-21T19:30:00.000Z", 1);
  const ids = domain.createDeterministicIdFactory("deep-subject-focus");
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: "Alex Rivera",
    requestedDepth: "deep",
  });
  const engine = new agent.InvestigationEngine(input, { clock, ids });
  const anchorSignal = {
    kind: "name",
    value: "Alex Rivera",
    normalizedValue: "alex rivera",
    strength: "weak",
    assurance: "self_asserted",
  };
  const focus = engine.addCandidate({ displayName: "Alex Rivera", signals: [anchorSignal] }).candidate;
  const anchorEvidence = engine.admitEvidence({
    candidateId: focus.id,
    claim: "The exact query subject was retained as a neutral discovery anchor.",
    sourceUrl: "https://search.example/result/alex-rivera",
    sourceType: "search_result",
    canonicalSubset: { providerAttestedUrl: true },
    verificationMethod: "search_discovery",
    attributes: { querySubjectAnchor: true, querySubjectName: "Alex Rivera" },
  });
  assert.equal(anchorEvidence.admitted, true);
  const alternate = engine.addCandidate({ displayName: "Alex Rivera" }).candidate;
  assert.notEqual(alternate.id, focus.id);

  const seeded = search.seedFrontier(
    engine.snapshot().searchGraph,
    engine.snapshot().target,
    ["search_web"],
    ids,
    clock.now(),
  );
  const canonical = seeded.graph.frontier[0];
  assert.ok(canonical);
  const focusEntry = {
    ...canonical,
    id: "frontier_focus_candidate",
    frontierEntryId: "frontier_focus_candidate",
    actionId: "frontier_focus_candidate",
    candidateId: focus.id,
  };
  const alternateEntry = {
    ...canonical,
    id: "frontier_alternate_candidate",
    frontierEntryId: "frontier_alternate_candidate",
    actionId: "frontier_alternate_candidate",
    candidateId: alternate.id,
  };
  const graph = structuredClone(seeded.graph);
  graph.frontier.push(focusEntry, alternateEntry);
  graph.telemetry.enqueued += 2;

  const pruned = agent.pruneForeignDeepSubjectFrontier(graph, engine.snapshot(), clock.now());
  assert.equal(pruned.focusedCandidateId, focus.id);
  assert.deepEqual(pruned.prunedFrontierEntryIds, [alternateEntry.id]);
  assert.equal(pruned.graph.frontier.find((entry) => entry.id === focusEntry.id).status, "queued");
  assert.equal(pruned.graph.frontier.find((entry) => entry.id === alternateEntry.id).status, "exhausted");
  assert.equal(pruned.graph.frontier.find((entry) => entry.id === canonical.id).status, "queued");
  assert.equal(pruned.graph.telemetry.exhausted, graph.telemetry.exhausted + 1);
  assert.equal(engine.snapshot().candidates.length, 2, "pruning routing must not delete alternate candidates");

  const secondAnchor = engine.admitEvidence({
    candidateId: alternate.id,
    claim: "A second exact-name candidate was also marked as a query anchor.",
    sourceUrl: "https://search.example/result/alex-rivera-2",
    sourceType: "search_result",
    canonicalSubset: { providerAttestedUrl: true },
    verificationMethod: "search_discovery",
    attributes: { querySubjectAnchor: true, querySubjectName: "Alex Rivera" },
  });
  assert.equal(secondAnchor.admitted, true);
  const markerOnly = agent.pruneForeignDeepSubjectFrontier(graph, engine.snapshot(), clock.now());
  assert.equal(
    markerOnly.ambiguous,
    false,
    "an unmarked alternate never becomes a focus anchor from name equality alone",
  );
  assert.deepEqual(markerOnly.prunedFrontierEntryIds, [alternateEntry.id]);

  const conflictingAnchor = engine.addCandidate({ displayName: "Alex Rivera", signals: [anchorSignal] }).candidate;
  const conflictingAnchorEvidence = engine.admitEvidence({
    candidateId: conflictingAnchor.id,
    claim: "A second structurally eligible exact-query anchor was admitted.",
    sourceUrl: "https://search.example/result/alex-rivera-3",
    sourceType: "search_result",
    canonicalSubset: { providerAttestedUrl: true },
    verificationMethod: "search_discovery",
    attributes: { querySubjectAnchor: true, querySubjectName: "Alex Rivera" },
  });
  assert.equal(conflictingAnchorEvidence.admitted, true);
  const ambiguous = agent.pruneForeignDeepSubjectFrontier(graph, engine.snapshot(), clock.now());
  assert.equal(ambiguous.ambiguous, true);
  assert.equal(ambiguous.focusedCandidateId, null);
  assert.deepEqual(ambiguous.prunedFrontierEntryIds, [alternateEntry.id, focusEntry.id].sort());
  assert.equal(ambiguous.graph.frontier.find((entry) => entry.id === focusEntry.id).status, "exhausted");
  assert.equal(ambiguous.graph.frontier.find((entry) => entry.id === alternateEntry.id).status, "exhausted");
  assert.equal(ambiguous.graph.frontier.find((entry) => entry.id === canonical.id).status, "queued");
});

test("quality probe attempt accounting ignores rejected and exhausted prioritized leads", () => {
  const targetRaw = "Casey Rowan";
  const target = domain.parseTarget(targetRaw);
  const ids = domain.createDeterministicIdFactory("quality-probe-attempt-accounting");
  const seeded = search.seedFrontier(
    search.emptySearchGraph("run_quality_probe_attempt_accounting", target.normalizedQuery, "2026-08-21T20:00:00.000Z"),
    target,
    ["search_web", "fetch_public_source"],
    ids,
    "2026-08-21T20:00:00.001Z",
  );
  let graph = search.setFrontierStatus(
    seeded.graph,
    seeded.graph.frontier.map((entry) => entry.id),
    "exhausted",
    "2026-08-21T20:00:00.002Z",
  );
  const parent = graph.frontier[0];
  assert.ok(parent);
  const actionNode = search.admitGraphNode(
    graph,
    {
      kind: "action",
      label: "search_web",
      status: "exhausted",
      sourceTier: parent.sourceTier,
      sourceLaneId: parent.sourceLaneId,
      frontierEntryId: parent.id,
      actionId: parent.actionId,
      data: { tool: "search_web" },
      dedupeEntityKey: `action:${parent.id}`,
    },
    ids,
    "2026-08-21T20:00:00.003Z",
  );
  const actionEdge = search.admitGraphEdge(
    actionNode.graph,
    {
      fromNodeId: parent.nodeId,
      toNodeId: actionNode.value.id,
      kind: "expands",
      status: "exhausted",
      frontierEntryId: parent.id,
      actionId: parent.actionId,
      edgeCost: 0.05,
      pathCost: parent.pathCost + 0.05,
    },
    ids,
    "2026-08-21T20:00:00.004Z",
  );
  graph = actionEdge.graph;
  const candidate = { id: "candidate_casey_rowan", displayName: targetRaw };

  const context = { personNames: [targetRaw] };
  const specs = [
    {
      leadId: "lead_stale_rejected",
      sourceUrl: "https://archive.example/people/casey-rowan",
      title: "Casey Rowan | Archive",
      status: "rejected",
      decision: { disposition: "prioritize", reason: "candidate_bio_path" },
    },
    {
      leadId: "lead_stale_exhausted",
      sourceUrl: "https://old.example/casey-rowan",
      title: "Public source at old.example",
      status: "exhausted",
      decision: { disposition: "prioritize", reason: "exact_subject_slug_probe" },
    },
    {
      leadId: "lead_actual_first_probe",
      sourceUrl: "https://official.example/casey-rowan",
      title: "Public source at official.example",
      status: "queued",
      decision: { disposition: "prioritize", reason: "exact_subject_slug_probe" },
    },
    {
      leadId: "lead_comparator_backup",
      sourceUrl: "https://casey.example/casey-rowan",
      title: "Casey Rowan | Profile",
      status: "queued",
      decision: { disposition: "prioritize", reason: "candidate_bio_path" },
    },
    {
      leadId: "lead_ordinary_after_cap",
      sourceUrl: "https://laboratory.example/people/casey-rowan",
      title: "Casey Rowan | Laboratory",
      status: "queued",
      decision: { disposition: "prioritize", reason: "candidate_bio_path" },
    },
  ];
  const entries = new Map();
  const decisions = {};
  let tick = 5;
  for (const spec of specs) {
    if (spec.decision.reason === "candidate_bio_path") {
      assert.deepEqual(
        search.discoveryLeadSchedulingDecision(spec.sourceUrl, spec.title, context),
        spec.decision,
        spec.leadId,
      );
    }
    const evidenceId = `evidence_${spec.leadId}`;
    const sourceNode = search.admitGraphNode(
      graph,
      {
        kind: "source",
        label: spec.title,
        status: "exhausted",
        sourceTier: parent.sourceTier,
        sourceLaneId: parent.sourceLaneId,
        frontierEntryId: parent.id,
        actionId: parent.actionId,
        candidateId: candidate.id,
        evidenceId,
        data: {
          sourceUrl: spec.sourceUrl,
          sourceType: "search_result",
          classifiedSourceLaneId: "t6.candidate_public_source",
          classifiedSourceTier: 6,
          classifiedSourceType: "other",
          leadId: spec.leadId,
        },
        dedupeEntityKey: `source:${evidenceId}`,
      },
      ids,
      `2026-08-21T20:00:00.${String(tick++).padStart(3, "0")}Z`,
    );
    const sourceEdge = search.admitGraphEdge(
      sourceNode.graph,
      {
        fromNodeId: actionNode.value.id,
        toNodeId: sourceNode.value.id,
        kind: "expands",
        status: "exhausted",
        frontierEntryId: parent.id,
        actionId: parent.actionId,
        edgeCost: 0.04,
        pathCost: parent.pathCost + 0.09,
      },
      ids,
      `2026-08-21T20:00:00.${String(tick++).padStart(3, "0")}Z`,
    );
    graph = sourceEdge.graph;
    const enqueued = search.enqueueCandidateLeadFetchFrontier(
      graph,
      target,
      candidate,
      {
        leadId: spec.leadId,
        sourceUrl: spec.sourceUrl,
        sourceEvidenceId: evidenceId,
        classifiedSourceLaneId: "t6.candidate_public_source",
        classifiedSourceTier: 6,
        classifiedSourceType: "other",
      },
      parent,
      sourceNode.value.id,
      ["fetch_public_source"],
      ids,
      `2026-08-21T20:00:00.${String(tick++).padStart(3, "0")}Z`,
    );
    assert.ok(enqueued.value);
    graph = enqueued.graph;
    entries.set(spec.leadId, enqueued.value);
    decisions[spec.leadId] = spec.decision;
    if (spec.status !== "queued") {
      graph = search.setFrontierStatus(
        graph,
        [enqueued.value.id],
        spec.status,
        `2026-08-21T20:00:00.${String(tick++).padStart(3, "0")}Z`,
      );
    }
  }
  assert.deepEqual(search.validateSearchGraph(graph), []);

  const selectionOptions = {
    prioritizeDiscoveryLeadProbe: true,
    maxPrioritizedDiscoveryLeadProbes: 2,
    discoveryLeadContexts: { [candidate.id]: context },
    discoveryLeadSchedulingDecisions: decisions,
  };
  assert.throws(
    () => search.selectFrontierBatch(graph, 1, "2026-08-21T20:00:00.999Z", selectionOptions),
    /require explicit attempted entry IDs/,
  );
  const first = search.selectFrontierBatch(graph, 1, "2026-08-21T20:00:01.000Z", {
    ...selectionOptions,
    attemptedPrioritizedDiscoveryLeadProbeEntryIds: new Set(),
  });
  assert.equal(first.value[0]?.leadId, "lead_actual_first_probe");
  assert.deepEqual(
    first.events
      .filter((event) => event.name === "frontier.quality_probe_selected")
      .map((event) => [event.payload.leadId, event.payload.probeOrdinal]),
    [["lead_actual_first_probe", 1]],
  );

  graph = search.setFrontierStatus(first.graph, [first.value[0].id], "running", "2026-08-21T20:00:01.001Z");
  graph = search.recordFrontierOutcome(graph, first.value[0], "exhausted", "2026-08-21T20:00:01.002Z").graph;
  const second = search.selectFrontierBatch(graph, 1, "2026-08-21T20:00:02.000Z", {
    ...selectionOptions,
    attemptedPrioritizedDiscoveryLeadProbeEntryIds: new Set([first.value[0].id]),
  });
  assert.equal(second.value[0]?.leadId, "lead_comparator_backup");
  assert.deepEqual(
    second.events
      .filter((event) => event.name === "frontier.quality_probe_selected")
      .map((event) => [event.payload.leadId, event.payload.probeOrdinal]),
    [["lead_comparator_backup", 2]],
  );

  graph = search.setFrontierStatus(second.graph, [second.value[0].id], "running", "2026-08-21T20:00:02.001Z");
  graph = search.recordFrontierOutcome(graph, second.value[0], "verified", "2026-08-21T20:00:02.002Z").graph;
  const afterCap = search.selectFrontierBatch(graph, 1, "2026-08-21T20:00:03.000Z", {
    ...selectionOptions,
    attemptedPrioritizedDiscoveryLeadProbeEntryIds: new Set([first.value[0].id, second.value[0].id]),
  });
  assert.equal(afterCap.value[0]?.id, entries.get("lead_ordinary_after_cap").id);
  assert.equal(afterCap.events.filter((event) => event.name === "frontier.quality_probe_selected").length, 0);
  assert.deepEqual(search.validateSearchGraph(afterCap.graph), []);
});

test("deep runner spends one grounding probe and then resumes ordinary focused fanout", async () => {
  const targetRaw = "Alex Rivera";
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: targetRaw,
    requestedDepth: "deep",
  });
  const plan = search.compileOsintQueries(domain.parseTarget(input));
  assert.equal(plan.status, "compiled");

  const leads = [
    {
      leadId: "lead_exact_subject_probe",
      sourceUrl: "https://official.example/alex-rivera",
      title: "Public source at official.example",
      lane: "t6.candidate_public_source",
      tier: 6,
      type: "other",
      scheduling: { disposition: "prioritize", reason: "exact_subject_slug_probe" },
    },
    {
      leadId: "lead_exact_personal_profile",
      sourceUrl: "https://alexrivera.example/profile",
      title: "Alex Rivera",
      lane: "t6.candidate_public_source",
      tier: 6,
      type: "other",
      scheduling: { disposition: "prioritize", reason: "candidate_bio_path" },
    },
    {
      leadId: "lead_candidate_bio_path",
      sourceUrl: "https://robotics.example/people/alex-rivera",
      title: "Alex Rivera | Robotics",
      lane: "t6.candidate_public_source",
      tier: 6,
      type: "other",
      scheduling: { disposition: "prioritize", reason: "candidate_bio_path" },
    },
    {
      leadId: "lead_neutral_profile",
      sourceUrl: "https://github.com/alex-rivera",
      title: "Alex Rivera · GitHub",
      lane: "t2.structured_professional",
      tier: 2,
      type: "code_profile",
      scheduling: { disposition: "neutral", reason: "neutral" },
    },
  ];
  const expectedDecisions = leads
    .slice(1)
    .map((lead) => search.discoveryLeadSchedulingDecision(lead.sourceUrl, lead.title, { personNames: [targetRaw] }));
  assert.deepEqual(
    expectedDecisions,
    leads.slice(1).map((lead) => lead.scheduling),
  );

  let emittedLeads = false;
  let ordinaryPlannerCalls = 0;
  const fetchedLeadIds = [];
  const qualityRoleLeadIds = [];
  let synthesisCalls = 0;
  let fetchedCountAtFirstSynthesis = null;
  const updates = [];
  for await (const update of agent.runResearch(
    input,
    {
      clock: domain.createSequenceClock("2026-08-21T20:00:00.000Z", 1),
      ids: domain.createDeterministicIdFactory("deep-backup-quality-probe"),
      planner: async ({ selectedFrontierEntries }) => {
        ordinaryPlannerCalls += 1;
        return {
          kind: "actions",
          decisionSummary: "Resume the ordinary bounded lead traversal.",
          actions: selectedFrontierEntries.map((entry) => ({
            frontierEntryId: entry.id,
            tool: entry.allowedTools[0],
            purpose: "Execute the selected ordinary capability.",
            arguments:
              entry.allowedTools[0] === "search_web" ? { query: entry.queryHint } : { leadId: entry.queryHint },
            ...(entry.candidateId ? { candidateId: entry.candidateId } : {}),
          })),
        };
      },
      executeAction: async (action) => {
        if (action.tool === "search_web") {
          if (!emittedLeads && action.sourceLaneId === "t1.first_party") {
            emittedLeads = true;
            return {
              status: "succeeded",
              candidates: [{ ref: "alex_query_subject", displayName: targetRaw }],
              evidence: leads.map((lead) => ({
                candidateRef: "alex_query_subject",
                claim: `Public discovery surfaced ${lead.title}.`,
                disposition: "discovery_only",
                sourceUrl: lead.sourceUrl,
                title: lead.title,
                sourceType: "search_result",
                canonicalSubset: { providerAttestedUrl: true },
                verificationMethod: "search_discovery",
                attributes: {
                  leadId: lead.leadId,
                  classifiedSourceLaneId: lead.lane,
                  classifiedSourceTier: lead.tier,
                  classifiedSourceType: lead.type,
                  leadSchedulingDisposition: lead.scheduling.disposition,
                  leadSchedulingReason: lead.scheduling.reason,
                },
              })),
              meta: { requests: 1, bytesRead: 0, incomplete: false, llmCalls: 0 },
            };
          }
          return {
            status: "not_found",
            evidence: [],
            meta: { requests: 1, bytesRead: 0, incomplete: false, llmCalls: 0 },
          };
        }
        if (action.tool === "fetch_public_source") {
          fetchedLeadIds.push(action.arguments.leadId);
          if (action.executionRole === "quality_probe") qualityRoleLeadIds.push(action.arguments.leadId);
          const lead = leads.find((item) => item.leadId === action.arguments.leadId);
          assert.ok(lead);
          if (lead.leadId === "lead_exact_subject_probe") {
            return {
              status: "succeeded",
              evidence: [
                {
                  candidateId: action.candidateId,
                  claim: targetRaw,
                  excerpt: targetRaw,
                  title: targetRaw,
                  sourceUrl: lead.sourceUrl,
                  sourceType: lead.type,
                  httpStatus: 200,
                  contentHash: `sha256:${"1".repeat(64)}`,
                  verificationMethod: "direct_fetch",
                },
              ],
              meta: { requests: 1, bytesRead: 64, incomplete: false, llmCalls: 0 },
            };
          }
          if (lead.leadId === "lead_exact_personal_profile") {
            return {
              status: "succeeded",
              evidence: [
                {
                  candidateId: action.candidateId,
                  claim: `${targetRaw} founded Example Robotics and serves as its chief engineer.`,
                  excerpt: `${targetRaw} founded Example Robotics and serves as its chief engineer.`,
                  title: lead.title,
                  sourceUrl: lead.sourceUrl,
                  sourceType: lead.type,
                  httpStatus: 200,
                  contentHash: `sha256:${"2".repeat(64)}`,
                  verificationMethod: "direct_fetch",
                },
              ],
              meta: { requests: 1, bytesRead: 160, incomplete: false, llmCalls: 0 },
            };
          }
          return {
            status: "not_found",
            evidence: [],
            meta: { requests: 1, bytesRead: 0, incomplete: false, llmCalls: 0 },
          };
        }
        throw new Error(`Unexpected backup-probe action ${action.tool}`);
      },
      synthesize: async (_state, context) => {
        synthesisCalls += 1;
        if (fetchedCountAtFirstSynthesis === null) fetchedCountAtFirstSynthesis = fetchedLeadIds.length;
        assert.equal(context.modelAccounting.reserve(), true);
        context.modelAccounting.settle({ networkRequests: 1 });
        throw new Error("simulated synthesis outage after the informative backup probe");
      },
    },
    {
      availableTools: ["search_web", "fetch_public_source"],
      budget: { maxTurns: 10, maxLlmCalls: 6 },
    },
  ))
    updates.push(update);

  const completed = updates.at(-1);
  assert.equal(completed.type, "completed");
  assert.equal(fetchedLeadIds[0], "lead_exact_subject_probe", "the persisted focus probe must run first");
  assert.equal(fetchedLeadIds.length, leads.length, "ordinary candidate fanout must resume after the focus probe");
  assert.ok(ordinaryPlannerCalls > 0, "ordinary work must return to the planner after the mechanical probes");
  const qualityEvents = completed.trace.events.filter((event) => event.name === "frontier.quality_probe_selected");
  assert.deepEqual(
    qualityEvents.map((event) => [event.payload.leadId, event.payload.probeOrdinal]),
    [["lead_exact_subject_probe", 1]],
  );
  assert.deepEqual(
    qualityEvents.map((event) => event.payload.interleavedBeforeCanonicalBreadth),
    [true],
    "the single persisted-priority probe may interleave with canonical breadth",
  );
  const canonicalSearchEnds = completed.trace.events.filter(
    (event) => event.kind === "span_end" && event.name === "tool.search_web",
  );
  const leadFetchStarts = completed.trace.events.filter(
    (event) => event.kind === "span_start" && event.name === "tool.fetch_public_source",
  );
  assert.equal(canonicalSearchEnds.length, plan.queries.length);
  assert.ok(
    leadFetchStarts[0].seq < Math.max(...canonicalSearchEnds.map((event) => event.seq)),
    "the persisted-priority probe must run before the remaining canonical searches",
  );
  assert.equal(
    completed.trace.events.filter((event) => event.name === "scheduler.quality_probe_routed").length,
    1,
    "the focus path must never route more than one grounding probe",
  );
  assert.deepEqual(
    qualityRoleLeadIds,
    ["lead_exact_subject_probe"],
    "only the mechanically selected focus probe may receive the server-owned execution role",
  );
  assert.equal(
    fetchedCountAtFirstSynthesis,
    leads.length,
    "a bare-name direct quote must not truncate the remaining focused source traversal",
  );
  assert.equal(synthesisCalls, 1);
  const bareEvidence = completed.report.evidence.find((evidence) => evidence.claim === targetRaw);
  const durableClaim = `${targetRaw} founded Example Robotics and serves as its chief engineer.`;
  const durableEvidence = completed.report.evidence.find((evidence) => evidence.claim === durableClaim);
  assert.ok(bareEvidence && durableEvidence);
  assert.ok(
    bareEvidence.id.localeCompare(durableEvidence.id) < 0,
    "the earlier bare-name ID must lose to the later informative exact quote",
  );
  assert.equal(completed.report.findings.length, 1);
  assert.equal(completed.report.findings[0].title, `Identity — ${targetRaw}`);
  assert.equal(completed.report.findings[0].category, "identity");
  assert.deepEqual(completed.report.findings[0].evidenceIds, [durableEvidence.id]);
  assert.equal(completed.report.findings[0].description, durableClaim);
  assert.equal(completed.report.findings[0].confidence.label, "low");
  assert.ok(completed.report.findings[0].confidence.score < 0.45);
  assert.ok(fetchedLeadIds.includes("lead_candidate_bio_path"), "a third prioritized lead remains ordinary fanout");
  assert.ok(fetchedLeadIds.includes("lead_neutral_profile"));
  assert.deepEqual(search.validateSearchGraph(completed.report.searchGraph), []);
  assert.deepEqual(domain.validateReferentialIntegrity(completed.state), []);
});

test("deterministic fallback retains a bare-name direct quote when it is the sole eligible record", async () => {
  const targetRaw = "Casey Morgan";
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: targetRaw,
    requestedDepth: "deep",
  });
  const lead = {
    leadId: "lead_casey_exact_subject",
    sourceUrl: "https://official.example/casey-morgan",
    title: "Public source at official.example",
  };
  let emittedLead = false;
  let synthesisCalls = 0;
  const updates = [];
  for await (const update of agent.runResearch(
    input,
    {
      clock: domain.createSequenceClock("2026-08-21T20:20:00.000Z", 1),
      ids: domain.createDeterministicIdFactory("bare-name-only-deterministic-fallback"),
      planner: async ({ selectedFrontierEntries }) => ({
        kind: "actions",
        decisionSummary: "Execute the remaining bounded public capability.",
        actions: selectedFrontierEntries.map((entry) => ({
          frontierEntryId: entry.id,
          tool: entry.allowedTools[0],
          purpose: "Execute one selected public capability.",
          arguments: entry.allowedTools[0] === "search_web" ? { query: entry.queryHint } : { leadId: entry.queryHint },
          ...(entry.candidateId ? { candidateId: entry.candidateId } : {}),
        })),
      }),
      executeAction: async (action) => {
        if (action.tool === "search_web") {
          if (!emittedLead && action.sourceLaneId === "t1.first_party") {
            emittedLead = true;
            return {
              status: "succeeded",
              candidates: [{ ref: "casey_query_subject", displayName: targetRaw }],
              evidence: [
                {
                  candidateRef: "casey_query_subject",
                  claim: `Public discovery surfaced ${lead.title}.`,
                  disposition: "discovery_only",
                  sourceUrl: lead.sourceUrl,
                  title: lead.title,
                  sourceType: "search_result",
                  canonicalSubset: { providerAttestedUrl: true },
                  verificationMethod: "search_discovery",
                  attributes: {
                    leadId: lead.leadId,
                    classifiedSourceLaneId: "t6.candidate_public_source",
                    classifiedSourceTier: 6,
                    classifiedSourceType: "other",
                    leadSchedulingDisposition: "prioritize",
                    leadSchedulingReason: "exact_subject_slug_probe",
                  },
                },
              ],
              meta: { requests: 1, bytesRead: 0, incomplete: false, llmCalls: 0 },
            };
          }
          return {
            status: "not_found",
            evidence: [],
            meta: { requests: 1, bytesRead: 0, incomplete: false, llmCalls: 0 },
          };
        }
        if (action.tool === "fetch_public_source") {
          assert.equal(action.arguments.leadId, lead.leadId);
          return {
            status: "succeeded",
            evidence: [
              {
                candidateId: action.candidateId,
                claim: targetRaw,
                excerpt: targetRaw,
                title: targetRaw,
                sourceUrl: lead.sourceUrl,
                sourceType: "other",
                httpStatus: 200,
                contentHash: `sha256:${"3".repeat(64)}`,
                verificationMethod: "direct_fetch",
              },
            ],
            meta: { requests: 1, bytesRead: 64, incomplete: false, llmCalls: 0 },
          };
        }
        throw new Error(`Unexpected bare-only fallback action ${action.tool}`);
      },
      synthesize: async (_state, context) => {
        synthesisCalls += 1;
        assert.equal(context.modelAccounting.reserve(), true);
        context.modelAccounting.settle({ networkRequests: 1 });
        throw new Error("simulated synthesis outage with one bare-name direct quote");
      },
    },
    {
      availableTools: ["search_web", "fetch_public_source"],
      budget: { maxTurns: 10, maxLlmCalls: 6 },
    },
  ))
    updates.push(update);

  const completed = updates.at(-1);
  assert.equal(completed.type, "completed");
  assert.equal(synthesisCalls, 1);
  const direct = completed.report.evidence.find(
    (evidence) => evidence.verificationMethod === "direct_fetch" && evidence.claim === targetRaw,
  );
  assert.ok(direct);
  assert.equal(completed.report.findings.length, 1);
  const finding = completed.report.findings[0];
  assert.equal(finding.title, `Identity — ${targetRaw}`);
  assert.equal(finding.description, targetRaw);
  assert.deepEqual(finding.evidenceIds, [direct.id]);
  assert.equal(finding.confidence.label, "low");
  assert.ok(finding.confidence.score < 0.45);
  assert.ok(
    completed.trace.events.some((event) =>
      event.payload?.diagnostics?.some((diagnostic) => diagnostic.code === "deterministic_finding_fallback_used"),
    ),
  );
  assert.deepEqual(search.validateSearchGraph(completed.report.searchGraph), []);
  assert.deepEqual(domain.validateReferentialIntegrity(completed.state), []);
});

test("standard runner never enables the Deep-only quality-probe fallback", async () => {
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: "Alex Rivera",
    requestedDepth: "standard",
  });
  let emittedLeads = false;
  let plannerFetches = 0;
  const updates = [];
  for await (const update of agent.runResearch(
    input,
    {
      clock: domain.createSequenceClock("2026-08-21T20:10:00.000Z", 1),
      ids: domain.createDeterministicIdFactory("standard-no-quality-probe"),
      planner: async ({ selectedFrontierEntries }) => ({
        kind: "actions",
        decisionSummary: "Use the standard planner path.",
        actions: selectedFrontierEntries.map((entry) => {
          if (entry.allowedTools[0] === "fetch_public_source") plannerFetches += 1;
          return {
            frontierEntryId: entry.id,
            tool: entry.allowedTools[0],
            purpose: "Execute the standard selected capability.",
            arguments:
              entry.allowedTools[0] === "search_web" ? { query: entry.queryHint } : { leadId: entry.queryHint },
            ...(entry.candidateId ? { candidateId: entry.candidateId } : {}),
          };
        }),
      }),
      executeAction: async (action) => {
        if (action.tool === "search_web" && !emittedLeads) {
          emittedLeads = true;
          return {
            status: "succeeded",
            candidates: [{ ref: "alex_standard_subject", displayName: "Alex Rivera" }],
            evidence: [
              {
                candidateRef: "alex_standard_subject",
                claim: "Public discovery surfaced an exact-name biography path.",
                disposition: "discovery_only",
                sourceUrl: "https://official.example/alex-rivera",
                title: "Public source at official.example",
                sourceType: "search_result",
                canonicalSubset: { providerAttestedUrl: true },
                verificationMethod: "search_discovery",
                attributes: {
                  leadId: "lead_standard_prioritized",
                  classifiedSourceLaneId: "t6.candidate_public_source",
                  classifiedSourceTier: 6,
                  classifiedSourceType: "other",
                  leadSchedulingDisposition: "prioritize",
                  leadSchedulingReason: "exact_subject_slug_probe",
                },
              },
            ],
            meta: { requests: 1, bytesRead: 0, incomplete: false, llmCalls: 0 },
          };
        }
        if (action.tool === "fetch_public_source") {
          return {
            status: "not_found",
            evidence: [],
            meta: { requests: 1, bytesRead: 0, incomplete: false, llmCalls: 0 },
          };
        }
        return {
          status: "not_found",
          evidence: [],
          meta: { requests: 1, bytesRead: 0, incomplete: false, llmCalls: 0 },
        };
      },
    },
    { availableTools: ["search_web", "fetch_public_source"], budget: { maxTurns: 6 } },
  ))
    updates.push(update);

  const completed = updates.at(-1);
  assert.equal(completed.type, "completed");
  assert.ok(plannerFetches > 0, "standard traversal must keep its existing planner path");
  assert.equal(completed.trace.events.filter((event) => event.name === "frontier.quality_probe_selected").length, 0);
  assert.equal(completed.trace.events.filter((event) => event.name === "scheduler.quality_probe_routed").length, 0);
  assert.deepEqual(search.validateSearchGraph(completed.report.searchGraph), []);
});

test("deep runner spends the reserved final synthesis call after the last opaque lead settles", async () => {
  const targetRaw = "Jordan Lee";
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: targetRaw,
    requestedDepth: "deep",
  });
  const plan = search.compileOsintQueries(domain.parseTarget(input));
  assert.equal(plan.status, "compiled");

  let emittedLead = false;
  let leadPlannerCalls = 0;
  let fetchCalls = 0;
  let synthesisCalls = 0;
  const updates = [];
  for await (const update of agent.runResearch(
    input,
    {
      clock: domain.createSequenceClock("2026-08-21T10:30:00.000Z", 1),
      ids: domain.createDeterministicIdFactory("deep-last-lead-final-synthesis"),
      planner: async ({ selectedFrontierEntries, modelAccounting }) => {
        leadPlannerCalls += 1;
        assert.equal(modelAccounting.reserve(), true);
        modelAccounting.settle({ networkRequests: 1 });
        return {
          kind: "actions",
          decisionSummary: "Fetch the final exact opaque lead.",
          actions: selectedFrontierEntries.map((entry) => ({
            frontierEntryId: entry.id,
            tool: "fetch_public_source",
            purpose: "Fetch the final bounded public lead.",
            arguments: { leadId: entry.queryHint },
            candidateId: entry.candidateId,
          })),
        };
      },
      executeAction: async (action, context) => {
        if (action.tool === "search_web") {
          if (!emittedLead && action.sourceLaneId === "t1.first_party") {
            emittedLead = true;
            return {
              status: "succeeded",
              candidates: [{ ref: "jordan_query_subject", displayName: targetRaw }],
              evidence: [
                {
                  candidateRef: "jordan_query_subject",
                  claim: "Public discovery surfaced one canonical GitHub profile lead.",
                  disposition: "discovery_only",
                  sourceUrl: "https://github.com/jordan-lee",
                  title: "Jordan Lee · GitHub",
                  sourceType: "search_result",
                  canonicalSubset: { providerAttestedUrl: true },
                  verificationMethod: "search_discovery",
                  attributes: {
                    leadId: "lead_jordan_final",
                    classifiedSourceLaneId: "t2.structured_professional",
                    classifiedSourceTier: 2,
                    classifiedSourceType: "code_profile",
                    leadSchedulingDisposition: "neutral",
                    leadSchedulingReason: "neutral",
                  },
                },
              ],
              meta: { requests: 1, bytesRead: 0, incomplete: false, llmCalls: 0 },
            };
          }
          return {
            status: "not_found",
            evidence: [],
            meta: { requests: 1, bytesRead: 0, incomplete: false, llmCalls: 0 },
          };
        }
        if (action.tool === "fetch_public_source") {
          fetchCalls += 1;
          assert.equal(context.modelAccounting.reserve(), true);
          context.modelAccounting.settle({ networkRequests: 1 });
          return {
            status: "succeeded",
            evidence: [
              {
                candidateId: action.candidateId,
                claim: targetRaw,
                excerpt: targetRaw,
                sourceUrl: "https://github.com/jordan-lee",
                sourceType: "code_profile",
                httpStatus: 200,
                verificationMethod: "direct_fetch",
              },
            ],
            meta: { requests: 1, bytesRead: 64, incomplete: false, llmCalls: 0 },
          };
        }
        throw new Error(`Unexpected test action ${action.tool}`);
      },
      synthesize: async (state, context) => {
        synthesisCalls += 1;
        assert.ok(
          state.evidence.some(
            (evidence) =>
              evidence.disposition === "supports" &&
              evidence.sourceType === "code_profile" &&
              evidence.verificationMethod === "direct_fetch" &&
              evidence.excerpt === targetRaw,
          ),
          "the final synthesis call must follow newly admitted useful direct support",
        );
        assert.equal(context.modelAccounting.reserve(), true, "the post-last-lead synthesis call must remain callable");
        context.modelAccounting.settle({ networkRequests: 1 });
        return { decisionSummary: "The exhausted lead set was synthesized once.", findings: [], openQuestions: [] };
      },
    },
    {
      availableTools: ["search_web", "fetch_public_source"],
      budget: { maxLlmCalls: 3 },
    },
  ))
    updates.push(update);

  const completed = updates.at(-1);
  assert.equal(completed.type, "completed");
  assert.equal(leadPlannerCalls, 1);
  assert.equal(fetchCalls, 1);
  assert.equal(synthesisCalls, 1);
  assert.equal(completed.report.usage.llmCalls, 3);
  assert.deepEqual(completed.report.findings, [], "successful empty synthesis remains an intentional abstention");
  assert.equal(
    completed.report.searchGraph.frontier.filter(
      (entry) => entry.leadId && ["queued", "mutated", "selected", "running"].includes(entry.status),
    ).length,
    0,
    "the regression must settle the last finite lead before synthesis",
  );
  const fetchEnd = completed.trace.events.find(
    (event) => event.kind === "span_end" && event.name === "tool.fetch_public_source",
  );
  const synthesisStart = completed.trace.events.find(
    (event) => event.kind === "span_start" && event.name === "synthesis.findings",
  );
  assert.ok(fetchEnd && synthesisStart && fetchEnd.seq < synthesisStart.seq);
  assert.equal(completed.trace.events.filter((event) => event.name === "synthesis.final_call_reserved").length, 1);
  assert.deepEqual(search.validateSearchGraph(completed.report.searchGraph), []);
  assert.deepEqual(domain.validateReferentialIntegrity(completed.state), []);
});

test("terminal exhaustion never claims an unexecuted compiler query ran", async () => {
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: "Taylor Morgan, Example University",
    requestedDepth: "deep",
  });
  const updates = [];
  for await (const update of agent.runResearch(
    input,
    {
      clock: domain.createSequenceClock("2026-08-20T20:27:25.000Z", 1),
      ids: domain.createDeterministicIdFactory("unexecuted-compiler-honesty"),
      planner: async ({ selectedFrontierEntries }) => ({
        kind: "actions",
        decisionSummary: "Execute only the bounded selected queries.",
        actions: selectedFrontierEntries.map((entry) => ({
          frontierEntryId: entry.id,
          tool: "search_web",
          purpose: "Run one canonical query.",
          arguments: { query: entry.queryHint },
        })),
      }),
      executeAction: async () => ({
        status: "not_found",
        evidence: [],
        meta: { requests: 1, bytesRead: 0, llmCalls: 0 },
      }),
    },
    {
      availableTools: ["search_web"],
      budget: { maxToolCalls: 2, maxSearchCalls: 2 },
    },
  ))
    updates.push(update);

  const completed = updates.at(-1);
  assert.equal(completed.type, "completed");
  const compilerEntries = completed.report.searchGraph.frontier.filter((entry) =>
    search.isCanonicalCompilerSearchEntry(entry),
  );
  const searchSpans = completed.trace.events.filter(
    (event) => event.kind === "span_start" && event.name === "tool.search_web",
  );
  const executedIds = new Set(searchSpans.map((event) => event.payload.frontierEntryId));
  const unexecutedCompilerEntries = compilerEntries.filter((entry) => !executedIds.has(entry.id));
  assert.equal(searchSpans.length, 2);
  assert.ok(unexecutedCompilerEntries.length > 0);
  assert.ok(
    unexecutedCompilerEntries.every(
      (entry) =>
        !completed.trace.events.some(
          (event) =>
            event.kind === "span_end" && event.name === "tool.search_web" && event.payload.frontierEntryId === entry.id,
        ),
    ),
  );
  assert.equal(completed.report.stop.reason, "budget_exhausted");
  assert.deepEqual(search.validateSearchGraph(completed.report.searchGraph), []);
});

test("a Deep synthesis outage is deferred until canonical frontier work is exhausted", async () => {
  const targetRaw = "Chinmay Bhat";
  const queryPlan = search.compileOsintQueries(domain.parseTarget(targetRaw));
  assert.equal(queryPlan.status, "compiled");
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: targetRaw,
    requestedDepth: "deep",
  });
  const executedQueries = [];
  let plannerCalls = 0;
  let synthesisCalls = 0;
  let firstAction = true;
  const updates = [];

  for await (const update of agent.runResearch(
    input,
    {
      clock: domain.createSequenceClock("2026-08-20T20:27:30.000Z", 1),
      ids: domain.createDeterministicIdFactory("phase-cap-synthesis-outage"),
      planner: async ({ selectedFrontierEntries }) => {
        plannerCalls += 1;
        return {
          kind: "actions",
          decisionSummary: "Execute only the selected bounded public-professional frontier entries.",
          actions: selectedFrontierEntries.map((entry) => ({
            frontierEntryId: entry.id,
            tool: entry.allowedTools[0],
            purpose: "Execute the selected public-professional source lane.",
            arguments:
              entry.allowedTools[0] === "search_web" ? { query: entry.queryHint } : { leadId: entry.queryHint },
            ...(entry.candidateId ? { candidateId: entry.candidateId } : {}),
          })),
        };
      },
      executeAction: async (action) => {
        if (action.tool === "fetch_public_source") {
          return {
            status: "succeeded",
            evidence: [
              {
                claim: "Chinmay Bhat has a public professional profile.",
                excerpt: "Chinmay Bhat has a public professional profile.",
                candidateId: action.candidateId,
                sourceUrl: "https://github.com/chinmay-bhat",
                sourceType: "code_profile",
                httpStatus: 200,
                verificationMethod: "direct_fetch",
              },
            ],
            meta: { requests: 0, bytesRead: 96, incomplete: false, llmCalls: 0 },
          };
        }
        executedQueries.push(action.arguments.query);
        if (firstAction) {
          firstAction = false;
          return {
            status: "succeeded",
            candidates: [{ ref: "chinmay", displayName: targetRaw, frontierExpansion: "none" }],
            evidence: [
              {
                candidateRef: "chinmay",
                claim: "The canonical discovery query returned one bounded public profile lead.",
                disposition: "discovery_only",
                sourceUrl: "https://github.com/chinmay-bhat",
                sourceType: "search_result",
                canonicalSubset: { providerAttestedUrl: true },
                verificationMethod: "search_discovery",
                attributes: {
                  leadId: "lead_chinmay_profile",
                  classifiedSourceLaneId: "t2.structured_professional",
                  classifiedSourceTier: 2,
                  classifiedSourceType: "code_profile",
                  leadSchedulingDisposition: "prioritize",
                  leadSchedulingReason: "exact_subject_slug_probe",
                },
              },
            ],
            meta: { requests: 0, bytesRead: 0, incomplete: false, llmCalls: 0 },
          };
        }
        return {
          status: "not_found",
          evidence: [],
          meta: { requests: 0, bytesRead: 0, incomplete: false, llmCalls: 0 },
        };
      },
      synthesize: async () => {
        synthesisCalls += 1;
        throw new Error("forced synthesis outage after corroboration cap");
      },
    },
    {
      availableTools: ["search_web", "fetch_public_source"],
      budget: {
        maxTurns: 8,
        maxLlmCalls: 12,
        maxToolCalls: 20,
        maxSearchCalls: 20,
        maxConsecutiveNoProgress: 8,
        maxActionsPerTurn: 6,
        phaseCaps: { plan: 1, discover: 2, separate_candidates: 2, corroborate: 1, calibrate: 4, report: 1 },
      },
    },
  ))
    updates.push(update);

  const completed = updates.at(-1);
  assert.equal(completed.type, "completed");
  assert.equal(completed.report.stop.reason, "no_legal_actions");
  assert.equal(synthesisCalls, 1, "the provider outage opens a run-scoped synthesis circuit");

  const toolStarts = completed.trace.events.filter(
    (event) => event.kind === "span_start" && event.name === "tool.search_web",
  );
  const directFetchStarts = completed.trace.events.filter(
    (event) => event.kind === "span_start" && event.name === "tool.fetch_public_source",
  );
  const executedFrontierIds = new Set(toolStarts.map((event) => event.payload.frontierEntryId));
  assert.equal(toolStarts.length, executedQueries.length);
  assert.equal(directFetchStarts.length, 1);
  assert.equal(completed.report.usage.toolCalls, executedQueries.length + directFetchStarts.length);
  assert.equal(completed.report.usage.llmCalls, plannerCalls + synthesisCalls);
  assert.ok(completed.report.usage.llmCalls < completed.state.budget.limits.maxLlmCalls);
  assert.equal(executedFrontierIds.size, toolStarts.length, "frontier actions remain at-most-once");

  const compilerEntries = completed.report.searchGraph.frontier.filter((entry) =>
    search.isCanonicalCompilerSearchEntry(entry),
  );
  assert.equal(compilerEntries.length, queryPlan.queries.length);
  assert.ok(
    compilerEntries.every((entry) => executedFrontierIds.has(entry.id)),
    "every finite compiler query must reach its tool adapter despite the synthesis outage",
  );
  assert.deepEqual(
    executedQueries.filter((query) => queryPlan.queries.some((compiled) => compiled.query === query)).sort(),
    queryPlan.queries.map((query) => query.query).sort(),
  );
  const t6CompilerEntries = compilerEntries.filter((entry) => entry.sourceTier === 6);
  assert.equal(
    t6CompilerEntries.length,
    queryPlan.queries.filter(
      (query) =>
        query.kind === "exact_refinement" ||
        ["professional_content", "public_thread", "public_forum"].includes(query.kind),
    ).length,
  );
  assert.ok(
    t6CompilerEntries.every((entry) => executedFrontierIds.has(entry.id)),
    "every focused professional-content, public-thread, forum, and exact-refinement T6 query must execute exactly once",
  );

  const synthesisEnds = completed.trace.events.filter(
    (event) => event.kind === "span_end" && event.name === "synthesis.findings",
  );
  assert.equal(synthesisEnds.length, 1);
  assert.equal(synthesisEnds[0].status, "failed");
  assert.ok(
    Math.max(...toolStarts.map((event) => event.seq)) < synthesisEnds[0].seq,
    "the first synthesis attempt must follow every finite canonical search adapter call",
  );
  const capStops = completed.trace.events.filter(
    (event) => event.name === "phase.cap_reached" && event.payload.reason === "pending_frontier_continues_in_calibrate",
  );
  assert.equal(capStops.length, 0, "deferred synthesis no longer needs a calibrate-to-corroborate recovery loop");

  const { limits, usage } = completed.state.budget;
  for (const [phase, turns] of Object.entries(usage.phaseTurns)) {
    const cap = limits.phaseCaps[phase];
    if (cap !== undefined) assert.ok(turns <= cap, `${phase} exceeded its configured turn cap`);
  }
  assert.equal(usage.phaseTurns.corroborate, 1);
  assert.ok(usage.phaseTurns.calibrate > 0);
  assert.deepEqual(search.validateSearchGraph(completed.report.searchGraph), []);
  assert.deepEqual(domain.validateReferentialIntegrity(completed.state), []);
});

test("runner opens and executes Keybase only after a GitHub handle is grounded, then reaches T3 and T6", async () => {
  const targetRaw = "Chinmay Bhat";
  const input = domain.parseInvestigationInput({
    schemaVersion: domain.SCHEMA_VERSION,
    query: targetRaw,
    requestedDepth: "deep",
  });
  let emittedGithubLead = false;
  let keybaseCalls = 0;
  let plannerProviderCalls = 0;
  let providerCallsAtKeybase = null;
  const liveDependencies = live.createLiveDependencies(input, {
    apiKey: "test-key",
    model: "test/model",
    fetch: async () => {
      plannerProviderCalls += 1;
      return new Response(JSON.stringify({ error: { message: "planner quota exhausted" } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "0" },
      });
    },
  });
  const updates = [];
  for await (const update of agent.runResearch(
    input,
    {
      clock: domain.createSequenceClock("2026-08-20T20:28:00.000Z", 1),
      ids: domain.createDeterministicIdFactory("grounded-keybase-lifecycle"),
      planner: liveDependencies.planner,
      executeAction: async (action) => {
        if (
          action.tool === "search_web" &&
          action.sourceLaneId === "t6.general_discovery" &&
          !action.arguments.query.includes('"C. Bhat"') &&
          !emittedGithubLead
        ) {
          emittedGithubLead = true;
          return {
            status: "succeeded",
            candidates: [{ ref: "chinmay", displayName: targetRaw }],
            evidence: [
              {
                candidateRef: "chinmay",
                claim: "Search surfaced one exact GitHub public-profile lead.",
                disposition: "discovery_only",
                sourceUrl: "https://github.com/chinmay-bhat",
                sourceType: "search_result",
                canonicalSubset: { providerAttestedUrl: true },
                verificationMethod: "search_discovery",
                attributes: {
                  leadId: "lead_chinmay_github",
                  classifiedSourceLaneId: "t2.structured_professional",
                  classifiedSourceTier: 2,
                  classifiedSourceType: "code_profile",
                },
              },
            ],
            meta: { requests: 1, bytesRead: 0, incomplete: false, llmCalls: 0 },
          };
        }
        if (action.tool === "fetch_public_source") {
          return {
            status: "succeeded",
            evidence: [
              {
                candidateId: action.candidateId,
                claim: "Chinmay Bhat — chinmay-bhat",
                excerpt: "Chinmay Bhat — chinmay-bhat",
                title: "Chinmay Bhat (chinmay-bhat)",
                sourceUrl: "https://github.com/chinmay-bhat",
                sourceType: "code_profile",
                httpStatus: 200,
                verificationMethod: "direct_fetch",
              },
            ],
            candidateSignals: [
              {
                candidateId: action.candidateId,
                signals: [
                  {
                    kind: "social_handle",
                    value: "chinmay-bhat",
                    normalizedValue: "chinmay-bhat",
                    strength: "strong",
                    assurance: "spoofable",
                    sourceFamily: "github.com",
                  },
                ],
              },
            ],
            meta: { requests: 1, bytesRead: 128, incomplete: false, llmCalls: 0 },
          };
        }
        if (action.tool === "keybase_identity_proofs") {
          keybaseCalls += 1;
          providerCallsAtKeybase = plannerProviderCalls;
          assert.equal(action.arguments.githubHandle, "chinmay-bhat");
          return { status: "not_found", evidence: [], meta: { requests: 1, bytesRead: 0, llmCalls: 0 } };
        }
        return { status: "not_found", evidence: [], meta: { requests: 1, bytesRead: 0, llmCalls: 0 } };
      },
      synthesize: async () => ({ decisionSummary: "No findings.", openQuestions: [], findings: [] }),
    },
    {
      availableTools: ["search_web", "fetch_public_source", "keybase_identity_proofs"],
      budget: { maxTurns: 16, maxToolCalls: 32, maxSearchCalls: 24 },
    },
  ))
    updates.push(update);

  const completed = updates.at(-1);
  const specialist = completed.report.searchGraph.frontier.find((entry) =>
    entry.allowedTools.includes("keybase_identity_proofs"),
  );
  assert.equal(
    keybaseCalls,
    1,
    JSON.stringify({
      stop: completed.report.stop,
      candidates: completed.report.candidates,
      frontier: completed.report.searchGraph.frontier.map((entry) => ({
        id: entry.id,
        lane: entry.sourceLaneId,
        tools: entry.allowedTools,
        hint: entry.queryHint,
        leadId: entry.leadId,
        parent: entry.parentFrontierEntryId,
        status: entry.status,
      })),
      rejectedSignals: completed.trace.events.filter((event) => event.name === "candidate_signal.rejected"),
      evidenceAdmissions: completed.trace.events.filter((event) => event.name === "evidence.admission"),
      actionRejected: completed.trace.events.filter((event) => event.name === "action.rejected"),
    }),
  );
  assert.equal(
    plannerProviderCalls,
    0,
    "Deep canonical discovery and grounded lead/specialist dependencies require no model planner call",
  );
  assert.equal(
    providerCallsAtKeybase,
    plannerProviderCalls,
    "the grounded Keybase action must be routed mechanically without another provider attempt",
  );
  assert.equal(
    completed.trace.events.filter(
      (event) => event.name === "planner.decision" && event.kind === "span_end" && event.usage.llmCalls === 1,
    ).length,
    0,
  );
  assert.ok(completed.trace.events.some((event) => event.name === "scheduler.canonical_batch_routed"));
  assert.ok(specialist);
  assert.equal(specialist.queryHint, "chinmay-bhat");
  assert.equal(specialist.status, "exhausted");
  const specialistParent = completed.report.searchGraph.frontier.find(
    (entry) => entry.id === specialist.parentFrontierEntryId,
  );
  assert.equal(specialistParent.leadId, "lead_chinmay_github");
  const candidate = completed.report.candidates.find((item) => item.id === specialist.candidateId);
  assert.ok(
    candidate.signals.some(
      (signal) =>
        signal.kind === "social_handle" &&
        signal.normalizedValue === "chinmay-bhat" &&
        signal.sourceFamily === "github.com" &&
        Boolean(signal.sourceEvidenceId),
    ),
  );
  assert.ok(
    completed.report.searchGraph.frontier
      .filter((entry) => ["t3.institutional", "t6.general_discovery"].includes(entry.sourceLaneId))
      .every((entry) => entry.status === "exhausted"),
    "grounded specialist handling must not strand canonical T3/T6 breadth",
  );
  assert.deepEqual(search.validateSearchGraph(completed.report.searchGraph), []);
});

test("frontier schedules exact LinkedIn, X/Twitter, and Reddit content queries in T6 without aliases", () => {
  const target = domain.parseTarget("Renée D'Angelo Smith");
  const ids = domain.createDeterministicIdFactory("compiler-name-variants");
  const seeded = search.seedFrontier(
    search.emptySearchGraph("run_compiler_name_variants", target.normalizedQuery, "2026-08-20T20:21:00.000Z"),
    target,
    ["search_web"],
    ids,
    "2026-08-20T20:21:00.001Z",
  );
  const t6Entries = seeded.value.filter((entry) => entry.sourceLaneId === "t6.general_discovery");
  assert.ok(
    t6Entries.some(
      (entry) => entry.intent.includes(": professional_content;") && entry.queryHint.includes("site:linkedin.com"),
    ),
  );
  assert.ok(
    t6Entries.some(
      (entry) =>
        entry.intent.includes(": public_thread;") &&
        entry.queryHint.includes("site:x.com") &&
        entry.queryHint.includes("site:twitter.com"),
    ),
  );
  assert.ok(
    t6Entries.some((entry) => entry.intent.includes(": public_forum;") && entry.queryHint.includes("site:reddit.com")),
  );
  assert.equal(
    t6Entries.some(
      (entry) => entry.intent.includes(": orthographic_name;") || entry.intent.includes(": initial_name;"),
    ),
    false,
  );
  assert.equal(
    t6Entries.every((entry) => entry.queryHint.includes('"Renée D\'angelo Smith"')),
    true,
  );
  assert.deepEqual(search.validateSearchGraph(seeded.graph), []);
});

test("candidate-linked exact URLs open a validated T5 dependency even after the breadth cursor advanced", () => {
  const {
    graph: seeded,
    target,
    ids,
  } = seededGraph("Denise Hilary", ["search_web", "fetch_public_source", "wayback_profile_history"]);
  const parent = seeded.frontier.find((entry) => entry.sourceLaneId === "t1.first_party");
  assert.ok(parent);
  const action = search.admitGraphNode(
    seeded,
    {
      kind: "action",
      label: "search_web — establish exact page lead",
      status: "verified",
      sourceTier: 1,
      sourceLaneId: parent.sourceLaneId,
      frontierEntryId: parent.id,
      actionId: parent.id,
      data: { tool: "search_web", budgetClass: "search", pathCost: parent.pathCost, mutated: false },
      dedupeEntityKey: `action:${parent.id}`,
    },
    ids,
    "2026-08-20T19:59:59.000Z",
  );
  const actionEdge = search.admitGraphEdge(
    action.graph,
    {
      fromNodeId: parent.nodeId,
      toNodeId: action.value.id,
      kind: "expands",
      status: "verified",
      frontierEntryId: parent.id,
      actionId: parent.id,
      edgeCost: 0.05,
      pathCost: parent.pathCost + 0.05,
    },
    ids,
    "2026-08-20T19:59:59.500Z",
  );
  const runningGraph = search.setFrontierStatus(actionEdge.graph, [parent.id], "running", "2026-08-20T19:59:59.750Z");
  const executedGraph = search.recordFrontierOutcome(
    runningGraph,
    parent,
    "verified",
    "2026-08-20T19:59:59.875Z",
  ).graph;
  const candidate = search.admitGraphNode(
    executedGraph,
    {
      kind: "candidate",
      label: "Denise Hilary",
      status: "selected",
      candidateId: "candidate-denise",
      data: {},
      dedupeEntityKey: "candidate:candidate-denise",
    },
    ids,
    "2026-08-20T20:00:00.000Z",
  );
  const candidateEdge = search.admitGraphEdge(
    candidate.graph,
    {
      fromNodeId: action.value.id,
      toNodeId: candidate.value.id,
      kind: "expands",
      status: "selected",
      frontierEntryId: parent.id,
      actionId: parent.id,
      edgeCost: 0.06,
      pathCost: parent.pathCost + 0.11,
    },
    ids,
    "2026-08-20T20:00:00.500Z",
  );
  const source = search.admitGraphNode(
    candidateEdge.graph,
    {
      kind: "source",
      label: "Denise Hilary — public profile",
      status: "verified",
      sourceTier: 1,
      sourceLaneId: parent.sourceLaneId,
      frontierEntryId: parent.id,
      actionId: parent.id,
      candidateId: "candidate-denise",
      evidenceId: "evidence-denise-page",
      data: { sourceUrl: "https://portfolio.example/denise" },
    },
    ids,
    "2026-08-20T20:00:01.000Z",
  );
  const sourceEdge = search.admitGraphEdge(
    source.graph,
    {
      fromNodeId: action.value.id,
      toNodeId: source.value.id,
      kind: "expands",
      status: "verified",
      frontierEntryId: parent.id,
      actionId: parent.id,
      edgeCost: 0.04,
      pathCost: parent.pathCost + 0.09,
    },
    ids,
    "2026-08-20T20:00:01.500Z",
  );
  const opened = search.enqueueCandidateUrlFrontier(
    sourceEdge.graph,
    target,
    { id: "candidate-denise", displayName: "Denise Hilary" },
    "https://portfolio.example/denise#about",
    parent,
    source.value.id,
    ["wayback_profile_history"],
    ids,
    "2026-08-20T20:00:02.000Z",
  );
  assert.equal(opened.value.length, 1);
  assert.equal(opened.value[0].sourceLaneId, "t5.candidate_wayback");
  assert.equal(opened.value[0].queryHint, "https://portfolio.example/denise");
  assert.deepEqual(search.validateSearchGraph(opened.graph), []);

  const advanced = structuredClone(opened.graph);
  advanced.currentSourceTier = 6;
  const selected = search.selectFrontierBatch(advanced, 1, "2026-08-20T20:00:03.000Z", {
    reserveCanonicalCompilerBreadth: true,
  });
  assert.equal(selected.value[0].sourceLaneId, "t5.candidate_wayback");
  assert.equal(selected.graph.currentSourceTier, 6, "the breadth cursor must not regress");
  assert.deepEqual(
    search.validateSearchGraph(selected.graph),
    [],
    "a selected late exact-URL dependency must remain canonical",
  );
});

test("runner executes the frontier's canonical search query, not a planner rewrite", async () => {
  let observedQuery = null;
  for await (const _update of agent.runResearch(
    "Denise Hilary",
    {
      clock: domain.createSequenceClock("2026-08-20T20:10:00.000Z", 1),
      ids: domain.createDeterministicIdFactory("canonical-query"),
      planner: async ({ selectedFrontierEntries }) => ({
        kind: "actions",
        decisionSummary: "Exercise canonical query binding.",
        actions: [
          {
            frontierEntryId: selectedFrontierEntries[0].id,
            tool: "search_web",
            purpose: "Find public professional sources.",
            arguments: { query: "Denise Hilary broadened by the planner" },
          },
        ],
      }),
      executeAction: async (action) => {
        observedQuery = action.arguments.query;
        return { status: "not_found", evidence: [], meta: { requests: 0 } };
      },
    },
    { availableTools: ["search_web"], budget: { maxTurns: 1 } },
  ))
    void _update;
  assert.equal(observedQuery, '"Denise Hilary"');
});

test("frontier dedupes dominated pivots and validates registered and canonical generic lanes", () => {
  const { graph, target, ids } = seededGraph("Ada Lovelace", ["search_web"]);
  const original = graph.frontier[0];
  const lane = search.sourceLaneById(original.sourceLaneId);
  const duplicate = search.enqueueFrontier(
    graph,
    {
      lane,
      target,
      parentNodeId: graph.seedNodeId,
      queryHint: original.queryHint,
    },
    ids,
    "2026-08-19T17:00:04.000Z",
  );
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
    (entry) => {
      entry.sourceLaneId = "t6.tool.forged_registry";
    },
    (entry) => {
      entry.sourceTier = 1;
    },
    (entry) => {
      entry.allowedTools = ["professional_registry_search", "search_web"];
    },
    (entry) => {
      entry.candidateId = "candidate_forged";
    },
  ]) {
    const forgedGeneric = structuredClone(genericGraph);
    mutate(forgedGeneric.frontier[0]);
    assert.ok(search.validateSearchGraph(forgedGeneric).some((issue) => issue.code === "illegal_source_lane"));
  }
});

test("search graph validation rejects malformed shape and forged pivot, parent, edge, and candidate joins", () => {
  const { graph, target, ids } = seededGraph("Alex Kim, Example Labs", ["search_web", "fetch_public_source"]);
  for (const [mutate, expectedCode] of [
    [
      (value) => {
        delete value.telemetry.toolCalls;
      },
      "invalid_graph_shape",
    ],
    [
      (value) => {
        value.runId = "";
      },
      "invalid_graph_shape",
    ],
    [
      (value) => {
        value.seed = "";
      },
      "invalid_graph_seed",
    ],
    [
      (value) => {
        value.frontier[0].nodeId = value.seedNodeId;
      },
      "frontier_pivot_mismatch",
    ],
    [
      (value) => {
        value.frontier[0].parentFrontierEntryId = "ghost_action";
      },
      "missing_parent_frontier",
    ],
    [
      (value) => {
        value.edges = value.edges.filter((edge) => edge.frontierEntryId !== value.frontier[0].id);
      },
      "frontier_expansion_edge_mismatch",
    ],
  ]) {
    const forged = structuredClone(graph);
    mutate(forged);
    const issues = search.validateSearchGraph(forged);
    assert.ok(
      issues.some((issue) => issue.code === expectedCode),
      JSON.stringify(issues),
    );
    assert.throws(() => search.assertSearchGraph(forged), /search graph invariant failed/);
  }

  const parent = graph.frontier.find((entry) => entry.sourceLaneId === "t1.first_party");
  const candidateNode = search.admitGraphNode(
    graph,
    {
      kind: "candidate",
      label: "Alex Kim",
      status: "verified",
      sourceTier: parent.sourceTier,
      sourceLaneId: parent.sourceLaneId,
      frontierEntryId: parent.id,
      actionId: parent.id,
      candidateId: "candidate_a",
      data: {},
    },
    ids,
    "2026-08-19T17:00:05.000Z",
  );
  const candidateFrontier = search.enqueueCandidateLeadFetchFrontier(
    candidateNode.graph,
    target,
    { id: "candidate_a", displayName: "Alex Kim" },
    {
      leadId: "lead_graph_validation",
      sourceUrl: "https://examplelabs.org/team/alex-kim",
      sourceEvidenceId: "evidence_graph_validation_lead",
      classifiedSourceLaneId: "t1.candidate_company_page",
      classifiedSourceTier: 1,
      classifiedSourceType: "company_page",
    },
    parent,
    candidateNode.value.id,
    ["fetch_public_source"],
    ids,
    "2026-08-19T17:00:06.000Z",
  );
  const candidateEntry = candidateFrontier.value;
  const actionNode = search.admitGraphNode(
    candidateFrontier.graph,
    {
      kind: "action",
      label: "fetch_public_source",
      status: candidateEntry.status,
      sourceTier: candidateEntry.sourceTier,
      sourceLaneId: candidateEntry.sourceLaneId,
      frontierEntryId: candidateEntry.id,
      actionId: candidateEntry.id,
      candidateId: "candidate_a",
      data: { tool: "fetch_public_source" },
    },
    ids,
    "2026-08-19T17:00:07.000Z",
  );
  const foreignEvidence = search.admitGraphNode(
    actionNode.graph,
    {
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
    },
    ids,
    "2026-08-19T17:00:08.000Z",
  );
  const candidateIssues = search.validateSearchGraph(foreignEvidence.graph);
  assert.ok(candidateIssues.some((issue) => issue.code === "node_candidate_scope_mismatch"));
  assert.ok(candidateIssues.some((issue) => issue.code === "action_evidence_candidate_mismatch"));
});

test("source hierarchy is tiered and denies people-search, phonebook, property, tax, family, and credential surfaces", () => {
  assert.deepEqual([...new Set(search.SOURCE_HIERARCHY.map((lane) => lane.tier))], [0, 1, 2, 3, 4, 5, 6]);
  for (const source of [
    "https://whitepages.com/person/example",
    "https://usphonebook.com/example",
    "https://county.example.gov/property-tax-assessor/person",
    "https://example.org/family-member-map",
    "https://example.org/credential-dump",
    "https://example.org/%2570roperty-%2574ax-%2561ssessor",
    "https://example.org/%2566amily-%256dember-map",
    "https://example.org/%2563redential-%2564ump",
  ])
    assert.equal(search.isDeniedResearchSource(source), true, source);
  assert.equal(search.isDeniedResearchSource("https://www.sec.gov/edgar/search/"), false);
  assert.equal(search.sourceTierForUrl("https://www.sec.gov/edgar/search/", "public_document"), 2);
  assert.equal(search.deterministicSourceTypeForUrl("https://www.linkedin.com/in/example"), "professional_profile");
  assert.equal(search.sourceTierForUrl("https://www.linkedin.com/in/example", "professional_profile"), 2);
  assert.equal(
    search.deterministicSourceTypeForUrl("https://www.researchgate.net/profile/Example-Person"),
    "professional_profile",
  );
  assert.equal(
    search.sourceTierForUrl("https://www.researchgate.net/profile/Example-Person", "professional_profile"),
    2,
  );
  for (const source of [
    "https://openreview.net/profile?id=~Example_Person1",
    "https://www.semanticscholar.org/author/Example-Person/123456",
    "https://openalex.org/A123456789",
  ]) {
    const sourceType = search.deterministicSourceTypeForUrl(source);
    const sourceTier = search.sourceTierForUrl(source, sourceType);
    assert.equal(sourceType, "professional_profile", source);
    assert.equal(sourceTier, 2, source);
    assert.equal(search.classifiedFetchLaneId(sourceType, sourceTier, true), "t2.structured_professional", source);
  }
  const crossrefRecord = "https://api.crossref.org/works/10.5555%2Fexample";
  assert.equal(search.deterministicSourceTypeForUrl(crossrefRecord), "public_document");
  assert.equal(search.sourceTierForUrl(crossrefRecord, "public_document"), 3);
  assert.equal(search.classifiedFetchLaneId("public_document", 3, true), "t3.institutional");
  assert.equal(search.deterministicSourceTypeForUrl("https://profiles.example/person"), "other");
  assert.equal(search.sourceTierForUrl("https://profiles.example/person", "other"), 6);
  assert.equal(search.sourceTierForUrl("https://example.edu/person", "public_document"), 3);
  assert.equal(
    search.deterministicSourceTypeForUrl("https://scholar.google.com/citations?user=abcD_123&hl=en"),
    "public_document",
  );
  assert.equal(
    search.sourceTierForUrl("https://scholar.google.com/citations?user=abcD_123&hl=en", "public_document"),
    2,
  );
  assert.equal(search.deterministicSourceTypeForUrl("https://scholar.google.com/scholar?q=person"), "other");
  for (const listing of [
    "https://apps.apple.com/us/app/example/id123456789",
    "https://apps.apple.com/app/id123456789?platform=iphone",
  ]) {
    assert.equal(search.deterministicSourceTypeForUrl(listing), "public_document", listing);
    assert.equal(
      search.sourceTierForUrl(listing, "public_document"),
      3,
      `${listing} remains public metadata without outranking canonical person records`,
    );
  }
  for (const nonListing of [
    "https://apps.apple.com/us/developer/example/id123456789",
    "https://apps.apple.com/us/app/example",
    "https://apps.apple.com/us/app/example/idnotdigits",
    "https://apps.apple.com/us/app/example/id123456789/reviews",
    "https://evil.apps.apple.com/us/app/example/id123456789",
  ]) {
    const sourceType = search.deterministicSourceTypeForUrl(nonListing);
    assert.equal(sourceType, "other", nonListing);
    assert.notEqual(search.sourceTierForUrl(nonListing, sourceType), 2, nonListing);
  }
  assert.equal(
    search.deterministicSourceTypeForUrl(
      "https://examplelabs.org/team/person",
      { organizationNames: ["Example Labs"] },
      "company_page",
    ),
    "company_page",
  );
  assert.equal(
    search.sourceTierForUrl("https://examplelabs.org/team/person", "company_page", false, {
      organizationNames: ["Example Labs"],
    }),
    1,
  );
  assert.equal(search.sourceLaneById("t6.candidate_public_source").sourceTypes[0], "other");
  assert.equal(search.sourceTierForUrl("https://whitepages.com/person/example"), null);
  const encodedDenied = "https://example.org/%2570roperty-%2574ax-%2561ssessor";
  assert.equal(domain.classifySafety(encodedDenied).level, "block");
  assert.deepEqual(search.sourceLanesForTarget(domain.parseTarget(encodedDenied), ["fetch_public_source"]), []);
  assert.equal(
    agent.isActionPolicyCompliant(
      {
        tool: "search_web",
        purpose: "Research a public professional source",
        arguments: { query: encodedDenied },
      },
      ["search_web"],
    ).allowed,
    false,
  );
  const exactDomain = domain.parseTarget("example.org");
  assert.equal(search.sourceLanesForTarget(exactDomain, ["search_web"])[0].id, "t0.explicit_identifier");
  const exactUrl = domain.parseTarget("https://example.org/public-profile");
  assert.equal(search.sourceLanesForTarget(exactUrl, ["fetch_public_source"])[0].id, "t0.explicit_url");
  assert.equal(
    live.exactUserSuppliedUrl({ target: exactUrl }, "https://example.org/public-profile"),
    "https://example.org/public-profile",
  );
  assert.equal(live.exactUserSuppliedUrl({ target: exactUrl }, "https://example.org/other-profile"), null);
});

test("denied generic research tools never seed a lane or reach an adapter", async () => {
  const deniedTools = [
    "peoplefinder_query",
    "phonebook_search",
    "spokeo_lookup",
    "property_lookup",
    "tax_assessor",
    "familytree_lookup",
    "cloud_bucket_enumeration",
    "subdomain_bruteforce",
    "account_existence_probe",
    "ios_binary_analysis",
    "ipa_decryption",
    "testflight_probe",
    "traffic_interception",
    "s3_bucket_enum",
    "account_discovery",
    "subdomain_scan",
    "ipa_analysis",
    "testflight_enumeration",
    "packet_capture",
  ];
  const target = domain.parseTarget("Alex Kim, Example Labs");
  for (const tool of deniedTools) {
    assert.equal(search.isDeniedResearchTool(tool), true, tool);
    assert.deepEqual(search.sourceLanesForTarget(target, [tool]), [], tool);
    assert.equal(
      agent.isActionPolicyCompliant(
        {
          tool,
          purpose: "Look up a public professional profile.",
          arguments: { query: target.normalizedQuery },
        },
        [tool],
      ).allowed,
      false,
      tool,
    );

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
    ))
      updates.push(update);
    assert.equal(plannerCalls, 0, tool);
    assert.equal(adapterCalls, 0, tool);
    assert.equal(updates.at(-1).report.stop.reason, "no_legal_actions", tool);
    assert.equal(updates.at(-1).report.searchGraph.frontier.length, 0, tool);
  }

  assert.deepEqual(
    search.sourceLanesForTarget(target, ["工具"]),
    [],
    "Unicode name support must not broaden the ASCII-only generic tool identifier grammar",
  );

  const legitimateTool = "professional_registry_search";
  assert.equal(search.isDeniedResearchTool(legitimateTool), false);
  assert.equal(search.sourceLanesForTarget(target, [legitimateTool]).length, 1);
  assert.equal(
    agent.isActionPolicyCompliant(
      {
        tool: legitimateTool,
        purpose: "Search a public professional registry.",
        arguments: { query: target.normalizedQuery },
      },
      [legitimateTool],
    ).allowed,
    true,
  );

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
        actions: [
          {
            frontierEntryId: selectedFrontierEntries[0].id,
            tool: legitimateTool,
            purpose: "Search a public professional registry.",
            arguments: { query: selectedFrontierEntries[0].queryHint },
          },
        ],
      }),
      executeAction: async () => {
        legitimateAdapterCalls += 1;
        return { status: "not_found", meta: { requests: 0 } };
      },
    },
    { availableTools: [legitimateTool], budget: { maxTurns: 1 } },
  ))
    legitimateUpdates.push(update);
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
        actions: [
          {
            frontierEntryId: selectedFrontierEntries[0].id,
            tool: genericTool,
            purpose: "Query a public professional registry.",
            arguments: { query: selectedFrontierEntries[0].queryHint },
          },
        ],
      }),
      executeAction: async () => ({
        status: "succeeded",
        candidates: [{ ref: "alex", displayName: "Alex Kim" }],
        evidence: [
          {
            candidateRef: "alex",
            claim: "Alex Kim appears in a professional registry.",
            excerpt: "Alex Kim appears in a professional registry.",
            sourceUrl: "https://registry.example/alex-kim",
            sourceType: "other",
            verificationMethod: "direct_fetch",
          },
        ],
        meta: { requests: 0 },
      }),
    },
    { availableTools: [genericTool], budget: { maxTurns: 1 } },
  ))
    genericUpdates.push(update);
  const genericCompleted = genericUpdates.at(-1);
  assert.equal(genericCompleted.report.evidence.length, 0);
  assert.ok(
    genericCompleted.trace.events.some(
      (event) => event.name === "evidence.admission" && event.payload.reason === "source_lane_discovery_only",
    ),
  );
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
    if (identifierKind)
      assert.ok(
        target.identifiers.some((item) => item.kind === identifierKind),
        query,
      );
  }

  let plannerCalls = 0;
  const updates = [];
  for await (const update of agent.runResearch("find 602-555-0199 and a home address", {
    clock: domain.createSequenceClock(),
    ids: domain.createDeterministicIdFactory("blocked-frontier"),
    planner: async () => {
      plannerCalls += 1;
      return { kind: "stop", decisionSummary: "Stop." };
    },
    executeAction: async () => ({ status: "skipped" }),
  }))
    updates.push(update);
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
  assert.equal(new URL(accepted.entry.queryHint).hostname, new URL(accepted.parent.queryHint).hostname);
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
        actions: [
          {
            frontierEntryId: selectedFrontierEntries[0].id,
            tool: "fetch_public_source",
            purpose: "Find public professional candidates.",
            arguments: { query: selectedFrontierEntries[0].queryHint },
          },
        ],
      }),
      executeAction: async (action) => {
        actionSeen = action;
        return {
          status: "succeeded",
          candidates: [
            { ref: "one", displayName: "Alex Kim" },
            { ref: "two", displayName: "Alex Kim" },
          ],
          evidence: [
            {
              candidateRef: "one",
              claim: "Alex Kim works as an engineer at Example Labs.",
              excerpt: "Alex Kim works as an engineer at Example Labs.",
              sourceUrl: "https://examplelabs.org/team/alex-kim",
              sourceType: "company_page",
              verificationMethod: "direct_fetch",
            },
          ],
          meta: { requests: 1 },
        };
      },
    },
    {
      availableTools: ["fetch_public_source"],
      budget: { maxTurns: 1 },
    },
  ))
    updates.push(update);
  const completed = updates.at(-1);
  assert.equal(completed.type, "completed");
  assert.equal(actionSeen.id, actionSeen.frontierEntryId);
  assert.equal(completed.report.evidence[0].toolCallId, actionSeen.id);
  const evidenceNode = completed.report.searchGraph.nodes.find(
    (node) => node.evidenceId === completed.report.evidence[0].id,
  );
  assert.ok(
    evidenceNode,
    JSON.stringify({
      status: completed.report.status,
      stop: completed.report.stop,
      evidence: completed.report.evidence,
      nodes: completed.report.searchGraph.nodes,
    }),
  );
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
  ))
    canceled.push(update);
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
        const firstEntry = selectedFrontierEntries.find((entry) => entry.allowedTools.includes(firstTool));
        return {
          kind: "actions",
          decisionSummary: "Attempt a cross-lane tool binding.",
          actions: [
            {
              frontierEntryId: firstEntry.id,
              tool: secondTool,
              purpose: "Search a public professional publication index.",
              arguments: { query: firstEntry.queryHint },
            },
          ],
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
  ))
    mismatched.push(update);
  assert.equal(mismatchedAdapterCalls, 0);
  assert.ok(
    mismatched
      .at(-1)
      .trace.events.some(
        (event) =>
          event.name === "action.rejected" &&
          event.payload.reason === "action is not bound to one selected compatible frontier entry",
      ),
  );

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
        actions: [
          {
            frontierEntryId: selectedFrontierEntries[0].id,
            tool: selectedFrontierEntries[0].allowedTools[0],
            purpose: "Search a public professional registry.",
            arguments: { query: selectedFrontierEntries[0].queryHint },
            candidateId: "ghost_candidate",
          },
        ],
      }),
      executeAction: async () => {
        ghostAdapterCalls += 1;
        return { status: "not_found" };
      },
    },
    { availableTools: [firstTool], budget: { maxTurns: 1 } },
  ))
    ghost.push(update);
  assert.equal(ghostAdapterCalls, 0);
  assert.equal(ghost.at(-1).type, "completed");
  assert.ok(
    ghost
      .at(-1)
      .trace.events.some(
        (event) =>
          event.name === "action.rejected" &&
          event.payload.reason === "action is not bound to one selected compatible frontier entry",
      ),
  );

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
        actions: [
          {
            frontierEntryId: selectedFrontierEntries[0].id,
            tool: firstTool,
            purpose: "Search a public professional registry.",
            arguments: { query: selectedFrontierEntries[0].queryHint },
          },
        ],
      }),
      executeAction: async () => {
        foreignAdapterCalls += 1;
        return {
          status: "succeeded",
          candidates: [{ ref: "alex", displayName: "Alex Kim" }],
          evidence: [
            {
              candidateRef: "alex",
              toolCallId: "foreign_action",
              claim: "Alex Kim has a public professional profile.",
              excerpt: "Alex Kim has a public professional profile.",
              sourceUrl: "https://example.org/team/alex-kim",
              sourceType: "company_page",
              verificationMethod: "direct_fetch",
            },
          ],
          meta: { requests: 0 },
        };
      },
    },
    { availableTools: [firstTool], budget: { maxTurns: 1 } },
  ))
    foreign.push(update);
  const completed = foreign.at(-1);
  assert.equal(foreignAdapterCalls, 1);
  assert.equal(completed.type, "completed");
  assert.equal(completed.report.evidence.length, 0);
  assert.doesNotMatch(JSON.stringify(completed.report), /foreign_action/);
  assert.ok(
    completed.trace.events.some(
      (event) => event.name === "evidence.admission" && event.payload.reason === "foreign_tool_call_id",
    ),
  );
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
            actions: [
              {
                frontierEntryId: entry.id,
                tool: "search_web",
                purpose: "Find public professional candidates.",
                arguments: { query: entry.queryHint },
              },
            ],
          };
        }
        const entry = selectedFrontierEntries.find((item) => item.candidateId !== null);
        boundCandidateId = entry.candidateId;
        foreignCandidateId = state.candidates.find((candidate) => candidate.id !== boundCandidateId).id;
        return {
          kind: "actions",
          decisionSummary: "Exercise one candidate-bound first-party lane.",
          actions: [
            {
              frontierEntryId: entry.id,
              tool: "fetch_public_source",
              purpose: "Fetch the candidate-bound organization page.",
              arguments: { url: "https://examplelabs.org/team/alex-kim" },
              candidateId: boundCandidateId,
            },
          ],
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
            evidence: [
              {
                candidateRef: "one",
                claim: "Search surfaced an exact candidate-scoped organization-page lead.",
                disposition: "discovery_only",
                sourceUrl: "https://examplelabs.org/team/alex-kim",
                sourceType: "search_result",
                canonicalSubset: { providerAttestedUrl: true },
                verificationMethod: "search_discovery",
                attributes: {
                  leadId: "lead_candidate_scope",
                  classifiedSourceLaneId: "t1.candidate_company_page",
                  classifiedSourceTier: 1,
                  classifiedSourceType: "company_page",
                },
              },
            ],
            meta: { requests: 0 },
          };
        }
        const other = context.state.candidates.find((candidate) => candidate.id !== action.candidateId);
        return {
          status: "succeeded",
          candidates: [{ ref: "third", displayName: "Alex Kim" }],
          candidateSignals: [
            {
              candidateId: other.id,
              signals: [
                {
                  kind: "organization",
                  value: "Foreign Labs",
                  normalizedValue: "foreign labs",
                  strength: "strong",
                  assurance: "verified",
                  sourceFamily: "foreign.example",
                },
              ],
            },
          ],
          evidence: [
            {
              candidateId: other.id,
              claim: "The other Alex Kim works at Example Labs.",
              excerpt: "The other Alex Kim works at Example Labs.",
              sourceUrl: "https://examplelabs.org/team/other-alex-kim",
              sourceType: "company_page",
              verificationMethod: "direct_fetch",
            },
          ],
          findings: [
            {
              candidateId: other.id,
              title: "Foreign candidate finding",
              description: "This must not be admitted from a candidate-bound action.",
              category: "identity",
              evidenceIds: [],
            },
          ],
          meta: { requests: 0 },
        };
      },
    },
    {
      availableTools: ["search_web", "fetch_public_source"],
      budget: { maxTurns: 2 },
    },
  ))
    updates.push(update);
  const completed = updates.at(-1);
  assert.equal(
    adapterCalls,
    2,
    JSON.stringify({
      frontier: completed.report.searchGraph.frontier,
      evidence: completed.report.evidence,
      admissions: completed.trace.events.filter((event) => event.name === "evidence.admission"),
    }),
  );
  assert.equal(completed.type, "completed");
  assert.equal(completed.report.evidence.length, 1);
  assert.equal(completed.report.evidence[0].disposition, "discovery_only");
  assert.equal(completed.report.findings.length, 0);
  assert.equal(completed.report.candidates.length, 2);
  assert.ok(boundCandidateId && foreignCandidateId && boundCandidateId !== foreignCandidateId);
  assert.ok(
    !completed.report.candidates
      .find((candidate) => candidate.id === foreignCandidateId)
      .signals.some((signal) => signal.normalizedValue === "foreign labs"),
  );
  for (const [name, reason] of [
    ["candidate.rejected", "candidate_bound_action_cannot_create_candidates"],
    ["candidate_signal.rejected", "foreign_candidate_id"],
    ["evidence.admission", "foreign_candidate_id"],
    ["finding.rejected", "foreign_candidate_id"],
  ])
    assert.ok(
      completed.trace.events.some((event) => event.name === name && event.payload.reason === reason),
      `${name}:${reason}`,
    );
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
        actions: [
          {
            frontierEntryId: selectedFrontierEntries[0].id,
            tool: "fetch_public_source",
            purpose: "Fetch a candidate-facing public page.",
            arguments: { url: "https://news.example/alex-kim" },
          },
        ],
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
  ))
    updates.push(update);
  const completed = updates.at(-1);
  assert.equal(completed.type, "completed");
  assert.equal(completed.report.evidence.length, 0);
  assert.ok(
    completed.trace.events.some(
      (event) => event.name === "evidence.admission" && event.payload.reason === "source_type_outside_lane",
    ),
  );
  assert.equal(
    completed.trace.events.filter(
      (event) => event.name === "evidence.admission" && event.payload.reason === "source_tier_mismatch",
    ).length,
    2,
  );
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
  ))
    updates.push(update);

  const completed = updates.at(-1);
  assert.equal(completed.report.status, "partial");
  assert.equal(completed.report.stop.reason, "budget_exhausted");
  assert.match(completed.report.stop.detail, /turns/);
  assert.equal(completed.report.searchGraph.selectedFrontierEntryIds.length, 0);
});

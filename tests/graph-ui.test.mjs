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
const graphUi = await vite.ssrLoadModule("/app/graph-model.ts");

after(async () => {
  await vite.close();
});

function utility() {
  return {
    relevance: 0.8,
    novelty: 0.5,
    informationGain: 0.7,
    sourceTrust: 0.9,
    executionCost: 0.2,
    policyRisk: 0.05,
    repetition: 0,
    depthPenalty: 0.1,
  };
}

function canonicalFixture() {
  const createdAt = "2026-08-19T00:00:00.000Z";
  const node = (id, kind, label, status, ordinal, extras = {}) => ({
    schemaVersion: 2,
    id,
    kind,
    label,
    status,
    sourceTier: extras.sourceTier ?? null,
    sourceLaneId: extras.sourceLaneId ?? null,
    frontierEntryId: extras.frontierEntryId ?? null,
    actionId: extras.actionId ?? null,
    candidateId: extras.candidateId ?? null,
    evidenceId: extras.evidenceId ?? null,
    findingId: null,
    ordinal,
    data: extras.data ?? {},
    createdAt,
    updatedAt: createdAt,
  });
  const edge = (id, fromNodeId, toNodeId, kind, status, ordinal, extras = {}) => ({
    schemaVersion: 2,
    id,
    fromNodeId,
    toNodeId,
    kind,
    status,
    frontierEntryId: extras.frontierEntryId ?? null,
    actionId: extras.actionId ?? null,
    edgeCost: extras.edgeCost ?? 0.5,
    pathCost: extras.pathCost ?? 0.5,
    ordinal,
    createdAt,
  });
  const stableId = "frontier_same_name_decoy";
  return {
    schemaVersion: 2,
    runId: "graph-ui-run",
    status: "completed",
    seed: "Chris Anderson, TED",
    seedNodeId: "seed",
    nodes: [
      node("seed", "seed", "Chris Anderson, TED", "verified", 1),
      node("candidate-ted", "candidate", "Chris Anderson · TED", "verified", 2, { candidateId: "candidate-ted" }),
      node("candidate-decoy", "candidate", "Chris Anderson · 3D Robotics", "rejected", 3, {
        sourceTier: 1,
        sourceLaneId: "t1.first_party",
        frontierEntryId: stableId,
        actionId: stableId,
        candidateId: "candidate-decoy",
      }),
      node("mutation", "pivot", "Alternate organization anchor", "mutated", 4),
    ],
    edges: [
      edge("edge-ted", "seed", "candidate-ted", "expands", "verified", 1),
      edge("edge-decoy", "seed", "candidate-decoy", "separates", "rejected", 2, {
        frontierEntryId: stableId,
        actionId: stableId,
        pathCost: 1.1,
      }),
      edge("edge-mutation", "seed", "mutation", "mutates", "mutated", 3),
    ],
    frontier: [{
      schemaVersion: 2,
      id: stableId,
      frontierEntryId: stableId,
      actionId: stableId,
      nodeId: "candidate-decoy",
      parentNodeId: "seed",
      parentFrontierEntryId: null,
      status: "rejected",
      sourceTier: 1,
      sourceLaneId: "t1.first_party",
      allowedTools: ["search_web"],
      intent: "Keep the same-name alternative separate.",
      queryHint: "Chris Anderson 3D Robotics",
      candidateId: "candidate-decoy",
      depth: 1,
      ordinal: 1,
      dedupeKey: "candidate-decoy",
      utility: utility(),
      edgeCost: 1.1,
      pathCost: 1.1,
      mutation: null,
      createdAt,
      updatedAt: createdAt,
    }],
    selectedFrontierEntryIds: [stableId],
    currentSourceTier: 1,
    nextOrdinal: 5,
    mutationStep: 1,
    telemetry: {
      seeded: 1,
      enqueued: 1,
      selected: 1,
      pruned: 1,
      expanded: 1,
      exhausted: 0,
      toolCalls: 1,
      mutationToolCalls: 0,
      mutationsProposed: 1,
      mutationsAccepted: 1,
      mutationsRejected: 0,
    },
    createdAt,
    updatedAt: createdAt,
  };
}

test("UI accepts only the canonical v2 runtime graph and never derives one from dossier prose", () => {
  const graph = canonicalFixture();
  assert.equal(graphUi.canonicalGraph(graph), graph);
  assert.equal(graphUi.graphFromReport({ searchGraph: graph }), graph);
  assert.equal(graphUi.graphFromReport({
    candidates: [{ id: "candidate", displayName: "Decorative candidate" }],
    evidence: [{ id: "evidence", claim: "Decorative evidence" }],
    findings: [{ id: "finding", title: "Decorative finding" }],
  }), null);
  assert.equal(graphUi.canonicalGraph({ ...graph, schemaVersion: 1 }), null);

  const invalidEdge = structuredClone(graph);
  invalidEdge.edges[0].toNodeId = "missing-node";
  assert.equal(graphUi.canonicalGraph(invalidEdge), null);
});

test("graph presentation retains rejected same-name and mutation branches with deterministic layers", () => {
  const graph = canonicalFixture();
  const normalized = graphUi.canonicalGraph(graph);
  assert.ok(normalized);
  assert.equal(normalized.nodes.find((node) => node.id === "candidate-decoy").status, "rejected");
  assert.equal(normalized.nodes.find((node) => node.id === "mutation").status, "mutated");
  assert.equal(graphUi.nodeRelationships(normalized, "candidate-decoy").length, 1);

  const positions = graphUi.deterministicPositions(normalized);
  assert.ok(positions.get("candidate-decoy").x > positions.get("seed").x);
  assert.ok(positions.get("mutation").x > positions.get("seed").x);
});

test("fixed graph geometry remains collision-free across every incremental topology prefix", () => {
  const base = canonicalFixture();
  const extraNodes = Array.from({ length: 12 }, (_, index) => ({
    ...structuredClone(base.nodes[1]),
    id: `dense-node-${String(index + 1).padStart(2, "0")}`,
    label: `Dense branch ${index + 1} with a deliberately long label that must never resize its card`,
    ordinal: 20 + index * 2,
    frontierEntryId: null,
    actionId: null,
    candidateId: null,
  }));
  const extraEdges = extraNodes.map((node, index) => ({
    ...structuredClone(base.edges[0]),
    id: `dense-edge-${String(index + 1).padStart(2, "0")}`,
    fromNodeId: index < 4 ? "seed" : extraNodes[index - 4].id,
    toNodeId: node.id,
    ordinal: 21 + index * 2,
  }));

  assert.equal(graphUi.GRAPH_NODE_WIDTH, 300);
  assert.equal(graphUi.GRAPH_NODE_HEIGHT, 96);
  let previousTopology = graphUi.graphTopologyKey(base);
  for (let prefix = 0; prefix <= extraNodes.length; prefix += 1) {
    const graph = {
      ...structuredClone(base),
      nodes: [...structuredClone(base.nodes), ...structuredClone(extraNodes.slice(0, prefix))],
      edges: [...structuredClone(base.edges), ...structuredClone(extraEdges.slice(0, prefix))],
      nextOrdinal: 100,
    };
    const normalized = graphUi.canonicalGraph(graph);
    assert.ok(normalized);
    const layout = graphUi.deterministicGraphLayout(normalized);
    const rerun = graphUi.deterministicGraphLayout(normalized);
    assert.equal(layout.positions.size, normalized.nodes.length);
    assert.equal(layout.routes.size, normalized.edges.length);
    assert.equal(graphUi.isCollisionFreeGraphLayout(normalized, layout), true);
    assert.deepEqual([...layout.positions], [...rerun.positions]);
    assert.deepEqual([...layout.routes], [...rerun.routes]);
    for (const route of layout.routes.values()) {
      assert.doesNotMatch(graphUi.graphRoutePath(route), /NaN|Infinity/);
      for (let pointIndex = 1; pointIndex < route.points.length; pointIndex += 1) {
        const start = route.points[pointIndex - 1];
        const end = route.points[pointIndex];
        assert.ok(start.x === end.x || start.y === end.y, `route ${route.edgeId} is orthogonal`);
      }
    }
    const statusOnly = structuredClone(normalized);
    statusOnly.nodes[0].status = statusOnly.nodes[0].status === "verified" ? "exhausted" : "verified";
    assert.equal(graphUi.graphTopologyKey(statusOnly), layout.topologyKey);
    if (prefix > 0) assert.notEqual(layout.topologyKey, previousTopology);
    previousTopology = layout.topologyKey;
  }
});

test("layout validation rejects node collisions, stale topology, and edge routes through cards", () => {
  const graph = canonicalFixture();
  const valid = graphUi.deterministicGraphLayout(graph);
  assert.equal(graphUi.isCollisionFreeGraphLayout(graph, valid), true);

  const colliding = {
    ...valid,
    positions: new Map(valid.positions),
  };
  colliding.positions.set("candidate-decoy", { ...colliding.positions.get("seed") });
  assert.equal(graphUi.isCollisionFreeGraphLayout(graph, colliding), false);

  assert.equal(graphUi.isCollisionFreeGraphLayout(graph, {
    ...valid,
    topologyKey: `${valid.topologyKey}-stale`,
  }), false);

  const crossing = {
    ...valid,
    routes: new Map(valid.routes),
  };
  const seed = valid.positions.get("seed");
  const decoy = valid.positions.get("candidate-decoy");
  crossing.routes.set("edge-ted", {
    edgeId: "edge-ted",
    points: [
      { x: seed.x + graphUi.GRAPH_NODE_WIDTH, y: seed.y + graphUi.GRAPH_NODE_HEIGHT / 2 },
      { x: decoy.x + graphUi.GRAPH_NODE_WIDTH / 2, y: decoy.y + graphUi.GRAPH_NODE_HEIGHT / 2 },
      valid.routes.get("edge-ted").points.at(-1),
    ],
  });
  assert.equal(graphUi.isCollisionFreeGraphLayout(graph, crossing), false);
});

test("one stable frontier/action identifier links trace focus to its canonical node", () => {
  const graph = canonicalFixture();
  const stableId = "frontier_same_name_decoy";
  const event = {
    name: "frontier.rejected",
    payload: { frontierEntryId: stableId, actionId: stableId },
  };
  assert.equal(graphUi.eventStableId(event), stableId);
  assert.equal(graphUi.stableNodeForEvent(graph, stableId), "candidate-decoy");
});

test("streamed graph snapshots advance monotonically and reject destructive fallbacks", () => {
  const current = canonicalFixture();
  const initial = {
    ...structuredClone(current),
    seed: "",
    seedNodeId: null,
    nodes: [],
    edges: [],
    frontier: [],
    selectedFrontierEntryIds: [],
    nextOrdinal: 1,
    mutationStep: 0,
    telemetry: Object.fromEntries(Object.keys(current.telemetry).map((key) => [key, 0])),
  };
  const next = structuredClone(current);
  next.updatedAt = "2026-08-19T00:01:00.000Z";
  next.nextOrdinal += 1;
  next.telemetry.expanded += 1;
  next.nodes.push({
    ...structuredClone(next.nodes[0]),
    id: "new-source",
    kind: "source",
    label: "New source",
    ordinal: 5,
  });

  assert.equal(graphUi.mergeGraphSnapshot(initial, current), current);
  assert.equal(graphUi.mergeGraphSnapshot(current, next), next);
  assert.equal(graphUi.mergeGraphSnapshot(next, next), next);
  assert.equal(graphUi.mergeGraphEvent(current, { payload: { searchGraph: next } }), next);

  const stale = structuredClone(current);
  stale.nextOrdinal -= 1;
  assert.equal(graphUi.mergeGraphSnapshot(current, stale), current);

  const missingNode = structuredClone(next);
  missingNode.nodes = missingNode.nodes.filter((node) => node.id !== "candidate-decoy");
  missingNode.edges = missingNode.edges.filter((edge) =>
    edge.fromNodeId !== "candidate-decoy" && edge.toNodeId !== "candidate-decoy");
  assert.equal(graphUi.mergeGraphSnapshot(next, missingNode), next);

  const emptyFatal = {
    ...structuredClone(current),
    status: "failed",
    seedNodeId: null,
    nodes: [],
    edges: [],
    frontier: [],
    selectedFrontierEntryIds: [],
  };
  assert.equal(graphUi.mergeGraphSnapshot(current, emptyFatal), current);
  assert.equal(graphUi.mergeGraphSnapshot(current, { ...next, runId: "other-run" }), current);
  assert.equal(graphUi.mergeGraphSnapshot(current, { ...next, telemetry: null }), current);
});

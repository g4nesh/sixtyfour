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

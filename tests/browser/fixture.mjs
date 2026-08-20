import { readFile } from "node:fs/promises";

const exampleOutputUrl = new URL("../../examples/chris-anderson-ted/output.json", import.meta.url);
const exampleTraceUrl = new URL("../../examples/chris-anderson-ted/trace.json", import.meta.url);

function prefixGraph(graph, nodeCount) {
  const nodes = [...graph.nodes]
    .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))
    .slice(0, nodeCount);
  const nodeIds = new Set(nodes.map((node) => node.id));
  return {
    ...structuredClone(graph),
    status: "active",
    nodes,
    edges: graph.edges.filter((edge) => nodeIds.has(edge.fromNodeId) && nodeIds.has(edge.toNodeId)),
    frontier: graph.frontier.filter((entry) => nodeIds.has(entry.nodeId)),
    selectedFrontierEntryIds: graph.selectedFrontierEntryIds.filter((id) =>
      graph.frontier.some((entry) => entry.id === id && nodeIds.has(entry.nodeId))),
  };
}

export async function denseReplayFixture() {
  const [report, trace] = await Promise.all([
    readFile(exampleOutputUrl, "utf8").then(JSON.parse),
    readFile(exampleTraceUrl, "utf8").then(JSON.parse),
  ]);
  const terminal = structuredClone(trace.at(-1));
  if (terminal?.name !== "result.terminal" || !terminal.payload?.report) {
    throw new Error("The dense browser fixture must end in one result.terminal report.");
  }
  const graph = report.searchGraph;
  const snapshotCounts = [5, 11].filter((count) => count < graph.nodes.length);
  const snapshots = snapshotCounts.map((count, index) => ({
    schemaVersion: 2,
    seq: index + 1,
    eventId: `browser_fixture_snapshot_${index + 1}`,
    runId: graph.runId,
    timestamp: graph.createdAt,
    elapsedMs: (index + 1) * 25,
    kind: "event",
    name: "graph.snapshot",
    phase: "discover",
    spanId: null,
    parentSpanId: null,
    attempt: 1,
    status: "recorded",
    payload: { searchGraph: prefixGraph(graph, count) },
    usage: null,
  }));
  terminal.seq = snapshots.length + 1;
  terminal.eventId = "browser_fixture_terminal";
  terminal.payload.report = report;
  return {
    graph,
    report,
    events: [...snapshots, terminal],
    ndjson: [...snapshots, terminal].map((event) => JSON.stringify(event)).join("\n") + "\n",
  };
}

export function intersectingRectangles(rectangles, tolerance = 0.75) {
  const collisions = [];
  for (let leftIndex = 0; leftIndex < rectangles.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < rectangles.length; rightIndex += 1) {
      const left = rectangles[leftIndex];
      const right = rectangles[rightIndex];
      const width = Math.min(left.right, right.right) - Math.max(left.left, right.left);
      const height = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
      if (width > tolerance && height > tolerance) {
        collisions.push({ left: left.id, right: right.id, width, height });
      }
    }
  }
  return collisions;
}

export function graphChromeCollisions(nodes, chrome, tolerance = 0.75) {
  const collisions = [];
  for (const node of nodes) {
    for (const item of chrome) {
      const width = Math.min(node.right, item.right) - Math.max(node.left, item.left);
      const height = Math.min(node.bottom, item.bottom) - Math.max(node.top, item.top);
      if (width > tolerance && height > tolerance) {
        collisions.push({ node: node.id, chrome: item.id, width, height });
      }
    }
  }
  return collisions;
}

export function chromeChromeCollisions(chrome, tolerance = 0.75) {
  return intersectingRectangles(chrome, tolerance);
}

export const chromeSelectors = [
  ".scope-row",
  ".graph-toolbar",
  ".workspace-status",
  ".source-ladder",
  ".node-inspector",
  ".graph-legend",
  ".trace-rail",
  ".atlas-flow-controls",
  ".atlas-minimap",
];

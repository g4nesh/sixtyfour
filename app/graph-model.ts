import type {
  SearchFrontierEntryV2,
  SearchGraphEdgeV2,
  SearchGraphNodeV2,
  SearchGraphStatus,
  SearchGraphV2,
} from "../lib/domain/types";
import type { Report, TraceEvent } from "./atlas-types";

export type CanonicalSearchGraph = SearchGraphV2;
export type SearchGraphNode = SearchGraphNodeV2;
export type SearchGraphEdge = SearchGraphEdgeV2;
export type GraphNodeStatus = SearchGraphStatus;
export type GraphVisualStatus = "seed" | SearchGraphStatus;

export function nodeVisualStatus(node: SearchGraphNode): GraphVisualStatus {
  return node.kind === "seed" ? "seed" : node.status;
}

export function edgeVisualStatus(edge: SearchGraphEdge): GraphVisualStatus {
  if (edge.kind === "mutates") return "mutated";
  if (edge.kind === "conflicts") return "rejected";
  return edge.status;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

/**
 * Accept only the shared v2 execution graph. Legacy reports intentionally stay
 * graphless instead of being reverse-engineered into a decorative network.
 */
export function canonicalGraph(value: unknown): CanonicalSearchGraph | null {
  if (!isRecord(value) || value.schemaVersion !== 2) return null;
  if (
    typeof value.runId !== "string"
    || typeof value.seed !== "string"
    || !Array.isArray(value.nodes)
    || !Array.isArray(value.edges)
    || !Array.isArray(value.frontier)
    || !Array.isArray(value.selectedFrontierEntryIds)
  ) return null;
  const graph = value as unknown as CanonicalSearchGraph;
  if (
    graph.nodes.some((node) => node.schemaVersion !== 2 || !node.id || !node.label)
    || graph.edges.some((edge) => edge.schemaVersion !== 2 || !edge.id || !edge.fromNodeId || !edge.toNodeId)
    || graph.frontier.some((entry) => entry.schemaVersion !== 2 || entry.id !== entry.frontierEntryId || entry.id !== entry.actionId)
  ) return null;
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  if (graph.edges.some((edge) => !nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId))) return null;
  return graph;
}

export function graphFromReport(report: Report | null): CanonicalSearchGraph | null {
  return report ? canonicalGraph(report.searchGraph) : null;
}

export function fullGraphFromTrace(event: TraceEvent): CanonicalSearchGraph | null {
  const payload = event.payload;
  const attributes = event.attributes;
  return canonicalGraph(payload?.searchGraph)
    ?? canonicalGraph(attributes?.searchGraph)
    ?? canonicalGraph((event as Record<string, unknown>).searchGraph);
}

export function mergeGraphEvent(
  current: CanonicalSearchGraph | null,
  event: TraceEvent,
): CanonicalSearchGraph | null {
  return fullGraphFromTrace(event) ?? current;
}

export function eventStableId(event: TraceEvent): string | null {
  const payload = event.payload;
  const attributes = event.attributes;
  return stringValue(
    event.frontierId,
    event.actionId,
    payload?.frontierEntryId,
    payload?.frontierId,
    payload?.actionId,
    attributes?.frontierEntryId,
    attributes?.frontierId,
    attributes?.actionId,
  ) ?? null;
}

export function stableNodeForEvent(graph: CanonicalSearchGraph | null, stableId: string | null): string | null {
  if (!graph || !stableId) return null;
  return graph.nodes.find((node) => node.frontierEntryId === stableId || node.actionId === stableId)?.id ?? null;
}

export function nodeRelationships(graph: CanonicalSearchGraph, nodeId: string): SearchGraphEdge[] {
  return graph.edges.filter((edge) => edge.fromNodeId === nodeId || edge.toNodeId === nodeId);
}

export function frontierForNode(graph: CanonicalSearchGraph, node: SearchGraphNode): SearchFrontierEntryV2 | null {
  return graph.frontier.find((entry) => entry.nodeId === node.id || entry.id === node.frontierEntryId) ?? null;
}

export function nodePathCost(graph: CanonicalSearchGraph, node: SearchGraphNode): number | undefined {
  return frontierForNode(graph, node)?.pathCost;
}

export function nodeDepth(graph: CanonicalSearchGraph, node: SearchGraphNode): number | undefined {
  return frontierForNode(graph, node)?.depth;
}

export function nodePriority(graph: CanonicalSearchGraph, node: SearchGraphNode): number | undefined {
  const entry = frontierForNode(graph, node);
  if (!entry) return undefined;
  const utility = entry.utility;
  return utility.relevance
    + utility.novelty
    + utility.informationGain
    + utility.sourceTrust
    - utility.executionCost
    - utility.policyRisk
    - utility.repetition
    - utility.depthPenalty;
}

export function nodeDetail(graph: CanonicalSearchGraph, node: SearchGraphNode): string | undefined {
  const entry = frontierForNode(graph, node);
  if (entry?.intent) return entry.intent;
  const allowedKeys = ["description", "summary", "claim", "sourceFamily", "queryHint", "url"];
  for (const key of allowedKeys) {
    const value = node.data[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function nodeUrl(node: SearchGraphNode): string | undefined {
  for (const key of ["canonicalUrl", "sourceUrl", "url"] as const) {
    const value = node.data[key];
    if (typeof value !== "string") continue;
    try {
      const parsed = new URL(value);
      if (parsed.protocol === "https:") return parsed.href;
    } catch {
      // The canonical graph may carry a non-URL label; it does not become a link.
    }
  }
  return undefined;
}

export function deterministicPositions(graph: CanonicalSearchGraph): Map<string, { x: number; y: number }> {
  const incoming = new Map(graph.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map(graph.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of graph.edges) {
    incoming.set(edge.toNodeId, (incoming.get(edge.toNodeId) ?? 0) + 1);
    outgoing.get(edge.fromNodeId)?.push(edge.toNodeId);
  }
  const roots = graph.nodes
    .filter((node) => node.id === graph.seedNodeId || (incoming.get(node.id) ?? 0) === 0)
    .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id));
  const depth = new Map<string, number>();
  const queue = roots.map((node) => node.id);
  roots.forEach((node) => depth.set(node.id, nodeDepth(graph, node) ?? 0));
  while (queue.length > 0) {
    const source = queue.shift();
    if (!source) break;
    const nextDepth = (depth.get(source) ?? 0) + 1;
    for (const target of (outgoing.get(source) ?? []).sort()) {
      const existing = depth.get(target);
      if (existing === undefined || nextDepth < existing) {
        depth.set(target, nextDepth);
        queue.push(target);
      }
    }
  }
  for (const node of graph.nodes) depth.set(node.id, nodeDepth(graph, node) ?? depth.get(node.id) ?? 0);
  const layers = new Map<number, SearchGraphNode[]>();
  for (const node of graph.nodes) {
    const layer = depth.get(node.id) ?? 0;
    layers.set(layer, [...(layers.get(layer) ?? []), node]);
  }
  const positions = new Map<string, { x: number; y: number }>();
  for (const [layer, nodes] of [...layers.entries()].sort(([left], [right]) => left - right)) {
    nodes.sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id));
    nodes.forEach((node, index) => positions.set(node.id, {
      x: 96 + layer * 320,
      y: 92 + index * 126 + (layer % 2 === 0 ? 0 : 36),
    }));
  }
  return positions;
}

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

/**
 * One geometry contract is shared by the synchronous safe layout, ELK, and
 * React Flow. Keeping the renderer and layout engine on the same dimensions is
 * what prevents long labels from silently expanding a node into an edge lane.
 */
export const GRAPH_NODE_WIDTH = 300;
export const GRAPH_NODE_HEIGHT = 96;
export const GRAPH_NODE_GAP = 48;
export const GRAPH_LAYER_GAP = 156;
export const GRAPH_EDGE_NODE_GAP = 18;
const GRAPH_LAYOUT_PADDING = 48;
const GRAPH_FALLBACK_EDGE_LANE_GAP = 18;
const GRAPH_FALLBACK_EDGE_STUB = 36;

export interface GraphPoint {
  x: number;
  y: number;
}

export interface GraphRoute {
  edgeId: string;
  points: GraphPoint[];
}

export interface GraphLayout {
  topologyKey: string;
  positions: Map<string, GraphPoint>;
  routes: Map<string, GraphRoute>;
  source: "deterministic" | "elk";
}

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
    || typeof value.nextOrdinal !== "number"
    || !Number.isInteger(value.nextOrdinal)
    || value.nextOrdinal < 0
    || typeof value.mutationStep !== "number"
    || !Number.isInteger(value.mutationStep)
    || value.mutationStep < 0
    || !isRecord(value.telemetry)
    || !Array.isArray(value.nodes)
    || !Array.isArray(value.edges)
    || !Array.isArray(value.frontier)
    || !Array.isArray(value.selectedFrontierEntryIds)
  ) return null;
  const graph = value as unknown as CanonicalSearchGraph;
  if (
    graph.nodes.some((node) => !isRecord(node) || node.schemaVersion !== 2 || !node.id || !node.label)
    || graph.edges.some((edge) => !isRecord(edge) || edge.schemaVersion !== 2 || !edge.id || !edge.fromNodeId || !edge.toNodeId)
    || graph.frontier.some((entry) => !isRecord(entry) || entry.schemaVersion !== 2 || entry.id !== entry.frontierEntryId || entry.id !== entry.actionId)
    || TELEMETRY_KEYS.some((key) => {
      const counter = graph.telemetry[key];
      return typeof counter !== "number" || !Number.isInteger(counter) || counter < 0;
    })
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

const TELEMETRY_KEYS = [
  "seeded",
  "enqueued",
  "selected",
  "pruned",
  "expanded",
  "exhausted",
  "toolCalls",
  "mutationToolCalls",
  "mutationsProposed",
  "mutationsAccepted",
  "mutationsRejected",
] as const;

function retainsIds(
  previous: readonly { id: string }[],
  next: readonly { id: string }[],
): boolean {
  const nextIds = new Set(next.map((item) => item.id));
  return previous.every((item) => nextIds.has(item.id));
}

function isPristineBootstrapGraph(graph: CanonicalSearchGraph): boolean {
  return graph.seed === ""
    && graph.seedNodeId === null
    && graph.nodes.length === 0
    && graph.edges.length === 0
    && graph.frontier.length === 0;
}

/**
 * Runtime graphs are append-only identities with mutable statuses. Refuse a
 * stale, cross-run, or empty fallback snapshot so a useful streamed graph can
 * never disappear when a later transport envelope fails.
 */
export function mergeGraphSnapshot(
  current: CanonicalSearchGraph | null,
  value: unknown,
): CanonicalSearchGraph | null {
  const incoming = canonicalGraph(value);
  if (!incoming) return current;
  if (!current) return incoming;
  if (incoming.runId !== current.runId) return current;
  if (isPristineBootstrapGraph(current)) {
    if (
      incoming.nextOrdinal < current.nextOrdinal
      || incoming.mutationStep < current.mutationStep
      || TELEMETRY_KEYS.some((key) => incoming.telemetry[key] < current.telemetry[key])
    ) return current;
    return incoming;
  }
  if (
    incoming.seed !== current.seed
    || (current.seedNodeId !== null && incoming.seedNodeId !== current.seedNodeId)
    || incoming.nextOrdinal < current.nextOrdinal
    || incoming.mutationStep < current.mutationStep
    || !retainsIds(current.nodes, incoming.nodes)
    || !retainsIds(current.edges, incoming.edges)
    || !retainsIds(current.frontier, incoming.frontier)
    || TELEMETRY_KEYS.some((key) => incoming.telemetry[key] < current.telemetry[key])
  ) return current;
  return incoming;
}

export function mergeGraphEvent(
  current: CanonicalSearchGraph | null,
  event: TraceEvent,
): CanonicalSearchGraph | null {
  return mergeGraphSnapshot(current, fullGraphFromTrace(event));
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

export function graphTopologyKey(graph: CanonicalSearchGraph): string {
  const nodes = [...graph.nodes]
    .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))
    .map((node) => node.id);
  const edges = [...graph.edges]
    .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))
    .map((edge) => `${edge.id}:${edge.fromNodeId}>${edge.toNodeId}`);
  return `${graph.runId}|n:${nodes.join(",")}|e:${edges.join(",")}`;
}

export function deterministicPositions(graph: CanonicalSearchGraph): Map<string, GraphPoint> {
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
  const positions = new Map<string, GraphPoint>();
  // Reserve deterministic lanes above the first node row for the safe
  // fallback router. The asynchronous ELK layout replaces this compactly.
  const nodeOriginY = GRAPH_LAYOUT_PADDING
    + graph.edges.length * GRAPH_FALLBACK_EDGE_LANE_GAP
    + GRAPH_NODE_GAP;
  for (const [layer, nodes] of [...layers.entries()].sort(([left], [right]) => left - right)) {
    nodes.sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id));
    nodes.forEach((node, index) => positions.set(node.id, {
      x: GRAPH_LAYOUT_PADDING + layer * (GRAPH_NODE_WIDTH + GRAPH_LAYER_GAP),
      y: nodeOriginY + index * (GRAPH_NODE_HEIGHT + GRAPH_NODE_GAP),
    }));
  }
  return positions;
}

function fallbackRoute(
  edge: SearchGraphEdge,
  positions: Map<string, GraphPoint>,
  edgeIndex: number,
): GraphRoute | null {
  const source = positions.get(edge.fromNodeId);
  const target = positions.get(edge.toNodeId);
  if (!source || !target) return null;
  const sourcePoint = {
    x: source.x + GRAPH_NODE_WIDTH,
    y: source.y + GRAPH_NODE_HEIGHT / 2,
  };
  const targetPoint = {
    x: target.x,
    y: target.y + GRAPH_NODE_HEIGHT / 2,
  };
  const laneY = GRAPH_LAYOUT_PADDING + edgeIndex * GRAPH_FALLBACK_EDGE_LANE_GAP;
  return {
    edgeId: edge.id,
    points: [
      sourcePoint,
      { x: sourcePoint.x + GRAPH_FALLBACK_EDGE_STUB, y: sourcePoint.y },
      { x: sourcePoint.x + GRAPH_FALLBACK_EDGE_STUB, y: laneY },
      { x: targetPoint.x - GRAPH_FALLBACK_EDGE_STUB, y: laneY },
      { x: targetPoint.x - GRAPH_FALLBACK_EDGE_STUB, y: targetPoint.y },
      targetPoint,
    ],
  };
}

/**
 * A synchronous full-graph fallback. It deliberately routes each edge through
 * a separate lane outside the node rows; this is less compact than ELK, but it
 * is deterministic and cannot paint through an unrelated node while ELK is
 * loading or a newer streamed topology is being coalesced.
 */
export function deterministicGraphLayout(graph: CanonicalSearchGraph): GraphLayout {
  const positions = deterministicPositions(graph);
  const routes = new Map<string, GraphRoute>();
  [...graph.edges]
    .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))
    .forEach((edge, index) => {
      const route = fallbackRoute(edge, positions, index);
      if (route) routes.set(edge.id, route);
    });
  return {
    topologyKey: graphTopologyKey(graph),
    positions,
    routes,
    source: "deterministic",
  };
}

interface GraphRectangle {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function nodeRectangle(point: GraphPoint, padding = 0): GraphRectangle {
  return {
    left: point.x - padding,
    top: point.y - padding,
    right: point.x + GRAPH_NODE_WIDTH + padding,
    bottom: point.y + GRAPH_NODE_HEIGHT + padding,
  };
}

function rectanglesIntersect(left: GraphRectangle, right: GraphRectangle): boolean {
  return left.left < right.right
    && left.right > right.left
    && left.top < right.bottom
    && left.bottom > right.top;
}

function segmentIntersectsRectangle(
  start: GraphPoint,
  end: GraphPoint,
  rectangle: GraphRectangle,
): boolean {
  const epsilon = 0.001;
  if (Math.abs(start.x - end.x) <= epsilon) {
    const minimumY = Math.min(start.y, end.y);
    const maximumY = Math.max(start.y, end.y);
    return start.x > rectangle.left
      && start.x < rectangle.right
      && maximumY > rectangle.top
      && minimumY < rectangle.bottom;
  }
  if (Math.abs(start.y - end.y) <= epsilon) {
    const minimumX = Math.min(start.x, end.x);
    const maximumX = Math.max(start.x, end.x);
    return start.y > rectangle.top
      && start.y < rectangle.bottom
      && maximumX > rectangle.left
      && minimumX < rectangle.right;
  }
  return true;
}

function pointOnRectangleBoundary(point: GraphPoint, rectangle: GraphRectangle): boolean {
  const epsilon = 0.01;
  const withinHorizontal = point.x >= rectangle.left - epsilon && point.x <= rectangle.right + epsilon;
  const withinVertical = point.y >= rectangle.top - epsilon && point.y <= rectangle.bottom + epsilon;
  return (withinVertical && (Math.abs(point.x - rectangle.left) <= epsilon || Math.abs(point.x - rectangle.right) <= epsilon))
    || (withinHorizontal && (Math.abs(point.y - rectangle.top) <= epsilon || Math.abs(point.y - rectangle.bottom) <= epsilon));
}

/**
 * Refuse a renderer layout unless every fixed node box is separated and every
 * orthogonal edge stays outside every non-endpoint node. Invalid async output
 * can therefore never replace the known-safe deterministic layout.
 */
export function isCollisionFreeGraphLayout(
  graph: CanonicalSearchGraph,
  layout: GraphLayout,
): boolean {
  if (layout.topologyKey !== graphTopologyKey(graph)) return false;
  for (const point of layout.positions.values()) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
  }
  if (layout.positions.size !== graph.nodes.length || layout.routes.size !== graph.edges.length) return false;

  for (let leftIndex = 0; leftIndex < graph.nodes.length; leftIndex += 1) {
    const leftPoint = layout.positions.get(graph.nodes[leftIndex].id);
    if (!leftPoint) return false;
    const leftRectangle = nodeRectangle(leftPoint, GRAPH_NODE_GAP / 2);
    for (let rightIndex = leftIndex + 1; rightIndex < graph.nodes.length; rightIndex += 1) {
      const rightPoint = layout.positions.get(graph.nodes[rightIndex].id);
      if (!rightPoint || rectanglesIntersect(leftRectangle, nodeRectangle(rightPoint, GRAPH_NODE_GAP / 2))) return false;
    }
  }

  for (const edge of graph.edges) {
    const route = layout.routes.get(edge.id);
    if (!route || route.edgeId !== edge.id || route.points.length < 2) return false;
    if (route.points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return false;
    const sourcePoint = layout.positions.get(edge.fromNodeId);
    const targetPoint = layout.positions.get(edge.toNodeId);
    if (
      !sourcePoint
      || !targetPoint
      || !pointOnRectangleBoundary(route.points[0], nodeRectangle(sourcePoint))
      || !pointOnRectangleBoundary(route.points.at(-1)!, nodeRectangle(targetPoint))
    ) return false;
    for (let pointIndex = 1; pointIndex < route.points.length; pointIndex += 1) {
      const start = route.points[pointIndex - 1];
      const end = route.points[pointIndex];
      if (Math.abs(start.x - end.x) > 0.001 && Math.abs(start.y - end.y) > 0.001) return false;
      for (const node of graph.nodes) {
        if (node.id === edge.fromNodeId || node.id === edge.toNodeId) continue;
        const point = layout.positions.get(node.id);
        if (!point || segmentIntersectsRectangle(start, end, nodeRectangle(point, GRAPH_EDGE_NODE_GAP))) return false;
      }
    }
  }
  return true;
}

export function graphRoutePath(route: GraphRoute): string {
  return route.points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`)
    .join(" ");
}

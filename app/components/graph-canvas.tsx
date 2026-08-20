"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { humanize } from "../atlas-types";
import {
  deterministicGraphLayout,
  edgeVisualStatus,
  GRAPH_EDGE_NODE_GAP,
  GRAPH_LAYER_GAP,
  GRAPH_NODE_GAP,
  GRAPH_NODE_HEIGHT,
  GRAPH_NODE_WIDTH,
  graphRoutePath,
  graphTopologyKey,
  isCollisionFreeGraphLayout,
  nodeDepth,
  nodeDetail,
  nodePathCost,
  nodeVisualStatus,
  unrelatedEdgeCrossings,
  type CanonicalSearchGraph,
  type GraphLayout,
  type GraphPoint,
  type GraphRoute,
  type GraphVisualStatus,
  type SearchGraphNode,
} from "../graph-model";

interface AtlasNodeData extends Record<string, unknown> {
  source: SearchGraphNode;
  detail?: string;
  pathCost?: number;
  depth?: number;
  focused: boolean;
  onSelect: (id: string) => void;
}

type AtlasFlowNode = Node<AtlasNodeData, "atlas">;

interface AtlasEdgeData extends Record<string, unknown> {
  path: string;
  points: GraphPoint[];
}

type AtlasFlowEdge = Edge<AtlasEdgeData, "atlas">;

const statusColor: Record<GraphVisualStatus, string> = {
  seed: "#76a9fa",
  queued: "#c79e5c",
  selected: "#d6aa61",
  running: "#d6aa61",
  verified: "#62c58a",
  mutated: "#df8d55",
  rejected: "#e47670",
  exhausted: "#727e76",
};

// A literal fit of a dense live graph can make a 300 x 96 card smaller than a
// status pip. Keep the automatic and explicit fit actions readable instead;
// the full topology remains available by panning (and deliberate zooming).
const GRAPH_FIT_MIN_ZOOM = 0.46;
const GRAPH_FIT_MIN_ZOOM_COMPACT = 0.62;
const GRAPH_COMPACT_MEDIA_QUERY = "(max-width: 700px)";

function readableFitMinimum(): number {
  return window.matchMedia(GRAPH_COMPACT_MEDIA_QUERY).matches ? GRAPH_FIT_MIN_ZOOM_COMPACT : GRAPH_FIT_MIN_ZOOM;
}

function flowNodes(
  graph: CanonicalSearchGraph,
  layout: GraphLayout,
  selectedNodeId: string | null,
  focusedStableId: string | null,
  onSelect: (id: string) => void,
): AtlasFlowNode[] {
  return graph.nodes.flatMap((node) => {
    const position = layout.positions.get(node.id);
    if (!position) return [];
    return [
      {
        id: node.id,
        type: "atlas",
        position,
        width: GRAPH_NODE_WIDTH,
        height: GRAPH_NODE_HEIGHT,
        initialWidth: GRAPH_NODE_WIDTH,
        initialHeight: GRAPH_NODE_HEIGHT,
        style: { width: GRAPH_NODE_WIDTH, height: GRAPH_NODE_HEIGHT },
        data: {
          source: node,
          detail: nodeDetail(graph, node),
          pathCost: nodePathCost(graph, node),
          depth: nodeDepth(graph, node),
          focused: Boolean(
            focusedStableId && (node.frontierEntryId === focusedStableId || node.actionId === focusedStableId),
          ),
          onSelect,
        },
        selected: node.id === selectedNodeId,
        draggable: false,
        connectable: false,
        focusable: false,
        zIndex: 2,
        ariaLabel: `${node.label}. ${humanize(node.kind)}. ${humanize(node.status)}.${nodeDetail(graph, node) ? ` ${nodeDetail(graph, node)}` : ""}`,
      },
    ];
  });
}

function flowEdges(graph: CanonicalSearchGraph, layout: GraphLayout, focusedStableId: string | null): AtlasFlowEdge[] {
  return graph.edges.flatMap((edge) => {
    const route = layout.routes.get(edge.id);
    if (!route) return [];
    const focused = Boolean(
      focusedStableId && (edge.frontierEntryId === focusedStableId || edge.actionId === focusedStableId),
    );
    const visualStatus = edgeVisualStatus(edge);
    const color = statusColor[visualStatus];
    const dash = ["queued", "selected", "running"].includes(visualStatus)
      ? "7 6"
      : visualStatus === "mutated"
        ? "2 6"
        : ["rejected", "exhausted"].includes(visualStatus)
          ? "8 5"
          : undefined;
    return [
      {
        id: edge.id,
        source: edge.fromNodeId,
        target: edge.toNodeId,
        type: "atlas",
        data: { path: graphRoutePath(route), points: route.points },
        animated: ["selected", "running"].includes(visualStatus),
        focusable: false,
        ariaLabel: `${edge.kind} from ${edge.fromNodeId} to ${edge.toNodeId}`,
        markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
        style: {
          stroke: color,
          strokeWidth: focused ? 2.2 : 1.15,
          strokeDasharray: dash,
          opacity: focused ? 1 : ["rejected", "exhausted"].includes(visualStatus) ? 0.62 : 0.84,
        },
        zIndex: 0,
      },
    ];
  });
}

function AtlasGraphEdge({ id, data, style, markerEnd, interactionWidth }: EdgeProps<AtlasFlowEdge>) {
  if (!data?.path) return null;
  return <BaseEdge id={id} path={data.path} style={style} markerEnd={markerEnd} interactionWidth={interactionWidth} />;
}

function AtlasGraphNode({ data, selected }: NodeProps<AtlasFlowNode>) {
  const node = data.source;
  const visualStatus = nodeVisualStatus(node);
  const metrics = [
    typeof data.pathCost === "number" ? `g ${data.pathCost.toFixed(2)}` : null,
    typeof data.depth === "number" ? `d ${data.depth}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      className={`atlas-flow-node status-${visualStatus} ${selected ? "is-selected" : ""} ${data.focused ? "is-trace-focused" : ""}`}
    >
      <Handle type="target" position={Position.Left} className="atlas-node-handle" />
      <button
        type="button"
        onClick={() => data.onSelect(node.id)}
        onFocus={() => data.onSelect(node.id)}
        aria-label={`${node.label}, ${humanize(node.kind)}, ${humanize(node.status)}${data.detail ? `, ${data.detail}` : ""}`}
      >
        <span className="node-topline">
          <small>{humanize(node.kind)}</small>
          <i>{humanize(node.status)}</i>
        </span>
        <strong>{node.label}</strong>
        <span className="node-bottomline">
          <small>{data.detail ?? node.frontierEntryId ?? node.actionId ?? "Canonical search state"}</small>
          {metrics ? <code>{metrics}</code> : null}
        </span>
      </button>
      <Handle type="source" position={Position.Right} className="atlas-node-handle" />
    </div>
  );
}

const nodeTypes = { atlas: AtlasGraphNode };
const edgeTypes = { atlas: AtlasGraphEdge };

interface ElkPoint {
  x: number;
  y: number;
}

interface ElkLayoutResult {
  children?: Array<{ id: string; x?: number; y?: number }>;
  edges?: Array<{
    id: string;
    sections?: Array<{
      startPoint: ElkPoint;
      bendPoints?: ElkPoint[];
      endPoint: ElkPoint;
    }>;
  }>;
}

async function elkGraphLayout(graph: CanonicalSearchGraph): Promise<GraphLayout | null> {
  const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
  const elk = new ELK();
  const result = (await elk.layout({
    id: "atlas-search-graph",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.padding": "[top=40,left=40,bottom=40,right=40]",
      "elk.spacing.nodeNode": String(GRAPH_NODE_GAP + 8),
      "elk.spacing.edgeNode": String(GRAPH_EDGE_NODE_GAP + 14),
      "elk.spacing.edgeEdge": "18",
      "elk.layered.spacing.nodeNodeBetweenLayers": String(GRAPH_LAYER_GAP),
      "elk.layered.spacing.edgeNodeBetweenLayers": String(GRAPH_EDGE_NODE_GAP + 14),
      "elk.layered.spacing.edgeEdgeBetweenLayers": "18",
      "elk.layered.mergeEdges": "false",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.layered.crossingMinimization.forceNodeModelOrder": "false",
      "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
    },
    children: [...graph.nodes]
      .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))
      .map((node) => ({ id: node.id, width: GRAPH_NODE_WIDTH, height: GRAPH_NODE_HEIGHT })),
    edges: [...graph.edges]
      .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))
      .map((edge) => ({ id: edge.id, sources: [edge.fromNodeId], targets: [edge.toNodeId] })),
  })) as ElkLayoutResult;
  const positions = new Map<string, GraphPoint>();
  for (const child of result.children ?? []) {
    if (typeof child.x !== "number" || typeof child.y !== "number") return null;
    positions.set(child.id, { x: child.x, y: child.y });
  }
  const routes = new Map<string, GraphRoute>();
  for (const edge of result.edges ?? []) {
    // Canonical graph edges have one source and target, so disconnected or
    // hyperedge sections are invalid rather than being joined by a false line.
    if (edge.sections?.length !== 1) return null;
    const section = edge.sections[0];
    routes.set(edge.id, {
      edgeId: edge.id,
      points: [section.startPoint, ...(section.bendPoints ?? []), section.endPoint],
    });
  }
  const layout: GraphLayout = {
    topologyKey: graphTopologyKey(graph),
    positions,
    routes,
    source: "elk",
  };
  return isCollisionFreeGraphLayout(graph, layout) && unrelatedEdgeCrossings(graph, layout).length === 0
    ? layout
    : null;
}

function GraphCanvasInner({
  graph,
  selectedNodeId,
  onSelectNode,
  focusedStableId,
  fitRequest,
}: {
  graph: CanonicalSearchGraph;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  focusedStableId: string | null;
  fitRequest: number;
}) {
  const onSelect = useCallback((id: string) => onSelectNode(id), [onSelectNode]);
  const topologyKey = graphTopologyKey(graph);
  const graphRef = useRef(graph);
  const fallbackLayout = deterministicGraphLayout(graph);
  const [layout, setLayout] = useState<GraphLayout>(() => fallbackLayout);
  const activeLayout = layout.topologyKey === topologyKey ? layout : fallbackLayout;
  const preparedNodes = useMemo(
    () => flowNodes(graph, activeLayout, selectedNodeId, focusedStableId, onSelect),
    [activeLayout, focusedStableId, graph, onSelect, selectedNodeId],
  );
  const preparedEdges = useMemo(
    () => flowEdges(graph, activeLayout, focusedStableId),
    [activeLayout, focusedStableId, graph],
  );
  const instanceRef = useRef<ReactFlowInstance<AtlasFlowNode, AtlasFlowEdge> | null>(null);
  const didInitialFit = useRef(false);
  const layoutGeneration = useRef(0);

  useEffect(() => {
    graphRef.current = graph;
  }, [graph]);

  useEffect(() => {
    const snapshot = graphRef.current;
    const safeLayout = deterministicGraphLayout(snapshot);
    setLayout(safeLayout);
    const generation = ++layoutGeneration.current;
    const timeout = window.setTimeout(() => {
      void elkGraphLayout(snapshot)
        .then((nextLayout) => {
          if (
            nextLayout &&
            layoutGeneration.current === generation &&
            graphTopologyKey(graphRef.current) === topologyKey
          )
            setLayout(nextLayout);
        })
        .catch(() => {
          // The full deterministic layout is already visible and collision-free.
        });
    }, 40);
    return () => {
      layoutGeneration.current += 1;
      window.clearTimeout(timeout);
    };
  }, [topologyKey]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      // Live snapshots can arrive faster than a fit animation completes. An
      // immediate bounded fit prevents overlapping viewport tweens from
      // briefly shrinking every card below the readability floor.
      void instanceRef.current?.fitView({ padding: 0.18, minZoom: readableFitMinimum(), maxZoom: 0.92 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeLayout.source, activeLayout.topologyKey]);

  useEffect(() => {
    if (fitRequest <= 0) return;
    void instanceRef.current?.fitView({ padding: 0.2, duration: 260, minZoom: readableFitMinimum(), maxZoom: 1.1 });
  }, [fitRequest]);

  const handleInit = useCallback((instance: ReactFlowInstance<AtlasFlowNode, AtlasFlowEdge>) => {
    instanceRef.current = instance;
    if (didInitialFit.current) return;
    didInitialFit.current = true;
    requestAnimationFrame(() => void instance.fitView({ padding: 0.2, minZoom: readableFitMinimum(), maxZoom: 0.9 }));
  }, []);

  return (
    <div className="graph-canvas" data-testid="canonical-graph-canvas" data-layout-source={activeLayout.source}>
      <ReactFlow<AtlasFlowNode, AtlasFlowEdge>
        nodes={preparedNodes}
        edges={preparedEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onInit={handleInit}
        onPaneClick={() => onSelectNode(null)}
        onNodeClick={(_, node) => onSelectNode(node.id)}
        minZoom={0.24}
        maxZoom={2}
        panOnScroll
        selectionOnDrag
        zoomOnDoubleClick={false}
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        colorMode="dark"
        defaultEdgeOptions={{ interactionWidth: 18 }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={0.75} color="rgba(114, 126, 118, 0.18)" />
      </ReactFlow>
    </div>
  );
}

export function GraphCanvas(props: Parameters<typeof GraphCanvasInner>[0]) {
  return (
    <ReactFlowProvider>
      <GraphCanvasInner {...props} />
    </ReactFlowProvider>
  );
}

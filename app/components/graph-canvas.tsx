"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { humanize } from "../atlas-types";
import {
  deterministicPositions,
  edgeVisualStatus,
  nodeDepth,
  nodeDetail,
  nodePathCost,
  nodeVisualStatus,
  type CanonicalSearchGraph,
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

const nodeWidth = 230;
const nodeHeight = 78;

const statusColor: Record<GraphVisualStatus, string> = {
  seed: "#438cff",
  queued: "#e7b340",
  selected: "#f5ca5d",
  running: "#f5ca5d",
  verified: "#35c978",
  mutated: "#e98735",
  rejected: "#e05a47",
  exhausted: "#738077",
};

function flowNodes(
  graph: CanonicalSearchGraph,
  selectedNodeId: string | null,
  focusedStableId: string | null,
  onSelect: (id: string) => void,
): AtlasFlowNode[] {
  const positions = deterministicPositions(graph);
  return graph.nodes.map((node) => ({
    id: node.id,
    type: "atlas",
    position: positions.get(node.id) ?? { x: 0, y: 0 },
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
    draggable: true,
    focusable: false,
    ariaLabel: `${node.label}. ${humanize(node.kind)}. ${humanize(node.status)}.${nodeDetail(graph, node) ? ` ${nodeDetail(graph, node)}` : ""}`,
  }));
}

function flowEdges(graph: CanonicalSearchGraph, focusedStableId: string | null): Edge[] {
  return graph.edges.map((edge) => {
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
    return {
      id: edge.id,
      source: edge.fromNodeId,
      target: edge.toNodeId,
      type: "smoothstep",
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
      zIndex: focused ? 3 : 1,
    };
  });
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
  const preparedNodes = useMemo(
    () => flowNodes(graph, selectedNodeId, focusedStableId, onSelect),
    [focusedStableId, graph, onSelect, selectedNodeId],
  );
  const preparedEdges = useMemo(() => flowEdges(graph, focusedStableId), [focusedStableId, graph]);
  const [nodes, setNodes, onNodesChange] = useNodesState<AtlasFlowNode>(preparedNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(preparedEdges);
  const instanceRef = useRef<ReactFlowInstance<AtlasFlowNode, Edge> | null>(null);
  const didInitialFit = useRef(false);

  useEffect(() => {
    setNodes((current) => {
      const positions = new Map(current.map((node) => [node.id, node.position]));
      return preparedNodes.map((node) => ({ ...node, position: positions.get(node.id) ?? node.position }));
    });
    setEdges(preparedEdges);
  }, [preparedEdges, preparedNodes, setEdges, setNodes]);

  useEffect(() => {
    let active = true;
    const timeout = window.setTimeout(() => {
      void (async () => {
        try {
          const { default: ELK } = await import("elkjs/lib/elk.bundled.js");
          const elk = new ELK();
          const result = await elk.layout({
            id: "atlas-search-graph",
            layoutOptions: {
              "elk.algorithm": "layered",
              "elk.direction": "RIGHT",
              "elk.edgeRouting": "SPLINES",
              "elk.layered.spacing.nodeNodeBetweenLayers": "110",
              "elk.spacing.nodeNode": "48",
              "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
              "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
            },
            children: graph.nodes.map((node) => ({ id: node.id, width: nodeWidth, height: nodeHeight })),
            edges: graph.edges.map((edge) => ({ id: edge.id, sources: [edge.fromNodeId], targets: [edge.toNodeId] })),
          });
          if (!active) return;
          const positions = new Map(
            (result.children ?? []).map((child) => [child.id, { x: child.x ?? 0, y: child.y ?? 0 }]),
          );
          setNodes((current) =>
            current.map((node) => ({ ...node, position: positions.get(node.id) ?? node.position })),
          );
        } catch {
          // Deterministic layered positions are already painted. ELK is an optional client enhancement.
        }
      })();
    }, 90);
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [graph.edges, graph.nodes, setNodes]);

  useEffect(() => {
    if (fitRequest <= 0) return;
    void instanceRef.current?.fitView({ padding: 0.16, duration: 260, minZoom: 0.08, maxZoom: 1.1 });
  }, [fitRequest]);

  const handleInit = useCallback((instance: ReactFlowInstance<AtlasFlowNode, Edge>) => {
    instanceRef.current = instance;
    if (didInitialFit.current) return;
    didInitialFit.current = true;
    requestAnimationFrame(() => void instance.fitView({ padding: 0.18, minZoom: 0.08, maxZoom: 0.9 }));
  }, []);

  return (
    <div className="graph-canvas" data-testid="canonical-graph-canvas">
      <ReactFlow<AtlasFlowNode, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onInit={handleInit}
        onPaneClick={() => onSelectNode(null)}
        onNodeClick={(_, node) => onSelectNode(node.id)}
        minZoom={0.04}
        maxZoom={2}
        panOnScroll
        selectionOnDrag
        zoomOnDoubleClick={false}
        nodesFocusable={false}
        edgesFocusable={false}
        colorMode="dark"
        defaultEdgeOptions={{ interactionWidth: 18 }}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={0.85} color="rgba(155, 170, 160, 0.2)" />
        <Controls className="atlas-flow-controls" showInteractive={false} />
        <MiniMap
          className="atlas-minimap"
          nodeColor={(node) => {
            const source = node.data?.source as SearchGraphNode | undefined;
            return source ? statusColor[nodeVisualStatus(source)] : "#778079";
          }}
          nodeStrokeWidth={1}
          maskColor="rgba(4, 7, 5, .72)"
          pannable
          zoomable
          ariaLabel="Search graph minimap"
        />
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

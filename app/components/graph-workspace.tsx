"use client";

import dynamic from "next/dynamic";
import type { RunStatus } from "../atlas-types";
import { humanize } from "../atlas-types";
import { nodeDetail, type CanonicalSearchGraph } from "../graph-model";
import { FitIcon, GraphIcon, ListIcon } from "./atlas-icons";

const GraphCanvas = dynamic(() => import("./graph-canvas").then((module) => module.GraphCanvas), {
  ssr: false,
  loading: () => (
    <div className="graph-client-loading" role="status">
      <span aria-hidden="true" />
      <p>Loading the canonical graph renderer…</p>
    </div>
  ),
});

export type GraphView = "graph" | "list";

function graphSummary(graph: CanonicalSearchGraph): string {
  const frontier = graph.nodes.filter((node) => ["queued", "selected", "running"].includes(node.status)).length;
  const verified = graph.nodes.filter((node) => node.status === "verified").length;
  const rejected = graph.nodes.filter((node) => node.status === "rejected").length;
  return `${graph.nodes.length} nodes, ${graph.edges.length} edges, ${frontier} frontier, ${verified} verified, ${rejected} rejected`;
}

export function GraphWorkspace({
  graph,
  view,
  onViewChange,
  selectedNodeId,
  onSelectNode,
  focusedStableId,
  fitRequest,
  onFit,
  runStatus,
}: {
  graph: CanonicalSearchGraph | null;
  view: GraphView;
  onViewChange: (view: GraphView) => void;
  selectedNodeId: string | null;
  onSelectNode: (id: string | null) => void;
  focusedStableId: string | null;
  fitRequest: number;
  onFit: () => void;
  runStatus: RunStatus;
}) {
  return (
    <section className="graph-workspace" aria-label="Canonical research search graph">
      <div className="graph-toolbar">
        <div className="graph-view-switch" role="group" aria-label="Graph presentation">
          <button
            type="button"
            className={view === "graph" ? "is-selected" : ""}
            aria-pressed={view === "graph"}
            onClick={() => onViewChange("graph")}
          >
            <GraphIcon /> Graph
          </button>
          <button
            type="button"
            className={view === "list" ? "is-selected" : ""}
            aria-pressed={view === "list"}
            onClick={() => onViewChange("list")}
          >
            <ListIcon /> List
          </button>
        </div>
        <button
          className="graph-fit-button"
          type="button"
          onClick={onFit}
          disabled={!graph || view !== "graph"}
          title="Fit graph to viewport (F)"
        >
          <FitIcon />
          <span>Fit</span>
          <kbd>F</kbd>
        </button>
      </div>

      {graph ? (
        <>
          <p className="sr-only" role="status">
            {graphSummary(graph)}
          </p>
          {view === "graph" ? (
            <GraphCanvas
              graph={graph}
              selectedNodeId={selectedNodeId}
              onSelectNode={onSelectNode}
              focusedStableId={focusedStableId}
              fitRequest={fitRequest}
            />
          ) : (
            <GraphList graph={graph} selectedNodeId={selectedNodeId} onSelectNode={onSelectNode} />
          )}
          <div className="graph-legend" aria-label="Graph status legend">
            <span className="legend-seed">Seed</span>
            <span className="legend-verified">Verified</span>
            <span className="legend-frontier">Frontier</span>
            <span className="legend-mutation">Mutation</span>
            <span className="legend-rejected">Rejected</span>
          </div>
        </>
      ) : (
        <div className="canonical-graph-empty" data-graph-state="unavailable">
          <div className="empty-graph-mark" aria-hidden="true">
            <span />
          </div>
          <p className="empty-kicker">Search graph</p>
          <h2>{runStatus === "running" ? "Building the search graph…" : "Run a search to build the graph"}</h2>
          <p>
            {runStatus === "running"
              ? "Nodes and edges appear as the agent discovers, fetches, and verifies public sources."
              : "Enter a query and press Research. The graph is drawn from real execution — it is never invented from prose."}
          </p>
        </div>
      )}
    </section>
  );
}

function GraphList({
  graph,
  selectedNodeId,
  onSelectNode,
}: {
  graph: CanonicalSearchGraph;
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
}) {
  return (
    <div className="graph-list-view" aria-label="Accessible graph list">
      <header>
        <div>
          <span>Accessible graph view</span>
          <strong>Every search branch</strong>
        </div>
        <p>Edges are summarized under each node; rejected same-name candidates remain visible.</p>
      </header>
      <ol>
        {graph.nodes.map((node, index) => {
          const incoming = graph.edges.filter((edge) => edge.toNodeId === node.id);
          const outgoing = graph.edges.filter((edge) => edge.fromNodeId === node.id);
          const detail = nodeDetail(graph, node);
          return (
            <li key={node.id} className={`status-${node.status}`}>
              <button
                type="button"
                onClick={() => onSelectNode(node.id)}
                aria-pressed={selectedNodeId === node.id}
                aria-label={`${node.label}, ${humanize(node.kind)}, ${humanize(node.status)}, ${incoming.length} incoming and ${outgoing.length} outgoing relationships`}
              >
                <span className="graph-list-index">{String(index + 1).padStart(2, "0")}</span>
                <span className="graph-list-node">
                  <small>
                    {humanize(node.kind)} · {humanize(node.status)}
                  </small>
                  <strong>{node.label}</strong>
                  {detail ? <span>{detail}</span> : null}
                </span>
                <span className="graph-list-links">
                  {incoming.length} in
                  <br />
                  {outgoing.length} out
                </span>
              </button>
              {incoming.length > 0 || outgoing.length > 0 ? (
                <ul aria-label={`Relationships for ${node.label}`}>
                  {incoming.map((edge) => (
                    <li key={`in-${edge.id}`}>
                      <span>← {humanize(edge.kind)}</span>
                      <strong>
                        {graph.nodes.find((candidate) => candidate.id === edge.fromNodeId)?.label ?? edge.fromNodeId}
                      </strong>
                    </li>
                  ))}
                  {outgoing.map((edge) => (
                    <li key={`out-${edge.id}`}>
                      <span>→ {humanize(edge.kind)}</span>
                      <strong>
                        {graph.nodes.find((candidate) => candidate.id === edge.toNodeId)?.label ?? edge.toNodeId}
                      </strong>
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

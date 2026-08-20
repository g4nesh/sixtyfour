import { useMemo } from "react";
import { SOURCE_HIERARCHY } from "../../lib/search/source-hierarchy";
import type { CanonicalSearchGraph } from "../graph-model";
import { ChevronIcon, LayersIcon } from "./atlas-icons";

export function SourceLadder({ graph, collapsed, onToggle }: {
  graph: CanonicalSearchGraph | null;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const rows = useMemo(() => SOURCE_HIERARCHY.map((item) => {
    const nodes = graph?.nodes.filter((node) => node.sourceTier === item.tier && node.sourceLaneId === item.id) ?? [];
    const frontier = graph?.frontier.filter((entry) => entry.sourceLaneId === item.id) ?? [];
    const active = nodes.filter((node) => ["selected", "running"].includes(node.status)).length;
    const attempts = nodes.filter((node) => node.kind === "action").length;
    const verifiedSources = nodes.filter((node) =>
      node.kind === "source"
      && node.status === "verified"
      && node.data.sourceType !== "search_result").length;
    const complete = verifiedSources;
    const rejected = nodes.filter((node) => node.status === "rejected").length;
    return { item, attempts, verifiedSources, active, complete, rejected, queued: frontier.length };
  }), [graph]);

  return <aside className={`source-ladder ${collapsed ? "is-collapsed" : ""}`} aria-label="Website source search hierarchy">
    <button className="source-ladder-toggle" type="button" onClick={onToggle} aria-expanded={!collapsed} aria-controls="source-ladder-steps">
      <LayersIcon />
      <span><strong>Source ladder</strong><small>Website search order</small></span>
      <ChevronIcon className="source-ladder-chevron" />
    </button>
    <ol id="source-ladder-steps" hidden={collapsed}>
      {rows.map(({ item, attempts, verifiedSources, active, complete, rejected, queued }) => <li key={item.id} className={active ? "is-active" : complete ? "is-complete" : rejected ? "is-rejected" : ""}>
        <span className="ladder-index">T{item.tier}</span>
        <span className="ladder-copy"><strong>{item.label}</strong><small>{item.description}</small></span>
        <span
          className="ladder-count"
          aria-label={`${verifiedSources} verified sources from ${attempts} tool attempts; ${queued} frontier entries`}
        >{active ? "live" : verifiedSources}</span>
      </li>)}
    </ol>
    {!collapsed ? <p className="source-ladder-policy">Private contact and home-record research is blocked.</p> : null}
  </aside>;
}

import { useMemo } from "react";
import { SOURCE_HIERARCHY } from "../../lib/search/source-hierarchy";
import { humanize, isStructuredSearchTransport, traceSearchTransportAttempts, type TraceEvent } from "../atlas-types";
import { querySiteScopes, type CanonicalSearchGraph } from "../graph-model";
import { ChevronIcon, LayersIcon } from "./atlas-icons";

export function SourceLadder({
  graph,
  trace,
  collapsed,
  onToggle,
}: {
  graph: CanonicalSearchGraph | null;
  trace: TraceEvent[];
  collapsed: boolean;
  onToggle: () => void;
}) {
  const rows = useMemo(
    () =>
      SOURCE_HIERARCHY.map((item) => {
        const nodes =
          graph?.nodes.filter((node) => node.sourceTier === item.tier && node.sourceLaneId === item.id) ?? [];
        const frontier = graph?.frontier.filter((entry) => entry.sourceLaneId === item.id) ?? [];
        const searchQueries = frontier.filter((entry) => entry.allowedTools.includes("search_web"));
        const siteScopes = [...new Set(searchQueries.flatMap((entry) => querySiteScopes(entry.queryHint)))];
        const active = nodes.filter((node) => ["selected", "running"].includes(node.status)).length;
        const attempts = nodes.filter((node) => node.kind === "action").length;
        const verifiedSources = nodes.filter(
          (node) => node.kind === "source" && node.status === "verified" && node.data.sourceType !== "search_result",
        ).length;
        const classifiedLeads =
          graph?.nodes.filter(
            (node) =>
              node.kind === "source" &&
              node.status === "exhausted" &&
              node.data.sourceType === "search_result" &&
              node.data.classifiedSourceTier === item.tier &&
              (typeof node.data.classifiedSourceLaneId !== "string" || node.data.classifiedSourceLaneId === item.id),
          ).length ?? 0;
        const complete = verifiedSources;
        const rejected = nodes.filter((node) => node.status === "rejected").length;
        return {
          item,
          attempts,
          verifiedSources,
          classifiedLeads,
          active,
          complete,
          rejected,
          queued: frontier.length,
          queryCount: searchQueries.length,
          siteScopes,
        };
      }),
    [graph],
  );
  const transportAttempts = useMemo(() => traceSearchTransportAttempts(trace), [trace]);
  const webTransports = transportAttempts.filter((transport) => !isStructuredSearchTransport(transport));
  const structuredTransports = transportAttempts.filter(isStructuredSearchTransport);

  return (
    <aside className={`source-ladder ${collapsed ? "is-collapsed" : ""}`} aria-label="Website source search hierarchy">
      <button
        className="source-ladder-toggle"
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-controls="source-ladder-steps"
      >
        <LayersIcon />
        <span>
          <strong>Source ladder</strong>
          <small>Website search order</small>
        </span>
        <ChevronIcon className="source-ladder-chevron" />
      </button>
      <ol id="source-ladder-steps" hidden={collapsed}>
        {rows.map(
          ({
            item,
            attempts,
            verifiedSources,
            classifiedLeads,
            active,
            complete,
            rejected,
            queued,
            queryCount,
            siteScopes,
          }) => (
            <li
              key={item.id}
              className={
                active
                  ? "is-active"
                  : complete
                    ? "is-complete"
                    : classifiedLeads
                      ? "has-leads"
                      : rejected
                        ? "is-rejected"
                        : ""
              }
            >
              <span className="ladder-index">T{item.tier}</span>
              <span className="ladder-copy">
                <strong>{item.label}</strong>
                <small>{item.description}</small>
                {siteScopes.length > 0 ? (
                  <small className="ladder-query-scopes">Sites: {siteScopes.join(" · ")}</small>
                ) : queryCount > 0 ? (
                  <small className="ladder-query-scopes">
                    {queryCount} exact/operator {queryCount === 1 ? "query" : "queries"}
                  </small>
                ) : null}
              </span>
              <span
                className="ladder-count"
                aria-label={`${verifiedSources} verified sources and ${classifiedLeads} unverified leads from ${attempts} tool attempts; ${queued} frontier entries`}
              >
                <strong>
                  {active
                    ? "live"
                    : verifiedSources
                      ? `${verifiedSources} cited`
                      : classifiedLeads
                        ? `${classifiedLeads} lead${classifiedLeads === 1 ? "" : "s"}`
                        : "none"}
                </strong>
                <small>
                  {attempts} {attempts === 1 ? "try" : "tries"}
                </small>
              </span>
            </li>
          ),
        )}
      </ol>
      {!collapsed ? (
        <footer className="source-ladder-footer">
          {transportAttempts.length > 0 ? (
            <div className="ladder-transports" aria-label="Search transport attempts">
              <strong>Transports attempted</strong>
              {webTransports.length > 0 ? (
                <section className="transport-group">
                  <small>Web discovery path</small>
                  <div>
                    {webTransports.map((transport) => (
                      <span key={transport.id} className={`transport-outcome-${transport.outcome}`}>
                        <span>{transport.label}</span>
                        <small>{humanize(transport.outcome)}</small>
                      </span>
                    ))}
                  </div>
                </section>
              ) : null}
              {structuredTransports.length > 0 ? (
                <section className="transport-group">
                  <small>Structured indexes</small>
                  <div>
                    {structuredTransports.map((transport) => (
                      <span key={transport.id} className={`transport-outcome-${transport.outcome}`}>
                        <span>{transport.label}</span>
                        <small>{humanize(transport.outcome)}</small>
                      </span>
                    ))}
                  </div>
                </section>
              ) : null}
              <p>Returned leads remain unverified until a page is fetched and admitted.</p>
            </div>
          ) : null}
          <p className="source-ladder-policy">Private contact and home-record research is blocked.</p>
        </footer>
      ) : null}
    </aside>
  );
}

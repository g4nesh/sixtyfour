import { humanize, isStructuredSearchTransport, traceSearchTransportAttempts, type TraceEvent } from "../atlas-types";
import {
  eventStableId,
  frontierForNode,
  nodeDepth,
  nodeDetail,
  nodePathCost,
  nodePriority,
  nodeRelationships,
  nodeUrl,
  querySiteScopes,
  type CanonicalSearchGraph,
  type SearchGraphNode,
} from "../graph-model";
import { CloseIcon, ExternalIcon } from "./atlas-icons";

function formatMetric(value: number | undefined): string {
  return typeof value === "number" ? value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "") : "—";
}

export function NodeInspector({
  graph,
  node,
  trace,
  onClose,
}: {
  graph: CanonicalSearchGraph;
  node: SearchGraphNode | null;
  trace: TraceEvent[];
  onClose: () => void;
}) {
  if (!node)
    return (
      <aside className="node-inspector inspector-empty" aria-label="Graph node inspector">
        <div className="inspector-empty-mark" aria-hidden="true">
          ⌁
        </div>
        <strong>Inspect a search node</strong>
        <p>Select any seed, frontier, source, candidate, or evidence node to see its path and relationships.</p>
      </aside>
    );

  const relationships = nodeRelationships(graph, node.id);
  const frontier = frontierForNode(graph, node);
  const detail = nodeDetail(graph, node);
  const url = nodeUrl(node);
  const searchQuery = frontier?.allowedTools.includes("search_web") ? frontier.queryHint : null;
  const siteScopes = searchQuery ? querySiteScopes(searchQuery) : [];
  const relatedTrace = frontier ? trace.filter((event) => eventStableId(event) === frontier.id) : [];
  const transports = traceSearchTransportAttempts(relatedTrace);
  const webTransports = transports.filter((transport) => !isStructuredSearchTransport(transport));
  const structuredTransports = transports.filter(isStructuredSearchTransport);
  return (
    <aside className="node-inspector" aria-label={`Inspector for ${node.label}`}>
      <header>
        <span className={`node-status-dot status-${node.status}`} aria-hidden="true" />
        <div>
          <small>{humanize(node.kind)}</small>
          <strong>{node.label}</strong>
        </div>
        <button type="button" onClick={onClose} aria-label="Close node inspector">
          <CloseIcon />
        </button>
      </header>
      {detail ? <p className="inspector-detail">{detail}</p> : null}
      <dl className="inspector-metrics">
        <div>
          <dt>Status</dt>
          <dd>{humanize(node.status)}</dd>
        </div>
        <div>
          <dt>Scheduler path cost</dt>
          <dd>{formatMetric(nodePathCost(graph, node))}</dd>
        </div>
        <div>
          <dt>Priority</dt>
          <dd>{formatMetric(nodePriority(graph, node))}</dd>
        </div>
        <div>
          <dt>Depth</dt>
          <dd>{nodeDepth(graph, node) ?? "—"}</dd>
        </div>
      </dl>
      <p className="inspector-path-note">
        Scheduler path cost is ranking metadata, not an API charge, error, or rejection reason. Exhausted means this
        frontier is closed for the run; check Transport attempts or the trace to see whether a request actually ran. The
        score did not reject it.
      </p>
      {frontier ? (
        <section className="inspector-execution" aria-labelledby="execution-heading">
          <div className="inspector-section-heading">
            <h3 id="execution-heading">Search execution</h3>
            <span>{frontier.allowedTools.length}</span>
          </div>
          {searchQuery ? (
            <div>
              <span>Exact query</span>
              <code>{searchQuery}</code>
            </div>
          ) : null}
          {siteScopes.length > 0 ? (
            <div>
              <span>Site scope</span>
              <strong>{siteScopes.join(" · ")}</strong>
            </div>
          ) : null}
          <div>
            <span>Allowed tools</span>
            <strong>{frontier.allowedTools.map(humanize).join(" · ")}</strong>
          </div>
          {transports.length > 0 ? (
            <div>
              <span>Transport attempts</span>
              {webTransports.length > 0 ? (
                <section className="inspector-transport-group">
                  <strong>Web discovery path</strong>
                  <ul>
                    {webTransports.map((transport) => (
                      <li key={transport.id}>
                        <strong>{transport.label}</strong>
                        <small>{humanize(transport.outcome)}</small>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {structuredTransports.length > 0 ? (
                <section className="inspector-transport-group">
                  <strong>Structured indexes</strong>
                  <ul>
                    {structuredTransports.map((transport) => (
                      <li key={transport.id}>
                        <strong>{transport.label}</strong>
                        <small>{humanize(transport.outcome)}</small>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </div>
          ) : null}
          <p>Attempts and discovery leads are not cited sources unless a hardened fetch admits evidence.</p>
        </section>
      ) : null}
      <section className="inspector-identifiers" aria-label="Stable graph identifiers">
        {node.frontierEntryId ? (
          <div>
            <span>Frontier</span>
            <code>{node.frontierEntryId}</code>
          </div>
        ) : null}
        {node.actionId ? (
          <div>
            <span>Action</span>
            <code>{node.actionId}</code>
          </div>
        ) : null}
        {node.candidateId ? (
          <div>
            <span>Candidate</span>
            <code>{node.candidateId}</code>
          </div>
        ) : null}
        {node.evidenceId ? (
          <div>
            <span>Evidence</span>
            <code>{node.evidenceId}</code>
          </div>
        ) : null}
        {frontier?.sourceLaneId ? (
          <div>
            <span>Source lane</span>
            <code>{frontier.sourceLaneId}</code>
          </div>
        ) : null}
      </section>
      <section className="inspector-relations" aria-labelledby="relations-heading">
        <div className="inspector-section-heading">
          <h3 id="relations-heading">Relationships</h3>
          <span>{relationships.length}</span>
        </div>
        <ul>
          {relationships.map((edge) => {
            const outgoing = edge.fromNodeId === node.id;
            const otherId = outgoing ? edge.toNodeId : edge.fromNodeId;
            const other = graph.nodes.find((candidate) => candidate.id === otherId);
            return (
              <li key={edge.id}>
                <span className={`relation-line status-${edge.status}`} aria-hidden="true" />
                <span>
                  <small>{outgoing ? humanize(edge.kind) : `From · ${humanize(edge.kind)}`}</small>
                  <strong>{other?.label ?? otherId}</strong>
                </span>
              </li>
            );
          })}
        </ul>
        {relationships.length === 0 ? <p>No graph edges touch this node.</p> : null}
      </section>
      {url ? (
        <a className="inspector-source-link" href={url} target="_blank" rel="noreferrer">
          Open canonical source <ExternalIcon />
        </a>
      ) : null}
    </aside>
  );
}

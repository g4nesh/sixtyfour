import type { TraceEvent } from "../atlas-types";
import {
  eventType,
  formatDuration,
  formatUsage,
  humanize,
  isStructuredSearchTransport,
  traceDiagnostics,
  traceDuration,
  traceSearchQuery,
  traceSearchTransportAttempts,
  traceUsage,
} from "../atlas-types";
import { ChevronIcon } from "./atlas-icons";
import { eventStableId } from "../graph-model";

function transportOutcomeCopy(outcome: ReturnType<typeof traceSearchTransportAttempts>[number]["outcome"]): string {
  if (outcome === "returned_leads") return "returned unverified leads";
  if (outcome === "no_safe_leads") return "no safe leads";
  if (outcome === "no_match") return "no exact match";
  return outcome;
}

function traceSummary(event: TraceEvent, searchQuery: string | null = null): string {
  const attributes = event.payload ?? event.attributes;
  const diagnostics = traceDiagnostics(event);
  const diagnostic = diagnostics.find((item) => item.severity !== "info") ?? diagnostics[0];
  if (eventType(event) === "tool.search_web" && searchQuery) {
    const transports = traceSearchTransportAttempts([event]);
    const webSummary = transports
      .filter((transport) => !isStructuredSearchTransport(transport))
      .map((transport) => `${transport.label}: ${transportOutcomeCopy(transport.outcome)}`)
      .join(" → ");
    const structuredSummary = transports
      .filter(isStructuredSearchTransport)
      .map((transport) => `${transport.label}: ${transportOutcomeCopy(transport.outcome)}`)
      .join(" → ");
    const transportSummary = [
      webSummary ? `Web path · ${webSummary}` : null,
      structuredSummary ? `Structured indexes · ${structuredSummary}` : null,
    ]
      .filter((summary): summary is string => Boolean(summary))
      .join(" · ");
    if (transportSummary)
      return `Query · ${searchQuery} · ${diagnostic && diagnostic.severity !== "info" ? `${diagnostic.message} · ` : ""}${transportSummary}`;
    if (diagnostic) return `Query · ${searchQuery} · ${diagnostic.message}`;
    return `Query · ${searchQuery}`;
  }
  const ordinarySummary =
    event.decisionSummary ??
    (typeof attributes?.decisionSummary === "string" ? attributes.decisionSummary : undefined) ??
    (typeof attributes?.summary === "string" ? attributes.summary : undefined) ??
    (event.tool ? `Tool · ${event.tool}` : humanize(eventType(event)));
  return diagnostic && diagnostic.severity !== "info"
    ? `${humanize(diagnostic.code)} · ${diagnostic.message}`
    : (ordinarySummary ??
        (diagnostic ? `${humanize(diagnostic.code)} · ${diagnostic.message}` : humanize(eventType(event))));
}

export function TraceRail({
  trace,
  expanded,
  onToggle,
  focusedStableId,
  onFocusStableId,
}: {
  trace: TraceEvent[];
  expanded: boolean;
  onToggle: () => void;
  focusedStableId: string | null;
  onFocusStableId: (stableId: string | null) => void;
}) {
  const latest = trace.at(-1);
  const searchQueryByStableId = new Map<string, string>();
  for (const event of trace) {
    const stableId = eventStableId(event);
    const query = traceSearchQuery(event);
    if (stableId && query) searchQueryByStableId.set(stableId, query);
  }
  return (
    <section className={`trace-rail ${expanded ? "is-expanded" : ""}`} aria-label="Append-only execution trace">
      <button
        className="trace-rail-handle"
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls="trace-rail-content"
      >
        <span className={`trace-live-pip ${latest ? "has-events" : ""}`} aria-hidden="true" />
        <strong>Trace</strong>
        <span className="trace-latest">{latest ? humanize(eventType(latest)) : "Waiting for a run"}</span>
        <span>{trace.length} events</span>
        <span>{formatDuration(traceDuration(latest))}</span>
        <kbd>T</kbd>
        <ChevronIcon />
      </button>
      <div id="trace-rail-content" hidden={!expanded}>
        <header>
          <div>
            <span>Append-only execution</span>
            <strong>Decisions, calls, gates, and usage</strong>
          </div>
          <p>No hidden chain-of-thought is exposed.</p>
        </header>
        <ol className="trace-event-list">
          {trace.map((event, index) => {
            const stableId = eventStableId(event);
            const searchQuery = traceSearchQuery(event) ?? (stableId ? searchQueryByStableId.get(stableId) : null);
            const sequence = event.seq ?? event.sequence ?? index + 1;
            const elapsed = traceDuration(event);
            const usage = traceUsage(event);
            const diagnostic =
              traceDiagnostics(event).find((item) => item.severity !== "info") ?? traceDiagnostics(event)[0];
            const focused = Boolean(stableId && stableId === focusedStableId);
            return (
              <li
                key={`${sequence}-${event.spanId ?? eventType(event)}`}
                className={diagnostic ? `has-diagnostic severity-${diagnostic.severity}` : undefined}
              >
                <button
                  type="button"
                  className={focused ? "is-focused" : ""}
                  onClick={() => onFocusStableId(stableId)}
                  aria-pressed={focused}
                >
                  <span className="trace-sequence">{String(sequence).padStart(2, "0")}</span>
                  <span className="trace-event-copy">
                    <small>
                      {humanize(event.phase)} ·{" "}
                      {typeof elapsed === "number" ? `t+${(elapsed / 1000).toFixed(2)}s` : "time unavailable"}
                    </small>
                    <strong>{humanize(eventType(event))}</strong>
                    <span>{traceSummary(event, searchQuery ?? null)}</span>
                  </span>
                  <span className="trace-event-meta">
                    {event.attempt && event.attempt > 1
                      ? `try ${event.attempt}`
                      : stableId
                        ? stableId.slice(-10)
                        : formatUsage(usage)}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        {trace.length === 0 ? (
          <div className="trace-rail-empty">
            <span aria-hidden="true">⌁</span>
            <p>Frontier selection, mutations, tool calls, evidence admission, and terminal state will stream here.</p>
          </div>
        ) : null}
      </div>
    </section>
  );
}

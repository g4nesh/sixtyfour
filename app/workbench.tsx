"use client";

import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { FindingCategory, InvestigationReport } from "../lib/domain/types";
import type { Report, RunStatus, TraceEvent } from "./atlas-types";
import {
  eventType,
  formatDuration,
  formatUsage,
  humanize,
  traceDiagnostics,
  traceDuration,
  traceUsage,
} from "./atlas-types";
import {
  eventStableId,
  graphFromReport,
  mergeGraphEvent,
  mergeGraphSnapshot,
  stableNodeForEvent,
  type CanonicalSearchGraph,
} from "./graph-model";
import { GraphWorkspace, type GraphView } from "./components/graph-workspace";
import { NodeInspector } from "./components/node-inspector";
import { ReportSheet } from "./components/report-sheet";
import { SourceLadder } from "./components/source-ladder";
import { TraceRail } from "./components/trace-rail";
import { PlayIcon, ReportIcon, SearchIcon, StopIcon } from "./components/atlas-icons";

// Public-professional research modalities. These map to report categories, not
// to any private-contact/location data — home address, personal phone, and
// tax/data-broker records are intentionally out of scope.
const MODALITIES: ReadonlyArray<{ id: FindingCategory; label: string }> = [
  { id: "identity", label: "Identity" },
  { id: "employment", label: "Employer & role" },
  { id: "online_presence", label: "Profiles & handles" },
  { id: "project", label: "Projects & repos" },
  { id: "publication", label: "Publications" },
  { id: "education", label: "Education" },
];

const DEFAULT_MODALITIES: readonly FindingCategory[] = ["identity", "employment", "online_presence"];

const EXAMPLE_QUERIES: readonly string[] = [
  "torvalds@linux-foundation.org",
  "Chris Anderson, TED",
  "the creator of Python",
];

interface AtlasWorkbenchProps {
  onDownloadMarkdown?: (report: Report) => void | Promise<void>;
  onDownloadPdf?: (report: Report) => void | Promise<void>;
}

type ResearchExecutionMode = "live" | "replay" | "local_demo";

function executionModeFromResponse(response: Response): ResearchExecutionMode | null {
  const value = response.headers.get("x-atlas-execution-mode")?.trim().toLocaleLowerCase("en-US");
  if (value === "live" || value === "replay" || value === "local_demo") return value;
  return null;
}

function executionModeLabel(mode: ResearchExecutionMode): string {
  if (mode === "local_demo") return "Local demo replay";
  return mode === "replay" ? "Replay" : "Live";
}

function terminalReport(event: TraceEvent): Report | null {
  return (
    event.report ??
    event.result?.report ??
    (event.payload?.report as Report | undefined) ??
    (event.attributes?.report as Report | undefined) ??
    null
  );
}

function terminalStatusFor(event: TraceEvent, report: Report | null): string | undefined {
  return report?.status ?? event.status;
}

function runMessage(
  status: string | undefined,
  diagnosticCodes: ReadonlySet<string> = new Set(),
  hasDirectEvidence = false,
): string {
  if (status === "configuration_error")
    return "Live mode is not configured on this server. Enable live mode and configure a server-side provider key.";
  if (status === "blocked") return "The request was refused by the public-professional safety policy.";
  if (status === "failed") return "The run ended early. Inspect the terminal trace for the recorded boundary.";
  if (status === "canceled") return "The run was canceled. Its partial graph and trace remain inspectable.";
  const providerUnavailable =
    diagnosticCodes.has("search_provider_quota_exhausted") ||
    diagnosticCodes.has("search_provider_unavailable") ||
    diagnosticCodes.has("search_provider_circuit_open");
  const providerUngrounded = diagnosticCodes.has("search_provider_sources_not_observed");
  const googleAttempted = [...diagnosticCodes].some((code) => code.startsWith("google_"));
  const duckDuckGoAttempted = [...diagnosticCodes].some((code) => code.startsWith("duckduckgo_"));
  const githubAttempted = [...diagnosticCodes].some(
    (code) => code.startsWith("github_public_user_") || code.startsWith("github_exact_name_"),
  );
  const retainedSourceMessage = hasDirectEvidence
    ? "A directly fetched citation is in the report."
    : "No directly fetched citation was admitted before the run stopped.";
  const providerBoundary = providerUnavailable ? "was unavailable" : "returned no usable source annotations";
  const fallbackAttempts = [
    duckDuckGoAttempted ? "DuckDuckGo HTML" : null,
    googleAttempted ? "Google HTML" : null,
    githubAttempted ? "GitHub exact-name" : null,
  ].filter((label): label is string => Boolean(label));
  if ((providerUnavailable || providerUngrounded) && fallbackAttempts.length > 0) {
    return `${status === "partial" ? "Partial coverage" : "Run complete"} — provider search ${providerBoundary}. Atlas then attempted ${fallbackAttempts.join(" and ")} fallback discovery. ${retainedSourceMessage}`;
  }
  if (providerUnavailable || providerUngrounded) {
    return `Partial coverage — the configured web-search provider ${providerBoundary} and no fallback source was verified. Inspect the trace for the recorded boundary.`;
  }
  if (status === "partial")
    return "Stopped with partial coverage — the cited sources gathered so far are in the report.";
  if (status === "ambiguous") return "Identity remained ambiguous; competing candidate branches were not merged.";
  return "Run complete. Every finding links to the public source it was drawn from.";
}

async function defaultMarkdownDownload(report: Report): Promise<void> {
  const [{ createReportViewModel }, { downloadReportMarkdown }] = await Promise.all([
    import("../lib/report-export"),
    import("./report/downloads.client"),
  ]);
  const model = createReportViewModel(report as unknown as InvestigationReport);
  downloadReportMarkdown(model);
}

async function defaultPdfDownload(report: Report): Promise<void> {
  const [{ createReportViewModel }, { downloadReportPdf }] = await Promise.all([
    import("../lib/report-export"),
    import("./report/downloads.client"),
  ]);
  const model = createReportViewModel(report as unknown as InvestigationReport);
  await downloadReportPdf(model);
}

function isTerminalEvent(event: TraceEvent): boolean {
  return eventType(event).includes("terminal");
}

function graphStatusLabel(graph: CanonicalSearchGraph | null, runStatus: RunStatus): string {
  if (runStatus === "running") return graph ? `Search ${graph.status}` : "Awaiting frontier";
  if (graph) return `Graph ${graph.status}`;
  return "Idle";
}

function subscribeCompactViewport(onStoreChange: () => void): () => void {
  const media = window.matchMedia("(max-width: 980px)");
  media.addEventListener("change", onStoreChange);
  return () => media.removeEventListener("change", onStoreChange);
}

function compactViewportSnapshot(): boolean {
  return window.matchMedia("(max-width: 980px)").matches;
}

export function AtlasWorkbench({ onDownloadMarkdown, onDownloadPdf }: AtlasWorkbenchProps = {}) {
  const [query, setQuery] = useState<string>("");
  const [categories, setCategories] = useState<ReadonlySet<FindingCategory>>(() => new Set(DEFAULT_MODALITIES));
  const [report, setReport] = useState<Report | null>(null);
  const [trace, setTrace] = useState<TraceEvent[]>([]);
  const [graph, setGraph] = useState<CanonicalSearchGraph | null>(null);
  const [runStatus, setRunStatus] = useState<RunStatus>("idle");
  const [message, setMessage] = useState("Describe the person with any public-professional context you have.");
  const [executionMode, setExecutionMode] = useState<ResearchExecutionMode | null>(null);
  const [liveConfigured, setLiveConfigured] = useState<boolean | null>(null);
  const [graphView, setGraphView] = useState<GraphView>("graph");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [focusedStableId, setFocusedStableId] = useState<string | null>(null);
  const [sourceLadderPreference, setSourceLadderPreference] = useState<boolean | null>(null);
  const [traceExpanded, setTraceExpanded] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [fitRequest, setFitRequest] = useState(0);
  const [exporting, setExporting] = useState<"markdown" | "pdf" | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const queryRef = useRef<HTMLInputElement>(null);
  const compactViewport = useSyncExternalStore(subscribeCompactViewport, compactViewportSnapshot, () => false);
  const sourceLadderCollapsed = sourceLadderPreference ?? compactViewport;

  const resetRun = useCallback(() => {
    setReport(null);
    setTrace([]);
    setGraph(null);
    setSelectedNodeId(null);
    setFocusedStableId(null);
    setReportOpen(false);
    setExecutionMode(null);
  }, []);

  const applyReport = useCallback((nextReport: Report | null) => {
    setReport(nextReport);
    const nextGraph = graphFromReport(nextReport);
    setGraph((current) => mergeGraphSnapshot(current, nextGraph));
  }, []);

  const toggleModality = useCallback((id: FindingCategory) => {
    setCategories((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        if (next.size > 1) next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    void fetch("/api/health", { headers: { accept: "application/json" } })
      .then(async (response) => (response.ok ? ((await response.json()) as { liveConfigured?: boolean }) : null))
      .then((health) => setLiveConfigured(health?.liveConfigured ?? false))
      .catch(() => setLiveConfigured(false));
    return () => abortRef.current?.abort();
  }, []);

  const ingestEvent = useCallback(
    (streamed: TraceEvent): string | undefined => {
      setTrace((current) => [...current, streamed]);
      setGraph((current) => mergeGraphEvent(current, streamed));
      const stableId = eventStableId(streamed);
      if (stableId) setFocusedStableId(stableId);
      const nextReport = terminalReport(streamed);
      if (nextReport) applyReport(nextReport);
      if (!isTerminalEvent(streamed)) return undefined;
      const status = terminalStatusFor(streamed, nextReport);
      setRunStatus(
        status === "canceled"
          ? "canceled"
          : ["failed", "configuration_error", "blocked"].includes(status ?? "")
            ? "error"
            : "complete",
      );
      return status;
    },
    [applyReport],
  );

  const startResearch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) {
      setMessage("Describe the person with a name or other public-professional context.");
      queryRef.current?.focus();
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    resetRun();
    setRunStatus("running");
    setMessage("Searching public professional sources…");
    let terminalStatus: string | undefined;
    let completedReport: Report | null = null;
    const diagnosticCodes = new Set<string>();
    try {
      const response = await fetch("/api/research", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/x-ndjson" },
        body: JSON.stringify({
          query: trimmed,
          mode: "live",
          requestedDepth: "deep",
          requestedCategories: [...categories],
        }),
        signal: controller.signal,
      });
      if (abortRef.current !== controller || controller.signal.aborted) return;
      if (!response.ok || !response.body) {
        const detail = await response.text();
        throw new Error(detail || `Research failed (${response.status})`);
      }
      const responseExecutionMode = executionModeFromResponse(response);
      setExecutionMode(responseExecutionMode);
      if (responseExecutionMode === "local_demo") {
        setMessage("Local demo replay — streaming a captured, zero-network investigation.");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      while (true) {
        const { done, value } = await reader.read();
        buffered += decoder.decode(value, { stream: !done });
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          if (abortRef.current !== controller || controller.signal.aborted) return;
          const streamed = JSON.parse(line) as TraceEvent;
          traceDiagnostics(streamed).forEach((diagnostic) => diagnosticCodes.add(diagnostic.code));
          completedReport = terminalReport(streamed) ?? completedReport;
          terminalStatus = ingestEvent(streamed) ?? terminalStatus;
        }
        if (done) break;
      }
      if (buffered.trim()) {
        const streamed = JSON.parse(buffered) as TraceEvent;
        traceDiagnostics(streamed).forEach((diagnostic) => diagnosticCodes.add(diagnostic.code));
        completedReport = terminalReport(streamed) ?? completedReport;
        terminalStatus = ingestEvent(streamed) ?? terminalStatus;
      }
      if (abortRef.current !== controller || controller.signal.aborted) return;
      setRunStatus((current) => (current === "running" ? "complete" : current));
      const hasDirectEvidence =
        completedReport?.evidence?.some((evidence) => evidence.verificationMethod === "direct_fetch") ?? false;
      const completionMessage = runMessage(terminalStatus, diagnosticCodes, hasDirectEvidence);
      setMessage(
        responseExecutionMode === "local_demo" ? `Local demo replay — ${completionMessage}` : completionMessage,
      );
    } catch (error) {
      if (abortRef.current !== controller) return;
      if (controller.signal.aborted) {
        setRunStatus("canceled");
        setMessage("Run canceled. The partial graph and trace remain available.");
      } else {
        setRunStatus("error");
        setMessage(error instanceof Error ? error.message : "Research failed");
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const focusStableId = useCallback(
    (stableId: string | null) => {
      setFocusedStableId(stableId);
      const nodeId = stableNodeForEvent(graph, stableId);
      if (nodeId) setSelectedNodeId(nodeId);
    },
    [graph],
  );

  const requestFit = useCallback(() => {
    setGraphView("graph");
    setFitRequest((value) => value + 1);
  }, []);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      if (event.key === "/" && !isTyping) {
        event.preventDefault();
        queryRef.current?.focus();
        queryRef.current?.select();
        return;
      }
      if (isTyping || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        requestFit();
      } else if (event.key.toLowerCase() === "l") {
        event.preventDefault();
        setGraphView((current) => (current === "graph" ? "list" : "graph"));
      } else if (event.key.toLowerCase() === "r" && report) {
        event.preventDefault();
        setReportOpen((current) => !current);
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [report, requestFit]);

  const activeNode = useMemo(
    () => graph?.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [graph, selectedNodeId],
  );
  const lastTrace = trace.at(-1);
  const elapsed = report?.usage?.elapsedMs ?? report?.telemetry?.elapsedMs ?? traceDuration(lastTrace);
  const usage = report?.usage ?? report?.telemetry?.usage ?? traceUsage(lastTrace);
  const reportStatus = report?.status ?? runStatus;

  const markdownDownload = useCallback(
    async (nextReport: Report) => {
      setExporting("markdown");
      try {
        await (onDownloadMarkdown ?? defaultMarkdownDownload)(nextReport);
        setMessage("Markdown intelligence report downloaded.");
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Markdown export failed.");
      } finally {
        setExporting(null);
      }
    },
    [onDownloadMarkdown],
  );

  const pdfDownload = useCallback(
    async (nextReport: Report) => {
      setExporting("pdf");
      try {
        await (onDownloadPdf ?? defaultPdfDownload)(nextReport);
        setMessage("PDF intelligence report downloaded.");
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "PDF export failed.");
      } finally {
        setExporting(null);
      }
    },
    [onDownloadPdf],
  );

  const idle = runStatus === "idle" && !report;

  return (
    <div className="atlas-shell">
      <a className="skip-link" href="#graph-workspace">
        Skip to search graph
      </a>
      <header className="command-header">
        <a className="atlas-wordmark" href="#graph-workspace" aria-label="Atlas home">
          <strong>Atlas</strong>
        </a>
        <form className="command-search" onSubmit={startResearch} role="search">
          <label className="sr-only" htmlFor="atlas-query">
            Public-professional research input
          </label>
          <SearchIcon />
          <input
            ref={queryRef}
            id="atlas-query"
            name="query"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Any public context: name, role, company, city/region, adult school, URL, or handle"
            autoComplete="off"
            spellCheck="false"
            aria-describedby="research-scope-note"
          />
          <kbd>/</kbd>
        </form>
        {runStatus === "running" ? (
          <button className="run-button is-stop" type="button" onClick={() => abortRef.current?.abort()}>
            <StopIcon />
            <span>Stop</span>
          </button>
        ) : (
          <button
            className="run-button"
            type="button"
            onClick={() => document.querySelector<HTMLFormElement>(".command-search")?.requestSubmit()}
          >
            <PlayIcon />
            <span>Research</span>
          </button>
        )}
        <button
          className="report-button"
          type="button"
          onClick={() => setReportOpen(true)}
          disabled={!report}
          aria-label="Report"
          title="Open intelligence report (R)"
        >
          <ReportIcon />
          <span>Report</span>
          {exporting ? <i role="status" aria-label={`Exporting ${exporting}`} /> : null}
        </button>
      </header>

      <main id="graph-workspace" className="atlas-main">
        <div className="workspace-status" role="status" aria-live="polite">
          <span className={`run-status-pip status-${runStatus}`} aria-hidden="true" />
          <strong>{humanize(reportStatus)}</strong>
          <span className="workspace-message">{message}</span>
          <div className="workspace-metrics">
            {executionMode ? <span className="execution-mode">{executionModeLabel(executionMode)}</span> : null}
            <span>{graphStatusLabel(graph, runStatus)}</span>
            <span>{formatDuration(elapsed)}</span>
            <span>{formatUsage(usage)}</span>
          </div>
        </div>

        <div className="scope-row">
          <fieldset className="modality-toggles" aria-label="Research modalities">
            <legend className="sr-only">Research modalities</legend>
            {MODALITIES.map((modality) => {
              const active = categories.has(modality.id);
              return (
                <button
                  key={modality.id}
                  type="button"
                  className={active ? "modality is-on" : "modality"}
                  aria-pressed={active}
                  onClick={() => toggleModality(modality.id)}
                >
                  {modality.label}
                </button>
              );
            })}
          </fieldset>
          <p id="research-scope-note" className="scope-note">
            <span aria-hidden="true">●</span> Free-form public context is welcome: role, company, city/region, and adult
            school. Home addresses, personal phones, data-broker records, and research about minors are refused.
          </p>
        </div>

        {idle ? (
          <div className="empty-hint">
            <p>Try:</p>
            <div className="example-chips">
              {EXAMPLE_QUERIES.map((example) => (
                <button
                  key={example}
                  type="button"
                  className="example-chip"
                  onClick={() => {
                    setQuery(example);
                    queryRef.current?.focus();
                  }}
                >
                  {example}
                </button>
              ))}
            </div>
            {liveConfigured === false ? (
              <p className="config-hint">Live mode is not configured on this server yet.</p>
            ) : null}
          </div>
        ) : null}

        <GraphWorkspace
          graph={graph}
          view={graphView}
          onViewChange={setGraphView}
          selectedNodeId={selectedNodeId}
          onSelectNode={setSelectedNodeId}
          focusedStableId={focusedStableId}
          fitRequest={fitRequest}
          onFit={requestFit}
          runStatus={runStatus}
        />
        {graph ? (
          <SourceLadder
            graph={graph}
            trace={trace}
            collapsed={sourceLadderCollapsed}
            onToggle={() => setSourceLadderPreference(!sourceLadderCollapsed)}
          />
        ) : null}
        {graph ? (
          <NodeInspector graph={graph} node={activeNode} trace={trace} onClose={() => setSelectedNodeId(null)} />
        ) : null}
        <TraceRail
          trace={trace}
          expanded={traceExpanded}
          onToggle={() => setTraceExpanded((current) => !current)}
          focusedStableId={focusedStableId}
          onFocusStableId={focusStableId}
        />
      </main>

      <ReportSheet
        report={report}
        trace={trace}
        open={reportOpen}
        onClose={() => setReportOpen(false)}
        onDownloadMarkdown={markdownDownload}
        onDownloadPdf={pdfDownload}
      />
    </div>
  );
}

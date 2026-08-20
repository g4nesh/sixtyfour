"use client";

import {
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { InvestigationReport } from "../lib/domain/types";
import type { Report, RunMode, RunStatus, TraceEvent, ExamplePayload } from "./atlas-types";
import {
  eventType,
  formatDuration,
  formatUsage,
  humanize,
  traceDuration,
  traceUsage,
} from "./atlas-types";
import {
  eventStableId,
  graphFromReport,
  mergeGraphEvent,
  stableNodeForEvent,
  type CanonicalSearchGraph,
} from "./graph-model";
import { GraphWorkspace, type GraphView } from "./components/graph-workspace";
import { NodeInspector } from "./components/node-inspector";
import { ReportSheet } from "./components/report-sheet";
import { SourceLadder } from "./components/source-ladder";
import { TraceRail } from "./components/trace-rail";
import { PlayIcon, ReportIcon, SearchIcon, StopIcon } from "./components/atlas-icons";

const examples = [
  { id: "linus-codegraph", label: "Exact email → code graph", query: "torvalds@linux-foundation.org" },
  { id: "chris-anderson-ted", label: "Same-name separation", query: "Chris Anderson, TED" },
  { id: "python-creator", label: "Role-only resolution", query: "the creator of Python" },
] as const;

interface AtlasWorkbenchProps {
  onDownloadMarkdown?: (report: Report) => void | Promise<void>;
  onDownloadPdf?: (report: Report) => void | Promise<void>;
}

function terminalReport(event: TraceEvent): Report | null {
  return event.report
    ?? event.result?.report
    ?? (event.payload?.report as Report | undefined)
    ?? (event.attributes?.report as Report | undefined)
    ?? null;
}

function terminalStatusFor(event: TraceEvent, report: Report | null): string | undefined {
  return report?.status ?? event.status;
}

function runMessage(status: string | undefined, mode: RunMode): string {
  if (status === "configuration_error") return "Live mode is not configured on this server. Verified replays remain available.";
  if (status === "blocked") return "The request was refused by the public-professional safety policy.";
  if (status === "failed") return "The run failed safely. Inspect the terminal trace for the recorded boundary.";
  if (status === "canceled") return "The run was canceled. Its partial graph and trace remain inspectable.";
  if (status === "partial") return "The run stopped with partial coverage; gaps are retained in the report.";
  if (status === "ambiguous") return "Identity remained ambiguous; competing candidate branches were not merged.";
  return mode === "live"
    ? "Live run complete. Review every finding against admitted evidence."
    : "Replay complete. No external research requests were made.";
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
  if (runStatus === "loading") return "Loading capture";
  if (runStatus === "running") return graph ? `Search ${graph.status}` : "Awaiting frontier";
  if (graph) return `Graph ${graph.status}`;
  return "Graph unavailable";
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
  const [query, setQuery] = useState<string>(examples[0].query);
  const [mode, setMode] = useState<RunMode>("replay");
  const [selectedExample, setSelectedExample] = useState<string | null>(examples[0].id);
  const [report, setReport] = useState<Report | null>(null);
  const [trace, setTrace] = useState<TraceEvent[]>([]);
  const [graph, setGraph] = useState<CanonicalSearchGraph | null>(null);
  const [runStatus, setRunStatus] = useState<RunStatus>("idle");
  const [message, setMessage] = useState("Loading the default verified replay.");
  const [liveConfigured, setLiveConfigured] = useState<boolean | null>(null);
  const [capturedAt, setCapturedAt] = useState<string | null>(null);
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
  const didLoadInitialRef = useRef(false);
  const compactViewport = useSyncExternalStore(subscribeCompactViewport, compactViewportSnapshot, () => false);
  const sourceLadderCollapsed = sourceLadderPreference ?? compactViewport;

  const resetRun = useCallback(() => {
    setReport(null);
    setTrace([]);
    setGraph(null);
    setCapturedAt(null);
    setSelectedNodeId(null);
    setFocusedStableId(null);
    setReportOpen(false);
  }, []);

  const applyReport = useCallback((nextReport: Report | null) => {
    setReport(nextReport);
    const nextGraph = graphFromReport(nextReport);
    setGraph(nextGraph);
    setSelectedNodeId((current) => current && nextGraph?.nodes.some((node) => node.id === current) ? current : null);
  }, []);

  const loadExample = useCallback(async (exampleId: string) => {
    const example = examples.find((item) => item.id === exampleId);
    if (!example) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setSelectedExample(example.id);
    setMode("replay");
    setQuery(example.query);
    resetRun();
    setRunStatus("loading");
    setMessage("Loading a deterministic, zero-network capture…");
    try {
      const response = await fetch(`/api/examples/${encodeURIComponent(example.id)}`, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Replay unavailable (${response.status})`);
      const payload = (await response.json()) as ExamplePayload;
      if (abortRef.current !== controller || controller.signal.aborted) return;
      const nextReport = payload.output ?? payload.report ?? null;
      applyReport(nextReport);
      setTrace(Array.isArray(payload.trace) ? payload.trace : []);
      setCapturedAt(payload.manifest?.capturedAt ?? null);
      setRunStatus("complete");
      setMessage(graphFromReport(nextReport)
        ? "Verified replay loaded with its canonical execution graph."
        : "This legacy capture has no canonical graph; no decorative graph was fabricated.");
    } catch (error) {
      if (controller.signal.aborted || abortRef.current !== controller) return;
      resetRun();
      setRunStatus("error");
      setMessage(error instanceof Error ? error.message : "Replay unavailable");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [applyReport, resetRun]);

  useEffect(() => {
    if (didLoadInitialRef.current) return;
    didLoadInitialRef.current = true;
    void loadExample(examples[0].id);
  }, [loadExample]);

  useEffect(() => {
    void fetch("/api/health", { headers: { accept: "application/json" } })
      .then(async (response) => response.ok ? (await response.json()) as { liveConfigured?: boolean } : null)
      .then((health) => setLiveConfigured(health?.liveConfigured ?? false))
      .catch(() => setLiveConfigured(false));
    return () => abortRef.current?.abort();
  }, []);

  const ingestEvent = useCallback((streamed: TraceEvent): string | undefined => {
    setTrace((current) => [...current, streamed]);
    setGraph((current) => mergeGraphEvent(current, streamed));
    const stableId = eventStableId(streamed);
    if (stableId) setFocusedStableId(stableId);
    const nextReport = terminalReport(streamed);
    if (nextReport) applyReport(nextReport);
    if (!isTerminalEvent(streamed)) return undefined;
    const status = terminalStatusFor(streamed, nextReport);
    setRunStatus(status === "canceled"
      ? "canceled"
      : ["failed", "configuration_error", "blocked"].includes(status ?? "")
        ? "error"
        : "complete");
    return status;
  }, [applyReport]);

  const startResearch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) {
      setMessage("Enter a name, role, organization, work email, public URL, handle, or publication.");
      queryRef.current?.focus();
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    resetRun();
    setRunStatus("running");
    setMessage(mode === "live" ? "Live public-source search started." : "Replaying captured frontier decisions.");
    let terminalStatus: string | undefined;
    try {
      const response = await fetch("/api/research", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/x-ndjson" },
        body: JSON.stringify({ query: trimmed, mode, exampleId: selectedExample }),
        signal: controller.signal,
      });
      if (abortRef.current !== controller || controller.signal.aborted) return;
      if (!response.ok || !response.body) {
        const detail = await response.text();
        throw new Error(detail || `Research failed (${response.status})`);
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
          terminalStatus = ingestEvent(JSON.parse(line) as TraceEvent) ?? terminalStatus;
        }
        if (done) break;
      }
      if (buffered.trim()) terminalStatus = ingestEvent(JSON.parse(buffered) as TraceEvent) ?? terminalStatus;
      if (abortRef.current !== controller || controller.signal.aborted) return;
      setRunStatus((current) => current === "running" ? "complete" : current);
      setMessage(runMessage(terminalStatus, mode));
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

  const setRunMode = useCallback((nextMode: RunMode) => {
    if (nextMode === mode) return;
    abortRef.current?.abort();
    abortRef.current = null;
    setMode(nextMode);
    setSelectedExample(null);
    resetRun();
    setRunStatus("idle");
    setMessage(nextMode === "live"
      ? liveConfigured
        ? "Live mode uses server-side OpenRouter and allowlisted public-source tools."
        : "Live mode needs server configuration; verified replays remain available."
      : "Replay mode is deterministic and zero-network. Choose a verified capture.");
  }, [liveConfigured, mode, resetRun]);

  const focusStableId = useCallback((stableId: string | null) => {
    setFocusedStableId(stableId);
    const nodeId = stableNodeForEvent(graph, stableId);
    if (nodeId) setSelectedNodeId(nodeId);
  }, [graph]);

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
        setGraphView((current) => current === "graph" ? "list" : "graph");
      } else if (event.key.toLowerCase() === "t") {
        event.preventDefault();
        setTraceExpanded((current) => !current);
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
  const reportMode = report?.mode ?? report?.run?.mode ?? mode;

  const markdownDownload = useCallback(async (nextReport: Report) => {
    setExporting("markdown");
    try {
      await (onDownloadMarkdown ?? defaultMarkdownDownload)(nextReport);
      setMessage("Markdown intelligence report downloaded.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Markdown export failed.");
    } finally {
      setExporting(null);
    }
  }, [onDownloadMarkdown]);

  const pdfDownload = useCallback(async (nextReport: Report) => {
    setExporting("pdf");
    try {
      await (onDownloadPdf ?? defaultPdfDownload)(nextReport);
      setMessage("PDF intelligence report downloaded.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "PDF export failed.");
    } finally {
      setExporting(null);
    }
  }, [onDownloadPdf]);

  return <div className="atlas-shell">
    <a className="skip-link" href="#graph-workspace">Skip to search graph</a>
    <header className="command-header">
      <a className="atlas-wordmark" href="#graph-workspace" aria-label="Atlas home"><span aria-hidden="true">A</span><strong>Atlas</strong></a>
      <form className="command-search" onSubmit={startResearch} role="search">
        <label className="sr-only" htmlFor="atlas-query">Public-professional research input</label>
        <SearchIcon />
        <input
          ref={queryRef}
          id="atlas-query"
          name="query"
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            if (event.target.value !== examples.find((item) => item.id === selectedExample)?.query) setSelectedExample(null);
          }}
          placeholder="Name, role, organization, work email, URL, handle, or publication"
          autoComplete="off"
          spellCheck="false"
          aria-describedby="research-scope-note"
        />
        <kbd>/</kbd>
      </form>
      <div className="mode-switch" role="group" aria-label="Research mode">
        <button type="button" className={mode === "replay" ? "is-selected" : ""} aria-pressed={mode === "replay"} onClick={() => setRunMode("replay")}>Replay</button>
        <button type="button" className={mode === "live" ? "is-selected" : ""} aria-pressed={mode === "live"} onClick={() => setRunMode("live")}>Live<span className={liveConfigured ? "is-ready" : ""} aria-label={liveConfigured ? "configured" : "not configured"} /></button>
      </div>
      <label className="example-select-label"><span className="sr-only">Verified replay</span><select value={selectedExample ?? ""} onChange={(event) => { if (event.target.value) void loadExample(event.target.value); }} disabled={mode === "live" || runStatus === "running"}><option value="">Verified captures</option>{examples.map((example) => <option key={example.id} value={example.id}>{example.label}</option>)}</select></label>
      {runStatus === "running" ? <button className="run-button is-stop" type="button" onClick={() => abortRef.current?.abort()}><StopIcon /><span>Stop</span></button> : <button className="run-button" type="button" onClick={() => document.querySelector<HTMLFormElement>(".command-search")?.requestSubmit()}><PlayIcon /><span>Run</span></button>}
      <button className="report-button" type="button" onClick={() => setReportOpen(true)} disabled={!report} title="Open intelligence report (R)"><ReportIcon /><span>Report</span>{exporting ? <i aria-label={`Exporting ${exporting}`} /> : null}</button>
    </header>

    <main id="graph-workspace" className="atlas-main">
      <div className="workspace-status" role="status" aria-live="polite">
        <span className={`run-status-pip status-${runStatus}`} aria-hidden="true" />
        <strong>{reportMode === "replay" ? "Replay" : "Live"} · {humanize(reportStatus)}</strong>
        <span>{message}</span>
        <div><span>{graphStatusLabel(graph, runStatus)}</span>{capturedAt ? <span>Captured {capturedAt.slice(0, 10)}</span> : null}<span>{formatDuration(elapsed)}</span><span>{formatUsage(usage)}</span></div>
      </div>
      <p id="research-scope-note" className="scope-note"><span aria-hidden="true">●</span> Public-professional sources only. Private contact and home-record research is blocked.</p>
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
      <SourceLadder graph={graph} collapsed={sourceLadderCollapsed} onToggle={() => setSourceLadderPreference(!sourceLadderCollapsed)} />
      {graph ? <NodeInspector graph={graph} node={activeNode} onClose={() => setSelectedNodeId(null)} /> : null}
      <div className="shortcut-rail" aria-label="Keyboard shortcuts"><span><kbd>L</kbd> list</span><span><kbd>T</kbd> trace</span><span><kbd>R</kbd> report</span></div>
      <TraceRail trace={trace} expanded={traceExpanded} onToggle={() => setTraceExpanded((current) => !current)} focusedStableId={focusedStableId} onFocusStableId={focusStableId} />
    </main>

    <ReportSheet report={report} trace={trace} open={reportOpen} onClose={() => setReportOpen(false)} onDownloadMarkdown={markdownDownload} onDownloadPdf={pdfDownload} />
  </div>;
}

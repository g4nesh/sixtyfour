"use client";

import { FormEvent, KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";

type RunMode = "replay" | "live";
type ViewTab = "dossier" | "evidence" | "trace";

interface TraceUsage {
  promptTokens?: number | null;
  completionTokens?: number | null;
  reasoningTokens?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  thinkingTokens?: number | null;
  cachedTokens?: number | null;
  cachedInputTokens?: number | null;
  totalTokens?: number | null;
  costUsd?: number | null;
  elapsedMs?: number | null;
  durationMs?: number | null;
}

interface TraceEvent {
  seq?: number;
  sequence?: number;
  kind?: string;
  type?: string;
  eventType?: string;
  phase?: string;
  status?: string;
  timestamp?: string;
  elapsedMs?: number | null;
  spanId?: string;
  parentSpanId?: string | null;
  attempt?: number;
  tool?: string;
  name?: string;
  decisionSummary?: string | null;
  payload?: Record<string, unknown>;
  attributes?: Record<string, unknown>;
  metrics?: TraceUsage & { durationMs?: number | null };
  usage?: TraceUsage | null;
}

interface Candidate {
  id?: string;
  candidateId?: string;
  name?: string;
  displayName?: string;
  headline?: string;
  affiliation?: string;
  confidenceBand?: string;
  score?: number | { total?: number; matchedSignals?: string[]; conflictingSignals?: string[] };
  selected?: boolean;
  status?: string;
  conflicts?: string[];
  matchedSignals?: string[];
  separationReason?: string;
  signals?: Array<{ kind?: string; value?: string; strength?: string }>;
}

interface Evidence {
  id?: string;
  evidenceId?: string;
  candidateId?: string;
  title?: string;
  excerpt?: string;
  minimalExcerpt?: string;
  url?: string;
  sourceUrl?: string;
  queryUrl?: string;
  publisher?: string;
  sourceFamily?: string;
  sourceType?: string;
  type?: string;
  verificationMethod?: string;
  temporalStatus?: string;
  observedAt?: string;
  retrievedAt?: string;
  contentHash?: string;
  spoofable?: boolean;
  status?: string;
  metadata?: Record<string, unknown>;
  claim?: string;
  reliability?: number;
  attributes?: Record<string, unknown>;
  source?: {
    url?: string;
    canonicalUrl?: string;
    sourceFamily?: string;
    sourceType?: string;
    title?: string;
    publisher?: string;
    accessedAt?: string;
    publishedAt?: string;
  };
}

interface Finding {
  id?: string;
  findingId?: string;
  candidateId?: string;
  title: string;
  description?: string;
  summary?: string;
  confidenceBand?: string;
  rationale?: string;
  evidenceIds?: string[];
  counterEvidenceIds?: string[];
  category?: string;
  confidence?: { label?: string; score?: number; appliedCaps?: string[] };
  caveats?: string[];
}

interface Report {
  schemaVersion?: string;
  runId?: string;
  query?: string | { raw?: string; normalized?: string; kind?: string };
  status?: string;
  mode?: RunMode;
  startedAt?: string;
  completedAt?: string;
  run?: { id?: string; query?: string; status?: string; mode?: RunMode; startedAt?: string; completedAt?: string };
  input?: { query?: string; objective?: string; requestedDepth?: string };
  identity?: { candidates?: Candidate[]; selectedCandidateId?: string | null; runnerUpMargin?: number | null; margin?: number | null; status?: string; rationale?: string };
  candidates?: Candidate[];
  selectedCandidateId?: string | null;
  candidateMargin?: number | null;
  findings?: Finding[];
  evidence?: Evidence[];
  sources?: Evidence[];
  coverage?: Record<string, unknown> | Array<Record<string, unknown>>;
  limitations?: Array<string | { code?: string; message?: string }>;
  telemetry?: { elapsedMs?: number | null; toolCalls?: number; sources?: number; usage?: TraceUsage | null };
  usage?: TraceUsage;
  stopReason?: string | { code?: string; detail?: string };
}

interface ExamplePayload {
  id?: string;
  input?: { query?: string; target?: string; mode?: RunMode };
  output?: Report;
  report?: Report;
  trace?: TraceEvent[];
  manifest?: { capturedAt?: string; title?: string; description?: string };
}

const examples = [
  { id: "linus-codegraph", label: "Email → codegraph", query: "torvalds@linux-foundation.org" },
  { id: "chris-anderson-ted", label: "Same-name separation", query: "Chris Anderson, TED" },
  { id: "python-creator", label: "Role-only resolution", query: "the creator of Python" },
] as const;

const phaseOrder = ["intake", "classify", "plan", "discover", "separate_candidates", "corroborate", "calibrate", "report", "terminal"];
const viewTabs: ViewTab[] = ["dossier", "evidence", "trace"];

function eventType(event: TraceEvent): string {
  return event.name ?? event.type ?? event.eventType ?? "event";
}

function humanize(value: string | undefined): string {
  if (!value) return "Update";
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function reportQuery(report: Report | null): string {
  if (!report) return "";
  if (typeof report.query === "string") return report.query;
  return report.query?.raw ?? report.query?.normalized ?? report.input?.query ?? report.run?.query ?? "";
}

function reportCandidates(report: Report | null): Candidate[] {
  return report?.identity?.candidates ?? report?.candidates ?? [];
}

function candidateName(candidate: Candidate): string {
  return candidate.displayName ?? candidate.name ?? "Unknown candidate";
}

function candidateMatchedSignals(candidate: Candidate): string[] {
  if (candidate.matchedSignals) return candidate.matchedSignals;
  if (typeof candidate.score === "object" && candidate.score?.matchedSignals) return candidate.score.matchedSignals;
  return (candidate.signals ?? []).filter((signal) => signal.kind !== "conflict").map((signal) => signal.kind ?? "signal");
}

function candidateConflicts(candidate: Candidate): string[] {
  if (candidate.conflicts) return candidate.conflicts;
  if (typeof candidate.score === "object" && candidate.score?.conflictingSignals) return candidate.score.conflictingSignals;
  return (candidate.signals ?? []).filter((signal) => signal.kind === "conflict").map((signal) => signal.value ?? "conflict");
}

function evidenceType(evidence: Evidence): string {
  return evidence.source?.sourceType ?? evidence.sourceType ?? evidence.type ?? "other";
}

function evidenceAttributes(evidence: Evidence): Record<string, unknown> {
  return evidence.attributes ?? evidence.metadata ?? {};
}

function traceUsage(event: TraceEvent | undefined): TraceUsage | null | undefined {
  return event?.usage ?? event?.metrics;
}

function traceDuration(event: TraceEvent | undefined): number | null | undefined {
  return event?.elapsedMs ?? event?.metrics?.durationMs;
}

function selectedCandidate(report: Report | null): Candidate | null {
  if (!report) return null;
  const candidates = reportCandidates(report);
  const selectedId = report.identity?.selectedCandidateId ?? report.selectedCandidateId;
  return candidates.find((candidate) => (candidate.id ?? candidate.candidateId) === selectedId) ?? candidates.find((candidate) => candidate.selected) ?? null;
}

function reportEvidence(report: Report | null): Evidence[] {
  return report?.evidence ?? report?.sources ?? [];
}

function limitationText(limitation: string | { code?: string; message?: string }): string {
  if (typeof limitation === "string") return limitation;
  return limitation.message ?? humanize(limitation.code);
}

function formatDuration(milliseconds: number | null | undefined): string {
  if (milliseconds == null) return "—";
  if (milliseconds < 1000) return `${milliseconds} ms`;
  return `${(milliseconds / 1000).toFixed(2)} s`;
}

function formatUsage(usage: TraceUsage | null | undefined): string {
  const total = totalUsageTokens(usage);
  if (typeof total !== "number") return "Tokens unavailable";
  return `${new Intl.NumberFormat("en", { notation: "compact" }).format(total)} tokens`;
}

function totalUsageTokens(usage: TraceUsage | null | undefined): number | null {
  return usage?.totalTokens ?? (
    typeof usage?.inputTokens === "number" && typeof usage.outputTokens === "number"
      ? usage.inputTokens + usage.outputTokens
      : null
  );
}

function downloadJson(filename: string, value: unknown) {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function downloadTrace(filename: string, trace: TraceEvent[]) {
  const ndjson = `${trace.map((event) => JSON.stringify(event)).join("\n")}\n`;
  const blob = new Blob([ndjson], { type: "application/x-ndjson" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function AtlasWorkbench() {
  const [query, setQuery] = useState<string>(examples[0].query);
  const [mode, setMode] = useState<RunMode>("replay");
  const [selectedExample, setSelectedExample] = useState<string | null>(examples[0].id);
  const [report, setReport] = useState<Report | null>(null);
  const [trace, setTrace] = useState<TraceEvent[]>([]);
  const [runStatus, setRunStatus] = useState<"idle" | "loading" | "running" | "complete" | "error" | "canceled">("idle");
  const [message, setMessage] = useState("Choose a verified replay or enter a live research brief.");
  const [liveConfigured, setLiveConfigured] = useState<boolean | null>(null);
  const [activeTab, setActiveTabState] = useState<ViewTab>("dossier");
  const [capturedAt, setCapturedAt] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const setActiveTab = useCallback((nextTab: ViewTab) => {
    setActiveTabState(nextTab);
    if (nextTab === "evidence") {
      requestAnimationFrame(() => document.getElementById("panel-evidence")?.focus());
    }
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
    setRunStatus("loading");
    setMessage("Loading deterministic replay…");
    try {
      const response = await fetch(`/api/examples/${encodeURIComponent(example.id)}`, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Replay unavailable (${response.status})`);
      const payload = (await response.json()) as ExamplePayload;
      if (abortRef.current !== controller || controller.signal.aborted) return;
      setReport(payload.output ?? payload.report ?? null);
      setTrace(Array.isArray(payload.trace) ? payload.trace : []);
      setCapturedAt(payload.manifest?.capturedAt ?? null);
      setRunStatus("complete");
      setMessage("Deterministic replay loaded. No external or live research requests were made.");
    } catch (error) {
      if (controller.signal.aborted || abortRef.current !== controller) return;
      setReport(null);
      setTrace([]);
      setRunStatus("error");
      setMessage(error instanceof Error ? error.message : "Replay unavailable");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, []);

  useEffect(() => {
    void fetch("/api/health", { headers: { accept: "application/json" } })
      .then(async (response) => response.ok ? (await response.json()) as { liveConfigured?: boolean } : null)
      .then((health) => setLiveConfigured(health?.liveConfigured ?? false))
      .catch(() => setLiveConfigured(false));
  }, []);

  const currentPhase = useMemo(() => {
    const phase = [...trace].reverse().find((event) => event.phase)?.phase;
    if (phase) return phase;
    if (runStatus === "running") return "intake";
    return report ? "report" : null;
  }, [report, runStatus, trace]);

  const candidate = selectedCandidate(report);
  const candidates = reportCandidates(report);
  const candidateId = candidate?.id ?? candidate?.candidateId;
  const evidence = reportEvidence(report).filter((item) => !candidateId || item.candidateId === candidateId);
  const findings = (report?.findings ?? []).filter((item) => !candidateId || item.candidateId === candidateId);
  const limitations = report?.limitations ?? [];
  const reportStatus = report?.run?.status ?? report?.status ?? runStatus;
  const reportMode = report?.run?.mode ?? report?.mode ?? mode;
  const elapsed = report?.usage?.elapsedMs ?? report?.telemetry?.elapsedMs ?? traceDuration(trace.at(-1));
  const terminalUsage = traceUsage([...trace].reverse().find((event) => eventType(event).includes("terminal")));
  const usage = terminalUsage ?? report?.usage ?? report?.telemetry?.usage ?? traceUsage([...trace].reverse().find((event) => traceUsage(event)));
  const margin = report?.identity?.runnerUpMargin ?? report?.identity?.margin ?? report?.candidateMargin;
  const identityStatus = report?.identity?.status ?? candidate?.status ?? "unresolved";

  const startResearch = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) {
      setMessage("Enter a person, work email, role, or professional description.");
      return;
    }
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setReport(null);
    setTrace([]);
    setCapturedAt(null);
    setRunStatus("running");
    setMessage(mode === "live" ? "Live public-source research started." : "Replaying captured research decisions.");
    setActiveTab("trace");
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
          const streamed = JSON.parse(line) as TraceEvent & { report?: Report; result?: { report?: Report }; payload?: Record<string, unknown> & { report?: Report } };
          setTrace((current) => [...current, streamed]);
          const terminalReport = streamed.report ?? streamed.result?.report ?? streamed.payload?.report ?? streamed.attributes?.report as Report | undefined;
          if (terminalReport) setReport(terminalReport);
          if (eventType(streamed).includes("terminal")) {
            terminalStatus = terminalReport?.status ?? streamed.status;
            setRunStatus(
              terminalStatus === "canceled"
                ? "canceled"
                : ["failed", "configuration_error", "blocked"].includes(terminalStatus ?? "")
                  ? "error"
                  : "complete",
            );
            setActiveTab("dossier");
          }
        }
        if (done) break;
      }
      if (abortRef.current !== controller || controller.signal.aborted) return;
      setRunStatus((current) => current === "running" ? "complete" : current);
      setMessage(
        terminalStatus === "configuration_error"
          ? "Live mode is not configured on this server. Deterministic replays remain available."
          : terminalStatus === "blocked"
            ? "Request refused by the public-professional safety policy."
          : terminalStatus === "failed"
              ? "The run failed safely. Review the terminal trace and limitations."
              : terminalStatus === "canceled"
                ? "The run was canceled. The partial trace remains available."
                : terminalStatus === "partial"
                  ? "The run stopped with a partial report. Review its coverage gaps and limitations."
                  : terminalStatus === "ambiguous"
                    ? "Identity remained ambiguous; candidates were kept separate."
              : mode === "live"
                ? "Live run complete. Review evidence before relying on findings."
                : "Replay complete. Output is byte-stable and offline.",
      );
    } catch (error) {
      if (abortRef.current !== controller) return;
      if (controller.signal.aborted) {
        setRunStatus("canceled");
        setMessage("Run canceled. The partial trace remains available.");
      } else {
        setRunStatus("error");
        setMessage(error instanceof Error ? error.message : "Research failed");
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const setRunMode = (nextMode: RunMode) => {
    if (nextMode === mode) return;
    abortRef.current?.abort();
    abortRef.current = null;
    setMode(nextMode);
    setRunStatus("idle");
    setReport(null);
    setTrace([]);
    setCapturedAt(null);
    setActiveTab("dossier");
    if (nextMode === "live") {
      setSelectedExample(null);
      setMessage(liveConfigured ? "Live mode uses OpenRouter and public OSINT tools." : "Live mode is disabled or missing server configuration. Replays remain available.");
    } else {
      setSelectedExample(null);
      setMessage("Replay mode ready. Choose a verified replay example.");
    }
  };

  const focusEvidence = () => {
    setActiveTab("evidence");
  };

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % viewTabs.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + viewTabs.length) % viewTabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = viewTabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTab = viewTabs[nextIndex];
    setActiveTab(nextTab);
    requestAnimationFrame(() => document.getElementById(`tab-${nextTab}`)?.focus());
  };

  return (
    <div className="app-shell workbench-shell">
      <a className="skip-link" href="#main-content">Skip to investigation</a>
      <header className="site-header">
        <a className="wordmark" href="#research-brief" aria-label="Atlas home"><span className="wordmark-mark" aria-hidden="true"><span>64</span></span><span className="wordmark-copy"><strong>ATLAS</strong><small>People intelligence</small></span></a>
        <nav className="header-nav" aria-label="Primary navigation"><a className="nav-link is-current" href="#research-brief">Research</a><button className="nav-link" type="button" aria-controls="panel-evidence" onClick={focusEvidence}>Evidence <span>{evidence.length}</span></button></nav>
        <div className="node-status" role="status" aria-live="polite"><span className={`node-dot ${runStatus === "running" ? "is-active" : ""}`} aria-hidden="true" /><span>{runStatus === "running" ? "Agent " : "Research node "}<strong>{runStatus === "running" ? "running" : "ready"}</strong></span></div>
      </header>

      <main id="main-content" className="workbench-main">
        <section className="research-brief" id="research-brief" aria-labelledby="brief-heading">
          <div className="brief-heading-group"><p className="eyebrow">Auditable public-source research</p><h1 id="brief-heading">Investigate a person, not just a name.</h1></div>
          <form className="research-form" onSubmit={startResearch}>
            <label htmlFor="target">Research brief</label>
            <div className="input-frame">
              <span className="input-prefix" aria-hidden="true">→</span>
              <input id="target" name="target" type="search" value={query} onChange={(event) => { setQuery(event.target.value); if (event.target.value !== examples.find((item) => item.id === selectedExample)?.query) setSelectedExample(null); }} placeholder="Name, work email, role, or professional clue" autoComplete="off" spellCheck="false" aria-describedby="target-help" />
              {runStatus === "running" ? <button className="stop-button" type="button" onClick={() => abortRef.current?.abort()}>Stop <span aria-hidden="true">■</span></button> : <button type="submit">Investigate <span aria-hidden="true">↗</span></button>}
            </div>
            <div className="form-toolbar" id="target-help"><div className="mode-switch" role="group" aria-label="Research mode"><button type="button" className={mode === "replay" ? "is-selected" : ""} aria-pressed={mode === "replay"} onClick={() => setRunMode("replay")}>Replay</button><button type="button" className={mode === "live" ? "is-selected" : ""} aria-pressed={mode === "live"} onClick={() => setRunMode("live")}>Live <span>{liveConfigured ? "ready" : "server setup"}</span></button></div><p><span aria-hidden="true">◉</span> Public professional scope only</p></div>
          </form>
          <div className="example-strip" aria-label="Verified replay examples"><span>Verified replays</span><div>{examples.map((example) => <button key={example.id} type="button" className={selectedExample === example.id ? "is-selected" : ""} aria-pressed={selectedExample === example.id} onClick={() => void loadExample(example.id)}><span aria-hidden="true">{example.id === "linus-codegraph" ? "@" : example.id === "chris-anderson-ted" ? "≠" : "?"}</span>{example.label}</button>)}</div></div>
        </section>

        <div className="run-banner" role="status" aria-live="polite"><div><span className={`status-symbol status-${runStatus}`} aria-hidden="true" /><strong>{reportMode === "replay" ? "Replay" : "Live"} · {humanize(reportStatus)}</strong><span>{message}</span></div><div className="run-provenance">{capturedAt ? <span>Captured {capturedAt.slice(0, 10)}</span> : null}<span>{formatDuration(elapsed)}</span><span>{formatUsage(usage)}</span></div></div>

        <div className="view-tabs" role="group" aria-label="Focus an investigation view">{viewTabs.map((tab, index) => <button id={`tab-${tab}`} key={tab} type="button" aria-pressed={activeTab === tab} aria-controls={`panel-${tab}`} className={activeTab === tab ? "is-selected" : ""} onClick={() => setActiveTab(tab)} onKeyDown={(event) => handleTabKeyDown(event, index)}>{humanize(tab)}<span>{tab === "evidence" ? evidence.length : tab === "trace" ? trace.length : findings.length}</span></button>)}</div>

        <section className="workbench-grid" data-active-tab={activeTab} aria-label="Investigation result">
          <div className={`dossier-panel view-panel ${activeTab === "dossier" ? "is-mobile-active" : ""}`} id="panel-dossier" role="region" aria-labelledby="tab-dossier">
            <header className="panel-header dossier-header"><div><p className="panel-kicker"><span className="live-pip" aria-hidden="true" /> Identity gate</p><h2>{candidate ? identityStatus === "resolved" ? "Candidate resolved with explicit boundaries" : identityStatus === "ambiguous" ? "Identity remains ambiguous" : "Leading candidate remains unresolved" : runStatus === "running" ? "Separating identity candidates" : "No research result loaded"}</h2></div><div className="case-number"><span>Run</span>{report?.run?.id?.slice(-8) ?? report?.runId?.slice(-8) ?? "—"}</div></header>
            <div className="phase-track" aria-label="Agent phases">{phaseOrder.map((phase) => { const phaseIndex = phaseOrder.indexOf(phase); const currentIndex = currentPhase ? phaseOrder.indexOf(currentPhase) : -1; const state = currentIndex > phaseIndex ? "complete" : currentIndex === phaseIndex ? "active" : "queued"; return <span key={phase} className={`phase-${state}`}><i aria-hidden="true" />{humanize(phase === "separate_candidates" ? "separate" : phase)}</span>; })}</div>

            {candidate ? <>
              <section className="candidate-gate" aria-labelledby="candidate-name"><div className="identity-avatar" aria-hidden="true"><span>{candidateName(candidate).split(/\s+/).map((part) => part[0]).slice(0, 2).join("")}</span><i /></div><div className="identity-main"><div className="identity-label">{identityStatus === "resolved" ? "Selected candidate" : "Leading candidate"}</div><h3 id="candidate-name">{candidateName(candidate)}</h3><p>{candidate.headline ?? candidate.affiliation ?? (identityStatus === "resolved" ? "Professional identity resolved from public sources" : "Public-source candidate retained pending stronger identity evidence")}</p><div className="identity-tags"><span>{humanize(candidate.confidenceBand ?? candidate.status ?? "calibrated")}</span>{candidateMatchedSignals(candidate).slice(0, 2).map((signal) => <span key={signal}>{humanize(signal)}</span>)}{candidateConflicts(candidate).length > 0 ? <span className="tag-conflict">Conflict noted</span> : null}</div></div><div className="confidence"><span>Runner-up margin</span><strong>{typeof margin === "number" ? margin.toFixed(2) : "—"}</strong><small>{candidates.length} candidate{candidates.length === 1 ? "" : "s"}</small></div></section>
              {candidates.length > 1 ? <div className="candidate-separation" aria-label="Candidate separation">{candidates.map((item) => { const itemId = item.id ?? item.candidateId; const selectedId = candidate.id ?? candidate.candidateId; const isSelected = itemId === selectedId; const label = isSelected ? identityStatus === "resolved" ? "Selected" : "Leading" : item.status === "rejected" ? "Rejected" : item.status === "plausible" ? "Alternate" : "Separate"; return <article key={itemId ?? candidateName(item)} className={isSelected ? "is-selected" : "is-quarantined"}><span>{label}</span><strong>{candidateName(item)}</strong><p>{item.headline ?? item.affiliation ?? item.separationReason ?? "Kept separate—no strong identifier link."}</p></article>; })}</div> : null}
              <section className="findings-section" aria-labelledby="findings-heading"><div className="section-heading-row"><div><p className="note-label">Auditable output</p><h3 id="findings-heading">Findings</h3></div><span>{findings.length} claim{findings.length === 1 ? "" : "s"}</span></div><div className="finding-list">{findings.map((finding, index) => { const confidence = finding.confidenceBand ?? finding.confidence?.label ?? "unknown"; const rationale = finding.rationale ?? finding.caveats?.join(" "); return <article className="finding-card" key={finding.id ?? finding.findingId ?? `${finding.title}-${index}`}><div className="finding-index">{String(index + 1).padStart(2, "0")}</div><div><div className="finding-meta"><span>{humanize(finding.category ?? "professional")}</span><span className={`confidence-band band-${confidence}`}>{humanize(confidence)}</span></div><h4>{finding.title}</h4><p>{finding.description ?? finding.summary}</p>{rationale ? <small>{rationale}</small> : null}<button type="button" onClick={focusEvidence}>{finding.evidenceIds?.length ?? 0} evidence record{(finding.evidenceIds?.length ?? 0) === 1 ? "" : "s"} <span aria-hidden="true">→</span></button></div></article>; })}{findings.length === 0 ? <p className="empty-state">Findings appear only after the identity gate and evidence-admission checks pass.</p> : null}</div></section>
              <ShowcaseCard evidence={evidence} query={reportQuery(report)} />
              {limitations.length > 0 ? <section className="limitations-card" aria-labelledby="limitations-heading"><p className="note-label">Boundaries</p><h3 id="limitations-heading">What this report does not establish</h3><ul>{limitations.map((limitation, index) => <li key={`${limitationText(limitation)}-${index}`}>{limitationText(limitation)}</li>)}</ul></section> : null}
            </> : <div className="dossier-empty"><div className="empty-orbit" aria-hidden="true"><span>@</span></div><h3>{runStatus === "running" ? "Evidence graph is forming" : "Start from a verified replay"}</h3><p>{runStatus === "running" ? "Atlas is keeping candidates separate while direct sources are fetched." : "The three examples exercise exact-email codegraph, same-name quarantine, and role-only resolution."}</p></div>}
            {report ? <footer className="report-actions"><p>This report is for public professional research, not adverse or high-impact decisions.</p><div><button type="button" onClick={() => downloadJson(`atlas-${report.run?.id ?? report.runId ?? "report"}.json`, report)}>JSON <span aria-hidden="true">↓</span></button><button type="button" onClick={() => downloadTrace(`atlas-${report.run?.id ?? report.runId ?? "trace"}.ndjson`, trace)}>Trace <span aria-hidden="true">↓</span></button></div></footer> : null}
          </div>
          <EvidencePanel evidence={evidence} active={activeTab === "evidence"} />
          <TracePanel trace={trace} active={activeTab === "trace"} />
        </section>
      </main>
    </div>
  );
}

function ShowcaseCard({ evidence, query }: { evidence: Evidence[]; query: string }) {
  const commit = evidence.find((item) => ["github_commit", "code_commit"].some((type) => evidenceType(item).includes(type)));
  const snapshots = evidence.filter((item) => ["wayback", "web_archive"].some((type) => evidenceType(item).includes(type)));
  if (commit) {
    const attributes = evidenceAttributes(commit);
    const sha = String(attributes.sha ?? commit.contentHash ?? "immutable SHA").slice(0, 12);
    const repository = String(attributes.repository ?? commit.source?.publisher ?? commit.publisher ?? "public repository");
    const login = String(attributes.login ?? attributes.githubAccount ?? "linked account");
    return <section className="showcase-card codegraph-card" aria-labelledby="showcase-heading"><div className="showcase-copy"><p className="note-label">Showcase OSINT · GitHub codegraph</p><h3 id="showcase-heading">Exact email → immutable commit → linked account</h3><p>Atlas used the exact user-supplied email. Git metadata is treated as spoofable and cannot establish identity by itself.</p></div><div className="codegraph" aria-label={`Codegraph connects ${query} to ${repository} and ${login}`}><span className="graph-node"><small>Exact input</small><strong>{query}</strong></span><i aria-hidden="true">→</i><span className="graph-node"><small>Commit</small><strong>{sha}</strong></span><i aria-hidden="true">→</i><span className="graph-node"><small>Repository / account</small><strong>{repository} · @{login}</strong></span></div></section>;
  }
  if (snapshots.length >= 2) return <section className="showcase-card history-card" aria-labelledby="showcase-heading"><div className="showcase-copy"><p className="note-label">Temporal corroboration · Wayback</p><h3 id="showcase-heading">Then / now profile history</h3><p>Only candidate-linked profile URLs were compared; archived pages never introduced a new identity.</p></div><div className="history-pair">{snapshots.slice(0, 2).map((snapshot, index) => <article key={snapshot.id ?? snapshot.evidenceId ?? index}><span>{index === 0 ? "Then" : "Now"}</span><strong>{snapshot.observedAt?.slice(0, 10) ?? snapshot.source?.publishedAt?.slice(0, 10) ?? "Archived"}</strong><p>{snapshot.excerpt ?? snapshot.minimalExcerpt ?? snapshot.claim}</p></article>)}</div></section>;
  return null;
}

function EvidencePanel({ evidence, active }: { evidence: Evidence[]; active: boolean }) {
  return <aside className={`evidence-panel view-panel ${active ? "is-mobile-active" : ""}`} id="panel-evidence" role="region" aria-labelledby="tab-evidence" tabIndex={-1}><header><div><p className="panel-kicker">Provenance ledger</p><h2>Evidence</h2></div><span>{evidence.length} admitted</span></header><p className="evidence-intro">Selected-candidate records only: exact source excerpts or canonical API claims, plus retrieval context and verification method—never full fetched bodies.</p><div className="evidence-list" id="evidence-panel">{evidence.map((item, index) => { const id = item.id ?? item.evidenceId ?? `evidence-${index + 1}`; const href = item.source?.canonicalUrl ?? item.source?.url ?? item.sourceUrl ?? item.url; const attributes = evidenceAttributes(item); const title = item.source?.title ?? item.title ?? item.source?.publisher ?? item.publisher ?? humanize(evidenceType(item)); const family = item.source?.sourceFamily ?? item.sourceFamily ?? item.source?.publisher ?? item.publisher ?? "Public source"; const observed = item.observedAt ?? item.retrievedAt ?? item.source?.accessedAt; const hash = item.contentHash ?? (typeof attributes.contentHash === "string" ? attributes.contentHash : undefined); const excerpt = item.excerpt ?? item.minimalExcerpt; return <details className="evidence-record" key={id} open={index === 0}><summary><span className="evidence-number">E{String(index + 1).padStart(2, "0")}</span><span><strong>{title}</strong><small>{family}</small></span><span className={`evidence-badge ${item.spoofable ? "is-spoofable" : ""}`}>{item.spoofable ? "Spoofable" : humanize(item.status ?? "Admitted")}</span></summary><div className="evidence-body">{excerpt ? <blockquote>{excerpt}</blockquote> : <div className="canonical-claim"><span>Canonical API claim</span><p>{item.claim ?? "No canonical claim retained."}</p></div>}<dl><div><dt>Verification</dt><dd>{humanize(item.verificationMethod ?? (typeof attributes.verificationMethod === "string" ? attributes.verificationMethod : undefined))}</dd></div><div><dt>Observed</dt><dd>{observed?.slice(0, 10) ?? "Unavailable"}</dd></div><div><dt>Temporal</dt><dd>{humanize(item.temporalStatus ?? (typeof attributes.temporalStatus === "string" ? attributes.temporalStatus : undefined))}</dd></div><div><dt>Hash</dt><dd>{hash?.slice(0, 16) ?? "Unavailable"}</dd></div></dl>{href ? <a href={href} target="_blank" rel="noreferrer">Open source <span aria-hidden="true">↗</span></a> : null}</div></details>; })}{evidence.length === 0 ? <p className="empty-state">No evidence has been admitted for the leading candidate yet. Search snippets never appear here as final claim support.</p> : null}</div></aside>;
}

function TracePanel({ trace, active }: { trace: TraceEvent[]; active: boolean }) {
  const latest = trace.at(-1);
  return <aside className={`trace-panel dynamic-trace view-panel ${active ? "is-mobile-active" : ""}`} id="panel-trace" role="region" aria-labelledby="tab-trace"><header className="trace-header"><div><p className="panel-kicker">Append-only execution</p><h2>Trace</h2></div><div className="elapsed"><span>Elapsed</span><strong>{formatDuration(traceDuration(latest))}</strong></div></header><div className="trace-command" aria-label="Trace privacy rule"><span className="command-prompt" aria-hidden="true">$</span><code>decisions, counts, calls · no hidden chain-of-thought</code><span className="command-cursor" aria-hidden="true" /></div><ol className="trace-events">{trace.map((item, index) => { const type = eventType(item); const status = item.status ?? (item.kind === "span_end" || type.includes("complete") || type.includes("terminal") ? "complete" : item.kind === "span_start" || type.includes("start") ? "active" : "recorded"); const attributes = item.payload ?? item.attributes; const summary = item.decisionSummary ?? (typeof attributes?.decisionSummary === "string" ? attributes.decisionSummary : undefined) ?? (typeof attributes?.summary === "string" ? attributes.summary : undefined) ?? (item.tool ? `Tool: ${item.tool}` : humanize(type)); const eventUsage = traceUsage(item); const sequence = item.seq ?? item.sequence ?? index + 1; const duration = traceDuration(item); const latency = eventUsage?.durationMs ?? item.metrics?.durationMs; const cached = eventUsage?.cachedInputTokens ?? eventUsage?.cachedTokens; const arguments_ = attributes?.arguments; const elapsedLabel = typeof duration === "number" ? `${formatDuration(duration)} elapsed since run start` : "Elapsed time unavailable"; return <li className={`trace-event is-${status}`} key={`${sequence}-${item.spanId ?? type}`}><div className="event-time" aria-label={elapsedLabel}>{typeof duration === "number" ? `t+${(duration / 1000).toFixed(2)}s` : "—"}</div><div className="event-rail" aria-hidden="true"><span>{sequence}</span></div><div className="event-content"><div className="event-title-row"><h3>{humanize(type)}</h3><span>{item.attempt && item.attempt > 1 ? `try ${item.attempt}` : humanize(item.phase)}</span></div><p>{summary}</p>{arguments_ && typeof arguments_ === "object" ? <details className="trace-arguments"><summary>Sanitized arguments</summary><code>{JSON.stringify(arguments_)}</code></details> : null}{eventUsage ? <small>{formatUsage(eventUsage)}{typeof cached === "number" ? ` · ${cached} cached` : ""}{typeof latency === "number" ? ` · ${formatDuration(latency)} latency` : ""}{typeof eventUsage.reasoningTokens === "number" ? ` · ${eventUsage.reasoningTokens} reasoning` : typeof eventUsage.thinkingTokens === "number" ? ` · ${eventUsage.thinkingTokens} reasoning` : " · reasoning unavailable"}</small> : null}</div></li>; })}</ol>{trace.length === 0 ? <div className="trace-empty"><span aria-hidden="true">⌁</span><p>Tool calls, gates, retries, token counts, and terminal state will stream here.</p></div> : null}<footer className="trace-footer"><dl><div><dt>Events</dt><dd>{trace.length}</dd></div><div><dt>Retries</dt><dd>{trace.filter((item) => (item.attempt ?? 1) > 1).length}</dd></div><div><dt>Tokens</dt><dd>{totalUsageTokens(traceUsage(latest)) ?? "—"}</dd></div></dl><p><span aria-hidden="true">i</span> Started spans must close exactly once</p></footer></aside>;
}

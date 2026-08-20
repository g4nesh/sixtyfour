import { useEffect, useRef } from "react";
import type { Report, TraceEvent } from "../atlas-types";
import { candidateName, humanize, limitationText, reportCandidates, reportEvidence, reportQuery } from "../atlas-types";
import { CloseIcon, DownloadIcon, ExternalIcon } from "./atlas-icons";

function candidateScore(candidate: ReturnType<typeof reportCandidates>[number]): number | undefined {
  return typeof candidate.score === "number" ? candidate.score : candidate.score?.total;
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
  const body = `${trace.map((event) => JSON.stringify(event)).join("\n")}\n`;
  const url = URL.createObjectURL(new Blob([body], { type: "application/x-ndjson" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function ReportSheet({
  report,
  trace,
  open,
  onClose,
  onDownloadMarkdown,
  onDownloadPdf,
}: {
  report: Report | null;
  trace: TraceEvent[];
  open: boolean;
  onClose: () => void;
  onDownloadMarkdown?: (report: Report) => void | Promise<void>;
  onDownloadPdf?: (report: Report) => void | Promise<void>;
}) {
  const sheetRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => sheetRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, open]);

  if (!open) return null;
  const candidates = reportCandidates(report);
  const evidence = reportEvidence(report);
  const findings = report?.findings ?? [];
  const reportId = report?.runId ?? report?.run?.id ?? "atlas-report";

  const evidenceUrl = (item: (typeof evidence)[number]): string | undefined =>
    item.canonicalUrl ?? item.sourceUrl ?? item.url ?? item.source?.canonicalUrl ?? item.source?.url;
  const domainOf = (url: string, fallback: string): string => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return fallback;
    }
  };
  const evidenceById = new Map(evidence.map((item) => [item.id ?? item.evidenceId, item] as const));
  const findingSources = (finding: (typeof findings)[number]) =>
    ((finding.evidenceIds as string[] | undefined) ?? [])
      .map((id) => evidenceById.get(id))
      .filter((item): item is (typeof evidence)[number] => Boolean(item))
      .map((item) => {
        const url = evidenceUrl(item);
        return url ? { url, domain: domainOf(url, item.sourceFamily ?? item.publisher ?? "source") } : null;
      })
      .filter((source): source is { url: string; domain: string } => Boolean(source));
  return (
    <div className="report-sheet-backdrop">
      <button
        className="report-backdrop-dismiss"
        type="button"
        onClick={onClose}
        aria-label="Close intelligence report"
        tabIndex={-1}
      />
      <section
        className="report-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="report-sheet-heading"
        tabIndex={-1}
        ref={sheetRef}
      >
        <header className="report-sheet-header">
          <div>
            <span>Intelligence report</span>
            <h2 id="report-sheet-heading">{report ? reportQuery(report) : "No completed report"}</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close report">
            <CloseIcon />
          </button>
        </header>
        <div className="report-export-bar" aria-label="Report downloads">
          <button type="button" disabled={!report} onClick={() => report && downloadJson(`${reportId}.json`, report)}>
            <DownloadIcon /> JSON
          </button>
          <button
            type="button"
            disabled={trace.length === 0}
            onClick={() => downloadTrace(`${reportId}.trace.ndjson`, trace)}
          >
            <DownloadIcon /> Trace
          </button>
          <button
            type="button"
            disabled={!report || !onDownloadMarkdown}
            onClick={() => report && void onDownloadMarkdown?.(report)}
            title={onDownloadMarkdown ? "Download clean Markdown" : "Markdown export is unavailable for this build"}
          >
            <DownloadIcon /> Markdown
          </button>
          <button
            type="button"
            className="is-primary"
            disabled={!report || !onDownloadPdf}
            onClick={() => report && void onDownloadPdf?.(report)}
            title={onDownloadPdf ? "Download rendered PDF" : "PDF export is unavailable for this build"}
          >
            <DownloadIcon /> PDF
          </button>
        </div>
        {report ? (
          <div className="report-sheet-body">
            <section className="report-lede">
              <span className={`report-status status-${report.status ?? "unknown"}`}>{humanize(report.status)}</span>
              <p>
                {report.input?.objective ??
                  "Auditable public-professional intelligence assembled from admitted evidence."}
              </p>
            </section>
            <section className="report-section" aria-labelledby="report-candidates-heading">
              <div className="report-section-heading">
                <h3 id="report-candidates-heading">Identity branches</h3>
                <span>{candidates.length}</span>
              </div>
              <div className="candidate-report-grid">
                {candidates.map((candidate) => {
                  const id = candidate.id ?? candidate.candidateId ?? candidateName(candidate);
                  const score = candidateScore(candidate);
                  return (
                    <article key={id} className={`candidate-report-card status-${candidate.status ?? "unknown"}`}>
                      <header>
                        <span>{humanize(candidate.status)}</span>
                        {typeof score === "number" ? <strong>{Math.round(score * 100)}%</strong> : null}
                      </header>
                      <h4>{candidateName(candidate)}</h4>
                      <p>
                        {candidate.headline ??
                          candidate.affiliation ??
                          candidate.separationReason ??
                          "Candidate kept as a distinct graph branch."}
                      </p>
                      <code>{id}</code>
                    </article>
                  );
                })}
              </div>
            </section>
            <section className="report-section" aria-labelledby="report-findings-heading">
              <div className="report-section-heading">
                <h3 id="report-findings-heading">Findings</h3>
                <span>{findings.length}</span>
              </div>
              <div className="report-findings">
                {findings.map((finding, index) => {
                  const sources = findingSources(finding);
                  return (
                    <article key={finding.id ?? finding.findingId ?? index}>
                      <header>
                        <span>{humanize(finding.category)}</span>
                        <strong>{humanize(finding.confidence?.label ?? finding.confidenceBand)}</strong>
                      </header>
                      <h4>{finding.title}</h4>
                      <p>{finding.description ?? finding.summary ?? finding.rationale}</p>
                      <footer className="finding-sources">
                        {sources.length > 0 ? (
                          <>
                            <span className="sources-label">Sources:</span>
                            {sources.map((source, sourceIndex) => (
                              <a
                                key={`${source.url}-${sourceIndex}`}
                                href={source.url}
                                target="_blank"
                                rel="noreferrer"
                                className="source-cite"
                              >
                                <ExternalIcon />
                                {source.domain}
                              </a>
                            ))}
                          </>
                        ) : (
                          <span className="sources-label">No cited source</span>
                        )}
                        {finding.counterEvidenceIds?.length ? (
                          <span className="counter-count">{finding.counterEvidenceIds.length} counter</span>
                        ) : null}
                      </footer>
                    </article>
                  );
                })}
              </div>
            </section>
            <section className="report-section" aria-labelledby="report-evidence-heading">
              <div className="report-section-heading">
                <h3 id="report-evidence-heading">Evidence ledger</h3>
                <span>{evidence.length}</span>
              </div>
              <ol className="report-evidence-list">
                {evidence.map((item, index) => {
                  const href = evidenceUrl(item);
                  return (
                    <li key={item.id ?? item.evidenceId ?? index}>
                      <span>E{String(index + 1).padStart(2, "0")}</span>
                      <div>
                        <small>
                          {item.sourceFamily ?? item.publisher ?? item.source?.sourceFamily ?? "Public source"} ·{" "}
                          {humanize(item.verificationMethod)}
                        </small>
                        <strong>{item.title ?? item.source?.title ?? item.claim ?? "Evidence record"}</strong>
                        <p>{item.excerpt ?? item.minimalExcerpt ?? item.claim}</p>
                        {href ? (
                          <a className="evidence-source-link" href={href} target="_blank" rel="noreferrer">
                            <ExternalIcon />
                            {domainOf(href, "source")}
                          </a>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>
            {(report.limitations?.length ?? 0) > 0 ? (
              <section className="report-section report-limitations" aria-labelledby="report-limitations-heading">
                <div className="report-section-heading">
                  <h3 id="report-limitations-heading">Limits</h3>
                  <span>{report.limitations?.length}</span>
                </div>
                <ul>
                  {report.limitations?.map((limitation, index) => (
                    <li key={index}>{limitationText(limitation)}</li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        ) : (
          <div className="report-empty">
            <span aria-hidden="true">□</span>
            <h3>No report loaded</h3>
            <p>Run a verified replay or live investigation before exporting.</p>
          </div>
        )}
      </section>
    </div>
  );
}

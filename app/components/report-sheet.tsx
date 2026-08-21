import { useEffect, useRef } from "react";
import {
  isPassivePageMetadataObservation,
  projectPageFootprint,
  projectTemporalComparison,
} from "../../lib/report-export/evidence-context";
import type { Report, TraceEvent } from "../atlas-types";
import {
  candidateName,
  humanize,
  limitationText,
  reportCandidates,
  reportEvidence,
  reportQuery,
  traceDiagnostics,
} from "../atlas-types";
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

function FootprintContext({ footprint }: { footprint: NonNullable<ReturnType<typeof projectPageFootprint>> }) {
  return (
    <aside className="evidence-context evidence-footprint">
      <header>
        <b>Page-declared footprint</b>
        <span>{footprint.bounded ? "bounded projection" : "projection not truncated"}</span>
      </header>
      <p>
        <b>Projection hash</b> <code>{footprint.footprintHash}</code>
      </p>
      <dl>
        {footprint.title ? (
          <div>
            <dt>Page title</dt>
            <dd>{footprint.title}</dd>
          </div>
        ) : null}
        {footprint.description ? (
          <div>
            <dt>Description</dt>
            <dd>{footprint.description}</dd>
          </div>
        ) : null}
        {footprint.canonicalStatus ? (
          <div>
            <dt>Canonical status</dt>
            <dd>{humanize(footprint.canonicalStatus)}</dd>
          </div>
        ) : null}
        {footprint.canonicalUrl ? (
          <div>
            <dt>Canonical URL</dt>
            <dd>
              <a href={footprint.canonicalUrl} target="_blank" rel="noreferrer">
                {footprint.canonicalUrl}
              </a>
            </dd>
          </div>
        ) : null}
        {footprint.language ? (
          <div>
            <dt>Language</dt>
            <dd>{footprint.language}</dd>
          </div>
        ) : null}
        {footprint.openGraphType ? (
          <div>
            <dt>Open Graph type</dt>
            <dd>{footprint.openGraphType}</dd>
          </div>
        ) : null}
        {footprint.openGraphSiteName ? (
          <div>
            <dt>Open Graph site</dt>
            <dd>{footprint.openGraphSiteName}</dd>
          </div>
        ) : null}
        {footprint.generators.length > 0 ? (
          <div>
            <dt>Generators</dt>
            <dd>{footprint.generators.join(", ")}</dd>
          </div>
        ) : null}
        {footprint.applicationNames.length > 0 ? (
          <div>
            <dt>Applications</dt>
            <dd>{footprint.applicationNames.join(", ")}</dd>
          </div>
        ) : null}
      </dl>
      {footprint.observedProviderFamilies.length > 0 ? (
        <p>
          <b>Observed providers</b> {footprint.observedProviderFamilies.map(humanize).join(", ")}
        </p>
      ) : null}
      {footprint.observedResourceHosts.length > 0 ? (
        <p>
          <b>Referenced hosts</b> {footprint.observedResourceHosts.join(", ")}
        </p>
      ) : null}
      {footprint.jsonLdTypes.length > 0 ? (
        <p>
          <b>JSON-LD types</b> {footprint.jsonLdTypes.join(", ")}
        </p>
      ) : null}
      <p>{footprint.caveat}</p>
    </aside>
  );
}

function TemporalContext({ temporal }: { temporal: NonNullable<ReturnType<typeof projectTemporalComparison>> }) {
  const changeState = (changed: boolean) => (changed ? "Changed" : "Unchanged");
  return (
    <aside className="evidence-context evidence-temporal">
      <header>
        <b>Temporal diff</b>
        <span>{temporal.comparisonBounded ? "bounded comparison" : "observed captures"}</span>
      </header>
      <dl>
        <div>
          <dt>Observation window</dt>
          <dd>
            after {temporal.observedAfter} · on or before {temporal.observedOnOrBefore}
          </dd>
        </div>
        <div>
          <dt>Archived response body bytes</dt>
          <dd>{changeState(temporal.bodyChanged)}</dd>
        </div>
        <div>
          <dt>Normalized static-HTML text</dt>
          <dd>{changeState(temporal.visibleTextChanged)}</dd>
        </div>
        <div>
          <dt>Page-declared metadata</dt>
          <dd>{changeState(temporal.metadataChanged)}</dd>
        </div>
        <div>
          <dt>Static-HTML structure</dt>
          <dd>{changeState(temporal.structureChanged)}</dd>
        </div>
        <div>
          <dt>Static-HTML fragment counts</dt>
          <dd>
            {temporal.addedFragmentCount} added · {temporal.removedFragmentCount} removed ·{" "}
            {temporal.unchangedFragmentCount} unchanged
          </dd>
        </div>
        {temporal.changedMetadataFields.length > 0 ? (
          <div>
            <dt>Changed metadata fields</dt>
            <dd>{temporal.changedMetadataFields.map(humanize).join(", ")}</dd>
          </div>
        ) : null}
      </dl>
      {temporal.addedTextFragments.length > 0 ? (
        <div className="temporal-fragments is-added">
          <b>Added in later capture</b>
          {temporal.addedTextFragments.map((fragment, fragmentIndex) => (
            <q key={`added-${fragmentIndex}`}>{fragment}</q>
          ))}
        </div>
      ) : null}
      {temporal.removedTextFragments.length > 0 ? (
        <div className="temporal-fragments is-removed">
          <b>Removed by later capture</b>
          {temporal.removedTextFragments.map((fragment, fragmentIndex) => (
            <q key={`removed-${fragmentIndex}`}>{fragment}</q>
          ))}
        </div>
      ) : null}
      <p>{temporal.caveat}</p>
    </aside>
  );
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
  const allCandidates = reportCandidates(report);
  const evidence = reportEvidence(report);
  const findings = report?.findings ?? [];
  const selectedCandidateId = report?.identity?.selectedCandidateId ?? report?.selectedCandidateId;
  const candidates = [...allCandidates]
    .sort((left, right) => {
      const leftId = left.id ?? left.candidateId;
      const rightId = right.id ?? right.candidateId;
      if (leftId === selectedCandidateId) return -1;
      if (rightId === selectedCandidateId) return 1;
      return (
        (candidateScore(right) ?? 0) - (candidateScore(left) ?? 0) || String(leftId).localeCompare(String(rightId))
      );
    })
    .slice(0, 5);
  const candidateNameById = new Map(
    allCandidates.map((candidate) => [candidate.id ?? candidate.candidateId, candidateName(candidate)]),
  );
  const reportId = report?.runId ?? report?.run?.id ?? "atlas-report";
  const coverageDiagnostics = [
    ...new Map(
      trace
        .flatMap(traceDiagnostics)
        .filter(
          (diagnostic) => diagnostic.code.startsWith("search_provider_") || diagnostic.code.endsWith("fallback_used"),
        )
        .map((diagnostic) => [diagnostic.code, diagnostic]),
    ).values(),
  ];

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
        return url
          ? {
              url,
              domain: domainOf(url, item.sourceFamily ?? item.publisher ?? "source"),
              title: item.title ?? item.source?.title ?? item.claim ?? "Source",
            }
          : null;
      })
      .filter((source): source is { url: string; domain: string; title: string } => Boolean(source));
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
        <div className="report-export-bar" role="toolbar" aria-label="Report downloads">
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
            {coverageDiagnostics.length > 0 ? (
              <section className="report-coverage-note" aria-labelledby="report-coverage-heading">
                <h3 id="report-coverage-heading">Search coverage</h3>
                <ul>
                  {coverageDiagnostics.map((diagnostic) => (
                    <li key={diagnostic.code}>
                      <strong>{humanize(diagnostic.code)}</strong>
                      <span>{diagnostic.message}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            <section className="report-section" aria-labelledby="report-candidates-heading">
              <div className="report-section-heading">
                <h3 id="report-candidates-heading">Identity branches</h3>
                <span>{allCandidates.length}</span>
              </div>
              {allCandidates.length > 1 ? (
                <div className="candidate-ambiguity-note" role="note">
                  <strong>{allCandidates.length} distinct candidate branches retained</strong>
                  <p>
                    Atlas did not merge same-name results without strong corroborating identifiers. The five
                    highest-ranked candidate profiles are consolidated below.
                  </p>
                </div>
              ) : null}
              {candidates.length > 0 ? (
                <div className="candidate-report-grid">
                  {candidates.map((candidate) => {
                    const id = candidate.id ?? candidate.candidateId ?? candidateName(candidate);
                    const score = candidateScore(candidate);
                    const branchEvidence = evidence.filter((item) => item.candidateId === id);
                    const branchFindings = findings.filter((finding) => finding.candidateId === id);
                    const directEvidence = branchEvidence.filter(
                      (item) => item.disposition !== "discovery_only" && item.verificationMethod !== "search_discovery",
                    );
                    const branchSourceByHref = new Map<string, { href: string; title: string }>();
                    for (const item of directEvidence) {
                      const href = evidenceUrl(item);
                      if (!href || branchSourceByHref.has(href)) continue;
                      branchSourceByHref.set(href, {
                        href,
                        title: item.title ?? item.source?.title ?? item.claim ?? domainOf(href, "source"),
                      });
                    }
                    const branchSources = [...branchSourceByHref.values()].slice(0, 3);
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
                        <div className="candidate-profile-metrics">
                          <span>{directEvidence.length} direct</span>
                          <span>{branchEvidence.length} evidence</span>
                          <span>{branchFindings.length} findings</span>
                        </div>
                        {branchSources.length > 0 ? (
                          <ul className="candidate-profile-sources">
                            {branchSources.map((source) => (
                              <li key={source.href}>
                                <a href={source.href} target="_blank" rel="noreferrer">
                                  <ExternalIcon /> {source.title}
                                </a>
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <small>No directly fetched source was bound to this branch.</small>
                        )}
                        <code>{id}</code>
                      </article>
                    );
                  })}
                </div>
              ) : (
                <p className="report-section-empty">No identity branch was retained.</p>
              )}
            </section>
            <section className="report-section" aria-labelledby="report-findings-heading">
              <div className="report-section-heading">
                <h3 id="report-findings-heading">Findings</h3>
                <span>{findings.length}</span>
              </div>
              {findings.length > 0 ? (
                <div className="report-findings">
                  {findings.map((finding, index) => {
                    const sources = findingSources(finding);
                    return (
                      <article key={finding.id ?? finding.findingId ?? index}>
                        <header>
                          <span>{humanize(finding.category)}</span>
                          <strong>{humanize(finding.confidence?.label ?? finding.confidenceBand)}</strong>
                        </header>
                        <small className="finding-candidate-label">
                          Candidate: {candidateNameById.get(finding.candidateId) ?? "Unresolved candidate branch"}
                        </small>
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
                                  {source.title} — {source.domain}
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
              ) : (
                <p className="report-section-empty">No finding met the evidence and confidence rules.</p>
              )}
            </section>
            <section className="report-section" aria-labelledby="report-evidence-heading">
              <div className="report-section-heading">
                <h3 id="report-evidence-heading">Evidence ledger</h3>
                <span>{evidence.length}</span>
              </div>
              {evidence.length > 0 ? (
                <ol className="report-evidence-list">
                  {evidence.map((item, index) => {
                    const href = evidenceUrl(item);
                    const title = item.title ?? item.source?.title ?? item.claim ?? "Evidence record";
                    const discoveryOnly =
                      item.disposition === "discovery_only" || item.verificationMethod === "search_discovery";
                    const passiveMetadataObservation = isPassivePageMetadataObservation(item);
                    const footprint =
                      discoveryOnly && !passiveMetadataObservation ? null : projectPageFootprint(item.canonicalSubset);
                    const temporal = discoveryOnly ? null : projectTemporalComparison(item.canonicalSubset);
                    const discoveryLabel = passiveMetadataObservation
                      ? "Passive page metadata observation"
                      : "Unverified discovery lead";
                    const discoverySummary = passiveMetadataObservation
                      ? "Bounded page-declared metadata from an exact authorized fetch; it does not establish identity, ownership, or a finding."
                      : "Provider-attested URL metadata only; this lead does not support a finding until a hardened direct fetch succeeds.";
                    return (
                      <li
                        key={item.id ?? item.evidenceId ?? index}
                        className={discoveryOnly ? "is-discovery-lead" : undefined}
                      >
                        <span>E{String(index + 1).padStart(2, "0")}</span>
                        <div>
                          <small>
                            {item.sourceFamily ?? item.publisher ?? item.source?.sourceFamily ?? "Public source"} ·{" "}
                            {discoveryOnly ? discoveryLabel : humanize(item.verificationMethod)}
                          </small>
                          {item.candidateId ? (
                            <small className="evidence-candidate-label">
                              Candidate: {candidateNameById.get(item.candidateId) ?? item.candidateId}
                            </small>
                          ) : null}
                          <strong>{title}</strong>
                          <p>
                            {discoveryOnly ? discoverySummary : (item.excerpt ?? item.minimalExcerpt ?? item.claim)}
                          </p>
                          {temporal ? <TemporalContext temporal={temporal} /> : null}
                          {footprint ? <FootprintContext footprint={footprint} /> : null}
                          {href ? (
                            <a className="evidence-source-link" href={href} target="_blank" rel="noreferrer">
                              <ExternalIcon />
                              {title} — {domainOf(href, "source")}
                            </a>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <p className="report-section-empty">No evidence record was admitted.</p>
              )}
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
            <p>Run a live investigation before exporting.</p>
          </div>
        )}
      </section>
    </div>
  );
}

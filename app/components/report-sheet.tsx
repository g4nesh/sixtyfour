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
  isStructuredSearchTransport,
  limitationText,
  reportCandidates,
  reportEvidence,
  reportQuery,
  traceDiagnostics,
  traceSearchQueries,
  traceSearchTransportAttempts,
} from "../atlas-types";
import { CloseIcon, DownloadIcon, ExternalIcon } from "./atlas-icons";

const PROFILE_CONTEXT_SIGNAL_KINDS = new Set(["organization", "role", "location", "bio_phrase"]);

function candidateScore(candidate: ReturnType<typeof reportCandidates>[number]): number | undefined {
  return typeof candidate.score === "number" ? candidate.score : candidate.score?.total;
}

function countPhrase(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function percentScore(value: number | undefined): string {
  return typeof value === "number" ? `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%` : "unscored";
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
  const searchQueries = traceSearchQueries(trace);
  const searchTransports = traceSearchTransportAttempts(trace);
  const webSearchTransports = searchTransports.filter((transport) => !isStructuredSearchTransport(transport));
  const structuredSearchTransports = searchTransports.filter(isStructuredSearchTransport);
  const coverageDiagnostics = [
    ...new Map(
      trace
        .flatMap(traceDiagnostics)
        .filter(
          (diagnostic) =>
            diagnostic.code.startsWith("search_provider_") ||
            diagnostic.code.startsWith("google_") ||
            diagnostic.code.startsWith("duckduckgo_") ||
            diagnostic.code.startsWith("github_public_user_") ||
            diagnostic.code.startsWith("github_exact_name_") ||
            diagnostic.code.startsWith("semantic_scholar_") ||
            diagnostic.code.startsWith("crossref_") ||
            diagnostic.code === "public_web_fallback_used",
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

  const formalIdentityStatus = ["resolved", "ambiguous", "unresolved"].includes(report?.identity?.status ?? "")
    ? (report?.identity?.status as "resolved" | "ambiguous" | "unresolved")
    : selectedCandidateId
      ? "resolved"
      : report?.status === "ambiguous"
        ? "ambiguous"
        : "unresolved";
  const leadCandidate = candidates[0] ?? null;
  const leadId = leadCandidate?.id ?? leadCandidate?.candidateId;
  const leadEvidence = leadId ? evidence.filter((item) => item.candidateId === leadId) : [];
  const leadSupportingEvidence = leadEvidence.filter(
    (item) =>
      item.disposition === "supports" &&
      item.verificationMethod === "direct_fetch" &&
      item.attributes?.metadataObservation !== true,
  );
  const leadSupportingFamilies = [
    ...new Set(
      leadSupportingEvidence.map((item) => {
        const href = evidenceUrl(item);
        return item.sourceFamily ?? (href ? domainOf(href, "source") : "source");
      }),
    ),
  ].sort();
  const leadSupportingEvidenceIds = new Set(
    leadSupportingEvidence
      .map((item) => item.id ?? item.evidenceId)
      .filter((id): id is string => typeof id === "string"),
  );
  const leadMatchedSignals = [
    ...new Set(
      [
        ...(leadCandidate?.signals ?? [])
          .filter(
            (signal) =>
              typeof signal.kind === "string" &&
              PROFILE_CONTEXT_SIGNAL_KINDS.has(signal.kind) &&
              signal.assurance !== "self_asserted" &&
              Boolean(signal.sourceEvidenceId && leadSupportingEvidenceIds.has(signal.sourceEvidenceId)),
          )
          .map((signal) => signal.kind),
      ].filter((signal): signal is string => typeof signal === "string"),
    ),
  ].sort();
  const leadConflicts = [
    ...new Set(
      [
        ...(leadCandidate?.signals ?? []).filter((signal) => signal.kind === "conflict").map((signal) => signal.kind),
        ...leadEvidence.filter((item) => item.disposition === "contradicts").map(() => "conflict"),
        ...(leadCandidate?.conflicts ?? []),
      ].filter((signal): signal is string => typeof signal === "string"),
    ),
  ].sort();
  const baseLeadScore = leadCandidate ? candidateScore(leadCandidate) : undefined;
  const resolutionBasis = report?.identity?.resolutionBasis ?? "candidate_score";
  const identitySupportingFamilies =
    resolutionBasis === "context_corroboration" && (report?.identity?.resolutionSourceFamilies?.length ?? 0) > 0
      ? [...new Set(report!.identity!.resolutionSourceFamilies!)].sort()
      : leadSupportingFamilies;
  const identityContextKeys =
    resolutionBasis === "context_corroboration" && (report?.identity?.resolutionContextKeys?.length ?? 0) > 0
      ? [...new Set(report!.identity!.resolutionContextKeys!)].filter((key) => !key.startsWith("name:")).sort()
      : leadMatchedSignals;
  const identityEvidenceIds =
    resolutionBasis === "context_corroboration" && (report?.identity?.resolutionEvidenceIds?.length ?? 0) > 0
      ? new Set(report!.identity!.resolutionEvidenceIds!)
      : leadSupportingEvidenceIds;
  const identitySupportingEvidence = evidence.filter((item) => {
    const id = item.id ?? item.evidenceId;
    return typeof id === "string" && identityEvidenceIds.has(id);
  });
  const leadScore = leadCandidate
    ? leadId === selectedCandidateId && typeof report?.identity?.selectedScore === "number"
      ? Math.max(
          baseLeadScore ?? 0,
          report.identity.selectedScore,
          report.identity.resolutionScore ?? report.identity.selectedScore,
        )
      : baseLeadScore
    : undefined;
  const resolutionThreshold = report?.identity?.resolutionThreshold ?? null;
  const marginThreshold = report?.identity?.marginThreshold ?? null;
  const runnerUpMargin =
    report?.identity?.resolutionMargin ??
    report?.identity?.runnerUpMargin ??
    report?.identity?.margin ??
    report?.candidateMargin ??
    null;
  const highConfidenceMatch =
    formalIdentityStatus === "resolved" &&
    typeof leadScore === "number" &&
    typeof resolutionThreshold === "number" &&
    leadScore >= resolutionThreshold &&
    leadScore >= 0.75 &&
    identitySupportingFamilies.length >= 2 &&
    identityContextKeys.length >= 1 &&
    leadConflicts.length === 0 &&
    identitySupportingEvidence.some((item) => item.spoofable === false);
  const identityAssessmentLabel = !leadCandidate
    ? "No eligible candidate"
    : formalIdentityStatus === "resolved"
      ? highConfidenceMatch
        ? "High-confidence match"
        : "Resolved match"
      : formalIdentityStatus === "ambiguous"
        ? "Competing candidates"
        : identitySupportingFamilies.length >= 1 && identityContextKeys.length >= 1
          ? "Best-supported candidate"
          : "Leading query branch";
  const missingCorroboration: string[] = [];
  if (leadCandidate && formalIdentityStatus !== "resolved") {
    if (typeof leadScore === "number" && typeof resolutionThreshold === "number" && leadScore < resolutionThreshold) {
      missingCorroboration.push(
        `${percentScore(leadScore)} identity match score is below the ${percentScore(resolutionThreshold)} resolution threshold`,
      );
    }
    if (identitySupportingFamilies.length === 0) {
      missingCorroboration.push("no directly fetched supporting source family was admitted");
    } else if (identitySupportingFamilies.length === 1) {
      missingCorroboration.push("direct support comes from only one source family");
    }
    if (identityContextKeys.length === 0) {
      missingCorroboration.push("no directly grounded requested professional context was retained");
    }
    if (leadConflicts.length > 0) {
      missingCorroboration.push(`${countPhrase(leadConflicts.length, "conflicting identity signal")} remain`);
    }
    if (identitySupportingEvidence.length > 0 && identitySupportingEvidence.every((item) => item.spoofable === true)) {
      missingCorroboration.push("every direct supporting observation remains spoofable");
    }
    if (
      formalIdentityStatus === "ambiguous" &&
      typeof runnerUpMargin === "number" &&
      typeof marginThreshold === "number" &&
      runnerUpMargin < marginThreshold
    ) {
      missingCorroboration.push(
        `${percentScore(runnerUpMargin)} runner-up margin is below the ${percentScore(marginThreshold)} separation requirement`,
      );
    }
    if (missingCorroboration.length === 0) {
      missingCorroboration.push("the formal resolution rules were not cleared by the admitted evidence");
    }
  }
  const identityAssessmentSummary = leadCandidate
    ? `${candidateName(leadCandidate)} is the ${formalIdentityStatus === "resolved" ? "formally selected" : "highest-ranked"} branch at a ${percentScore(leadScore)} identity match score${resolutionBasis === "context_corroboration" && typeof baseLeadScore === "number" ? ` (base candidate score ${percentScore(baseLeadScore)})` : ""}, backed by ${countPhrase(identitySupportingEvidence.length, "identity-supporting direct record")} across ${countPhrase(identitySupportingFamilies.length, "identity-supporting source family", "identity-supporting source families")} and ${countPhrase(identityContextKeys.length, "grounded requested-context signal")}.`
    : "No candidate-bound direct evidence survived admission, so Atlas cannot rank an eligible profile yet.";
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
            <section
              className={`report-identity-assessment formal-${formalIdentityStatus}`}
              aria-labelledby="report-identity-assessment-heading"
            >
              <header>
                <span>Candidate assessment</span>
                <strong id="report-identity-assessment-heading">{identityAssessmentLabel}</strong>
              </header>
              {leadCandidate ? <h3>{candidateName(leadCandidate)}</h3> : null}
              <p>{identityAssessmentSummary}</p>
              <dl>
                <div>
                  <dt>Formal identity status</dt>
                  <dd>{humanize(formalIdentityStatus)}</dd>
                </div>
                <div>
                  <dt>Identity match score · {humanize(resolutionBasis)}</dt>
                  <dd>{percentScore(leadScore)}</dd>
                </div>
                <div>
                  <dt>Supporting source families</dt>
                  <dd>{leadSupportingFamilies.length}</dd>
                </div>
                <div>
                  <dt>Matched context signals</dt>
                  <dd>{leadMatchedSignals.length}</dd>
                </div>
              </dl>
              {missingCorroboration.length > 0 ? (
                <div className="identity-corroboration-gaps" role="note">
                  <b>What is still missing</b>
                  <ul>
                    {missingCorroboration.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </section>
            {coverageDiagnostics.length > 0 || searchQueries.length > 0 || searchTransports.length > 0 ? (
              <section className="report-coverage-note" aria-labelledby="report-coverage-heading">
                <h3 id="report-coverage-heading">Search coverage</h3>
                {searchTransports.length > 0 ? (
                  <div className="report-search-transports" aria-label="Search transport attempts">
                    <strong>Transport attempts</strong>
                    {webSearchTransports.length > 0 ? (
                      <section>
                        <small>Web discovery path</small>
                        <ul>
                          {webSearchTransports.map((transport) => (
                            <li key={transport.id}>
                              <span>{transport.label}</span>
                              <small>{humanize(transport.outcome)}</small>
                            </li>
                          ))}
                        </ul>
                      </section>
                    ) : null}
                    {structuredSearchTransports.length > 0 ? (
                      <section>
                        <small>Structured indexes</small>
                        <ul>
                          {structuredSearchTransports.map((transport) => (
                            <li key={transport.id}>
                              <span>{transport.label}</span>
                              <small>{humanize(transport.outcome)}</small>
                            </li>
                          ))}
                        </ul>
                      </section>
                    ) : null}
                    <p>Attempts and returned discovery leads are not cited sources until hardened fetch succeeds.</p>
                  </div>
                ) : null}
                {searchQueries.length > 0 ? (
                  <div className="report-query-program">
                    <header>
                      <strong>Queries attempted</strong>
                      <span>{searchQueries.length}</span>
                    </header>
                    <ol>
                      {searchQueries.map((query) => (
                        <li key={query}>
                          <code>{query}</code>
                        </li>
                      ))}
                    </ol>
                  </div>
                ) : null}
                {coverageDiagnostics.length > 0 ? (
                  <ul className="report-coverage-diagnostics">
                    {coverageDiagnostics.map((diagnostic) => (
                      <li key={diagnostic.code}>
                        <strong>{humanize(diagnostic.code)}</strong>
                        <span>{diagnostic.message}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
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
                    const rawScore = candidateScore(candidate);
                    const score =
                      id === selectedCandidateId && typeof report.identity?.selectedScore === "number"
                        ? Math.max(
                            rawScore ?? 0,
                            report.identity.selectedScore,
                            report.identity.resolutionScore ?? report.identity.selectedScore,
                          )
                        : id === report.identity?.runnerUpCandidateId &&
                            typeof report.identity.runnerUpScore === "number"
                          ? Math.max(rawScore ?? 0, report.identity.runnerUpScore)
                          : rawScore;
                    const branchEvidence = evidence.filter((item) => item.candidateId === id);
                    const branchFindings = findings.filter((finding) => finding.candidateId === id);
                    const directEvidence = branchEvidence.filter(
                      (item) => item.disposition !== "discovery_only" && item.verificationMethod !== "search_discovery",
                    );
                    const supportingEvidence = directEvidence.filter(
                      (item) =>
                        item.disposition === "supports" &&
                        item.verificationMethod === "direct_fetch" &&
                        item.attributes?.metadataObservation !== true,
                    );
                    const supportingFamilies = [
                      ...new Set(
                        supportingEvidence.map((item) => {
                          const href = evidenceUrl(item);
                          return item.sourceFamily ?? (href ? domainOf(href, "source") : "source");
                        }),
                      ),
                    ].sort();
                    const supportingEvidenceIds = new Set(
                      supportingEvidence
                        .map((item) => item.id ?? item.evidenceId)
                        .filter((evidenceId): evidenceId is string => typeof evidenceId === "string"),
                    );
                    const matchedContextSignals = [
                      ...new Set(
                        [
                          ...(candidate.signals ?? [])
                            .filter(
                              (signal) =>
                                typeof signal.kind === "string" &&
                                PROFILE_CONTEXT_SIGNAL_KINDS.has(signal.kind) &&
                                signal.assurance !== "self_asserted" &&
                                Boolean(signal.sourceEvidenceId && supportingEvidenceIds.has(signal.sourceEvidenceId)),
                            )
                            .map((signal) => signal.kind),
                        ].filter((signal): signal is string => typeof signal === "string"),
                      ),
                    ].sort();
                    const profileFacts = supportingEvidence
                      .filter(
                        (item, index, items) =>
                          items.findIndex(
                            (candidateItem) =>
                              (candidateItem.claim ?? candidateItem.excerpt ?? "").toLocaleLowerCase("en-US") ===
                              (item.claim ?? item.excerpt ?? "").toLocaleLowerCase("en-US"),
                          ) === index,
                      )
                      .slice(0, 3);
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
                          <span>
                            {id === leadId
                              ? formalIdentityStatus === "resolved"
                                ? "Selected candidate"
                                : identityAssessmentLabel
                              : humanize(candidate.status)}
                          </span>
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
                          <span>{supportingFamilies.length} source families</span>
                          <span>{matchedContextSignals.length} context matches</span>
                        </div>
                        {profileFacts.length > 0 ? (
                          <div className="candidate-profile-facts">
                            <b>
                              {formalIdentityStatus === "resolved"
                                ? "Cited profile facts"
                                : "Candidate-scoped cited observations"}
                            </b>
                            {formalIdentityStatus !== "resolved" ? (
                              <small>
                                These observations are bound only to this retained branch. They do not independently
                                establish that it is the queried person.
                              </small>
                            ) : null}
                            <ul>
                              {profileFacts.map((item) => {
                                const href = evidenceUrl(item);
                                const claim = item.claim ?? item.excerpt ?? "Admitted public-professional observation.";
                                return (
                                  <li key={item.id ?? item.evidenceId ?? claim}>
                                    <span>{claim}</span>
                                    {href ? (
                                      <a href={href} target="_blank" rel="noreferrer">
                                        <ExternalIcon /> {domainOf(href, item.sourceFamily ?? "source")}
                                      </a>
                                    ) : null}
                                  </li>
                                );
                              })}
                            </ul>
                          </div>
                        ) : null}
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
                        <small>
                          {branchEvidence.length} evidence records · {branchFindings.length} admitted findings · branch
                          status {humanize(candidate.status)}
                        </small>
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

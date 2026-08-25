import { markdownInline, markdownUrl, stableSlug } from "./sanitize";
import type {
  ReportBriefingObservationView,
  ReportCitedSource,
  ReportCandidateView,
  ReportEvidenceView,
  ReportFindingView,
  ReportPathView,
  ReportViewModel,
} from "./types";

function percent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function human(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function contextHuman(value: string): string {
  return human(value.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("-", " "));
}

function briefingHeadline(value: string): string {
  const suffix = " — here’s what’s publicly available.";
  if (!value.endsWith(suffix)) return markdownInline(value);
  return `${markdownInline(value.slice(0, -suffix.length))}${suffix}`;
}

function row(values: readonly (string | number)[]): string {
  return `| ${values.map((value) => markdownInline(String(value))).join(" | ")} |`;
}

function referenceLinks(refs: readonly string[]): string {
  return refs.length === 0
    ? "None"
    : refs.map((ref) => `[${markdownInline(ref)}](#${ref.toLocaleLowerCase("en-US")})`).join(", ");
}

function citedSourceLinks(sources: readonly ReportCitedSource[]): string {
  if (sources.length === 0) return "None";
  return sources
    .map((source) => {
      const target = markdownUrl(source.url);
      const label = source.title ? `${source.title} — ${source.domain}` : source.domain;
      return target ? `[${markdownInline(label)}](${target})` : markdownInline(label);
    })
    .join(", ");
}

function candidateTable(candidates: readonly ReportCandidateView[]): string[] {
  if (candidates.length === 0) return ["No alternative candidate was retained."];
  const lines = [
    row([
      "Candidate",
      "Branch status",
      "Direct evidence",
      "Supporting families",
      "Evidence",
      "Findings",
      "Matched context",
      "Conflicts",
    ]),
    row(["---", "---", "---:", "---", "---", "---", "---", "---"]),
  ];
  for (const candidate of candidates) {
    lines.push(
      row([
        candidate.name,
        human(candidate.status),
        candidate.directSourceCount,
        candidate.supportingSourceFamilies.join(", ") || "None",
        candidate.evidenceRefs.join(", ") || "None",
        candidate.findingIds.join(", ") || "None",
        candidate.matchedContextSignals.map(human).join(", ") || "None",
        candidate.conflictingSignals.map(human).join(", ") || "None",
      ]),
    );
  }
  return lines;
}

function briefingObservationLines(observation: ReportBriefingObservationView): string[] {
  const lines = [
    `- **${markdownInline(observation.heading)}.** ${markdownInline(observation.detail)}`,
    `  - Evidence: ${referenceLinks(observation.evidenceRefs)}`,
    `  - Sources: ${citedSourceLinks(observation.sources)}`,
  ];
  if (observation.caveats.length > 0) {
    lines.push(...observation.caveats.map((caveat) => `  - Caveat: ${markdownInline(caveat)}`));
  }
  return lines;
}

function findingSection(finding: ReportFindingView, index: number): string[] {
  const lines = [
    `### ${index + 1}. ${markdownInline(finding.title)}`,
    "",
    `**Category:** ${markdownInline(human(finding.category))}<br>`,
    `**Candidate:** ${markdownInline(finding.candidateName)} (${markdownInline(finding.candidateId)})<br>`,
    `**Confidence:** ${markdownInline(human(finding.confidenceLabel))} (${percent(finding.confidenceScore)})<br>`,
    `**Sources:** ${citedSourceLinks(finding.sources)}<br>`,
    `**Counter-evidence:** ${referenceLinks(finding.counterCitations)}`,
    "",
    markdownInline(finding.description),
  ];
  if (finding.caveats.length > 0) {
    lines.push("", "Caveats:", "", ...finding.caveats.map((caveat) => `- ${markdownInline(caveat)}`));
  }
  return lines;
}

function sourceLink(evidence: ReportEvidenceView): string {
  const target = markdownUrl(evidence.sourceUrl);
  if (!target) return "Unavailable";
  return `[${markdownInline(evidence.sourceUrl)}](${target})`;
}

function temporalContextSection(evidence: ReportEvidenceView): string[] {
  const temporal = evidence.temporalComparison;
  if (!temporal) return [];
  const lines = [
    "",
    "#### Temporal comparison",
    "",
    `**Observation window:** after ${markdownInline(temporal.observedAfter)}; on or before ${markdownInline(temporal.observedOnOrBefore)}  `,
    `**Comparison scope:** ${temporal.comparisonBounded ? "Bounded comparison" : "Observed captures"}  `,
    `**Archived response body bytes changed:** ${temporal.bodyChanged ? "Yes" : "No"}  `,
    `**Normalized static-HTML text changed:** ${temporal.visibleTextChanged ? "Yes" : "No"}  `,
    `**Page-declared metadata changed:** ${temporal.metadataChanged ? "Yes" : "No"}  `,
    `**Static-HTML structure changed:** ${temporal.structureChanged ? "Yes" : "No"}  `,
    `**Changed metadata fields:** ${markdownInline(temporal.changedMetadataFields.map(contextHuman).join(", ") || "None observed")}  `,
    `**Static-HTML fragment counts:** ${temporal.addedFragmentCount} added; ${temporal.removedFragmentCount} removed; ${temporal.unchangedFragmentCount} unchanged`,
  ];
  if (temporal.addedTextFragments.length > 0) {
    lines.push(
      "",
      "**Added in the later capture:**",
      "",
      ...temporal.addedTextFragments.map((fragment) => `- ${markdownInline(fragment)}`),
    );
  }
  if (temporal.removedTextFragments.length > 0) {
    lines.push(
      "",
      "**Removed by the later capture:**",
      "",
      ...temporal.removedTextFragments.map((fragment) => `- ${markdownInline(fragment)}`),
    );
  }
  lines.push("", `**Caveat:** ${markdownInline(temporal.caveat)}`);
  return lines;
}

function pageFootprintSection(evidence: ReportEvidenceView): string[] {
  const footprint = evidence.pageFootprint;
  if (!footprint) return [];
  const canonicalTarget = footprint.canonicalUrl ? markdownUrl(footprint.canonicalUrl) : "";
  const canonicalValue =
    footprint.canonicalUrl && canonicalTarget
      ? `[${markdownInline(footprint.canonicalUrl)}](${canonicalTarget})`
      : "Not retained";
  return [
    "",
    "#### Page-declared footprint",
    "",
    `**Footprint projection hash:** ${markdownInline(footprint.footprintHash)}  `,
    `**Page title:** ${markdownInline(footprint.title ?? "Not observed")}  `,
    `**Description:** ${markdownInline(footprint.description ?? "Not observed")}  `,
    `**Canonical status:** ${markdownInline(footprint.canonicalStatus ? contextHuman(footprint.canonicalStatus) : "Not retained")}  `,
    `**Canonical URL:** ${canonicalValue}  `,
    `**Language:** ${markdownInline(footprint.language ?? "Not observed")}  `,
    `**Open Graph type:** ${markdownInline(footprint.openGraphType ?? "Not observed")}  `,
    `**Open Graph site name:** ${markdownInline(footprint.openGraphSiteName ?? "Not observed")}  `,
    `**Declared generators:** ${markdownInline(footprint.generators.join(", ") || "None observed")}  `,
    `**Declared applications:** ${markdownInline(footprint.applicationNames.join(", ") || "None observed")}  `,
    `**Observed provider families:** ${markdownInline(footprint.observedProviderFamilies.map(contextHuman).join(", ") || "None observed")}  `,
    `**Referenced resource hosts:** ${markdownInline(footprint.observedResourceHosts.join(", ") || "None observed")}  `,
    `**JSON-LD types:** ${markdownInline(footprint.jsonLdTypes.join(", ") || "None observed")}  `,
    `**Projection scope:** ${footprint.bounded ? "Bounded projection" : "Projection not truncated by configured extraction limits"}`,
    "",
    `**Caveat:** ${markdownInline(footprint.caveat)}`,
  ];
}

function evidenceSection(evidence: ReportEvidenceView): string[] {
  const heading = evidence.title ?? evidence.sourceFamily;
  const lines = [
    `<a id="${evidence.ref.toLocaleLowerCase("en-US")}"></a>`,
    `### ${markdownInline(evidence.ref)} - ${markdownInline(heading)}`,
    "",
    row(["Field", "Value"]),
    row(["---", "---"]),
    row(["Evidence ID", evidence.id]),
    row(["Content basis", evidence.contentLabel]),
    row(["Disposition", human(evidence.disposition)]),
    row(["Verification", human(evidence.verificationMethod)]),
    row(["Source", `${evidence.sourceFamily} / ${human(evidence.sourceType)}`]),
    row(["Source tier", `${evidence.sourceTier} - ${evidence.sourceTierLabel}`]),
    row(["Temporal status", human(evidence.temporalStatus)]),
    row(["Observed", evidence.observedAt ?? "Not supplied"]),
    row(["Retrieved", evidence.retrievedAt]),
    row(["Content hash", evidence.contentHash ?? "Not supplied"]),
    row(["Reliability", percent(evidence.reliability)]),
    row(["Spoofable", evidence.spoofable ? "Yes - confidence capped" : "No"]),
    "",
    `**Source URL:** ${sourceLink(evidence)}`,
    "",
    `**Admitted claim:** ${markdownInline(evidence.claim)}`,
  ];
  if (evidence.exactExcerpt !== null) {
    const excerpt = evidence.exactExcerpt.split("\n");
    const heading =
      evidence.contentLabel === "Normalized archived text"
        ? "**Normalized archived text:**"
        : "**Exact source excerpt:**";
    lines.push("", heading, "", ...excerpt.map((line) => `> ${markdownInline(line)}`));
  } else if (evidence.contentLabel === "Structured API claim") {
    lines.push(
      "",
      "**Structured API claim:** The admitted claim above is the human-readable projection of a canonical API subset; no raw provider payload is embedded in this export.",
    );
  }
  lines.push(...temporalContextSection(evidence), ...pageFootprintSection(evidence));
  return lines;
}

function pathLine(path: ReportPathView): string {
  const cost = path.cost === null ? "cost unavailable" : `cost ${path.cost.toFixed(3)}`;
  return `- **${markdownInline(human(path.disposition))}:** ${path.path.map(markdownInline).join(" -> ")} (${markdownInline(cost)})`;
}

export function reportMarkdownFilename(viewModel: ReportViewModel): string {
  return `atlas-${stableSlug(viewModel.subject, "intelligence")}-${stableSlug(viewModel.run.id, "report")}.md`;
}

export function reportPdfFilename(viewModel: ReportViewModel): string {
  return reportMarkdownFilename(viewModel).replace(/\.md$/, ".pdf");
}

/** Serialize the sanitized view model into byte-stable CommonMark. */
export function reportViewModelToMarkdown(viewModel: ReportViewModel): string {
  const lines: string[] = [
    `# ${briefingHeadline(viewModel.briefing.headline)}`,
    "",
    `> ${viewModel.classification}`,
    "",
    "## Public briefing",
    "",
    markdownInline(viewModel.briefing.leadStatement),
    "",
    markdownInline(viewModel.briefing.overview),
    "",
    `> ${markdownInline(viewModel.briefing.statusCaveat)}`,
    "",
    `> ${markdownInline(viewModel.briefing.sourceCaveat)}`,
    "",
    "## Source-backed public record",
    "",
  ];
  if (viewModel.briefing.sections.length === 0) {
    lines.push(
      markdownInline(viewModel.briefing.emptyState ?? "No cited public-professional observation was retained."),
      "",
    );
  } else {
    for (const section of viewModel.briefing.sections) {
      lines.push(
        `### ${markdownInline(section.heading)}`,
        "",
        ...section.observations.flatMap(briefingObservationLines),
        "",
      );
    }
  }
  lines.push(
    "## Retained candidate branches",
    "",
    "Candidate branches remain separate. Facts in the public briefing belong only to its displayed branch.",
    "",
    ...candidateTable(viewModel.identity.profiles),
    "",
    "## Findings",
    "",
  );
  if (viewModel.findings.length === 0) {
    lines.push("No finding met the admission and confidence rules.");
  } else {
    for (const [index, finding] of viewModel.findings.entries()) {
      lines.push(...findingSection(finding, index), "");
    }
  }

  lines.push(
    "## Evidence and source ledger",
    "",
    "Evidence references are stable within this report. Exact source excerpts, normalized archived text, and structured API claims are labeled separately.",
    "",
  );
  if (viewModel.evidence.length === 0) {
    lines.push("No evidence was admitted.", "");
  } else {
    for (const evidence of viewModel.evidence) lines.push(...evidenceSection(evidence), "");
  }

  lines.push(
    "## Search strategy",
    "",
    markdownInline(viewModel.searchStrategy.narrative),
    "",
    row(["Graph metric", "Value"]),
    row(["---", "---:"]),
    row(["Canonical graph available", viewModel.searchStrategy.graphAvailable ? "Yes" : "No"]),
    row(["Nodes", viewModel.searchStrategy.nodeCount]),
    row(["Edges", viewModel.searchStrategy.edgeCount]),
    row(["Mutations proposed", viewModel.searchStrategy.mutation.proposed]),
    row(["Mutations accepted", viewModel.searchStrategy.mutation.accepted]),
    row(["Mutations rejected", viewModel.searchStrategy.mutation.rejected]),
    "",
    "### Graph node states",
    "",
    row(["State", "Nodes"]),
    row(["---", "---:"]),
    ...viewModel.searchStrategy.nodeStatusCounts.map((item) => row([human(item.label), item.count])),
    "",
    "### Frontier entry states",
    "",
    row(["State", "Entries"]),
    row(["---", "---:"]),
    ...viewModel.searchStrategy.frontierCounts.map((item) => row([human(item.label), item.count])),
    "",
    "### Source ladder",
    "",
    row([
      "Tier",
      "Policy",
      "Frontier entries",
      "Verified",
      "Rejected",
      "Exhausted",
      "Admitted evidence",
      "Source families",
    ]),
    row(["---:", "---", "---:", "---:", "---:", "---:", "---:", "---"]),
    ...viewModel.searchStrategy.sourceLadder.map((tier) =>
      row([
        tier.tier,
        tier.label,
        tier.frontierCount,
        tier.verifiedCount,
        tier.rejectedCount,
        tier.exhaustedCount,
        tier.evidenceCount,
        tier.sourceFamilies.join(", ") || "None",
      ]),
    ),
    "",
    "### Accepted, rejected, and mutation paths",
    "",
    ...(viewModel.searchStrategy.paths.length > 0
      ? viewModel.searchStrategy.paths.map(pathLine)
      : ["No canonical path summary was available."]),
    "",
    "## Coverage gaps and limitations",
    "",
    row(["Requested-category coverage", "Value"]),
    row(["---", "---"]),
    row(["Covered categories", viewModel.coverage.coveredCategories.map(human).join(", ") || "None"]),
    row(["Missing categories", viewModel.coverage.missingCategories.map(human).join(", ") || "None"]),
    "",
    "### Gaps",
    "",
    ...(viewModel.coverage.gaps.length > 0
      ? viewModel.coverage.gaps.map((gap) => `- ${markdownInline(gap)}`)
      : ["- No additional gap was recorded."]),
    "",
    "### Limitations",
    "",
    ...(viewModel.limitations.length > 0
      ? viewModel.limitations.map((limitation) => `- ${markdownInline(limitation)}`)
      : ["- No additional limitation was recorded."]),
    "",
    "## Methodology and audit",
    "",
    "The scores below are deterministic rule-based decision aids, not probabilities about a person.",
    "",
    row(["Audit field", "Value"]),
    row(["---", "---"]),
    row(["Formal identity status", human(viewModel.audit.formalIdentityStatus)]),
    row(["Assessment", viewModel.audit.assessment]),
    row(["Resolution basis", human(viewModel.audit.resolutionBasis)]),
    row([viewModel.audit.decisionScoreLabel, percent(viewModel.audit.decisionScore)]),
    row([
      viewModel.audit.baseCandidateScoreLabel,
      viewModel.audit.baseCandidateScore === null ? "Not available" : percent(viewModel.audit.baseCandidateScore),
    ]),
    row(["Rule-based resolution threshold", percent(viewModel.audit.resolutionThreshold)]),
    row(["Rule-based resolution margin", percent(viewModel.audit.resolutionMargin)]),
    row(["Required rule-based margin", percent(viewModel.audit.marginThreshold)]),
    row(["Identity-supporting source families", viewModel.audit.identitySupportingSourceFamilyCount]),
    row(["Independent admitted source families", viewModel.audit.admittedIndependentSourceFamilyCount]),
    row(["Candidate branches retained", viewModel.audit.retainedCandidateCount]),
    row(["Requested-category coverage", percent(viewModel.audit.coverageScore)]),
    row(["Stop reason", human(viewModel.audit.stopReason)]),
    row(["Stop detail", viewModel.audit.stopDetail]),
    "",
    "### Run metadata",
    "",
    row(["Run field", "Value"]),
    row(["---", "---"]),
    row(["Run ID", viewModel.run.id]),
    row(["Query", viewModel.run.query]),
    row(["Objective", viewModel.run.objective ?? "Not supplied"]),
    row(["Target kind", human(viewModel.run.targetKind)]),
    row(["Depth", human(viewModel.run.depth)]),
    row(["Requested categories", viewModel.run.requestedCategories.map(human).join(", ") || "None"]),
    row(["Explicit identifiers", viewModel.run.explicitIdentifierKinds.map(human).join(", ") || "None"]),
    row(["Scope", viewModel.run.scope]),
    row(["Status", human(viewModel.run.status)]),
    row(["Generated", viewModel.run.generatedAt]),
    "",
    "### Execution usage",
    "",
    row(["Usage", "Value"]),
    row(["---", "---:"]),
    ...viewModel.execution.usage.map((metric) => row([metric.label, metric.value])),
    "",
    "### Standards and safety",
    "",
    `**Evidence standard.** ${markdownInline(viewModel.methodology.evidenceStandard)}`,
    "",
    `**Confidence standard.** ${markdownInline(viewModel.methodology.confidenceStandard)}`,
    "",
    `**Graph standard.** ${markdownInline(viewModel.methodology.graphStandard)}`,
    "",
    `**Safety note.** ${markdownInline(viewModel.methodology.safetyNote)}`,
    "",
    `---`,
    "",
    `Generated by Atlas for run ${markdownInline(viewModel.run.id)} at ${markdownInline(viewModel.run.generatedAt)}.`,
    "",
  );
  return lines.join("\n");
}

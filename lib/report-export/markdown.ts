import { markdownInline, markdownUrl, stableSlug } from "./sanitize";
import type {
  ReportCitedSource,
  ReportCandidateView,
  ReportEvidenceView,
  ReportFindingView,
  ReportPathView,
  ReportProfileFactView,
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
      "Base candidate score",
      "Direct evidence",
      "Supporting families",
      "Evidence",
      "Findings",
      "Matched context",
      "Conflicts",
    ]),
    row(["---", "---", "---:", "---:", "---", "---", "---", "---", "---"]),
  ];
  for (const candidate of candidates) {
    lines.push(
      row([
        candidate.name,
        human(candidate.status),
        percent(candidate.score),
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

function profileFactLine(fact: ReportProfileFactView): string {
  const evidence = `[${markdownInline(fact.evidenceRef)}](#${fact.evidenceRef.toLocaleLowerCase("en-US")})`;
  if (!fact.source) return `- ${evidence} ${markdownInline(fact.claim)}`;
  const target = markdownUrl(fact.source.url);
  const label = fact.source.title ? `${fact.source.title} — ${fact.source.domain}` : fact.source.domain;
  const source = target ? `[${markdownInline(label)}](${target})` : markdownInline(label);
  return `- ${evidence} ${markdownInline(fact.claim)} — ${source}`;
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
    `# ${markdownInline(viewModel.title)}`,
    "",
    `> ${viewModel.classification}`,
    "",
    row(["Run metadata", "Value"]),
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
    row(["Stop reason", human(viewModel.run.stopReason)]),
    "",
    "## Executive summary",
    "",
    markdownInline(viewModel.executiveSummary),
    "",
    "## Identity resolution",
    "",
    `**Assessment:** ${markdownInline(viewModel.identity.decisionLabel)}`,
    "",
    `**Formal identity status:** ${markdownInline(human(viewModel.identity.status))}`,
    "",
    markdownInline(viewModel.identity.rationale),
    "",
    `**Distinct candidate branches retained:** ${viewModel.identity.retainedCandidateCount}`,
    "",
  ];

  if (viewModel.identity.lead) {
    const lead = viewModel.identity.lead;
    lines.push(
      `**${viewModel.identity.selected ? "Selected" : "Leading"} candidate:** ${markdownInline(lead.name)} (base score ${percent(lead.score)}; ${markdownInline(human(lead.status))})`,
      "",
      `**Identity match score:** ${percent(viewModel.identity.resolutionScore)} (${markdownInline(human(viewModel.identity.resolutionBasis))})`,
      "",
      `**Direct supporting source families:** ${markdownInline(lead.supportingSourceFamilies.join(", ") || "None")}`,
      "",
      `**Matched non-name context:** ${markdownInline(lead.matchedContextSignals.map(human).join(", ") || "None")}`,
      "",
    );
  } else {
    lines.push("**Leading candidate:** None", "");
  }
  if (viewModel.identity.missingCorroboration.length > 0) {
    lines.push(
      "### What is still missing",
      "",
      ...viewModel.identity.missingCorroboration.map((item) => `- ${markdownInline(item)}`),
      "",
    );
  }
  lines.push(
    `**Resolution margin:** ${percent(viewModel.identity.resolutionMargin)} (required ${percent(viewModel.identity.marginThreshold)}; base candidate margin ${percent(viewModel.identity.runnerUpMargin)})`,
    "",
    "### Top retained candidate profiles",
    "",
    ...candidateTable(viewModel.identity.profiles),
    "",
  );
  if (viewModel.identity.lead?.profileFacts.length) {
    const resolvedProfile = viewModel.identity.status === "resolved";
    lines.push(
      resolvedProfile ? "### Cited profile facts" : "### Candidate-scoped cited observations",
      "",
      ...(resolvedProfile
        ? []
        : [
            "These cited observations are bound only to the leading retained branch. They do not independently establish that it is the queried person.",
            "",
          ]),
      ...viewModel.identity.lead.profileFacts.map(profileFactLine),
      "",
    );
  }
  lines.push("## Findings", "");
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
    row(["Coverage", "Value"]),
    row(["---", "---"]),
    row(["Score", percent(viewModel.coverage.score)]),
    row(["Covered categories", viewModel.coverage.coveredCategories.map(human).join(", ") || "None"]),
    row(["Missing categories", viewModel.coverage.missingCategories.map(human).join(", ") || "None"]),
    row(["Independent source families", viewModel.coverage.independentSourceFamilyCount]),
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
    "## Execution",
    "",
    row(["Usage", "Value"]),
    row(["---", "---:"]),
    ...viewModel.execution.usage.map((metric) => row([metric.label, metric.value])),
    "",
    `**Stop reason:** ${markdownInline(human(viewModel.execution.stopReason))}`,
    "",
    `**Stop detail:** ${markdownInline(viewModel.execution.stopDetail)}`,
    "",
    "## Methodology and safety",
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

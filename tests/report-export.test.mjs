import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const example = JSON.parse(
  await readFile(new URL("../examples/chris-anderson-ted/output.json", import.meta.url), "utf8"),
);
const vite = await createServer({
  root: projectRoot,
  configFile: false,
  cacheDir: `node_modules/.vite-atlas-ssr/${process.pid}`,
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true },
});
const reportExport = await vite.ssrLoadModule("/lib/report-export/index.ts");
const domain = await vite.ssrLoadModule("/lib/domain/index.ts");

after(async () => {
  await vite.close();
});

function terminalReport() {
  return structuredClone(example);
}

function syncFindingConfidence(report) {
  const evidenceById = new Map(report.evidence.map((item) => [item.id, item]));
  for (const finding of report.findings) {
    const records = [...finding.evidenceIds, ...finding.counterEvidenceIds]
      .map((id) => evidenceById.get(id))
      .filter(Boolean);
    finding.confidence = domain.assessConfidence(records);
  }
}

function fictionalNarrativeReport() {
  const report = terminalReport();
  const lead = structuredClone(report.candidates[0]);
  const alternate = structuredClone(report.candidates[1]);
  const leadId = "fictional-candidate-lead";
  const alternateId = "fictional-candidate-alternate";
  const categories = ["employment", "education", "project", "publication", "online_presence"];
  const facts = {
    employment: "Morgan Vale works as a research lead at Northstar Studio.",
    education: "Morgan Vale graduated from Cedar Ridge School.",
    project: "Morgan Vale built the Lantern Mapping project.",
    publication: "Morgan Vale published the Field Systems paper.",
    online_presence: "Morgan Vale maintains a public code profile.",
  };
  const families = {
    employment: "northstar.example",
    education: "morgan-vale.example",
    project: "lantern.example",
    publication: "journal.example",
    online_presence: "code.example",
  };
  const evidenceTemplate = report.evidence[0];
  const evidence = categories.map((category, index) => {
    const id = `fictional-evidence-${category}`;
    const family = families[category];
    return {
      ...structuredClone(evidenceTemplate),
      id,
      candidateId: leadId,
      claim: facts[category],
      normalizedClaim: facts[category]
        .toLocaleLowerCase("en-US")
        .replace(/[^a-z0-9]+/g, " ")
        .trim(),
      sourceUrl: `https://${family}/morgan-vale/${category}`,
      canonicalUrl: `https://${family}/morgan-vale/${category}`,
      title: `${category.replaceAll("_", " ")} record for Morgan Vale`,
      publisher: family,
      sourceFamily: family,
      sourceType: category === "online_presence" ? "code_profile" : "public_document",
      excerpt: facts[category],
      spoofable: category === "education",
      canonicalSubset: null,
      attributes: {},
      fingerprint: `fictional-${index}`,
    };
  });
  const crossCandidateEvidence = {
    ...structuredClone(evidenceTemplate),
    id: "fictional-evidence-cross-candidate",
    candidateId: alternateId,
    claim: "A different Morgan Vale leads Harbor Works.",
    normalizedClaim: "a different morgan vale leads harbor works",
    sourceUrl: "https://harbor.example/morgan-vale",
    canonicalUrl: "https://harbor.example/morgan-vale",
    title: "Harbor Works profile",
    publisher: "Harbor Works",
    sourceFamily: "harbor.example",
    excerpt: "A different Morgan Vale leads Harbor Works.",
    canonicalSubset: null,
    attributes: {},
  };
  const discoveryOnlyEvidence = {
    ...structuredClone(evidenceTemplate),
    id: "fictional-evidence-discovery-only",
    candidateId: leadId,
    claim: "A search snippet alleges an unverified private venture.",
    normalizedClaim: "a search snippet alleges an unverified private venture",
    disposition: "discovery_only",
    sourceUrl: "https://search.example/result",
    canonicalUrl: "https://search.example/result",
    title: "Unverified search lead",
    publisher: "Search",
    sourceFamily: "search.example",
    sourceType: "search_result",
    verificationMethod: "search_discovery",
    excerpt: "Discovery-only material must not enter the briefing.",
    reliability: 0,
    spoofable: true,
    canonicalSubset: null,
    attributes: {},
  };
  const signalTemplate = lead.signals.find((signal) => signal.kind === "organization");
  lead.id = leadId;
  lead.displayName = "Morgan Vale";
  lead.normalizedName = "morgan vale";
  lead.status = "resolved";
  lead.evidenceIds = evidence.map((item) => item.id);
  lead.signals = [
    {
      ...signalTemplate,
      kind: "name",
      value: "Morgan Vale",
      normalizedValue: "morgan vale",
      sourceEvidenceId: "fictional-evidence-education",
      sourceFamily: families.education,
    },
    {
      ...signalTemplate,
      kind: "organization",
      value: "Northstar Studio",
      normalizedValue: "northstar studio",
      sourceEvidenceId: "fictional-evidence-employment",
      sourceFamily: families.employment,
    },
    {
      ...signalTemplate,
      kind: "role",
      value: "research lead",
      normalizedValue: "research lead",
      sourceEvidenceId: "fictional-evidence-employment",
      sourceFamily: families.employment,
    },
  ];
  lead.score = {
    ...lead.score,
    total: 0.82,
    positive: 0.82,
    independentFamilies: Object.values(families),
    matchedSignals: ["name", "organization", "role"],
    conflictingSignals: [],
  };
  alternate.id = alternateId;
  alternate.displayName = "Morgan Vale";
  alternate.normalizedName = "morgan vale";
  alternate.evidenceIds = [crossCandidateEvidence.id];
  alternate.signals = [
    {
      ...signalTemplate,
      kind: "name",
      value: "Morgan Vale",
      normalizedValue: "morgan vale",
      sourceEvidenceId: crossCandidateEvidence.id,
      sourceFamily: crossCandidateEvidence.sourceFamily,
    },
  ];
  alternate.score = { ...alternate.score, total: 0.58, positive: 0.58, penalty: 0 };
  report.candidates = [lead, alternate];
  report.evidence = [...evidence, crossCandidateEvidence, discoveryOnlyEvidence];
  report.findings = categories.map((category, index) => {
    const sourceEvidence = evidence[index];
    return {
      ...structuredClone(report.findings[0]),
      id: `fictional-finding-${category}`,
      candidateId: leadId,
      title: `${category === "online_presence" ? "Online presence" : `${category[0].toUpperCase()}${category.slice(1)}`} — Morgan Vale`,
      description: facts[category],
      category,
      evidenceIds: [sourceEvidence.id],
      counterEvidenceIds: [],
      confidence: domain.assessConfidence([sourceEvidence]),
      caveats: [],
    };
  });
  report.input = {
    ...report.input,
    query: "Morgan Vale, Northstar Studio",
    objective: "Summarize admitted fictional public-professional records.",
    requestedCategories: categories,
  };
  report.target = domain.parseTarget(report.input);
  report.identity = domain.resolveIdentity(report.candidates, report.evidence, report.target);
  report.coverage = {
    ...report.coverage,
    score: 1,
    requestedCategories: categories,
    coveredCategories: categories,
    missingCategories: [],
    supportedFindingCount: categories.length,
    highConfidenceFindingCount: 0,
    independentSourceFamilyCount: Object.keys(families).length,
  };
  return report;
}

const footprintProjectionHash = `sha256:${"a".repeat(64)}`;

function reportWithEvidenceContexts() {
  const report = terminalReport();
  report.evidence[0].canonicalSubset = {
    pageFootprintHash: footprintProjectionHash,
    pageFootprint: {
      schemaVersion: "public_page_footprint_v1",
      title: "Chris Anderson — TED speaker profile",
      description: "Public page metadata retained from the already-fetched profile.",
      canonicalUrl: "https://www.ted.com/speakers/chris_anderson_ted",
      canonicalStatus: "accepted_same_page",
      language: "en-US",
      openGraph: { type: "profile", siteName: "TED" },
      observedProviderFamilies: ["cloudflare", "not-an-allowlisted-provider", "jsdelivr"],
      observedResourceHosts: ["cdn.jsdelivr.net", "localhost", "static.cloudflareinsights.com"],
      jsonLdTypes: [" Person ", "Organization"],
      declaredApplications: {
        generators: ["Next.js"],
        applicationNames: ["TED"],
      },
      bounded: false,
      spoofable: true,
      scopeNote: "DO_NOT_EXPORT_UNTRUSTED_FOOTPRINT_SCOPE_NOTE",
      arbitraryPageMetadata: "DO_NOT_EXPORT_ARBITRARY_PAGE_METADATA",
    },
    rawProviderSecret: "DO_NOT_EXPORT_CONTEXT_PROVIDER_PAYLOAD",
  };
  report.evidence[1].verificationMethod = "archive_snapshot";
  report.evidence[1].sourceType = "web_archive";
  report.evidence[1].excerpt = report.evidence[1].claim;
  report.evidence[1].canonicalSubset = {
    temporalComparison: {
      observedAfter: "2020-01-01T00:00:00.000Z",
      observedOnOrBefore: "2024-01-01T00:00:00.000Z",
      bodyChanged: true,
      visibleTextChanged: true,
      metadataChanged: true,
      structureChanged: false,
      changedMetadataFields: ["title", "rawHeaders", "description"],
      addedTextFragments: [
        "  Added   professional role — 2024.  ",
        "Published a public research note.",
        "Joined a public conference panel.",
        "Added an official project page.",
        "Added a public repository link.",
        "Updated the professional biography.",
        "This seventh fragment must be bounded out.",
      ],
      removedTextFragments: ["  Removed   the former curator wording. "],
      addedFragmentCount: 8,
      removedFragmentCount: 2,
      unchangedFragmentCount: 3,
      comparisonBounded: false,
      thenCaptureUrl: "https://example.org/DO_NOT_EXPORT_CAPTURE_URL",
      scopeNote: "DO_NOT_EXPORT_UNTRUSTED_TEMPORAL_SCOPE_NOTE",
    },
    arbitraryNestedPayload: { secret: "DO_NOT_EXPORT_CONTEXT_NESTED_PAYLOAD" },
  };
  syncFindingConfidence(report);
  return report;
}

test("report view model and Markdown are deterministic and citation-complete", () => {
  const report = terminalReport();
  const first = reportExport.createReportViewModel(report);
  const second = reportExport.createReportViewModel(structuredClone(report));
  assert.deepEqual(first, second);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first);

  const firstMarkdown = reportExport.reportViewModelToMarkdown(first);
  const secondMarkdown = reportExport.reportViewModelToMarkdown(second);
  assert.equal(firstMarkdown, secondMarkdown);
  assert.equal(reportExport.reportMarkdownFilename(first), "atlas-chris-anderson-replay-chris-anderson-ted-v2.md");
  assert.equal(reportExport.reportPdfFilename(first), "atlas-chris-anderson-replay-chris-anderson-ted-v2.pdf");

  const references = new Set(first.evidence.map((item) => item.ref));
  assert.deepEqual([...references], ["E01", "E02", "E03", "E04"]);
  for (const finding of first.findings) {
    assert.ok(finding.candidateId);
    assert.ok(finding.candidateName);
    for (const ref of [...finding.citations, ...finding.counterCitations]) {
      assert.equal(references.has(ref), true, `${finding.id} cites unknown ${ref}`);
      assert.match(firstMarkdown, new RegExp(`<a id="${ref.toLocaleLowerCase("en-US")}"></a>`));
    }
  }
  assert.match(firstMarkdown, /Exact source excerpt/);
  assert.match(firstMarkdown, /Mutations rejected\s*\| 1/);
  assert.match(firstMarkdown, /Mutation Rejected/);
  assert.match(firstMarkdown, /Frontier entry states/);
  assert.equal(first.identity.retainedCandidateCount, report.candidates.length);
  assert.ok(first.identity.profiles.length > 0 && first.identity.profiles.length <= 5);
  assert.match(first.identity.rationale, /Resolved match: Atlas formally selected Chris Anderson/);
  assert.equal(first.briefing.headline, "Chris Anderson — here’s what’s publicly available.");
  assert.match(first.briefing.leadStatement, /resolved match/);
  assert.match(first.briefing.overview, /clearest cited public record states/);
  assert.match(firstMarkdown, /## Public briefing/);
  assert.match(firstMarkdown, /## Retained candidate branches/);
  assert.match(firstMarkdown, /## Methodology and audit/);
  assert.match(firstMarkdown, /\*\*Candidate:\*\*/);
  assert.equal(first.audit.decisionScoreLabel, "Rule-based identity decision score (not a probability)");
  assert.equal(first.audit.baseCandidateScoreLabel, "Rule-based base candidate score (not a probability)");
  const narrativeOpening = firstMarkdown.slice(0, firstMarkdown.indexOf("## Retained candidate branches"));
  assert.doesNotMatch(narrativeOpening, /\b\d{1,3}%\b|Goal Satisfied|Budget Exhausted/);
  for (const profile of first.identity.profiles) {
    assert.ok(Array.isArray(profile.evidenceRefs));
    assert.ok(Array.isArray(profile.findingIds));
    assert.ok(Array.isArray(profile.sourceDomains));
    assert.ok(Array.isArray(profile.supportingSourceFamilies));
    assert.ok(Array.isArray(profile.matchedContextSignals));
    assert.ok(Array.isArray(profile.profileFacts));
    assert.equal(typeof profile.allSupportingEvidenceSpoofable, "boolean");
    assert.equal(Number.isInteger(profile.directSourceCount), true);
  }

  assert.match(firstMarkdown, /not probabilities about a person/);
  assert.doesNotMatch(first.briefing.overview, /[.!?…]”[.!?…]/u);
});

test("report export boundary rejects malformed, restricted, and cross-candidate report payloads", () => {
  const malformed = terminalReport();
  delete malformed.evidence;
  assert.throws(() => reportExport.createReportViewModel(malformed), /invalid canonical investigation report/);

  const zeroWidthRestricted = terminalReport();
  zeroWidthRestricted.limitations = ["A private\u200b-contact@example.net value must not enter an export."];
  assert.throws(() => reportExport.createReportViewModel(zeroWidthRestricted), /restricted public content/);

  const forged = terminalReport();
  const otherCandidateEvidence = forged.evidence.find(
    (item) => item.candidateId !== forged.findings[0].candidateId && item.disposition === "supports",
  );
  assert.ok(otherCandidateEvidence);
  forged.findings[0].evidenceIds = [otherCandidateEvidence.id];
  forged.findings[0].description = otherCandidateEvidence.excerpt;
  forged.findings[0].confidence = domain.assessConfidence([otherCandidateEvidence]);
  assert.throws(() => reportExport.createReportViewModel(forged), /cross_candidate_evidence/);

  const forgedIdentityCandidate = terminalReport();
  forgedIdentityCandidate.identity.selectedCandidate.displayName = "Forged Export Candidate";
  forgedIdentityCandidate.identity.selectedCandidate.normalizedName = "forged export candidate";
  assert.throws(
    () => reportExport.createReportViewModel(forgedIdentityCandidate),
    /identity projection does not match canonical candidates and evidence/,
  );

  const forgedIdentityStatus = terminalReport();
  forgedIdentityStatus.identity.status = "unresolved";
  assert.throws(
    () => reportExport.createReportViewModel(forgedIdentityStatus),
    /identity projection does not match canonical candidates and evidence/,
  );
});

test("report sources require public HTTPS hosts and deduplicate the same canonical URL", () => {
  const localSource = terminalReport();
  localSource.evidence[3].sourceUrl = "https://localhost/professional-profile";
  localSource.evidence[3].canonicalUrl = localSource.evidence[3].sourceUrl;
  const localView = reportExport.createReportViewModel(localSource);
  assert.equal(localView.evidence.find((item) => item.id === localSource.evidence[3].id)?.sourceUrl, "");

  const credentialUrl = terminalReport();
  credentialUrl.evidence[3].sourceUrl = "https://www.wired.com/profile?access\u200b_token=secret";
  credentialUrl.evidence[3].canonicalUrl = credentialUrl.evidence[3].sourceUrl;
  const credentialUrlView = reportExport.createReportViewModel(credentialUrl);
  assert.equal(credentialUrlView.evidence.find((item) => item.id === credentialUrl.evidence[3].id)?.sourceUrl, "");

  const portBearingCitation = terminalReport();
  const portBearingEvidence = portBearingCitation.evidence.find(
    (evidence) => evidence.id === portBearingCitation.findings[1].evidenceIds[0],
  );
  assert.ok(portBearingEvidence);
  const portBearingUrl = new URL(portBearingEvidence.sourceUrl);
  portBearingUrl.port = "8443";
  portBearingEvidence.sourceUrl = portBearingUrl.toString();
  portBearingEvidence.canonicalUrl = portBearingEvidence.sourceUrl;
  const portBearingView = reportExport.createReportViewModel(portBearingCitation);
  assert.equal(
    portBearingView.briefing.sections
      .flatMap((section) => section.observations)
      .some((observation) => observation.evidenceRefs.includes(portBearingView.evidence[1].ref)),
    false,
  );
  assert.equal(
    portBearingView.briefing.sections
      .flatMap((section) => section.observations)
      .every((observation) => observation.sources.length > 0),
    true,
  );

  const duplicateSources = terminalReport();
  const supporting = duplicateSources.evidence.filter(
    (item) => item.candidateId === duplicateSources.candidates[0].id && item.disposition === "supports",
  );
  duplicateSources.findings = [
    {
      ...duplicateSources.findings[0],
      title: `Public professional finding — ${duplicateSources.candidates[0].displayName}`,
      description: supporting.map((item) => item.excerpt).join(" "),
      category: "other",
      evidenceIds: supporting.map((item) => item.id),
      confidence: domain.assessConfidence(supporting),
    },
  ];
  const duplicateView = reportExport.createReportViewModel(duplicateSources);
  assert.equal(duplicateView.findings[0].sources.length, 1);
  assert.equal(duplicateView.findings[0].sources[0].url, "https://www.ted.com/speakers/chris_anderson_ted");
});

test("identity presentation separates a best-supported profile from formal unresolved status", () => {
  const report = terminalReport();
  const lead = structuredClone(report.candidates[0]);
  // A bounded alternate parse can retain a score-level name-mismatch penalty;
  // that is not a persisted evidence contradiction and must not be presented
  // as one to the reader.
  lead.score.conflictingSignals = ["conflict"];
  report.candidates = [lead];
  report.evidence = report.evidence.filter((item) => item.candidateId === lead.id);
  report.findings = [];
  report.identity = domain.resolveIdentity(report.candidates, report.evidence, report.target);
  report.coverage = {
    ...report.coverage,
    score: 0,
    coveredCategories: [],
    missingCategories: [...report.coverage.requestedCategories],
    supportedFindingCount: 0,
    highConfidenceFindingCount: 0,
    independentSourceFamilyCount: 0,
  };

  const viewModel = reportExport.createReportViewModel(report);
  const markdown = reportExport.reportViewModelToMarkdown(viewModel);
  assert.equal(viewModel.identity.status, "unresolved");
  assert.equal(viewModel.identity.selected, null);
  assert.equal(viewModel.identity.lead?.id, lead.id);
  assert.equal(viewModel.identity.decisionLabel, "Best-supported candidate");
  assert.deepEqual(viewModel.identity.lead?.supportingSourceFamilies, ["ted.com"]);
  assert.deepEqual(viewModel.identity.resolutionSourceFamilies, ["ted.com"]);
  assert.equal(viewModel.identity.lead?.matchedContextSignals.includes("organization"), true);
  assert.equal(viewModel.identity.lead?.matchedContextSignals.includes("role"), true);
  assert.equal(viewModel.identity.lead?.matchedContextSignals.includes("name"), false);
  assert.deepEqual(viewModel.identity.lead?.conflictingSignals, []);
  assert.equal(viewModel.identity.lead?.profileFacts.length, 2);
  assert.equal(viewModel.briefing.leadStatement, "The strongest public-professional lead points to Chris Anderson.");
  assert.match(viewModel.briefing.statusCaveat, /not a formally resolved identity/);
  assert.match(viewModel.briefing.sourceCaveat, /one source family.*not independent confirmation/);
  assert.doesNotMatch(viewModel.executiveSummary, /\b(?:62|0|78)%\b/);
  assert.match(viewModel.identity.rationale, /Formal identity is unresolved because/);
  assert.match(viewModel.identity.rationale, /identity match score is below the 78% resolution threshold/);
  assert.match(viewModel.identity.rationale, /only one source family/);
  assert.match(markdown, /## Public briefing/);
  assert.match(markdown, /Identity note: this is the best-supported retained branch/);
  assert.match(markdown, /### Employment/);
  assert.match(markdown, /Chris Anderson Chairman, TED/);
  assert.doesNotMatch(markdown, /\*\*Selected candidate:\*\* None/);
});

test("identity presentation explains competing and empty candidate sets without canned unresolved copy", () => {
  const ambiguous = terminalReport();
  const competingCandidate = ambiguous.candidates[1];
  competingCandidate.status = "plausible";
  competingCandidate.score = {
    ...competingCandidate.score,
    total: 0.5,
    positive: 0.5,
    penalty: 0,
    conflictingSignals: [],
  };
  ambiguous.identity = domain.resolveIdentity(ambiguous.candidates, ambiguous.evidence, ambiguous.target);
  const ambiguousView = reportExport.createReportViewModel(ambiguous);
  assert.equal(ambiguousView.identity.decisionLabel, "Competing candidates");
  assert.match(ambiguousView.identity.rationale, /direct support comes from only one source family/);
  assert.match(ambiguousView.briefing.leadStatement, /retained competing public-professional branches/);
  assert.match(ambiguousView.briefing.statusCaveat, /competing candidate branches/);

  const empty = terminalReport();
  empty.candidates = [];
  empty.evidence = [];
  empty.findings = [];
  empty.identity = domain.resolveIdentity(empty.candidates, empty.evidence, empty.target);
  const emptyView = reportExport.createReportViewModel(empty);
  assert.equal(emptyView.identity.decisionLabel, "No eligible candidate");
  assert.equal(emptyView.identity.lead, null);
  assert.match(emptyView.identity.rationale, /No candidate profile survived/);
  assert.match(emptyView.briefing.leadStatement, /^Atlas did not retain a public-professional lead/);
  assert.equal(emptyView.briefing.sections.length, 0);
  assert.match(emptyView.briefing.emptyState, /No candidate-bound public-professional observation/);
});

test("identity presentation reserves high-confidence wording for resolved cross-source context matches", () => {
  const report = terminalReport();
  const conferenceEvidence = {
    ...report.evidence[1],
    id: "conference-corroboration",
    claim: "Chris Anderson works at TED.",
    normalizedClaim: "chris anderson works at ted",
    excerpt: "Chris Anderson works at TED.",
    sourceFamily: "conference.org",
    sourceUrl: "https://conference.org/speakers/chris-anderson",
    canonicalUrl: "https://conference.org/speakers/chris-anderson",
    title: "Chris Anderson speaker biography",
  };
  const associationEvidence = {
    ...structuredClone(conferenceEvidence),
    id: "association-corroboration",
    sourceFamily: "association.example",
    sourceUrl: "https://association.example/people/chris-anderson",
    canonicalUrl: "https://association.example/people/chris-anderson",
    title: "Chris Anderson public leadership profile",
  };
  const corroboratingEvidence = [conferenceEvidence, associationEvidence];
  report.evidence.push(...corroboratingEvidence);
  report.candidates[0].evidenceIds.push(...corroboratingEvidence.map((item) => item.id));
  const nameAndOrganizationSignals = report.candidates[0].signals.filter((signal) =>
    ["name", "organization"].includes(signal.kind),
  );
  for (const item of corroboratingEvidence) {
    report.candidates[0].signals.push(
      ...nameAndOrganizationSignals.map((signal) => ({
        ...structuredClone(signal),
        sourceEvidenceId: item.id,
        sourceFamily: item.sourceFamily,
      })),
    );
  }
  report.identity = domain.resolveIdentity(report.candidates, report.evidence, report.target);

  const viewModel = reportExport.createReportViewModel(report);
  assert.equal(viewModel.identity.decisionLabel, "High-confidence match");
  assert.equal(viewModel.identity.resolutionBasis, "context_corroboration");
  assert.equal(viewModel.identity.resolutionScore >= 0.78, true);
  assert.equal(viewModel.identity.resolutionMargin >= 0.15, true);
  assert.equal(viewModel.identity.lead?.score, 0.54);
  assert.deepEqual(viewModel.identity.resolutionSourceFamilies, ["association.example", "conference.org", "ted.com"]);
  assert.deepEqual(viewModel.identity.lead?.supportingSourceFamilies, [
    "association.example",
    "conference.org",
    "ted.com",
  ]);
  assert.equal(viewModel.identity.lead?.matchedContextSignals.includes("organization"), true);
  assert.equal(viewModel.identity.lead?.matchedContextSignals.includes("role"), true);
  assert.match(viewModel.briefing.leadStatement, /resolved match/);
  assert.doesNotMatch(viewModel.executiveSummary, /100%|54%/);
  assert.equal(viewModel.audit.decisionScore, viewModel.identity.resolutionScore);
  assert.equal(viewModel.audit.baseCandidateScore, 0.54);

  const spoofable = structuredClone(report);
  spoofable.evidence = spoofable.evidence.map((item) =>
    item.candidateId === spoofable.identity.selectedCandidateId ? { ...item, spoofable: true } : item,
  );
  syncFindingConfidence(spoofable);
  spoofable.identity = domain.resolveIdentity(spoofable.candidates, spoofable.evidence, spoofable.target);
  const spoofableView = reportExport.createReportViewModel(spoofable);
  assert.equal(spoofableView.identity.lead?.allSupportingEvidenceSpoofable, true);
  assert.equal(spoofableView.identity.status, "unresolved");
  assert.equal(spoofableView.identity.decisionLabel, "Best-supported candidate");
});

test("narrative briefing stays fictional, candidate-bound, and truthful across identity outcomes", () => {
  const resolved = fictionalNarrativeReport();
  const resolvedView = reportExport.createReportViewModel(resolved);
  const resolvedMarkdown = reportExport.reportViewModelToMarkdown(resolvedView);
  assert.equal(resolvedView.briefing.headline, "Morgan Vale — here’s what’s publicly available.");
  assert.deepEqual(
    resolvedView.briefing.sections.map((section) => section.key),
    ["employment", "education", "project", "publication", "online_presence"],
  );
  const resolvedBriefing = JSON.stringify(resolvedView.briefing);
  assert.match(
    resolvedBriefing,
    /Northstar Studio|Cedar Ridge School|Lantern Mapping|Field Systems|public code profile/,
  );
  assert.doesNotMatch(resolvedBriefing, /Harbor Works|Discovery-only|unverified private venture/);
  for (const observation of resolvedView.briefing.sections.flatMap((section) => section.observations)) {
    assert.equal(observation.candidateId, "fictional-candidate-lead");
    assert.equal(
      new Set(observation.sources.map((source) => `${source.ref}\u0000${source.url}`)).size,
      observation.sources.length,
    );
  }
  const resolvedOpening = resolvedMarkdown.slice(0, resolvedMarkdown.indexOf("## Retained candidate branches"));
  assert.doesNotMatch(resolvedOpening, /\b(?:82|58|24|100)%\b|no legal actions|Goal Satisfied/i);
  assert.match(resolvedMarkdown, /Rule-based identity decision score \(not a probability\)/);

  const probable = fictionalNarrativeReport();
  const educationEvidence = probable.evidence.find((item) => item.id === "fictional-evidence-education");
  const discoveryEvidence = probable.evidence.find((item) => item.id === "fictional-evidence-discovery-only");
  const educationFinding = probable.findings.find((item) => item.category === "education");
  assert.ok(educationEvidence && discoveryEvidence && educationFinding);
  const probableLead = probable.candidates[0];
  probableLead.evidenceIds = [educationEvidence.id];
  probableLead.signals = [
    probableLead.signals[0],
    {
      ...probableLead.signals[1],
      kind: "organization",
      value: "Cedar Ridge School",
      normalizedValue: "cedar ridge school",
      sourceEvidenceId: educationEvidence.id,
      sourceFamily: educationEvidence.sourceFamily,
    },
  ];
  probableLead.score.independentFamilies = [educationEvidence.sourceFamily];
  probableLead.score.total = 0.62;
  probableLead.score.positive = 0.62;
  probable.candidates = [probableLead];
  probable.evidence = [educationEvidence, discoveryEvidence];
  probable.findings = [educationFinding];
  probable.identity = domain.resolveIdentity(probable.candidates, probable.evidence, probable.target);
  const probableView = reportExport.createReportViewModel(probable);
  assert.equal(probableView.identity.decisionLabel, "Best-supported candidate");
  assert.equal(probableView.briefing.leadStatement, "The strongest public-professional lead points to Morgan Vale.");
  assert.match(probableView.briefing.overview, /“Morgan Vale graduated from Cedar Ridge School\.”/);
  assert.match(
    probableView.briefing.sourceCaveat,
    /self-published or otherwise spoofable.*not independent confirmation/,
  );
  assert.equal(probableView.briefing.sections[0].key, "education");
  assert.match(probableView.briefing.sections[0].observations[0].sources[0].url, /^https:\/\/morgan-vale\.example\//);
  assert.doesNotMatch(JSON.stringify(probableView.briefing), /unverified private venture/);
  assert.equal(probableView.audit.formalIdentityStatus, "unresolved");

  const competing = fictionalNarrativeReport();
  competing.candidates[1].status = "plausible";
  competing.candidates[1].score = {
    ...competing.candidates[1].score,
    total: 0.74,
    positive: 0.74,
    penalty: 0,
    conflictingSignals: [],
  };
  competing.identity = domain.resolveIdentity(competing.candidates, competing.evidence, competing.target);
  const competingView = reportExport.createReportViewModel(competing);
  assert.equal(competingView.identity.decisionLabel, "Competing candidates");
  assert.match(competingView.briefing.leadStatement, /competing public-professional branches/);
  assert.match(competingView.briefing.statusCaveat, /did not resolve the queried person/);
  assert.doesNotMatch(JSON.stringify(competingView.briefing), /Harbor Works/);

  const empty = fictionalNarrativeReport();
  empty.candidates = [];
  empty.evidence = [];
  empty.findings = [];
  empty.identity = domain.resolveIdentity(empty.candidates, empty.evidence, empty.target);
  const emptyView = reportExport.createReportViewModel(empty);
  assert.equal(emptyView.briefing.leadCandidateId, null);
  assert.equal(emptyView.briefing.sections.length, 0);
  assert.match(emptyView.briefing.emptyState, /No candidate-bound public-professional observation/);
  assert.match(emptyView.briefing.statusCaveat, /no person profile is asserted/);
});

test("an unresolved branch without grounded professional context is not called best-supported", () => {
  const report = terminalReport();
  const lead = report.candidates[0];
  lead.signals = lead.signals.filter((signal) => signal.kind === "name");
  report.candidates = [lead];
  report.evidence = report.evidence.filter((item) => item.candidateId === lead.id);
  report.findings = [];
  report.identity = domain.resolveIdentity(report.candidates, report.evidence, report.target);

  const viewModel = reportExport.createReportViewModel(report);
  assert.equal(viewModel.identity.lead?.supportingSourceFamilies.length, 1);
  assert.deepEqual(viewModel.identity.lead?.matchedContextSignals, []);
  assert.equal(viewModel.identity.decisionLabel, "Leading query branch");
  assert.match(viewModel.identity.rationale, /no directly grounded professional context/);
});

test("discovery leads export as unverified metadata and never as exact excerpts", () => {
  const report = terminalReport();
  const candidate = report.candidates[0];
  report.findings = [];
  report.evidence = [
    {
      ...report.evidence[0],
      id: "discovery-lead",
      claim: "Web search surfaced a possible direct source; it is a discovery lead only.",
      normalizedClaim: "web search surfaced a possible direct source it is a discovery lead only",
      disposition: "discovery_only",
      sourceType: "search_result",
      verificationMethod: "search_discovery",
      excerpt: "Provider search surfaced this URL, but the page was not fetched.",
    },
  ];
  candidate.evidenceIds = [report.evidence[0].id];
  candidate.signals = [];
  report.candidates = [candidate];
  report.identity = {
    ...report.identity,
    status: "unresolved",
    selectedCandidate: structuredClone(candidate),
    runnerUpCandidate: null,
    selectedCandidateId: candidate.id,
    selectedScore: candidate.score.total,
    runnerUpScore: 0,
    runnerUpMargin: candidate.score.total,
  };
  delete report.identity.runnerUpCandidateId;

  const viewModel = reportExport.createReportViewModel(report);
  const markdown = reportExport.reportViewModelToMarkdown(viewModel);
  assert.equal(viewModel.evidence[0].contentLabel, "Unverified discovery lead");
  assert.equal(viewModel.evidence[0].exactExcerpt, null);
  assert.match(markdown, /Unverified discovery lead/);
  assert.doesNotMatch(markdown, /Provider search surfaced this URL/);
});

test("sanitization escapes hostile Markdown and excludes unsafe URLs and raw payload-shaped fields", () => {
  const viewModel = reportExport.createReportViewModel(terminalReport());
  viewModel.subject = "private-contact@example.net";
  viewModel.findings[0].title = "Hostile | [title] `tick`\u0007";
  viewModel.findings[0].description = "# injected\n- list | [link](javascript:alert(1))";
  viewModel.evidence[0].claim = "Claim | [break] `code`\u0001";
  viewModel.evidence[0].exactExcerpt = "Exact\n## heading | [x]";
  viewModel.evidence[0].sourceUrl = "javascript:alert(1)";
  viewModel.evidence[0].rawProviderSecret = "DO_NOT_EXPORT_PROVIDER_PAYLOAD";
  viewModel.evidence[0].toolArguments = "DO_NOT_EXPORT_TOOL_ARGUMENTS";
  viewModel.evidence[1].exactExcerpt = null;
  viewModel.evidence[1].contentLabel = "Structured API claim";
  viewModel.evidence[1].projection = "DO_NOT_EXPORT_STRUCTURED_PAYLOAD";
  viewModel.rawTrace = { payload: "DO_NOT_EXPORT_RAW_TRACE" };
  const markdown = reportExport.reportViewModelToMarkdown(viewModel);
  assert.match(markdown, /^# Chris Anderson — here’s what’s publicly available\./);
  assert.doesNotMatch(markdown, /private-contact@example\.net/);
  assert.equal(
    [...markdown].some((character) => {
      const code = character.codePointAt(0);
      return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31);
    }),
    false,
  );
  assert.match(markdown, /Hostile \\| \\\[title\\\] \\`tick\\`\\u0007/);
  assert.match(markdown, /Exact source excerpt/);
  assert.doesNotMatch(
    markdown,
    /\n# injected|javascript:|DO_NOT_EXPORT_PROVIDER_PAYLOAD|DO_NOT_EXPORT_STRUCTURED_PAYLOAD|DO_NOT_EXPORT_TOOL_ARGUMENTS|DO_NOT_EXPORT_RAW_TRACE/,
  );
  assert.equal(viewModel.evidence[0].sourceUrl, "javascript:alert(1)");
  assert.equal(viewModel.evidence[1].contentLabel, "Structured API claim");
});

test("allowlisted temporal and footprint projections are bounded, sanitized, and export to Markdown", () => {
  const viewModel = reportExport.createReportViewModel(reportWithEvidenceContexts());
  const markdown = reportExport.reportViewModelToMarkdown(viewModel);
  const footprintEvidence = viewModel.evidence.find((item) => item.pageFootprint !== null);
  const temporalEvidence = viewModel.evidence.find((item) => item.temporalComparison !== null);

  assert.ok(footprintEvidence);
  assert.deepEqual(footprintEvidence.pageFootprint, {
    footprintHash: footprintProjectionHash,
    title: "Chris Anderson - TED speaker profile",
    description: "Public page metadata retained from the already-fetched profile.",
    canonicalUrl: "https://www.ted.com/speakers/chris_anderson_ted",
    canonicalStatus: "accepted_same_page",
    language: "en-us",
    openGraphType: "profile",
    openGraphSiteName: "TED",
    generators: ["Next.js"],
    applicationNames: ["TED"],
    observedProviderFamilies: ["cloudflare", "jsdelivr"],
    observedResourceHosts: ["cdn.jsdelivr.net", "static.cloudflareinsights.com"],
    jsonLdTypes: ["Person", "Organization"],
    bounded: false,
    caveat:
      "Page declarations are spoofable observations from the exact fetched HTML. No referenced resource was followed, and no hosting ownership or control is inferred.",
  });
  assert.ok(temporalEvidence);
  assert.equal(temporalEvidence.contentLabel, "Normalized archived text");
  assert.equal(temporalEvidence.temporalComparison.bodyChanged, true);
  assert.equal(temporalEvidence.temporalComparison.visibleTextChanged, true);
  assert.equal(temporalEvidence.temporalComparison.metadataChanged, true);
  assert.equal(temporalEvidence.temporalComparison.structureChanged, false);
  assert.deepEqual(temporalEvidence.temporalComparison.changedMetadataFields, ["title", "description"]);
  assert.equal(temporalEvidence.temporalComparison.addedTextFragments.length, 6);
  assert.equal(temporalEvidence.temporalComparison.addedTextFragments[0], "Added professional role - 2024.");
  assert.deepEqual(temporalEvidence.temporalComparison.removedTextFragments, ["Removed the former curator wording."]);
  assert.equal(temporalEvidence.temporalComparison.addedFragmentCount, 8);
  assert.equal(temporalEvidence.temporalComparison.removedFragmentCount, 2);
  assert.equal(temporalEvidence.temporalComparison.unchangedFragmentCount, 3);
  assert.equal(temporalEvidence.temporalComparison.comparisonBounded, true);

  assert.match(markdown, /Normalized archived text/);
  assert.doesNotMatch(markdown, /\*\*Exact source excerpt:\*\*\s+> Normalized archived profile text\./);
  assert.match(markdown, /#### Temporal comparison/);
  assert.match(markdown, /after 2020-01-01T00:00:00\.000Z; on or before 2024-01-01T00:00:00\.000Z/);
  assert.match(markdown, /Archived response body bytes changed:\*\* Yes/);
  assert.match(markdown, /Normalized static-HTML text changed:\*\* Yes/);
  assert.match(markdown, /Page-declared metadata changed:\*\* Yes/);
  assert.match(markdown, /Static-HTML structure changed:\*\* No/);
  assert.match(markdown, /Changed metadata fields:\*\* Title, Description/);
  assert.match(markdown, /Static-HTML fragment counts:\*\* 8 added; 2 removed; 3 unchanged/);
  assert.match(markdown, /Added professional role - 2024\./);
  assert.match(markdown, /Removed the former curator wording\./);
  assert.match(markdown, /do not identify the editor or prove archive completeness/);
  assert.match(markdown, /do not describe browser-rendered state/);
  assert.match(markdown, /#### Page-declared footprint/);
  assert.match(markdown, new RegExp(footprintProjectionHash));
  assert.match(markdown, /Page title:\*\* Chris Anderson - TED speaker profile/);
  assert.match(markdown, /Description:\*\* Public page metadata retained from the already-fetched profile\./);
  assert.match(markdown, /Canonical status:\*\* Accepted Same Page/);
  assert.match(
    markdown,
    /Canonical URL:\*\* \[https:\/\/www\.ted\.com\/speakers\/chris\\_anderson\\_ted\]\(https:\/\/www\.ted\.com\/speakers\/chris_anderson_ted\)/,
  );
  assert.match(markdown, /Language:\*\* en-us/);
  assert.match(markdown, /Open Graph type:\*\* profile/);
  assert.match(markdown, /Open Graph site name:\*\* TED/);
  assert.match(markdown, /Declared generators:\*\* Next\.js/);
  assert.match(markdown, /Declared applications:\*\* TED/);
  assert.match(markdown, /Cloudflare, Jsdelivr/);
  assert.match(markdown, /cdn\.jsdelivr\.net, static\.cloudflareinsights\.com/);
  assert.match(markdown, /Person, Organization/);
  assert.match(markdown, /no hosting ownership or control is inferred/i);

  const durableView = JSON.stringify(viewModel);
  for (const excluded of [
    "DO_NOT_EXPORT_ARBITRARY_PAGE_METADATA",
    "DO_NOT_EXPORT_UNTRUSTED_FOOTPRINT_SCOPE_NOTE",
    "DO_NOT_EXPORT_CONTEXT_PROVIDER_PAYLOAD",
    "DO_NOT_EXPORT_CAPTURE_URL",
    "DO_NOT_EXPORT_UNTRUSTED_TEMPORAL_SCOPE_NOTE",
    "DO_NOT_EXPORT_CONTEXT_NESTED_PAYLOAD",
    "not-an-allowlisted-provider",
    "private-contact@example.net",
    "This seventh fragment must be bounded out.",
  ]) {
    assert.doesNotMatch(durableView, new RegExp(excluded.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(markdown, new RegExp(excluded.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("malformed temporal windows and unbound footprint objects fail closed", () => {
  const report = reportWithEvidenceContexts();
  const malformedFootprint = structuredClone(report.evidence[0].canonicalSubset);
  malformedFootprint.pageFootprintHash = "sha256:not-a-hash";
  const malformedTemporal = structuredClone(report.evidence[1].canonicalSubset);
  malformedTemporal.temporalComparison.observedAfter = "2025-01-01T00:00:00.000Z";
  malformedTemporal.temporalComparison.observedOnOrBefore = "2024-01-01T00:00:00.000Z";
  assert.equal(reportExport.projectPageFootprint(malformedFootprint), null);
  assert.equal(reportExport.projectTemporalComparison(malformedTemporal), null);
});

test("body-only archive changes remain explicit and malformed change dimensions fail closed", () => {
  const report = reportWithEvidenceContexts();
  report.evidence[1].canonicalSubset.temporalComparison = {
    observedAfter: "2020-01-01T00:00:00.000Z",
    observedOnOrBefore: "2024-01-01T00:00:00.000Z",
    bodyChanged: true,
    visibleTextChanged: false,
    metadataChanged: false,
    structureChanged: false,
    changedMetadataFields: [],
    addedTextFragments: [],
    removedTextFragments: [],
    addedFragmentCount: 0,
    removedFragmentCount: 0,
    unchangedFragmentCount: 1,
    comparisonBounded: false,
  };

  const viewModel = reportExport.createReportViewModel(report);
  const temporal = viewModel.evidence.find((item) => item.temporalComparison)?.temporalComparison;
  assert.ok(temporal);
  assert.deepEqual(temporal, {
    observedAfter: "2020-01-01T00:00:00.000Z",
    observedOnOrBefore: "2024-01-01T00:00:00.000Z",
    bodyChanged: true,
    visibleTextChanged: false,
    metadataChanged: false,
    structureChanged: false,
    changedMetadataFields: [],
    addedTextFragments: [],
    removedTextFragments: [],
    addedFragmentCount: 0,
    removedFragmentCount: 0,
    unchangedFragmentCount: 1,
    comparisonBounded: false,
    caveat:
      "Archive observations bind changes in retrieved response bytes and bounded static-HTML projections to this interval; they do not identify the editor or prove archive completeness, and they do not describe browser-rendered state.",
  });
  const markdown = reportExport.reportViewModelToMarkdown(viewModel);
  assert.match(markdown, /Archived response body bytes changed:\*\* Yes/);
  assert.match(markdown, /Normalized static-HTML text changed:\*\* No/);
  assert.match(markdown, /Page-declared metadata changed:\*\* No/);
  assert.match(markdown, /Static-HTML structure changed:\*\* No/);
  assert.match(markdown, /Static-HTML fragment counts:\*\* 0 added; 0 removed; 1 unchanged/);

  for (const invalidCount of [-1, 1.5, 257, Number.NaN]) {
    const malformed = reportWithEvidenceContexts();
    malformed.evidence[1].canonicalSubset.temporalComparison.addedFragmentCount = invalidCount;
    assert.equal(
      reportExport.projectTemporalComparison(malformed.evidence[1].canonicalSubset),
      null,
      `invalid temporal count ${String(invalidCount)} was projected`,
    );
  }
});

test("page-footprint metadata rejects private content and unsafe canonical URLs field by field", () => {
  const report = reportWithEvidenceContexts();
  report.evidence[0].canonicalSubset.pageFootprint = {
    ...report.evidence[0].canonicalSubset.pageFootprint,
    title: "private-contact@example.net",
    description: `sk-proj-${"z".repeat(48)}`,
    canonicalUrl: "https://www.ted.com:8443/speakers/chris_anderson_ted?email=private-contact%40example.net",
    canonicalStatus: "accepted_same_page",
    language: `en-${"a".repeat(40)}`,
    openGraph: { type: "profile", siteName: "private-contact@example.net" },
    observedResourceHosts: ["cdn.jsdelivr.net", `${"a".repeat(260)}.example.com`],
    declaredApplications: {
      generators: ["Next.js", `npm_${"z".repeat(48)}`],
      applicationNames: ["TED", "private-contact@example.net"],
    },
  };

  const footprint = reportExport.projectPageFootprint(report.evidence[0].canonicalSubset);
  assert.ok(footprint);
  assert.equal(footprint.title, null);
  assert.equal(footprint.description, null);
  assert.equal(footprint.canonicalUrl, null);
  assert.equal(footprint.canonicalStatus, null);
  assert.equal(footprint.language, null);
  assert.equal(footprint.openGraphType, "profile");
  assert.equal(footprint.openGraphSiteName, null);
  assert.deepEqual(footprint.generators, ["Next.js"]);
  assert.deepEqual(footprint.applicationNames, ["TED"]);
  assert.deepEqual(footprint.observedResourceHosts, ["cdn.jsdelivr.net"]);
  assert.equal(footprint.bounded, true);
  const durable = JSON.stringify(footprint);
  assert.doesNotMatch(durable, /private-contact@example\.net|sk-proj-|npm_z+|:8443|\?email=/);
});

test("long public URLs remain live and Unicode report text remains readable", () => {
  const viewModel = reportExport.createReportViewModel(terminalReport());
  const longSegment = "evidence-".repeat(45);
  viewModel.findings[0].description = "Café researcher 李 / Καλημέρα / résumé";
  viewModel.evidence[3].sourceUrl = `https://example.org/${longSegment}?source=atlas&view=public`;
  const markdown = reportExport.reportViewModelToMarkdown(viewModel);
  assert.match(markdown, /Café researcher 李 \/ Καλημέρα \/ résumé/);
  assert.match(markdown, /https:\/\/example\.org\/evidence-/);
  assert.match(markdown, /\]\(https:\/\/example\.org\//);
});

test("canonical graph telemetry and source-ladder frontier states are represented without trace payloads", () => {
  const viewModel = reportExport.createReportViewModel(terminalReport());
  assert.equal(viewModel.searchStrategy.graphAvailable, true);
  assert.equal(viewModel.searchStrategy.nodeCount, example.searchGraph.nodes.length);
  assert.equal(viewModel.searchStrategy.edgeCount, example.searchGraph.edges.length);
  assert.deepEqual(viewModel.searchStrategy.mutation, { proposed: 1, accepted: 0, rejected: 1 });
  const tierOne = viewModel.searchStrategy.sourceLadder.find((item) => item.tier === 1);
  const tierOneFrontier = example.searchGraph.frontier.filter((item) => item.sourceTier === 1);
  assert.equal(tierOne.frontierCount, tierOneFrontier.length);
  assert.equal(tierOne.verifiedCount, tierOneFrontier.filter((item) => item.status === "verified").length);
  assert.equal(tierOne.evidenceCount, 2);
  assert.equal(
    viewModel.searchStrategy.paths.some((item) => item.disposition === "mutation_rejected"),
    true,
  );
});

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", ".git", "dist", ".next"].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(absolute)));
    else if (/\.(?:ts|tsx|mts|mjs)$/.test(entry.name)) files.push(absolute);
  }
  return files;
}

test("React-PDF and Yoga stay behind one click-time browser-only module boundary", async () => {
  const files = await sourceFiles(projectRoot);
  const importers = [];
  for (const file of files) {
    const content = await readFile(file, "utf8");
    if (content.includes("@react-pdf/renderer")) importers.push(path.relative(projectRoot, file));
    if (!file.includes(`${path.sep}app${path.sep}report${path.sep}`)) {
      assert.doesNotMatch(content, /from\s+["'](?:@react-pdf\/renderer|yoga-layout)/);
    }
  }
  assert.deepEqual(importers, ["app/report/pdf-download.client.tsx", "tests/report-export.test.mjs", "vite.config.ts"]);
  const viteSource = await readFile(path.join(projectRoot, "vite.config.ts"), "utf8");
  assert.match(viteSource, /optimizeDeps:\s*\{\s*include:[^}]*@react-pdf\/renderer/);
  assert.doesNotMatch(viteSource, /from\s+["']@react-pdf\/renderer/);
  const pdfSource = await readFile(path.join(projectRoot, "app/report/pdf-download.client.tsx"), "utf8");
  const downloadSource = await readFile(path.join(projectRoot, "app/report/downloads.client.ts"), "utf8");
  assert.match(pdfSource, /^"use client";/);
  assert.match(downloadSource, /await import\("\.\/pdf-download\.client"\)/);
  assert.doesNotMatch(downloadSource, /from\s+["']@react-pdf\/renderer/);
  for (const contextLabel of [
    "Temporal comparison",
    "Observation window:",
    "Change dimensions:",
    "response body bytes",
    "normalized static-HTML text",
    "page-declared metadata",
    "static-HTML structure",
    "Static-HTML fragment counts:",
    "Changed metadata fields:",
    "Added in the later capture",
    "Removed by the later capture",
    "Page-declared footprint",
    "Footprint projection hash:",
    "Page title:",
    "Description:",
    "Canonical status:",
    "Canonical URL:",
    "Language:",
    "Open Graph type:",
    "Open Graph site name:",
    "Declared generators:",
    "Declared applications:",
    "Observed provider families:",
    "Referenced resource hosts:",
    "JSON-LD types:",
    "PUBLIC BRIEFING",
    "WHAT STILL NEEDS CONFIRMATION",
    "briefing.statusCaveat",
    "briefing.sourceCaveat",
    "briefing.sections.map",
    "FINDINGS",
    "FindingCard",
    "SUPPORTING CITATIONS",
    "COUNTER-EVIDENCE CITATIONS",
    "viewModel.findings.map",
    "TECHNICAL AUDIT",
    "decisionScoreLabel",
    "baseCandidateScoreLabel",
  ])
    assert.match(pdfSource, new RegExp(contextLabel));
});

test("React-PDF smoke produces application/pdf bytes", { skip: process.env.ATLAS_PDF_SMOKE !== "1" }, async () => {
  const pdfModule = await vite.ssrLoadModule("/app/report/pdf-download.client.tsx");
  const report = reportWithEvidenceContexts();
  const viewModel = reportExport.createReportViewModel(report);
  assert.equal(
    viewModel.evidence.some((item) => item.temporalComparison !== null),
    true,
  );
  const temporal = viewModel.evidence.find((item) => item.temporalComparison)?.temporalComparison;
  assert.equal(temporal?.bodyChanged, true);
  assert.equal(temporal?.visibleTextChanged, true);
  assert.equal(temporal?.addedFragmentCount, 8);
  assert.equal(temporal?.unchangedFragmentCount, 3);
  assert.equal(
    viewModel.evidence.some((item) => item.pageFootprint?.footprintHash === footprintProjectionHash),
    true,
  );
  const { blob } = await pdfModule.renderReportPdfBlob(viewModel);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.equal(blob.type, "application/pdf");
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
});

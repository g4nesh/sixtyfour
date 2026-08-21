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

after(async () => {
  await vite.close();
});

function graph(runId = example.runId) {
  const at = "2026-08-19T16:00:00.000Z";
  const utility = {
    relevance: 0.9,
    novelty: 0.8,
    informationGain: 0.7,
    sourceTrust: 0.9,
    executionCost: 0.2,
    policyRisk: 0.05,
    repetition: 0,
    depthPenalty: 0.1,
  };
  return {
    schemaVersion: 2,
    runId,
    status: "completed",
    seed: "Chris Anderson, TED",
    seedNodeId: "node-seed",
    nodes: [
      {
        schemaVersion: 2,
        id: "node-seed",
        kind: "seed",
        label: "Chris Anderson, TED",
        status: "verified",
        sourceTier: null,
        sourceLaneId: null,
        frontierEntryId: null,
        actionId: null,
        candidateId: null,
        evidenceId: null,
        findingId: null,
        ordinal: 1,
        data: {},
        createdAt: at,
        updatedAt: at,
      },
      {
        schemaVersion: 2,
        id: "node-source",
        kind: "source",
        label: "TED official profile",
        status: "verified",
        sourceTier: 1,
        sourceLaneId: "t1.first_party",
        frontierEntryId: "frontier-source",
        actionId: "frontier-source",
        candidateId: "chris_replay_candidate_0001",
        evidenceId: "chris_replay_evidence_0001",
        findingId: null,
        ordinal: 2,
        data: {},
        createdAt: at,
        updatedAt: at,
      },
      {
        schemaVersion: 2,
        id: "node-rejected",
        kind: "source",
        label: "Same-name candidate branch",
        status: "rejected",
        sourceTier: 4,
        sourceLaneId: "t4.reputable_media",
        frontierEntryId: "frontier-rejected",
        actionId: "frontier-rejected",
        candidateId: "chris_replay_candidate_0002",
        evidenceId: null,
        findingId: null,
        ordinal: 3,
        data: {},
        createdAt: at,
        updatedAt: at,
      },
    ],
    edges: [
      {
        schemaVersion: 2,
        id: "edge-source",
        fromNodeId: "node-seed",
        toNodeId: "node-source",
        kind: "expands",
        status: "verified",
        frontierEntryId: "frontier-source",
        actionId: "frontier-source",
        edgeCost: 0.3,
        pathCost: 0.3,
        ordinal: 1,
        createdAt: at,
      },
      {
        schemaVersion: 2,
        id: "edge-rejected",
        fromNodeId: "node-seed",
        toNodeId: "node-rejected",
        kind: "mutates",
        status: "rejected",
        frontierEntryId: "frontier-rejected",
        actionId: "frontier-rejected",
        edgeCost: 0.7,
        pathCost: 0.7,
        ordinal: 2,
        createdAt: at,
      },
    ],
    frontier: [
      {
        schemaVersion: 2,
        id: "frontier-source",
        frontierEntryId: "frontier-source",
        actionId: "frontier-source",
        nodeId: "node-source",
        parentNodeId: "node-seed",
        parentFrontierEntryId: null,
        status: "verified",
        sourceTier: 1,
        sourceLaneId: "t1.first_party",
        allowedTools: ["fetch_public_source"],
        intent: "Verify the official profile",
        queryHint: "TED Chris Anderson",
        candidateId: "chris_replay_candidate_0001",
        depth: 1,
        ordinal: 1,
        dedupeKey: "source",
        utility,
        edgeCost: 0.3,
        pathCost: 0.3,
        mutation: null,
        createdAt: at,
        updatedAt: at,
      },
      {
        schemaVersion: 2,
        id: "frontier-rejected",
        frontierEntryId: "frontier-rejected",
        actionId: "frontier-rejected",
        nodeId: "node-rejected",
        parentNodeId: "node-seed",
        parentFrontierEntryId: "frontier-source",
        status: "rejected",
        sourceTier: 4,
        sourceLaneId: "t4.reputable_media",
        allowedTools: ["search_web"],
        intent: "Check a bounded adjacent candidate",
        queryHint: "Chris Anderson adjacent source",
        candidateId: "chris_replay_candidate_0002",
        depth: 1,
        ordinal: 2,
        dedupeKey: "rejected",
        utility,
        edgeCost: 0.7,
        pathCost: 0.7,
        mutation: {
          strategy: "source_adjacent",
          parentFrontierEntryId: "frontier-source",
          proposalIndex: 0,
          temperature: 0.2,
          logAcceptanceRatio: -1,
          acceptanceProbability: 0.36,
          deterministicU: 0.8,
          parentNeighborCount: 1,
          candidateNeighborCount: 2,
        },
        createdAt: at,
        updatedAt: at,
      },
    ],
    selectedFrontierEntryIds: ["frontier-source", "frontier-rejected"],
    currentSourceTier: 4,
    nextOrdinal: 4,
    mutationStep: 1,
    telemetry: {
      seeded: 1,
      enqueued: 2,
      selected: 2,
      pruned: 0,
      expanded: 1,
      exhausted: 0,
      toolCalls: 1,
      mutationToolCalls: 0,
      mutationsProposed: 1,
      mutationsAccepted: 0,
      mutationsRejected: 1,
    },
    createdAt: at,
    updatedAt: at,
  };
}

function terminalReport() {
  return { ...structuredClone(example), schemaVersion: 2, searchGraph: graph() };
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
      jsonLdTypes: [" Person ", "Organization", "private-contact@example.net", `npm_${"x".repeat(48)}`],
      declaredApplications: {
        generators: ["Next.js", "private-contact@example.net"],
        applicationNames: ["TED", `npm_${"x".repeat(48)}`],
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
  report.evidence[1].excerpt = "Normalized archived profile text.";
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
        "private-contact@example.net",
      ],
      removedTextFragments: ["  Removed   the former curator wording. ", `sk-proj-${"y".repeat(48)}`],
      addedFragmentCount: 8,
      removedFragmentCount: 2,
      unchangedFragmentCount: 3,
      comparisonBounded: false,
      thenCaptureUrl: "https://example.org/DO_NOT_EXPORT_CAPTURE_URL",
      scopeNote: "DO_NOT_EXPORT_UNTRUSTED_TEMPORAL_SCOPE_NOTE",
    },
    arbitraryNestedPayload: { secret: "DO_NOT_EXPORT_CONTEXT_NESTED_PAYLOAD" },
  };
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
  assert.match(first.identity.rationale, new RegExp(`${report.candidates.length} distinct candidate branch`));
  assert.match(firstMarkdown, /Distinct candidate branches retained/);
  assert.match(firstMarkdown, /Top retained candidate profiles/);
  assert.match(firstMarkdown, /\*\*Candidate:\*\*/);
  for (const profile of first.identity.profiles) {
    assert.ok(Array.isArray(profile.evidenceRefs));
    assert.ok(Array.isArray(profile.findingIds));
    assert.ok(Array.isArray(profile.sourceDomains));
    assert.equal(Number.isInteger(profile.directSourceCount), true);
  }
});

test("discovery leads export as unverified metadata and never as exact excerpts", () => {
  const report = terminalReport();
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

  const viewModel = reportExport.createReportViewModel(report);
  const markdown = reportExport.reportViewModelToMarkdown(viewModel);
  assert.equal(viewModel.evidence[0].contentLabel, "Unverified discovery lead");
  assert.equal(viewModel.evidence[0].exactExcerpt, null);
  assert.match(markdown, /Unverified discovery lead/);
  assert.doesNotMatch(markdown, /Provider search surfaced this URL/);
});

test("sanitization escapes hostile Markdown and excludes unsafe URLs and raw payload-shaped fields", () => {
  const report = terminalReport();
  report.findings[0].title = "Hostile | [title] `tick`\u0007";
  report.findings[0].description = "# injected\n- list | [link](javascript:alert(1))";
  report.evidence[0].claim = "Claim | [break] `code`\u0001";
  report.evidence[0].excerpt = "Exact\n## heading | [x]";
  report.evidence[0].sourceUrl = "javascript:alert(1)";
  report.evidence[0].canonicalUrl = "javascript:alert(1)";
  report.evidence[0].canonicalSubset = { rawProviderSecret: "DO_NOT_EXPORT_PROVIDER_PAYLOAD" };
  report.evidence[0].attributes = { toolArguments: "DO_NOT_EXPORT_TOOL_ARGUMENTS" };
  report.evidence[1].excerpt = null;
  report.evidence[1].canonicalSubset = { projection: "DO_NOT_EXPORT_STRUCTURED_PAYLOAD" };
  report.rawTrace = { payload: "DO_NOT_EXPORT_RAW_TRACE" };

  const viewModel = reportExport.createReportViewModel(report);
  const markdown = reportExport.reportViewModelToMarkdown(viewModel);
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
  assert.equal(viewModel.evidence[0].sourceUrl, "");
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
  report.evidence[0].canonicalSubset.pageFootprintHash = "sha256:not-a-hash";
  report.evidence[1].canonicalSubset.temporalComparison.observedAfter = "2025-01-01T00:00:00.000Z";
  report.evidence[1].canonicalSubset.temporalComparison.observedOnOrBefore = "2024-01-01T00:00:00.000Z";

  const viewModel = reportExport.createReportViewModel(report);
  const markdown = reportExport.reportViewModelToMarkdown(viewModel);
  assert.equal(
    viewModel.evidence.every((item) => item.pageFootprint === null),
    true,
  );
  assert.equal(
    viewModel.evidence.every((item) => item.temporalComparison === null),
    true,
  );
  assert.doesNotMatch(
    markdown,
    /Page-declared footprint|Temporal comparison|Public page metadata retained from the already-fetched profile/,
  );
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
      reportExport.createReportViewModel(malformed).evidence.every((item) => item.temporalComparison === null),
      true,
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

  const viewModel = reportExport.createReportViewModel(report);
  const footprint = viewModel.evidence.find((item) => item.pageFootprint)?.pageFootprint;
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
  const durable = `${JSON.stringify(viewModel)}\n${reportExport.reportViewModelToMarkdown(viewModel)}`;
  assert.doesNotMatch(durable, /private-contact@example\.net|sk-proj-|npm_z+|:8443|\?email=/);
});

test("long public URLs remain live and Unicode report text remains readable", () => {
  const report = terminalReport();
  const longSegment = "evidence-".repeat(45);
  report.findings[0].description = "Café researcher 李 / Καλημέρα / résumé";
  report.evidence[0].canonicalUrl = `https://example.org/${longSegment}?source=atlas&view=public`;
  report.evidence[0].sourceUrl = report.evidence[0].canonicalUrl;

  const viewModel = reportExport.createReportViewModel(report);
  const markdown = reportExport.reportViewModelToMarkdown(viewModel);
  assert.match(markdown, /Café researcher 李 \/ Καλημέρα \/ résumé/);
  assert.match(markdown, /https:\/\/example\.org\/evidence-/);
  assert.match(markdown, /\]\(https:\/\/example\.org\//);
});

test("canonical graph telemetry and source-ladder frontier states are represented without trace payloads", () => {
  const viewModel = reportExport.createReportViewModel(terminalReport());
  assert.equal(viewModel.searchStrategy.graphAvailable, true);
  assert.equal(viewModel.searchStrategy.nodeCount, 3);
  assert.equal(viewModel.searchStrategy.edgeCount, 2);
  assert.deepEqual(viewModel.searchStrategy.mutation, { proposed: 1, accepted: 0, rejected: 1 });
  const tierOne = viewModel.searchStrategy.sourceLadder.find((item) => item.tier === 1);
  assert.equal(tierOne.frontierCount, 1);
  assert.equal(tierOne.verifiedCount, 1);
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
  ])
    assert.match(pdfSource, new RegExp(contextLabel));
});

test("React-PDF smoke produces application/pdf bytes", { skip: process.env.ATLAS_PDF_SMOKE !== "1" }, async () => {
  const pdfModule = await vite.ssrLoadModule("/app/report/pdf-download.client.tsx");
  const report = reportWithEvidenceContexts();
  report.evidence[0].disposition = "discovery_only";
  report.evidence[0].verificationMethod = "unverified";
  report.evidence[0].sourceType = "other";
  report.evidence[0].excerpt = null;
  report.evidence[0].reliability = 0;
  report.evidence[0].spoofable = true;
  report.evidence[0].attributes = {
    metadataObservation: true,
    findingAuthority: false,
    identityBinding: false,
    untrustedContent: true,
    fullBodyRetained: false,
    ownershipVerified: false,
  };
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
  assert.equal(
    viewModel.evidence.some((item) => item.contentLabel === "Passive page metadata observation"),
    true,
  );
  const { blob } = await pdfModule.renderReportPdfBlob(viewModel);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.equal(blob.type, "application/pdf");
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
});

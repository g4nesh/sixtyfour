import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const example = JSON.parse(await readFile(new URL("../examples/chris-anderson-ted/output.json", import.meta.url), "utf8"));
const vite = await createServer({
  root: projectRoot,
  configFile: false,
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
    for (const ref of [...finding.citations, ...finding.counterCitations]) {
      assert.equal(references.has(ref), true, `${finding.id} cites unknown ${ref}`);
      assert.match(firstMarkdown, new RegExp(`<a id="${ref.toLocaleLowerCase("en-US")}"></a>`));
    }
  }
  assert.match(firstMarkdown, /Exact source excerpt/);
  assert.match(firstMarkdown, /Mutations rejected\s*\| 1/);
  assert.match(firstMarkdown, /Mutation Rejected/);
  assert.match(firstMarkdown, /Frontier entry states/);
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
  assert.equal([...markdown].some((character) => {
    const code = character.codePointAt(0);
    return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31);
  }), false);
  assert.match(markdown, /Hostile \\| \\\[title\\\] \\`tick\\`\\u0007/);
  assert.match(markdown, /Exact source excerpt/);
  assert.doesNotMatch(markdown, /\n# injected|javascript:|DO_NOT_EXPORT_PROVIDER_PAYLOAD|DO_NOT_EXPORT_STRUCTURED_PAYLOAD|DO_NOT_EXPORT_TOOL_ARGUMENTS|DO_NOT_EXPORT_RAW_TRACE/);
  assert.equal(viewModel.evidence[0].sourceUrl, "");
  assert.equal(viewModel.evidence[1].contentLabel, "Structured API claim");
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
  assert.equal(viewModel.searchStrategy.paths.some((item) => item.disposition === "mutation_rejected"), true);
});

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", ".git", "dist", ".next"].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(absolute));
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
  assert.deepEqual(importers, ["app/report/pdf-download.client.tsx", "tests/report-export.test.mjs"]);
  const pdfSource = await readFile(path.join(projectRoot, "app/report/pdf-download.client.tsx"), "utf8");
  const downloadSource = await readFile(path.join(projectRoot, "app/report/downloads.client.ts"), "utf8");
  assert.match(pdfSource, /^"use client";/);
  assert.match(downloadSource, /await import\("\.\/pdf-download\.client"\)/);
  assert.doesNotMatch(downloadSource, /from\s+["']@react-pdf\/renderer/);
});

test("React-PDF smoke produces application/pdf bytes", { skip: process.env.ATLAS_PDF_SMOKE !== "1" }, async () => {
  const pdfModule = await vite.ssrLoadModule("/app/report/pdf-download.client.tsx");
  const viewModel = reportExport.createReportViewModel(terminalReport());
  const { blob } = await pdfModule.renderReportPdfBlob(viewModel);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.equal(blob.type, "application/pdf");
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
});

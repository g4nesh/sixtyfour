import { readFile } from "node:fs/promises";

const exampleOutputUrl = new URL("../../examples/chris-anderson-ted/output.json", import.meta.url);
const exampleTraceUrl = new URL("../../examples/chris-anderson-ted/trace.json", import.meta.url);

export const reportEvidenceContextFixture = {
  footprint: {
    schemaVersion: "public_page_footprint_v1",
    title: "Chris Anderson — TED speaker profile",
    description: "Public page metadata retained from the already-fetched profile.",
    canonicalUrl: "https://www.ted.com/speakers/chris_anderson_ted",
    canonicalStatus: "accepted_same_page",
    language: "en",
    openGraph: { type: "profile", siteName: "TED" },
    declaredApplications: { generators: ["Next.js"], applicationNames: ["TED"] },
    jsonLdTypes: ["Person", "Organization"],
    observedResourceHosts: ["cdn.jsdelivr.net", "static.cloudflareinsights.com"],
    observedProviderFamilies: ["jsdelivr", "cloudflare"],
    bounded: false,
    spoofable: true,
    scopeNote: "Fixture metadata is page-declared and does not establish hosting ownership.",
  },
  temporal: {
    observedAfter: "2020-01-01T00:00:00.000Z",
    observedOnOrBefore: "2024-01-01T00:00:00.000Z",
    thenCaptureUrl: "https://web.archive.org/web/20200101000000id_/https://www.ted.com/speakers/chris_anderson_ted",
    nowCaptureUrl: "https://web.archive.org/web/20240101000000id_/https://www.ted.com/speakers/chris_anderson_ted",
    bodyChanged: true,
    visibleTextChanged: true,
    metadataChanged: true,
    structureChanged: false,
    changedMetadataFields: ["title", "description"],
    addedTextFragments: ["Chris Anderson became TED's founder and chairman."],
    removedTextFragments: ["Chris Anderson served as TED's curator."],
    addedFragmentCount: 1,
    removedFragmentCount: 1,
    unchangedFragmentCount: 3,
    comparisonBounded: true,
    scopeNote: "Fixture comparison binds only the two captured responses and does not identify an editor.",
  },
  bodyOnlyTemporal: {
    observedAfter: "2024-01-01T00:00:00.000Z",
    observedOnOrBefore: "2025-01-01T00:00:00.000Z",
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
  },
};

function prefixGraph(graph, nodeCount) {
  const nodes = [...graph.nodes]
    .sort((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id))
    .slice(0, nodeCount);
  const nodeIds = new Set(nodes.map((node) => node.id));
  return {
    ...structuredClone(graph),
    status: "active",
    nodes,
    edges: graph.edges.filter((edge) => nodeIds.has(edge.fromNodeId) && nodeIds.has(edge.toNodeId)),
    frontier: graph.frontier.filter((entry) => nodeIds.has(entry.nodeId)),
    selectedFrontierEntryIds: graph.selectedFrontierEntryIds.filter((id) =>
      graph.frontier.some((entry) => entry.id === id && nodeIds.has(entry.nodeId)),
    ),
  };
}

export async function denseReplayFixture() {
  const [report, trace] = await Promise.all([
    readFile(exampleOutputUrl, "utf8").then(JSON.parse),
    readFile(exampleTraceUrl, "utf8").then(JSON.parse),
  ]);
  if (report.evidence.length < 2) {
    throw new Error("The dense browser fixture needs separate footprint and temporal evidence records.");
  }
  report.evidence[0].canonicalSubset = {
    ...(report.evidence[0].canonicalSubset ?? {}),
    pageFootprint: structuredClone(reportEvidenceContextFixture.footprint),
    pageFootprintHash: `sha256:${"d".repeat(64)}`,
  };
  report.evidence[1].canonicalSubset = {
    ...(report.evidence[1].canonicalSubset ?? {}),
    temporalComparison: structuredClone(reportEvidenceContextFixture.temporal),
  };
  if (report.evidence.length < 3) {
    throw new Error("The dense browser fixture needs one hostile unbound context record.");
  }
  report.evidence[2].canonicalSubset = {
    ...(report.evidence[2].canonicalSubset ?? {}),
    pageFootprint: {
      ...structuredClone(reportEvidenceContextFixture.footprint),
      observedResourceHosts: ["ATLAS_CONTEXT_SENTINEL_SHOULD_NOT_RENDER.example"],
    },
    temporalComparison: {
      ...structuredClone(reportEvidenceContextFixture.temporal),
      observedAfter: "2025-01-01T00:00:00.000Z",
      observedOnOrBefore: "2024-01-01T00:00:00.000Z",
      addedTextFragments: ["ATLAS_CONTEXT_SENTINEL_SHOULD_NOT_RENDER"],
    },
  };
  report.evidence[3].verificationMethod = "archive_snapshot";
  report.evidence[3].sourceType = "web_archive";
  report.evidence[3].excerpt = "A bounded normalized static-HTML projection was retained.";
  report.evidence[3].canonicalSubset = {
    temporalComparison: structuredClone(reportEvidenceContextFixture.bodyOnlyTemporal),
  };
  const terminal = structuredClone(trace.at(-1));
  if (terminal?.name !== "result.terminal" || !terminal.payload?.report) {
    throw new Error("The dense browser fixture must end in one result.terminal report.");
  }
  const graph = report.searchGraph;
  const searchFrontier = graph.frontier.find(
    (entry) => entry.allowedTools.includes("search_web") && /(?:^|\s)site:/i.test(entry.queryHint),
  );
  if (!searchFrontier) throw new Error("The dense browser fixture needs one site-scoped search frontier.");
  const snapshotCounts = [5, 11].filter((count) => count < graph.nodes.length);
  const snapshots = snapshotCounts.map((count, index) => ({
    schemaVersion: 2,
    seq: index + 1,
    eventId: `browser_fixture_snapshot_${index + 1}`,
    runId: graph.runId,
    timestamp: graph.createdAt,
    elapsedMs: (index + 1) * 25,
    kind: index === 0 ? "span_start" : "span_end",
    name: "tool.search_web",
    phase: "discover",
    spanId: "browser_fixture_search_span",
    parentSpanId: null,
    attempt: 1,
    status: index === 0 ? "running" : "not_found",
    payload: {
      searchGraph: prefixGraph(graph, count),
      actionId: searchFrontier.actionId,
      frontierEntryId: searchFrontier.id,
      sourceTier: searchFrontier.sourceTier,
      sourceLaneId: searchFrontier.sourceLaneId,
      ...(index === 0
        ? { arguments: { query: searchFrontier.queryHint } }
        : {
            diagnostics: [
              {
                code: "search_provider_quota_exhausted",
                severity: "warning",
                message: "The configured web-search provider exhausted its retryable quota.",
                retryable: true,
              },
              {
                code: "google_results_not_observed",
                severity: "info",
                message: "The bounded Google public search returned no safe HTTPS result leads.",
                retryable: false,
              },
              {
                code: "duckduckgo_results_not_observed",
                severity: "info",
                message: "The bounded keyless public search returned no safe HTTPS result leads.",
                retryable: false,
              },
              {
                code: "github_exact_name_not_observed",
                severity: "info",
                message: "No exact public-name match was observed in bounded GitHub user records.",
                retryable: false,
              },
              {
                code: "semantic_scholar_exact_name_not_observed",
                severity: "info",
                message: "No exact public-name match was observed in bounded Semantic Scholar author records.",
                retryable: false,
              },
              {
                code: "crossref_exact_author_not_observed",
                severity: "info",
                message: "No exact author match was observed in bounded Crossref works records.",
                retryable: false,
              },
            ],
          }),
    },
    usage: null,
  }));
  terminal.seq = snapshots.length + 1;
  terminal.eventId = "browser_fixture_terminal";
  terminal.payload.report = report;
  return {
    graph,
    report,
    events: [...snapshots, terminal],
    ndjson: [...snapshots, terminal].map((event) => JSON.stringify(event)).join("\n") + "\n",
  };
}

export function intersectingRectangles(rectangles, tolerance = 0.75) {
  const collisions = [];
  for (let leftIndex = 0; leftIndex < rectangles.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < rectangles.length; rightIndex += 1) {
      const left = rectangles[leftIndex];
      const right = rectangles[rightIndex];
      const width = Math.min(left.right, right.right) - Math.max(left.left, right.left);
      const height = Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top);
      if (width > tolerance && height > tolerance) {
        collisions.push({ left: left.id, right: right.id, width, height });
      }
    }
  }
  return collisions;
}

export function graphChromeCollisions(nodes, chrome, tolerance = 0.75) {
  const collisions = [];
  for (const node of nodes) {
    for (const item of chrome) {
      const width = Math.min(node.right, item.right) - Math.max(node.left, item.left);
      const height = Math.min(node.bottom, item.bottom) - Math.max(node.top, item.top);
      if (width > tolerance && height > tolerance) {
        collisions.push({ node: node.id, chrome: item.id, width, height });
      }
    }
  }
  return collisions;
}

export function chromeChromeCollisions(chrome, tolerance = 0.75) {
  return intersectingRectangles(chrome, tolerance);
}

export const chromeSelectors = [
  ".scope-row",
  ".graph-toolbar",
  ".workspace-status",
  ".source-ladder",
  ".node-inspector",
  ".graph-legend",
  ".trace-rail",
  ".atlas-flow-controls",
  ".atlas-minimap",
];

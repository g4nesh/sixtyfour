import { readFile } from "node:fs/promises";

const exampleOutputUrl = new URL("../../examples/chris-anderson-ted/output.json", import.meta.url);
const exampleTraceUrl = new URL("../../examples/chris-anderson-ted/trace.json", import.meta.url);

export const fictionalResearchQuery = "Avery Rowan, Northstar Forum";

const forbiddenFictionalFixturePatterns = [
  ["real target name", /chris|anderson/i],
  ["real target organization or domain", /(?:^|[^a-z])ted(?:$|[^a-z])|ted\.com/i],
  ["real secondary organization or domain", /wired|3d robotics|airware/i],
  ["real-target distinctive claim", /third-largest producer of drones/i],
  ["gendered pronoun", /\b(?:he|him|his|she|her|hers)\b/i],
];

function fictionalizeFixtureText(value) {
  return value
    .replace(
      /\(He is not, however, to be confused with the curator of TED, who has the same name\.\)/gi,
      "A separate same-name professional branch is not the Northstar Forum curator.",
    )
    .replace(
      /he is not however to be confused with the curator of ted who has the same name\.?/gi,
      "a separate same-name professional branch is not the northstar forum curator.",
    )
    .replace(/confused with the curator of TED/gi, "separate same-name professional branch")
    .replace(
      /CEO of the world's third-largest producer of drones \(and a former editor-in-chief of WIRED US\)/gi,
      "a public robotics executive and former editor of Northstar Review",
    )
    .replace(
      /ceo of the world s third-largest producer of drones and a former editor-in-chief of wired us/gi,
      "a public robotics executive and former editor of northstar review",
    )
    .replaceAll("chris_anderson_ted", "avery_rowan_forum")
    .replaceAll("chris_anderson_wired", "avery_rowan_review")
    .replaceAll("chris_anderson", "avery_rowan")
    .replaceAll("chris-anderson-ted", "avery-rowan-northstar")
    .replaceAll("chris-anderson", "avery-rowan")
    .replaceAll("chris_replay", "avery_replay")
    .replaceAll("chris replay", "avery replay")
    .replaceAll("Chris Anderson", "Avery Rowan")
    .replaceAll("chris anderson", "avery rowan")
    .replace(/www\.ted\.com/gi, "profiles.example.org")
    .replace(/ted\.com/gi, "profiles.example.org")
    .replace(/www\.wired\.com/gi, "review.example.net")
    .replace(/wired\.com/gi, "review.example.net")
    .replace(/\bTED Conference\b/g, "Northstar Forum")
    .replace(/\bted conference\b/g, "northstar forum")
    .replace(/\bTED\b/g, "Northstar Forum")
    .replace(/\bted\b/g, "northstar forum")
    .replace(/\bWIRED US\b/g, "Northstar Review")
    .replace(/\bWIRED\b/g, "Northstar Review")
    .replace(/\bwired\b/g, "northstar review")
    .replace(/\b3D Robotics\b/gi, "Stratos Robotics")
    .replace(/airware-drones/gi, "skyloom-systems")
    .replace(/\bAirware\b/gi, "Skyloom Systems");
}

function fictionalizeReplay(value) {
  if (typeof value === "string") return fictionalizeFixtureText(value);
  if (Array.isArray(value)) return value.map(fictionalizeReplay);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fictionalizeReplay(item)]));
  }
  return value;
}

export function assertFictionalReplay(value, path = "fixture") {
  if (typeof value === "string") {
    for (const [label, pattern] of forbiddenFictionalFixturePatterns) {
      if (pattern.test(value)) throw new Error(`${path} retained ${label}: ${JSON.stringify(value)}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertFictionalReplay(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      for (const [label, pattern] of forbiddenFictionalFixturePatterns) {
        if (pattern.test(key)) throw new Error(`${path} retained ${label} in key ${JSON.stringify(key)}`);
      }
      assertFictionalReplay(item, `${path}.${key}`);
    }
  }
}

export const reportEvidenceContextFixture = {
  footprint: {
    schemaVersion: "public_page_footprint_v1",
    title: "Avery Rowan — Northstar Forum profile",
    description: "Public page metadata retained from the already-fetched profile.",
    canonicalUrl: "https://profiles.example.org/people/avery_rowan",
    canonicalStatus: "accepted_same_page",
    language: "en",
    openGraph: { type: "profile", siteName: "Northstar Forum" },
    declaredApplications: { generators: ["Next.js"], applicationNames: ["Northstar Forum"] },
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
    thenCaptureUrl: "https://web.archive.org/web/20200101000000id_/https://profiles.example.org/people/avery_rowan",
    nowCaptureUrl: "https://web.archive.org/web/20240101000000id_/https://profiles.example.org/people/avery_rowan",
    bodyChanged: true,
    visibleTextChanged: true,
    metadataChanged: true,
    structureChanged: false,
    changedMetadataFields: ["title", "description"],
    addedTextFragments: ["Avery Rowan became Northstar Forum's founder and chair."],
    removedTextFragments: ["Avery Rowan served as Northstar Forum's curator."],
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
  const [sourceReport, sourceTrace] = await Promise.all([
    readFile(exampleOutputUrl, "utf8").then(JSON.parse),
    readFile(exampleTraceUrl, "utf8").then(JSON.parse),
  ]);
  const report = fictionalizeReplay(sourceReport);
  const trace = fictionalizeReplay(sourceTrace);
  assertFictionalReplay(report, "denseReplayFixture.report");
  assertFictionalReplay(trace, "denseReplayFixture.trace");
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
  const fixture = {
    graph,
    report,
    events: [...snapshots, terminal],
    ndjson: [...snapshots, terminal].map((event) => JSON.stringify(event)).join("\n") + "\n",
  };
  assertFictionalReplay(fixture, "denseReplayFixture");
  return fixture;
}

/**
 * Exercise the live-dashboard scale that previously saturated React Flow's
 * shared node ResizeObserver. The synthetic nodes carry no evidence or person
 * claims; this fixture exists only to stress graph rendering and viewport work.
 */
export async function highNodeCountGraphFixture(nodeCount = 249, snapshotNodeCounts = [121, 185]) {
  if (!Number.isSafeInteger(nodeCount) || nodeCount < 2) {
    throw new Error("The high-node-count browser fixture needs at least two nodes.");
  }
  if (
    !Array.isArray(snapshotNodeCounts) ||
    snapshotNodeCounts.some(
      (count, index) =>
        !Number.isSafeInteger(count) ||
        count < 2 ||
        count >= nodeCount ||
        (index > 0 && count <= snapshotNodeCounts[index - 1]),
    )
  ) {
    throw new Error("High-node-count snapshot sizes must be unique ascending integers below the terminal size.");
  }
  const fixture = await denseReplayFixture();
  const report = structuredClone(fixture.report);
  const baseGraph = fixture.graph;
  const nodes = structuredClone(baseGraph.nodes);
  const edges = structuredClone(baseGraph.edges);
  const frontier = structuredClone(baseGraph.frontier);
  const rootEntry = frontier.find(
    (entry) => entry.parentFrontierEntryId === null && entry.parentNodeId === baseGraph.seedNodeId,
  );
  const pivotTemplate = rootEntry ? nodes.find((node) => node.id === rootEntry.nodeId) : undefined;
  const edgeTemplate = rootEntry
    ? edges.find(
        (edge) =>
          edge.kind === "expands" &&
          edge.fromNodeId === rootEntry.parentNodeId &&
          edge.toNodeId === rootEntry.nodeId &&
          edge.frontierEntryId === rootEntry.id,
      )
    : undefined;
  if (!rootEntry || !pivotTemplate || !edgeTemplate) {
    throw new Error("The high-node-count browser fixture needs one canonical root frontier branch.");
  }
  if (nodeCount <= nodes.length) {
    throw new Error(`The high-node-count browser fixture must exceed its ${nodes.length}-node canonical base graph.`);
  }
  let nextOrdinal = Math.max(
    baseGraph.nextOrdinal,
    ...nodes.map((node) => node.ordinal + 1),
    ...edges.map((edge) => edge.ordinal + 1),
  );
  for (let index = nodes.length; index < nodeCount; index += 1) {
    const suffix = String(index + 1).padStart(4, "0");
    const id = `high_density_graph_node_${suffix}`;
    const frontierEntryId = `high_density_graph_frontier_${suffix}`;
    const status = index % 2 === 0 ? "rejected" : "exhausted";
    const queryHint = `synthetic public-source render branch ${index}`;
    const intent = `Exercise bounded graph rendering for synthetic branch ${index}.`;
    frontier.push({
      ...structuredClone(rootEntry),
      id: frontierEntryId,
      frontierEntryId,
      actionId: frontierEntryId,
      nodeId: id,
      status,
      intent,
      queryHint,
      candidateId: null,
      ordinal: nextOrdinal++,
      dedupeKey: `high-density-render:${suffix}`,
      mutation: null,
    });
    nodes.push({
      ...structuredClone(pivotTemplate),
      id,
      label: `Bounded public-source branch ${index}`,
      status,
      sourceTier: rootEntry.sourceTier,
      sourceLaneId: rootEntry.sourceLaneId,
      frontierEntryId,
      actionId: frontierEntryId,
      candidateId: null,
      evidenceId: null,
      findingId: null,
      ordinal: nextOrdinal++,
      data: { renderStressFixture: true, intent, queryHint },
    });
    edges.push({
      ...structuredClone(edgeTemplate),
      id: `high_density_graph_edge_${suffix}`,
      fromNodeId: rootEntry.parentNodeId,
      toNodeId: id,
      kind: "expands",
      status,
      frontierEntryId,
      actionId: frontierEntryId,
      edgeCost: rootEntry.edgeCost,
      pathCost: rootEntry.pathCost,
      ordinal: nextOrdinal++,
    });
  }
  const graph = {
    ...structuredClone(baseGraph),
    status: "completed",
    nodes,
    edges,
    frontier,
    nextOrdinal,
    telemetry: {
      ...baseGraph.telemetry,
      enqueued: frontier.length,
      selected: frontier.length,
      expanded: frontier.filter((entry) => entry.status === "verified").length,
      exhausted: frontier.filter((entry) => entry.status === "exhausted").length,
    },
  };
  report.searchGraph = graph;
  const terminal = structuredClone(fixture.events.at(-1));
  const snapshots = snapshotNodeCounts.map((count, index) => {
    const event = structuredClone(fixture.events[0]);
    event.seq = index + 1;
    event.eventId = `browser_high_density_snapshot_${index + 1}`;
    event.payload.searchGraph = prefixGraph(graph, count);
    return event;
  });
  terminal.seq = snapshots.length + 1;
  terminal.eventId = "browser_high_density_terminal";
  terminal.payload.searchGraph = graph;
  terminal.payload.report = report;
  const result = { graph, report, events: [...snapshots, terminal] };
  assertFictionalReplay(result, "highNodeCountGraphFixture");
  return result;
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

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test, { after } from "node:test";
import { createServer } from "vite";

const vite = await createServer({
  configFile: false,
  cacheDir: `node_modules/.vite-atlas-ssr/${process.pid}`,
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true },
});
after(async () => vite.close());

const replay = await vite.ssrLoadModule("/lib/replay/catalog.ts");
const api = await vite.ssrLoadModule("/lib/api/router.ts");
const integrity = await vite.ssrLoadModule("/lib/domain/integrity.ts");
const validation = await vite.ssrLoadModule("/lib/domain/validation.ts");
const traceContract = await vite.ssrLoadModule("/lib/agent/trace.ts");
const domain = await vite.ssrLoadModule("/lib/domain/index.ts");
const captureContract = await vite.ssrLoadModule("/scripts/capture-contract.ts");
const search = await vite.ssrLoadModule("/lib/search/index.ts");

const expectedIds = ["chris-anderson-ted", "linus-codegraph", "python-creator"];

function parseNdjson(text) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function terminalReport(events) {
  return events.at(-1)?.payload?.report ?? null;
}

function rawReplay(example) {
  return structuredClone({
    input: example.input,
    output: example.output,
    trace: example.trace,
    cassette: example.cassette,
    manifest: example.manifest,
  });
}

const INVESTIGATION_TO_GRAPH_STATUS = {
  running: "active",
  completed: "completed",
  blocked: "blocked",
  canceled: "canceled",
  failed: "failed",
  configuration_error: "failed",
  partial: "exhausted",
  ambiguous: "exhausted",
};

function syncTerminalReport(bundle) {
  // Keep the canonical graph status consistent with the report status so a
  // status mutation exercises the intended deeper legality check rather than
  // tripping the schema-level status/graph-status match first.
  const graphStatus = INVESTIGATION_TO_GRAPH_STATUS[bundle.output.status];
  if (graphStatus) bundle.output.searchGraph.status = graphStatus;
  const terminal = bundle.trace.at(-1);
  assert.equal(terminal.name, "result.terminal");
  terminal.payload.report = structuredClone(bundle.output);
  terminal.payload.status = bundle.output.status;
  terminal.payload.stopReason = bundle.output.stop.reason;
}

function forbiddenTraceKey(value, path = []) {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = forbiddenTraceKey(value[index], [...path, String(index)]);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (
      [
        "analysis",
        "chainofthought",
        "cot",
        "hiddenreasoning",
        "internalmonologue",
        "reasoning",
        "reasoningcontent",
        "scratchpad",
        "thinking",
        "thinkingcontent",
      ].includes(normalized)
    ) {
      return [...path, key].join(".");
    }
    const found = forbiddenTraceKey(child, [...path, key]);
    if (found) return found;
  }
  return null;
}

test("repository contains exactly three complete captured replay directories", async () => {
  const entries = await readdir(new URL("../examples/", import.meta.url), { withFileTypes: true });
  assert.deepEqual(
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(),
    expectedIds,
  );
  for (const id of expectedIds) {
    const files = await readdir(new URL(`../examples/${id}/`, import.meta.url));
    assert.deepEqual(files.sort(), ["cassette.json", "input.json", "manifest.json", "output.json", "trace.json"]);
    const manifest = JSON.parse(await readFile(new URL(`../examples/${id}/manifest.json`, import.meta.url), "utf8"));
    assert.equal(manifest.captureMode, "source_verified_scripted_reconstruction");
    assert.equal(manifest.replayMode, "deterministic_zero_network");
    assert.equal(manifest.decisionProvenance, "scripted_local_policy");
    assert.equal(manifest.provider, null);
    assert.equal(manifest.networkOnReplay, "forbidden");
  }
});

test("example evidence uses only root-verified exact excerpts or canonical API projections", () => {
  for (const id of expectedIds) {
    const example = replay.getReplayExample(id);
    assert.equal(example.manifest.capturedAt, captureContract.VERIFIED_CAPTURED_AT);
    const actionCaptureIds = Object.fromEntries(
      example.cassette.requests.map((request) => [request.id, request.captureId]),
    );
    assert.doesNotThrow(() =>
      captureContract.assertVerifiedEvidenceContract(example.output.evidence, actionCaptureIds),
    );
    for (const evidence of example.output.evidence) {
      const request = example.cassette.requests.find((item) => item.id === evidence.toolCallId);
      assert.ok(request, `${id} evidence ${evidence.id} lacks an action-bound cassette request`);
      const capture = captureContract.VERIFIED_PUBLIC_CAPTURES[request.captureId];
      assert.ok(capture, `${id} evidence ${evidence.id} lacks a verified capture`);
      assert.equal(evidence.contentHash, `sha256:${capture.bodySha256}`);
      if (evidence.verificationMethod === "direct_fetch") {
        assert.equal(evidence.claim, evidence.excerpt);
        assert.ok(capture.directExcerpts.includes(evidence.excerpt));
      } else {
        assert.equal(evidence.verificationMethod, "api_response");
        assert.equal(evidence.excerpt, null);
        assert.equal(evidence.claim, capture.apiClaim);
        assert.deepEqual(evidence.canonicalSubset, capture.canonicalSubset);
      }
    }
    for (const request of example.cassette.requests) {
      assert.equal(request.id, request.actionId);
      assert.equal(request.id, request.frontierEntryId);
      const capture = captureContract.VERIFIED_PUBLIC_CAPTURES[request.captureId];
      assert.ok(capture, `${id} cassette request ${request.captureId} lacks a verified capture`);
      assert.equal(request.response.bodySha256, capture.bodySha256);
      if (capture.requestFingerprint) {
        assert.equal(request.fingerprint, capture.requestFingerprint);
      }
    }
  }

  const codegraph = replay.getReplayExample("linus-codegraph");
  const searchRequest = codegraph.cassette.requests.find((request) => request.captureId === "req-github-search");
  const commitRequest = codegraph.cassette.requests.find((request) => request.captureId === "req-github-commit");
  const strongestSha = searchRequest.response.canonicalSubset.strongest_sha;
  assert.equal(strongestSha, captureContract.VERIFIED_GITHUB_STRONGEST_SHA);
  assert.equal(commitRequest.response.canonicalSubset.sha, strongestSha);
  assert.match(commitRequest.fingerprint, new RegExp(`/commits/${strongestSha} `));
  const commitEvidence = codegraph.output.evidence.find((evidence) => evidence.toolCallId === commitRequest.id);
  assert.equal(commitEvidence.canonicalSubset.sha, strongestSha);
  assert.equal(commitEvidence.sourceUrl, `https://github.com/torvalds/linux/commit/${strongestSha}`);
  assert.equal(commitEvidence.queryUrl, `https://api.github.com/repos/torvalds/linux/commits/${strongestSha}`);
});

test("replays are canonical byte-stable and require no outbound fetch", () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("replay attempted network");
  };
  try {
    for (const id of expectedIds) {
      const first = replay.getReplayExample(id);
      const second = replay.getReplayExample(id);
      assert.notEqual(first, second);
      assert.equal(replay.canonicalJson(first.output), replay.canonicalJson(second.output));
      assert.equal(replay.canonicalJson(first.trace), replay.canonicalJson(second.trace));
    }
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("synchronous replay SHA-256 draws equal independent Web Crypto digests", async () => {
  for (const seed of [
    "replay-linus-codegraph-v2|torvalds@linux-foundation.org|action_fixture|0|strategy",
    "Atlas deterministic mutation draw — UTF-8",
  ]) {
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(seed)));
    const high = digest[0] * 0x1000000 + (digest[1] << 16) + (digest[2] << 8) + digest[3];
    const low = ((digest[4] << 16) | (digest[5] << 8) | digest[6]) >>> 0;
    const expected = (high * 0x200000 + (low & 0x1fffff) + 0.5) / 0x20000000000000;
    assert.equal(search.deterministicSha256UnitSync(seed), expected);
  }
});

test("replays retain the canonical best-first execution graph and source hierarchy", () => {
  for (const id of expectedIds) {
    const example = replay.getReplayExample(id);
    const graph = example.output.searchGraph;
    assert.equal(example.output.schemaVersion, 2);
    assert.match(example.output.runId, /-v2$/);
    assert.equal(graph.schemaVersion, 2);
    assert.equal(graph.status, "completed");
    assert.ok(graph.seedNodeId);
    assert.ok(graph.nodes.some((node) => node.id === graph.seedNodeId && node.kind === "seed"));
    assert.ok(graph.frontier.some((entry) => entry.status === "verified"));
    assert.ok(graph.frontier.some((entry) => entry.status === "exhausted"));
    assert.ok(graph.frontier.some((entry) => entry.status === "queued" || entry.status === "mutated"));
    assert.ok(graph.frontier.some((entry) => entry.mutation));
    for (const entry of graph.frontier) {
      assert.equal(entry.id, entry.frontierEntryId);
      assert.equal(entry.id, entry.actionId);
      assert.ok(Number.isFinite(entry.edgeCost) && entry.edgeCost > 0);
      assert.ok(Number.isFinite(entry.pathCost) && entry.pathCost > 0);
    }
    for (const edge of graph.edges) {
      assert.ok(Number.isFinite(edge.edgeCost) && edge.edgeCost > 0);
      assert.ok(Number.isFinite(edge.pathCost) && edge.pathCost > 0);
    }
    for (const evidence of example.output.evidence) {
      const action = graph.frontier.find((entry) => entry.id === evidence.toolCallId);
      assert.ok(action, `${id} evidence ${evidence.id} has no frontier action`);
      const evidenceNode = graph.nodes.find((node) => node.evidenceId === evidence.id);
      assert.equal(evidenceNode.actionId, action.id);
      assert.equal(evidenceNode.frontierEntryId, action.id);
    }
    const eventNames = new Set(example.trace.map((event) => event.name));
    for (const name of [
      "frontier.seeded",
      "frontier.enqueued",
      "frontier.selected",
      "frontier.expanded",
      "source.tier_advanced",
      "mutation.proposed",
      "graph.node_admitted",
      "graph.edge_admitted",
      "graph.completed",
    ]) {
      assert.ok(eventNames.has(name), `${id} trace is missing ${name}`);
    }
    assert.ok(eventNames.has("mutation.accepted") || eventNames.has("mutation.rejected"));
  }

  const linus = replay.getReplayExample("linus-codegraph");
  const captureEntry = (captureId) => {
    const request = linus.cassette.requests.find((item) => item.captureId === captureId);
    return linus.output.searchGraph.frontier.find((entry) => entry.id === request.id);
  };
  assert.equal(captureEntry("req-github-search").sourceLaneId, "t0.explicit_email_codegraph");
  assert.equal(captureEntry("req-linux-doc").sourceLaneId, "t2.structured_professional");
  assert.equal(captureEntry("req-linux-foundation").sourceLaneId, "t1.first_party");
  assert.equal(captureEntry("req-github-commit").sourceLaneId, "t2.structured_professional");
  assert.equal(captureEntry("req-keybase").status, "exhausted");
  assert.equal(linus.output.searchGraph.telemetry.mutationToolCalls, 0);
  const acceptedMutation = linus.output.searchGraph.frontier.find((entry) => entry.mutation);
  assert.equal(acceptedMutation.status, "mutated");
  assert.equal(
    linus.trace.some((event) => event.kind === "span_start" && event.payload.actionId === acceptedMutation.id),
    false,
  );
  for (const toolSpan of linus.trace.filter((event) => event.kind === "span_start" && event.name.startsWith("tool."))) {
    const entry = linus.output.searchGraph.frontier.find((item) => item.id === toolSpan.payload.actionId);
    assert.ok(entry.allowedTools.includes(toolSpan.name.slice("tool.".length)));
  }

  const chris = replay.getReplayExample("chris-anderson-ted");
  const chrisGraph = chris.output.searchGraph;
  const candidateNodes = chrisGraph.nodes.filter((node) => node.kind === "candidate");
  assert.equal(candidateNodes.length, 2);
  assert.ok(candidateNodes.some((node) => node.status === "rejected"));
  assert.ok(chrisGraph.edges.some((edge) => edge.kind === "separates" && edge.status === "rejected"));
  const chrisCaptureLane = (captureId) => {
    const request = chris.cassette.requests.find((item) => item.captureId === captureId);
    return chrisGraph.frontier.find((entry) => entry.id === request.id).sourceLaneId;
  };
  assert.equal(chrisCaptureLane("req-ted-selected"), "t1.first_party");
  assert.equal(chrisCaptureLane("req-ted-decoy"), "t3.institutional");
  assert.equal(chrisCaptureLane("req-wired-decoy"), "t4.reputable_media");

  const python = replay.getReplayExample("python-creator").output;
  assert.equal(python.target.kind, "role_query");
  assert.deepEqual([...new Set(python.searchGraph.frontier.map((entry) => entry.sourceLaneId))].sort(), [
    "t1.first_party",
    "t3.institutional",
    "t6.general_discovery",
  ]);
});

test("schema guards reject invalid report enums, identity objects, trace phases, and usage", () => {
  const example = replay.getReplayExample("python-creator");
  assert.equal(validation.isInvestigationReport(example.output), true);
  const allowedEmails = new Set(
    example.output.target.identifiers
      .filter((identifier) => identifier.kind === "email" && identifier.provenance === "user_input")
      .map((identifier) => identifier.normalizedValue),
  );
  assert.equal(
    example.trace.every((event) => traceContract.isTraceEvent(event, { allowedEmails })),
    true,
  );

  const invalidReportStatus = structuredClone(example.output);
  invalidReportStatus.status = "banana";
  assert.equal(validation.isInvestigationReport(invalidReportStatus), false);
  const invalidIdentity = structuredClone(example.output);
  invalidIdentity.identity = {};
  assert.equal(validation.isInvestigationReport(invalidIdentity), false);
  const malformedGraph = structuredClone(example.output);
  malformedGraph.searchGraph = {
    schemaVersion: 2,
    nodes: [],
    edges: [],
    frontier: [],
    selectedFrontierEntryIds: [],
    telemetry: {},
  };
  assert.equal(validation.isInvestigationReport(malformedGraph), false);
  const mismatchedGraphRun = structuredClone(example.output);
  mismatchedGraphRun.searchGraph.runId = "other-run";
  assert.equal(validation.isInvestigationReport(mismatchedGraphRun), false);
  const mismatchedGraphStatus = structuredClone(example.output);
  mismatchedGraphStatus.searchGraph.status = "blocked";
  assert.equal(validation.isInvestigationReport(mismatchedGraphStatus), false);

  const clampedMarginReport = structuredClone(example.output);
  const selected = clampedMarginReport.identity.selectedCandidate;
  const rejected = {
    ...structuredClone(selected),
    id: "higher_scoring_rejected_candidate",
    status: "rejected",
    signals: [],
    evidenceIds: [],
    score: {
      total: 0.97,
      positive: 0.97,
      penalty: 0,
      independentFamilies: [],
      matchedSignals: [],
      conflictingSignals: [],
      cappedBecauseSpoofable: false,
    },
  };
  clampedMarginReport.candidates.push(rejected);
  clampedMarginReport.telemetry.candidateCount += 1;
  clampedMarginReport.identity = {
    ...clampedMarginReport.identity,
    status: "unresolved",
    runnerUpCandidate: rejected,
    runnerUpCandidateId: rejected.id,
    runnerUpScore: rejected.score.total,
    runnerUpMargin: 0,
  };
  assert.equal(validation.isInvestigationReport(clampedMarginReport), true);

  const invalidTracePhase = structuredClone(example.trace[0]);
  invalidTracePhase.phase = "banana";
  assert.equal(traceContract.isTraceEvent(invalidTracePhase), false);
  const invalidTraceStatus = structuredClone(example.trace[0]);
  invalidTraceStatus.status = "banana";
  assert.equal(traceContract.isTraceEvent(invalidTraceStatus), false);
  const invalidTraceUsage = structuredClone(example.trace[0]);
  invalidTraceUsage.usage = {};
  assert.equal(traceContract.isTraceEvent(invalidTraceUsage), false);
  const unexplainedNullUsage = structuredClone(example.trace[0]);
  unexplainedNullUsage.usage.unavailableReason = null;
  assert.equal(traceContract.isTraceEvent(unexplainedNullUsage), false);
  const secretBearingTrace = structuredClone(example.trace[0]);
  secretBearingTrace.payload.apiKey = "must-not-persist";
  assert.equal(traceContract.isTraceEvent(secretBearingTrace), false);
  const credentialUrlTrace = structuredClone(example.trace[0]);
  credentialUrlTrace.payload.sourceUrl = "https://example.test/?q=public&access_token=secret";
  assert.equal(traceContract.isTraceEvent(credentialUrlTrace), false);

  for (const [label, mutate] of [
    [
      "top-level event ID email",
      (event) => {
        event.eventId = "private-contact@example.net";
      },
    ],
    [
      "top-level run ID address",
      (event) => {
        event.runId = "123 Main Street Phoenix AZ 85001";
      },
    ],
    [
      "event name email",
      (event) => {
        event.name = "private-contact@example.net";
      },
    ],
    [
      "timestamp address",
      (event) => {
        event.timestamp = "123 Main Street Phoenix AZ 85001";
      },
    ],
    [
      "usage reason phone",
      (event) => {
        event.usage.unavailableReason = "+1 (602) 555-0199";
      },
    ],
    [
      "payload candidate ID email",
      (event) => {
        event.payload.candidateId = "private-contact@example.net";
      },
    ],
    [
      "payload evidence ID phone",
      (event) => {
        event.payload.evidenceId = "+1 (602) 555-0199";
      },
    ],
    [
      "payload structural timestamp address",
      (event) => {
        event.payload.at = "123 Main Street Phoenix AZ 85001";
      },
    ],
  ]) {
    const mutated = structuredClone(example.trace[0]);
    mutate(mutated);
    assert.equal(traceContract.isTraceEvent(mutated), false, label);
  }

  const spanEvent = structuredClone(example.trace.find((event) => event.kind === "span_start"));
  assert.ok(spanEvent);
  spanEvent.spanId = "+1 (602) 555-0199";
  assert.equal(traceContract.isTraceEvent(spanEvent), false, "top-level span ID phone");
});

test("replay hydration fails closed on report graph, run, sequence, and span corruption", () => {
  const example = replay.getReplayExample("python-creator");

  const missingDirectExcerpt = rawReplay(example);
  const directFetch = missingDirectExcerpt.output.evidence.find(
    (evidence) => evidence.verificationMethod === "direct_fetch",
  );
  assert.ok(directFetch);
  directFetch.excerpt = null;
  syncTerminalReport(missingDirectExcerpt);
  assert.equal(validation.isEvidenceRecord(directFetch), false);
  assert.throws(
    () => replay.validateReplayBundle("python-creator", missingDirectExcerpt),
    /output\.json does not match InvestigationReport schema v2/i,
  );

  const graph = rawReplay(example);
  graph.output.findings[0].evidenceIds = ["missing_evidence"];
  assert.throws(
    () => replay.validateReplayBundle("python-creator", graph),
    /report graph failed integrity.*unknown evidence/i,
  );

  const run = rawReplay(example);
  run.trace[0].runId = "foreign_run";
  assert.throws(() => replay.validateReplayBundle("python-creator", run), /foreign runId/i);

  const sequence = rawReplay(example);
  sequence.trace[1].seq += 1;
  assert.throws(() => replay.validateReplayBundle("python-creator", sequence), /sequence is not contiguous/i);

  const span = rawReplay(example);
  const spanEnd = span.trace.find((event) => event.kind === "span_end");
  assert.ok(spanEnd);
  spanEnd.spanId = "span_without_start";
  assert.throws(() => replay.validateReplayBundle("python-creator", span), /ends without one open start/i);

  const target = rawReplay(example);
  target.output.target.identifiers.push({
    kind: "email",
    value: "private-contact@example.net",
    normalizedValue: "private-contact@example.net",
    assurance: "self_asserted",
    provenance: "user_input",
  });
  syncTerminalReport(target);
  assert.throws(
    () => replay.validateReplayBundle("python-creator", target),
    /report target does not match deterministic input parsing/i,
  );

  const selfAuthorizedTrace = rawReplay(example);
  selfAuthorizedTrace.trace[0].payload.report = {
    target: {
      identifiers: [
        {
          kind: "email",
          value: "private-contact@example.net",
          normalizedValue: "private-contact@example.net",
          assurance: "self_asserted",
          provenance: "user_input",
        },
      ],
    },
    decisionSummary: "Found private-contact@example.net.",
  };
  assert.throws(() => replay.validateReplayBundle("python-creator", selfAuthorizedTrace), /invalid TraceEvent/i);

  const nestedEvidenceLeak = rawReplay(example);
  nestedEvidenceLeak.output.evidence[0].attributes.hostile = {
    contact: "private-contact@example.net",
    phone: "+1 (602) 555-0199",
  };
  syncTerminalReport(nestedEvidenceLeak);
  assert.throws(() => replay.validateReplayBundle("python-creator", nestedEvidenceLeak), /restricted public content/i);

  for (const [label, mutate] of [
    [
      "event ID email",
      (bundle) => {
        bundle.trace[0].eventId = "private-contact@example.net";
      },
    ],
    [
      "event name email",
      (bundle) => {
        bundle.trace[0].name = "private-contact@example.net";
      },
    ],
    [
      "usage reason phone",
      (bundle) => {
        bundle.trace[0].usage.unavailableReason = "+1 (602) 555-0199";
      },
    ],
    [
      "payload ID email",
      (bundle) => {
        bundle.trace[0].payload.candidateId = "private-contact@example.net";
      },
    ],
    [
      "payload timestamp address",
      (bundle) => {
        bundle.trace[0].payload.at = "123 Main Street Phoenix AZ 85001";
      },
    ],
    [
      "matched span IDs phone",
      (bundle) => {
        const start = bundle.trace.find((event) => event.kind === "span_start");
        const end = bundle.trace.find((event) => event.kind === "span_end" && event.spanId === start.spanId);
        start.spanId = "+1 (602) 555-0199";
        end.spanId = start.spanId;
      },
    ],
  ]) {
    const mutated = rawReplay(example);
    mutate(mutated);
    assert.throws(() => replay.validateReplayBundle("python-creator", mutated), /invalid TraceEvent/i, label);
  }
});

test("replay hydration rejects execution-graph cost, tier, mutation, candidate, and action corruption", () => {
  const python = replay.getReplayExample("python-creator");

  const dangling = rawReplay(python);
  dangling.output.searchGraph.edges[0].toNodeId = "missing_graph_node";
  syncTerminalReport(dangling);
  assert.throws(
    () => replay.validateReplayBundle("python-creator", dangling),
    /InvestigationReport schema v2|dangling_edge|dangling/i,
  );

  const forgedCost = rawReplay(python);
  const leaf = forgedCost.output.searchGraph.frontier.find((entry) => entry.sourceLaneId === "t6.general_discovery");
  const expansion = forgedCost.output.searchGraph.edges.find(
    (edge) => edge.frontierEntryId === leaf.id && edge.toNodeId === leaf.nodeId,
  );
  leaf.edgeCost += 0.125;
  leaf.pathCost += 0.125;
  expansion.edgeCost = leaf.edgeCost;
  expansion.pathCost = leaf.pathCost;
  syncTerminalReport(forgedCost);
  assert.throws(() => replay.validateReplayBundle("python-creator", forgedCost), /forged edge cost|schema v2/i);

  const tierSkip = rawReplay(replay.getReplayExample("linus-codegraph"));
  const firstSelection = tierSkip.trace.find((event) => event.name === "frontier.selected");
  const skippedTo = tierSkip.output.searchGraph.frontier.find(
    (entry) => entry.sourceLaneId === "t1.first_party" && entry.parentFrontierEntryId === null,
  );
  firstSelection.payload.frontierEntryId = skippedTo.id;
  firstSelection.payload.actionId = skippedTo.id;
  firstSelection.payload.sourceTier = skippedTo.sourceTier;
  firstSelection.payload.sourceLaneId = skippedTo.sourceLaneId;
  firstSelection.payload.edgeCost = skippedTo.edgeCost;
  firstSelection.payload.pathCost = skippedTo.pathCost;
  firstSelection.payload.depth = skippedTo.depth;
  assert.throws(
    () => replay.validateReplayBundle("linus-codegraph", tierSkip),
    /selected ahead of a lower-cost legal entry/i,
  );

  const illegalLaneTier = rawReplay(python);
  illegalLaneTier.output.searchGraph.frontier[0].sourceTier = 6;
  syncTerminalReport(illegalLaneTier);
  assert.throws(
    () => replay.validateReplayBundle("python-creator", illegalLaneTier),
    /InvestigationReport schema v2|forges its source tier|illegal_source_lane/i,
  );

  const mutationMath = rawReplay(python);
  const mutation = mutationMath.output.searchGraph.frontier.find((entry) => entry.mutation);
  mutation.mutation.acceptanceProbability = 0.123456;
  syncTerminalReport(mutationMath);
  assert.throws(
    () => replay.validateReplayBundle("python-creator", mutationMath),
    /canonical deterministic proposal|Metropolis-Hastings math|trace calculation/i,
  );

  const chris = rawReplay(replay.getReplayExample("chris-anderson-ted"));
  const selectedCandidateId = chris.output.identity.selectedCandidateId;
  const decoyCandidateId = chris.output.candidates.find((candidate) => candidate.id !== selectedCandidateId).id;
  const selectedEvidenceNode = chris.output.searchGraph.nodes.find(
    (node) => node.kind === "evidence" && node.candidateId === selectedCandidateId,
  );
  const selectedCandidateNode = chris.output.searchGraph.nodes.find(
    (node) => node.kind === "candidate" && node.candidateId === selectedCandidateId,
  );
  const decoyCandidateNode = chris.output.searchGraph.nodes.find(
    (node) => node.kind === "candidate" && node.candidateId === decoyCandidateId,
  );
  const crossCandidateEdge = chris.output.searchGraph.edges.find(
    (edge) => edge.fromNodeId === selectedEvidenceNode.id && edge.toNodeId === selectedCandidateNode.id,
  );
  crossCandidateEdge.toNodeId = decoyCandidateNode.id;
  syncTerminalReport(chris);
  assert.throws(() => replay.validateReplayBundle("chris-anderson-ted", chris), /crosses candidate ledgers|schema v2/i);

  const actionMismatch = rawReplay(python);
  const evidenceNode = actionMismatch.output.searchGraph.nodes.find((node) => node.kind === "evidence");
  evidenceNode.actionId = actionMismatch.output.searchGraph.frontier.find(
    (entry) => entry.id !== evidenceNode.actionId,
  ).id;
  syncTerminalReport(actionMismatch);
  assert.throws(
    () => replay.validateReplayBundle("python-creator", actionMismatch),
    /action_evidence_join_mismatch|broken stable action join|does not match evidence tool call|not a canonical projection|schema v2/i,
  );
});

test("replay hydration recomputes mutation draws and transformations instead of trusting mirrored fields", () => {
  const example = replay.getReplayExample("python-creator");

  const forgedDraw = rawReplay(example);
  const drawEntry = forgedDraw.output.searchGraph.frontier.find((entry) => entry.mutation);
  const forgedU = drawEntry.mutation.deterministicU === 0.25 ? 0.5 : 0.25;
  drawEntry.mutation.deterministicU = forgedU;
  for (const event of forgedDraw.trace.filter(
    (item) =>
      ["mutation.proposed", "mutation.accepted", "mutation.rejected"].includes(item.name) &&
      (item.payload.frontierEntryId === drawEntry.id ||
        item.payload.parentFrontierEntryId === drawEntry.mutation.parentFrontierEntryId),
  )) {
    event.payload.deterministicU = forgedU;
  }
  syncTerminalReport(forgedDraw);
  assert.throws(() => replay.validateReplayBundle("python-creator", forgedDraw), /canonical deterministic proposal/i);

  const forgedStrategy = rawReplay(example);
  const strategyEntry = forgedStrategy.output.searchGraph.frontier.find((entry) => entry.mutation);
  strategyEntry.mutation.strategy = "random_magic";
  for (const event of forgedStrategy.trace.filter((item) =>
    ["mutation.proposed", "mutation.accepted", "mutation.rejected"].includes(item.name),
  )) {
    event.payload.strategy = "random_magic";
  }
  syncTerminalReport(forgedStrategy);
  assert.throws(
    () => replay.validateReplayBundle("python-creator", forgedStrategy),
    /InvestigationReport schema v2|invalid_mutation_metadata/i,
  );

  const forgedTransformation = rawReplay(example);
  const transformedEntry = forgedTransformation.output.searchGraph.frontier.find((entry) => entry.mutation);
  transformedEntry.queryHint = "unrelated query chosen after seeing the replay";
  const transformedNode = forgedTransformation.output.searchGraph.nodes.find(
    (node) => node.id === transformedEntry.nodeId,
  );
  transformedNode.data.queryHint = transformedEntry.queryHint;
  syncTerminalReport(forgedTransformation);
  assert.throws(
    () => replay.validateReplayBundle("python-creator", forgedTransformation),
    /canonical deterministic proposal/i,
  );
});

test("replay hydration requires every frontier-linked tool span to be lane-allowed", () => {
  const forged = rawReplay(replay.getReplayExample("python-creator"));
  const start = forged.trace.find((event) => event.kind === "span_start" && event.name.startsWith("tool."));
  const end = forged.trace.find((event) => event.kind === "span_end" && event.spanId === start.spanId);
  start.name = "tool.mutation_frontier_policy";
  end.name = start.name;
  assert.throws(() => replay.validateReplayBundle("python-creator", forged), /outside frontier .* allowedTools/i);
});

test("replay hydration enforces goal legality, empty gaps, and canonical terminal status", () => {
  const example = replay.getReplayExample("python-creator");

  const withGap = rawReplay(example);
  withGap.output.coverage.gaps = ["Unresolved identity question"];
  withGap.output.limitations = [...withGap.output.limitations, "Unresolved identity question"].sort();
  syncTerminalReport(withGap);
  assert.throws(
    () => replay.validateReplayBundle("python-creator", withGap),
    /goal_satisfied report retains unresolved coverage gaps/i,
  );

  for (const status of ["partial", "ambiguous", "failed"]) {
    const wrongStatus = rawReplay(example);
    wrongStatus.output.status = status;
    syncTerminalReport(wrongStatus);
    assert.throws(
      () => replay.validateReplayBundle("python-creator", wrongStatus),
      /status .* is invalid for stop reason goal_satisfied/i,
      status,
    );
  }

  const forcedBudget = rawReplay(example);
  forcedBudget.output.stop.reason = "budget_exhausted";
  forcedBudget.output.stop.detail = "Budget exhausted: maxTurns.";
  forcedBudget.output.status = "partial";
  const kernelTerminal = forcedBudget.trace.find((event) => event.name === "investigation.terminal");
  kernelTerminal.payload.reason = "budget_exhausted";
  kernelTerminal.payload.detail = forcedBudget.output.stop.detail;
  kernelTerminal.payload.status = "partial";
  syncTerminalReport(forcedBudget);
  assert.throws(
    () => replay.validateReplayBundle("python-creator", forcedBudget),
    /budget_exhausted report is stop-illegal/i,
  );

  const illegalAnchor = rawReplay(replay.getReplayExample("chris-anderson-ted"));
  for (const evidence of illegalAnchor.output.evidence) {
    if (evidence.candidateId === illegalAnchor.output.identity.selectedCandidateId) {
      evidence.spoofable = true;
    }
  }
  for (const finding of illegalAnchor.output.findings) {
    const records = [...finding.evidenceIds, ...finding.counterEvidenceIds].map((id) =>
      illegalAnchor.output.evidence.find((item) => item.id === id),
    );
    finding.confidence = domain.assessConfidence(records);
  }
  // Once the sole anchor is spoofable the identity no longer resolves; keep the
  // recomputed identity consistent so the deeper goal-legality (stop-illegal)
  // check is what rejects the still-"goal_satisfied" stop reason.
  illegalAnchor.output.identity = domain.resolveIdentity(
    illegalAnchor.output.candidates,
    illegalAnchor.output.evidence,
  );
  syncTerminalReport(illegalAnchor);
  assert.throws(() => replay.validateReplayBundle("chris-anderson-ted", illegalAnchor), /stop-illegal/i);

  const forgedFamily = rawReplay(example);
  forgedFamily.output.evidence[0].sourceFamily = "attacker.example";
  forgedFamily.output.sources = domain.summarizeSources(forgedFamily.output.evidence);
  for (const finding of forgedFamily.output.findings) {
    const records = [...finding.evidenceIds, ...finding.counterEvidenceIds].map((evidenceId) =>
      forgedFamily.output.evidence.find((item) => item.id === evidenceId),
    );
    finding.confidence = domain.assessConfidence(records);
  }
  syncTerminalReport(forgedFamily);
  assert.throws(
    () => replay.validateReplayBundle("python-creator", forgedFamily),
    /source URL or sourceFamily is not canonically derived|not grounded by same-candidate evidence/i,
  );

  const forgedConfidence = rawReplay(example);
  forgedConfidence.output.findings[0].confidence.label = "very_high";
  forgedConfidence.output.findings[0].confidence.independentSourceFamilies = ["forged.example"];
  forgedConfidence.output.findings[0].confidence.appliedCaps = ["forged-cap"];
  syncTerminalReport(forgedConfidence);
  assert.throws(
    () => replay.validateReplayBundle("python-creator", forgedConfidence),
    /confidence metadata does not match deterministic evidence assessment/i,
  );

  const missingBodyHash = rawReplay(example);
  missingBodyHash.output.evidence[0].contentHash = null;
  syncTerminalReport(missingBodyHash);
  assert.throws(
    () => replay.validateReplayBundle("python-creator", missingBodyHash),
    /content hash differs from its cassette response|not a canonical projection|schema v2/i,
  );

  const forgedQuote = rawReplay(example);
  const forgedEvidence = forgedQuote.output.evidence[0];
  forgedEvidence.claim = "Guido van Rossum won a Nobel Prize and is Python's creator.";
  forgedEvidence.excerpt = forgedEvidence.claim;
  forgedEvidence.normalizedClaim = domain.normalizeComparable(forgedEvidence.claim);
  const forgedFinding = forgedQuote.output.findings.find((finding) => finding.evidenceIds.includes(forgedEvidence.id));
  forgedFinding.description = forgedEvidence.excerpt;
  syncTerminalReport(forgedQuote);
  assert.throws(
    () => replay.validateReplayBundle("python-creator", forgedQuote),
    /differs from its cassette evidence binding|not grounded by same-candidate evidence/i,
  );
});

test("trace sanitation preserves validated UUID-shaped structural identifiers", () => {
  const runId = "123e4567-e89b-12d3-a456-426614174000";
  const recorder = new traceContract.TraceRecorder(
    runId,
    domain.createSequenceClock("2026-08-18T23:00:00.000Z", 1),
    domain.createDeterministicIdFactory("uuid-trace"),
  );
  const event = recorder.record("result.terminal", {
    phase: "terminal",
    payload: { report: { runId }, status: "configuration_error" },
  });
  assert.equal(event.runId, runId);
  assert.equal(event.payload.report.runId, runId);
  assert.equal(traceContract.isTraceEvent(event), true);
  const prefixedUuid = structuredClone(event);
  prefixedUuid.eventId = `event_${runId}`;
  prefixedUuid.runId = `run_${runId}`;
  prefixedUuid.payload.report.runId = prefixedUuid.runId;
  assert.equal(traceContract.isTraceEvent(prefixedUuid), true);
  const prefixedPhone = structuredClone(event);
  prefixedPhone.eventId = "event_602-555-0199";
  assert.equal(traceContract.isTraceEvent(prefixedPhone), false);
  assert.throws(
    () =>
      new traceContract.TraceRecorder(
        "private-contact@example.net",
        domain.createSequenceClock("2026-08-18T23:00:00.000Z", 1),
        domain.createDeterministicIdFactory("invalid-trace"),
      ),
    /safe machine identifier/i,
  );
  assert.deepEqual(
    traceContract.sanitizeTraceValue({
      candidateId: "private-contact@example.net",
      evidenceId: "+1 (602) 555-0199",
      at: "123 Main Street Phoenix AZ 85001",
    }),
    {},
  );
  const sanitizedEvent = recorder.record("gate.identity", {
    phase: "separate_candidates",
    payload: {
      candidateId: "private-contact@example.net",
      detail: "Candidate value was rejected by the structural gate.",
    },
  });
  assert.deepEqual(sanitizedEvent.payload, {
    detail: "Candidate value was rejected by the structural gate.",
  });
  assert.equal(traceContract.isTraceEvent(sanitizedEvent), true);
});

test("every replay report and trace preserve graph and append-only integrity", () => {
  for (const id of expectedIds) {
    const example = replay.getReplayExample(id);
    assert.equal(example.output.status, "completed");
    assert.equal(example.output.identity.status, "resolved");
    assert.equal(integrity.validateReferentialIntegrity(example.output).length, 0);
    assert.ok(example.output.findings.length > 0);
    assert.ok(example.output.evidence.length > 0);
    const candidates = new Set(example.output.candidates.map((candidate) => candidate.id));
    const evidenceById = new Map(example.output.evidence.map((item) => [item.id, item]));
    for (const evidence of example.output.evidence) {
      assert.ok(candidates.has(evidence.candidateId));
      for (const field of [
        "sourceUrl",
        "queryUrl",
        "publisher",
        "sourceFamily",
        "sourceType",
        "retrievedAt",
        "observedAt",
        "httpStatus",
        "contentHash",
        "excerpt",
        "canonicalSubset",
        "toolCallId",
        "verificationMethod",
        "temporalStatus",
        "spoofable",
      ]) {
        assert.ok(Object.hasOwn(evidence, field), `${id} evidence ${evidence.id} missing ${field}`);
      }
    }
    for (const finding of example.output.findings) {
      assert.ok(candidates.has(finding.candidateId));
      assert.ok(Array.isArray(finding.counterEvidenceIds));
      for (const evidenceId of [...finding.evidenceIds, ...finding.counterEvidenceIds]) {
        assert.equal(evidenceById.get(evidenceId)?.candidateId, finding.candidateId);
        assert.notEqual(evidenceById.get(evidenceId)?.sourceType, "search_result");
      }
    }
    const starts = new Map();
    const ends = new Map();
    example.trace.forEach((event, index) => {
      assert.equal(event.seq, index + 1);
      if (index > 0) assert.ok(event.elapsedMs >= example.trace[index - 1].elapsedMs);
      if (event.kind === "span_start") starts.set(event.spanId, (starts.get(event.spanId) ?? 0) + 1);
      if (event.kind === "span_end") ends.set(event.spanId, (ends.get(event.spanId) ?? 0) + 1);
    });
    assert.deepEqual([...starts.entries()].sort(), [...ends.entries()].sort());
    assert.match(example.trace.at(-1).name, /terminal/);
    assert.equal(forbiddenTraceKey(example.trace), null);
  }
});

test("same-name replay quarantines decoy evidence and Git replay preserves spoofable cap rationale", () => {
  const sameName = replay.getReplayExample("chris-anderson-ted").output;
  assert.equal(sameName.candidates.length, 2);
  const selected = sameName.identity.selectedCandidateId;
  const decoy = sameName.candidates.find((candidate) => candidate.id !== selected);
  assert.equal(decoy.status, "rejected");
  assert.equal(sameName.identity.runnerUpCandidateId, decoy.id);
  assert.equal(sameName.identity.runnerUpScore, decoy.score.total);
  assert.ok(sameName.identity.runnerUpMargin >= 0.2);
  assert.ok(sameName.evidence.some((item) => item.candidateId === decoy.id));
  assert.ok(sameName.findings.every((finding) => finding.candidateId === selected));
  assert.deepEqual(sameName.coverage.requestedCategories, ["employment", "identity"]);
  assert.deepEqual(sameName.coverage.coveredCategories, ["employment", "identity"]);
  assert.equal(sameName.coverage.independentSourceFamilyCount, 1);
  assert.equal(new Set(sameName.findings.flatMap((finding) => finding.evidenceIds)).size, 2);
  const bioPhrase = sameName.identity.selectedCandidate.signals.find((signal) => signal.kind === "bio_phrase");
  assert.equal(bioPhrase.value, "became the curator of the TED Conference in 2002");
  assert.equal(bioPhrase.sourceFamily, "ted.com");

  const codegraph = replay.getReplayExample("linus-codegraph").output;
  const git = codegraph.evidence.find((item) => item.sourceType === "code_commit");
  assert.equal(git.spoofable, true);
  const gitFinding = codegraph.findings.find((finding) => finding.evidenceIds.includes(git.id));
  assert.ok(gitFinding.confidence.score < 0.75);
  assert.deepEqual(gitFinding.confidence.independentSourceFamilies, ["github.com"]);
  assert.ok(gitFinding.caveats.some((item) => /spoof|unsigned/i.test(item)));
  const identityFinding = codegraph.findings.find((finding) => finding.category === "identity");
  assert.ok(identityFinding.confidence.score >= 0.75);
  assert.deepEqual(identityFinding.confidence.independentSourceFamilies, ["github.com", "linuxfoundation.org"]);
});

test("health and example APIs expose replay readiness without leaking configuration", async () => {
  const health = await api.handleApiRequest(new Request("https://atlas.test/api/health"), {});
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    schemaVersion: 2,
    status: "ok",
    service: "atlas-people-intelligence",
    replayReady: true,
    exampleCount: 3,
    liveConfigured: false,
    liveAuthorizationRequired: false,
  });
  const keyOnlyHealth = await api.handleApiRequest(new Request("https://atlas.test/api/health"), {
    OPENROUTER_API_KEY: "server-secret",
  });
  assert.equal((await keyOnlyHealth.json()).liveConfigured, false);
  const enabledHealth = await api.handleApiRequest(new Request("https://atlas.test/api/health"), {
    ATLAS_LIVE_ENABLED: "true",
    OPENROUTER_API_KEY: "server-secret",
    OPENROUTER_MODEL: "test/model",
    ATLAS_API_TOKEN: "a".repeat(32),
  });
  assert.deepEqual(await enabledHealth.json(), {
    schemaVersion: 2,
    status: "ok",
    service: "atlas-people-intelligence",
    replayReady: true,
    exampleCount: 3,
    liveConfigured: true,
    liveAuthorizationRequired: true,
  });
  const unprotectedHealth = await api.handleApiRequest(new Request("https://atlas.test/api/health"), {
    ATLAS_LIVE_ENABLED: "true",
    OPENROUTER_API_KEY: "server-secret",
  });
  assert.equal((await unprotectedHealth.json()).liveConfigured, false);
  const localHealth = await api.handleApiRequest(new Request("http://localhost/api/health"), {
    ATLAS_LIVE_ENABLED: "true",
    ATLAS_ALLOW_UNAUTHENTICATED_LOCAL: "true",
    LIVE_PROVIDER: "openrouter",
    OPENROUTER_API_KEY: "server-secret",
  });
  const localPayload = await localHealth.json();
  assert.equal(localPayload.liveConfigured, true);
  assert.equal(localPayload.liveAuthorizationRequired, false);

  const staleDirectProvider = await api.handleApiRequest(new Request("http://localhost/api/health"), {
    ATLAS_LIVE_ENABLED: "true",
    ATLAS_ALLOW_UNAUTHENTICATED_LOCAL: "true",
    LIVE_PROVIDER: "gemini",
    LIVE_SEARCH_PROVIDER: "openai",
    GEMINI_API_KEY: "reasoning-secret",
    OPENAI_API_KEY: "search-secret",
  });
  assert.equal((await staleDirectProvider.json()).liveConfigured, false);

  const rejectedPolicyPin = await api.handleApiRequest(new Request("http://localhost/api/health"), {
    ATLAS_LIVE_ENABLED: "true",
    ATLAS_ALLOW_UNAUTHENTICATED_LOCAL: "true",
    LIVE_PROVIDER: "openai",
    OPENROUTER_API_KEY: "server-secret",
  });
  assert.equal((await rejectedPolicyPin.json()).liveConfigured, false);

  const openRouterOnly = await api.handleApiRequest(new Request("http://localhost/api/health"), {
    ATLAS_LIVE_ENABLED: "true",
    ATLAS_ALLOW_UNAUTHENTICATED_LOCAL: "true",
    LIVE_PROVIDER: "openrouter",
    OPENROUTER_API_KEY: "server-secret",
    LIVE_SEARCH_PROVIDER: "openai",
    ANTHROPIC_API_KEY: "claude-secret",
    GEMINI_API_KEY: "gemini-secret",
    OPENAI_API_KEY: "openai-secret",
  });
  const openRouterPayload = await openRouterOnly.json();
  assert.equal(openRouterPayload.liveConfigured, true);
  for (const forbidden of ["provider", "model", "apiKey", "searchProvider"]) {
    assert.equal(forbidden in openRouterPayload, false);
  }
  const response = await api.handleApiRequest(new Request("https://atlas.test/api/examples/python-creator"), {});
  const payload = await response.json();
  assert.equal(payload.id, "python-creator");
  assert.equal(payload.input.query, "the creator of Python");
  assert.equal(payload.trace.at(-1).name, "result.terminal");
});

test("remote live sessions authenticate once, expire, reject tampering, and never disclose the token", async () => {
  const now = Date.parse("2026-08-23T12:00:00.000Z");
  const apiToken = `atlas-test-token-${"x".repeat(48)}`;
  const environment = {
    ATLAS_LIVE_ENABLED: "true",
    LIVE_PROVIDER: "openrouter",
    OPENROUTER_API_KEY: "test-openrouter-key-not-real",
    ATLAS_API_TOKEN: apiToken,
  };
  const loginRequest = (token) =>
    new Request("https://atlas.test/api/live/session", {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });

  for (const request of [loginRequest(), loginRequest("wrong-token")]) {
    const response = await api.handleApiRequest(request, environment, { now: () => now });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal((await response.text()).includes(apiToken), false);
  }

  const unavailable = await api.handleApiRequest(loginRequest(apiToken), {
    ...environment,
    OPENROUTER_API_KEY: undefined,
  });
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.text()).includes(apiToken), false);

  const login = await api.handleApiRequest(loginRequest(apiToken), environment, { now: () => now });
  assert.equal(login.status, 204);
  assert.equal(await login.text(), "");
  const setCookie = login.headers.get("set-cookie");
  assert.ok(setCookie);
  assert.match(setCookie, /^__Host-atlas_live_session=v1\.[0-9]+\.[a-f0-9]{64};/);
  assert.match(setCookie, /Path=\//);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.match(setCookie, /Max-Age=1800/);
  assert.equal(setCookie.includes(apiToken), false);
  const cookie = setCookie.split(";", 1)[0];

  const sessionStatus = (value, timestamp = now) =>
    api.handleApiRequest(
      new Request("https://atlas.test/api/live/session", { headers: { cookie: value } }),
      environment,
      { now: () => timestamp },
    );
  const authenticated = await sessionStatus(cookie);
  assert.equal(authenticated.status, 200);
  assert.deepEqual(await authenticated.json(), { authenticated: true });

  const tamperedCookie = `${cookie.slice(0, -1)}${cookie.endsWith("0") ? "1" : "0"}`;
  const tampered = await sessionStatus(tamperedCookie);
  assert.equal(tampered.status, 401);
  assert.deepEqual(await tampered.json(), { authenticated: false });

  const duplicate = await sessionStatus(`${cookie}; ${cookie}`);
  assert.equal(duplicate.status, 401);

  const expired = await sessionStatus(cookie, now + 30 * 60 * 1_000);
  assert.equal(expired.status, 401);

  let observedConfig;
  const research = await api.handleApiRequest(
    new Request("https://atlas.test/api/research", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ query: "Grace Hopper public professional background", mode: "live" }),
    }),
    environment,
    {
      now: () => now,
      streamLive(_input, config) {
        observedConfig = config;
        return (async function* () {})();
      },
    },
  );
  assert.equal(research.status, 200);
  assert.equal(research.headers.get("x-atlas-execution-mode"), "live");
  const researchTrace = await research.text();
  assert.equal(researchTrace.includes(apiToken), false);
  assert.equal(observedConfig.provider, "openrouter");
  assert.equal(observedConfig.model, "openai/gpt-5.4-nano");
  for (const forbidden of ["searchProvider", "searchApiKey", "searchEndpoint"]) {
    assert.equal(forbidden in observedConfig, false);
  }

  const logout = await api.handleApiRequest(
    new Request("https://atlas.test/api/live/session", { method: "DELETE", headers: { cookie } }),
    environment,
  );
  assert.equal(logout.status, 204);
  const clearedCookie = logout.headers.get("set-cookie");
  assert.match(clearedCookie, /^__Host-atlas_live_session=;/);
  assert.match(clearedCookie, /Max-Age=0/);
  assert.match(clearedCookie, /Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
  assert.match(clearedCookie, /HttpOnly/);
  assert.match(clearedCookie, /Secure/);
  assert.match(clearedCookie, /SameSite=Strict/);
  assert.equal(clearedCookie.includes(apiToken), false);
  const afterLogout = await sessionStatus(clearedCookie.split(";", 1)[0]);
  assert.equal(afterLogout.status, 401);

  const wrongMethod = await api.handleApiRequest(
    new Request("https://atlas.test/api/live/session", { method: "PUT" }),
    environment,
  );
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "GET, POST, DELETE");
});

test("POST replay streams byte-stable NDJSON ending in one terminal report", async () => {
  const request = () =>
    new Request("https://atlas.test/api/research", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "the creator of Python", mode: "replay", exampleId: "python-creator" }),
    });
  const first = await api.handleApiRequest(request(), {});
  const second = await api.handleApiRequest(request(), {});
  assert.match(first.headers.get("content-type"), /^application\/x-ndjson/);
  assert.equal(first.headers.get("x-atlas-execution-mode"), "replay");
  const [firstText, secondText] = await Promise.all([first.text(), second.text()]);
  assert.equal(firstText, secondText);
  const events = parseNdjson(firstText);
  assert.equal(events.at(-1).name, "result.terminal");
  assert.equal(events.filter((event) => event.name === "result.terminal").length, 1);
  assert.equal(terminalReport(events).status, "completed");
});

test("local demo fixtures can intercept only the explicit loopback development bypass", async () => {
  const example = replay.getReplayExample("python-creator");
  const input = structuredClone(example.input);
  const trace = api.immediateTerminalTrace(input, "configuration_error", "Synthetic local demo terminal.");
  const globalKey = "__ATLAS_LOCAL_DEMO_FIXTURES__";
  const previous = globalThis[globalKey];
  globalThis[globalKey] = [{ query: input.query, input, trace }];
  const body = JSON.stringify({
    query: input.query,
    objective: input.objective,
    requestedDepth: input.requestedDepth,
    requestedCategories: input.requestedCategories,
    locale: input.locale,
    mode: "live",
  });
  const request = (url) =>
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

  try {
    const local = await api.handleApiRequest(request("http://localhost/api/research"), {
      ATLAS_ALLOW_UNAUTHENTICATED_LOCAL: "true",
    });
    assert.equal(local.headers.get("x-atlas-execution-mode"), "local_demo");
    assert.equal(terminalReport(parseNdjson(await local.text())).input.query, input.query);

    const localWithoutBypass = await api.handleApiRequest(request("http://localhost/api/research"), {});
    assert.equal(localWithoutBypass.headers.get("x-atlas-execution-mode"), "live");

    const publicIngress = await api.handleApiRequest(request("https://atlas.test/api/research"), {
      ATLAS_ALLOW_UNAUTHENTICATED_LOCAL: "true",
    });
    assert.equal(publicIngress.headers.get("x-atlas-execution-mode"), "live");
  } finally {
    if (previous === undefined) delete globalThis[globalKey];
    else globalThis[globalKey] = previous;
  }
});

test("NDJSON wrapper closes open spans and emits a consumable failed report after source failure", async () => {
  const input = replay.getReplayExample("python-creator").input;
  const exemplar = replay.getReplayExample("python-creator").trace.find((event) => event.kind === "span_start");
  assert.ok(exemplar);
  const started = { ...exemplar, seq: 1, runId: "run_stream_failure", eventId: "event_stream_start" };
  async function* failingSource() {
    yield started;
    throw new Error("private upstream detail that must not escape");
  }
  const response = api.traceNdjsonResponse(() => failingSource(), new AbortController().signal, input);
  const events = parseNdjson(await response.text());
  assert.deepEqual(
    events.map((event) => event.seq),
    [1, 2, 3],
  );
  assert.equal(events[1].kind, "span_end");
  assert.equal(events[1].spanId, started.spanId);
  assert.equal(events[1].status, "failed");
  assert.equal(events[2].name, "result.terminal");
  assert.equal(events[2].payload.report.status, "failed");
  assert.equal(events[2].payload.report.stop.reason, "fatal_error");
  assert.equal(events[2].payload.report.runId, "run_stream_failure");
  assert.doesNotMatch(JSON.stringify(events), /private upstream detail/);
});

test("FNV-backed partial terminals survive sanitation and preserve their graph through the NDJSON wrapper", async () => {
  const example = replay.getReplayExample("python-creator");
  const report = structuredClone(example.output);
  report.status = "partial";
  report.searchGraph.status = "exhausted";
  report.stop = {
    reason: "diminishing_returns",
    detail: "No additional bounded source improved the report.",
    at: report.generatedAt,
  };
  report.evidence[0].contentHash = "fnv1a32:deadbeef";
  const sanitized = traceContract.sanitizeTraceValue({ report });
  assert.equal(sanitized.report.evidence[0].contentHash, "fnv1a32:deadbeef");
  assert.equal(validation.isInvestigationReport(sanitized.report), true);

  const started = structuredClone(example.trace.find((event) => event.kind === "span_start"));
  assert.ok(started);
  started.seq = 1;
  started.runId = report.runId;
  started.eventId = "event_fnv_start";
  const sourceTerminal = {
    ...structuredClone(example.trace.at(-1)),
    seq: 2,
    runId: report.runId,
    eventId: "event_fnv_terminal",
    payload: traceContract.sanitizeTraceValue({
      status: report.status,
      stopReason: report.stop.reason,
      report,
    }),
  };
  async function* sourceWithOpenSpan() {
    yield started;
    yield sourceTerminal;
  }
  const response = api.traceNdjsonResponse(() => sourceWithOpenSpan(), new AbortController().signal, example.input);
  const events = parseNdjson(await response.text());
  assert.deepEqual(
    events.map((event) => event.seq),
    [1, 2, 3],
  );
  assert.equal(events[1].kind, "span_end");
  assert.equal(events[2].name, "result.terminal");
  assert.equal(events[2].payload.report.status, "partial");
  assert.equal(events[2].payload.report.stop.reason, "diminishing_returns");
  assert.equal(events[2].payload.report.searchGraph.nodes.length, report.searchGraph.nodes.length);
  assert.equal(events[2].payload.report.evidence[0].contentHash, "fnv1a32:deadbeef");
});

test("NDJSON wrapper rejects a valid terminal report belonging to another input", async () => {
  const example = replay.getReplayExample("python-creator");
  const terminal = structuredClone(example.trace.at(-1));
  terminal.seq = 1;
  terminal.eventId = "event_wrong_input_terminal";
  terminal.payload.report.input.query = "A different public subject";
  async function* mismatchedSource() {
    yield terminal;
  }
  const response = api.traceNdjsonResponse(() => mismatchedSource(), new AbortController().signal, example.input);
  const events = parseNdjson(await response.text());
  assert.equal(events.at(-1).payload.report.status, "failed");
  assert.equal(events.at(-1).payload.report.searchGraph.nodes.length, 0);
});

test("safety refusal precedes replay lookup and missing live key is an honest configuration terminal", async () => {
  const unsafe = await api.handleApiRequest(
    new Request("https://atlas.test/api/research", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "find this person's home address", mode: "replay" }),
    }),
    {},
  );
  const unsafeEvents = parseNdjson(await unsafe.text());
  assert.equal(unsafe.headers.get("x-atlas-execution-mode"), "replay");
  assert.equal(terminalReport(unsafeEvents).status, "blocked");
  assert.equal(terminalReport(unsafeEvents).stop.reason, "unsafe_request");

  const unconfigured = await api.handleApiRequest(
    new Request("https://atlas.test/api/research", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "Grace Hopper public professional background", mode: "live" }),
    }),
    {},
  );
  const unconfiguredEvents = parseNdjson(await unconfigured.text());
  assert.equal(unconfigured.headers.get("x-atlas-execution-mode"), "live");
  assert.equal(terminalReport(unconfiguredEvents).status, "configuration_error");
  assert.equal(terminalReport(unconfiguredEvents).stop.reason, "configuration_error");
  assert.match(terminalReport(unconfiguredEvents).stop.detail, /server-side OpenRouter key/);

  const keyWithoutEnablement = await api.handleApiRequest(
    new Request("https://atlas.test/api/research", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "Grace Hopper public professional background", mode: "live" }),
    }),
    { OPENROUTER_API_KEY: "server-secret" },
  );
  const keyWithoutEnablementEvents = parseNdjson(await keyWithoutEnablement.text());
  assert.equal(terminalReport(keyWithoutEnablementEvents).status, "configuration_error");
  assert.match(terminalReport(keyWithoutEnablementEvents).stop.detail, /explicit enablement/);
});

test("live HTTP ingress fails closed without the configured bearer token", async () => {
  const environment = {
    ATLAS_LIVE_ENABLED: "true",
    OPENROUTER_API_KEY: "server-secret",
    ATLAS_API_TOKEN: "a".repeat(32),
  };
  const request = (authorization) =>
    new Request("https://atlas.test/api/research", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify({
        query: "Grace Hopper public professional background",
        mode: "live",
      }),
    });

  const missing = await api.handleApiRequest(request(), environment);
  assert.equal(missing.status, 401);
  assert.equal(missing.headers.get("www-authenticate"), 'Bearer realm="atlas-live"');
  assert.deepEqual(await missing.json(), {
    error: "unauthorized",
    message: "Valid live research authorization is required.",
  });

  const wrong = await api.handleApiRequest(request("Bearer wrong-token"), environment);
  assert.equal(wrong.status, 401);
});

test("API rejects malformed and unmatched requests without starting synthetic research", async () => {
  const malformed = await api.handleApiRequest(
    new Request("https://atlas.test/api/research", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    }),
    {},
  );
  assert.equal(malformed.status, 400);

  for (const requestedCategories of [[], ["identity", "employer", "profiles"], ["identity", 42]]) {
    const invalidCategories = await api.handleApiRequest(
      new Request("https://atlas.test/api/research", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "Ada Lovelace", mode: "replay", requestedCategories }),
      }),
      {},
    );
    assert.equal(invalidCategories.status, 400);
    const payload = await invalidCategories.json();
    assert.equal(payload.error, "invalid_request");
    assert.match(payload.message, /requestedCategories must contain only/);
  }

  const unmatched = await api.handleApiRequest(
    new Request("https://atlas.test/api/research", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "Ada Lovelace", mode: "replay" }),
    }),
    {},
  );
  assert.equal(unmatched.status, 422);
  assert.equal((await unmatched.json()).error, "replay_not_found");
});

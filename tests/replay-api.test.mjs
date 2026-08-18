import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test, { after } from "node:test";
import { createServer } from "vite";

const vite = await createServer({
  configFile: false,
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

const expectedIds = ["chris-anderson-ted", "linus-codegraph", "python-creator"];

function parseNdjson(text) {
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
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

function syncTerminalReport(bundle) {
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
    if (["analysis", "chainofthought", "cot", "hiddenreasoning", "internalmonologue", "reasoning", "reasoningcontent", "scratchpad", "thinking", "thinkingcontent"].includes(normalized)) {
      return [...path, key].join(".");
    }
    const found = forbiddenTraceKey(child, [...path, key]);
    if (found) return found;
  }
  return null;
}

test("repository contains exactly three complete captured replay directories", async () => {
  const entries = await readdir(new URL("../examples/", import.meta.url), { withFileTypes: true });
  assert.deepEqual(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(), expectedIds);
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
    assert.doesNotThrow(() => captureContract.assertVerifiedEvidenceContract(example.output.evidence));
    for (const evidence of example.output.evidence) {
      const capture = captureContract.VERIFIED_PUBLIC_CAPTURES[evidence.toolCallId];
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
      const capture = captureContract.VERIFIED_PUBLIC_CAPTURES[request.id];
      assert.ok(capture, `${id} cassette request ${request.id} lacks a verified capture`);
      assert.equal(request.response.bodySha256, capture.bodySha256);
      if (capture.requestFingerprint) {
        assert.equal(request.fingerprint, capture.requestFingerprint);
      }
    }
  }

  const codegraph = replay.getReplayExample("linus-codegraph");
  const searchRequest = codegraph.cassette.requests.find((request) =>
    request.id === "req-github-search");
  const commitRequest = codegraph.cassette.requests.find((request) =>
    request.id === "req-github-commit");
  const strongestSha = searchRequest.response.canonicalSubset.strongest_sha;
  assert.equal(strongestSha, captureContract.VERIFIED_GITHUB_STRONGEST_SHA);
  assert.equal(commitRequest.response.canonicalSubset.sha, strongestSha);
  assert.match(commitRequest.fingerprint, new RegExp(`/commits/${strongestSha} `));
  const commitEvidence = codegraph.output.evidence.find((evidence) =>
    evidence.toolCallId === commitRequest.id);
  assert.equal(commitEvidence.canonicalSubset.sha, strongestSha);
  assert.equal(commitEvidence.sourceUrl, `https://github.com/torvalds/linux/commit/${strongestSha}`);
  assert.equal(
    commitEvidence.queryUrl,
    `https://api.github.com/repos/torvalds/linux/commits/${strongestSha}`,
  );
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

test("schema guards reject invalid report enums, identity objects, trace phases, and usage", () => {
  const example = replay.getReplayExample("python-creator");
  assert.equal(validation.isInvestigationReport(example.output), true);
  const allowedEmails = new Set(example.output.target.identifiers
    .filter((identifier) => identifier.kind === "email" && identifier.provenance === "user_input")
    .map((identifier) => identifier.normalizedValue));
  assert.equal(example.trace.every((event) =>
    traceContract.isTraceEvent(event, { allowedEmails })), true);

  const invalidReportStatus = structuredClone(example.output);
  invalidReportStatus.status = "banana";
  assert.equal(validation.isInvestigationReport(invalidReportStatus), false);
  const invalidIdentity = structuredClone(example.output);
  invalidIdentity.identity = {};
  assert.equal(validation.isInvestigationReport(invalidIdentity), false);

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
    ["top-level event ID email", (event) => { event.eventId = "private-contact@example.net"; }],
    ["top-level run ID address", (event) => { event.runId = "123 Main Street Phoenix AZ 85001"; }],
    ["event name email", (event) => { event.name = "private-contact@example.net"; }],
    ["timestamp address", (event) => { event.timestamp = "123 Main Street Phoenix AZ 85001"; }],
    ["usage reason phone", (event) => { event.usage.unavailableReason = "+1 (602) 555-0199"; }],
    ["payload candidate ID email", (event) => { event.payload.candidateId = "private-contact@example.net"; }],
    ["payload evidence ID phone", (event) => { event.payload.evidenceId = "+1 (602) 555-0199"; }],
    ["payload structural timestamp address", (event) => { event.payload.at = "123 Main Street Phoenix AZ 85001"; }],
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
  const directFetch = missingDirectExcerpt.output.evidence.find((evidence) =>
    evidence.verificationMethod === "direct_fetch");
  assert.ok(directFetch);
  directFetch.excerpt = null;
  syncTerminalReport(missingDirectExcerpt);
  assert.equal(validation.isEvidenceRecord(directFetch), false);
  assert.throws(
    () => replay.validateReplayBundle("python-creator", missingDirectExcerpt),
    /output\.json does not match InvestigationReport v1/i,
  );

  const graph = rawReplay(example);
  graph.output.findings[0].evidenceIds = ["missing_evidence"];
  assert.throws(
    () => replay.validateReplayBundle("python-creator", graph),
    /report graph failed integrity.*unknown evidence/i,
  );

  const run = rawReplay(example);
  run.trace[0].runId = "foreign_run";
  assert.throws(
    () => replay.validateReplayBundle("python-creator", run),
    /foreign runId/i,
  );

  const sequence = rawReplay(example);
  sequence.trace[1].seq += 1;
  assert.throws(
    () => replay.validateReplayBundle("python-creator", sequence),
    /sequence is not contiguous/i,
  );

  const span = rawReplay(example);
  const spanEnd = span.trace.find((event) => event.kind === "span_end");
  assert.ok(spanEnd);
  spanEnd.spanId = "span_without_start";
  assert.throws(
    () => replay.validateReplayBundle("python-creator", span),
    /ends without one open start/i,
  );

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
      identifiers: [{
        kind: "email",
        value: "private-contact@example.net",
        normalizedValue: "private-contact@example.net",
        assurance: "self_asserted",
        provenance: "user_input",
      }],
    },
    decisionSummary: "Found private-contact@example.net.",
  };
  assert.throws(
    () => replay.validateReplayBundle("python-creator", selfAuthorizedTrace),
    /invalid TraceEvent/i,
  );

  const nestedEvidenceLeak = rawReplay(example);
  nestedEvidenceLeak.output.evidence[0].attributes.hostile = {
    contact: "private-contact@example.net",
    phone: "+1 (602) 555-0199",
  };
  syncTerminalReport(nestedEvidenceLeak);
  assert.throws(
    () => replay.validateReplayBundle("python-creator", nestedEvidenceLeak),
    /restricted public content/i,
  );

  for (const [label, mutate] of [
    ["event ID email", (bundle) => { bundle.trace[0].eventId = "private-contact@example.net"; }],
    ["event name email", (bundle) => { bundle.trace[0].name = "private-contact@example.net"; }],
    ["usage reason phone", (bundle) => { bundle.trace[0].usage.unavailableReason = "+1 (602) 555-0199"; }],
    ["payload ID email", (bundle) => { bundle.trace[0].payload.candidateId = "private-contact@example.net"; }],
    ["payload timestamp address", (bundle) => { bundle.trace[0].payload.at = "123 Main Street Phoenix AZ 85001"; }],
    ["matched span IDs phone", (bundle) => {
      const start = bundle.trace.find((event) => event.kind === "span_start");
      const end = bundle.trace.find((event) => event.kind === "span_end" && event.spanId === start.spanId);
      start.spanId = "+1 (602) 555-0199";
      end.spanId = start.spanId;
    }],
  ]) {
    const mutated = rawReplay(example);
    mutate(mutated);
    assert.throws(
      () => replay.validateReplayBundle("python-creator", mutated),
      /invalid TraceEvent/i,
      label,
    );
  }
});

test("replay hydration enforces goal legality, empty gaps, and canonical terminal status", () => {
  const example = replay.getReplayExample("python-creator");

  const withGap = rawReplay(example);
  withGap.output.coverage.gaps = ["Unresolved identity question"];
  withGap.output.limitations = [
    ...withGap.output.limitations,
    "Unresolved identity question",
  ].sort();
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
    const records = [...finding.evidenceIds, ...finding.counterEvidenceIds]
      .map((id) => illegalAnchor.output.evidence.find((item) => item.id === id));
    finding.confidence = domain.assessConfidence(records);
  }
  syncTerminalReport(illegalAnchor);
  assert.throws(
    () => replay.validateReplayBundle("chris-anderson-ted", illegalAnchor),
    /stop-illegal/i,
  );

  const forgedFamily = rawReplay(example);
  forgedFamily.output.evidence[0].sourceFamily = "attacker.example";
  forgedFamily.output.sources = domain.summarizeSources(forgedFamily.output.evidence);
  for (const finding of forgedFamily.output.findings) {
    const records = [...finding.evidenceIds, ...finding.counterEvidenceIds]
      .map((evidenceId) => forgedFamily.output.evidence.find((item) => item.id === evidenceId));
    finding.confidence = domain.assessConfidence(records);
  }
  syncTerminalReport(forgedFamily);
  assert.throws(
    () => replay.validateReplayBundle("python-creator", forgedFamily),
    /source URL or sourceFamily is not canonically derived/i,
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
    /content hash differs from its cassette response/i,
  );

  const forgedQuote = rawReplay(example);
  const forgedEvidence = forgedQuote.output.evidence[0];
  forgedEvidence.claim = "Guido van Rossum won a Nobel Prize and is Python's creator.";
  forgedEvidence.excerpt = forgedEvidence.claim;
  forgedEvidence.normalizedClaim = domain.normalizeComparable(forgedEvidence.claim);
  const forgedFinding = forgedQuote.output.findings.find((finding) =>
    finding.evidenceIds.includes(forgedEvidence.id));
  forgedFinding.description = forgedEvidence.excerpt;
  syncTerminalReport(forgedQuote);
  assert.throws(
    () => replay.validateReplayBundle("python-creator", forgedQuote),
    /differs from its cassette evidence binding/i,
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
  assert.throws(() => new traceContract.TraceRecorder(
    "private-contact@example.net",
    domain.createSequenceClock("2026-08-18T23:00:00.000Z", 1),
    domain.createDeterministicIdFactory("invalid-trace"),
  ), /safe machine identifier/i);
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
      for (const field of ["sourceUrl", "queryUrl", "publisher", "sourceFamily", "sourceType", "retrievedAt", "observedAt", "httpStatus", "contentHash", "excerpt", "canonicalSubset", "toolCallId", "verificationMethod", "temporalStatus", "spoofable"]) {
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
  const bioPhrase = sameName.identity.selectedCandidate.signals.find((signal) =>
    signal.kind === "bio_phrase");
  assert.equal(bioPhrase.value, "became the curator of the TED Conference in 2002");
  assert.equal(bioPhrase.sourceFamily, undefined);

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
    schemaVersion: 1,
    status: "ok",
    service: "atlas-people-intelligence",
    replayReady: true,
    exampleCount: 3,
    liveConfigured: false,
    model: null,
  });
  const keyOnlyHealth = await api.handleApiRequest(
    new Request("https://atlas.test/api/health"),
    { OPENROUTER_API_KEY: "server-secret" },
  );
  assert.equal((await keyOnlyHealth.json()).liveConfigured, false);
  const enabledHealth = await api.handleApiRequest(
    new Request("https://atlas.test/api/health"),
    {
      ATLAS_LIVE_ENABLED: "true",
      OPENROUTER_API_KEY: "server-secret",
      OPENROUTER_MODEL: "test/model",
    },
  );
  assert.deepEqual(await enabledHealth.json(), {
    schemaVersion: 1,
    status: "ok",
    service: "atlas-people-intelligence",
    replayReady: true,
    exampleCount: 3,
    liveConfigured: true,
    model: "test/model",
  });
  const response = await api.handleApiRequest(new Request("https://atlas.test/api/examples/python-creator"), {});
  const payload = await response.json();
  assert.equal(payload.id, "python-creator");
  assert.equal(payload.input.query, "the creator of Python");
  assert.equal(payload.trace.at(-1).name, "result.terminal");
});

test("POST replay streams byte-stable NDJSON ending in one terminal report", async () => {
  const request = () => new Request("https://atlas.test/api/research", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "the creator of Python", mode: "replay", exampleId: "python-creator" }),
  });
  const first = await api.handleApiRequest(request(), {});
  const second = await api.handleApiRequest(request(), {});
  assert.match(first.headers.get("content-type"), /^application\/x-ndjson/);
  const [firstText, secondText] = await Promise.all([first.text(), second.text()]);
  assert.equal(firstText, secondText);
  const events = parseNdjson(firstText);
  assert.equal(events.at(-1).name, "result.terminal");
  assert.equal(events.filter((event) => event.name === "result.terminal").length, 1);
  assert.equal(terminalReport(events).status, "completed");
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
  const response = api.traceNdjsonResponse(
    () => failingSource(),
    new AbortController().signal,
    input,
  );
  const events = parseNdjson(await response.text());
  assert.deepEqual(events.map((event) => event.seq), [1, 2, 3]);
  assert.equal(events[1].kind, "span_end");
  assert.equal(events[1].spanId, started.spanId);
  assert.equal(events[1].status, "failed");
  assert.equal(events[2].name, "result.terminal");
  assert.equal(events[2].payload.report.status, "failed");
  assert.equal(events[2].payload.report.stop.reason, "fatal_error");
  assert.equal(events[2].payload.report.runId, "run_stream_failure");
  assert.doesNotMatch(JSON.stringify(events), /private upstream detail/);
});

test("safety refusal precedes replay lookup and missing live key is an honest configuration terminal", async () => {
  const unsafe = await api.handleApiRequest(new Request("https://atlas.test/api/research", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "find this person's home address", mode: "replay" }),
  }), {});
  const unsafeEvents = parseNdjson(await unsafe.text());
  assert.equal(terminalReport(unsafeEvents).status, "blocked");
  assert.equal(terminalReport(unsafeEvents).stop.reason, "unsafe_request");

  const unconfigured = await api.handleApiRequest(new Request("https://atlas.test/api/research", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "Grace Hopper public professional background", mode: "live" }),
  }), {});
  const unconfiguredEvents = parseNdjson(await unconfigured.text());
  assert.equal(terminalReport(unconfiguredEvents).status, "configuration_error");
  assert.equal(terminalReport(unconfiguredEvents).stop.reason, "configuration_error");
  assert.match(terminalReport(unconfiguredEvents).stop.detail, /OPENROUTER_API_KEY/);

  const keyWithoutEnablement = await api.handleApiRequest(new Request("https://atlas.test/api/research", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "Grace Hopper public professional background", mode: "live" }),
  }), { OPENROUTER_API_KEY: "server-secret" });
  const keyWithoutEnablementEvents = parseNdjson(await keyWithoutEnablement.text());
  assert.equal(terminalReport(keyWithoutEnablementEvents).status, "configuration_error");
  assert.match(terminalReport(keyWithoutEnablementEvents).stop.detail, /ATLAS_LIVE_ENABLED=true/);
});

test("API rejects malformed and unmatched requests without starting synthetic research", async () => {
  const malformed = await api.handleApiRequest(new Request("https://atlas.test/api/research", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not-json",
  }), {});
  assert.equal(malformed.status, 400);

  const unmatched = await api.handleApiRequest(new Request("https://atlas.test/api/research", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "Ada Lovelace", mode: "replay" }),
  }), {});
  assert.equal(unmatched.status, 422);
  assert.equal((await unmatched.json()).error, "replay_not_found");
});

import { isTraceEvent, type TraceEvent } from "../agent/trace";
import { resolveBudgetLimits } from "../domain/budget";
import { candidateStatus, dedupeSignals, scoreCandidate } from "../domain/candidates";
import { canonicalizeSourceUrl, inferSourceFamily } from "../domain/evidence";
import { validateReferentialIntegrity } from "../domain/integrity";
import {
  requestedCategoriesForInput,
  resolveIdentity,
  restrictedReportContentPaths,
  summarizeSources,
} from "../domain/report";
import { cloneJson, isJsonValue, normalizeComparable } from "../domain/runtime";
import { classifySafety } from "../domain/safety";
import { parseTarget } from "../domain/target";
import { evaluateStop, terminalStatusForStop } from "../domain/stopping";
import { SCHEMA_VERSION, type InvestigationInput, type InvestigationReport, type InvestigationState, type JsonValue } from "../domain/types";
import { isInvestigationInput, isInvestigationReport } from "../domain/validation";

import linusInput from "../../examples/linus-codegraph/input.json" with { type: "json" };
import linusOutput from "../../examples/linus-codegraph/output.json" with { type: "json" };
import linusTrace from "../../examples/linus-codegraph/trace.json" with { type: "json" };
import linusCassette from "../../examples/linus-codegraph/cassette.json" with { type: "json" };
import linusManifest from "../../examples/linus-codegraph/manifest.json" with { type: "json" };

import chrisInput from "../../examples/chris-anderson-ted/input.json" with { type: "json" };
import chrisOutput from "../../examples/chris-anderson-ted/output.json" with { type: "json" };
import chrisTrace from "../../examples/chris-anderson-ted/trace.json" with { type: "json" };
import chrisCassette from "../../examples/chris-anderson-ted/cassette.json" with { type: "json" };
import chrisManifest from "../../examples/chris-anderson-ted/manifest.json" with { type: "json" };

import pythonInput from "../../examples/python-creator/input.json" with { type: "json" };
import pythonOutput from "../../examples/python-creator/output.json" with { type: "json" };
import pythonTrace from "../../examples/python-creator/trace.json" with { type: "json" };
import pythonCassette from "../../examples/python-creator/cassette.json" with { type: "json" };
import pythonManifest from "../../examples/python-creator/manifest.json" with { type: "json" };

export const REPLAY_IDS = [
  "linus-codegraph",
  "chris-anderson-ted",
  "python-creator",
] as const;

export type ReplayId = (typeof REPLAY_IDS)[number];

export interface ReplayManifest {
  schemaVersion: typeof SCHEMA_VERSION;
  id: ReplayId;
  title: string;
  description: string;
  capturedAt: string;
  captureMode: "source_verified_scripted_reconstruction";
  replayMode: "deterministic_zero_network";
  decisionProvenance: "scripted_local_policy";
  provider: null;
  networkOnReplay: "forbidden";
  files: string[];
}

export interface ReplayCassette {
  schemaVersion: typeof SCHEMA_VERSION;
  cassetteVersion: 2;
  capturedAt: string;
  networkOnReplay: "forbidden";
  decisionProvenance: "scripted_local_policy";
  requests: Array<Record<string, unknown>>;
  scriptedDecisions: Array<Record<string, unknown>>;
}

export interface ReplayExample {
  id: ReplayId;
  input: InvestigationInput;
  output: InvestigationReport;
  trace: TraceEvent[];
  cassette: ReplayCassette;
  manifest: ReplayManifest;
}

export interface RawReplay {
  input: unknown;
  output: unknown;
  trace: unknown;
  cassette: unknown;
  manifest: unknown;
}

export class ReplayValidationError extends TypeError {
  readonly replayId: ReplayId;

  constructor(replayId: ReplayId, message: string) {
    super(`Replay ${replayId} is invalid: ${message}`);
    this.name = "ReplayValidationError";
    this.replayId = replayId;
  }
}

const EXPECTED_REPLAY_FILES = [
  "cassette.json",
  "input.json",
  "manifest.json",
  "output.json",
  "trace.json",
] as const;

const RESEARCH_PHASES = new Set([
  "intake",
  "classify",
  "plan",
  "discover",
  "separate_candidates",
  "corroborate",
  "calibrate",
  "report",
  "terminal",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return (
    sortedLeft.length === sortedRight.length &&
    sortedLeft.every((value, index) => value === sortedRight[index])
  );
}

function isReplayManifest(value: unknown, id: ReplayId): value is ReplayManifest {
  return (
    isRecord(value) &&
    value.schemaVersion === SCHEMA_VERSION &&
    value.id === id &&
    isNonEmptyString(value.title) &&
    isNonEmptyString(value.description) &&
    isNonEmptyString(value.capturedAt) &&
    value.captureMode === "source_verified_scripted_reconstruction" &&
    value.replayMode === "deterministic_zero_network" &&
    value.decisionProvenance === "scripted_local_policy" &&
    value.provider === null &&
    value.networkOnReplay === "forbidden" &&
    Array.isArray(value.files) &&
    value.files.every(isNonEmptyString) &&
    sameStrings(value.files, EXPECTED_REPLAY_FILES) &&
    isJsonValue(value)
  );
}

function isCassetteRequest(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.response)) return false;
  return (
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.fingerprint) &&
    typeof value.response.status === "number" &&
    Number.isInteger(value.response.status) &&
    value.response.status >= 100 &&
    value.response.status <= 599 &&
    isNonEmptyString(value.response.contentType) &&
    typeof value.response.bodySha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.response.bodySha256) &&
    Array.isArray(value.response.evidenceBindings) &&
    value.response.evidenceBindings.every((binding) =>
      isRecord(binding)
      && isNonEmptyString(binding.evidenceId)
      && isNonEmptyString(binding.candidateId)
      && isNonEmptyString(binding.sourceUrl)
      && isNonEmptyString(binding.normalizedClaim)
      && (binding.excerpt === null || typeof binding.excerpt === "string")
      && (binding.canonicalSubset === null || isRecord(binding.canonicalSubset))
      && isJsonValue(binding)) &&
    isJsonValue(value)
  );
}

function isScriptedDecision(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.phase === "string" &&
    RESEARCH_PHASES.has(value.phase) &&
    isNonEmptyString(value.summary) &&
    isJsonValue(value)
  );
}

function isReplayCassette(value: unknown): value is ReplayCassette {
  return (
    isRecord(value) &&
    value.schemaVersion === SCHEMA_VERSION &&
    value.cassetteVersion === 2 &&
    isNonEmptyString(value.capturedAt) &&
    value.networkOnReplay === "forbidden" &&
    value.decisionProvenance === "scripted_local_policy" &&
    Array.isArray(value.requests) &&
    value.requests.every(isCassetteRequest) &&
    Array.isArray(value.scriptedDecisions) &&
    value.scriptedDecisions.every(isScriptedDecision) &&
    isJsonValue(value)
  );
}

function fail(id: ReplayId, message: string): never {
  throw new ReplayValidationError(id, message);
}

const RAW: Record<ReplayId, RawReplay> = {
  "linus-codegraph": {
    input: linusInput,
    output: linusOutput,
    trace: linusTrace,
    cassette: linusCassette,
    manifest: linusManifest,
  },
  "chris-anderson-ted": {
    input: chrisInput,
    output: chrisOutput,
    trace: chrisTrace,
    cassette: chrisCassette,
    manifest: chrisManifest,
  },
  "python-creator": {
    input: pythonInput,
    output: pythonOutput,
    trace: pythonTrace,
    cassette: pythonCassette,
    manifest: pythonManifest,
  },
};

function isReplayId(value: string): value is ReplayId {
  return (REPLAY_IDS as readonly string[]).includes(value);
}

function normalizeQuery(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return (
    isJsonValue(left) &&
    isJsonValue(right) &&
    canonicalJson(left) === canonicalJson(right)
  );
}

interface SpanDefinition {
  name: string;
  phase: string;
  parentSpanId: string | null;
  attempt: number;
}

function validateTrace(id: ReplayId, trace: TraceEvent[], output: InvestigationReport): void {
  if (trace.length === 0) fail(id, "trace must contain at least one event");
  const eventIds = new Set<string>();
  const definedSpans = new Map<string, SpanDefinition>();
  const openSpans = new Set<string>();
  let previousElapsed = -1;
  let previousTimestamp = -1;

  const allowedEmails = new Set(output.target.identifiers
    .filter((identifier) => identifier.kind === "email" && identifier.provenance === "user_input")
    .map((identifier) => identifier.normalizedValue));
  trace.forEach((event, index) => {
    if (!isTraceEvent(event, { allowedEmails })) {
      fail(id, `trace[${index}] does not match TraceEvent v1`);
    }
    if (event.seq !== index + 1) fail(id, `trace sequence is not contiguous at index ${index}`);
    if (event.runId !== output.runId) fail(id, `trace[${index}] has a foreign runId`);
    if (eventIds.has(event.eventId)) fail(id, `trace eventId ${event.eventId} is duplicated`);
    eventIds.add(event.eventId);
    if (event.elapsedMs < previousElapsed) fail(id, `trace elapsedMs regresses at seq ${event.seq}`);
    previousElapsed = event.elapsedMs;
    const timestamp = Date.parse(event.timestamp);
    if (!Number.isFinite(timestamp)) fail(id, `trace seq ${event.seq} has an invalid timestamp`);
    if (timestamp < previousTimestamp) fail(id, `trace timestamp regresses at seq ${event.seq}`);
    previousTimestamp = timestamp;

    if (event.parentSpanId !== null && !openSpans.has(event.parentSpanId)) {
      fail(id, `trace seq ${event.seq} references a parent span that is not open`);
    }
    if (event.kind === "span_start") {
      const spanId = event.spanId as string;
      if (definedSpans.has(spanId)) fail(id, `span ${spanId} starts more than once`);
      definedSpans.set(spanId, {
        name: event.name,
        phase: event.phase,
        parentSpanId: event.parentSpanId,
        attempt: event.attempt,
      });
      openSpans.add(spanId);
      return;
    }
    if (event.kind === "span_end") {
      const spanId = event.spanId as string;
      const start = definedSpans.get(spanId);
      if (!start || !openSpans.has(spanId)) fail(id, `span ${spanId} ends without one open start`);
      if (
        start.name !== event.name ||
        start.phase !== event.phase ||
        start.parentSpanId !== event.parentSpanId ||
        start.attempt !== event.attempt
      ) {
        fail(id, `span ${spanId} end metadata does not match its start`);
      }
      openSpans.delete(spanId);
    }
  });

  if (openSpans.size > 0) fail(id, `trace has unclosed spans: ${[...openSpans].sort().join(", ")}`);
  const investigationTerminals = trace.filter((event) => event.name === "investigation.terminal");
  if (investigationTerminals.length !== 1) {
    fail(id, "trace must contain exactly one investigation.terminal event");
  }
  const investigationTerminal = investigationTerminals[0];
  if (
    investigationTerminal.phase !== "terminal"
    || investigationTerminal.payload.status !== output.status
    || investigationTerminal.payload.reason !== output.stop.reason
    || investigationTerminal.payload.detail !== output.stop.detail
  ) {
    fail(id, "investigation.terminal semantics do not match the report");
  }
  const terminalEvents = trace.filter((event) => event.name === "result.terminal");
  if (terminalEvents.length !== 1 || trace.at(-1) !== terminalEvents[0]) {
    fail(id, "trace must end in exactly one result.terminal event");
  }
  const terminal = terminalEvents[0];
  if (
    terminal.phase !== "terminal" ||
    terminal.payload.status !== output.status ||
    terminal.payload.stopReason !== output.stop.reason
  ) {
    fail(id, "terminal trace status does not match the report");
  }
  if (!jsonEqual(terminal.payload.report, output)) {
    fail(id, "terminal trace report does not byte-semantically match output.json");
  }
}

function validateReportGraph(
  id: ReplayId,
  output: InvestigationReport,
  cassette: ReplayCassette,
): void {
  if (!jsonEqual(output.target, parseTarget(output.input))) {
    fail(id, "report target does not match deterministic input parsing");
  }
  const canonicalStatus = terminalStatusForStop(output.stop.reason, output.candidates);
  if (output.status !== canonicalStatus) {
    fail(id, `report status ${output.status} is invalid for stop reason ${output.stop.reason}`);
  }
  const restrictedPaths = restrictedReportContentPaths(output);
  if (restrictedPaths.length > 0) {
    fail(id, `report contains restricted public content at ${restrictedPaths[0]}`);
  }
  const integrityIssues = validateReferentialIntegrity(output);
  if (integrityIssues.length > 0) {
    fail(id, `report graph failed integrity: ${integrityIssues[0].path} ${integrityIssues[0].message}`);
  }
  const candidateById = new Map(output.candidates.map((candidate) => [candidate.id, candidate]));
  const evidenceById = new Map(output.evidence.map((evidence) => [evidence.id, evidence]));
  for (const candidate of output.candidates) {
    const normalizedSignals = dedupeSignals(candidate.signals);
    const expectedScore = scoreCandidate({
      displayName: candidate.displayName,
      signals: normalizedSignals,
    }, output.target);
    if (
      candidate.normalizedName !== normalizeComparable(candidate.displayName)
      || !jsonEqual(candidate.signals, normalizedSignals)
      || !jsonEqual(candidate.score, expectedScore)
      || candidate.status !== candidateStatus(normalizedSignals, expectedScore)
    ) {
      fail(id, `candidate ${candidate.id} contains non-canonical derived identity state`);
    }
    const expectedEvidenceIds = output.evidence
      .filter((evidence) => evidence.candidateId === candidate.id)
      .map((evidence) => evidence.id);
    if (!sameStrings(candidate.evidenceIds, expectedEvidenceIds)) {
      fail(id, `candidate ${candidate.id} evidence index does not match the report graph`);
    }
    for (const signal of candidate.signals) {
      if (!signal.sourceEvidenceId) continue;
      const evidence = evidenceById.get(signal.sourceEvidenceId);
      if (!evidence || evidence.candidateId !== candidate.id) {
        fail(id, `candidate ${candidate.id} has a foreign signal sourceEvidenceId`);
      }
    }
  }
  for (const evidence of output.evidence) {
    let expectedCanonicalUrl = "";
    let expectedFamily = "";
    let expectedQueryUrl: string | null = null;
    try {
      expectedCanonicalUrl = canonicalizeSourceUrl(evidence.sourceUrl);
      expectedFamily = inferSourceFamily(expectedCanonicalUrl);
      expectedQueryUrl = evidence.queryUrl === null
        ? null
        : canonicalizeSourceUrl(evidence.queryUrl);
    } catch {
      fail(id, `evidence ${evidence.id} has an invalid canonical source URL`);
    }
    if (
      evidence.sourceUrl !== expectedCanonicalUrl
      || evidence.canonicalUrl !== expectedCanonicalUrl
      || evidence.sourceFamily !== expectedFamily
    ) {
      fail(id, `evidence ${evidence.id} source URL or sourceFamily is not canonically derived`);
    }
    if (
      evidence.normalizedClaim !== normalizeComparable(evidence.claim)
      || (
        evidence.verificationMethod === "direct_fetch"
        && (!evidence.excerpt || evidence.claim !== evidence.excerpt)
      )
    ) {
      fail(id, `evidence ${evidence.id} claim is not the canonical extractive claim`);
    }
    if (evidence.queryUrl !== expectedQueryUrl) {
      fail(id, `evidence ${evidence.id} query URL is not canonical`);
    }
  }
  for (const finding of output.findings) {
    if (
      !sameStrings(finding.evidenceIds, finding.confidence.supportingEvidenceIds) ||
      !sameStrings(finding.counterEvidenceIds, finding.confidence.contradictingEvidenceIds)
    ) {
      fail(id, `finding ${finding.id} confidence evidence indexes are inconsistent`);
    }
  }
  for (const [label, candidateId, embedded] of [
    ["selected", output.identity.selectedCandidateId, output.identity.selectedCandidate],
    ["runner-up", output.identity.runnerUpCandidateId, output.identity.runnerUpCandidate],
  ] as const) {
    if (!candidateId && embedded === null) continue;
    const candidate = candidateId ? candidateById.get(candidateId) : undefined;
    if (!candidate || !jsonEqual(candidate, embedded)) {
      fail(id, `identity ${label} candidate is not the canonical report candidate`);
    }
  }
  if (output.identity.status === "resolved" && output.identity.selectedCandidate === null) {
    fail(id, "resolved identity is missing a selected candidate");
  }
  if (!jsonEqual(output.identity, resolveIdentity(output.candidates))) {
    fail(id, "identity selection or runner-up margin does not match candidate ranking");
  }

  const requestIds = new Set<string>();
  const requestHashes = new Map<string, string>();
  const evidenceBindings = new Map<string, JsonValue>();
  for (const request of cassette.requests) {
    const requestId = request.id as string;
    if (requestIds.has(requestId)) fail(id, `cassette request id ${requestId} is duplicated`);
    requestIds.add(requestId);
    const response = request.response as Record<string, unknown>;
    requestHashes.set(requestId, response.bodySha256 as string);
    for (const binding of response.evidenceBindings as Array<Record<string, unknown>>) {
      const evidenceId = binding.evidenceId as string;
      if (evidenceBindings.has(evidenceId)) {
        fail(id, `cassette evidence binding ${evidenceId} is duplicated`);
      }
      evidenceBindings.set(evidenceId, binding as JsonValue);
    }
  }
  for (const evidence of output.evidence) {
    if (evidence.toolCallId === null) continue;
    if (!requestIds.has(evidence.toolCallId)) {
      fail(id, `evidence ${evidence.id} references an absent cassette request`);
    }
    const expectedBodyHash = requestHashes.get(evidence.toolCallId);
    if (evidence.contentHash !== `sha256:${expectedBodyHash}`) {
      fail(id, `evidence ${evidence.id} content hash differs from its cassette response`);
    }
    const expectedBinding: JsonValue = {
      evidenceId: evidence.id,
      candidateId: evidence.candidateId,
      sourceUrl: evidence.sourceUrl,
      normalizedClaim: evidence.normalizedClaim,
      excerpt: evidence.excerpt,
      canonicalSubset: evidence.canonicalSubset,
    };
    if (!jsonEqual(evidenceBindings.get(evidence.id), expectedBinding)) {
      fail(id, `evidence ${evidence.id} differs from its cassette evidence binding`);
    }
  }
  const reportEvidenceIds = new Set(output.evidence
    .filter((evidence) => evidence.toolCallId !== null)
    .map((evidence) => evidence.id));
  for (const evidenceId of evidenceBindings.keys()) {
    if (!reportEvidenceIds.has(evidenceId)) {
      fail(id, `cassette evidence binding ${evidenceId} has no report evidence record`);
    }
  }

  if (!jsonEqual(output.sources, summarizeSources(output.evidence))) {
    fail(id, "report source summaries do not match admitted evidence");
  }
  const selectedCandidateId = output.identity.selectedCandidateId;
  const selectedEvidence = selectedCandidateId
    ? output.evidence.filter((evidence) => evidence.candidateId === selectedCandidateId)
    : [];
  const selectedFindings = selectedCandidateId
    ? output.findings.filter((finding) => finding.candidateId === selectedCandidateId)
    : [];
  const expectedCoveredCategories = output.coverage.requestedCategories.filter((category) =>
    selectedFindings.some(
      (finding) => finding.category === category && finding.confidence.score >= 0.45,
    ),
  );
  const expectedMissingCategories = output.coverage.requestedCategories.filter(
    (category) => !expectedCoveredCategories.includes(category),
  );
  const expectedIndependentFamilies = new Set(
    selectedEvidence
      .filter((evidence) => evidence.disposition === "supports")
      .map((evidence) => evidence.sourceFamily),
  ).size;
  if (
    !sameStrings(output.coverage.coveredCategories, expectedCoveredCategories) ||
    !sameStrings(output.coverage.missingCategories, expectedMissingCategories) ||
    output.coverage.supportedFindingCount !==
      selectedFindings.filter((finding) => finding.confidence.score >= 0.45).length ||
    output.coverage.highConfidenceFindingCount !==
      selectedFindings.filter((finding) => finding.confidence.score >= 0.75).length ||
    output.coverage.independentSourceFamilyCount !== expectedIndependentFamilies
  ) {
    fail(id, "report coverage is not scoped to the selected candidate");
  }
  const expectedEvidenceTelemetry = {
    admitted: output.evidence.length,
    discoveryOnly: output.evidence.filter((evidence) => evidence.disposition === "discovery_only").length,
    supporting: output.evidence.filter((evidence) => evidence.disposition === "supports").length,
    contradicting: output.evidence.filter((evidence) => evidence.disposition === "contradicts").length,
  };
  if (
    output.telemetry.candidateCount !== output.candidates.length ||
    output.telemetry.resolvedCandidateCount !==
      output.candidates.filter((candidate) => candidate.status === "resolved").length ||
    output.telemetry.findingCount !== output.findings.length ||
    output.telemetry.highConfidenceFindingCount !==
      output.findings.filter((finding) => finding.confidence.score >= 0.75).length ||
    output.telemetry.evidence.admitted !== expectedEvidenceTelemetry.admitted ||
    output.telemetry.evidence.discoveryOnly !== expectedEvidenceTelemetry.discoveryOnly ||
    output.telemetry.evidence.supporting !== expectedEvidenceTelemetry.supporting ||
    output.telemetry.evidence.contradicting !== expectedEvidenceTelemetry.contradicting
  ) {
    fail(id, "report telemetry counts do not match the report graph");
  }

  if (!sameStrings(
    output.coverage.requestedCategories,
    requestedCategoriesForInput(output.input),
  )) {
    fail(id, "report coverage categories differ from the input policy");
  }

  const stateVerifiableReasons = new Set([
    "goal_satisfied",
    "unsafe_request",
    "budget_exhausted",
    "diminishing_returns",
    "planner_requested",
  ]);
  if (stateVerifiableReasons.has(output.stop.reason)) {
    if (output.stop.reason === "goal_satisfied" && output.coverage.gaps.length > 0) {
      fail(id, "goal_satisfied report retains unresolved coverage gaps");
    }
    const capturedYear = Number(output.generatedAt.slice(0, 4));
    const state: InvestigationState = {
      schemaVersion: SCHEMA_VERSION,
      runId: output.runId,
      revision: 0,
      status: "running",
      phase: "report",
      input: output.input,
      target: output.target,
      safety: classifySafety(output.input, {
        currentYear: Number.isInteger(capturedYear) ? capturedYear : undefined,
      }),
      candidates: output.candidates,
      evidence: output.evidence,
      findings: output.findings,
      openQuestions: [...output.coverage.gaps],
      evidenceTelemetry: output.telemetry.evidence,
      budget: {
        limits: resolveBudgetLimits(output.input.requestedDepth ?? "standard"),
        usage: output.usage,
      },
      startedAt: output.generatedAt,
      updatedAt: output.generatedAt,
    };
    const stop = evaluateStop(state, output.stop.reason === "planner_requested"
      ? { plannerRequested: true }
      : {});
    if (!stop.allowed || stop.reason !== output.stop.reason) {
      fail(id, `${output.stop.reason} report is stop-illegal: ${stop.detail}`);
    }
  }
}

/** Fail-closed hydration used by API, CLI, and tests before replay data is exposed. */
export function validateReplayBundle(id: ReplayId, raw: RawReplay): ReplayExample {
  if (!isInvestigationInput(raw.input)) fail(id, "input.json does not match InvestigationInput v1");
  if (!isInvestigationReport(raw.output)) fail(id, "output.json does not match InvestigationReport v1");
  const canonicalTarget = parseTarget(raw.input);
  if (!jsonEqual(raw.output.target, canonicalTarget)) {
    fail(id, "report target does not match deterministic input parsing");
  }
  const earlyRestrictedPaths = restrictedReportContentPaths(raw.output);
  if (earlyRestrictedPaths.length > 0) {
    fail(id, `report contains restricted public content at ${earlyRestrictedPaths[0]}`);
  }
  const allowedEmails = new Set(canonicalTarget.identifiers
    .filter((identifier) => identifier.kind === "email" && identifier.provenance === "user_input")
    .map((identifier) => identifier.normalizedValue));
  if (!Array.isArray(raw.trace) || !raw.trace.every((event) =>
    isTraceEvent(event, { allowedEmails }))) {
    fail(id, "trace.json contains an invalid TraceEvent v1");
  }
  if (!isReplayCassette(raw.cassette)) fail(id, "cassette.json does not match cassette v2");
  if (!isReplayManifest(raw.manifest, id)) fail(id, "manifest.json does not match its replay id");

  const example: ReplayExample = {
    id,
    input: raw.input,
    output: raw.output,
    trace: raw.trace,
    cassette: raw.cassette,
    manifest: raw.manifest,
  };
  if (!jsonEqual(example.input, example.output.input)) {
    fail(id, "input.json differs from output.input");
  }
  if (example.manifest.capturedAt !== example.cassette.capturedAt) {
    fail(id, "manifest and cassette capture timestamps differ");
  }
  validateReportGraph(id, example.output, example.cassette);
  validateTrace(id, example.trace, example.output);
  return cloneJson(example);
}

function hydrate(id: ReplayId): ReplayExample {
  return validateReplayBundle(id, RAW[id]);
}

export function getReplayExample(id: string): ReplayExample | null {
  return isReplayId(id) ? hydrate(id) : null;
}

export function findReplayForQuery(query: string): ReplayExample | null {
  const normalized = normalizeQuery(query);
  for (const id of REPLAY_IDS) {
    const example = hydrate(id);
    if (normalizeQuery(example.input.query) === normalized) return example;
  }
  return null;
}

export function listReplayExamples(): Array<Pick<ReplayExample, "id" | "input" | "manifest">> {
  return REPLAY_IDS.map((id) => {
    const example = hydrate(id);
    return { id, input: example.input, manifest: example.manifest };
  });
}

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

/** Stable serialization used by replay byte-stability tests and the CLI. */
export function canonicalJson(value: JsonValue): string {
  return `${JSON.stringify(canonicalize(value))}\n`;
}

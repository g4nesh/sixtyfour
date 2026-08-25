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
import {
  SCHEMA_VERSION,
  type InvestigationInput,
  type InvestigationReport,
  type InvestigationState,
  type JsonValue,
} from "../domain/types";
import { isInvestigationInput, isInvestigationReport } from "../domain/validation";
import {
  calculateEdgeCost,
  compareFrontierEntries,
  deriveMutationProposal,
  sourceLaneById,
  validateSearchGraph,
} from "../search";
import {
  VERIFIED_PUBLIC_CAPTURES,
  assertVerifiedEvidenceContract,
  type VerifiedRequestId,
} from "../../scripts/capture-contract";

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

export const REPLAY_IDS = ["linus-codegraph", "chris-anderson-ted", "python-creator"] as const;

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

const EXPECTED_REPLAY_FILES = ["cassette.json", "input.json", "manifest.json", "output.json", "trace.json"] as const;

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
  return sortedLeft.length === sortedRight.length && sortedLeft.every((value, index) => value === sortedRight[index]);
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
    isNonEmptyString(value.captureId) &&
    value.actionId === value.id &&
    value.frontierEntryId === value.id &&
    isNonEmptyString(value.fingerprint) &&
    typeof value.response.status === "number" &&
    Number.isInteger(value.response.status) &&
    value.response.status >= 100 &&
    value.response.status <= 599 &&
    isNonEmptyString(value.response.contentType) &&
    typeof value.response.bodySha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.response.bodySha256) &&
    Array.isArray(value.response.evidenceBindings) &&
    value.response.evidenceBindings.every(
      (binding) =>
        isRecord(binding) &&
        isNonEmptyString(binding.evidenceId) &&
        isNonEmptyString(binding.candidateId) &&
        isNonEmptyString(binding.sourceUrl) &&
        isNonEmptyString(binding.normalizedClaim) &&
        (binding.excerpt === null || typeof binding.excerpt === "string") &&
        (binding.canonicalSubset === null || isRecord(binding.canonicalSubset)) &&
        isJsonValue(binding),
    ) &&
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
  return isJsonValue(left) && isJsonValue(right) && canonicalJson(left) === canonicalJson(right);
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

  const allowedEmails = new Set(
    output.target.identifiers
      .filter((identifier) => identifier.kind === "email" && identifier.provenance === "user_input")
      .map((identifier) => identifier.normalizedValue),
  );
  trace.forEach((event, index) => {
    if (!isTraceEvent(event, { allowedEmails })) {
      fail(id, `trace[${index}] does not match the current TraceEvent schema`);
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
    investigationTerminal.phase !== "terminal" ||
    investigationTerminal.payload.status !== output.status ||
    investigationTerminal.payload.reason !== output.stop.reason ||
    investigationTerminal.payload.detail !== output.stop.detail
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

const EXECUTION_COST_PRECISION = 1_000_000;

function executionCost(value: number): number {
  return Math.round(value * EXECUTION_COST_PRECISION) / EXECUTION_COST_PRECISION;
}

function payloadString(event: TraceEvent, key: string): string | null {
  const value = event.payload[key];
  return typeof value === "string" ? value : null;
}

function validateExecutionGraph(
  id: ReplayId,
  output: InvestigationReport,
  trace: TraceEvent[],
  cassette: ReplayCassette,
): void {
  const graph = output.searchGraph;
  const sharedIssues = validateSearchGraph(graph);
  if (sharedIssues.length > 0) {
    fail(id, `search graph invariant failed: ${sharedIssues[0].code} at ${sharedIssues[0].path}`);
  }
  if (graph.runId !== output.runId) fail(id, "search graph has a foreign runId");
  if (graph.status !== "completed") fail(id, "completed replay must retain a completed search graph");
  if (graph.selectedFrontierEntryIds.length > 0) {
    fail(id, "completed search graph retains selected frontier entries");
  }
  if (!graph.seedNodeId || !graph.nodes.some((node) => node.id === graph.seedNodeId)) {
    fail(id, "search graph is missing its seed node");
  }
  if (graph.seed !== output.target.normalizedQuery) {
    fail(id, "search graph seed differs from the parsed target");
  }

  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const frontier = new Map(graph.frontier.map((entry) => [entry.id, entry]));
  const rootEntries = graph.frontier.filter((entry) => entry.parentFrontierEntryId === null);
  for (const entry of graph.frontier) {
    const lane = sourceLaneById(entry.sourceLaneId);
    if (!lane) fail(id, `frontier ${entry.id} uses an unregistered source lane`);
    if (entry.sourceTier !== lane.tier) {
      fail(id, `frontier ${entry.id} forges its source tier`);
    }
    if (entry.allowedTools.length === 0 || entry.allowedTools.some((tool) => !lane.allowedTools.includes(tool))) {
      fail(id, `frontier ${entry.id} contains a tool outside its source lane`);
    }
    if (lane.requiresCandidate && entry.candidateId === null) {
      fail(id, `frontier ${entry.id} skipped its candidate binding`);
    }
    if (lane.requiresExactCandidateUrl) {
      try {
        const url = new URL(entry.queryHint);
        if (url.protocol !== "https:") throw new TypeError("not https");
      } catch {
        fail(id, `frontier ${entry.id} lacks the exact candidate HTTPS URL required by its lane`);
      }
    }
    const expectedEdgeCost = calculateEdgeCost(entry.sourceTier, entry.depth, entry.utility);
    if (entry.edgeCost !== expectedEdgeCost) {
      fail(id, `frontier ${entry.id} has a forged edge cost`);
    }
    const parent = entry.parentFrontierEntryId ? frontier.get(entry.parentFrontierEntryId) : null;
    if (entry.parentFrontierEntryId && !parent) {
      fail(id, `frontier ${entry.id} references an absent parent frontier entry`);
    }
    if (entry.parentNodeId !== (parent?.nodeId ?? graph.seedNodeId)) {
      fail(id, `frontier ${entry.id} parent node does not match its frontier parent`);
    }
    if (entry.depth !== (parent?.depth ?? -1) + 1) {
      fail(id, `frontier ${entry.id} has a forged traversal depth`);
    }
    const expectedPathCost = executionCost((parent?.pathCost ?? 0) + entry.edgeCost);
    if (entry.pathCost !== expectedPathCost) {
      fail(id, `frontier ${entry.id} has a forged cumulative path cost`);
    }
    const node = nodes.get(entry.nodeId);
    if (
      !node ||
      node.frontierEntryId !== entry.id ||
      node.actionId !== entry.id ||
      node.sourceLaneId !== entry.sourceLaneId ||
      node.sourceTier !== entry.sourceTier ||
      node.candidateId !== entry.candidateId ||
      node.data.intent !== entry.intent ||
      node.data.queryHint !== entry.queryHint
    ) {
      fail(id, `frontier ${entry.id} does not match its graph node`);
    }
    const expansion = graph.edges.find(
      (edge) =>
        edge.fromNodeId === entry.parentNodeId &&
        edge.toNodeId === entry.nodeId &&
        edge.frontierEntryId === entry.id &&
        edge.actionId === entry.id &&
        edge.kind === (entry.mutation ? "mutates" : "expands"),
    );
    if (!expansion || expansion.edgeCost !== entry.edgeCost || expansion.pathCost !== entry.pathCost) {
      fail(id, `frontier ${entry.id} is missing its exact-cost expansion edge`);
    }
  }
  if (rootEntries.some((entry) => entry.depth !== 0)) {
    fail(id, "root frontier entries must have depth zero");
  }

  for (const node of graph.nodes) {
    if (node.frontierEntryId === null && node.actionId === null) continue;
    if (
      node.frontierEntryId === null ||
      node.actionId !== node.frontierEntryId ||
      !frontier.has(node.frontierEntryId)
    ) {
      fail(id, `graph node ${node.id} has a broken stable action join`);
    }
  }
  for (const edge of graph.edges) {
    if (edge.frontierEntryId === null && edge.actionId === null) continue;
    if (
      edge.frontierEntryId === null ||
      edge.actionId !== edge.frontierEntryId ||
      !frontier.has(edge.frontierEntryId)
    ) {
      fail(id, `graph edge ${edge.id} has a broken stable action join`);
    }
  }

  const nodePathCost = new Map<string, number>([[graph.seedNodeId, 0]]);
  for (const entry of graph.frontier) nodePathCost.set(entry.nodeId, entry.pathCost);
  for (const edge of [...graph.edges].sort((left, right) => left.ordinal - right.ordinal)) {
    const sourcePath = nodePathCost.get(edge.fromNodeId);
    if (sourcePath === undefined) {
      fail(id, `graph edge ${edge.id} has no cost-resolved source node`);
    }
    const expectedPathCost = executionCost(sourcePath + edge.edgeCost);
    if (edge.pathCost !== expectedPathCost) {
      fail(id, `graph edge ${edge.id} has a forged cumulative path cost`);
    }
    if (!nodePathCost.has(edge.toNodeId)) nodePathCost.set(edge.toNodeId, edge.pathCost);
    const from = nodes.get(edge.fromNodeId);
    const to = nodes.get(edge.toNodeId);
    if (!from || !to) fail(id, `graph edge ${edge.id} is dangling`);
    if (
      edge.kind !== "separates" &&
      from.candidateId !== null &&
      to.candidateId !== null &&
      from.candidateId !== to.candidateId
    ) {
      fail(id, `graph edge ${edge.id} crosses candidate ledgers`);
    }
    if (
      edge.kind === "separates" &&
      (from.candidateId === null || to.candidateId === null || from.candidateId === to.candidateId)
    ) {
      fail(id, `graph separation edge ${edge.id} does not separate two candidates`);
    }
  }

  const nodeAdmissionEvents = trace.filter((event) => event.name === "graph.node_admitted");
  const edgeAdmissionEvents = trace.filter((event) => event.name === "graph.edge_admitted");
  for (const node of graph.nodes) {
    const events = nodeAdmissionEvents.filter((event) => payloadString(event, "nodeId") === node.id);
    if (
      events.length !== 1 ||
      payloadString(events[0], "kind") !== node.kind ||
      payloadString(events[0], "frontierEntryId") !== node.frontierEntryId ||
      payloadString(events[0], "actionId") !== node.actionId
    ) {
      fail(id, `graph node ${node.id} disagrees with its admission trace`);
    }
  }
  for (const edge of graph.edges) {
    const events = edgeAdmissionEvents.filter((event) => payloadString(event, "edgeId") === edge.id);
    if (
      events.length !== 1 ||
      payloadString(events[0], "fromNodeId") !== edge.fromNodeId ||
      payloadString(events[0], "toNodeId") !== edge.toNodeId ||
      payloadString(events[0], "kind") !== edge.kind ||
      events[0].payload.edgeCost !== edge.edgeCost ||
      events[0].payload.pathCost !== edge.pathCost
    ) {
      fail(id, `graph edge ${edge.id} disagrees with its admission trace`);
    }
  }

  const queued = new Set<string>();
  let completedTools = 0;
  let completedMutationTools = 0;
  let selectedCount = 0;
  let expandedCount = 0;
  let exhaustedCount = 0;
  for (const event of trace) {
    if (event.name === "frontier.enqueued") {
      const frontierEntryId = payloadString(event, "frontierEntryId");
      if (!frontierEntryId || !frontier.has(frontierEntryId)) {
        fail(id, "frontier enqueue trace references an absent entry");
      }
      queued.add(frontierEntryId);
      continue;
    }
    if (event.name === "mutation.rejected") {
      const frontierEntryId = payloadString(event, "frontierEntryId");
      if (frontierEntryId) queued.delete(frontierEntryId);
      continue;
    }
    if (event.name === "frontier.selected") {
      const frontierEntryId = payloadString(event, "frontierEntryId");
      const selected = frontierEntryId ? frontier.get(frontierEntryId) : undefined;
      if (!selected || !queued.has(selected.id)) {
        fail(id, "frontier selection trace references a non-queued entry");
      }
      const executable = [...queued]
        .map((entryId) => frontier.get(entryId))
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
        .filter((entry) => {
          if (!entry.mutation) return true;
          return (completedMutationTools + 1) / (completedTools + 1) <= 0.2 + Number.EPSILON;
        });
      const minimumTier = executable.length > 0 ? Math.min(...executable.map((entry) => entry.sourceTier)) : null;
      const eligible = executable.filter((entry) => entry.sourceTier === minimumTier).sort(compareFrontierEntries);
      if (eligible[0]?.id !== selected.id) {
        fail(id, `frontier ${selected.id} was selected ahead of a lower-cost legal entry`);
      }
      queued.delete(selected.id);
      selectedCount += 1;
      continue;
    }
    if (
      (event.name === "frontier.expanded" || event.name === "frontier.exhausted") &&
      typeof event.payload.status === "string"
    ) {
      const frontierEntryId = payloadString(event, "frontierEntryId");
      const entry = frontierEntryId ? frontier.get(frontierEntryId) : undefined;
      if (!entry) fail(id, "frontier outcome trace references an absent entry");
      completedTools += 1;
      if (entry.mutation) completedMutationTools += 1;
      if (event.name === "frontier.expanded") expandedCount += 1;
      else exhaustedCount += 1;
    }
  }
  if (
    graph.telemetry.selected !== selectedCount ||
    graph.telemetry.toolCalls !== completedTools ||
    graph.telemetry.mutationToolCalls !== completedMutationTools ||
    graph.telemetry.expanded !== expandedCount ||
    graph.telemetry.exhausted !== exhaustedCount
  ) {
    fail(id, "search graph telemetry disagrees with frontier trace events");
  }

  const mutationEntries = graph.frontier.filter((entry) => entry.mutation !== null);
  const proposedEvents = trace.filter((event) => event.name === "mutation.proposed");
  const acceptedEvents = trace.filter((event) => event.name === "mutation.accepted");
  const rejectedEvents = trace.filter((event) => event.name === "mutation.rejected");
  const proposalIndexes = mutationEntries
    .map((entry) => entry.mutation?.proposalIndex)
    .sort((left, right) => (left ?? -1) - (right ?? -1));
  if (graph.mutationStep !== mutationEntries.length || proposalIndexes.some((value, index) => value !== index)) {
    fail(id, "mutation proposal indexes are not canonical and contiguous");
  }
  for (const entry of mutationEntries) {
    const mutation = entry.mutation;
    if (!mutation) continue;
    const parent = frontier.get(mutation.parentFrontierEntryId);
    if (!parent || entry.parentFrontierEntryId !== parent.id) {
      fail(id, `mutation ${entry.id} has an invalid parent`);
    }
    const expected = deriveMutationProposal(graph, output.target, parent, mutation.proposalIndex);
    if (
      !expected ||
      mutation.strategy !== expected.strategy ||
      mutation.temperature !== expected.temperature ||
      mutation.logAcceptanceRatio !== expected.logAcceptanceRatio ||
      mutation.acceptanceProbability !== expected.acceptanceProbability ||
      mutation.deterministicU !== expected.deterministicU ||
      mutation.parentNeighborCount !== expected.parentNeighborCount ||
      mutation.candidateNeighborCount !== expected.candidateNeighborCount ||
      entry.sourceLaneId !== expected.candidateLane.id ||
      entry.sourceTier !== expected.candidateLane.tier ||
      !jsonEqual(entry.allowedTools, [...expected.candidateLane.allowedTools].sort()) ||
      entry.candidateId !== parent.candidateId ||
      entry.queryHint !== expected.queryHint ||
      entry.intent !== expected.intent ||
      !jsonEqual(entry.utility, expected.utility) ||
      entry.edgeCost !== expected.candidateCost
    ) {
      fail(id, `mutation ${entry.id} differs from its canonical deterministic proposal`);
    }
    const accepted = expected.accepted;
    const proposal = proposedEvents.find(
      (event) =>
        event.payload.proposalIndex === mutation.proposalIndex &&
        payloadString(event, "parentFrontierEntryId") === parent.id,
    );
    const result = [...acceptedEvents, ...rejectedEvents].find(
      (event) => payloadString(event, "frontierEntryId") === entry.id,
    );
    if (
      !proposal ||
      proposal.payload.strategy !== expected.strategy ||
      proposal.payload.fromSourceLaneId !== parent.sourceLaneId ||
      proposal.payload.toSourceLaneId !== expected.candidateLane.id ||
      proposal.payload.queryChanged !== (expected.queryHint !== parent.queryHint) ||
      proposal.payload.temperature !== mutation.temperature ||
      proposal.payload.logAcceptanceRatio !== mutation.logAcceptanceRatio ||
      proposal.payload.acceptanceProbability !== mutation.acceptanceProbability ||
      proposal.payload.deterministicU !== mutation.deterministicU ||
      proposal.payload.parentNeighborCount !== mutation.parentNeighborCount ||
      proposal.payload.candidateNeighborCount !== mutation.candidateNeighborCount ||
      !result ||
      result.name !== (accepted ? "mutation.accepted" : "mutation.rejected") ||
      result.payload.strategy !== expected.strategy ||
      result.payload.fromSourceLaneId !== parent.sourceLaneId ||
      result.payload.toSourceLaneId !== expected.candidateLane.id ||
      result.payload.queryChanged !== (expected.queryHint !== parent.queryHint) ||
      result.payload.acceptanceProbability !== expected.acceptanceProbability ||
      result.payload.deterministicU !== expected.deterministicU
    ) {
      fail(id, `mutation ${entry.id} disagrees with its trace calculation`);
    }
  }
  if (
    graph.telemetry.mutationsProposed !== proposedEvents.length ||
    graph.telemetry.mutationsAccepted !== acceptedEvents.length ||
    graph.telemetry.mutationsRejected !== rejectedEvents.length ||
    mutationEntries.length !== acceptedEvents.length + rejectedEvents.length
  ) {
    fail(id, "mutation telemetry disagrees with the execution graph");
  }

  const captureIds = new Set<string>();
  const actionCaptureIds: Record<string, VerifiedRequestId> = {};
  for (const request of cassette.requests) {
    const actionId = request.id as string;
    const captureId = request.captureId as string;
    if (captureIds.has(captureId)) fail(id, `cassette captureId ${captureId} is duplicated`);
    captureIds.add(captureId);
    if (!(captureId in VERIFIED_PUBLIC_CAPTURES)) {
      fail(id, `cassette captureId ${captureId} is not root-verified`);
    }
    const verifiedCaptureId = captureId as VerifiedRequestId;
    const verifiedCapture = VERIFIED_PUBLIC_CAPTURES[verifiedCaptureId];
    actionCaptureIds[actionId] = verifiedCaptureId;
    const response = request.response as Record<string, unknown>;
    if (response.bodySha256 !== verifiedCapture.bodySha256) {
      fail(id, `cassette capture ${captureId} has a forged response hash`);
    }
    if (
      "requestFingerprint" in verifiedCapture &&
      verifiedCapture.requestFingerprint &&
      request.fingerprint !== verifiedCapture.requestFingerprint
    ) {
      fail(id, `cassette capture ${captureId} has a forged request fingerprint`);
    }
    if (
      "canonicalSubset" in verifiedCapture &&
      verifiedCapture.canonicalSubset &&
      !jsonEqual(response.canonicalSubset, verifiedCapture.canonicalSubset)
    ) {
      fail(id, `cassette capture ${captureId} has a forged canonical API subset`);
    }
    const entry = frontier.get(actionId);
    if (!entry || entry.actionId !== actionId || entry.frontierEntryId !== actionId) {
      fail(id, `cassette action ${actionId} has no stable frontier join`);
    }
    if (!["verified", "exhausted", "rejected"].includes(entry.status)) {
      fail(id, `cassette action ${actionId} was never completed`);
    }
    const starts = trace.filter(
      (event) =>
        event.kind === "span_start" &&
        event.name.startsWith("tool.") &&
        payloadString(event, "actionId") === actionId &&
        payloadString(event, "captureId") === captureId,
    );
    const ends = trace.filter(
      (event) =>
        event.kind === "span_end" &&
        payloadString(event, "actionId") === actionId &&
        payloadString(event, "captureId") === captureId,
    );
    if (
      starts.length !== 1 ||
      ends.length !== 1 ||
      starts[0].spanId !== ends[0].spanId ||
      payloadString(starts[0], "frontierEntryId") !== actionId ||
      payloadString(starts[0], "requestFingerprint") !== request.fingerprint
    ) {
      fail(id, `cassette capture ${captureId} disagrees with its tool trace`);
    }
  }
  try {
    assertVerifiedEvidenceContract(output.evidence, actionCaptureIds);
  } catch {
    fail(id, "report evidence differs from its root-verified capture projection");
  }
  for (const start of trace.filter((event) => event.kind === "span_start" && event.name.startsWith("tool."))) {
    const actionId = payloadString(start, "actionId");
    if (!actionId) fail(id, `tool span ${start.spanId} is missing its frontier action join`);
    const entry = frontier.get(actionId);
    if (payloadString(start, "frontierEntryId") !== actionId || !entry) {
      fail(id, `tool span ${start.spanId} has a broken frontier action join`);
    }
    const toolName = start.name.slice("tool.".length);
    if (!entry.allowedTools.includes(toolName)) {
      fail(id, `tool span ${start.spanId} uses ${toolName} outside frontier ${entry.id} allowedTools`);
    }
    const captureId = payloadString(start, "captureId");
    const capturedRequest = captureId
      ? cassette.requests.find((request) => request.id === actionId && request.captureId === captureId)
      : undefined;
    if (!capturedRequest) {
      fail(id, `tool span ${start.spanId} is not backed by a verified replay capture`);
    }
    const end = trace.find((event) => event.kind === "span_end" && event.spanId === start.spanId);
    if (
      !end ||
      payloadString(end, "actionId") !== actionId ||
      payloadString(end, "frontierEntryId") !== actionId ||
      end.name !== start.name
    ) {
      fail(id, `tool span ${start.spanId} does not preserve its frontier action join`);
    }
  }

  const completed = trace.filter((event) => event.name === "graph.completed");
  if (
    completed.length !== 1 ||
    completed[0].payload.status !== graph.status ||
    completed[0].payload.nodeCount !== graph.nodes.length ||
    completed[0].payload.edgeCount !== graph.edges.length
  ) {
    fail(id, "graph completion trace disagrees with the report graph");
  }
}

function validateReportGraph(id: ReplayId, output: InvestigationReport, cassette: ReplayCassette): void {
  if (!jsonEqual(output.target, parseTarget(output.input))) {
    fail(id, "report target does not match deterministic input parsing");
  }
  const canonicalStatus = terminalStatusForStop(output.stop.reason, output.candidates, output.evidence, output.target);
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
    const expectedScore = scoreCandidate(
      {
        displayName: candidate.displayName,
        signals: normalizedSignals,
      },
      output.target,
    );
    if (
      candidate.normalizedName !== normalizeComparable(candidate.displayName) ||
      !jsonEqual(candidate.signals, normalizedSignals) ||
      !jsonEqual(candidate.score, expectedScore) ||
      candidate.status !== candidateStatus(normalizedSignals, expectedScore)
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
      expectedQueryUrl = evidence.queryUrl === null ? null : canonicalizeSourceUrl(evidence.queryUrl);
    } catch {
      fail(id, `evidence ${evidence.id} has an invalid canonical source URL`);
    }
    if (
      evidence.sourceUrl !== expectedCanonicalUrl ||
      evidence.canonicalUrl !== expectedCanonicalUrl ||
      evidence.sourceFamily !== expectedFamily
    ) {
      fail(id, `evidence ${evidence.id} source URL or sourceFamily is not canonically derived`);
    }
    if (
      evidence.normalizedClaim !== normalizeComparable(evidence.claim) ||
      (evidence.verificationMethod === "direct_fetch" && (!evidence.excerpt || evidence.claim !== evidence.excerpt))
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
  const canonicalIdentity = resolveIdentity(output.candidates, output.evidence, output.target);
  if (!jsonEqual(output.identity, canonicalIdentity)) {
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
  const reportEvidenceIds = new Set(
    output.evidence.filter((evidence) => evidence.toolCallId !== null).map((evidence) => evidence.id),
  );
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
    selectedFindings.some((finding) => finding.category === category && finding.confidence.score >= 0.45),
  );
  const expectedMissingCategories = output.coverage.requestedCategories.filter(
    (category) => !expectedCoveredCategories.includes(category),
  );
  const expectedIndependentFamilies = new Set(
    selectedEvidence.filter((evidence) => evidence.disposition === "supports").map((evidence) => evidence.sourceFamily),
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
      Math.max(
        canonicalIdentity.status === "resolved" && canonicalIdentity.resolutionBasis === "context_corroboration"
          ? 1
          : 0,
        output.candidates.filter((candidate) => candidate.status === "resolved").length,
      ) ||
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

  if (!sameStrings(output.coverage.requestedCategories, requestedCategoriesForInput(output.input))) {
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
      searchGraph: output.searchGraph,
      openQuestions: [...output.coverage.gaps],
      evidenceTelemetry: output.telemetry.evidence,
      budget: {
        limits: resolveBudgetLimits(output.input.requestedDepth ?? "standard"),
        usage: output.usage,
      },
      startedAt: output.generatedAt,
      updatedAt: output.generatedAt,
    };
    const stop = evaluateStop(state, output.stop.reason === "planner_requested" ? { plannerRequested: true } : {});
    if (!stop.allowed || stop.reason !== output.stop.reason) {
      fail(id, `${output.stop.reason} report is stop-illegal: ${stop.detail}`);
    }
  }
}

/** Fail-closed hydration used by API, CLI, and tests before replay data is exposed. */
export function validateReplayBundle(id: ReplayId, raw: RawReplay): ReplayExample {
  if (!isInvestigationInput(raw.input)) fail(id, "input.json does not match InvestigationInput schema v2");
  if (!isInvestigationReport(raw.output)) fail(id, "output.json does not match InvestigationReport schema v2");
  const canonicalTarget = parseTarget(raw.input);
  if (!jsonEqual(raw.output.target, canonicalTarget)) {
    fail(id, "report target does not match deterministic input parsing");
  }
  const earlyRestrictedPaths = restrictedReportContentPaths(raw.output);
  if (earlyRestrictedPaths.length > 0) {
    fail(id, `report contains restricted public content at ${earlyRestrictedPaths[0]}`);
  }
  const allowedEmails = new Set(
    canonicalTarget.identifiers
      .filter((identifier) => identifier.kind === "email" && identifier.provenance === "user_input")
      .map((identifier) => identifier.normalizedValue),
  );
  if (!Array.isArray(raw.trace) || !raw.trace.every((event) => isTraceEvent(event, { allowedEmails }))) {
    fail(id, "trace.json contains an invalid TraceEvent schema v2 event");
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
  validateExecutionGraph(id, example.output, example.trace, example.cassette);
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

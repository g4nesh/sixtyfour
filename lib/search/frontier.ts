import { cloneJson, isJsonValue, normalizeComparable, normalizeWhitespace } from "../domain/runtime";
import type { IdFactory } from "../domain/runtime";
import {
  SEARCH_GRAPH_SCHEMA_VERSION,
  type FrontierMutationMetadata,
  type JsonObject,
  type ParsedTarget,
  type SearchFrontierEntry,
  type SearchGraph,
  type SearchGraphEdge,
  type SearchGraphEdgeKind,
  type SearchGraphNode,
  type SearchGraphNodeKind,
  type SearchGraphStatus,
  type SearchUtilityComponents,
  type SourceTier,
} from "../domain/types";
import {
  isDeniedResearchSource,
  isDeniedResearchTool,
  sourceLaneById,
  sourceLaneForFrontierEntry,
  sourceLaneQueryHint,
  sourceLanesForTarget,
  type SourceLane,
} from "./source-hierarchy";

const MINIMUM_COST = 0.000001;
const MUTATION_SHARE_CAP = 0.2;
const SCORE_PRECISION = 1_000_000;

export interface SearchKernelEvent {
  name:
    | "frontier.seeded"
    | "frontier.enqueued"
    | "frontier.selected"
    | "frontier.pruned"
    | "frontier.expanded"
    | "frontier.exhausted"
    | "source.tier_advanced"
    | "mutation.proposed"
    | "mutation.accepted"
    | "mutation.rejected"
    | "graph.node_admitted"
    | "graph.edge_admitted";
  payload: JsonObject;
}

export interface SearchKernelResult<T = undefined> {
  graph: SearchGraph;
  value: T;
  events: SearchKernelEvent[];
}

export interface FrontierEnqueueOptions {
  lane: SourceLane;
  target: ParsedTarget;
  parentNodeId: string;
  parentFrontierEntry?: SearchFrontierEntry | null;
  candidateId?: string | null;
  candidateLabel?: string | null;
  intent?: string;
  queryHint?: string;
  status?: Extract<SearchGraphStatus, "queued" | "mutated" | "rejected">;
  mutation?: FrontierMutationMetadata | null;
  utility?: Partial<SearchUtilityComponents>;
}

export interface GraphNodeAdmission {
  kind: SearchGraphNodeKind;
  label: string;
  status: SearchGraphStatus;
  sourceTier?: SourceTier | null;
  sourceLaneId?: string | null;
  frontierEntryId?: string | null;
  actionId?: string | null;
  candidateId?: string | null;
  evidenceId?: string | null;
  findingId?: string | null;
  data?: JsonObject;
  dedupeEntityKey?: string;
}

function rounded(value: number): number {
  return Math.round(value * SCORE_PRECISION) / SCORE_PRECISION;
}

function score(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${label} must be a finite score in [0, 1]`);
  }
  return rounded(value);
}

function positiveCost(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} must be finite and strictly positive`);
  }
  return Math.max(MINIMUM_COST, rounded(value));
}

function canonicalDedupe(value: string): string {
  return normalizeComparable(value).replace(/\s+/g, " ").slice(0, 500);
}

function graphTimestamp(graph: SearchGraph, timestamp: string): SearchGraph {
  return { ...graph, updatedAt: timestamp };
}

export function emptySearchGraph(runId: string, seed: string, timestamp: string): SearchGraph {
  return {
    schemaVersion: SEARCH_GRAPH_SCHEMA_VERSION,
    runId,
    status: "empty",
    seed: normalizeWhitespace(seed).slice(0, 500),
    seedNodeId: null,
    nodes: [],
    edges: [],
    frontier: [],
    selectedFrontierEntryIds: [],
    currentSourceTier: null,
    nextOrdinal: 1,
    mutationStep: 0,
    telemetry: {
      seeded: 0,
      enqueued: 0,
      selected: 0,
      pruned: 0,
      expanded: 0,
      exhausted: 0,
      toolCalls: 0,
      mutationToolCalls: 0,
      mutationsProposed: 0,
      mutationsAccepted: 0,
      mutationsRejected: 0,
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function defaultUtilityForLane(
  lane: SourceLane,
  depth: number,
  overrides: Partial<SearchUtilityComponents> = {},
): SearchUtilityComponents {
  return {
    relevance: score(overrides.relevance ?? (lane.tier <= 1 ? 0.94 : lane.tier <= 3 ? 0.78 : 0.58), "relevance"),
    novelty: score(overrides.novelty ?? Math.max(0.25, 0.88 - depth * 0.12), "novelty"),
    informationGain: score(overrides.informationGain ?? (lane.requiresCandidate ? 0.76 : 0.68), "informationGain"),
    sourceTrust: score(overrides.sourceTrust ?? lane.trustPrior, "sourceTrust"),
    executionCost: score(overrides.executionCost ?? lane.executionCost, "executionCost"),
    policyRisk: score(overrides.policyRisk ?? lane.policyRisk, "policyRisk"),
    repetition: score(overrides.repetition ?? Math.min(1, depth * 0.16), "repetition"),
    depthPenalty: score(overrides.depthPenalty ?? Math.min(1, depth * 0.14), "depthPenalty"),
  };
}

/** Search utility affects traversal cost only; it is never an evidence confidence input. */
export function calculateEdgeCost(
  tier: SourceTier,
  depth: number,
  utility: SearchUtilityComponents,
): number {
  for (const [key, value] of Object.entries(utility)) score(value, key);
  if (!Number.isInteger(depth) || depth < 0) throw new TypeError("depth must be a non-negative integer");
  const benefit =
    utility.relevance * 0.32
    + utility.novelty * 0.18
    + utility.informationGain * 0.3
    + utility.sourceTrust * 0.2;
  const burden =
    utility.executionCost * 0.34
    + utility.policyRisk * 0.3
    + utility.repetition * 0.2
    + utility.depthPenalty * 0.16;
  return positiveCost(0.18 + tier * 0.72 + depth * 0.31 + (1 - benefit) + burden, "edgeCost");
}

export function compareFrontierEntries(
  left: SearchFrontierEntry,
  right: SearchFrontierEntry,
): number {
  return left.pathCost - right.pathCost
    || left.sourceTier - right.sourceTier
    || left.depth - right.depth
    || left.ordinal - right.ordinal
    || left.id.localeCompare(right.id);
}

function nodeEvent(node: SearchGraphNode): SearchKernelEvent {
  return {
    name: "graph.node_admitted",
    payload: {
      nodeId: node.id,
      kind: node.kind,
      status: node.status,
      frontierEntryId: node.frontierEntryId,
      actionId: node.actionId,
    },
  };
}

function edgeEvent(edge: SearchGraphEdge): SearchKernelEvent {
  return {
    name: "graph.edge_admitted",
    payload: {
      edgeId: edge.id,
      fromNodeId: edge.fromNodeId,
      toNodeId: edge.toNodeId,
      kind: edge.kind,
      frontierEntryId: edge.frontierEntryId,
      actionId: edge.actionId,
      edgeCost: edge.edgeCost,
      pathCost: edge.pathCost,
    },
  };
}

export function admitGraphNode(
  graphValue: SearchGraph,
  admission: GraphNodeAdmission,
  ids: IdFactory,
  timestamp: string,
): SearchKernelResult<SearchGraphNode> {
  const graph = cloneJson(graphValue);
  const existing = admission.dedupeEntityKey
    ? graph.nodes.find((node) => node.data.entityKey === admission.dedupeEntityKey)
    : undefined;
  if (existing) return { graph, value: existing, events: [] };
  const ordinal = graph.nextOrdinal;
  const node: SearchGraphNode = {
    schemaVersion: SEARCH_GRAPH_SCHEMA_VERSION,
    id: ids.next("graph_node"),
    kind: admission.kind,
    label: normalizeWhitespace(admission.label).slice(0, 320),
    status: admission.status,
    sourceTier: admission.sourceTier ?? null,
    sourceLaneId: admission.sourceLaneId ?? null,
    frontierEntryId: admission.frontierEntryId ?? null,
    actionId: admission.actionId ?? null,
    candidateId: admission.candidateId ?? null,
    evidenceId: admission.evidenceId ?? null,
    findingId: admission.findingId ?? null,
    ordinal,
    data: {
      ...(admission.data ?? {}),
      ...(admission.dedupeEntityKey ? { entityKey: admission.dedupeEntityKey } : {}),
    },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  graph.nodes.push(node);
  graph.nextOrdinal += 1;
  graph.updatedAt = timestamp;
  return { graph, value: node, events: [nodeEvent(node)] };
}

export function admitGraphEdge(
  graphValue: SearchGraph,
  options: {
    fromNodeId: string;
    toNodeId: string;
    kind: SearchGraphEdgeKind;
    status: SearchGraphStatus;
    frontierEntryId?: string | null;
    actionId?: string | null;
    edgeCost: number;
    pathCost: number;
  },
  ids: IdFactory,
  timestamp: string,
): SearchKernelResult<SearchGraphEdge> {
  const graph = cloneJson(graphValue);
  if (!graph.nodes.some((node) => node.id === options.fromNodeId)) {
    throw new Error(`unknown graph edge source ${options.fromNodeId}`);
  }
  if (!graph.nodes.some((node) => node.id === options.toNodeId)) {
    throw new Error(`unknown graph edge target ${options.toNodeId}`);
  }
  const existing = graph.edges.find((edge) =>
    edge.fromNodeId === options.fromNodeId
    && edge.toNodeId === options.toNodeId
    && edge.kind === options.kind
    && edge.actionId === (options.actionId ?? null));
  if (existing) return { graph, value: existing, events: [] };
  const edge: SearchGraphEdge = {
    schemaVersion: SEARCH_GRAPH_SCHEMA_VERSION,
    id: ids.next("graph_edge"),
    fromNodeId: options.fromNodeId,
    toNodeId: options.toNodeId,
    kind: options.kind,
    status: options.status,
    frontierEntryId: options.frontierEntryId ?? null,
    actionId: options.actionId ?? null,
    edgeCost: positiveCost(options.edgeCost, "graph edgeCost"),
    pathCost: positiveCost(options.pathCost, "graph pathCost"),
    ordinal: graph.nextOrdinal,
    createdAt: timestamp,
  };
  graph.edges.push(edge);
  graph.nextOrdinal += 1;
  graph.updatedAt = timestamp;
  return { graph, value: edge, events: [edgeEvent(edge)] };
}

export function enqueueFrontier(
  graphValue: SearchGraph,
  options: FrontierEnqueueOptions,
  ids: IdFactory,
  timestamp: string,
): SearchKernelResult<SearchFrontierEntry | null> {
  let graph = cloneJson(graphValue);
  const parent = options.parentFrontierEntry ?? null;
  const depth = (parent?.depth ?? -1) + 1;
  const utility = defaultUtilityForLane(options.lane, depth, options.utility);
  const edgeCost = calculateEdgeCost(options.lane.tier, depth, utility);
  const pathCost = positiveCost((parent?.pathCost ?? 0) + edgeCost, "pathCost");
  const queryHint = normalizeWhitespace(options.queryHint ?? sourceLaneQueryHint(options.target, options.lane)).slice(0, 320);
  const candidateId = options.candidateId ?? null;
  const dedupeKey = canonicalDedupe([
    options.lane.id,
    candidateId ?? "unbound",
    queryHint,
    options.mutation?.strategy ?? "base",
  ].join("|"));
  const dominant = graph.frontier.find((entry) =>
    entry.dedupeKey === dedupeKey
    && entry.status !== "rejected"
    && entry.status !== "exhausted"
    && entry.pathCost <= pathCost);
  if (dominant) {
    graph.telemetry.pruned += 1;
    graph.updatedAt = timestamp;
    return {
      graph,
      value: null,
      events: [{
        name: "frontier.pruned",
        payload: {
          dedupeKey,
          dominatedByFrontierEntryId: dominant.id,
          proposedPathCost: pathCost,
          dominantPathCost: dominant.pathCost,
        },
      }],
    };
  }

  const stableId = ids.next("action");
  const nodeAdmission = admitGraphNode(graph, {
    kind: "pivot",
    label: options.candidateLabel
      ? `${options.lane.label}: ${options.candidateLabel}`
      : options.lane.label,
    status: options.status ?? "queued",
    sourceTier: options.lane.tier,
    sourceLaneId: options.lane.id,
    frontierEntryId: stableId,
    actionId: stableId,
    candidateId,
    data: {
      intent: normalizeWhitespace(options.intent ?? options.lane.description).slice(0, 320),
      queryHint,
      admission: options.lane.admission,
    },
  }, ids, timestamp);
  graph = nodeAdmission.graph;
  const node = nodeAdmission.value;
  const entry: SearchFrontierEntry = {
    schemaVersion: SEARCH_GRAPH_SCHEMA_VERSION,
    id: stableId,
    frontierEntryId: stableId,
    actionId: stableId,
    nodeId: node.id,
    parentNodeId: options.parentNodeId,
    parentFrontierEntryId: parent?.id ?? null,
    status: options.status ?? "queued",
    sourceTier: options.lane.tier,
    sourceLaneId: options.lane.id,
    allowedTools: [...options.lane.allowedTools].sort(),
    intent: normalizeWhitespace(options.intent ?? options.lane.description).slice(0, 320),
    queryHint,
    candidateId,
    depth,
    ordinal: graph.nextOrdinal,
    dedupeKey,
    utility,
    edgeCost,
    pathCost,
    mutation: options.mutation ?? null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  graph.nextOrdinal += 1;
  graph.frontier.push(entry);
  graph.telemetry.enqueued += 1;
  const edgeAdmission = admitGraphEdge(graph, {
    fromNodeId: options.parentNodeId,
    toNodeId: node.id,
    kind: options.mutation ? "mutates" : "expands",
    status: entry.status,
    frontierEntryId: stableId,
    actionId: stableId,
    edgeCost,
    pathCost,
  }, ids, timestamp);
  graph = edgeAdmission.graph;
  const events = [
    ...nodeAdmission.events,
    ...edgeAdmission.events,
    {
      name: "frontier.enqueued" as const,
      payload: {
        frontierEntryId: entry.id,
        actionId: entry.actionId,
        nodeId: entry.nodeId,
        sourceTier: entry.sourceTier,
        sourceLaneId: entry.sourceLaneId,
        edgeCost: entry.edgeCost,
        pathCost: entry.pathCost,
        depth: entry.depth,
        mutated: Boolean(entry.mutation),
      },
    },
  ];
  return { graph: graphTimestamp(graph, timestamp), value: entry, events };
}

export function seedFrontier(
  graphValue: SearchGraph,
  target: ParsedTarget,
  availableTools: readonly string[],
  ids: IdFactory,
  timestamp: string,
): SearchKernelResult<SearchFrontierEntry[]> {
  if (graphValue.seedNodeId !== null || graphValue.nodes.length > 0) {
    throw new Error("search graph can be seeded exactly once");
  }
  let graph = cloneJson(graphValue);
  graph.seed = target.normalizedQuery.slice(0, 500);
  const seedAdmission = admitGraphNode(graph, {
    kind: "seed",
    label: target.normalizedQuery,
    status: "verified",
    data: { targetKind: target.kind },
    dedupeEntityKey: `seed:${graph.runId}`,
  }, ids, timestamp);
  graph = seedAdmission.graph;
  graph.seedNodeId = seedAdmission.value.id;
  graph.status = "active";
  const events = [...seedAdmission.events];
  const seeded: SearchFrontierEntry[] = [];
  for (const lane of sourceLanesForTarget(target, availableTools)) {
    if (lane.requiresCandidate) continue;
    const enqueued = enqueueFrontier(graph, {
      lane,
      target,
      parentNodeId: seedAdmission.value.id,
    }, ids, timestamp);
    graph = enqueued.graph;
    events.push(...enqueued.events);
    if (enqueued.value) seeded.push(enqueued.value);
  }
  graph.telemetry.seeded = seeded.length;
  events.push({
    name: "frontier.seeded",
    payload: {
      seedNodeId: graph.seedNodeId,
      entryCount: seeded.length,
      tiers: [...new Set(seeded.map((entry) => entry.sourceTier))],
    },
  });
  return { graph: graphTimestamp(graph, timestamp), value: seeded, events };
}

export function enqueueCandidateFrontier(
  graphValue: SearchGraph,
  target: ParsedTarget,
  candidate: { id: string; displayName: string },
  parentEntry: SearchFrontierEntry,
  parentNodeId: string,
  availableTools: readonly string[],
  ids: IdFactory,
  timestamp: string,
): SearchKernelResult<SearchFrontierEntry[]> {
  let graph = cloneJson(graphValue);
  const entries: SearchFrontierEntry[] = [];
  const events: SearchKernelEvent[] = [];
  for (const lane of sourceLanesForTarget(target, availableTools, { candidateId: candidate.id })) {
    if (!lane.requiresCandidate) continue;
    // Lanes that require an exact candidate-linked URL (e.g. Wayback) cannot be
    // enqueued from a name/org query hint; they are opened later, only once an
    // admitted source has bound a concrete HTTPS URL to this candidate.
    if (lane.requiresExactCandidateUrl) continue;
    const enqueued = enqueueFrontier(graph, {
      lane,
      target,
      parentNodeId,
      parentFrontierEntry: parentEntry,
      candidateId: candidate.id,
      candidateLabel: candidate.displayName,
      queryHint: `${candidate.displayName} ${target.organizationHints.map((item) => item.name).join(" ")}`,
    }, ids, timestamp);
    graph = enqueued.graph;
    events.push(...enqueued.events);
    if (enqueued.value) entries.push(enqueued.value);
  }
  return { graph, value: entries, events };
}

function mutationSelectionLegal(graph: SearchGraph): boolean {
  // A mutation must be legal on its own. Never borrow projected baseline calls
  // from the same selected batch because the planner may legally omit them.
  const projectedTools = graph.telemetry.toolCalls + 1;
  const projectedMutations = graph.telemetry.mutationToolCalls + 1;
  return projectedTools > 0 && projectedMutations / projectedTools <= MUTATION_SHARE_CAP + Number.EPSILON;
}

export function selectFrontierBatch(
  graphValue: SearchGraph,
  limit: number,
  timestamp: string,
): SearchKernelResult<SearchFrontierEntry[]> {
  if (!Number.isInteger(limit) || limit < 0) throw new TypeError("frontier batch limit must be a non-negative integer");
  const graph = cloneJson(graphValue);
  const queued = graph.frontier
    .filter((entry) => entry.status === "queued" || entry.status === "mutated")
    .sort(compareFrontierEntries);
  // Source hierarchy is an eligibility gate around the Dijkstra ordering. A
  // batch may expand only the lowest tier that has an action executable now;
  // this prevents broad discovery from racing an unexhausted exact/official
  // lane while still allowing mutation-cap-deferred entries to wait safely.
  // The cursor is monotonic: entries below the current tier (e.g. a candidate
  // lane opened after the run already advanced) are not revisited downward.
  const tierFloor = graph.currentSourceTier ?? 0;
  const initiallyExecutable = queued.filter((entry) =>
    entry.sourceTier >= tierFloor
    && (entry.mutation === null || mutationSelectionLegal(graph)));
  const minimumEligibleTier = initiallyExecutable.length > 0
    ? initiallyExecutable.reduce<SourceTier>(
      (value, entry) => Math.min(value, entry.sourceTier) as SourceTier,
      initiallyExecutable[0].sourceTier,
    )
    : null;
  const eligible = minimumEligibleTier === null
    ? []
    : queued.filter((entry) => entry.sourceTier === minimumEligibleTier);
  const selected: SearchFrontierEntry[] = [];
  let selectedMutations = 0;
  const selectedIds = new Set<string>();
  while (selected.length < limit) {
    const entry = eligible.find((candidate) => {
      if (selectedIds.has(candidate.id)) return false;
      if (candidate.mutation === null) return true;
      if (selectedMutations >= 1) return false;
      return mutationSelectionLegal(graph);
    });
    if (!entry) break;
    selected.push(entry);
    selectedIds.add(entry.id);
    if (entry.mutation !== null) selectedMutations += 1;
  }

  graph.frontier = graph.frontier.map((entry) => selectedIds.has(entry.id)
    ? { ...entry, status: "selected", updatedAt: timestamp }
    : entry);
  graph.nodes = graph.nodes.map((node) => selected.some((entry) => entry.nodeId === node.id)
    ? { ...node, status: "selected", updatedAt: timestamp }
    : node);
  graph.selectedFrontierEntryIds = selected.map((entry) => entry.id);
  graph.telemetry.selected += selected.length;
  graph.updatedAt = timestamp;
  const events: SearchKernelEvent[] = selected.map((entry) => ({
    name: "frontier.selected",
    payload: {
      frontierEntryId: entry.id,
      actionId: entry.actionId,
      sourceTier: entry.sourceTier,
      sourceLaneId: entry.sourceLaneId,
      edgeCost: entry.edgeCost,
      pathCost: entry.pathCost,
      depth: entry.depth,
      mutated: Boolean(entry.mutation),
    },
  }));
  const selectedTier = selected[0]?.sourceTier ?? null;
  if (selectedTier !== null && (graph.currentSourceTier === null || selectedTier > graph.currentSourceTier)) {
    const previousTier = graph.currentSourceTier;
    graph.currentSourceTier = selectedTier;
    events.push({
      name: "source.tier_advanced",
      payload: { previousTier, sourceTier: selectedTier },
    });
  }
  if (selected.length === 0 && queued.length === 0) {
    graph.status = "exhausted";
    graph.telemetry.exhausted += 1;
    events.push({
      name: "frontier.exhausted",
      payload: { reason: "no_queued_entries" },
    });
  }
  return { graph, value: selected.map((entry) => ({ ...entry, status: "selected" })), events };
}

export function setFrontierStatus(
  graphValue: SearchGraph,
  frontierEntryIds: readonly string[],
  status: SearchGraphStatus,
  timestamp: string,
): SearchGraph {
  const graph = cloneJson(graphValue);
  const ids = new Set(frontierEntryIds);
  graph.frontier = graph.frontier.map((entry) => ids.has(entry.id)
    ? { ...entry, status, updatedAt: timestamp }
    : entry);
  graph.nodes = graph.nodes.map((node) =>
    (node.kind === "pivot" || node.kind === "action")
      && node.frontierEntryId
      && ids.has(node.frontierEntryId)
    ? { ...node, status, updatedAt: timestamp }
    : node);
  if (!["selected", "running"].includes(status)) {
    graph.selectedFrontierEntryIds = graph.selectedFrontierEntryIds.filter((id) => !ids.has(id));
  }
  graph.updatedAt = timestamp;
  return graph;
}

export function requeueFrontier(
  graph: SearchGraph,
  frontierEntryIds: readonly string[],
  timestamp: string,
): SearchGraph {
  return setFrontierStatus(graph, frontierEntryIds, "queued", timestamp);
}

export function recordFrontierOutcome(
  graphValue: SearchGraph,
  entry: SearchFrontierEntry,
  status: Extract<SearchGraphStatus, "verified" | "rejected" | "exhausted">,
  timestamp: string,
): SearchKernelResult {
  const current = graphValue.frontier.find((candidate) => candidate.id === entry.id);
  if (!current || current.status !== "running") {
    throw new Error(`frontier outcome requires one running entry: ${entry.id}`);
  }
  const graph = setFrontierStatus(graphValue, [entry.id], status, timestamp);
  graph.telemetry.toolCalls += 1;
  if (entry.mutation) graph.telemetry.mutationToolCalls += 1;
  if (status === "verified") graph.telemetry.expanded += 1;
  else graph.telemetry.exhausted += 1;
  const name = status === "verified" ? "frontier.expanded" : "frontier.exhausted";
  return {
    graph,
    value: undefined,
    events: [{
      name,
      payload: {
        frontierEntryId: entry.id,
        actionId: entry.actionId,
        status,
        sourceTier: entry.sourceTier,
        sourceLaneId: entry.sourceLaneId,
      },
    }],
  };
}

type MutationStrategy = FrontierMutationMetadata["strategy"];

export const FRONTIER_MUTATION_STRATEGIES = [
  "exact_phrase",
  "role_anchor",
  "organization_anchor",
  "source_adjacent",
] as const satisfies readonly MutationStrategy[];

function adjacentSourceLaneForMutation(
  entry: SearchFrontierEntry,
  target: ParsedTarget,
): SourceLane | null {
  const candidateBound = entry.candidateId !== null;
  return sourceLanesForTarget(target, entry.allowedTools, { candidateId: entry.candidateId })
    .filter((lane) => lane.id !== entry.sourceLaneId)
    .filter((lane) => lane.tier > entry.sourceTier)
    .filter((lane) => lane.requiresCandidate === candidateBound)
    .sort((left, right) => left.tier - right.tier || left.id.localeCompare(right.id))[0] ?? null;
}

function mutationStrategies(entry: SearchFrontierEntry, target: ParsedTarget): MutationStrategy[] {
  const strategies: MutationStrategy[] = ["exact_phrase"];
  if (target.roleHints.length > 0) strategies.push("role_anchor");
  if (target.organizationHints.length > 0) strategies.push("organization_anchor");
  if (adjacentSourceLaneForMutation(entry, target)) strategies.push("source_adjacent");
  return strategies;
}

function mutatedIntent(
  strategy: MutationStrategy,
  entry: SearchFrontierEntry,
  target: ParsedTarget,
  lane: SourceLane,
): string {
  switch (strategy) {
    case "exact_phrase":
      return `Explore the exact supplied public-professional target phrase in ${entry.sourceLaneId}.`;
    case "role_anchor":
      return `Corroborate the supplied role anchor ${target.roleHints.join(" / ")} in ${entry.sourceLaneId}.`;
    case "organization_anchor":
      return `Corroborate the supplied organization anchor ${target.organizationHints.map((item) => item.name).join(" / ")} in ${entry.sourceLaneId}.`;
    case "source_adjacent":
      return `Explore ${lane.id} as an adjacent source class without changing the supplied identifiers or hostname.`;
  }
}

function mutatedQueryHint(
  strategy: MutationStrategy,
  entry: SearchFrontierEntry,
  target: ParsedTarget,
): string {
  switch (strategy) {
    case "exact_phrase": {
      const exact = entry.queryHint.replace(/^"+|"+$/g, "").slice(0, 316);
      return `"${exact}"`;
    }
    case "role_anchor":
      return normalizeWhitespace(
        `${entry.queryHint} "${target.roleHints.join(" / ")}"`,
      ).slice(0, 320);
    case "organization_anchor":
      return normalizeWhitespace(
        `${entry.queryHint} "${target.organizationHints.map((item) => item.name).join(" / ")}"`,
      ).slice(0, 320);
    case "source_adjacent":
      return entry.queryHint;
  }
}

const SHA256_INITIAL_STATE = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] as const;

const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** Small Worker-safe SHA-256 used where replay hydration must remain synchronous. */
function sha256Bytes(value: string): Uint8Array {
  const input = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x80;
  const bitLength = input.length * 8;
  const paddedView = new DataView(padded.buffer);
  paddedView.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  paddedView.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const state: number[] = [...SHA256_INITIAL_STATE];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = paddedView.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15];
      const right = words[index - 2];
      const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
      const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 = (h + sum1 + choice + SHA256_ROUND_CONSTANTS[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }

  const digest = new Uint8Array(32);
  const digestView = new DataView(digest.buffer);
  state.forEach((word, index) => digestView.setUint32(index * 4, word, false));
  return digest;
}

export function deterministicSha256UnitSync(seed: string): number {
  const digest = sha256Bytes(seed);
  // A 53-bit integer maps exactly into a JavaScript double mantissa.
  const high = (digest[0] * 0x1000000) + (digest[1] << 16) + (digest[2] << 8) + digest[3];
  const low = ((digest[4] << 16) | (digest[5] << 8) | digest[6]) >>> 0;
  const integer = high * 0x200000 + (low & 0x1fffff);
  return (integer + 0.5) / 0x20000000000000;
}

export async function deterministicSha256Unit(seed: string): Promise<number> {
  return deterministicSha256UnitSync(seed);
}

export function coolingTemperature(
  step: number,
  options: { initial?: number; rate?: number; minimum?: number } = {},
): number {
  if (!Number.isInteger(step) || step < 0) throw new TypeError("mutation step must be a non-negative integer");
  const initial = options.initial ?? 1;
  const rate = options.rate ?? 0.86;
  const minimum = options.minimum ?? 0.12;
  if (![initial, rate, minimum].every((value) => Number.isFinite(value) && value > 0)) {
    throw new TypeError("cooling parameters must be finite and strictly positive");
  }
  return rounded(Math.max(minimum, initial * rate ** step));
}

export function metropolisHastingsAcceptance(options: {
  parentCost: number;
  candidateCost: number;
  temperature: number;
  parentNeighborCount: number;
  candidateNeighborCount: number;
}): { logAcceptanceRatio: number; acceptanceProbability: number } {
  const parentCost = positiveCost(options.parentCost, "parentCost");
  const candidateCost = positiveCost(options.candidateCost, "candidateCost");
  const temperature = positiveCost(options.temperature, "temperature");
  if (!Number.isInteger(options.parentNeighborCount) || options.parentNeighborCount <= 0) {
    throw new TypeError("parentNeighborCount must be a positive integer");
  }
  if (!Number.isInteger(options.candidateNeighborCount) || options.candidateNeighborCount <= 0) {
    throw new TypeError("candidateNeighborCount must be a positive integer");
  }
  // Uniform finite-neighbor proposal: q(parent|candidate) / q(candidate|parent) = N_parent/N_candidate.
  const logAcceptanceRatio = rounded(
    -((candidateCost - parentCost) / temperature)
    + Math.log(options.parentNeighborCount / options.candidateNeighborCount),
  );
  return {
    logAcceptanceRatio,
    acceptanceProbability: rounded(Math.min(1, Math.exp(Math.min(0, logAcceptanceRatio)))),
  };
}

export interface DerivedMutationProposal {
  strategy: MutationStrategy;
  candidateLane: SourceLane;
  queryHint: string;
  intent: string;
  utility: SearchUtilityComponents;
  candidateCost: number;
  parentNeighborCount: number;
  candidateNeighborCount: number;
  temperature: number;
  logAcceptanceRatio: number;
  acceptanceProbability: number;
  deterministicU: number;
  accepted: boolean;
}

/**
 * Canonical mutation derivation. Generation and synchronous replay hydration
 * both call this function so strategy, transformation, lane, neighbor counts,
 * MH math, and the deterministic draw cannot be changed as one forged bundle.
 */
export function deriveMutationProposal(
  graph: Pick<SearchGraph, "runId" | "seed">,
  target: ParsedTarget,
  parent: SearchFrontierEntry,
  proposalIndex: number,
): DerivedMutationProposal | null {
  const lane = sourceLaneById(parent.sourceLaneId);
  if (!lane || parent.mutation || !Number.isInteger(proposalIndex) || proposalIndex < 0) return null;
  const strategies = mutationStrategies(parent, target);
  if (strategies.length === 0) return null;
  const selector = deterministicSha256UnitSync(
    `${graph.runId}|${graph.seed}|${parent.id}|${proposalIndex}|strategy`,
  );
  const strategy = strategies[Math.min(strategies.length - 1, Math.floor(selector * strategies.length))];
  const candidateLane = strategy === "source_adjacent"
    ? adjacentSourceLaneForMutation(parent, target)
    : lane;
  if (!candidateLane) return null;
  const candidateState = {
    ...parent,
    sourceTier: candidateLane.tier,
    sourceLaneId: candidateLane.id,
    allowedTools: [...candidateLane.allowedTools].sort(),
  };
  const candidateNeighborCount = Math.max(1, mutationStrategies(candidateState, target).length);
  const queryHint = mutatedQueryHint(strategy, parent, target);
  if (strategy !== "source_adjacent" && queryHint === parent.queryHint) return null;
  if (strategy === "source_adjacent" && candidateLane.id === parent.sourceLaneId) return null;
  const intent = mutatedIntent(strategy, parent, target, candidateLane);
  const temperature = coolingTemperature(proposalIndex);
  const utility = defaultUtilityForLane(candidateLane, parent.depth + 1, {
    novelty: Math.min(1, parent.utility.novelty + 0.08),
    repetition: Math.min(1, parent.utility.repetition + 0.12),
    depthPenalty: Math.min(1, parent.utility.depthPenalty + 0.14),
  });
  const candidateCost = calculateEdgeCost(candidateLane.tier, parent.depth + 1, utility);
  const mh = metropolisHastingsAcceptance({
    parentCost: parent.edgeCost,
    candidateCost,
    temperature,
    parentNeighborCount: strategies.length,
    candidateNeighborCount,
  });
  const deterministicU = rounded(deterministicSha256UnitSync(
    `${graph.runId}|${graph.seed}|${parent.id}|${proposalIndex}|${strategy}|accept`,
  ));
  return {
    strategy,
    candidateLane,
    queryHint,
    intent,
    utility,
    candidateCost,
    parentNeighborCount: strategies.length,
    candidateNeighborCount,
    temperature,
    logAcceptanceRatio: mh.logAcceptanceRatio,
    acceptanceProbability: mh.acceptanceProbability,
    deterministicU,
    accepted: deterministicU <= mh.acceptanceProbability,
  };
}

export async function proposeBoundedMutation(
  graphValue: SearchGraph,
  target: ParsedTarget,
  parent: SearchFrontierEntry,
  ids: IdFactory,
  timestamp: string,
): Promise<SearchKernelResult<SearchFrontierEntry | null>> {
  let graph = cloneJson(graphValue);
  if (parent.mutation || graph.telemetry.toolCalls < 1) {
    return { graph, value: null, events: [] };
  }
  const proposalIndex = graph.mutationStep;
  const derived = deriveMutationProposal(graph, target, parent, proposalIndex);
  if (!derived) return { graph, value: null, events: [] };
  const {
    strategy,
    candidateLane,
    queryHint,
    intent,
    utility,
    parentNeighborCount,
    candidateNeighborCount,
    temperature,
    logAcceptanceRatio,
    acceptanceProbability,
    deterministicU,
    accepted,
  } = derived;
  const mutation: FrontierMutationMetadata = {
    strategy,
    parentFrontierEntryId: parent.id,
    proposalIndex,
    temperature,
    logAcceptanceRatio,
    acceptanceProbability,
    deterministicU,
    parentNeighborCount,
    candidateNeighborCount,
  };
  graph.mutationStep += 1;
  graph.telemetry.mutationsProposed += 1;
  const proposedEvent: SearchKernelEvent = {
    name: "mutation.proposed",
    payload: {
      parentFrontierEntryId: parent.id,
      strategy,
      fromSourceLaneId: parent.sourceLaneId,
      toSourceLaneId: candidateLane.id,
      queryChanged: queryHint !== parent.queryHint,
      proposalIndex,
      temperature,
      logAcceptanceRatio,
      acceptanceProbability,
      deterministicU,
      parentNeighborCount,
      candidateNeighborCount,
    },
  };
  const enqueued = enqueueFrontier(graph, {
    lane: candidateLane,
    target,
    parentNodeId: parent.nodeId,
    parentFrontierEntry: parent,
    candidateId: parent.candidateId,
    intent,
    queryHint,
    status: accepted ? "mutated" : "rejected",
    mutation,
    utility,
  }, ids, timestamp);
  graph = enqueued.graph;
  if (accepted) graph.telemetry.mutationsAccepted += 1;
  else graph.telemetry.mutationsRejected += 1;
  const resultEvent: SearchKernelEvent = {
    name: accepted ? "mutation.accepted" : "mutation.rejected",
    payload: {
      parentFrontierEntryId: parent.id,
      frontierEntryId: enqueued.value?.id ?? null,
      strategy,
      fromSourceLaneId: parent.sourceLaneId,
      toSourceLaneId: candidateLane.id,
      queryChanged: queryHint !== parent.queryHint,
      acceptanceProbability,
      deterministicU,
    },
  };
  return {
    graph,
    value: accepted ? enqueued.value : null,
    events: [proposedEvent, ...enqueued.events, resultEvent],
  };
}

export function markSearchGraphTerminal(
  graphValue: SearchGraph,
  status: SearchGraph["status"],
  timestamp: string,
  options: { preserveQueued?: boolean } = {},
): SearchGraph {
  const graph = cloneJson(graphValue);
  const preserveQueued = options.preserveQueued ?? status === "completed";
  graph.status = status;
  graph.selectedFrontierEntryIds = [];
  graph.frontier = graph.frontier.map((entry) =>
    entry.status === "selected"
      || entry.status === "running"
      || (!preserveQueued && (entry.status === "queued" || entry.status === "mutated"))
      ? { ...entry, status: "exhausted", updatedAt: timestamp }
      : entry);
  graph.nodes = graph.nodes.map((node) =>
    node.status === "selected"
      || node.status === "running"
      || (!preserveQueued && (node.status === "queued" || node.status === "mutated"))
      ? { ...node, status: "exhausted", updatedAt: timestamp }
      : node);
  graph.updatedAt = timestamp;
  return graph;
}

export interface SearchGraphInvariantIssue {
  code: string;
  path: string;
  message: string;
}

const GRAPH_RUN_STATUSES = new Set([
  "empty", "active", "exhausted", "completed", "blocked", "canceled", "failed",
]);
const GRAPH_NODE_STATUSES = new Set([
  "queued", "selected", "running", "verified", "rejected", "exhausted", "mutated",
]);
const GRAPH_NODE_KINDS = new Set([
  "seed", "pivot", "action", "source", "evidence", "candidate", "finding", "gap", "report",
]);
const GRAPH_EDGE_KINDS = new Set([
  "expands", "mutates", "supports", "conflicts", "separates", "grounds", "includes",
]);
const GRAPH_EDGE_ENDPOINTS: Readonly<Record<SearchGraphEdgeKind, ReadonlySet<string>>> = {
  expands: new Set([
    "seed->pivot", "pivot->pivot", "pivot->action",
    "action->candidate", "action->source", "action->gap", "candidate->pivot",
  ]),
  mutates: new Set(["pivot->pivot", "pivot->action"]),
  supports: new Set(["source->evidence", "evidence->candidate", "candidate->finding"]),
  conflicts: new Set(["evidence->candidate"]),
  separates: new Set(["candidate->candidate"]),
  grounds: new Set([
    "pivot->source", "source->evidence", "evidence->candidate", "evidence->finding",
  ]),
  includes: new Set(["candidate->report", "finding->report", "gap->report"]),
};
const GRAPH_TELEMETRY_KEYS = [
  "seeded", "enqueued", "selected", "pruned", "expanded", "exhausted", "toolCalls",
  "mutationToolCalls", "mutationsProposed", "mutationsAccepted", "mutationsRejected",
] as const;
const GRAPH_UTILITY_KEYS = [
  "relevance", "novelty", "informationGain", "sourceTrust", "executionCost",
  "policyRisk", "repetition", "depthPenalty",
] as const;

function graphRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function graphNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function graphNullableString(value: unknown): value is string | null {
  return value === null || graphNonEmptyString(value);
}

function graphNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function graphPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function graphScore(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function graphSourceTier(value: unknown): value is SourceTier {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 6;
}

function graphTimestampValue(value: unknown): value is string {
  return graphNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function graphJsonValue(value: unknown): boolean {
  try {
    return isJsonValue(value);
  } catch {
    return false;
  }
}

function canonicalGraphNodeShape(value: unknown): boolean {
  return graphRecord(value)
    && value.schemaVersion === SEARCH_GRAPH_SCHEMA_VERSION
    && graphNonEmptyString(value.id)
    && typeof value.kind === "string" && GRAPH_NODE_KINDS.has(value.kind)
    && graphNonEmptyString(value.label)
    && typeof value.status === "string" && GRAPH_NODE_STATUSES.has(value.status)
    && (value.sourceTier === null || graphSourceTier(value.sourceTier))
    && graphNullableString(value.sourceLaneId)
    && graphNullableString(value.frontierEntryId)
    && graphNullableString(value.actionId)
    && graphNullableString(value.candidateId)
    && graphNullableString(value.evidenceId)
    && graphNullableString(value.findingId)
    && graphNonNegativeInteger(value.ordinal)
    && graphRecord(value.data) && graphJsonValue(value.data)
    && graphTimestampValue(value.createdAt)
    && graphTimestampValue(value.updatedAt);
}

function canonicalGraphEdgeShape(value: unknown): boolean {
  return graphRecord(value)
    && value.schemaVersion === SEARCH_GRAPH_SCHEMA_VERSION
    && graphNonEmptyString(value.id)
    && graphNonEmptyString(value.fromNodeId)
    && graphNonEmptyString(value.toNodeId)
    && typeof value.kind === "string" && GRAPH_EDGE_KINDS.has(value.kind)
    && typeof value.status === "string" && GRAPH_NODE_STATUSES.has(value.status)
    && graphNullableString(value.frontierEntryId)
    && graphNullableString(value.actionId)
    && graphPositiveFinite(value.edgeCost)
    && graphPositiveFinite(value.pathCost)
    && graphNonNegativeInteger(value.ordinal)
    && graphTimestampValue(value.createdAt);
}

function canonicalGraphUtilityShape(value: unknown): boolean {
  return graphRecord(value) && GRAPH_UTILITY_KEYS.every((key) => graphScore(value[key]));
}

function canonicalGraphMutationShape(value: unknown): boolean {
  return graphRecord(value)
    && typeof value.strategy === "string"
    && FRONTIER_MUTATION_STRATEGIES.includes(value.strategy as FrontierMutationMetadata["strategy"])
    && graphNonEmptyString(value.parentFrontierEntryId)
    && graphNonNegativeInteger(value.proposalIndex)
    && graphPositiveFinite(value.temperature)
    && typeof value.logAcceptanceRatio === "number" && Number.isFinite(value.logAcceptanceRatio)
    && graphScore(value.acceptanceProbability)
    && graphScore(value.deterministicU)
    && graphNonNegativeInteger(value.parentNeighborCount) && value.parentNeighborCount > 0
    && graphNonNegativeInteger(value.candidateNeighborCount) && value.candidateNeighborCount > 0;
}

function canonicalFrontierEntryShape(value: unknown): boolean {
  return graphRecord(value)
    && value.schemaVersion === SEARCH_GRAPH_SCHEMA_VERSION
    && graphNonEmptyString(value.id)
    && graphNonEmptyString(value.frontierEntryId)
    && graphNonEmptyString(value.actionId)
    && graphNonEmptyString(value.nodeId)
    && graphNonEmptyString(value.parentNodeId)
    && graphNullableString(value.parentFrontierEntryId)
    && typeof value.status === "string" && GRAPH_NODE_STATUSES.has(value.status)
    && graphSourceTier(value.sourceTier)
    && graphNonEmptyString(value.sourceLaneId)
    && Array.isArray(value.allowedTools)
    && value.allowedTools.length > 0
    && value.allowedTools.every(graphNonEmptyString)
    && graphNonEmptyString(value.intent)
    && graphNonEmptyString(value.queryHint)
    && graphNullableString(value.candidateId)
    && graphNonNegativeInteger(value.depth)
    && graphNonNegativeInteger(value.ordinal)
    && graphNonEmptyString(value.dedupeKey)
    && canonicalGraphUtilityShape(value.utility)
    && graphPositiveFinite(value.edgeCost)
    && graphPositiveFinite(value.pathCost)
    && (value.mutation === null || canonicalGraphMutationShape(value.mutation))
    && graphTimestampValue(value.createdAt)
    && graphTimestampValue(value.updatedAt);
}

function validateSearchGraphStructure(value: unknown): SearchGraphInvariantIssue[] {
  const issues: SearchGraphInvariantIssue[] = [];
  if (!graphRecord(value)) {
    return [{ code: "invalid_graph_shape", path: "$", message: "search graph must be an object" }];
  }
  const requireField = (condition: boolean, path: string, message: string): void => {
    if (!condition) issues.push({ code: "invalid_graph_shape", path, message });
  };
  requireField(value.schemaVersion === SEARCH_GRAPH_SCHEMA_VERSION, "schemaVersion", "unsupported search graph schema");
  requireField(graphNonEmptyString(value.runId), "runId", "runId must be non-empty");
  requireField(typeof value.status === "string" && GRAPH_RUN_STATUSES.has(value.status), "status", "invalid graph status");
  requireField(typeof value.seed === "string", "seed", "seed must be a string");
  requireField(graphNullableString(value.seedNodeId), "seedNodeId", "seedNodeId must be null or non-empty");
  requireField(Array.isArray(value.nodes), "nodes", "nodes must be an array");
  requireField(Array.isArray(value.edges), "edges", "edges must be an array");
  requireField(Array.isArray(value.frontier), "frontier", "frontier must be an array");
  requireField(
    Array.isArray(value.selectedFrontierEntryIds) && value.selectedFrontierEntryIds.every(graphNonEmptyString),
    "selectedFrontierEntryIds",
    "selectedFrontierEntryIds must contain strings",
  );
  requireField(value.currentSourceTier === null || graphSourceTier(value.currentSourceTier), "currentSourceTier", "invalid current source tier");
  requireField(graphNonNegativeInteger(value.nextOrdinal), "nextOrdinal", "nextOrdinal must be a non-negative integer");
  requireField(graphNonNegativeInteger(value.mutationStep), "mutationStep", "mutationStep must be a non-negative integer");
  const telemetry = graphRecord(value.telemetry) ? value.telemetry : null;
  requireField(
    telemetry !== null && GRAPH_TELEMETRY_KEYS.every((key) => graphNonNegativeInteger(telemetry[key])),
    "telemetry",
    "telemetry must contain every non-negative integer counter",
  );
  requireField(graphTimestampValue(value.createdAt), "createdAt", "createdAt must be a valid timestamp");
  requireField(graphTimestampValue(value.updatedAt), "updatedAt", "updatedAt must be a valid timestamp");
  if (Array.isArray(value.nodes)) value.nodes.forEach((node, index) => {
    if (!canonicalGraphNodeShape(node)) {
      issues.push({ code: "invalid_node_shape", path: `nodes[${index}]`, message: "invalid canonical graph node" });
    }
  });
  if (Array.isArray(value.edges)) value.edges.forEach((edge, index) => {
    if (!canonicalGraphEdgeShape(edge)) {
      issues.push({ code: "invalid_edge_shape", path: `edges[${index}]`, message: "invalid canonical graph edge" });
    }
  });
  if (Array.isArray(value.frontier)) value.frontier.forEach((entry, index) => {
    if (!canonicalFrontierEntryShape(entry)) {
      issues.push({ code: "invalid_frontier_shape", path: `frontier[${index}]`, message: "invalid canonical frontier entry" });
    }
  });
  if (!graphJsonValue(value)) {
    issues.push({ code: "invalid_graph_shape", path: "$", message: "search graph must be JSON-safe" });
  }
  return issues;
}

export function validateSearchGraph(graphValue: unknown): SearchGraphInvariantIssue[] {
  const structuralIssues = validateSearchGraphStructure(graphValue);
  if (structuralIssues.length > 0) return structuralIssues;
  const graph = graphValue as SearchGraph;
  const issues: SearchGraphInvariantIssue[] = [];
  const nodeIds = new Set<string>();
  graph.nodes.forEach((node, index) => {
    if (nodeIds.has(node.id)) issues.push({ code: "duplicate_node", path: `nodes[${index}].id`, message: node.id });
    nodeIds.add(node.id);
    if (node.data.sourceUrl && typeof node.data.sourceUrl === "string" && isDeniedResearchSource(node.data.sourceUrl)) {
      issues.push({ code: "denied_source", path: `nodes[${index}].data.sourceUrl`, message: "denied source" });
    }
    if (node.kind === "action" && typeof node.data.tool === "string" && isDeniedResearchTool(node.data.tool)) {
      issues.push({ code: "denied_tool", path: `nodes[${index}].data.tool`, message: "denied research tool" });
    }
  });
  const evidenceNodeIds = new Set<string>();
  const findingNodeIds = new Set<string>();
  const candidateEntityNodeIds = new Set<string>();
  graph.nodes.forEach((node, index) => {
    if ((node.evidenceId !== null) !== (node.kind === "evidence" || node.kind === "source")) {
      issues.push({
        code: "invalid_evidence_node_reference",
        path: `nodes[${index}].evidenceId`,
        message: "source and evidence nodes require one non-null evidenceId",
      });
    }
    if ((node.kind === "evidence" || node.kind === "source")
      && (node.frontierEntryId === null || node.actionId === null)) {
      issues.push({
        code: "unbound_evidence_node",
        path: `nodes[${index}].actionId`,
        message: "source and evidence nodes require canonical frontier/action provenance",
      });
    }
    if (node.kind === "evidence" && node.evidenceId !== null) {
      if (evidenceNodeIds.has(node.evidenceId)) {
        issues.push({
          code: "duplicate_evidence_node",
          path: `nodes[${index}].evidenceId`,
          message: node.evidenceId,
        });
      }
      evidenceNodeIds.add(node.evidenceId);
    }
    if ((node.findingId !== null) !== (node.kind === "finding")) {
      issues.push({
        code: "invalid_finding_node_reference",
        path: `nodes[${index}].findingId`,
        message: "only finding nodes may carry one non-null findingId",
      });
    }
    if (node.findingId !== null) {
      if (findingNodeIds.has(node.findingId)) {
        issues.push({
          code: "duplicate_finding_node",
          path: `nodes[${index}].findingId`,
          message: node.findingId,
        });
      }
      findingNodeIds.add(node.findingId);
    }
    if (node.kind === "candidate") {
      if (node.candidateId === null) {
        issues.push({
          code: "invalid_candidate_entity_node",
          path: `nodes[${index}].candidateId`,
          message: "candidate entity nodes require a candidateId",
        });
      } else if (candidateEntityNodeIds.has(node.candidateId)) {
        issues.push({
          code: "duplicate_candidate_node",
          path: `nodes[${index}].candidateId`,
          message: node.candidateId,
        });
      } else {
        candidateEntityNodeIds.add(node.candidateId);
      }
    }
  });
  const edgeIds = new Set<string>();
  graph.edges.forEach((edge, index) => {
    if (edgeIds.has(edge.id)) issues.push({ code: "duplicate_edge", path: `edges[${index}].id`, message: edge.id });
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId)) {
      issues.push({ code: "dangling_edge", path: `edges[${index}]`, message: edge.id });
    }
    if (!Number.isFinite(edge.edgeCost) || edge.edgeCost <= 0 || !Number.isFinite(edge.pathCost) || edge.pathCost <= 0) {
      issues.push({ code: "invalid_edge_cost", path: `edges[${index}]`, message: edge.id });
    }
  });
  const frontierIds = new Set<string>();
  const activeDedupe = new Set<string>();
  graph.frontier.forEach((entry, index) => {
    if (frontierIds.has(entry.id)) issues.push({ code: "duplicate_frontier", path: `frontier[${index}].id`, message: entry.id });
    frontierIds.add(entry.id);
    if (entry.id !== entry.frontierEntryId || entry.id !== entry.actionId) {
      issues.push({ code: "unstable_action_join", path: `frontier[${index}]`, message: entry.id });
    }
    if (!nodeIds.has(entry.nodeId) || !nodeIds.has(entry.parentNodeId)) {
      issues.push({ code: "dangling_frontier_node", path: `frontier[${index}]`, message: entry.id });
    }
    if (!Number.isFinite(entry.edgeCost) || entry.edgeCost <= 0 || !Number.isFinite(entry.pathCost) || entry.pathCost <= 0) {
      issues.push({ code: "invalid_frontier_cost", path: `frontier[${index}]`, message: entry.id });
    }
    const resolvedLane = sourceLaneForFrontierEntry(entry);
    if (
      isDeniedResearchTool(entry.sourceLaneId)
      || entry.allowedTools.some((tool) => isDeniedResearchTool(tool))
    ) {
      issues.push({
        code: "denied_tool",
        path: `frontier[${index}].allowedTools`,
        message: "denied research tool",
      });
    }
    if (!resolvedLane) {
      issues.push({
        code: "illegal_source_lane",
        path: `frontier[${index}].sourceLaneId`,
        message: `${entry.sourceLaneId} does not match its tier, tool, or candidate scope`,
      });
    }
    if (resolvedLane?.requiresExactCandidateUrl) {
      try {
        const url = new URL(entry.queryHint);
        if (url.protocol !== "https:") throw new TypeError("not https");
      } catch {
        issues.push({
          code: "candidate_url_scope_mismatch",
          path: `frontier[${index}].queryHint`,
          message: `${entry.sourceLaneId} requires an exact candidate-linked HTTPS URL`,
        });
      }
    }
    if (entry.mutation !== null && (
      typeof entry.mutation !== "object"
      || !FRONTIER_MUTATION_STRATEGIES.includes(entry.mutation.strategy)
      || !Number.isInteger(entry.mutation.proposalIndex)
      || entry.mutation.proposalIndex < 0
      || !Number.isFinite(entry.mutation.temperature)
      || entry.mutation.temperature <= 0
      || !Number.isFinite(entry.mutation.logAcceptanceRatio)
      || !Number.isFinite(entry.mutation.acceptanceProbability)
      || entry.mutation.acceptanceProbability < 0
      || entry.mutation.acceptanceProbability > 1
      || !Number.isFinite(entry.mutation.deterministicU)
      || entry.mutation.deterministicU < 0
      || entry.mutation.deterministicU > 1
      || !Number.isInteger(entry.mutation.parentNeighborCount)
      || entry.mutation.parentNeighborCount <= 0
      || !Number.isInteger(entry.mutation.candidateNeighborCount)
      || entry.mutation.candidateNeighborCount <= 0
    )) {
      issues.push({
        code: "invalid_mutation_metadata",
        path: `frontier[${index}].mutation`,
        message: `${entry.id} has invalid mutation metadata`,
      });
    }
    const parent = entry.parentFrontierEntryId
      ? graph.frontier.find((item) => item.id === entry.parentFrontierEntryId)
      : null;
    if (entry.parentFrontierEntryId !== null && !parent) {
      issues.push({
        code: "missing_parent_frontier",
        path: `frontier[${index}].parentFrontierEntryId`,
        message: entry.parentFrontierEntryId,
      });
    }
    const expectedDepth = (parent?.depth ?? -1) + 1;
    if (entry.depth !== expectedDepth) {
      issues.push({
        code: "frontier_depth_mismatch",
        path: `frontier[${index}].depth`,
        message: `${entry.depth} != ${expectedDepth}`,
      });
    }
    const parentNode = graph.nodes.find((node) => node.id === entry.parentNodeId);
    const validParentNode = entry.parentFrontierEntryId === null
      ? entry.parentNodeId === graph.seedNodeId
      : Boolean(parent && parentNode && (
        entry.parentNodeId === parent.nodeId
        || (parentNode.frontierEntryId === parent.id && parentNode.actionId === parent.id)
      ));
    if (!validParentNode) {
      issues.push({
        code: "frontier_parent_node_mismatch",
        path: `frontier[${index}].parentNodeId`,
        message: `${entry.id} does not descend from its declared frontier parent`,
      });
    }
    if (
      parentNode?.candidateId !== null
      && parentNode?.candidateId !== undefined
      && entry.candidateId !== null
      && parentNode.candidateId !== entry.candidateId
    ) {
      issues.push({
        code: "frontier_candidate_scope_mismatch",
        path: `frontier[${index}].candidateId`,
        message: `${entry.id} crosses its parent candidate scope`,
      });
    }
    const expectedEdgeCost = calculateEdgeCost(entry.sourceTier, entry.depth, entry.utility);
    if (entry.edgeCost !== expectedEdgeCost) {
      issues.push({
        code: "frontier_edge_cost_mismatch",
        path: `frontier[${index}].edgeCost`,
        message: `${entry.edgeCost} != ${expectedEdgeCost}`,
      });
    }
    const expectedPathCost = rounded((parent?.pathCost ?? 0) + entry.edgeCost);
    if (entry.pathCost !== expectedPathCost) {
      issues.push({ code: "path_cost_mismatch", path: `frontier[${index}].pathCost`, message: `${entry.pathCost} != ${expectedPathCost}` });
    }
    const pivotNode = graph.nodes.find((node) => node.id === entry.nodeId);
    if (
      !pivotNode
      || pivotNode.kind !== "pivot"
      || pivotNode.frontierEntryId !== entry.id
      || pivotNode.actionId !== entry.id
      || pivotNode.sourceTier !== entry.sourceTier
      || pivotNode.sourceLaneId !== entry.sourceLaneId
      || pivotNode.candidateId !== entry.candidateId
      || pivotNode.status !== entry.status
      || pivotNode.data.intent !== entry.intent
      || pivotNode.data.queryHint !== entry.queryHint
    ) {
      issues.push({
        code: "frontier_pivot_mismatch",
        path: `frontier[${index}].nodeId`,
        message: `${entry.id} does not match its canonical pivot node`,
      });
    }
    const expansionEdges = graph.edges.filter((edge) =>
      edge.fromNodeId === entry.parentNodeId
      && edge.toNodeId === entry.nodeId
      && edge.frontierEntryId === entry.id
      && edge.actionId === entry.id
      && edge.kind === (entry.mutation ? "mutates" : "expands")
      && edge.edgeCost === entry.edgeCost
      && edge.pathCost === entry.pathCost);
    if (expansionEdges.length !== 1) {
      issues.push({
        code: "frontier_expansion_edge_mismatch",
        path: `frontier[${index}].nodeId`,
        message: `${entry.id} requires exactly one canonical expansion edge`,
      });
    }
    if (entry.mutation && (
      entry.parentFrontierEntryId === null
      || entry.mutation.parentFrontierEntryId !== entry.parentFrontierEntryId
    )) {
      issues.push({
        code: "mutation_parent_mismatch",
        path: `frontier[${index}].mutation.parentFrontierEntryId`,
        message: `${entry.id} mutation parent disagrees with its frontier parent`,
      });
    }
    if (!["rejected", "exhausted"].includes(entry.status)) {
      if (activeDedupe.has(entry.dedupeKey)) {
        issues.push({ code: "active_dedupe_collision", path: `frontier[${index}].dedupeKey`, message: entry.dedupeKey });
      }
      activeDedupe.add(entry.dedupeKey);
    }
  });

  const frontierById = new Map(graph.frontier.map((entry) => [entry.id, entry]));
  const actionNodesByEntry = new Map<string, SearchGraphNode[]>();
  graph.nodes.forEach((node, index) => {
    if (node.kind === "pivot") {
      const owners = graph.frontier.filter((entry) => entry.nodeId === node.id);
      if (owners.length !== 1) {
        issues.push({
          code: "orphan_or_duplicate_pivot",
          path: `nodes[${index}]`,
          message: `${node.id} must be the canonical pivot of exactly one frontier entry`,
        });
      }
    }
    if (node.kind === "action") {
      if (node.frontierEntryId === null || node.actionId === null) {
        issues.push({
          code: "unbound_action_node",
          path: `nodes[${index}]`,
          message: "action nodes require canonical frontier/action provenance",
        });
        return;
      }
      const nodes = actionNodesByEntry.get(node.frontierEntryId) ?? [];
      nodes.push(node);
      actionNodesByEntry.set(node.frontierEntryId, nodes);
      const entry = frontierById.get(node.frontierEntryId);
      if (
        !entry
        || typeof node.data.tool !== "string"
        || !entry.allowedTools.includes(node.data.tool)
        || ["queued", "selected", "mutated"].includes(entry.status)
      ) {
        issues.push({
          code: "invalid_action_node_binding",
          path: `nodes[${index}]`,
          message: `${node.id} is not one executed action for its frontier entry`,
        });
      }
    }
    if (node.kind === "gap" && (node.frontierEntryId === null || node.actionId === null)) {
      issues.push({
        code: "unbound_gap_node",
        path: `nodes[${index}]`,
        message: "gap nodes require canonical frontier/action provenance",
      });
    }
  });
  for (const [entryId, nodes] of actionNodesByEntry) {
    if (nodes.length !== 1) {
      issues.push({
        code: "duplicate_action_node",
        path: "nodes",
        message: `${entryId} has ${nodes.length} action nodes`,
      });
    }
    const entry = frontierById.get(entryId);
    if (entry && nodes.length === 1) {
      const actionEdges = graph.edges.filter((edge) =>
        edge.fromNodeId === entry.nodeId
        && edge.toNodeId === nodes[0].id
        && edge.actionId === entry.id
        && edge.frontierEntryId === entry.id
        && edge.kind === (entry.mutation ? "mutates" : "expands"));
      if (actionEdges.length !== 1) {
        issues.push({
          code: "missing_or_duplicate_action_edge",
          path: "edges",
          message: `${entryId} requires one canonical pivot-to-action edge`,
        });
      }
    }
  }
  const reportNodes = graph.nodes.filter((node) => node.kind === "report");
  const reportRequired = graph.seedNodeId !== null
    && ["completed", "blocked", "canceled", "failed"].includes(graph.status);
  const reportForbidden = graph.status === "active" || graph.status === "empty";
  if (
    (reportRequired && reportNodes.length !== 1)
    || (reportForbidden && reportNodes.length !== 0)
    || (!reportRequired && !reportForbidden && reportNodes.length > 1)
  ) {
    issues.push({
      code: "invalid_report_node_cardinality",
      path: "nodes",
      message: `${graph.status} graph has ${reportNodes.length} report nodes`,
    });
  }
  reportNodes.forEach((node) => {
    if (
      node.frontierEntryId !== null
      || node.actionId !== null
      || node.candidateId !== null
      || node.evidenceId !== null
      || node.findingId !== null
      || node.sourceTier !== null
      || node.sourceLaneId !== null
      || node.data.entityKey !== `report:${graph.runId}`
    ) {
      issues.push({
        code: "invalid_report_node_projection",
        path: `nodes[${graph.nodes.indexOf(node)}]`,
        message: "report node is not the canonical unbound run report",
      });
    }
  });

  const seedNodes = graph.nodes.filter((node) => node.kind === "seed");
  const hasAdmittedSearchState = graph.seedNodeId !== null
    || graph.nodes.length > 0
    || graph.edges.length > 0
    || graph.frontier.length > 0;
  if (hasAdmittedSearchState && !graphNonEmptyString(graph.seed)) {
    issues.push({
      code: "invalid_graph_seed",
      path: "seed",
      message: "a graph with admitted search state requires a non-empty seed",
    });
  }
  if (graph.status === "empty") {
    if (
      graph.seedNodeId !== null
      || graph.nodes.length > 0
      || graph.edges.length > 0
      || graph.frontier.length > 0
      || graph.selectedFrontierEntryIds.length > 0
    ) {
      issues.push({
        code: "invalid_empty_graph",
        path: "status",
        message: "an empty graph cannot contain admitted search state",
      });
    }
  } else if (!hasAdmittedSearchState) {
    if (!["blocked", "canceled", "failed"].includes(graph.status)) {
      issues.push({
        code: "missing_seed_node",
        path: "seedNodeId",
        message: `${graph.status} graph cannot be unseeded`,
      });
    }
  } else if (
    graph.seedNodeId === null
    || seedNodes.length !== 1
    || seedNodes[0]?.id !== graph.seedNodeId
    || seedNodes[0]?.frontierEntryId !== null
    || seedNodes[0]?.actionId !== null
    || seedNodes[0]?.candidateId !== null
  ) {
    issues.push({
      code: "invalid_seed_node",
      path: "seedNodeId",
      message: "a non-empty graph requires exactly one unbound canonical seed node",
    });
  }

  const candidatesExplicitlySeparated = (leftCandidateId: string, rightCandidateId: string): boolean => {
    if (leftCandidateId === rightCandidateId) return false;
    const leftNode = graph.nodes.find((node) =>
      node.kind === "candidate" && node.candidateId === leftCandidateId);
    const rightNode = graph.nodes.find((node) =>
      node.kind === "candidate" && node.candidateId === rightCandidateId);
    if (!leftNode || !rightNode) return false;
    return graph.edges.some((edge) =>
      edge.kind === "separates"
      && ((edge.fromNodeId === leftNode.id && edge.toNodeId === rightNode.id)
        || (edge.fromNodeId === rightNode.id && edge.toNodeId === leftNode.id)));
  };

  graph.nodes.forEach((node, index) => {
    if (node.frontierEntryId === null && node.actionId === null) return;
    const entry = node.frontierEntryId ? frontierById.get(node.frontierEntryId) : undefined;
    if (
      node.frontierEntryId === null
      || node.actionId !== node.frontierEntryId
      || !entry
    ) {
      issues.push({
        code: "broken_node_action_join",
        path: `nodes[${index}].frontierEntryId`,
        message: `${node.id} is not joined to one canonical frontier/action ID`,
      });
      return;
    }
    if (node.sourceTier !== entry.sourceTier || node.sourceLaneId !== entry.sourceLaneId) {
      issues.push({
        code: "node_source_lane_mismatch",
        path: `nodes[${index}].sourceLaneId`,
        message: `${node.id} disagrees with frontier ${entry.id}`,
      });
    }
    const quarantinedCandidateScope = entry.candidateId !== null
      && node.candidateId !== null
      && (node.kind === "source" || node.kind === "evidence")
      && candidatesExplicitlySeparated(entry.candidateId, node.candidateId);
    if (
      entry.candidateId !== null
      && node.candidateId !== entry.candidateId
      && !quarantinedCandidateScope
    ) {
      issues.push({
        code: "node_candidate_scope_mismatch",
        path: `nodes[${index}].candidateId`,
        message: `${node.id} crosses candidate scope for frontier ${entry.id}`,
      });
    }
    if (node.kind === "action") {
      if (node.candidateId !== entry.candidateId) {
        issues.push({
          code: "frontier_action_candidate_mismatch",
          path: `nodes[${index}].candidateId`,
          message: `${node.id} candidate does not match frontier ${entry.id}`,
        });
      }
    }
  });
  // Evidence nodes may precede their action node in untrusted input order.
  graph.nodes.forEach((node, index) => {
    if (node.kind !== "evidence" || node.actionId === null) return;
    const actionNode = graph.nodes.find((candidate) =>
      candidate.kind === "action" && candidate.actionId === node.actionId);
    if (
      actionNode?.candidateId !== null
      && actionNode?.candidateId !== undefined
      && node.candidateId !== actionNode.candidateId
      && !(node.candidateId !== null
        && candidatesExplicitlySeparated(actionNode.candidateId, node.candidateId))
    ) {
      issues.push({
        code: "action_evidence_candidate_mismatch",
        path: `nodes[${index}].candidateId`,
        message: `${node.id} candidate does not match its bound action`,
      });
    }
  });

  graph.edges.forEach((edge, index) => {
    if (edge.frontierEntryId !== null || edge.actionId !== null) {
      if (
        edge.frontierEntryId === null
        || edge.actionId !== edge.frontierEntryId
        || !frontierById.has(edge.frontierEntryId)
      ) {
        issues.push({
          code: "broken_edge_action_join",
          path: `edges[${index}].frontierEntryId`,
          message: `${edge.id} is not joined to one canonical frontier/action ID`,
        });
      }
    }
    const from = graph.nodes.find((node) => node.id === edge.fromNodeId);
    const to = graph.nodes.find((node) => node.id === edge.toNodeId);
    if (!from || !to) return;
    const endpointPair = `${from.kind}->${to.kind}`;
    if (!GRAPH_EDGE_ENDPOINTS[edge.kind].has(endpointPair)) {
      issues.push({
        code: "invalid_edge_endpoints",
        path: `edges[${index}]`,
        message: `${edge.kind} cannot connect ${endpointPair}`,
      });
    }
    const frontierTransition = (edge.kind === "expands" || edge.kind === "mutates")
      && to.kind === "pivot";
    if (edge.actionId !== null) {
      const matchingEndpoint = from.actionId === edge.actionId || to.actionId === edge.actionId;
      const incompatibleFrom = from.actionId !== null
        && from.actionId !== edge.actionId
        && !frontierTransition;
      const incompatibleTo = to.actionId !== null && to.actionId !== edge.actionId;
      if (!matchingEndpoint || incompatibleFrom || incompatibleTo) {
        issues.push({
          code: "edge_action_provenance_mismatch",
          path: `edges[${index}].actionId`,
          message: `${edge.id} disagrees with its endpoint action provenance`,
        });
      }
    } else if (from.actionId !== null && to.actionId !== null) {
      issues.push({
        code: "missing_edge_action_provenance",
        path: `edges[${index}].actionId`,
        message: `${edge.id} joins action-bound endpoints without an action ID`,
      });
    }
    const quarantinedCandidateEdge = from.candidateId !== null
      && to.candidateId !== null
      && candidatesExplicitlySeparated(from.candidateId, to.candidateId)
      && from.kind === "action"
      && (to.kind === "candidate" || to.kind === "source");
    if (
      edge.kind !== "separates"
      && from.candidateId !== null
      && to.candidateId !== null
      && from.candidateId !== to.candidateId
      && !quarantinedCandidateEdge
    ) {
      issues.push({
        code: "edge_candidate_scope_mismatch",
        path: `edges[${index}]`,
        message: `${edge.id} crosses candidate ledgers`,
      });
    }
    if (
      edge.kind === "separates"
      && (from.candidateId === null || to.candidateId === null || from.candidateId === to.candidateId)
    ) {
      issues.push({
        code: "invalid_candidate_separation",
        path: `edges[${index}]`,
        message: `${edge.id} does not separate two distinct candidates`,
      });
    }
  });

  if (graph.seedNodeId !== null) {
    const reachable = new Set<string>([graph.seedNodeId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of graph.edges) {
        if (reachable.has(edge.fromNodeId) && !reachable.has(edge.toNodeId)) {
          reachable.add(edge.toNodeId);
          changed = true;
        }
      }
    }
    graph.nodes.forEach((node, index) => {
      if (node.kind !== "report" && !reachable.has(node.id)) {
        issues.push({
          code: "unreachable_graph_node",
          path: `nodes[${index}]`,
          message: `${node.id} is not reachable from the canonical seed`,
        });
      }
    });
  }

  const ordinals = [
    ...graph.nodes.map((node) => node.ordinal),
    ...graph.edges.map((edge) => edge.ordinal),
    ...graph.frontier.map((entry) => entry.ordinal),
  ];
  if (new Set(ordinals).size !== ordinals.length) {
    issues.push({ code: "duplicate_ordinal", path: "nextOrdinal", message: "graph ordinals must be globally unique" });
  }
  const expectedNextOrdinal = Math.max(0, ...ordinals) + 1;
  if (graph.nextOrdinal !== expectedNextOrdinal) {
    issues.push({
      code: "next_ordinal_mismatch",
      path: "nextOrdinal",
      message: `${graph.nextOrdinal} != ${expectedNextOrdinal}`,
    });
  }
  if (graph.telemetry.enqueued !== graph.frontier.length) {
    issues.push({
      code: "enqueued_counter_mismatch",
      path: "telemetry.enqueued",
      message: `${graph.telemetry.enqueued} != ${graph.frontier.length}`,
    });
  }
  const verifiedFrontierCount = graph.frontier.filter((entry) => entry.status === "verified").length;
  if (
    graph.telemetry.expanded !== verifiedFrontierCount
  ) {
    issues.push({
      code: "tool_outcome_counter_mismatch",
      path: "telemetry.toolCalls",
      message: "expanded counter must equal unique verified frontier outcomes",
    });
  }
  if (
    graph.mutationStep !== graph.telemetry.mutationsProposed
    || graph.telemetry.mutationsProposed
      !== graph.telemetry.mutationsAccepted + graph.telemetry.mutationsRejected
  ) {
    issues.push({
      code: "mutation_counter_mismatch",
      path: "mutationStep",
      message: "mutation counters must be internally consistent",
    });
  }
  if (Date.parse(graph.updatedAt) < Date.parse(graph.createdAt)) {
    issues.push({
      code: "graph_timestamp_order",
      path: "updatedAt",
      message: "updatedAt cannot precede createdAt",
    });
  }
  for (const id of graph.selectedFrontierEntryIds) {
    const entry = graph.frontier.find((item) => item.id === id);
    if (!entry || !["selected", "running"].includes(entry.status)) {
      issues.push({ code: "invalid_selected_frontier", path: "selectedFrontierEntryIds", message: id });
    }
  }
  const selectedTiers = new Set(graph.selectedFrontierEntryIds
    .map((id) => graph.frontier.find((entry) => entry.id === id)?.sourceTier)
    .filter((tier): tier is SourceTier => tier !== undefined));
  if (selectedTiers.size > 1) {
    issues.push({
      code: "mixed_selected_tiers",
      path: "selectedFrontierEntryIds",
      message: "one frontier batch cannot span source tiers",
    });
  }
  if (
    selectedTiers.size === 1
    && graph.currentSourceTier !== [...selectedTiers][0]
  ) {
    issues.push({
      code: "current_source_tier_mismatch",
      path: "currentSourceTier",
      message: "current source tier must match the selected batch",
    });
  }
  if (graph.status !== "active" && graph.selectedFrontierEntryIds.length > 0) {
    issues.push({
      code: "terminal_graph_has_selection",
      path: "selectedFrontierEntryIds",
      message: "only an active graph may retain selected frontier entries",
    });
  }
  if (
    graph.telemetry.mutationToolCalls > graph.telemetry.toolCalls
    || (graph.telemetry.toolCalls > 0
      && graph.telemetry.mutationToolCalls / graph.telemetry.toolCalls > MUTATION_SHARE_CAP + Number.EPSILON)
  ) {
    issues.push({ code: "mutation_share_exceeded", path: "telemetry.mutationToolCalls", message: "mutation tool share exceeds 20%" });
  }
  return issues;
}

export function assertSearchGraph(graph: SearchGraph): void {
  const issues = validateSearchGraph(graph);
  if (issues.length > 0) {
    throw new Error(`search graph invariant failed: ${issues.map((issue) =>
      `${issue.code}@${issue.path}:${issue.message}`).join(", ")}`);
  }
}

function immutableFrontierFingerprint(entry: SearchFrontierEntry): string {
  return JSON.stringify({
    schemaVersion: entry.schemaVersion,
    id: entry.id,
    frontierEntryId: entry.frontierEntryId,
    actionId: entry.actionId,
    nodeId: entry.nodeId,
    parentNodeId: entry.parentNodeId,
    parentFrontierEntryId: entry.parentFrontierEntryId,
    sourceTier: entry.sourceTier,
    sourceLaneId: entry.sourceLaneId,
    allowedTools: entry.allowedTools,
    intent: entry.intent,
    queryHint: entry.queryHint,
    candidateId: entry.candidateId,
    depth: entry.depth,
    ordinal: entry.ordinal,
    dedupeKey: entry.dedupeKey,
    utility: entry.utility,
    edgeCost: entry.edgeCost,
    pathCost: entry.pathCost,
    mutation: entry.mutation,
    createdAt: entry.createdAt,
  });
}

function immutableNodeFingerprint(node: SearchGraphNode): string {
  return JSON.stringify({
    schemaVersion: node.schemaVersion,
    id: node.id,
    kind: node.kind,
    label: node.label,
    sourceTier: node.sourceTier,
    sourceLaneId: node.sourceLaneId,
    frontierEntryId: node.frontierEntryId,
    actionId: node.actionId,
    candidateId: node.candidateId,
    evidenceId: node.evidenceId,
    findingId: node.findingId,
    ordinal: node.ordinal,
    data: node.data,
    createdAt: node.createdAt,
  });
}

/**
 * Enforces append-only graph identity and immutable search costs across live
 * scheduler snapshots. Status and updatedAt are the only mutable entry fields.
 */
export function assertSearchGraphEvolution(previous: SearchGraph, next: SearchGraph): void {
  assertSearchGraph(previous);
  assertSearchGraph(next);
  if (next.runId !== previous.runId || next.createdAt !== previous.createdAt) {
    throw new Error("search graph identity is immutable");
  }
  if (previous.seedNodeId !== null && (
    next.seedNodeId !== previous.seedNodeId || next.seed !== previous.seed
  )) {
    throw new Error("seed identity is immutable after frontier seeding");
  }
  if (next.nextOrdinal < previous.nextOrdinal || next.mutationStep < previous.mutationStep) {
    throw new Error(
      `search graph counters cannot regress: nextOrdinal ${previous.nextOrdinal}->${next.nextOrdinal}, mutationStep ${previous.mutationStep}->${next.mutationStep}, nodes ${previous.nodes.length}->${next.nodes.length}, edges ${previous.edges.length}->${next.edges.length}, frontier ${previous.frontier.length}->${next.frontier.length}, status ${previous.status}->${next.status}`,
    );
  }
  if (
    previous.currentSourceTier !== null
    && next.currentSourceTier !== null
    && next.currentSourceTier < previous.currentSourceTier
  ) {
    throw new Error("source hierarchy cursor cannot regress");
  }
  for (const priorEntry of previous.frontier) {
    const nextEntry = next.frontier.find((entry) => entry.id === priorEntry.id);
    if (!nextEntry) throw new Error(`frontier entry ${priorEntry.id} cannot be removed`);
    if (immutableFrontierFingerprint(nextEntry) !== immutableFrontierFingerprint(priorEntry)) {
      throw new Error(`frontier entry ${priorEntry.id} immutable fields changed`);
    }
  }
  for (const priorNode of previous.nodes) {
    const nextNode = next.nodes.find((node) => node.id === priorNode.id);
    if (!nextNode) throw new Error(`graph node ${priorNode.id} cannot be removed`);
    if (immutableNodeFingerprint(nextNode) !== immutableNodeFingerprint(priorNode)) {
      throw new Error(`graph node ${priorNode.id} immutable fields changed`);
    }
  }
  for (const priorEdge of previous.edges) {
    const nextEdge = next.edges.find((edge) => edge.id === priorEdge.id);
    if (!nextEdge) throw new Error(`graph edge ${priorEdge.id} cannot be removed`);
    if (JSON.stringify(nextEdge) !== JSON.stringify(priorEdge)) {
      throw new Error(`graph edge ${priorEdge.id} immutable fields changed`);
    }
  }
  for (const [key, value] of Object.entries(previous.telemetry)) {
    const nextValue = next.telemetry[key as keyof SearchGraph["telemetry"]];
    if (nextValue < value) throw new Error(`search graph telemetry ${key} cannot regress`);
  }
}

export function frontierEntryById(graph: SearchGraph, id: string): SearchFrontierEntry | undefined {
  return graph.frontier.find((entry) => entry.id === id);
}

export function registeredOrGenericLane(entry: SearchFrontierEntry): SourceLane {
  const lane = sourceLaneForFrontierEntry(entry);
  if (!lane) throw new Error(`frontier entry ${entry.id} has no canonical source lane`);
  return lane;
}

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { InvestigationEngine } from "../lib/agent/engine.ts";
import {
  buildInvestigationReport,
  requestedCategoriesForInput,
  resolveIdentity,
  summarizeCoverage,
} from "../lib/domain/report.ts";
import { evaluateStop } from "../lib/domain/stopping.ts";
import { cloneJson, createDeterministicIdFactory, createSequenceClock } from "../lib/domain/runtime.ts";
import {
  SCHEMA_VERSION,
  type Candidate,
  type EvidenceDraft,
  type InvestigationInput,
  type InvestigationReport,
  type JsonObject,
  type ResearchPhase,
  type SearchFrontierEntry,
  type SearchGraph,
  type SearchGraphNode,
  type SearchGraphStatus,
} from "../lib/domain/types.ts";
import {
  admitGraphEdge,
  admitGraphNode,
  enqueueFrontier,
  markSearchGraphTerminal,
  proposeBoundedMutation,
  recordFrontierOutcome,
  seedFrontier,
  selectFrontierBatch,
  setFrontierStatus,
  sourceLaneById,
  type SearchKernelEvent,
  type SearchKernelResult,
} from "../lib/search/index.ts";
import {
  VERIFIED_CAPTURED_AT,
  VERIFIED_GITHUB_STRONGEST_SHA,
  applyVerifiedCaptureMetadata,
  assertVerifiedEvidenceContract,
  verifiedApiEvidence,
  verifiedDirectEvidence,
  type VerifiedRequestId,
} from "./capture-contract.ts";

import linusInputJson from "../examples/linus-codegraph/input.json" with { type: "json" };
import chrisInputJson from "../examples/chris-anderson-ted/input.json" with { type: "json" };
import pythonInputJson from "../examples/python-creator/input.json" with { type: "json" };
import linusCassetteJson from "../examples/linus-codegraph/cassette.json" with { type: "json" };
import chrisCassetteJson from "../examples/chris-anderson-ted/cassette.json" with { type: "json" };
import pythonCassetteJson from "../examples/python-creator/cassette.json" with { type: "json" };
import linusManifestJson from "../examples/linus-codegraph/manifest.json" with { type: "json" };
import chrisManifestJson from "../examples/chris-anderson-ted/manifest.json" with { type: "json" };
import pythonManifestJson from "../examples/python-creator/manifest.json" with { type: "json" };

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const capturedAt = VERIFIED_CAPTURED_AT;

interface GeneratedExample {
  id: string;
  report: InvestigationReport;
  trace: JsonObject[];
  captureActions: Partial<Record<VerifiedRequestId, string>>;
}

function input(value: unknown): InvestigationInput {
  return cloneJson(value) as InvestigationInput;
}

function advance(
  engine: InvestigationEngine,
  phase: Exclude<ResearchPhase, "intake" | "terminal">,
  decisionSummary: string,
): void {
  engine.transition(phase);
  engine.trace.record("decision", {
    phase,
    payload: {
      decisionSummary,
      decisionProvenance: "scripted_local_policy",
      provider: null,
    },
    usage: { unavailableReason: "scripted_replay_no_provider" },
  });
}

const GRAPH_COST_PRECISION = 1_000_000;

function graphCost(value: number): number {
  return Math.round(value * GRAPH_COST_PRECISION) / GRAPH_COST_PRECISION;
}

/**
 * Example-only driver for the same pure frontier kernel used by live runs.
 * It never fabricates provider decisions: every network action is bound to one
 * source-verified cassette capture and all other branches remain visibly
 * queued, rejected, or exhausted.
 */
class ReplaySearchGraph {
  readonly captureActions: Partial<Record<VerifiedRequestId, string>> = {};
  readonly #evidenceNodes = new Map<string, string>();
  readonly #candidateNodes = new Map<string, string>();
  readonly #nodePathCosts = new Map<string, number>();
  #working: SearchGraph | null = null;
  #bufferedEvents: SearchKernelEvent[] = [];

  constructor(
    readonly engine: InvestigationEngine,
    readonly availableTools: readonly string[],
  ) {}

  #graph(): SearchGraph {
    return this.#working ?? this.engine.snapshot().searchGraph;
  }

  /**
   * Mirror the live runner: several kernel admissions (a node plus its
   * grounding edges) form one connected subgraph that is only valid once fully
   * linked. Buffer those admissions against a working graph and validate the
   * whole thing a single time, rather than after every intermediate step.
   */
  #transaction<T>(build: () => T): T {
    if (this.#working) throw new Error("nested graph transaction is not supported");
    this.#working = cloneJson(this.engine.snapshot().searchGraph);
    this.#bufferedEvents = [];
    try {
      const value = build();
      this.engine.replaceSearchGraph(this.#working);
      const events = this.#bufferedEvents;
      this.#working = null;
      this.#bufferedEvents = [];
      this.#recordKernelEvents(events);
      return value;
    } catch (error) {
      this.#working = null;
      this.#bufferedEvents = [];
      throw error;
    }
  }

  #recordKernelEvents(events: readonly SearchKernelEvent[]): void {
    for (const event of events) {
      this.engine.trace.record(event.name, {
        phase: this.engine.phase,
        payload: event.payload,
        usage: { unavailableReason: "scripted_frontier_kernel" },
      });
    }
  }

  #apply<T>(result: SearchKernelResult<T>): T {
    for (const entry of result.graph.frontier) {
      this.#nodePathCosts.set(entry.nodeId, entry.pathCost);
    }
    if (result.graph.seedNodeId) this.#nodePathCosts.set(result.graph.seedNodeId, 0);
    if (this.#working) {
      // Inside a transaction: stage the graph and buffer events; the enclosing
      // #transaction commits and validates the connected subgraph once.
      this.#working = result.graph;
      this.#bufferedEvents.push(...result.events);
      return result.value;
    }
    this.engine.replaceSearchGraph(result.graph);
    this.#recordKernelEvents(result.events);
    return result.value;
  }

  seed(): SearchFrontierEntry[] {
    const state = this.engine.snapshot();
    return this.#apply(
      seedFrontier(state.searchGraph, state.target, this.availableTools, this.engine.ids, this.engine.clock.now()),
    );
  }

  selectNext(): SearchFrontierEntry {
    const selected = this.#apply(selectFrontierBatch(this.#graph(), 1, this.engine.clock.now()));
    if (selected.length !== 1) throw new Error("example frontier has no selectable entry");
    return selected[0];
  }

  enqueue(
    laneId: string,
    options: {
      parent?: SearchFrontierEntry | null;
      candidate?: Pick<Candidate, "id" | "displayName"> | null;
      intent: string;
      queryHint: string;
    },
  ): SearchFrontierEntry {
    const graph = this.#graph();
    const lane = sourceLaneById(laneId);
    if (!lane) throw new Error(`example references unknown source lane ${laneId}`);
    const parent = options.parent ?? null;
    const parentNodeId = parent?.nodeId ?? graph.seedNodeId;
    if (!parentNodeId) throw new Error("example graph must be seeded before enqueue");
    const value = this.#apply(
      enqueueFrontier(
        graph,
        {
          lane,
          target: this.engine.snapshot().target,
          parentNodeId,
          parentFrontierEntry: parent,
          candidateId: options.candidate?.id ?? null,
          candidateLabel: options.candidate?.displayName ?? null,
          intent: options.intent,
          queryHint: options.queryHint,
        },
        this.engine.ids,
        this.engine.clock.now(),
      ),
    );
    if (!value) throw new Error(`example frontier entry ${laneId} was unexpectedly dominated`);
    return value;
  }

  recordCapturedTool(
    entry: SearchFrontierEntry,
    captureId: VerifiedRequestId,
    tool: string,
    requestFingerprint: string,
    options: {
      status?: "succeeded" | "partial";
      networkRequests?: number;
      bytesRead?: number | null;
      payload?: JsonObject;
      search?: boolean;
    } = {},
  ): void {
    if (!entry.allowedTools.includes(tool)) {
      throw new Error(`tool ${tool} is not allowed by replay frontier ${entry.id}`);
    }
    if (this.captureActions[captureId]) {
      throw new Error(`capture ${captureId} is bound to more than one action`);
    }
    this.captureActions[captureId] = entry.actionId;
    const networkRequests = options.networkRequests ?? 1;
    const spanId = this.engine.trace.startSpan({
      name: `tool.${tool}`,
      phase: this.engine.phase,
      payload: {
        actionId: entry.actionId,
        frontierEntryId: entry.id,
        sourceLaneId: entry.sourceLaneId,
        sourceTier: entry.sourceTier,
        captureId,
        requestFingerprint,
        replayNetwork: "forbidden",
        captureProvenance: "source_verified_scripted_reconstruction",
      },
      usage: { unavailableReason: "captured_request_start" },
    });
    this.engine.recordToolCall(networkRequests, options.search ?? false);
    this.engine.trace.endSpan(spanId, {
      status: options.status ?? "succeeded",
      payload: {
        actionId: entry.actionId,
        frontierEntryId: entry.id,
        captureId,
        ...(options.payload ?? {}),
        responseBodyRetained: false,
      },
      usage: {
        networkRequests,
        ...(typeof options.bytesRead === "number" ? { bytesRead: options.bytesRead } : {}),
        unavailableReason: "provider_tokens_not_applicable",
      },
    });
  }

  outcome(entry: SearchFrontierEntry, status: Extract<SearchGraphStatus, "verified" | "rejected" | "exhausted">): void {
    // Mirror the live runner: a selected entry transitions to `running` before
    // its outcome is admitted. The kernel requires exactly one running entry.
    this.engine.replaceSearchGraph(setFrontierStatus(this.#graph(), [entry.id], "running", this.engine.clock.now()));
    this.#apply(recordFrontierOutcome(this.#graph(), entry, status, this.engine.clock.now()));
  }

  async proposeMutation(parent: SearchFrontierEntry): Promise<SearchFrontierEntry | null> {
    const state = this.engine.snapshot();
    return this.#apply(
      await proposeBoundedMutation(state.searchGraph, state.target, parent, this.engine.ids, this.engine.clock.now()),
    );
  }

  linkEvidence(entry: SearchFrontierEntry, evidenceId: string): void {
    const record = this.engine.snapshot().evidence.find((item) => item.id === evidenceId);
    if (!record) throw new Error(`unknown example evidence ${evidenceId}`);
    const status: SearchGraphStatus = record.disposition === "contradicts" ? "rejected" : "verified";
    this.#transaction(() => {
      const source = this.#apply(
        admitGraphNode(
          this.#graph(),
          {
            kind: "source",
            label: record.title ?? record.sourceFamily,
            status,
            sourceTier: entry.sourceTier,
            sourceLaneId: entry.sourceLaneId,
            frontierEntryId: entry.id,
            actionId: entry.actionId,
            candidateId: record.candidateId,
            evidenceId: record.id,
            data: {
              sourceUrl: record.sourceUrl,
              sourceFamily: record.sourceFamily,
              sourceType: record.sourceType,
            },
            dedupeEntityKey: `source:${record.id}`,
          },
          this.engine.ids,
          this.engine.clock.now(),
        ),
      );
      const sourceCost = graphCost(entry.pathCost + 0.04);
      this.#nodePathCosts.set(source.id, sourceCost);
      this.#apply(
        admitGraphEdge(
          this.#graph(),
          {
            fromNodeId: entry.nodeId,
            toNodeId: source.id,
            kind: "grounds",
            status,
            frontierEntryId: entry.id,
            actionId: entry.actionId,
            edgeCost: 0.04,
            pathCost: sourceCost,
          },
          this.engine.ids,
          this.engine.clock.now(),
        ),
      );

      const evidenceNode = this.#apply(
        admitGraphNode(
          this.#graph(),
          {
            kind: "evidence",
            label: record.claim,
            status,
            sourceTier: entry.sourceTier,
            sourceLaneId: entry.sourceLaneId,
            frontierEntryId: entry.id,
            actionId: entry.actionId,
            candidateId: record.candidateId,
            evidenceId: record.id,
            data: {
              sourceUrl: record.sourceUrl,
              sourceFamily: record.sourceFamily,
              sourceType: record.sourceType,
              disposition: record.disposition,
              contentHash: record.contentHash,
              verificationMethod: record.verificationMethod,
            },
            dedupeEntityKey: `evidence:${record.id}`,
          },
          this.engine.ids,
          this.engine.clock.now(),
        ),
      );
      const evidenceCost = graphCost(sourceCost + 0.03);
      this.#nodePathCosts.set(evidenceNode.id, evidenceCost);
      this.#evidenceNodes.set(record.id, evidenceNode.id);
      // A source structurally grounds its extracted evidence; the supporting or
      // contradicting disposition is carried by node/edge status and by the
      // evidence->candidate edge, matching the live runner's graph.
      this.#apply(
        admitGraphEdge(
          this.#graph(),
          {
            fromNodeId: source.id,
            toNodeId: evidenceNode.id,
            kind: "grounds",
            status,
            frontierEntryId: entry.id,
            actionId: entry.actionId,
            edgeCost: 0.03,
            pathCost: evidenceCost,
          },
          this.engine.ids,
          this.engine.clock.now(),
        ),
      );
    });
  }

  selectDeferredBranch(): void {
    const entry = this.selectNext();
    this.engine.trace.record("frontier.deferred", {
      phase: this.engine.phase,
      payload: {
        actionId: entry.actionId,
        frontierEntryId: entry.id,
        sourceLaneId: entry.sourceLaneId,
        reason: "goal_satisfied_before_execution",
      },
      usage: { unavailableReason: "scripted_frontier_kernel" },
    });
  }

  finalizeStructure(): void {
    const state = this.engine.snapshot();
    let selectedBeforeTerminal: string[] = [];
    // Candidate, disambiguation, finding, and report nodes plus their edges form
    // one connected terminal subgraph; admit them as a single validated unit.
    this.#transaction(() => {
      for (const candidate of state.candidates) {
        const candidateStatus: SearchGraphStatus = candidate.status === "rejected" ? "rejected" : "verified";
        const candidateNode = this.#apply(
          admitGraphNode(
            this.#graph(),
            {
              kind: "candidate",
              label: candidate.displayName,
              status: candidateStatus,
              candidateId: candidate.id,
              data: {},
              dedupeEntityKey: `candidate:${candidate.id}`,
            },
            this.engine.ids,
            this.engine.clock.now(),
          ),
        );
        this.#candidateNodes.set(candidate.id, candidateNode.id);
        const evidenceNodes = candidate.evidenceIds
          .map((evidenceId) => this.#evidenceNodes.get(evidenceId))
          .filter((nodeId): nodeId is string => Boolean(nodeId));
        if (evidenceNodes.length === 0) {
          const seedNodeId = this.#graph().seedNodeId;
          if (!seedNodeId) throw new Error("search graph has no seed node");
          const pathCost = 0.08;
          this.#nodePathCosts.set(candidateNode.id, pathCost);
          this.#apply(
            admitGraphEdge(
              this.#graph(),
              {
                fromNodeId: seedNodeId,
                toNodeId: candidateNode.id,
                kind: "grounds",
                status: candidateStatus,
                edgeCost: 0.08,
                pathCost,
              },
              this.engine.ids,
              this.engine.clock.now(),
            ),
          );
        } else {
          evidenceNodes.forEach((evidenceNodeId, index) => {
            const sourcePath = this.#nodePathCosts.get(evidenceNodeId);
            if (sourcePath === undefined) throw new Error(`missing graph path for ${evidenceNodeId}`);
            const pathCost = graphCost(sourcePath + 0.05);
            if (index === 0) this.#nodePathCosts.set(candidateNode.id, pathCost);
            this.#apply(
              admitGraphEdge(
                this.#graph(),
                {
                  fromNodeId: evidenceNodeId,
                  toNodeId: candidateNode.id,
                  kind: "grounds",
                  status: candidateStatus,
                  edgeCost: 0.05,
                  pathCost,
                },
                this.engine.ids,
                this.engine.clock.now(),
              ),
            );
          });
        }
      }

      const candidatesByName = new Map<string, Candidate[]>();
      for (const candidate of state.candidates) {
        const candidates = candidatesByName.get(candidate.normalizedName) ?? [];
        candidates.push(candidate);
        candidatesByName.set(candidate.normalizedName, candidates);
      }
      for (const candidates of candidatesByName.values()) {
        if (candidates.length < 2) continue;
        const ordered = [...candidates].sort(
          (left, right) => right.score.total - left.score.total || left.id.localeCompare(right.id),
        );
        const sourceNodeId = this.#candidateNodes.get(ordered[0].id);
        if (!sourceNodeId) continue;
        for (const candidate of ordered.slice(1)) {
          const targetNodeId = this.#candidateNodes.get(candidate.id);
          const sourcePath = this.#nodePathCosts.get(sourceNodeId);
          if (!targetNodeId || sourcePath === undefined) continue;
          this.#apply(
            admitGraphEdge(
              this.#graph(),
              {
                fromNodeId: sourceNodeId,
                toNodeId: targetNodeId,
                kind: "separates",
                status: "rejected",
                edgeCost: 0.11,
                pathCost: graphCost(sourcePath + 0.11),
              },
              this.engine.ids,
              this.engine.clock.now(),
            ),
          );
        }
      }

      const findingNodes: SearchGraphNode[] = [];
      for (const finding of state.findings) {
        const candidateNodeId = this.#candidateNodes.get(finding.candidateId);
        const candidatePath = candidateNodeId ? this.#nodePathCosts.get(candidateNodeId) : undefined;
        if (!candidateNodeId || candidatePath === undefined) {
          throw new Error(`finding ${finding.id} has no candidate graph node`);
        }
        const findingNode = this.#apply(
          admitGraphNode(
            this.#graph(),
            {
              kind: "finding",
              label: finding.title,
              status: "verified",
              candidateId: finding.candidateId,
              findingId: finding.id,
              data: {
                category: finding.category,
                confidence: finding.confidence.score,
              },
              dedupeEntityKey: `finding:${finding.id}`,
            },
            this.engine.ids,
            this.engine.clock.now(),
          ),
        );
        const findingPath = graphCost(candidatePath + 0.05);
        this.#nodePathCosts.set(findingNode.id, findingPath);
        this.#apply(
          admitGraphEdge(
            this.#graph(),
            {
              fromNodeId: candidateNodeId,
              toNodeId: findingNode.id,
              kind: "supports",
              status: "verified",
              edgeCost: 0.05,
              pathCost: findingPath,
            },
            this.engine.ids,
            this.engine.clock.now(),
          ),
        );
        findingNodes.push(findingNode);
      }

      const reportNode = this.#apply(
        admitGraphNode(
          this.#graph(),
          {
            kind: "report",
            label: "Final intelligence report",
            status: "verified",
            data: { findingCount: state.findings.length },
            dedupeEntityKey: `report:${this.engine.runId}`,
          },
          this.engine.ids,
          this.engine.clock.now(),
        ),
      );
      for (const findingNode of findingNodes) {
        const findingPath = this.#nodePathCosts.get(findingNode.id);
        if (findingPath === undefined) continue;
        const pathCost = graphCost(findingPath + 0.04);
        if (!this.#nodePathCosts.has(reportNode.id)) this.#nodePathCosts.set(reportNode.id, pathCost);
        this.#apply(
          admitGraphEdge(
            this.#graph(),
            {
              fromNodeId: findingNode.id,
              toNodeId: reportNode.id,
              kind: "includes",
              status: "verified",
              edgeCost: 0.04,
              pathCost,
            },
            this.engine.ids,
            this.engine.clock.now(),
          ),
        );
      }
      // The report node may only exist in a terminal graph, so mark the graph
      // terminal as the last step of the same validated commit (like the runner).
      selectedBeforeTerminal = [...this.#graph().selectedFrontierEntryIds];
      this.#working = markSearchGraphTerminal(this.#graph(), "completed", this.engine.clock.now(), {
        preserveQueued: true,
      });
    });
    const terminalGraph = this.#graph();

    for (const frontierEntryId of selectedBeforeTerminal) {
      this.engine.trace.record("frontier.exhausted", {
        phase: this.engine.phase,
        payload: {
          frontierEntryId,
          actionId: frontierEntryId,
          reason: "goal_satisfied_before_execution",
        },
        usage: { unavailableReason: "scripted_frontier_kernel" },
      });
    }
    this.engine.trace.record("graph.completed", {
      phase: this.engine.phase,
      payload: {
        status: terminalGraph.status,
        nodeCount: terminalGraph.nodes.length,
        edgeCount: terminalGraph.edges.length,
        queuedBranches: terminalGraph.frontier.filter(
          (entry) => entry.status === "queued" || entry.status === "mutated",
        ).length,
      },
      usage: { unavailableReason: "scripted_frontier_kernel" },
    });
  }
}

function admit(engine: InvestigationEngine, draft: EvidenceDraft): string {
  const result = engine.admitEvidence(draft);
  if (!result.admitted || !result.evidence) {
    throw new Error(`example evidence was rejected: ${result.reason}`);
  }
  return result.evidence.id;
}

function finish(id: string, engine: InvestigationEngine, search: ReplaySearchGraph, detail: string): GeneratedExample {
  advance(
    engine,
    "report",
    "Compiled only referentially valid findings and explicit limitations into the versioned report.",
  );
  search.finalizeStructure();
  const stop = evaluateStop(engine.snapshot());
  if (!stop.allowed || stop.reason !== "goal_satisfied") {
    const state = engine.snapshot();
    throw new Error(
      `example ${id} is not legally complete: ${stop.detail}; identity=${JSON.stringify(resolveIdentity(state.candidates))}; coverage=${JSON.stringify(summarizeCoverage(state, requestedCategoriesForInput(state.input)))}`,
    );
  }
  engine.stopDecision({ ...stop, detail });
  engine.assertIntegrity();
  const report = buildInvestigationReport(engine.snapshot(), engine.clock);
  engine.trace.record("result.terminal", {
    phase: "terminal",
    payload: {
      status: report.status,
      stopReason: report.stop.reason,
      report: cloneJson(report) as unknown as JsonObject,
    },
    usage: { unavailableReason: "scripted_replay_no_provider" },
  });
  engine.trace.assertBalanced();
  return {
    id,
    report,
    trace: engine.trace.snapshot() as unknown as JsonObject[],
    captureActions: search.captureActions,
  };
}

async function buildLinus(): Promise<GeneratedExample> {
  const clock = createSequenceClock(capturedAt, 7);
  const ids = createDeterministicIdFactory("linus_replay");
  const engine = new InvestigationEngine(
    input(linusInputJson),
    { clock, ids },
    {
      runId: "replay-linus-codegraph-v2",
    },
  );
  const search = new ReplaySearchGraph(engine, [
    "fetch_public_source",
    "github_email_codegraph",
    "keybase_identity_proofs",
    "search_web",
  ]);

  advance(
    engine,
    "classify",
    "The query contains one exact user-supplied email and is limited to public professional correlation.",
  );
  advance(
    engine,
    "plan",
    "Run the bounded exact-email codegraph, anchor identity on the Linux Foundation leadership page, and corroborate with the kernel contribution documentation while inspecting the strongest commit.",
  );
  search.seed();
  advance(
    engine,
    "discover",
    "Fetch direct sources before admitting any claim; treat provider/search summaries as discovery-only.",
  );

  const candidate = engine.addCandidate({
    displayName: "Linus Torvalds",
    signals: [
      {
        kind: "email",
        value: "torvalds@linux-foundation.org",
        normalizedValue: "torvalds@linux-foundation.org",
        strength: "strong",
        assurance: "self_asserted",
      },
    ],
  }).candidate;

  const githubSearchEntry = search.selectNext();
  if (githubSearchEntry.sourceLaneId !== "t0.explicit_email_codegraph") {
    throw new Error("email replay did not select the exact-email lane first");
  }
  search.recordCapturedTool(
    githubSearchEntry,
    "req-github-search",
    "github_email_codegraph",
    "GET https://api.github.com/search/commits?q=repo%3Atorvalds%2Flinux+author-email%3Atorvalds%40linux-foundation.org+is%3Apublic&sort=committer-date&order=desc&per_page=3 accept:application/vnd.github+json",
    {
      networkRequests: 1,
      search: true,
      payload: {
        returnedCommits: 3,
        totalCountReported: 29714,
        incompleteResults: false,
        strongestCommitSha: VERIFIED_GITHUB_STRONGEST_SHA,
        strongestCommitSignature: "unsigned",
      },
    },
  );
  search.outcome(githubSearchEntry, "verified");

  const commitEntry = search.enqueue("t2.structured_professional", {
    parent: githubSearchEntry,
    candidate,
    intent: "Inspect the immutable strongest GitHub commit selected by the exact-email code graph.",
    queryHint: `torvalds/linux commit ${VERIFIED_GITHUB_STRONGEST_SHA}`,
  });
  const keybaseEntry = search.enqueue("t2.structured_professional", {
    parent: githubSearchEntry,
    candidate,
    intent: "Check whether a public Keybase proof independently verifies the GitHub account.",
    queryHint: "keybase github torvalds proof",
  });

  const foundationEntry = search.selectNext();
  if (foundationEntry.sourceLaneId !== "t1.first_party") {
    throw new Error("email replay skipped first-party sources");
  }
  search.recordCapturedTool(
    foundationEntry,
    "req-linux-foundation",
    "fetch_public_source",
    "GET https://www.linuxfoundation.org/about/leadership accept:text/html",
  );
  search.outcome(foundationEntry, "verified");
  // The kernel contribution document is a public repository record, so it is a
  // candidate-bound tier-2 structured-professional source, not a first-party
  // official page.
  const linuxDocEntry = search.enqueue("t2.structured_professional", {
    parent: githubSearchEntry,
    candidate,
    intent: "Corroborate the exact-email identity with the kernel project's own contribution documentation.",
    queryHint: "torvalds/linux submitting-patches documentation Linus Torvalds",
  });

  const pending = new Map([
    [linuxDocEntry.id, "linuxdoc"],
    [commitEntry.id, "commit"],
    [keybaseEntry.id, "keybase"],
  ] as const);
  while (pending.size > 0) {
    const entry = search.selectNext();
    const branch = pending.get(entry.id);
    if (!branch) throw new Error(`email replay selected an unexpected branch ${entry.sourceLaneId}`);
    pending.delete(entry.id);
    if (branch === "linuxdoc") {
      search.recordCapturedTool(
        entry,
        "req-linux-doc",
        "fetch_public_source",
        "GET https://github.com/torvalds/linux/blob/master/Documentation/process/submitting-patches.rst accept:text/html",
      );
      search.outcome(entry, "verified");
    } else if (branch === "commit") {
      search.recordCapturedTool(
        entry,
        "req-github-commit",
        "fetch_public_source",
        `GET https://api.github.com/repos/torvalds/linux/commits/${VERIFIED_GITHUB_STRONGEST_SHA} accept:application/vnd.github+json`,
      );
      search.outcome(entry, "verified");
    } else {
      search.recordCapturedTool(
        entry,
        "req-keybase",
        "keybase_identity_proofs",
        "GET https://keybase.io/_/api/1.0/user/lookup.json?github=torvalds&fields=basics%2Cproofs_summary%2Cremote_key_proofs accept:application/json",
        {
          status: "partial",
          payload: {
            providerStatus: "OK",
            linkedUsernameObserved: false,
            verifiedGithubProofs: 0,
            admittedIdentityEvidence: 0,
          },
        },
      );
      search.outcome(entry, "exhausted");
    }
  }

  advance(
    engine,
    "separate_candidates",
    "The exact email, public Linux documentation, and linked GitHub login form one candidate; Git metadata remains a spoofable signal, not a merge authority.",
  );
  advance(
    engine,
    "corroborate",
    "Admit minimal direct-source records and require the Linux Foundation source before allowing high-confidence identity findings.",
  );

  const linuxDoc = admit(
    engine,
    verifiedDirectEvidence("req-linux-doc", 0, linuxDocEntry.actionId, {
      candidateId: candidate.id,
      sourceUrl: "https://github.com/torvalds/linux/blob/master/Documentation/process/submitting-patches.rst",
      queryUrl: null,
      sourceType: "public_document",
      title: "Submitting patches: the essential guide",
      publisher: "Linux kernel project",
      sourceFamily: "github.com",
      observedAt: capturedAt,
      httpStatus: 200,
      temporalStatus: "current",
      reliability: 1,
      spoofable: false,
    }),
  );
  const foundation = admit(
    engine,
    verifiedDirectEvidence("req-linux-foundation", 0, foundationEntry.actionId, {
      candidateId: candidate.id,
      sourceUrl: "https://www.linuxfoundation.org/about/leadership",
      queryUrl: null,
      sourceType: "official_profile",
      title: "Linux Foundation leadership",
      publisher: "Linux Foundation",
      sourceFamily: "linuxfoundation.org",
      observedAt: capturedAt,
      httpStatus: 200,
      temporalStatus: "current",
      reliability: 1,
      spoofable: false,
    }),
  );
  const commit = admit(
    engine,
    verifiedApiEvidence("req-github-commit", commitEntry.actionId, {
      candidateId: candidate.id,
      sourceUrl: `https://github.com/torvalds/linux/commit/${VERIFIED_GITHUB_STRONGEST_SHA}`,
      queryUrl: `https://api.github.com/repos/torvalds/linux/commits/${VERIFIED_GITHUB_STRONGEST_SHA}`,
      sourceType: "code_commit",
      title: "Public commit metadata in torvalds/linux",
      publisher: "GitHub",
      sourceFamily: "github.com",
      publishedAt: "2026-08-18T21:13:43.000Z",
      observedAt: capturedAt,
      httpStatus: 200,
      temporalStatus: "current",
      reliability: 1,
      spoofable: true,
      attributes: {
        sha: VERIFIED_GITHUB_STRONGEST_SHA,
        repository: "torvalds/linux",
        login: "torvalds",
        signature: "unsigned",
      },
    }),
  );
  search.linkEvidence(linuxDocEntry, linuxDoc);
  search.linkEvidence(foundationEntry, foundation);
  search.linkEvidence(commitEntry, commit);

  engine.addCandidateSignals(candidate.id, [
    {
      kind: "name",
      value: "Linus Torvalds",
      normalizedValue: "linus torvalds",
      strength: "strong",
      assurance: "verified",
      sourceEvidenceId: foundation,
      sourceFamily: "linuxfoundation.org",
    },
    {
      kind: "profile_url",
      value: "https://www.linuxfoundation.org/about/leadership",
      normalizedValue: "https://www.linuxfoundation.org/about/leadership",
      strength: "strong",
      assurance: "corroborated",
      sourceEvidenceId: foundation,
      sourceFamily: "linuxfoundation.org",
    },
    {
      // The kernel documentation cross-links the exact user-supplied email to
      // the named maintainer; the email is the identifier grounded in the
      // fetched excerpt, so the cross-profile signal cites it directly.
      kind: "cross_profile_link",
      value: "torvalds@linux-foundation.org",
      normalizedValue: "torvalds@linux-foundation.org",
      strength: "strong",
      assurance: "corroborated",
      sourceEvidenceId: linuxDoc,
      sourceFamily: "github.com",
    },
    {
      kind: "social_handle",
      value: "torvalds",
      normalizedValue: "torvalds",
      strength: "medium",
      assurance: "spoofable",
      sourceEvidenceId: commit,
      sourceFamily: "github.com",
    },
  ]);

  advance(
    engine,
    "calibrate",
    "The non-Git Linux Foundation anchor lifts the resolved candidate beyond the spoofable-only cap; the Git-specific finding retains its caveat.",
  );
  engine.addFinding({
    candidateId: candidate.id,
    title: "Exact email resolves to Linus Torvalds in the bounded public record",
    description:
      "Two independent source families identify Linus Torvalds: the Linux guide publishes the exact supplied email, and the Linux Foundation names him as a Fellow.",
    category: "identity",
    evidenceIds: [linuxDoc, foundation],
    counterEvidenceIds: [],
  });
  engine.addFinding({
    candidateId: candidate.id,
    title: "Public GitHub codegraph links the email to @torvalds",
    description:
      "GitHub's commit API returned an immutable commit in torvalds/linux, linked it to @torvalds with an exact author-email match, and reported it unsigned.",
    category: "online_presence",
    evidenceIds: [commit],
    counterEvidenceIds: [],
    caveats: [
      "Git author metadata can be spoofed.",
      "The inspected strongest commit was unsigned.",
      "The bounded search describes indexed public default branches, not all Git activity.",
    ],
  });
  const boundedMutation = await search.proposeMutation(linuxDocEntry);
  if (!boundedMutation) throw new Error("email replay expected one accepted bounded mutation");
  // The accepted branch stays visible and deferred: there is no verified
  // capture for a lane-allowed action, so replay generation must not invent a
  // local tool execution or synthetic evidence to close it.
  return finish(
    "linus-codegraph",
    engine,
    search,
    "Resolved the professional identity with auditable findings, an independent non-Git anchor, and explicit Git metadata limitations.",
  );
}

async function buildChris(): Promise<GeneratedExample> {
  const clock = createSequenceClock(capturedAt, 7);
  const ids = createDeterministicIdFactory("chris_replay");
  const engine = new InvestigationEngine(
    input(chrisInputJson),
    { clock, ids },
    {
      runId: "replay-chris-anderson-ted-v2",
    },
  );
  const search = new ReplaySearchGraph(engine, ["fetch_public_source", "wayback_profile_history"]);

  advance(engine, "classify", "The query provides a person's name plus TED as an organization constraint.");
  advance(
    engine,
    "plan",
    "Fetch the TED-constrained profile and actively search for same-name professional candidates before selection.",
  );
  search.seed();
  advance(
    engine,
    "discover",
    "Direct profiles reveal two public professionals named Chris Anderson and require explicit separation.",
  );

  const selected = engine.addCandidate({ displayName: "Chris Anderson" }).candidate;
  const decoy = engine.addCandidate({ displayName: "Chris Anderson" }).candidate;

  const tedSelectedEntry = search.selectNext();
  if (tedSelectedEntry.sourceLaneId !== "t1.first_party") {
    throw new Error("same-name replay skipped the TED first-party lane");
  }
  search.recordCapturedTool(
    tedSelectedEntry,
    "req-ted-selected",
    "fetch_public_source",
    "GET https://www.ted.com/speakers/chris_anderson_ted accept:text/html",
  );
  search.outcome(tedSelectedEntry, "verified");
  const tedDecoyEntry = search.enqueue("t3.institutional", {
    parent: tedSelectedEntry,
    candidate: decoy,
    intent: "Inspect the separate TED profile that explicitly disambiguates the same-name speaker.",
    queryHint: "site:ted.com Chris Anderson WIRED same name",
  });
  const wiredDecoyEntry = search.enqueue("t4.reputable_media", {
    parent: tedSelectedEntry,
    candidate: decoy,
    intent: "Corroborate the former WIRED editor and 3DR executive as a separate professional.",
    queryHint: "WIRED Chris Anderson 3D Robotics Airware",
  });
  for (const expected of [tedDecoyEntry, wiredDecoyEntry]) {
    const entry = search.selectNext();
    if (entry.id !== expected.id) {
      throw new Error(`same-name replay violated source-tier ordering at ${entry.sourceLaneId}`);
    }
    if (entry.id === tedDecoyEntry.id) {
      search.recordCapturedTool(
        entry,
        "req-ted-decoy",
        "fetch_public_source",
        "GET https://www.ted.com/speakers/chris_anderson_wired accept:text/html",
      );
    } else {
      search.recordCapturedTool(
        entry,
        "req-wired-decoy",
        "fetch_public_source",
        "GET https://www.wired.com/story/airware-drones/ accept:text/html",
      );
    }
    search.outcome(entry, "verified");
  }

  advance(
    engine,
    "separate_candidates",
    "Name equality is weak evidence: the TED leader and the former WIRED editor/3DR executive remain separate candidates with separate ledgers.",
  );
  advance(
    engine,
    "corroborate",
    "Admit the direct TED and WIRED records to their own candidate IDs and preserve the organization conflict.",
  );

  const tedProfile = admit(
    engine,
    verifiedDirectEvidence("req-ted-selected", 0, tedSelectedEntry.actionId, {
      candidateId: selected.id,
      sourceUrl: "https://www.ted.com/speakers/chris_anderson_ted",
      queryUrl: null,
      sourceType: "official_profile",
      title: "Chris Anderson — TED speaker profile",
      publisher: "TED",
      sourceFamily: "ted.com",
      observedAt: capturedAt,
      httpStatus: 200,
      temporalStatus: "current",
      reliability: 1,
      spoofable: false,
      attributes: { organization: "TED", role: "Chairman, TED" },
    }),
  );
  const tedEmployment = admit(
    engine,
    verifiedDirectEvidence("req-ted-selected", 1, tedSelectedEntry.actionId, {
      candidateId: selected.id,
      sourceUrl: "https://www.ted.com/speakers/chris_anderson_ted",
      queryUrl: null,
      sourceType: "official_profile",
      title: "Chris Anderson — TED leadership",
      publisher: "TED",
      sourceFamily: "ted.com",
      observedAt: capturedAt,
      httpStatus: 200,
      temporalStatus: "current",
      reliability: 1,
      spoofable: false,
    }),
  );
  const tedDecoy = admit(
    engine,
    verifiedDirectEvidence("req-ted-decoy", 0, tedDecoyEntry.actionId, {
      candidateId: decoy.id,
      // The disambiguation explicitly denies this speaker is the TED curator, so
      // it is admitted as a contradiction that grounds the decoy's conflict. It is
      // a conference-published disambiguation note (tier-3 institutional document),
      // not a first-party profile.
      disposition: "contradicts",
      sourceUrl: "https://www.ted.com/speakers/chris_anderson_wired",
      queryUrl: null,
      sourceType: "public_document",
      title: "Chris Anderson — separate TED speaker profile",
      publisher: "TED",
      sourceFamily: "ted.com",
      observedAt: capturedAt,
      httpStatus: 200,
      temporalStatus: "current",
      reliability: 1,
      spoofable: false,
    }),
  );
  const wiredDecoy = admit(
    engine,
    verifiedDirectEvidence("req-wired-decoy", 0, wiredDecoyEntry.actionId, {
      candidateId: decoy.id,
      sourceUrl: "https://www.wired.com/story/airware-drones/",
      queryUrl: null,
      sourceType: "news",
      title: "Airware drones",
      publisher: "WIRED",
      sourceFamily: "wired.com",
      observedAt: capturedAt,
      httpStatus: 200,
      temporalStatus: "historical",
      reliability: 0.9,
      spoofable: false,
    }),
  );
  search.linkEvidence(tedSelectedEntry, tedProfile);
  search.linkEvidence(tedSelectedEntry, tedEmployment);
  search.linkEvidence(tedDecoyEntry, tedDecoy);
  search.linkEvidence(wiredDecoyEntry, wiredDecoy);

  engine.addCandidateSignals(selected.id, [
    {
      kind: "name",
      value: "Chris Anderson",
      normalizedValue: "chris anderson",
      strength: "strong",
      assurance: "verified",
      sourceEvidenceId: tedProfile,
      sourceFamily: "ted.com",
    },
    {
      kind: "organization",
      value: "TED",
      normalizedValue: "ted",
      strength: "strong",
      assurance: "verified",
      sourceEvidenceId: tedProfile,
      sourceFamily: "ted.com",
    },
    {
      kind: "role",
      value: "Chairman, TED",
      normalizedValue: "chairman ted",
      strength: "strong",
      assurance: "verified",
      sourceEvidenceId: tedProfile,
      sourceFamily: "ted.com",
    },
    {
      kind: "profile_url",
      value: "https://www.ted.com/speakers/chris_anderson_ted",
      normalizedValue: "https://www.ted.com/speakers/chris_anderson_ted",
      strength: "strong",
      assurance: "verified",
      sourceEvidenceId: tedProfile,
      sourceFamily: "ted.com",
    },
    {
      kind: "cross_profile_link",
      value: "Chris Anderson Chairman, TED",
      normalizedValue: "chris anderson chairman ted",
      strength: "strong",
      assurance: "corroborated",
      sourceEvidenceId: tedProfile,
      sourceFamily: "ted.com",
    },
    {
      kind: "bio_phrase",
      value: "became the curator of the TED Conference in 2002",
      normalizedValue: "became the curator of the ted conference in 2002",
      strength: "weak",
      assurance: "verified",
      sourceEvidenceId: tedEmployment,
      sourceFamily: "ted.com",
    },
  ]);
  engine.addCandidateSignals(decoy.id, [
    {
      // The supporting identity of the same-name decoy is grounded by the WIRED
      // record, not the TED page that contradicts the curator match.
      kind: "name",
      value: "Chris Anderson",
      normalizedValue: "chris anderson",
      strength: "strong",
      assurance: "verified",
      sourceEvidenceId: wiredDecoy,
      sourceFamily: "wired.com",
    },
    {
      kind: "organization",
      value: "WIRED",
      normalizedValue: "wired",
      strength: "strong",
      assurance: "corroborated",
      sourceEvidenceId: wiredDecoy,
      sourceFamily: "wired.com",
    },
    {
      kind: "conflict",
      value: "confused with the curator of TED",
      normalizedValue: "confused with the curator of ted",
      strength: "strong",
      assurance: "verified",
      sourceEvidenceId: tedDecoy,
      sourceFamily: "ted.com",
    },
  ]);

  advance(
    engine,
    "calibrate",
    "The TED-constrained profile supplies a unique strong anchor and clear runner-up margin; decoy evidence is quarantined rather than cited across candidates.",
  );
  engine.addFinding({
    candidateId: selected.id,
    title: "The TED-constrained identity is Chris Anderson, Chairman, TED",
    description:
      "TED's direct profile exactly names Chris Anderson as Chairman, TED and supplies a candidate-specific official profile URL.",
    category: "identity",
    evidenceIds: [tedProfile],
    counterEvidenceIds: [],
    caveats: ["This finding relies on a genuinely unique official profile anchor rather than two source families."],
  });
  engine.addFinding({
    candidateId: selected.id,
    title: "TED records his conference leadership from 2002",
    description:
      "The official profile says Anderson became curator of the TED Conference in 2002 and currently labels him Chairman, TED.",
    category: "employment",
    evidenceIds: [tedEmployment],
    counterEvidenceIds: [],
  });
  await search.proposeMutation(tedSelectedEntry);
  search.enqueue("t5.candidate_wayback", {
    parent: tedSelectedEntry,
    candidate: selected,
    intent: "Defer candidate-linked archive history because current official sources already satisfy the goal.",
    queryHint: "https://www.ted.com/speakers/chris_anderson_ted",
  });
  search.enqueue("t6.general_discovery", {
    intent: "Defer broader discovery after the same-name candidates have been separated.",
    queryHint: "Chris Anderson TED same-name professional candidates",
  });
  search.selectDeferredBranch();
  return finish(
    "chris-anderson-ted",
    engine,
    search,
    "Resolved the TED-constrained candidate with a unique official anchor and preserved the same-name decoy as a separate rejected candidate.",
  );
}

async function buildPython(): Promise<GeneratedExample> {
  const clock = createSequenceClock(capturedAt, 7);
  const ids = createDeterministicIdFactory("python_replay");
  const engine = new InvestigationEngine(
    input(pythonInputJson),
    { clock, ids },
    {
      runId: "replay-python-creator-v2",
    },
  );
  const search = new ReplaySearchGraph(engine, ["fetch_public_source"]);

  advance(
    engine,
    "classify",
    "The query is a role-only public figure request: resolve the creator of Python without assuming a name.",
  );
  advance(
    engine,
    "plan",
    "Use the official Python site and the candidate's public biography as independent direct sources.",
  );
  search.seed();
  advance(engine, "discover", "Both direct sources name the same person and describe the same unique creator role.");

  const candidate = engine.addCandidate({ displayName: "Guido van Rossum" }).candidate;
  // The candidate's own biography site is an explicit personal/official page
  // (first-party); the python.org foreword essay is a published document handled
  // as a tier-3 institutional source.
  const publicBioEntry = search.selectNext();
  if (publicBioEntry.sourceLaneId !== "t1.first_party") {
    throw new Error("role replay skipped the official first-party lane");
  }
  search.recordCapturedTool(
    publicBioEntry,
    "req-guido-bio",
    "fetch_public_source",
    "GET https://gvanrossum.github.io/bio accept:text/html",
  );
  search.outcome(publicBioEntry, "verified");
  const pythonForewordEntry = search.enqueue("t3.institutional", {
    parent: publicBioEntry,
    candidate,
    intent: "Corroborate the personal biography against the official Python foreword essay.",
    queryHint: "Guido van Rossum creator Python foreword python.org",
  });
  const selectedForewordEntry = search.selectNext();
  if (selectedForewordEntry.id !== pythonForewordEntry.id) {
    throw new Error("role replay violated first-party to institutional ordering");
  }
  search.recordCapturedTool(
    pythonForewordEntry,
    "req-python-foreword",
    "fetch_public_source",
    "GET https://www.python.org/doc/essays/foreword/ accept:text/html",
  );
  search.outcome(pythonForewordEntry, "verified");

  advance(
    engine,
    "separate_candidates",
    "The role phrase remains a clue until two direct sources converge on the same named candidate and unique personal domain.",
  );
  advance(
    engine,
    "corroborate",
    "Admit the official ecosystem foreword and the candidate's public biography as two independent source families.",
  );

  const pythonForeword = admit(
    engine,
    verifiedDirectEvidence("req-python-foreword", 0, pythonForewordEntry.actionId, {
      candidateId: candidate.id,
      sourceUrl: "https://www.python.org/doc/essays/foreword/",
      queryUrl: null,
      sourceType: "public_document",
      title: "Foreword for Programming Python",
      publisher: "Python Software Foundation",
      sourceFamily: "python.org",
      observedAt: capturedAt,
      httpStatus: 200,
      temporalStatus: "historical",
      reliability: 1,
      spoofable: false,
    }),
  );
  const publicBio = admit(
    engine,
    verifiedDirectEvidence("req-guido-bio", 0, publicBioEntry.actionId, {
      candidateId: candidate.id,
      sourceUrl: "https://gvanrossum.github.io/bio",
      queryUrl: null,
      sourceType: "official_profile",
      title: "Guido van Rossum — brief bio",
      publisher: "Guido van Rossum",
      sourceFamily: "github.io",
      observedAt: capturedAt,
      httpStatus: 200,
      temporalStatus: "current",
      reliability: 1,
      spoofable: false,
    }),
  );
  search.linkEvidence(pythonForewordEntry, pythonForeword);
  search.linkEvidence(publicBioEntry, publicBio);

  engine.addCandidateSignals(candidate.id, [
    {
      kind: "name",
      value: "Guido van Rossum",
      normalizedValue: "guido van rossum",
      strength: "strong",
      assurance: "verified",
      sourceEvidenceId: publicBio,
      sourceFamily: "github.io",
    },
    {
      kind: "role",
      value: "Python's creator",
      normalizedValue: "python's creator",
      strength: "strong",
      assurance: "corroborated",
      sourceEvidenceId: pythonForeword,
      sourceFamily: "python.org",
    },
    {
      kind: "cross_profile_link",
      value: "Python's creator",
      normalizedValue: "python's creator link",
      strength: "strong",
      assurance: "corroborated",
      sourceEvidenceId: pythonForeword,
      sourceFamily: "python.org",
    },
    {
      kind: "profile_url",
      value: "https://gvanrossum.github.io/bio",
      normalizedValue: "https://gvanrossum.github.io/bio",
      strength: "strong",
      assurance: "verified",
      sourceEvidenceId: publicBio,
      sourceFamily: "github.io",
    },
    {
      kind: "personal_domain",
      value: "https://gvanrossum.github.io",
      normalizedValue: "gvanrossum.github.io",
      strength: "strong",
      assurance: "corroborated",
      sourceEvidenceId: publicBio,
      sourceFamily: "github.io",
    },
  ]);

  advance(
    engine,
    "calibrate",
    "Two independent direct source families support the same unique creator role with no hard conflict.",
  );
  engine.addFinding({
    candidateId: candidate.id,
    title: "The creator of Python resolves to Guido van Rossum",
    description:
      "The official Python site and van Rossum's public biography independently identify him as Python's creator.",
    category: "identity",
    evidenceIds: [publicBio],
    counterEvidenceIds: [],
  });
  engine.addFinding({
    candidateId: candidate.id,
    title: "Van Rossum created the Python programming language",
    description:
      "His public biography states that he created Python in 1990, while the official Python foreword independently describes his creator role.",
    category: "project",
    evidenceIds: [pythonForeword],
    counterEvidenceIds: [],
  });
  await search.proposeMutation(publicBioEntry);
  search.enqueue("t3.institutional", {
    parent: publicBioEntry,
    candidate,
    intent: "Queue institutional conference and publisher corroboration as a bounded next source class.",
    queryHint: "Guido van Rossum Python creator conference biography",
  });
  search.enqueue("t6.general_discovery", {
    intent: "Queue broad discovery only after the role and identity are directly resolved.",
    queryHint: "the creator of Python",
  });
  search.selectDeferredBranch();
  return finish(
    "python-creator",
    engine,
    search,
    "Resolved the role-only query with two independent direct source families and no competing candidate above the ambiguity threshold.",
  );
}

async function writeExample(example: GeneratedExample): Promise<void> {
  const directory = resolve(repositoryRoot, "examples", example.id);
  const cassetteTemplates: Record<string, JsonObject> = {
    "linus-codegraph": linusCassetteJson as unknown as JsonObject,
    "chris-anderson-ted": chrisCassetteJson as unknown as JsonObject,
    "python-creator": pythonCassetteJson as unknown as JsonObject,
  };
  const manifestTemplates: Record<string, JsonObject> = {
    "linus-codegraph": linusManifestJson as unknown as JsonObject,
    "chris-anderson-ted": chrisManifestJson as unknown as JsonObject,
    "python-creator": pythonManifestJson as unknown as JsonObject,
  };
  const descriptions: Record<string, string> = {
    "linus-codegraph":
      "A scripted reconstruction from source-verified public captures that connects an exact user-supplied email to Linux documentation and bounded GitHub commit metadata while preserving the spoofable-metadata confidence cap.",
    "chris-anderson-ted":
      "A scripted reconstruction from source-verified public captures that selects the TED leader and explicitly quarantines the former WIRED editor and 3DR executive as a different Chris Anderson.",
    "python-creator":
      "A scripted reconstruction from source-verified public captures that resolves a role description to Guido van Rossum using the official Python site and his public biography.",
  };
  const actionCaptureIds = Object.fromEntries(
    Object.entries(example.captureActions).map(([captureId, actionId]) => [actionId, captureId]),
  ) as Record<string, VerifiedRequestId>;
  assertVerifiedEvidenceContract(example.report.evidence, actionCaptureIds);
  const cassette = cloneJson(cassetteTemplates[example.id]);
  cassette.schemaVersion = SCHEMA_VERSION;
  cassette.cassetteVersion = 2;
  for (const request of cassette.requests as JsonObject[]) {
    const captureId = request.captureId ?? request.id;
    if (typeof captureId !== "string" || !(captureId in example.captureActions)) {
      throw new Error(`example ${example.id} has no action for capture ${String(captureId)}`);
    }
    const actionId = example.captureActions[captureId as VerifiedRequestId];
    if (!actionId) throw new Error(`capture ${captureId} has an empty action binding`);
    request.captureId = captureId;
    request.id = actionId;
    request.actionId = actionId;
    request.frontierEntryId = actionId;
  }
  applyVerifiedCaptureMetadata(cassette);
  for (const request of cassette.requests as JsonObject[]) {
    const response = request.response as JsonObject;
    response.evidenceBindings = example.report.evidence
      .filter((evidence) => evidence.toolCallId === request.id)
      .map((evidence) => ({
        evidenceId: evidence.id,
        candidateId: evidence.candidateId,
        sourceUrl: evidence.sourceUrl,
        normalizedClaim: evidence.normalizedClaim,
        excerpt: evidence.excerpt,
        canonicalSubset: evidence.canonicalSubset,
      }));
  }
  const manifest = cloneJson(manifestTemplates[example.id]);
  manifest.schemaVersion = SCHEMA_VERSION;
  manifest.description = descriptions[example.id];
  manifest.capturedAt = capturedAt;
  manifest.captureMode = "source_verified_scripted_reconstruction";
  manifest.decisionProvenance = "scripted_local_policy";
  manifest.provider = null;
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(resolve(directory, "cassette.json"), `${JSON.stringify(cassette, null, 2)}\n`, "utf8"),
    writeFile(resolve(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    writeFile(resolve(directory, "output.json"), `${JSON.stringify(example.report, null, 2)}\n`, "utf8"),
    writeFile(resolve(directory, "trace.json"), `${JSON.stringify(example.trace, null, 2)}\n`, "utf8"),
  ]);
}

const examples = await Promise.all([buildLinus(), buildChris(), buildPython()]);
await Promise.all(examples.map(writeExample));
process.stdout.write(`Generated ${examples.length} deterministic examples.\n`);

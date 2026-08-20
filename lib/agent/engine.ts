import { BudgetLedger, EMPTY_BUDGET_USAGE, resolveBudgetLimits } from "../domain/budget";
import {
  addCandidateSignals as appendCandidateSignals,
  canMergeCandidates,
  createCandidate,
  identitySignalGroundedByEvidence,
  mergeCandidates,
} from "../domain/candidates";
import { admitEvidence as evaluateEvidenceAdmission } from "../domain/evidence";
import { createFinding, validateReferentialIntegrity } from "../domain/integrity";
import { buildInvestigationReport } from "../domain/report";
import type { Clock, IdFactory } from "../domain/runtime";
import {
  cloneJson,
  labelOccursAsTokenPhrase,
  normalizeComparable,
  normalizeLabelTokens,
  normalizeOrganizationIdentity,
} from "../domain/runtime";
import { classifySafety } from "../domain/safety";
import { containsRestrictedPublicContent } from "../domain/content-policy";
import { assertPhaseTransition } from "../domain/state-machine";
import { evaluateStop, terminalStatusForStop, type StopEvaluationOptions } from "../domain/stopping";
import { parseTarget } from "../domain/target";
import {
  SCHEMA_VERSION,
  type BudgetLimits,
  type Candidate,
  type CandidateDraft,
  type EvidenceAdmission,
  type EvidenceDraft,
  type Finding,
  type FindingDraft,
  type IdentitySignal,
  type InvestigationInput,
  type InvestigationReport,
  type InvestigationState,
  type JsonObject,
  type ResearchPhase,
  type StopReason,
  type TerminalStatus,
  type TokenUsage,
} from "../domain/types";
import { parseInvestigationInput } from "../domain/validation";
import { TraceRecorder } from "./trace";
import {
  assertSearchGraph,
  assertSearchGraphEvolution,
  emptySearchGraph,
  markSearchGraphTerminal,
} from "../search/frontier";

export interface InvestigationEngineOptions {
  budget?: Partial<BudgetLimits>;
  runId?: string;
  openQuestions?: string[];
}

export interface CandidateMutation {
  candidate: Candidate;
  created: boolean;
  mergedInto?: string;
}

function evidenceIdentityAttribute(
  evidence: InvestigationState["evidence"][number],
  key: "extractedSubjectName" | "extractedOrganization",
): string | null {
  const value = evidence.attributes[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function evidenceCarriesIdentityLabels(
  evidence: InvestigationState["evidence"][number],
  subject: string,
  organization: string,
): boolean {
  const subjectLabel =
    typeof evidence.attributes.extractedSubjectLabel === "string" ? evidence.attributes.extractedSubjectLabel : subject;
  const organizationLabel =
    typeof evidence.attributes.extractedOrganizationLabel === "string"
      ? evidence.attributes.extractedOrganizationLabel
      : organization;
  return Boolean(
    evidence.excerpt &&
    labelOccursAsTokenPhrase(evidence.excerpt, subjectLabel) &&
    labelOccursAsTokenPhrase(evidence.excerpt, organizationLabel),
  );
}

function withoutUnverifiedSourceProvenance(signal: IdentitySignal): IdentitySignal {
  const { sourceEvidenceId: _sourceEvidenceId, sourceFamily: _sourceFamily, ...provisional } = signal;
  return provisional;
}

/**
 * Deterministic policy kernel. LLMs and tools can propose mutations, but only
 * this class may admit them into investigation state.
 */
export class InvestigationEngine {
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly trace: TraceRecorder;
  readonly #budget: BudgetLedger;
  #state: InvestigationState;

  constructor(
    inputValue: InvestigationInput | string,
    dependencies: { clock: Clock; ids: IdFactory },
    options: InvestigationEngineOptions = {},
  ) {
    if (!dependencies.clock || !dependencies.ids) {
      throw new TypeError("InvestigationEngine requires injected clock and ids dependencies");
    }
    this.clock = dependencies.clock;
    this.ids = dependencies.ids;
    const input = parseInvestigationInput(inputValue);
    const runId = options.runId ?? this.ids.next("run");
    const startedAt = this.clock.now();
    const limits = resolveBudgetLimits(input.requestedDepth ?? "standard", options.budget);
    const target = parseTarget(input);
    this.#budget = new BudgetLedger(limits, this.clock.monotonicMs());
    this.trace = new TraceRecorder(runId, this.clock, this.ids, {
      allowedEmails: new Set(
        target.identifiers
          .filter((identifier) => identifier.kind === "email" && identifier.provenance === "user_input")
          .map((identifier) => identifier.normalizedValue),
      ),
    });
    this.#state = {
      schemaVersion: SCHEMA_VERSION,
      runId,
      revision: 0,
      status: "running",
      phase: "intake",
      input,
      target,
      safety: classifySafety(input, {
        currentYear: new Date(startedAt).getUTCFullYear(),
      }),
      candidates: [],
      evidence: [],
      findings: [],
      // The raw target is copied into graph state only after safety passes.
      searchGraph: emptySearchGraph(runId, "", startedAt),
      openQuestions: [...new Set(options.openQuestions ?? [])].sort(),
      evidenceTelemetry: {
        admitted: 0,
        rejected: 0,
        duplicate: 0,
        discoveryOnly: 0,
        supporting: 0,
        contradicting: 0,
      },
      budget: { limits, usage: { ...EMPTY_BUDGET_USAGE } },
      startedAt,
      updatedAt: startedAt,
    };
    this.trace.record("investigation.created", {
      phase: "intake",
      payload: {
        schemaVersion: SCHEMA_VERSION,
        targetKind: this.#state.target.kind,
        requestedDepth: input.requestedDepth ?? "standard",
      },
    });
  }

  get runId(): string {
    return this.#state.runId;
  }

  get phase(): ResearchPhase {
    return this.#state.phase;
  }

  get status(): InvestigationState["status"] {
    return this.#state.status;
  }

  #ensureRunning(): void {
    if (this.#state.status !== "running") {
      throw new Error(`investigation is terminal (${this.#state.status})`);
    }
  }

  #touch(timestamp = this.clock.now()): void {
    this.#state.revision += 1;
    this.#state.updatedAt = timestamp;
  }

  #syncBudget(): void {
    this.#state.budget.usage = this.#budget.snapshot(this.clock.monotonicMs());
  }

  #publicContentOptions(): {
    allowedEmails: ReadonlySet<string>;
    currentYear?: number;
  } {
    const currentYear = new Date(this.#state.startedAt).getUTCFullYear();
    return {
      allowedEmails: new Set(
        this.#state.target.identifiers
          .filter((identifier) => identifier.kind === "email" && identifier.provenance === "user_input")
          .map((identifier) => identifier.normalizedValue),
      ),
      ...(Number.isInteger(currentYear) ? { currentYear } : {}),
    };
  }

  snapshot(): InvestigationState {
    this.#syncBudget();
    return cloneJson(this.#state);
  }

  /**
   * Admits a complete JSON-safe orchestration snapshot after the frontier
   * kernel validates it. This does not grant LangGraph authority over any
   * candidate, evidence, confidence, budget, or stop state.
   */
  replaceSearchGraph(graph: InvestigationState["searchGraph"]): void {
    this.#ensureRunning();
    if (graph.runId !== this.#state.runId) {
      throw new Error(`search graph runId ${graph.runId} does not match ${this.#state.runId}`);
    }
    assertSearchGraph(graph);
    assertSearchGraphEvolution(this.#state.searchGraph, graph);
    this.#state.searchGraph = cloneJson(graph);
    this.#touch(graph.updatedAt);
  }

  transition(to: ResearchPhase, payload: JsonObject = {}): void {
    this.#ensureRunning();
    const from = this.#state.phase;
    assertPhaseTransition(from, to);
    this.#state.phase = to;
    this.#touch();
    this.trace.record("phase.transition", {
      phase: to,
      payload: { ...payload, from, to },
    });
  }

  addCandidate(draft: CandidateDraft): CandidateMutation {
    this.#ensureRunning();
    if (
      containsRestrictedPublicContent(draft.displayName, this.#publicContentOptions()) ||
      draft.signals?.some((signal) => containsRestrictedPublicContent(signal.value, this.#publicContentOptions()))
    ) {
      throw new TypeError("candidate contains restricted personal content");
    }
    if (draft.signals?.some((signal) => signal.kind === "cross_source_match")) {
      throw new TypeError("cross_source_match signals are derived only by the evidence kernel");
    }
    if (
      draft.signals?.some(
        (signal) =>
          signal.sourceEvidenceId ||
          signal.kind === "conflict" ||
          signal.assurance === "verified" ||
          signal.assurance === "corroborated",
      )
    ) {
      throw new TypeError("new candidate identity signals cannot claim unadmitted high-assurance evidence");
    }
    const candidateDraft: CandidateDraft = {
      ...draft,
      ...(draft.signals ? { signals: draft.signals.map(withoutUnverifiedSourceProvenance) } : {}),
    };
    const timestamp = this.clock.now();
    const proposed = createCandidate(candidateDraft, this.#state.target, this.ids.next("candidate"), timestamp);
    for (let index = 0; index < this.#state.candidates.length; index += 1) {
      const existing = this.#state.candidates[index];
      const decision = canMergeCandidates(existing, proposed);
      if (!decision.allowed) continue;
      const merged = mergeCandidates(existing, proposed, this.#state.target, timestamp);
      this.#state.candidates[index] = merged;
      this.#touch(timestamp);
      this.trace.record("candidate.merged", {
        phase: this.#state.phase,
        payload: {
          candidateId: merged.id,
          discardedCandidateId: proposed.id,
          matchedSignal: decision.matchedSignal ?? null,
        },
      });
      return { candidate: cloneJson(merged), created: false, mergedInto: merged.id };
    }

    this.#state.candidates.push(proposed);
    this.#state.candidates.sort((left, right) => left.id.localeCompare(right.id));
    this.#touch(timestamp);
    this.trace.record("candidate.created", {
      phase: this.#state.phase,
      payload: {
        candidateId: proposed.id,
        displayName: proposed.displayName,
        status: proposed.status,
        score: proposed.score.total,
      },
    });
    return { candidate: cloneJson(proposed), created: true };
  }

  #applyCandidateSignals(candidateId: string, signals: readonly IdentitySignal[]): Candidate {
    this.#ensureRunning();
    const index = this.#state.candidates.findIndex((candidate) => candidate.id === candidateId);
    if (index < 0) throw new Error(`unknown candidate ${candidateId}`);
    const timestamp = this.clock.now();
    const updated = appendCandidateSignals(this.#state.candidates[index], signals, this.#state.target, timestamp);
    this.#state.candidates[index] = updated;
    this.#touch(timestamp);
    this.trace.record("candidate.scored", {
      phase: this.#state.phase,
      payload: {
        candidateId,
        status: updated.status,
        score: updated.score.total,
        signalCount: updated.signals.length,
        spoofableCapApplied: updated.score.cappedBecauseSpoofable,
      },
    });
    return cloneJson(updated);
  }

  addCandidateSignals(candidateId: string, signals: readonly IdentitySignal[]): Candidate {
    if (signals.some((signal) => containsRestrictedPublicContent(signal.value, this.#publicContentOptions()))) {
      throw new TypeError("candidate signal contains restricted personal content");
    }
    if (signals.some((signal) => signal.kind === "cross_source_match")) {
      throw new TypeError("cross_source_match signals are derived only by the evidence kernel");
    }
    const canonicalSignals = signals.map((signal) => {
      if (!signal.sourceEvidenceId) {
        if (signal.kind === "conflict" || signal.assurance === "verified" || signal.assurance === "corroborated") {
          throw new TypeError("high-assurance identity signals require admitted evidence");
        }
        return withoutUnverifiedSourceProvenance(signal);
      }
      const evidence = this.#state.evidence.find((record) => record.id === signal.sourceEvidenceId);
      if (!evidence || evidence.candidateId !== candidateId || !identitySignalGroundedByEvidence(signal, evidence)) {
        throw new TypeError("identity signal evidence provenance does not match its candidate, family, and value");
      }
      return signal;
    });
    return this.#applyCandidateSignals(candidateId, canonicalSignals);
  }

  #reconcileCrossSourceIdentity(record: InvestigationState["evidence"][number]): void {
    if (
      record.disposition !== "supports" ||
      record.verificationMethod !== "direct_fetch" ||
      record.attributes.untrustedContent !== true
    )
      return;
    const subject = evidenceIdentityAttribute(record, "extractedSubjectName");
    const organization = evidenceIdentityAttribute(record, "extractedOrganization");
    if (!subject || !organization) return;
    const candidate = this.#state.candidates.find((item) => item.id === record.candidateId);
    if (
      !candidate ||
      candidate.signals.some((signal) => signal.kind === "conflict" && signal.strength === "strong") ||
      normalizeLabelTokens(candidate.displayName) !== normalizeLabelTokens(subject) ||
      !evidenceCarriesIdentityLabels(record, subject, organization)
    )
      return;

    const organizationKey = normalizeOrganizationIdentity(organization);
    const prior = this.#state.evidence.find(
      (item) =>
        item.id !== record.id &&
        item.candidateId === record.candidateId &&
        item.disposition === "supports" &&
        item.verificationMethod === "direct_fetch" &&
        item.attributes.untrustedContent === true &&
        item.sourceFamily !== record.sourceFamily &&
        evidenceIdentityAttribute(item, "extractedSubjectName") === subject &&
        normalizeOrganizationIdentity(evidenceIdentityAttribute(item, "extractedOrganization") ?? "") ===
          organizationKey &&
        evidenceCarriesIdentityLabels(item, subject, organization),
    );
    if (!prior) return;

    const families = [prior.sourceFamily, record.sourceFamily].sort();
    const normalizedValue = `${normalizeComparable(subject)}|${organizationKey}|${families.join("|")}`;
    if (
      candidate.signals.some(
        (signal) => signal.kind === "cross_source_match" && signal.normalizedValue === normalizedValue,
      )
    )
      return;
    this.#applyCandidateSignals(record.candidateId, [
      {
        kind: "cross_source_match",
        value: `${subject} at ${organization} is independently quoted by ${families.join(" and ")}`,
        normalizedValue,
        strength: "strong",
        assurance: "corroborated",
        sourceFamily: `cross-source:${families.join("+")}`,
        sourceEvidenceId: record.id,
      },
    ]);
    this.trace.record("candidate.cross_source_reconciled", {
      phase: this.#state.phase,
      payload: {
        candidateId: record.candidateId,
        evidenceIds: [prior.id, record.id],
        sourceFamilies: families,
      },
    });
  }

  admitEvidence(draft: EvidenceDraft): EvidenceAdmission {
    this.#ensureRunning();
    const canAttempt = this.#budget.canAttemptEvidence(this.clock.monotonicMs());
    this.#budget.recordEvidenceAttempt(this.clock.monotonicMs());
    this.#syncBudget();
    const result: EvidenceAdmission = canAttempt
      ? evaluateEvidenceAdmission(draft, {
          candidateIds: new Set(this.#state.candidates.map((candidate) => candidate.id)),
          existing: this.#state.evidence,
          ids: this.ids,
          clock: this.clock,
          allowedEmails: new Set(
            this.#state.target.identifiers
              .filter((identifier) => identifier.kind === "email" && identifier.provenance === "user_input")
              .map((identifier) => identifier.normalizedValue),
          ),
        })
      : { admitted: false, reason: "budget_exhausted" };
    if (result.admitted && result.evidence) {
      const record = result.evidence;
      this.#state.evidence.push(record);
      const candidateIndex = this.#state.candidates.findIndex((candidate) => candidate.id === record.candidateId);
      const candidate = this.#state.candidates[candidateIndex];
      this.#state.candidates[candidateIndex] = {
        ...candidate,
        evidenceIds: [...new Set([...candidate.evidenceIds, record.id])].sort(),
        updatedAt: record.createdAt,
      };
      this.#state.evidenceTelemetry.admitted += 1;
      if (record.disposition === "discovery_only") this.#state.evidenceTelemetry.discoveryOnly += 1;
      if (record.disposition === "supports") this.#state.evidenceTelemetry.supporting += 1;
      if (record.disposition === "contradicts") this.#state.evidenceTelemetry.contradicting += 1;
      this.#touch(record.createdAt);
      this.#reconcileCrossSourceIdentity(record);
    } else if (result.reason === "duplicate_url" || result.reason === "duplicate_source_family") {
      this.#state.evidenceTelemetry.duplicate += 1;
      this.#touch();
    } else {
      this.#state.evidenceTelemetry.rejected += 1;
      this.#touch();
    }
    this.trace.record("evidence.admission", {
      phase: this.#state.phase,
      payload: {
        admitted: result.admitted,
        reason: result.reason,
        evidenceId: result.evidence?.id ?? null,
        duplicateOf: result.duplicateOf ?? null,
        candidateId: draft.candidateId ?? null,
        sourceType: draft.sourceType,
      },
    });
    return cloneJson(result);
  }

  addFinding(draft: FindingDraft): Finding {
    this.#ensureRunning();
    const finding = createFinding(
      draft,
      this.#state.candidates,
      this.#state.evidence,
      this.ids,
      this.clock,
      new Set(
        this.#state.target.identifiers
          .filter((identifier) => identifier.kind === "email" && identifier.provenance === "user_input")
          .map((identifier) => identifier.normalizedValue),
      ),
      this.#state.findings,
    );
    const duplicate = this.#state.findings.find(
      (current) =>
        current.candidateId === finding.candidateId &&
        current.category === finding.category &&
        normalizeComparable(current.title) === normalizeComparable(finding.title) &&
        normalizeComparable(current.description) === normalizeComparable(finding.description) &&
        current.evidenceIds.join("|") === finding.evidenceIds.join("|") &&
        current.counterEvidenceIds.join("|") === finding.counterEvidenceIds.join("|"),
    );
    if (duplicate) return cloneJson(duplicate);
    this.#state.findings.push(finding);
    this.#state.findings.sort((left, right) => left.id.localeCompare(right.id));
    this.#touch(finding.createdAt);
    this.trace.record("finding.created", {
      phase: this.#state.phase,
      payload: {
        findingId: finding.id,
        candidateId: finding.candidateId,
        category: finding.category,
        confidence: finding.confidence.score,
        sourceFamilies: finding.confidence.independentSourceFamilies,
      },
    });
    return cloneJson(finding);
  }

  setOpenQuestions(questions: readonly string[]): void {
    this.#ensureRunning();
    const contentOptions = this.#publicContentOptions();
    this.#state.openQuestions = [
      ...new Set(
        questions
          .map((question) => question.trim())
          .filter(Boolean)
          .map((question) =>
            containsRestrictedPublicContent(question, contentOptions)
              ? "A proposed open question was removed by the public-professional safety policy."
              : question,
          ),
      ),
    ].sort();
    this.#touch();
  }

  beginTurn(): void {
    this.#ensureRunning();
    this.#budget.beginTurn(this.#state.phase, this.clock.monotonicMs());
    this.#syncBudget();
    this.#touch();
  }

  recordTokens(tokens: Partial<TokenUsage>): void {
    this.#ensureRunning();
    this.#budget.recordTokens(tokens, this.clock.monotonicMs());
    this.#syncBudget();
    this.#touch();
  }

  recordLlmCall(): void {
    this.recordLlmCalls(1);
  }

  recordLlmCalls(count: number): void {
    this.#ensureRunning();
    this.#budget.recordLlmCalls(count, this.clock.monotonicMs());
    this.#syncBudget();
    this.#touch();
  }

  canAttemptLlm(): boolean {
    return this.#budget.canAttemptLlm(this.clock.monotonicMs());
  }

  recordToolCall(networkRequests = 0, search = false): void {
    this.#ensureRunning();
    this.#budget.recordToolCall(networkRequests, search, this.clock.monotonicMs());
    this.#syncBudget();
    this.#touch();
  }

  recordNetworkRequests(count: number): void {
    this.#ensureRunning();
    this.#budget.recordNetworkRequests(count, this.clock.monotonicMs());
    this.#syncBudget();
    this.#touch();
  }

  endTurn(madeProgress: boolean): void {
    this.#ensureRunning();
    this.#budget.endTurn(madeProgress, this.clock.monotonicMs());
    this.#syncBudget();
    this.#touch();
  }

  canStartTurn(): boolean {
    return this.#budget.canStartTurn(this.#state.phase, this.clock.monotonicMs());
  }

  canExecuteActions(count: number, searchCount = 0): boolean {
    return this.#budget.canExecuteActions(count, searchCount, this.clock.monotonicMs());
  }

  #commitStop(reason: StopReason, detail: string, status?: TerminalStatus): void {
    this.#ensureRunning();
    const canonicalStatus = terminalStatusForStop(reason, this.#state.candidates);
    const safeDetail = containsRestrictedPublicContent(detail, this.#publicContentOptions())
      ? "Terminal detail was removed by the public-professional safety policy."
      : detail;
    if (status !== undefined && status !== canonicalStatus) {
      throw new Error(`terminal status ${status} is invalid for ${reason}; expected ${canonicalStatus}`);
    }
    if (this.#state.phase !== "terminal") {
      assertPhaseTransition(this.#state.phase, "terminal");
    }
    this.#syncBudget();
    const timestamp = this.clock.now();
    this.#state.phase = "terminal";
    this.#state.status = canonicalStatus;
    // Terminal stops that bypass the runner's graph finalization (safety block,
    // configuration error, cancellation before any search state) still need the
    // canonical graph status to match the report status. An unseeded graph may
    // only become blocked/canceled/failed; exhausted/completed require a seeded
    // graph, which the runner has already finalized on those paths.
    const graphStatus =
      reason === "goal_satisfied"
        ? "completed"
        : reason === "unsafe_request"
          ? "blocked"
          : reason === "cancelled"
            ? "canceled"
            : reason === "fatal_error" || reason === "configuration_error"
              ? "failed"
              : "exhausted";
    const unseededTerminal = graphStatus === "blocked" || graphStatus === "canceled" || graphStatus === "failed";
    if (
      this.#state.searchGraph.status === "active" ||
      (this.#state.searchGraph.status === "empty" && unseededTerminal)
    ) {
      this.#state.searchGraph = markSearchGraphTerminal(this.#state.searchGraph, graphStatus, timestamp, {
        preserveQueued: reason === "goal_satisfied",
      });
    }
    this.#state.stop = { reason, detail: safeDetail, at: timestamp };
    this.#touch(timestamp);
    this.trace.record("investigation.terminal", {
      phase: "terminal",
      payload: {
        status: this.#state.status,
        reason,
        detail: safeDetail,
      },
    });
  }

  stopDecision(
    decision: import("../domain/types").StopDecision,
    options: StopEvaluationOptions = {},
    status?: TerminalStatus,
  ): void {
    if (!decision.allowed || !decision.reason) {
      throw new Error("cannot terminalize from a denied stop decision");
    }
    const verified = evaluateStop(this.#state, options);
    if (!verified.allowed || verified.reason !== decision.reason) {
      throw new Error(`stop decision ${decision.reason} is not valid for current state: ${verified.detail}`);
    }
    this.#commitStop(decision.reason, decision.detail, status);
  }

  stopExternal(
    reason: Extract<StopReason, "cancelled" | "configuration_error" | "fatal_error">,
    detail: string,
    status?: TerminalStatus,
  ): void {
    this.#commitStop(reason, detail, status);
  }

  /**
   * Compatibility entrypoint for state-verifiable stops. Externally witnessed
   * cancellation, configuration, fatal, and no-action terminals must use the
   * explicit checked APIs above.
   */
  stop(reason: StopReason, detail: string, status?: TerminalStatus): void {
    if (["cancelled", "configuration_error", "fatal_error", "no_legal_actions"].includes(reason)) {
      throw new Error(`${reason} requires stopExternal or stopDecision with an explicit witness`);
    }
    const options: StopEvaluationOptions = reason === "planner_requested" ? { plannerRequested: true } : {};
    const decision = evaluateStop(this.#state, options);
    if (!decision.allowed || decision.reason !== reason) {
      throw new Error(`stop reason ${reason} is not valid for current state: ${decision.detail}`);
    }
    this.#commitStop(reason, detail, status);
  }

  assertIntegrity(): void {
    assertSearchGraph(this.#state.searchGraph);
    const issues = validateReferentialIntegrity(this.#state);
    if (issues.length > 0) {
      throw new Error(
        `investigation integrity failed: ${issues.map((issue) => `${issue.code}@${issue.path}`).join(", ")}`,
      );
    }
  }

  report(): InvestigationReport {
    this.assertIntegrity();
    return buildInvestigationReport(this.snapshot(), this.clock);
  }
}

import { exhaustedBudgetDimensions } from "./budget";
import {
  candidateHasUniqueOfficialAnchor,
  requestedCategoriesForInput,
  resolveIdentity,
  summarizeCoverage,
} from "./report";
import type { Candidate, InvestigationState, StopDecision, StopReason, TerminalStatus } from "./types";

function hasUniqueOfficialAnchor(state: InvestigationState, selectedCandidateId: string | undefined): boolean {
  if (!selectedCandidateId) return false;
  const candidate = state.candidates.find((item) => item.id === selectedCandidateId);
  if (!candidate) return false;
  return candidateHasUniqueOfficialAnchor(candidate, state.evidence);
}

export interface StopEvaluationOptions {
  plannerRequested?: boolean;
  noLegalActions?: boolean;
  canceled?: boolean;
  minimumFindings?: number;
  minimumIndependentSourceFamilies?: number;
}

/** One canonical stop-reason to terminal-status mapping for engine and replay. */
export function terminalStatusForStop(reason: StopReason, candidates: readonly Candidate[]): TerminalStatus {
  if (reason === "unsafe_request") return "blocked";
  if (reason === "cancelled") return "canceled";
  if (reason === "configuration_error") return "configuration_error";
  if (reason === "fatal_error") return "failed";
  if (reason === "goal_satisfied") return "completed";
  return resolveIdentity(candidates).status === "ambiguous" ? "ambiguous" : "partial";
}

export function evaluateStop(state: InvestigationState, options: StopEvaluationOptions = {}): StopDecision {
  if (state.safety.level === "block") {
    return {
      allowed: true,
      reason: "unsafe_request",
      detail: "The safety classifier blocked this investigation before external research.",
      exhaustedDimensions: [],
    };
  }
  if (options.canceled) {
    return {
      allowed: true,
      reason: "cancelled",
      detail: "The caller canceled the investigation.",
      exhaustedDimensions: [],
    };
  }

  const identity = resolveIdentity(state.candidates, state.evidence);
  const coverage = summarizeCoverage(state, requestedCategoriesForInput(state.input));
  const minimumFindings = Math.min(options.minimumFindings ?? 2, Math.max(1, coverage.requestedCategories.length));
  const enoughFindings = coverage.supportedFindingCount >= minimumFindings;
  const enoughSources = coverage.independentSourceFamilyCount >= (options.minimumIndependentSourceFamilies ?? 2);
  const uniqueOfficialAnchor = hasUniqueOfficialAnchor(state, identity.selectedCandidateId);
  // Completion and report coverage share one policy source. A run cannot claim
  // success while its own report still lists an applicable category as missing.
  const allApplicableCategoriesCovered = coverage.missingCategories.length === 0;
  const goalSatisfied =
    identity.status === "resolved" &&
    enoughFindings &&
    (enoughSources || uniqueOfficialAnchor) &&
    allApplicableCategoriesCovered &&
    state.openQuestions.length === 0;
  if (goalSatisfied) {
    return {
      allowed: true,
      reason: "goal_satisfied",
      detail:
        uniqueOfficialAnchor && !enoughSources
          ? "Identity, a unique non-spoofable official anchor, and every applicable report category meet the completion policy."
          : "Identity, evidence diversity, and every applicable report category meet the completion policy.",
      exhaustedDimensions: [],
    };
  }

  // Safety and cancellation take precedence over success; once the success
  // predicate is met, exhausted budgets or an empty action set must not
  // downgrade a legally complete report to partial.
  const exhaustedDimensions = exhaustedBudgetDimensions(state.budget.limits, state.budget.usage);
  if (exhaustedDimensions.length > 0) {
    return {
      allowed: true,
      reason: "budget_exhausted",
      detail: `Budget exhausted: ${exhaustedDimensions.join(", ")}.`,
      exhaustedDimensions,
    };
  }
  if (state.budget.usage.consecutiveNoProgress >= state.budget.limits.maxConsecutiveNoProgress) {
    return {
      allowed: true,
      reason: "diminishing_returns",
      detail: "The investigation reached its configured no-progress limit.",
      exhaustedDimensions: [],
    };
  }
  if (options.noLegalActions) {
    return {
      allowed: true,
      reason: "no_legal_actions",
      detail: "The planner has no remaining policy-compliant action.",
      exhaustedDimensions: [],
    };
  }

  if (options.plannerRequested && state.phase === "report") {
    return {
      allowed: true,
      reason: "planner_requested",
      detail: "The planner requested termination after the report phase before the completion policy was satisfied.",
      exhaustedDimensions: [],
    };
  }

  return {
    allowed: false,
    detail: options.plannerRequested
      ? "Planner stop rejected: identity or evidence coverage is not yet sufficient."
      : "The investigation has useful legal work remaining.",
    exhaustedDimensions: [],
  };
}

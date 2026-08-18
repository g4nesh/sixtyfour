import type { ResearchPhase } from "./types";

const LEGAL_TRANSITIONS: Record<ResearchPhase, readonly ResearchPhase[]> = {
  intake: ["classify", "terminal"],
  classify: ["plan", "terminal"],
  plan: ["discover", "terminal"],
  discover: ["separate_candidates", "terminal"],
  separate_candidates: ["discover", "corroborate", "terminal"],
  corroborate: ["discover", "calibrate", "terminal"],
  calibrate: ["corroborate", "report", "terminal"],
  report: ["terminal"],
  terminal: [],
};

export function legalNextPhases(phase: ResearchPhase): ResearchPhase[] {
  return [...LEGAL_TRANSITIONS[phase]];
}

export function canTransitionPhase(from: ResearchPhase, to: ResearchPhase): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export function assertPhaseTransition(from: ResearchPhase, to: ResearchPhase): void {
  if (!canTransitionPhase(from, to)) {
    throw new Error(`illegal research phase transition: ${from} -> ${to}`);
  }
}

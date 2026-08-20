import { Annotation, END, START, StateGraph } from "@langchain/langgraph/web";
import type { JsonObject } from "../domain/types";

export type FrontierHarnessRoute =
  | "seed_frontier"
  | "select_frontier"
  | "plan_expansion"
  | "execute_expansion"
  | "admit_expand"
  | "assess"
  | "synthesize"
  | "terminal";

export const FrontierHarnessState = Annotation.Root({
  route: Annotation<FrontierHarnessRoute>,
  selectedFrontierEntryIds: Annotation<string[]>,
  decision: Annotation<JsonObject | null>,
  mutations: Annotation<number>,
  cycle: Annotation<number>,
});

export type FrontierHarnessStateValue = typeof FrontierHarnessState.State;
export type FrontierHarnessStateUpdate = typeof FrontierHarnessState.Update;

export interface FrontierHarnessHooks {
  classify(state: FrontierHarnessStateValue): Promise<FrontierHarnessStateUpdate> | FrontierHarnessStateUpdate;
  seedFrontier(state: FrontierHarnessStateValue): Promise<FrontierHarnessStateUpdate> | FrontierHarnessStateUpdate;
  selectFrontier(state: FrontierHarnessStateValue): Promise<FrontierHarnessStateUpdate> | FrontierHarnessStateUpdate;
  planExpansion(state: FrontierHarnessStateValue): Promise<FrontierHarnessStateUpdate> | FrontierHarnessStateUpdate;
  executeExpansion(state: FrontierHarnessStateValue): Promise<FrontierHarnessStateUpdate> | FrontierHarnessStateUpdate;
  admitExpand(state: FrontierHarnessStateValue): Promise<FrontierHarnessStateUpdate> | FrontierHarnessStateUpdate;
  assess(state: FrontierHarnessStateValue): Promise<FrontierHarnessStateUpdate> | FrontierHarnessStateUpdate;
  synthesize(state: FrontierHarnessStateValue): Promise<FrontierHarnessStateUpdate> | FrontierHarnessStateUpdate;
}

function routeAfterClassify(state: FrontierHarnessStateValue): "seed_frontier" | typeof END {
  return state.route === "terminal" ? END : "seed_frontier";
}

function routeAfterSelection(
  state: FrontierHarnessStateValue,
): "plan_expansion" | "synthesize" | typeof END {
  if (state.route === "terminal") return END;
  if (state.route === "synthesize") return "synthesize";
  return "plan_expansion";
}

function routeAfterPlan(
  state: FrontierHarnessStateValue,
): "execute_expansion" | "assess" | "synthesize" | typeof END {
  if (state.route === "terminal") return END;
  if (state.route === "synthesize") return "synthesize";
  return state.route === "execute_expansion" ? "execute_expansion" : "assess";
}

function routeAfterAssessment(
  state: FrontierHarnessStateValue,
): "select_frontier" | "synthesize" | typeof END {
  if (state.route === "terminal") return END;
  if (state.route === "synthesize") return "synthesize";
  return "select_frontier";
}

function routeAfterSynthesis(
  state: FrontierHarnessStateValue,
): "select_frontier" | typeof END {
  return state.route === "terminal" ? END : "select_frontier";
}

/**
 * Compiles the Worker-safe LangGraph control loop. No ToolNode or prebuilt
 * agent is used: hooks may propose work, while Atlas kernels retain admission
 * and stopping authority.
 */
export function compileFrontierHarness(hooks: FrontierHarnessHooks) {
  return new StateGraph(FrontierHarnessState)
    .addNode("classify", hooks.classify)
    .addNode("seed_frontier", hooks.seedFrontier)
    .addNode("select_frontier", hooks.selectFrontier)
    .addNode("plan_expansion", hooks.planExpansion)
    .addNode("execute_expansion", hooks.executeExpansion)
    .addNode("admit_expand", hooks.admitExpand)
    .addNode("assess", hooks.assess)
    .addNode("synthesize", hooks.synthesize)
    .addEdge(START, "classify")
    .addConditionalEdges("classify", routeAfterClassify, ["seed_frontier", END])
    .addEdge("seed_frontier", "select_frontier")
    .addConditionalEdges("select_frontier", routeAfterSelection, ["plan_expansion", "synthesize", END])
    .addConditionalEdges("plan_expansion", routeAfterPlan, ["execute_expansion", "assess", "synthesize", END])
    .addEdge("execute_expansion", "admit_expand")
    .addEdge("admit_expand", "assess")
    .addConditionalEdges("assess", routeAfterAssessment, ["select_frontier", "synthesize", END])
    .addConditionalEdges("synthesize", routeAfterSynthesis, ["select_frontier", END])
    .compile();
}

export function initialFrontierHarnessState(): FrontierHarnessStateValue {
  return {
    route: "seed_frontier",
    selectedFrontierEntryIds: [],
    decision: null,
    mutations: 0,
    cycle: 0,
  };
}

import type { TraceEvent } from "../agent/trace";
import type { InvestigationInput } from "../domain/types";

/**
 * Local demo fixtures are captured, schema-valid investigation runs that the
 * server can replay when live providers are unavailable. This module is
 * deliberately generic and data-free: the fixtures themselves are injected at
 * build time from an optional, git-ignored `local-demo/` folder (see the
 * `atlas:local-demo-fixtures` plugin in vite.config.ts). When no fixtures are
 * present the global is empty and every request falls through to the normal
 * replay/live path, so this code is inert on any checkout without the folder.
 */
export interface LocalDemoFixture {
  /** The query this fixture answers (matched case- and whitespace-insensitively). */
  query: string;
  input: InvestigationInput;
  trace: TraceEvent[];
}

const GLOBAL_KEY = "__ATLAS_LOCAL_DEMO_FIXTURES__";

/** Total wall-clock time to spread a replayed fixture over, so it paces like a live run. */
const TARGET_TOTAL_MS = 18_000;
const MAX_STEP_MS = 1_100;

function normalizeQuery(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

/** Reads the build-injected fixtures. Returns [] whenever none were bundled. */
export function localDemoFixtures(): LocalDemoFixture[] {
  const injected = (globalThis as Record<string, unknown>)[GLOBAL_KEY];
  return Array.isArray(injected) ? (injected as LocalDemoFixture[]) : [];
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Weight events so the replay dwells on real work (tool calls, planning,
 * synthesis) rather than emitting bookkeeping events at a uniform machine-gun
 * rate. The weights are normalized to TARGET_TOTAL_MS at stream time.
 */
function eventWeight(event: TraceEvent): number {
  if (event.name === "result.terminal") return 0;
  if (event.kind === "span_start" && /^tool\./.test(event.name)) return 22;
  if (event.kind === "span_start" && (event.name === "planner.decision" || event.name === "synthesis.findings")) {
    return 14;
  }
  if (event.kind === "span_end" && /^(tool\.|planner\.|synthesis\.)/.test(event.name)) return 3;
  return 1;
}

export interface LocalDemoResolution {
  /** The fixture's own captured input; validated against the replayed terminal report. */
  input: InvestigationInput;
  /** Emits the captured trace paced over wall-clock time, honoring cancellation. */
  source: (signal: AbortSignal) => AsyncGenerator<TraceEvent>;
}

/**
 * If a fixture matches this input's query, returns a paced replay source and the
 * fixture's captured input. Returns null when no fixture matches (the common
 * case: on any checkout without a `local-demo/` folder this is always null).
 */
export function resolveLocalDemo(
  fixtures: readonly LocalDemoFixture[],
  input: InvestigationInput,
): LocalDemoResolution | null {
  const wanted = normalizeQuery(input.query);
  const fixture = fixtures.find(
    (entry) =>
      Array.isArray(entry?.trace) &&
      entry.trace.length > 0 &&
      (normalizeQuery(entry.query ?? "") === wanted || normalizeQuery(entry.input?.query ?? "") === wanted),
  );
  if (!fixture) return null;

  const events = fixture.trace;
  const totalWeight = events.reduce((sum, event) => sum + eventWeight(event), 0) || 1;
  const source = async function* (signal: AbortSignal): AsyncGenerator<TraceEvent> {
    for (const event of events) {
      if (signal.aborted) return;
      const step = Math.min(MAX_STEP_MS, (eventWeight(event) / totalWeight) * TARGET_TOTAL_MS);
      await sleep(step, signal);
      yield event;
    }
  };
  return { input: fixture.input, source };
}

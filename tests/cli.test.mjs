import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

function runAtlas(arguments_) {
  const environment = { ...process.env };
  delete environment.OPENROUTER_API_KEY;
  return spawnSync(process.execPath, ["bin/run.mjs", ...arguments_], {
    cwd: projectRoot,
    env: environment,
    encoding: "utf8",
    timeout: 15_000,
  });
}

function ndjson(value) {
  return value.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("CLI streams replay NDJSON from the shared engine and preserves terminal status", () => {
  const result = runAtlas([
    "research",
    "--mode",
    "replay",
    "--example",
    "python-creator",
    "--ndjson",
    "the creator of Python",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const events = ndjson(result.stdout);
  assert.equal(events.at(-1).name, "result.terminal");
  assert.equal(events.at(-1).payload.report.status, "completed");
  assert.equal(events.at(-1).seq, events.length);
});

test("CLI NDJSON mode returns the same nonzero code as formatted mode for configuration errors", () => {
  const arguments_ = ["research", "--mode", "live", "Grace Hopper public professional background"];
  const formatted = runAtlas(arguments_);
  const streamed = runAtlas([...arguments_.slice(0, 3), "--ndjson", ...arguments_.slice(3)]);
  assert.equal(formatted.status, 2, formatted.stderr);
  assert.equal(streamed.status, 2, streamed.stderr);
  const events = ndjson(streamed.stdout);
  assert.equal(events.at(-1).payload.report.status, "configuration_error");
  assert.equal(events.at(-1).payload.report.stop.reason, "configuration_error");
});

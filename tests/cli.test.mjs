import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createServer } from "vite";

const projectRoot = new URL("../", import.meta.url);

function runAtlas(arguments_) {
  const environment = { ...process.env };
  for (const key of ["LIVE_PROVIDER", "GEMINI_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"]) {
    delete environment[key];
  }
  return spawnSync(process.execPath, ["bin/run.mjs", ...arguments_], {
    cwd: projectRoot,
    env: environment,
    encoding: "utf8",
    timeout: 15_000,
  });
}

test("CLI help documents every supported live provider", () => {
  const result = runAtlas(["help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Gemini, OpenAI, or OpenRouter/);
  assert.match(result.stdout, /LIVE_PROVIDER=gemini\|openai\|openrouter/);
});

test("configured live CLI uses the loopback-only ingress bypass", async () => {
  const vite = await createServer({
    configFile: false,
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  try {
    const { CLI_RESEARCH_URL, cliApiEnvironment } = await vite.ssrLoadModule("/bin/atlas.ts");
    const environment = cliApiEnvironment("live", {
      LIVE_PROVIDER: "openrouter",
      OPENROUTER_API_KEY: "server-secret",
    });
    const researchUrl = new URL(CLI_RESEARCH_URL);

    assert.equal(researchUrl.protocol, "http:");
    assert.equal(researchUrl.hostname, "localhost");
    assert.equal(researchUrl.pathname, "/api/research");
    assert.equal(environment.ATLAS_ALLOW_UNAUTHENTICATED_LOCAL, "true");
    assert.equal(environment.ATLAS_API_TOKEN, undefined);
  } finally {
    await vite.close();
  }
});

function ndjson(value) {
  return value
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
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

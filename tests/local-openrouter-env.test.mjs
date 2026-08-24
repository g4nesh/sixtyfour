import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  LOCAL_OPENROUTER_SETTINGS,
  LOCAL_PRODUCTION_SERVER,
  localOpenRouterEnvironment,
  parseLocalOpenRouterArguments,
  resolveLocalOpenRouterEnvironment,
} from "../scripts/run-local-openrouter.mjs";

const script = new URL("../scripts/run-local-openrouter.mjs", import.meta.url);
const placeholderKey = ["sk-or-v1", "local-placeholder-key-material-1234567890"].join("-");

async function runCheck(contents, ambientEnvironment = {}) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-local-openrouter-"));
  const credentialPath = join(directory, "credentials.input");
  await writeFile(credentialPath, contents, { encoding: "utf8", mode: 0o600 });

  return await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [script.pathname, "--check", "--credentials-file", credentialPath], {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      env: { ...process.env, ...ambientEnvironment },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
}

test("local OpenRouter argument parsing requires one caller-selected environment path", () => {
  assert.deepEqual(parseLocalOpenRouterArguments(["--credentials-file", "private/credentials"], "/workspace"), {
    help: false,
    checkOnly: false,
    environmentPath: "/workspace/private/credentials",
  });
  assert.deepEqual(parseLocalOpenRouterArguments(["--check", "--credentials-file=../credentials"], "/workspace/app"), {
    help: false,
    checkOnly: true,
    environmentPath: "/workspace/credentials",
  });
  assert.deepEqual(parseLocalOpenRouterArguments(["--help"]), {
    help: true,
    checkOnly: false,
    environmentPath: null,
  });
  assert.throws(() => parseLocalOpenRouterArguments([]), /caller-selected --credentials-file path is required/);
  assert.throws(
    () => parseLocalOpenRouterArguments(["--credentials-file", "one", "--credentials-file=two"]),
    /supplied only once/,
  );
  assert.throws(
    () => parseLocalOpenRouterArguments(["--credentials-file", "private", "--port", "4000"]),
    /Unsupported/,
  );
});

test("credential resolution consumes only OPENROUTER_API_KEY and ignores Node, host, provider, and sentinel entries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-local-openrouter-resolve-"));
  const credentialPath = join(directory, "credentials.input");
  await writeFile(
    credentialPath,
    [
      `OPENROUTER_API_KEY=${placeholderKey}`,
      "NODE_OPTIONS=--import /dotenv/injected.mjs",
      "HOME=/dotenv/home",
      "PATH=/dotenv/bin",
      "LIVE_PROVIDER=anthropic",
      "OPENROUTER_MODEL=untrusted/model",
      "ATLAS_LOCAL_OPENROUTER_BOOTSTRAP=forged-bootstrap",
      "SENTINEL=dotenv-sentinel",
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );

  const environment = await resolveLocalOpenRouterEnvironment(credentialPath, {
    HOME: "/host/home",
    PATH: "/host/bin",
    LIVE_PROVIDER: "openai",
    OPENAI_API_KEY: "ambient-provider-secret",
    SENTINEL: "ambient-sentinel",
  });
  assert.equal(environment.OPENROUTER_API_KEY, placeholderKey);
  assert.equal(environment.HOME, "/host/home");
  assert.equal(environment.PATH, "/host/bin");
  assert.equal(environment.NODE_OPTIONS, "");
  assert.equal(environment.LIVE_PROVIDER, "openrouter");
  assert.equal(environment.OPENROUTER_MODEL, "openai/gpt-5.4-nano");
  assert.equal("ATLAS_LOCAL_OPENROUTER_BOOTSTRAP" in environment, false);
  assert.equal("SENTINEL" in environment, false);
  assert.equal("OPENAI_API_KEY" in environment, false);
});

test("local production settings are immutable, loopback-only, and do not inherit provider controls", () => {
  const environment = localOpenRouterEnvironment(
    {
      HOME: "/host/home",
      PATH: "/usr/bin",
      TMPDIR: "/host/tmp",
      LANG: "en_US.UTF-8",
      NODE_OPTIONS: "--inspect",
      LIVE_PROVIDER: "anthropic",
      SENTINEL: "ambient-sentinel",
    },
    placeholderKey,
  );
  assert.equal(environment.ATLAS_LIVE_ENABLED, "true");
  assert.equal(environment.ATLAS_ALLOW_UNAUTHENTICATED_LOCAL, "true");
  assert.equal(environment.LIVE_PROVIDER, "openrouter");
  assert.equal(environment.OPENROUTER_MODEL, "openai/gpt-5.4-nano");
  assert.equal(environment.OPENROUTER_SITE_URL, "http://localhost:3000");
  assert.equal(environment.OPENROUTER_API_KEY, placeholderKey);
  assert.equal(environment.NODE_OPTIONS, "");
  assert.equal(environment.NODE_ENV, "production");
  assert.equal(environment.HOSTNAME, "127.0.0.1");
  assert.equal(environment.PORT, "3000");
  assert.equal(environment.WRANGLER_WRITE_LOGS, "false");
  assert.equal(environment.HOME, "/host/home");
  assert.equal(environment.PATH, "/usr/bin");
  assert.equal(environment.TMPDIR, "/host/tmp");
  assert.equal(environment.LANG, "en_US.UTF-8");
  assert.equal("OPENAI_API_KEY" in environment, false);
  assert.equal("GEMINI_API_KEY" in environment, false);
  assert.equal("ANTHROPIC_API_KEY" in environment, false);
  assert.equal("LIVE_SEARCH_PROVIDER" in environment, false);
  assert.equal("SENTINEL" in environment, false);
  assert.equal(LOCAL_PRODUCTION_SERVER.cwd, fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, ""));
  assert.match(LOCAL_PRODUCTION_SERVER.modulePath, /node_modules\/vinext\/dist\/server\/prod-server\.js$/);
  assert.match(LOCAL_PRODUCTION_SERVER.outDir, /\/dist$/);
  assert.equal(LOCAL_PRODUCTION_SERVER.host, "127.0.0.1");
  assert.equal(LOCAL_PRODUCTION_SERVER.port, 3000);
  assert.equal(Object.isFrozen(LOCAL_OPENROUTER_SETTINGS), true);
  assert.equal(Object.isFrozen(LOCAL_PRODUCTION_SERVER), true);
});

test("validation-only launch uses the bounded shared reader without exposing the credential", async () => {
  const result = await runCheck(
    [
      `OPENROUTER_API_KEY=${placeholderKey}`,
      "NODE_OPTIONS=--import /dotenv/should-never-load.mjs",
      "HOME=/dotenv/home",
      "PATH=/dotenv/bin",
      "LIVE_PROVIDER=anthropic",
      "ATLAS_LOCAL_OPENROUTER_BOOTSTRAP=forged-bootstrap",
      "SENTINEL=dotenv-sentinel",
      "",
    ].join("\n"),
    {
      LIVE_PROVIDER: "openai",
      OPENAI_API_KEY: "ambient-provider-secret",
      OPENROUTER_MODEL: "untrusted/ambient-model",
      SENTINEL: "ambient-sentinel",
    },
  );

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.signal, null);
  assert.match(result.stdout, /Atlas local OpenRouter configuration is valid/);
  assert.match(result.stdout, /Binding: http:\/\/127\.0\.0\.1:3000/);
  assert.match(result.stdout, /Browser URL: http:\/\/localhost:3000/);
  assert.match(result.stdout, /Model: openai\/gpt-5\.4-nano/);
  assert.match(result.stdout, /Runtime: prebuilt Vinext production server/);
  assert.match(result.stdout, /No server was started/);
  assert.equal(result.stdout.includes(placeholderKey), false);
  assert.equal(result.stderr.includes(placeholderKey), false);
  assert.equal(result.stdout.includes("ambient-provider-secret"), false);
  assert.equal(result.stderr.includes("ambient-provider-secret"), false);
  assert.equal(result.stdout.includes("untrusted/ambient-model"), false);
  assert.equal(result.stderr.includes("untrusted/ambient-model"), false);
  for (const discardedValue of [
    "/dotenv/should-never-load.mjs",
    "/dotenv/home",
    "/dotenv/bin",
    "anthropic",
    "dotenv-sentinel",
    "forged-bootstrap",
  ]) {
    assert.equal(result.stdout.includes(discardedValue), false);
    assert.equal(result.stderr.includes(discardedValue), false);
  }
});

test("validation-only launch ignores additional file settings without forwarding or logging them", async () => {
  const unexpectedValue = "do-not-print-this-provider-setting";
  const result = await runCheck(
    `OPENROUTER_API_KEY=${placeholderKey}\nLIVE_PROVIDER=${unexpectedValue}\nOPENROUTER_MODEL=untrusted/model\n`,
  );

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Atlas local OpenRouter configuration is valid/);
  assert.match(result.stdout, /Model: openai\/gpt-5\.4-nano/);
  assert.equal(result.stdout.includes(placeholderKey), false);
  assert.equal(result.stderr.includes(placeholderKey), false);
  assert.equal(result.stdout.includes(unexpectedValue), false);
  assert.equal(result.stderr.includes(unexpectedValue), false);
  assert.equal(result.stderr.includes("untrusted/model"), false);
});

test("the launcher delegates bounded parsing and starts only the prebuilt Vinext production server", async () => {
  const source = await readFile(script, "utf8");
  assert.match(source, /from ["']\.\/openrouter-env-file\.mjs["']/);
  assert.match(source, /readValidatedOpenRouterKeyFromEnvFile\(environmentPath\)/);
  assert.doesNotMatch(source, /--env-file/);
  assert.doesNotMatch(source, /node:child_process|\bspawn\(|randomBytes|parseEnv/);
  assert.doesNotMatch(source, /from ["']node:fs/);
  assert.doesNotMatch(source, /readFile|dotenv\.config/);
  assert.match(source, /node_modules\/vinext\/dist\/server\/prod-server\.js/);
  assert.match(source, /await import\(pathToFileURL\(LOCAL_PRODUCTION_SERVER\.modulePath\)\.href\)/);
  assert.match(source, /startProdServer\(\{/);
  const sanitizeIndex = source.indexOf("replaceCurrentEnvironment(environment)");
  const productionImportIndex = source.indexOf("await import(pathToFileURL(LOCAL_PRODUCTION_SERVER.modulePath).href)");
  assert.ok(
    sanitizeIndex >= 0 && sanitizeIndex < productionImportIndex,
    "the process environment must be sanitized before the production server module is imported",
  );
  assert.doesNotMatch(source, /\bvite\b|createServer|envFile\s*:|vinext\/dist\/cli\.js/i);
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import test from "node:test";

import {
  DEFAULT_PORT,
  DEFAULT_OPENROUTER_APP_NAME,
  DEFAULT_OPENROUTER_MODEL,
  DEFAULT_OPENROUTER_SITE_URL,
  LAUNCH_AGENT_LABEL,
  LOCAL_HOSTNAME,
  buildLaunchAgentProgramArguments,
  buildRunLocalhostPlan,
  createLaunchAgentPlistXml,
  installLaunchAgent,
  replaceProcessEnvironment,
  resolveServicePaths,
  statusLaunchAgent,
  uninstallLaunchAgent,
} from "../scripts/macos-service.mjs";
import {
  DEFAULT_ENV_FILE_MAX_BYTES,
  parseValidatedOpenRouterKeyFromEnvText,
  readValidatedOpenRouterKeyFromEnvFile,
} from "../scripts/openrouter-env-file.mjs";

const script = new URL("../scripts/macos-service.mjs", import.meta.url);

function makeOpenRouterKey(character) {
  return `sk-or-v1-${character.repeat(48)}`;
}

async function serviceFixture() {
  const directory = await mkdtemp(join(tmpdir(), "atlas-macos-service-"));
  const homeDirectory = join(directory, "home");
  const projectRoot = "/Users/test/atlas project & root";
  const envFilePath = join(directory, "secrets", "atlas <env>.env");
  return {
    directory,
    homeDirectory,
    projectRoot,
    envFilePath,
    nodePath: "/opt/homebrew/bin/node",
  };
}

async function writeEnvFile(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, "utf8");
}

async function runCli(arguments_) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script.pathname, ...arguments_], {
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
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("plist generation is deterministic, escaped, and excludes Node --env-file usage", async () => {
  const fixture = await serviceFixture();
  const xml = createLaunchAgentPlistXml(fixture);
  const paths = resolveServicePaths(fixture);

  assert.match(xml, /<key>Label<\/key>\n\t<string>chat\.ganstlr\.atlas-backend<\/string>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\n\t<true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>\n\t<true\/>/);
  assert.match(xml, /<key>ThrottleInterval<\/key>\n\t<integer>10<\/integer>/);
  assert.match(xml, /<key>ProcessType<\/key>\n\t<string>Background<\/string>/);
  assert.match(xml, /<string>\/usr\/bin\/caffeinate<\/string>/);
  assert.match(xml, /<string>-i<\/string>/);
  assert.doesNotMatch(xml, /<string>--env-file=/);
  assert.match(xml, /<string>--env-file-path=/);
  assert.match(xml, /atlas &lt;env&gt;\.env/);
  assert.match(xml, /atlas project &amp; root/);
  assert.deepEqual(buildLaunchAgentProgramArguments(paths), [
    "/usr/bin/caffeinate",
    "-i",
    fixture.nodePath,
    join(fixture.projectRoot, "scripts/macos-service.mjs"),
    "bootstrap-localhost",
    `--project-root=${fixture.projectRoot}`,
    `--env-file-path=${fixture.envFilePath}`,
    `--home-directory=${fixture.homeDirectory}`,
    `--wrangler-log-path=${paths.wranglerLogPath}`,
    `--miniflare-registry-path=${paths.miniflareRegistryPath}`,
  ]);
});

test("custom runtime state paths are propagated into LaunchAgent args", async () => {
  const fixture = await serviceFixture();
  const paths = resolveServicePaths({
    ...fixture,
    wranglerLogPath: join(fixture.homeDirectory, "custom", "wrangler.log"),
    miniflareRegistryPath: join(fixture.homeDirectory, "custom", "miniflare-registry"),
  });

  assert.deepEqual(buildLaunchAgentProgramArguments(paths), [
    "/usr/bin/caffeinate",
    "-i",
    fixture.nodePath,
    join(fixture.projectRoot, "scripts/macos-service.mjs"),
    "bootstrap-localhost",
    `--project-root=${fixture.projectRoot}`,
    `--env-file-path=${fixture.envFilePath}`,
    `--home-directory=${fixture.homeDirectory}`,
    `--wrangler-log-path=${paths.wranglerLogPath}`,
    `--miniflare-registry-path=${paths.miniflareRegistryPath}`,
  ]);
});

test("install writes an atomic mode-0600 plist without reading or requiring the env file", async () => {
  const fixture = await serviceFixture();
  const installed = await installLaunchAgent(fixture);
  const status = await statusLaunchAgent(fixture);
  const plist = await readFile(installed.plistPath, "utf8");

  assert.equal(status.installed, true);
  assert.equal(status.matchesDesired, true);
  assert.equal((await stat(installed.plistPath)).mode & 0o777, 0o600);
  assert.match(plist, /StandardOutPath/);
  assert.match(plist, /Library\/Logs\/Atlas\/atlas\.stdout\.log/);
  assert.match(plist, /Library\/Logs\/Atlas\/atlas\.stderr\.log/);
  await assert.rejects(stat(fixture.envFilePath), { code: "ENOENT" });
});

test("status detects drift and uninstall removes only the plist target", async () => {
  const fixture = await serviceFixture();
  const installed = await installLaunchAgent(fixture);
  await writeFile(installed.plistPath, "changed\n", "utf8");

  const drifted = await statusLaunchAgent(fixture);
  assert.equal(drifted.installed, true);
  assert.equal(drifted.matchesDesired, false);

  const removed = await uninstallLaunchAgent(fixture);
  assert.equal(removed.removed, true);
  const missing = await statusLaunchAgent(fixture);
  assert.equal(missing.installed, false);
  assert.equal(missing.matchesDesired, false);
});

test("localhost runtime consumes only OPENROUTER_API_KEY from the env file and sanitizes the final env", async () => {
  const fixture = await serviceFixture();
  const fileKey = makeOpenRouterKey("f");
  await writeEnvFile(
    fixture.envFilePath,
    [
      `OPENROUTER_API_KEY=${fileKey}`,
      "HOME=/dotenv/home",
      "PATH=/dotenv/bin",
      "TMPDIR=/dotenv/tmp",
      "LANG=C",
      "NODE_OPTIONS=--import injected.mjs",
      "LIVE_PROVIDER=anthropic",
      "OPENROUTER_MODEL=wrong/model",
      "OPENROUTER_SITE_URL=https://bad.example",
      "OPENROUTER_APP_NAME=BadApp",
      "SENTINEL=remove-me",
      "OPENAI_API_KEY=remove-me-too",
      "",
    ].join("\n"),
  );

  const hostEnvironment = {
    HOME: fixture.homeDirectory,
    PATH: "/opt/homebrew/bin:/usr/bin:/bin",
    TMPDIR: join(fixture.directory, "tmp"),
    LANG: "en_US.UTF-8",
    OPENROUTER_API_KEY: makeOpenRouterKey("a"),
    SENTINEL: "must-not-leak",
  };
  const plan = await buildRunLocalhostPlan(fixture, hostEnvironment);

  assert.equal(plan.cwd, fixture.projectRoot);
  assert.equal(plan.host, LOCAL_HOSTNAME);
  assert.equal(plan.port, Number(DEFAULT_PORT));
  assert.match(plan.modulePath, /node_modules\/vinext\/dist\/server\/prod-server\.js$/);
  assert.doesNotMatch(plan.modulePath, /cli\.js$/);
  assert.match(plan.outDir, /\/dist$/);

  assert.equal(plan.env.OPENROUTER_API_KEY, fileKey);
  assert.equal(plan.env.HOME, fixture.homeDirectory);
  assert.equal(plan.env.PATH, "/opt/homebrew/bin:/usr/bin:/bin");
  assert.equal(plan.env.TMPDIR, join(fixture.directory, "tmp"));
  assert.equal(plan.env.LANG, "en_US.UTF-8");
  assert.equal(plan.env.NODE_OPTIONS, "");
  assert.equal(plan.env.NODE_ENV, "production");
  assert.equal(plan.env.ATLAS_LIVE_ENABLED, "true");
  assert.equal(plan.env.ATLAS_ALLOW_UNAUTHENTICATED_LOCAL, "true");
  assert.equal(plan.env.LIVE_PROVIDER, "openrouter");
  assert.equal(plan.env.OPENROUTER_MODEL, DEFAULT_OPENROUTER_MODEL);
  assert.equal(plan.env.OPENROUTER_SITE_URL, DEFAULT_OPENROUTER_SITE_URL);
  assert.equal(plan.env.OPENROUTER_APP_NAME, DEFAULT_OPENROUTER_APP_NAME);
  assert.equal(plan.env.HOSTNAME, LOCAL_HOSTNAME);
  assert.equal(plan.env.PORT, DEFAULT_PORT);
  assert.equal("SENTINEL" in plan.env, false);
  assert.equal("OPENAI_API_KEY" in plan.env, false);

  const targetEnvironment = {
    SENTINEL: "still-here",
    OPENAI_API_KEY: "ambient-secret",
    OPENROUTER_API_KEY: makeOpenRouterKey("z"),
  };
  replaceProcessEnvironment(plan.env, targetEnvironment);
  assert.equal(targetEnvironment.OPENROUTER_API_KEY, fileKey);
  assert.equal(targetEnvironment.HOME, fixture.homeDirectory);
  assert.equal(targetEnvironment.PATH, "/opt/homebrew/bin:/usr/bin:/bin");
  assert.equal(targetEnvironment.NODE_OPTIONS, "");
  assert.equal("SENTINEL" in targetEnvironment, false);
  assert.equal("OPENAI_API_KEY" in targetEnvironment, false);
});

test("bounded env-file parsing keeps only the validated OpenRouter key", async () => {
  const key = makeOpenRouterKey("k");
  assert.equal(
    parseValidatedOpenRouterKeyFromEnvText(
      `OPENROUTER_API_KEY=${key}\nHOME=/ignored\nNODE_OPTIONS=--inspect\nSENTINEL=remove-me\n`,
    ),
    key,
  );
});

test("env-file validation rejects invalid or missing keys without echoing values", async () => {
  const fixture = await serviceFixture();
  const invalidSecret = "bad-secret-value";
  await writeEnvFile(fixture.envFilePath, `OPENROUTER_API_KEY=${invalidSecret}\nSENTINEL=also-hidden\n`);

  await assert.rejects(readValidatedOpenRouterKeyFromEnvFile(fixture.envFilePath), (error) => {
    assert.equal(error instanceof TypeError, true);
    assert.match(error.message, /OPENROUTER_API_KEY must contain a valid OpenRouter key/);
    assert.doesNotMatch(error.message, /bad-secret-value|also-hidden/);
    return true;
  });

  await writeEnvFile(fixture.envFilePath, "HOME=/still-ignored\n");
  await assert.rejects(
    readValidatedOpenRouterKeyFromEnvFile(fixture.envFilePath),
    /OPENROUTER_API_KEY must contain a valid OpenRouter key/,
  );
});

test("env-file reads enforce a bounded maximum size without logging contents", async () => {
  const fixture = await serviceFixture();
  const oversizedBody = `OPENROUTER_API_KEY=${makeOpenRouterKey("x")}\nSENTINEL=${"n".repeat(DEFAULT_ENV_FILE_MAX_BYTES)}\n`;
  await writeEnvFile(fixture.envFilePath, oversizedBody);

  await assert.rejects(readValidatedOpenRouterKeyFromEnvFile(fixture.envFilePath, { maxBytes: 64 }), (error) => {
    assert.equal(error instanceof RangeError, true);
    assert.match(error.message, /allowed size limit/);
    assert.doesNotMatch(error.message, /SENTINEL|sk-or-v1-/);
    return true;
  });
});

test("CLI install/status/uninstall are safely testable and emit JSON", async () => {
  const fixture = await serviceFixture();
  const common = [
    `--project-root=${fixture.projectRoot}`,
    `--env-file-path=${fixture.envFilePath}`,
    `--home-directory=${fixture.homeDirectory}`,
    `--node-path=${fixture.nodePath}`,
  ];

  const install = await runCli(["install", ...common]);
  assert.equal(install.code, 0, install.stderr);
  assert.equal(JSON.parse(install.stdout).label, LAUNCH_AGENT_LABEL);

  const status = await runCli(["status", ...common]);
  assert.equal(status.code, 0, status.stderr);
  const statusPayload = JSON.parse(status.stdout);
  assert.equal(statusPayload.installed, true);
  assert.equal(statusPayload.matchesDesired, true);

  const uninstall = await runCli(["uninstall", ...common]);
  assert.equal(uninstall.code, 0, uninstall.stderr);
  assert.equal(JSON.parse(uninstall.stdout).removed, true);
});

test("temporary project roots are rejected so install targets a durable checkout only", async () => {
  const fixture = await serviceFixture();
  await assert.rejects(
    installLaunchAgent({
      ...fixture,
      projectRoot: join(tmpdir(), "atlas-ephemeral-root"),
    }),
    /must not live under a temporary directory/,
  );
});

test("relative paths are rejected before normalization", async () => {
  await assert.throws(
    () =>
      resolveServicePaths({
        projectRoot: "/Users/test/atlas",
        envFilePath: "relative.env",
        homeDirectory: "/Users/test",
      }),
    /envFilePath must be an absolute path/,
  );
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
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
  MANAGED_CREDENTIAL_FILENAME,
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

async function serviceFixture(context) {
  const directory = await mkdtemp(join(tmpdir(), "atlas-macos-service-"));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const homeDirectory = join(directory, "home");
  const projectRoot = "/Users/test/atlas project & root";
  const envFilePath = join(directory, "caller-owned", "source <credential>.env");
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
  await writeFile(path, contents, { encoding: "utf8", mode: 0o600 });
}

async function assertMissing(path) {
  await assert.rejects(stat(path), { code: "ENOENT" });
}

async function runCli(arguments_) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script.pathname, ...arguments_], {
      env: { LANG: "C", PATH: process.env.PATH ?? "/usr/bin:/bin" },
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

test("plist generation points only to the fixed managed credential snapshot", async (context) => {
  const fixture = await serviceFixture(context);
  const xml = createLaunchAgentPlistXml(fixture);
  const paths = resolveServicePaths(fixture);

  assert.match(xml, /<key>Label<\/key>\n\t<string>chat\.ganstlr\.atlas-backend<\/string>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\n\t<true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>\n\t<true\/>/);
  assert.match(xml, /<key>ThrottleInterval<\/key>\n\t<integer>10<\/integer>/);
  assert.match(xml, /<key>ProcessType<\/key>\n\t<string>Background<\/string>/);
  assert.match(xml, /<string>\/usr\/bin\/caffeinate<\/string>/);
  assert.match(xml, /<string>-i<\/string>/);
  assert.doesNotMatch(xml, /--env-file(?:-path)?=/);
  assert.doesNotMatch(xml, /source &lt;credential&gt;\.env/);
  assert.doesNotMatch(xml, /OPENROUTER_API_KEY|sk-or-v1-/);
  assert.match(xml, /Library\/Application Support\/Atlas\/openrouter\.env/);
  assert.match(xml, /atlas project &amp; root/);
  assert.equal(paths.credentialSnapshotPath, join(paths.supportDirectory, MANAGED_CREDENTIAL_FILENAME));
  assert.deepEqual(buildLaunchAgentProgramArguments(paths), [
    "/usr/bin/caffeinate",
    "-i",
    fixture.nodePath,
    join(fixture.projectRoot, "scripts/macos-service.mjs"),
    "bootstrap-localhost",
    `--project-root=${fixture.projectRoot}`,
    `--runtime-credential-path=${paths.credentialSnapshotPath}`,
    `--home-directory=${fixture.homeDirectory}`,
    `--wrangler-log-path=${paths.wranglerLogPath}`,
    `--miniflare-registry-path=${paths.miniflareRegistryPath}`,
  ]);
});

test("custom runtime state paths are propagated without changing the fixed snapshot", async (context) => {
  const fixture = await serviceFixture(context);
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
    `--runtime-credential-path=${paths.credentialSnapshotPath}`,
    `--home-directory=${fixture.homeDirectory}`,
    `--wrangler-log-path=${paths.wranglerLogPath}`,
    `--miniflare-registry-path=${paths.miniflareRegistryPath}`,
  ]);
});

test("install imports only the key into an atomic private snapshot and never returns it", async (context) => {
  const fixture = await serviceFixture(context);
  const key = makeOpenRouterKey("i");
  const poison = "synthetic-poison-must-not-survive";
  await writeEnvFile(
    fixture.envFilePath,
    `OPENROUTER_API_KEY=${key}\nNODE_OPTIONS=--import injected.mjs\nSENTINEL=${poison}\n`,
  );

  const installed = await installLaunchAgent(fixture);
  const status = await statusLaunchAgent(fixture);
  const plist = await readFile(installed.plistPath, "utf8");
  const snapshot = await readFile(installed.credentialSnapshotPath, "utf8");
  const serialized = JSON.stringify(installed);

  assert.equal(snapshot, `OPENROUTER_API_KEY=${key}\n`);
  assert.equal((await stat(installed.credentialSnapshotPath)).mode & 0o777, 0o600);
  assert.equal((await stat(installed.supportDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(installed.plistPath)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(installed.supportDirectory), [MANAGED_CREDENTIAL_FILENAME]);
  assert.doesNotMatch(plist, /--env-file(?:-path)?=|source &lt;credential&gt;\.env/);
  assert.match(plist, /--runtime-credential-path=/);
  assert.doesNotMatch(serialized, new RegExp(key));
  assert.doesNotMatch(serialized, new RegExp(poison));
  assert.equal(serialized.includes(fixture.envFilePath), false);
  assert.equal(installed.credentialSourceReadDuringInstall, true);
  assert.equal(installed.credentialSourceRetainedByAtlas, false);
  assert.equal(status.installed, true);
  assert.equal(status.plistMatchesDesired, true);
  assert.equal(status.matchesDesired, true);
  assert.equal(status.credentialDirectoryMode, "0700");
  assert.equal(status.credentialSnapshotMode, "0600");
  assert.equal(status.credentialSnapshotHealth, "valid");
});

test("the source can be removed after install and runtime uses only the managed snapshot", async (context) => {
  const fixture = await serviceFixture(context);
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
  await installLaunchAgent(fixture);
  await rm(fixture.envFilePath);

  const hostEnvironment = {
    HOME: fixture.homeDirectory,
    PATH: "/opt/homebrew/bin:/usr/bin:/bin",
    TMPDIR: join(fixture.directory, "tmp"),
    LANG: "en_US.UTF-8",
    OPENROUTER_API_KEY: makeOpenRouterKey("a"),
    SENTINEL: "must-not-leak",
  };
  const plan = await buildRunLocalhostPlan(fixture, hostEnvironment);
  const status = await statusLaunchAgent(fixture);

  await assertMissing(fixture.envFilePath);
  assert.equal(status.matchesDesired, true);
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

test("reinstall atomically rotates the snapshot and restores private modes", async (context) => {
  const fixture = await serviceFixture(context);
  const firstKey = makeOpenRouterKey("a");
  const secondKey = makeOpenRouterKey("b");
  await writeEnvFile(fixture.envFilePath, `OPENROUTER_API_KEY=${firstKey}\n`);
  const first = await installLaunchAgent(fixture);
  await chmod(first.supportDirectory, 0o755);
  await writeEnvFile(
    fixture.envFilePath,
    `OPENROUTER_API_KEY=${secondKey}\nOPENAI_API_KEY=${firstKey}\nSENTINEL=discard\n`,
  );

  const rotated = await installLaunchAgent(fixture);
  const contents = await readFile(rotated.credentialSnapshotPath, "utf8");

  assert.equal(contents, `OPENROUTER_API_KEY=${secondKey}\n`);
  assert.doesNotMatch(contents, new RegExp(firstKey));
  assert.doesNotMatch(contents, /OPENAI_API_KEY|SENTINEL/);
  assert.equal((await stat(rotated.supportDirectory)).mode & 0o777, 0o700);
  assert.equal((await stat(rotated.credentialSnapshotPath)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(rotated.supportDirectory), [MANAGED_CREDENTIAL_FILENAME]);
});

test("status reports bounded snapshot mode and parse health without the source", async (context) => {
  const fixture = await serviceFixture(context);
  const key = makeOpenRouterKey("s");
  await writeEnvFile(fixture.envFilePath, `OPENROUTER_API_KEY=${key}\n`);
  const installed = await installLaunchAgent(fixture);
  await rm(fixture.envFilePath);

  await chmod(installed.credentialSnapshotPath, 0o644);
  let status = await statusLaunchAgent(fixture);
  assert.equal(status.credentialSnapshotHealth, "unsafe_mode");
  assert.equal(status.credentialSnapshotMode, "0644");
  assert.equal(status.credentialSnapshotValid, false);
  assert.equal(status.matchesDesired, false);

  await chmod(installed.credentialSnapshotPath, 0o600);
  await writeFile(installed.credentialSnapshotPath, "OPENROUTER_API_KEY=invalid\n", { mode: 0o600 });
  status = await statusLaunchAgent(fixture);
  assert.equal(status.credentialSnapshotHealth, "invalid");
  assert.equal(status.credentialSnapshotValid, false);
  assert.doesNotMatch(JSON.stringify(status), /OPENROUTER_API_KEY=|sk-or-v1-/);

  await writeFile(installed.credentialSnapshotPath, `OPENROUTER_API_KEY=${key}\n`, { mode: 0o600 });
  await chmod(installed.supportDirectory, 0o755);
  status = await statusLaunchAgent(fixture);
  assert.equal(status.credentialSnapshotHealth, "unsafe_parent_mode");
  assert.equal(status.credentialDirectoryMode, "0755");
  assert.equal(status.matchesDesired, false);

  await chmod(installed.supportDirectory, 0o700);
  await rm(installed.credentialSnapshotPath);
  status = await statusLaunchAgent(fixture);
  assert.equal(status.credentialSnapshotHealth, "missing");
  assert.equal(status.credentialSnapshotPresent, false);
  assert.equal(status.matchesDesired, false);
});

test("runtime refuses a snapshot or parent directory with unsafe permissions", async (context) => {
  const fixture = await serviceFixture(context);
  await writeEnvFile(fixture.envFilePath, `OPENROUTER_API_KEY=${makeOpenRouterKey("r")}\n`);
  const installed = await installLaunchAgent(fixture);
  await rm(fixture.envFilePath);

  await chmod(installed.credentialSnapshotPath, 0o644);
  await assert.rejects(
    buildRunLocalhostPlan(fixture, {}),
    /managed Atlas credential snapshot must be a private mode-0600 regular file/,
  );
  await chmod(installed.credentialSnapshotPath, 0o600);
  await chmod(installed.supportDirectory, 0o755);
  await assert.rejects(
    buildRunLocalhostPlan(fixture, {}),
    /managed Atlas credential directory must be a private mode-0700 directory/,
  );
});

test("install and uninstall reject managed parent and snapshot symlinks", async (context) => {
  const parentFixture = await serviceFixture(context);
  const parentKey = makeOpenRouterKey("p");
  await writeEnvFile(parentFixture.envFilePath, `OPENROUTER_API_KEY=${parentKey}\n`);
  const redirectedParent = join(parentFixture.directory, "redirected-parent");
  await mkdir(join(parentFixture.homeDirectory, "Library"), { recursive: true });
  await mkdir(redirectedParent, { recursive: true });
  await symlink(redirectedParent, join(parentFixture.homeDirectory, "Library", "Application Support"));

  await assert.rejects(
    installLaunchAgent(parentFixture),
    /credential directory must be a real directory without symlinks/,
  );
  await assertMissing(join(redirectedParent, "Atlas", MANAGED_CREDENTIAL_FILENAME));

  const snapshotFixture = await serviceFixture(context);
  const snapshotKey = makeOpenRouterKey("q");
  await writeEnvFile(snapshotFixture.envFilePath, `OPENROUTER_API_KEY=${snapshotKey}\n`);
  const snapshotPaths = resolveServicePaths(snapshotFixture);
  const redirectedFile = join(snapshotFixture.directory, "must-remain-unchanged");
  await mkdir(snapshotPaths.supportDirectory, { recursive: true, mode: 0o700 });
  await chmod(snapshotPaths.supportDirectory, 0o700);
  await writeFile(redirectedFile, "sentinel\n", "utf8");
  await symlink(redirectedFile, snapshotPaths.credentialSnapshotPath);

  await assert.rejects(installLaunchAgent(snapshotFixture), /snapshot must be a regular file without symlinks/);
  await assert.rejects(uninstallLaunchAgent(snapshotFixture), /snapshot must be a regular file without symlinks/);
  assert.equal(await readFile(redirectedFile, "utf8"), "sentinel\n");

  const status = await statusLaunchAgent(snapshotFixture);
  assert.equal(status.credentialSnapshotHealth, "unsafe_type");
  assert.equal(status.credentialSnapshotSafe, false);
  assert.doesNotMatch(JSON.stringify(status), new RegExp(snapshotKey));
});

test("the runtime snapshot path cannot be redirected by an option", async (context) => {
  const fixture = await serviceFixture(context);
  assert.throws(
    () => resolveServicePaths({ ...fixture, runtimeCredentialPath: join(fixture.directory, "attacker-selected.env") }),
    /runtimeCredentialPath must be the managed Atlas credential snapshot path/,
  );
});

test("uninstall removes only the exact plist and managed snapshot and reports recovery", async (context) => {
  const fixture = await serviceFixture(context);
  const key = makeOpenRouterKey("u");
  await writeEnvFile(fixture.envFilePath, `OPENROUTER_API_KEY=${key}\nSENTINEL=caller-owned\n`);
  const installed = await installLaunchAgent(fixture);
  await writeFile(installed.stdoutPath, "preserved log\n", "utf8");
  await mkdir(installed.miniflareRegistryPath, { recursive: true });
  const statePath = join(installed.miniflareRegistryPath, "preserved-state");
  await writeFile(statePath, "state\n", "utf8");

  const result = await uninstallLaunchAgent(fixture);

  assert.equal(result.removed, true);
  assert.equal(result.plistRemoved, true);
  assert.equal(result.credentialSnapshotRemoved, true);
  assert.equal(result.credentialSnapshotRecoverable, false);
  assert.equal(result.callerCredentialSourceTouched, false);
  assert.equal(result.logsPreserved, true);
  assert.equal(result.runtimeStatePreserved, true);
  assert.match(result.recovery, /not recoverable; reinstall/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(key));
  assert.equal(JSON.stringify(result).includes(fixture.envFilePath), false);
  await assertMissing(installed.plistPath);
  await assertMissing(installed.credentialSnapshotPath);
  assert.match(await readFile(fixture.envFilePath, "utf8"), /SENTINEL=caller-owned/);
  assert.equal(await readFile(installed.stdoutPath, "utf8"), "preserved log\n");
  assert.equal(await readFile(statePath, "utf8"), "state\n");

  const repeated = await uninstallLaunchAgent(fixture);
  assert.equal(repeated.removed, false);
  assert.equal(repeated.credentialSnapshotRecoverable, null);
});

test("bounded env-file parsing keeps only the validated OpenRouter key", () => {
  const key = makeOpenRouterKey("k");
  assert.equal(
    parseValidatedOpenRouterKeyFromEnvText(
      `OPENROUTER_API_KEY=${key}\nHOME=/ignored\nNODE_OPTIONS=--inspect\nSENTINEL=remove-me\n`,
    ),
    key,
  );
});

test("env-file validation rejects invalid or missing keys without echoing values", async (context) => {
  const fixture = await serviceFixture(context);
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

test("env-file reads enforce a bounded maximum size without logging contents", async (context) => {
  const fixture = await serviceFixture(context);
  const oversizedBody = `OPENROUTER_API_KEY=${makeOpenRouterKey("x")}\nSENTINEL=${"n".repeat(DEFAULT_ENV_FILE_MAX_BYTES)}\n`;
  await writeEnvFile(fixture.envFilePath, oversizedBody);

  await assert.rejects(readValidatedOpenRouterKeyFromEnvFile(fixture.envFilePath, { maxBytes: 64 }), (error) => {
    assert.equal(error instanceof RangeError, true);
    assert.match(error.message, /allowed size limit/);
    assert.doesNotMatch(error.message, /SENTINEL|sk-or-v1-/);
    return true;
  });
});

test("CLI status and uninstall need no source after the one-time install import", async (context) => {
  const fixture = await serviceFixture(context);
  const key = makeOpenRouterKey("c");
  const poison = "cli-synthetic-poison";
  await writeEnvFile(fixture.envFilePath, `OPENROUTER_API_KEY=${key}\nSENTINEL=${poison}\n`);
  const base = [
    `--project-root=${fixture.projectRoot}`,
    `--home-directory=${fixture.homeDirectory}`,
    `--node-path=${fixture.nodePath}`,
  ];

  const install = await runCli(["install", ...base, `--env-file-path=${fixture.envFilePath}`]);
  assert.equal(install.code, 0, install.stderr);
  const installPayload = JSON.parse(install.stdout);
  assert.equal(installPayload.label, LAUNCH_AGENT_LABEL);
  assert.equal(installPayload.credentialSnapshotHealth, "valid");
  assert.doesNotMatch(install.stdout, new RegExp(key));
  assert.doesNotMatch(install.stdout, new RegExp(poison));
  assert.equal(install.stdout.includes(fixture.envFilePath), false);
  assert.equal(install.stderr, "");
  await rm(fixture.envFilePath);

  const status = await runCli(["status", ...base]);
  assert.equal(status.code, 0, status.stderr);
  const statusPayload = JSON.parse(status.stdout);
  assert.equal(statusPayload.installed, true);
  assert.equal(statusPayload.matchesDesired, true);
  assert.equal(statusPayload.credentialSnapshotHealth, "valid");
  assert.doesNotMatch(status.stdout, new RegExp(key));
  assert.equal(status.stderr, "");

  const uninstall = await runCli(["uninstall", ...base]);
  assert.equal(uninstall.code, 0, uninstall.stderr);
  const uninstallPayload = JSON.parse(uninstall.stdout);
  assert.equal(uninstallPayload.removed, true);
  assert.equal(uninstallPayload.credentialSnapshotRemoved, true);
  assert.equal(uninstallPayload.credentialSnapshotRecoverable, false);
  assert.doesNotMatch(uninstall.stdout, new RegExp(key));
  assert.equal(uninstall.stderr, "");
});

test("CLI failures redact a credential-shaped value embedded in a source filename", async (context) => {
  const fixture = await serviceFixture(context);
  const syntheticKey = makeOpenRouterKey("e");
  const missingSource = join(fixture.directory, `${syntheticKey}.env`);
  const result = await runCli([
    "install",
    `--project-root=${fixture.projectRoot}`,
    `--home-directory=${fixture.homeDirectory}`,
    `--node-path=${fixture.nodePath}`,
    `--env-file-path=${missingSource}`,
  ]);

  assert.equal(result.code, 1);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stderr, new RegExp(syntheticKey));
  assert.match(result.stderr, /\[redacted OpenRouter credential\]/);
  await assertMissing(resolveServicePaths(fixture).credentialSnapshotPath);
});

test("temporary roots and relative source paths are rejected before managed writes", async (context) => {
  const fixture = await serviceFixture(context);
  await writeEnvFile(fixture.envFilePath, `OPENROUTER_API_KEY=${makeOpenRouterKey("t")}\n`);
  await assert.rejects(
    installLaunchAgent({
      ...fixture,
      projectRoot: join(tmpdir(), "atlas-ephemeral-root"),
    }),
    /must not live under a temporary directory/,
  );
  await assert.rejects(
    installLaunchAgent({ ...fixture, envFilePath: "relative.env" }),
    /envFilePath must be an absolute path/,
  );
  await assertMissing(resolveServicePaths(fixture).credentialSnapshotPath);
});

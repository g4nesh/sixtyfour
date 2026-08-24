#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { readValidatedOpenRouterKeyFromEnvFile } from "./openrouter-env-file.mjs";

export const LAUNCH_AGENT_LABEL = "chat.ganstlr.atlas-backend";
export const DEFAULT_PORT = "3000";
export const DEFAULT_OPENROUTER_MODEL = "openai/gpt-5.4-nano";
export const DEFAULT_OPENROUTER_SITE_URL = "http://localhost:3000";
export const DEFAULT_OPENROUTER_APP_NAME = "Atlas";
export const LOCAL_HOSTNAME = "127.0.0.1";
export const MANAGED_CREDENTIAL_FILENAME = "openrouter.env";
const HOST_ENV_ALLOWLIST = ["HOME", "PATH", "TMPDIR", "LANG"];

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function plistString(value) {
  return `\t<string>${escapeXml(value)}</string>`;
}

function plistKey(value) {
  return `\t<key>${escapeXml(value)}</key>`;
}

function assertAbsolutePath(name, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} is required.`);
  }
  const trimmed = value.trim();
  if (!isAbsolute(trimmed)) throw new TypeError(`${name} must be an absolute path.`);
  const normalized = resolve(trimmed);
  return normalized;
}

function assertDurableProjectRoot(projectRoot) {
  const normalized = assertAbsolutePath("projectRoot", projectRoot);
  const disallowedPrefixes = ["/private/tmp", "/tmp", resolve(tmpdir())];
  if (disallowedPrefixes.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`))) {
    throw new TypeError("projectRoot must be durable and must not live under a temporary directory.");
  }
  return normalized;
}

export function resolveServicePaths({
  projectRoot,
  runtimeCredentialPath,
  nodePath = process.execPath,
  homeDirectory = homedir(),
  plistPath,
  stdoutPath,
  stderrPath,
  wranglerLogPath,
  miniflareRegistryPath,
} = {}) {
  const resolvedProjectRoot = assertDurableProjectRoot(projectRoot);
  const resolvedNodePath = assertAbsolutePath("nodePath", nodePath);
  const resolvedHomeDirectory = assertAbsolutePath("homeDirectory", homeDirectory);
  const logsDirectory = join(resolvedHomeDirectory, "Library/Logs/Atlas");
  const supportDirectory = join(resolvedHomeDirectory, "Library/Application Support/Atlas");
  const credentialSnapshotPath = join(supportDirectory, MANAGED_CREDENTIAL_FILENAME);
  if (
    runtimeCredentialPath !== undefined &&
    assertAbsolutePath("runtimeCredentialPath", runtimeCredentialPath) !== credentialSnapshotPath
  ) {
    throw new TypeError("runtimeCredentialPath must be the managed Atlas credential snapshot path.");
  }
  return {
    label: LAUNCH_AGENT_LABEL,
    projectRoot: resolvedProjectRoot,
    nodePath: resolvedNodePath,
    homeDirectory: resolvedHomeDirectory,
    launchAgentsDirectory: join(resolvedHomeDirectory, "Library/LaunchAgents"),
    logsDirectory,
    supportDirectory,
    credentialSnapshotPath,
    plistPath: plistPath
      ? assertAbsolutePath("plistPath", plistPath)
      : join(resolvedHomeDirectory, "Library/LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`),
    stdoutPath: stdoutPath ? assertAbsolutePath("stdoutPath", stdoutPath) : join(logsDirectory, "atlas.stdout.log"),
    stderrPath: stderrPath ? assertAbsolutePath("stderrPath", stderrPath) : join(logsDirectory, "atlas.stderr.log"),
    wranglerLogPath: wranglerLogPath
      ? assertAbsolutePath("wranglerLogPath", wranglerLogPath)
      : join(logsDirectory, "wrangler.log"),
    miniflareRegistryPath: miniflareRegistryPath
      ? assertAbsolutePath("miniflareRegistryPath", miniflareRegistryPath)
      : join(supportDirectory, "miniflare-registry"),
    entryScriptPath: join(resolvedProjectRoot, "scripts/macos-service.mjs"),
    vinextProdServerPath: join(resolvedProjectRoot, "node_modules/vinext/dist/server/prod-server.js"),
    distPath: join(resolvedProjectRoot, "dist"),
  };
}

export function buildLaunchAgentProgramArguments(paths) {
  return [
    "/usr/bin/caffeinate",
    "-i",
    paths.nodePath,
    paths.entryScriptPath,
    "bootstrap-localhost",
    `--project-root=${paths.projectRoot}`,
    `--runtime-credential-path=${paths.credentialSnapshotPath}`,
    `--home-directory=${paths.homeDirectory}`,
    `--wrangler-log-path=${paths.wranglerLogPath}`,
    `--miniflare-registry-path=${paths.miniflareRegistryPath}`,
  ];
}

export function createLaunchAgentPlistXml(options) {
  const paths = resolveServicePaths(options);
  const programArguments = buildLaunchAgentProgramArguments(paths)
    .map((value) => `\t\t${plistString(value).trimStart()}`)
    .join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    plistKey("Label"),
    plistString(paths.label),
    plistKey("ProgramArguments"),
    "\t<array>",
    programArguments,
    "\t</array>",
    plistKey("RunAtLoad"),
    "\t<true/>",
    plistKey("KeepAlive"),
    "\t<true/>",
    plistKey("ThrottleInterval"),
    "\t<integer>10</integer>",
    plistKey("ProcessType"),
    plistString("Background"),
    plistKey("WorkingDirectory"),
    plistString(paths.projectRoot),
    plistKey("StandardOutPath"),
    plistString(paths.stdoutPath),
    plistKey("StandardErrorPath"),
    plistString(paths.stderrPath),
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function selectHostBasics(paths, sourceEnvironment = process.env) {
  const hostBasics = Object.create(null);
  for (const key of HOST_ENV_ALLOWLIST) {
    const value = sourceEnvironment[key]?.trim();
    if (value) hostBasics[key] = value;
  }
  hostBasics.HOME ||= paths.homeDirectory;
  hostBasics.PATH ||= "/usr/bin:/bin:/usr/sbin:/sbin";
  hostBasics.LANG ||= "en_US.UTF-8";
  return hostBasics;
}

export function buildRunLocalhostEnvironment(options, hostEnvironment = process.env, openRouterKey) {
  const paths = resolveServicePaths(options);
  const environment = Object.create(null);
  const hostBasics = selectHostBasics(paths, hostEnvironment);
  for (const [key, value] of Object.entries(hostBasics)) {
    environment[key] = value;
  }
  environment.NODE_OPTIONS = "";
  environment.NODE_ENV = "production";
  environment.ATLAS_LIVE_ENABLED = "true";
  environment.ATLAS_ALLOW_UNAUTHENTICATED_LOCAL = "true";
  environment.LIVE_PROVIDER = "openrouter";
  environment.OPENROUTER_API_KEY = openRouterKey;
  environment.OPENROUTER_MODEL = DEFAULT_OPENROUTER_MODEL;
  environment.OPENROUTER_SITE_URL = DEFAULT_OPENROUTER_SITE_URL;
  environment.OPENROUTER_APP_NAME = DEFAULT_OPENROUTER_APP_NAME;
  environment.HOSTNAME = LOCAL_HOSTNAME;
  environment.PORT = DEFAULT_PORT;
  environment.WRANGLER_WRITE_LOGS = "false";
  environment.WRANGLER_LOG_PATH = paths.wranglerLogPath;
  environment.MINIFLARE_REGISTRY_PATH = paths.miniflareRegistryPath;
  return environment;
}

export async function buildRunLocalhostPlan(options, hostEnvironment = process.env) {
  const paths = resolveServicePaths(options);
  const openRouterKey = await readValidatedManagedOpenRouterKey(paths);
  return {
    cwd: paths.projectRoot,
    modulePath: paths.vinextProdServerPath,
    outDir: paths.distPath,
    host: LOCAL_HOSTNAME,
    port: Number(DEFAULT_PORT),
    env: buildRunLocalhostEnvironment(paths, hostEnvironment, openRouterKey),
  };
}

export function replaceProcessEnvironment(nextEnvironment, targetEnvironment = process.env) {
  for (const key of Object.keys(targetEnvironment)) {
    delete targetEnvironment[key];
  }
  for (const [key, value] of Object.entries(nextEnvironment)) {
    targetEnvironment[key] = value;
  }
}

async function closeServer(server) {
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}

function isMissingFileError(error) {
  return Boolean(error && typeof error === "object" && error.code === "ENOENT");
}

async function optionalLstat(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw error;
  }
}

function octalMode(stats) {
  return (stats.mode & 0o7777).toString(8).padStart(4, "0");
}

function managedDirectoryChain(paths) {
  return [
    paths.homeDirectory,
    join(paths.homeDirectory, "Library"),
    join(paths.homeDirectory, "Library/Application Support"),
    paths.supportDirectory,
  ];
}

async function inspectManagedDirectory(paths) {
  for (const path of managedDirectoryChain(paths)) {
    const stats = await optionalLstat(path);
    if (!stats) {
      return {
        present: false,
        safe: true,
        private: false,
        mode: null,
        health: "missing_parent",
      };
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      return {
        present: true,
        safe: false,
        private: false,
        mode: path === paths.supportDirectory ? octalMode(stats) : null,
        health: "unsafe_parent",
      };
    }
  }

  const supportStats = await lstat(paths.supportDirectory);
  const mode = octalMode(supportStats);
  return {
    present: true,
    safe: true,
    private: mode === "0700",
    mode,
    health: mode === "0700" ? "valid" : "unsafe_parent_mode",
  };
}

async function ensurePrivateManagedDirectory(paths) {
  const existing = await inspectManagedDirectory(paths);
  if (!existing.safe) {
    throw new TypeError("The managed Atlas credential directory must be a real directory without symlinks.");
  }
  await mkdir(paths.supportDirectory, { recursive: true, mode: 0o700 });
  let inspection = await inspectManagedDirectory(paths);
  if (!inspection.present || !inspection.safe) {
    throw new TypeError("The managed Atlas credential directory must be a real directory without symlinks.");
  }
  await chmod(paths.supportDirectory, 0o700);
  inspection = await inspectManagedDirectory(paths);
  if (!inspection.private) {
    throw new TypeError("The managed Atlas credential directory must use mode 0700.");
  }
}

async function inspectCredentialTarget(paths) {
  const stats = await optionalLstat(paths.credentialSnapshotPath);
  if (!stats) return { present: false, safe: true, mode: null };
  return {
    present: true,
    safe: !stats.isSymbolicLink() && stats.isFile(),
    mode: octalMode(stats),
  };
}

async function assertCredentialTargetSafe(paths) {
  const target = await inspectCredentialTarget(paths);
  if (target.present && !target.safe) {
    throw new TypeError("The managed Atlas credential snapshot must be a regular file without symlinks.");
  }
}

async function readValidatedManagedOpenRouterKey(paths) {
  const directory = await inspectManagedDirectory(paths);
  if (!directory.present || !directory.safe || !directory.private) {
    throw new TypeError(
      "The managed Atlas credential directory must be a private mode-0700 directory without symlinks.",
    );
  }
  const target = await inspectCredentialTarget(paths);
  if (!target.present || !target.safe || target.mode !== "0600") {
    throw new TypeError(
      "The managed Atlas credential snapshot must be a private mode-0600 regular file without symlinks.",
    );
  }
  const openRouterKey = await readValidatedOpenRouterKeyFromEnvFile(paths.credentialSnapshotPath);
  const afterRead = await inspectCredentialTarget(paths);
  if (!afterRead.present || !afterRead.safe || afterRead.mode !== "0600") {
    throw new TypeError("The managed Atlas credential snapshot changed during validation.");
  }
  return openRouterKey;
}

export async function inspectManagedCredentialSnapshot(options) {
  const paths = resolveServicePaths(options);
  const directory = await inspectManagedDirectory(paths);
  if (!directory.present || !directory.safe) {
    return {
      credentialDirectoryPresent: directory.present,
      credentialDirectorySafe: directory.safe,
      credentialDirectoryPrivate: directory.private,
      credentialDirectoryMode: directory.mode,
      credentialSnapshotPresent: false,
      credentialSnapshotSafe: false,
      credentialSnapshotPrivate: false,
      credentialSnapshotMode: null,
      credentialSnapshotValid: false,
      credentialSnapshotHealth: directory.health,
    };
  }

  const target = await inspectCredentialTarget(paths);
  if (!target.present) {
    return {
      credentialDirectoryPresent: true,
      credentialDirectorySafe: true,
      credentialDirectoryPrivate: directory.private,
      credentialDirectoryMode: directory.mode,
      credentialSnapshotPresent: false,
      credentialSnapshotSafe: true,
      credentialSnapshotPrivate: false,
      credentialSnapshotMode: null,
      credentialSnapshotValid: false,
      credentialSnapshotHealth: "missing",
    };
  }
  if (!target.safe) {
    return {
      credentialDirectoryPresent: true,
      credentialDirectorySafe: true,
      credentialDirectoryPrivate: directory.private,
      credentialDirectoryMode: directory.mode,
      credentialSnapshotPresent: true,
      credentialSnapshotSafe: false,
      credentialSnapshotPrivate: false,
      credentialSnapshotMode: target.mode,
      credentialSnapshotValid: false,
      credentialSnapshotHealth: "unsafe_type",
    };
  }

  const snapshotPrivate = target.mode === "0600";
  if (!directory.private || !snapshotPrivate) {
    return {
      credentialDirectoryPresent: true,
      credentialDirectorySafe: true,
      credentialDirectoryPrivate: directory.private,
      credentialDirectoryMode: directory.mode,
      credentialSnapshotPresent: true,
      credentialSnapshotSafe: true,
      credentialSnapshotPrivate: snapshotPrivate,
      credentialSnapshotMode: target.mode,
      credentialSnapshotValid: false,
      credentialSnapshotHealth: directory.private ? "unsafe_mode" : "unsafe_parent_mode",
    };
  }

  let valid = false;
  try {
    await readValidatedOpenRouterKeyFromEnvFile(paths.credentialSnapshotPath);
    valid = true;
  } catch {
    // Status reports only bounded health metadata; it never returns parser text or credential material.
  }
  return {
    credentialDirectoryPresent: true,
    credentialDirectorySafe: true,
    credentialDirectoryPrivate: true,
    credentialDirectoryMode: directory.mode,
    credentialSnapshotPresent: true,
    credentialSnapshotSafe: true,
    credentialSnapshotPrivate: true,
    credentialSnapshotMode: target.mode,
    credentialSnapshotValid: valid,
    credentialSnapshotHealth: valid ? "valid" : "invalid",
  };
}

async function writeAtomicFile(path, contents, mode = 0o600, beforeRename) {
  const directory = dirname(path);
  const temporaryPath = join(directory, `.atlas-${process.pid}-${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", mode, flag: "wx" });
    if (beforeRename) await beforeRename();
    await rename(temporaryPath, path);
    await chmod(path, mode);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function writeManagedCredentialSnapshot(paths, openRouterKey) {
  await ensurePrivateManagedDirectory(paths);
  await assertCredentialTargetSafe(paths);
  await writeAtomicFile(paths.credentialSnapshotPath, `OPENROUTER_API_KEY=${openRouterKey}\n`, 0o600, async () => {
    const directory = await inspectManagedDirectory(paths);
    if (!directory.safe || !directory.private) {
      throw new TypeError("The managed Atlas credential directory changed during installation.");
    }
    await assertCredentialTargetSafe(paths);
  });
  const inspection = await inspectManagedCredentialSnapshot(paths);
  if (inspection.credentialSnapshotHealth !== "valid") {
    throw new TypeError("The managed Atlas credential snapshot failed its private-file validation.");
  }
  return inspection;
}

export async function installLaunchAgent(options) {
  const sourceEnvFilePath = assertAbsolutePath("envFilePath", options?.envFilePath);
  const paths = resolveServicePaths(options);
  const openRouterKey = await readValidatedOpenRouterKeyFromEnvFile(sourceEnvFilePath);
  const xml = createLaunchAgentPlistXml(paths);
  const credentialInspection = await writeManagedCredentialSnapshot(paths, openRouterKey);
  await Promise.all([
    mkdir(dirname(paths.plistPath), { recursive: true, mode: 0o700 }),
    mkdir(dirname(paths.stdoutPath), { recursive: true, mode: 0o700 }),
    mkdir(dirname(paths.wranglerLogPath), { recursive: true, mode: 0o700 }),
  ]);
  await writeAtomicFile(paths.plistPath, xml, 0o600);
  return {
    ...paths,
    installed: true,
    plistXml: xml,
    ...credentialInspection,
    credentialSourceReadDuringInstall: true,
    credentialSourceRetainedByAtlas: false,
  };
}

async function removeExactFile(path) {
  try {
    await rm(path, { force: false });
    return true;
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    return false;
  }
}

async function assertRegularFileOrMissing(path, label) {
  const stats = await optionalLstat(path);
  if (stats && (stats.isSymbolicLink() || !stats.isFile())) {
    throw new TypeError(`${label} must be a regular file without symlinks.`);
  }
}

export async function uninstallLaunchAgent(options) {
  const paths = resolveServicePaths(options);
  const directory = await inspectManagedDirectory(paths);
  if (!directory.safe) {
    throw new TypeError("The managed Atlas credential directory must be a real directory without symlinks.");
  }
  await assertRegularFileOrMissing(paths.credentialSnapshotPath, "The managed Atlas credential snapshot");
  await assertRegularFileOrMissing(paths.plistPath, "The Atlas LaunchAgent plist");

  const credentialSnapshotRemoved = await removeExactFile(paths.credentialSnapshotPath);
  const plistRemoved = await removeExactFile(paths.plistPath);
  return {
    ...paths,
    removed: credentialSnapshotRemoved || plistRemoved,
    plistRemoved,
    credentialSnapshotRemoved,
    credentialSnapshotRecoverable: credentialSnapshotRemoved ? false : null,
    callerCredentialSourceTouched: false,
    logsPreserved: true,
    runtimeStatePreserved: true,
    recovery:
      "A removed managed snapshot is not recoverable; reinstall with the caller-owned source or a replacement credential file.",
  };
}

export async function statusLaunchAgent(options) {
  const paths = resolveServicePaths(options);
  const desiredXml = createLaunchAgentPlistXml(paths);
  const snapshot = await inspectManagedCredentialSnapshot(paths);
  const plistStats = await optionalLstat(paths.plistPath);
  if (!plistStats) {
    return {
      ...paths,
      installed: false,
      plistSafe: true,
      plistMatchesDesired: false,
      matchesDesired: false,
      ...snapshot,
    };
  }
  if (plistStats.isSymbolicLink() || !plistStats.isFile()) {
    return {
      ...paths,
      installed: true,
      plistSafe: false,
      plistMatchesDesired: false,
      matchesDesired: false,
      ...snapshot,
    };
  }

  try {
    const installedXml = await readFile(paths.plistPath, "utf8");
    const plistMatchesDesired = installedXml === desiredXml;
    return {
      ...paths,
      installed: true,
      plistSafe: true,
      plistMatchesDesired,
      matchesDesired: plistMatchesDesired && snapshot.credentialSnapshotHealth === "valid",
      ...snapshot,
    };
  } catch (error) {
    if (isMissingFileError(error)) {
      return {
        ...paths,
        installed: false,
        plistSafe: true,
        plistMatchesDesired: false,
        matchesDesired: false,
        ...snapshot,
      };
    }
    throw error;
  }
}

export async function bootstrapLocalhost(options) {
  const plan = await buildRunLocalhostPlan(options);
  replaceProcessEnvironment(plan.env);
  process.chdir(plan.cwd);
  const { startProdServer } = await import(pathToFileURL(plan.modulePath).href);
  const { server } = await startProdServer({
    host: plan.host,
    port: plan.port,
    outDir: plan.outDir,
  });
  return await new Promise((resolveCode, rejectCode) => {
    let closing = false;
    const cleanup = () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      server.off("close", onClose);
      server.off("error", onError);
    };
    const onClose = () => {
      cleanup();
      resolveCode(0);
    };
    const onError = (error) => {
      cleanup();
      rejectCode(error);
    };
    const onSignal = () => {
      if (closing) return;
      closing = true;
      void closeServer(server).catch(onError);
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    server.once("close", onClose);
    server.once("error", onError);
  });
}

function parseCommandLine(arguments_) {
  const [command, ...rest] = arguments_;
  const options = {};
  for (const argument of rest) {
    const match = /^--([^=]+)=(.*)$/.exec(argument);
    if (!match) throw new TypeError(`Unsupported argument: ${argument}`);
    const [, key, value] = match;
    if (Object.hasOwn(options, key)) throw new TypeError(`Duplicate argument: --${key}`);
    options[key] = value;
  }
  if (!command) throw new TypeError("A command is required.");
  return { command, options };
}

function cliOptions(rawOptions) {
  return {
    projectRoot: rawOptions["project-root"],
    envFilePath: rawOptions["env-file-path"],
    runtimeCredentialPath: rawOptions["runtime-credential-path"],
    homeDirectory: rawOptions["home-directory"],
    nodePath: rawOptions["node-path"],
    plistPath: rawOptions["plist-path"],
    stdoutPath: rawOptions["stdout-path"],
    stderrPath: rawOptions["stderr-path"],
    wranglerLogPath: rawOptions["wrangler-log-path"],
    miniflareRegistryPath: rawOptions["miniflare-registry-path"],
  };
}

async function main() {
  const { command, options } = parseCommandLine(process.argv.slice(2));
  const resolvedOptions = cliOptions(options);
  if (command === "install") {
    process.stdout.write(`${JSON.stringify(await installLaunchAgent(resolvedOptions), null, 2)}\n`);
    return;
  }
  if (command === "uninstall") {
    process.stdout.write(`${JSON.stringify(await uninstallLaunchAgent(resolvedOptions), null, 2)}\n`);
    return;
  }
  if (command === "status") {
    process.stdout.write(`${JSON.stringify(await statusLaunchAgent(resolvedOptions), null, 2)}\n`);
    return;
  }
  if (command === "bootstrap-localhost") {
    process.exitCode = await bootstrapLocalhost(resolvedOptions);
    return;
  }
  throw new TypeError(`Unknown command: ${command}`);
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "macOS service command failed.";
    process.stderr.write(
      `${message.replace(/\bsk-or-v1-[A-Za-z0-9_-]{12,}\b/g, "[redacted OpenRouter credential]")}\n`,
    );
    process.exitCode = 1;
  });
}

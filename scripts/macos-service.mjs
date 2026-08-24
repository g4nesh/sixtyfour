#!/usr/bin/env node

import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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
  envFilePath,
  nodePath = process.execPath,
  homeDirectory = homedir(),
  plistPath,
  stdoutPath,
  stderrPath,
  wranglerLogPath,
  miniflareRegistryPath,
} = {}) {
  const resolvedProjectRoot = assertDurableProjectRoot(projectRoot);
  const resolvedEnvFilePath = assertAbsolutePath("envFilePath", envFilePath);
  const resolvedNodePath = assertAbsolutePath("nodePath", nodePath);
  const resolvedHomeDirectory = assertAbsolutePath("homeDirectory", homeDirectory);
  const logsDirectory = join(resolvedHomeDirectory, "Library/Logs/Atlas");
  const supportDirectory = join(resolvedHomeDirectory, "Library/Application Support/Atlas");
  return {
    label: LAUNCH_AGENT_LABEL,
    projectRoot: resolvedProjectRoot,
    envFilePath: resolvedEnvFilePath,
    nodePath: resolvedNodePath,
    homeDirectory: resolvedHomeDirectory,
    launchAgentsDirectory: join(resolvedHomeDirectory, "Library/LaunchAgents"),
    logsDirectory,
    supportDirectory,
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
    `--env-file-path=${paths.envFilePath}`,
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
  const openRouterKey = await readValidatedOpenRouterKeyFromEnvFile(paths.envFilePath);
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

async function writeAtomicFile(path, contents, mode = 0o600) {
  const directory = dirname(path);
  const temporaryPath = join(directory, `.${process.pid}.${Date.now()}.tmp`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(temporaryPath, contents, { encoding: "utf8", mode, flag: "wx" });
  await rename(temporaryPath, path);
  await chmod(path, mode);
}

export async function installLaunchAgent(options) {
  const paths = resolveServicePaths(options);
  const xml = createLaunchAgentPlistXml(paths);
  await Promise.all([
    mkdir(dirname(paths.plistPath), { recursive: true, mode: 0o700 }),
    mkdir(dirname(paths.stdoutPath), { recursive: true, mode: 0o700 }),
    mkdir(dirname(paths.wranglerLogPath), { recursive: true, mode: 0o700 }),
    mkdir(dirname(paths.miniflareRegistryPath), { recursive: true, mode: 0o700 }),
  ]);
  await writeAtomicFile(paths.plistPath, xml, 0o600);
  return { ...paths, plistXml: xml };
}

export async function uninstallLaunchAgent(options) {
  const paths = resolveServicePaths(options);
  let removed = false;
  try {
    await rm(paths.plistPath, { force: false });
    removed = true;
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
  }
  return { ...paths, removed };
}

export async function statusLaunchAgent(options) {
  const paths = resolveServicePaths(options);
  try {
    const installedXml = await readFile(paths.plistPath, "utf8");
    const desiredXml = createLaunchAgentPlistXml(paths);
    return {
      ...paths,
      installed: true,
      matchesDesired: installedXml === desiredXml,
    };
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return {
        ...paths,
        installed: false,
        matchesDesired: false,
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
    options[key] = value;
  }
  if (!command) throw new TypeError("A command is required.");
  return { command, options };
}

function cliOptions(rawOptions) {
  return {
    projectRoot: rawOptions["project-root"],
    envFilePath: rawOptions["env-file-path"],
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
    process.stderr.write(`${error instanceof Error ? error.message : "macOS service command failed."}\n`);
    process.exitCode = 1;
  });
}

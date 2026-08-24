#!/usr/bin/env node

import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readValidatedOpenRouterKeyFromEnvFile } from "./openrouter-env-file.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const credentialVariable = "OPENROUTER_API_KEY";
const safeRuntimeVariables = new Set(["HOME", "PATH", "TMPDIR", "LANG"]);

export const LOCAL_OPENROUTER_SETTINGS = Object.freeze({
  ATLAS_LIVE_ENABLED: "true",
  ATLAS_ALLOW_UNAUTHENTICATED_LOCAL: "true",
  LIVE_PROVIDER: "openrouter",
  OPENROUTER_MODEL: "openai/gpt-5.4-nano",
  OPENROUTER_SITE_URL: "http://localhost:3000",
  OPENROUTER_APP_NAME: "Atlas",
  NODE_OPTIONS: "",
  NODE_ENV: "production",
  HOSTNAME: "127.0.0.1",
  PORT: "3000",
  WRANGLER_WRITE_LOGS: "false",
  WRANGLER_LOG_PATH: resolve(projectRoot, ".wrangler/wrangler.log"),
  MINIFLARE_REGISTRY_PATH: resolve(projectRoot, ".wrangler/miniflare-registry"),
});

export const LOCAL_PRODUCTION_SERVER = Object.freeze({
  cwd: projectRoot,
  modulePath: resolve(projectRoot, "node_modules/vinext/dist/server/prod-server.js"),
  outDir: resolve(projectRoot, "dist"),
  host: "127.0.0.1",
  port: 3000,
});

function usage() {
  return [
    "Usage:",
    "  npm run local:openrouter -- --credentials-file /absolute/path/to/credentials",
    "  npm run local:openrouter:check -- --credentials-file /absolute/path/to/credentials",
    "",
    "Only OPENROUTER_API_KEY is consumed from the selected file.",
  ].join("\n");
}

export function parseLocalOpenRouterArguments(arguments_, cwd = process.cwd()) {
  let checkOnly = false;
  let environmentPath;
  let help = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--check") {
      if (checkOnly) throw new Error("--check may be supplied only once.");
      checkOnly = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      if (help) throw new Error("--help may be supplied only once.");
      help = true;
      continue;
    }
    if (argument === "--credentials-file") {
      if (environmentPath) throw new Error("--credentials-file may be supplied only once.");
      const value = arguments_[index + 1];
      if (!value || value.startsWith("-")) throw new Error("--credentials-file requires a path.");
      environmentPath = resolve(cwd, value);
      index += 1;
      continue;
    }
    if (argument.startsWith("--credentials-file=")) {
      if (environmentPath) throw new Error("--credentials-file may be supplied only once.");
      const value = argument.slice("--credentials-file=".length);
      if (!value) throw new Error("--credentials-file requires a path.");
      environmentPath = resolve(cwd, value);
      continue;
    }
    throw new Error(`Unsupported argument: ${argument}`);
  }

  if (help) {
    if (environmentPath || checkOnly || arguments_.length !== 1) {
      throw new Error("--help cannot be combined with other arguments.");
    }
    return { help: true, checkOnly: false, environmentPath: null };
  }
  if (!environmentPath) throw new Error("A caller-selected --credentials-file path is required.");
  return { help: false, checkOnly, environmentPath };
}

function selectedRuntimeEnvironment(sourceEnvironment) {
  const selected = {};
  for (const variable of safeRuntimeVariables) {
    const value = sourceEnvironment[variable]?.trim();
    if (value && value.length <= 4_096) selected[variable] = value;
  }
  selected.HOME ||= homedir();
  selected.PATH ||= "/usr/bin:/bin:/usr/sbin:/sbin";
  selected.LANG ||= "en_US.UTF-8";
  return selected;
}

export function localOpenRouterEnvironment(sourceEnvironment, openRouterKey) {
  return {
    ...selectedRuntimeEnvironment(sourceEnvironment),
    ...LOCAL_OPENROUTER_SETTINGS,
    [credentialVariable]: openRouterKey,
  };
}

export async function resolveLocalOpenRouterEnvironment(environmentPath, sourceEnvironment = process.env) {
  const openRouterKey = await readValidatedOpenRouterKeyFromEnvFile(environmentPath);
  return localOpenRouterEnvironment(sourceEnvironment, openRouterKey);
}

function replaceCurrentEnvironment(environment) {
  for (const variable of Object.keys(process.env)) delete process.env[variable];
  Object.assign(process.env, environment);
}

function redactCredential(value) {
  return value.replace(/\bsk-or-v1-[A-Za-z0-9_-]{12,}\b/g, "[redacted OpenRouter credential]");
}

async function closeServer(server) {
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}

async function startLocalProductionServer(environment) {
  replaceCurrentEnvironment(environment);
  process.chdir(LOCAL_PRODUCTION_SERVER.cwd);
  const { startProdServer } = await import(pathToFileURL(LOCAL_PRODUCTION_SERVER.modulePath).href);
  const { server } = await startProdServer({
    host: LOCAL_PRODUCTION_SERVER.host,
    port: LOCAL_PRODUCTION_SERVER.port,
    outDir: LOCAL_PRODUCTION_SERVER.outDir,
  });
  await new Promise((resolveServer, rejectServer) => {
    let closing = false;
    const cleanup = () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      server.off("close", onClose);
      server.off("error", onError);
    };
    const onClose = () => {
      cleanup();
      resolveServer();
    };
    const onError = (error) => {
      cleanup();
      rejectServer(error);
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

async function runLocalOpenRouter(environmentPath, checkOnly) {
  const environment = await resolveLocalOpenRouterEnvironment(environmentPath);
  if (checkOnly) {
    process.stdout.write(
      [
        "Atlas local OpenRouter configuration is valid.",
        "Binding: http://127.0.0.1:3000",
        "Browser URL: http://localhost:3000",
        `Model: ${LOCAL_OPENROUTER_SETTINGS.OPENROUTER_MODEL}`,
        "Runtime: prebuilt Vinext production server",
        "Credential: loaded (value not displayed)",
        "No server was started.",
      ].join("\n") + "\n",
    );
    return;
  }

  process.stdout.write(
    "Starting the prebuilt Atlas production server on loopback http://127.0.0.1:3000. The OpenRouter credential value will not be displayed.\n",
  );
  await startLocalProductionServer(environment);
}

async function main() {
  const arguments_ = process.argv.slice(2);
  const parsed = parseLocalOpenRouterArguments(arguments_);
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  await runLocalOpenRouter(parsed.environmentPath, parsed.checkOnly);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "Atlas local startup failed.";
    process.stderr.write(`${redactCredential(message)}\n${usage()}\n`);
    process.exitCode = 1;
  });
}

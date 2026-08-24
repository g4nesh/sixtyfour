#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import process from "node:process";

const secretBindings = [
  {
    fileVariable: "OPENROUTER_API_KEY_FILE",
    targetVariable: "OPENROUTER_API_KEY",
    validate(value) {
      return /^sk-or-v1-[A-Za-z0-9_-]{32,}$/.test(value);
    },
  },
  {
    fileVariable: "ATLAS_API_TOKEN_FILE",
    targetVariable: "ATLAS_API_TOKEN",
    validate(value) {
      return !/\s/.test(value) && new TextEncoder().encode(value).byteLength >= 32;
    },
  },
];

export async function resolvedEnvironment(sourceEnvironment = process.env) {
  const environment = { ...sourceEnvironment };
  const liveEnabled = environment.ATLAS_LIVE_ENABLED?.trim() === "true";
  for (const binding of secretBindings) {
    const inlineValue = environment[binding.targetVariable]?.trim();
    const path = environment[binding.fileVariable]?.trim();
    if (inlineValue && path) {
      throw new Error(`${binding.targetVariable} and ${binding.fileVariable} cannot both be set.`);
    }
    if (!inlineValue && !path) {
      if (liveEnabled) throw new Error(`${binding.targetVariable} or ${binding.fileVariable} is required.`);
      continue;
    }
    const value = path ? (await readFile(path, "utf8")).trim() : inlineValue;
    const sourceVariable = path ? binding.fileVariable : binding.targetVariable;
    if (!binding.validate(value)) throw new Error(`${sourceVariable} did not contain a valid secret.`);
    environment[binding.targetVariable] = value;
    delete environment[binding.fileVariable];
  }
  return environment;
}

async function main() {
  const environment = await resolvedEnvironment();
  environment.WRANGLER_LOG_PATH ||= "/tmp/atlas-wrangler.log";
  const child = spawn(process.execPath, ["node_modules/vinext/dist/cli.js", "start"], {
    env: environment,
    stdio: "inherit",
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => child.kill(signal));
  }
  child.once("error", (error) => {
    process.stderr.write(`Atlas failed to start: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Container startup failed."}\n`);
    process.exitCode = 1;
  });
}

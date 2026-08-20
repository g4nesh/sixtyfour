import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const ignoredDirectories = new Set([
  ".agent",
  ".git",
  ".next",
  ".vinext",
  ".wrangler",
  "dist",
  "node_modules",
  "output",
  "public",
  "tmp",
]);
const ignoredFiles = new Set([".env", ".dev.vars", "package-lock.json"]);
const textExtensions = new Set([
  "",
  ".css",
  ".example",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);
const signatures = [
  ["OpenAI API key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g],
  ["OpenRouter API key", /\bsk-or-v1-[A-Za-z0-9]{32,}\b/g],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["Slack token", /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/g],
  ["private key", /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/g],
];

async function filesUnder(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    if (!entry.isDirectory() && ignoredFiles.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(path)));
    else if (textExtensions.has(extname(entry.name))) files.push(path);
  }
  return files;
}

const findings = [];
for (const path of await filesUnder(root)) {
  const source = await readFile(path, "utf8");
  const lines = source.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.includes("secret-scan: allow")) continue;
    for (const [label, pattern] of signatures) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) findings.push(`${relative(root, path)}:${index + 1} (${label})`);
    }
  }
}

if (findings.length > 0) {
  console.error("Potential committed secrets detected (values redacted):");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log("Secret scan passed: no known credential signatures found in repository text files.");
}

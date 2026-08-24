import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("../scripts/configure-openrouter-container.mjs", import.meta.url);

async function configure(directory, key, args = []) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script.pathname, ...args], {
      cwd: directory,
      stdio: ["pipe", "pipe", "pipe"],
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
    child.once("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || `Configuration exited ${code}.`));
    });
    child.stdin.end(`${key}\n`);
  });
}

test("container configuration writes only ignored private secret files and pins OpenRouter", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-openrouter-config-"));
  const firstKey = `sk-or-v1-${"a".repeat(48)}`;
  const secondKey = `sk-or-v1-${"b".repeat(48)}`;

  const first = await configure(directory, firstKey);
  assert.match(first.stdout, /OpenRouter container secrets configured/);
  assert.equal(first.stdout.includes(firstKey), false);
  assert.equal(first.stderr.includes(firstKey), false);

  const environment = await readFile(join(directory, ".env.atlas"), "utf8");
  const storedKey = await readFile(join(directory, "secrets/openrouter_api_key"), "utf8");
  const token = (await readFile(join(directory, "secrets/atlas_api_token"), "utf8")).trim();
  assert.match(environment, /^ATLAS_ALLOW_UNAUTHENTICATED_LOCAL=true$/m);
  assert.match(environment, /^LIVE_PROVIDER=openrouter$/m);
  assert.match(environment, /^OPENROUTER_MODEL=openai\/gpt-5\.4-mini$/m);
  assert.equal(environment.includes(firstKey), false);
  assert.equal(storedKey.trim(), firstKey);
  assert.ok(token.length >= 64);
  assert.equal((await stat(join(directory, "secrets"))).mode & 0o777, 0o700);
  assert.equal((await stat(join(directory, "secrets/openrouter_api_key"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, "secrets/atlas_api_token"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, ".env.atlas"))).mode & 0o777, 0o600);

  await assert.rejects(configure(directory, secondKey), /already exists/);
  const rotated = await configure(directory, secondKey, ["--rotate"]);
  assert.equal(rotated.stdout.includes(secondKey), false);
  assert.equal((await readFile(join(directory, "secrets/openrouter_api_key"), "utf8")).trim(), secondKey);
  assert.equal(
    (await readFile(join(directory, "secrets/atlas_api_token"), "utf8")).trim(),
    token,
    "provider-key rotation must not invalidate active Atlas access sessions",
  );
});

test("container configuration rejects non-OpenRouter credentials without writing them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-openrouter-reject-"));
  await assert.rejects(configure(directory, `sk-${"x".repeat(64)}`), /Expected a replacement OpenRouter API key/);
});

test("container configuration validates an existing policy file before rotating a secret", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atlas-openrouter-policy-"));
  await writeFile(join(directory, ".env.atlas"), "LIVE_PROVIDER=openai\n", "utf8");

  await assert.rejects(
    configure(directory, `sk-or-v1-${"c".repeat(48)}`, ["--rotate"]),
    /is not pinned to LIVE_PROVIDER=openrouter/,
  );
  await assert.rejects(readFile(join(directory, "secrets/openrouter_api_key"), "utf8"), { code: "ENOENT" });
});

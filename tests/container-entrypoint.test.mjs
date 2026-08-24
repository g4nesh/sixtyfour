import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolvedEnvironment } from "../scripts/container-entrypoint.mjs";

async function secretFiles() {
  const directory = await mkdtemp(join(tmpdir(), "atlas-container-entrypoint-"));
  const openRouterPath = join(directory, "openrouter_api_key");
  const atlasTokenPath = join(directory, "atlas_api_token");
  await Promise.all([
    writeFile(openRouterPath, `sk-or-v1-${"r".repeat(48)}\n`, { mode: 0o600 }),
    writeFile(atlasTokenPath, `${"t".repeat(48)}\n`, { mode: 0o600 }),
  ]);
  return { openRouterPath, atlasTokenPath };
}

test("container entrypoint resolves only the two mounted secret files", async () => {
  const { openRouterPath, atlasTokenPath } = await secretFiles();
  const source = {
    NODE_ENV: "production",
    OPENROUTER_API_KEY_FILE: openRouterPath,
    ATLAS_API_TOKEN_FILE: atlasTokenPath,
  };
  const environment = await resolvedEnvironment(source);

  assert.equal(environment.OPENROUTER_API_KEY, `sk-or-v1-${"r".repeat(48)}`);
  assert.equal(environment.ATLAS_API_TOKEN, "t".repeat(48));
  assert.equal("OPENROUTER_API_KEY_FILE" in environment, false);
  assert.equal("ATLAS_API_TOKEN_FILE" in environment, false);
  assert.equal(environment.NODE_ENV, "production");
  assert.equal("OPENROUTER_API_KEY" in source, false, "the source environment must not be mutated");
});

test("container entrypoint permits an explicitly credential-free replay-only image", async () => {
  assert.deepEqual(await resolvedEnvironment({ NODE_ENV: "production" }), { NODE_ENV: "production" });
});

test("container entrypoint accepts runtime secret injection but rejects ambiguity, missing live secrets, and invalid keys", async () => {
  const { openRouterPath, atlasTokenPath } = await secretFiles();
  const files = { OPENROUTER_API_KEY_FILE: openRouterPath, ATLAS_API_TOKEN_FILE: atlasTokenPath };

  const inline = await resolvedEnvironment({
    ATLAS_LIVE_ENABLED: "true",
    OPENROUTER_API_KEY: `sk-or-v1-${"i".repeat(48)}`,
    ATLAS_API_TOKEN: "a".repeat(48),
  });
  assert.equal(inline.OPENROUTER_API_KEY, `sk-or-v1-${"i".repeat(48)}`);
  assert.equal(inline.ATLAS_API_TOKEN, "a".repeat(48));

  await assert.rejects(
    resolvedEnvironment({ ...files, OPENROUTER_API_KEY: "inline-secret" }),
    /OPENROUTER_API_KEY and OPENROUTER_API_KEY_FILE cannot both be set/,
  );
  await assert.rejects(
    resolvedEnvironment({ ATLAS_LIVE_ENABLED: "true" }),
    /OPENROUTER_API_KEY or OPENROUTER_API_KEY_FILE is required/,
  );
  await assert.rejects(
    resolvedEnvironment({ ATLAS_LIVE_ENABLED: "true", ATLAS_API_TOKEN_FILE: atlasTokenPath }),
    /OPENROUTER_API_KEY or OPENROUTER_API_KEY_FILE is required/,
  );

  const invalidOpenRouterPath = join(await mkdtemp(join(tmpdir(), "atlas-container-invalid-")), "provider_key");
  await writeFile(invalidOpenRouterPath, `sk-${"x".repeat(64)}\n`, { mode: 0o600 });
  await assert.rejects(
    resolvedEnvironment({ ...files, OPENROUTER_API_KEY_FILE: invalidOpenRouterPath }),
    /OPENROUTER_API_KEY_FILE did not contain a valid secret/,
  );
});

test("Compose mounts generated files as Docker secrets without interpolating raw credentials", async () => {
  const [compose, dockerfile, dockerIgnore, packageJson, secretScanner] = await Promise.all([
    readFile(new URL("../compose.yaml", import.meta.url), "utf8"),
    readFile(new URL("../Dockerfile", import.meta.url), "utf8"),
    readFile(new URL("../.dockerignore", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../scripts/check-secrets.mjs", import.meta.url), "utf8"),
  ]);

  assert.match(compose, /ATLAS_API_TOKEN_FILE: \/run\/secrets\/atlas_api_token/);
  assert.match(compose, /OPENROUTER_API_KEY_FILE: \/run\/secrets\/openrouter_api_key/);
  assert.match(compose, /ATLAS_ALLOW_UNAUTHENTICATED_LOCAL: \$\{ATLAS_ALLOW_UNAUTHENTICATED_LOCAL:-true\}/);
  assert.match(compose, /file: \$\{ATLAS_API_TOKEN_FILE:\?Run npm run container:configure first\}/);
  assert.match(compose, /file: \$\{OPENROUTER_API_KEY_FILE:\?Run npm run container:configure first\}/);
  assert.doesNotMatch(compose, /^\s+ATLAS_API_TOKEN:/m);
  assert.doesNotMatch(compose, /^\s+OPENROUTER_API_KEY:/m);
  assert.doesNotMatch(compose, /OPENAI_API_KEY|GEMINI_API_KEY|ANTHROPIC_API_KEY|LIVE_SEARCH_PROVIDER/);
  assert.match(dockerfile, /^FROM node:22\.13-alpine AS dependencies$/m);
  assert.match(dockerfile, /^FROM node:22\.13-alpine AS runner$/m);
  assert.match(dockerfile, /process\.env\.PORT\|\|'3000'/);
  assert.match(dockerfile, /ENTRYPOINT \["node", "scripts\/container-entrypoint\.mjs"\]/);
  assert.match(dockerIgnore, /(?:^|\n)\.github(?:\n|$)/);
  assert.match(dockerIgnore, /(?:^|\n)secrets(?:\n|$)/);
  assert.equal(JSON.parse(packageJson).scripts["container:up"].includes("--force-recreate"), true);
  assert.match(secretScanner, /sk-or-v1-\[A-Za-z0-9_-\]\{32,\}/);
});

const continuousIntegrationUrl = new URL("../.github/workflows/ci.yml", import.meta.url);

test(
  "CI smoke-tests the container on a non-default internal port",
  {
    skip: !existsSync(continuousIntegrationUrl) && "workflow metadata is intentionally absent from the Docker context",
  },
  async () => {
    const continuousIntegration = await readFile(continuousIntegrationUrl, "utf8");
    assert.match(continuousIntegration, /--env PORT=8080 --publish 127\.0\.0\.1:3000:8080/);
  },
);

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const blueprintUrl = new URL("../render.yaml", import.meta.url);

test("Render Blueprint exposes the verified image with authenticated OpenRouter-only live ingress", async () => {
  const blueprint = await readFile(blueprintUrl, "utf8");
  const lines = new Set(blueprint.split("\n"));

  assert.match(blueprint, /^# yaml-language-server: \$schema=https:\/\/render\.com\/schema\/render\.yaml\.json$/m);
  for (const line of [
    "  generation: off",
    "  - type: web",
    "    name: atlas",
    "    runtime: docker",
    "    plan: free",
    "    numInstances: 1",
    "    branch: main",
    "    autoDeployTrigger: checksPass",
    "    renderSubdomainPolicy: enabled",
    "    healthCheckPath: /api/health",
    "    dockerfilePath: ./Dockerfile",
    "    dockerContext: .",
  ]) {
    assert.ok(lines.has(line), `Blueprint is missing: ${line.trim()}`);
  }

  for (const block of [
    '- key: ATLAS_LIVE_ENABLED\n        value: "true"',
    '- key: ATLAS_ALLOW_UNAUTHENTICATED_LOCAL\n        value: "false"',
    "- key: LIVE_PROVIDER\n        value: openrouter",
    "- key: OPENROUTER_MODEL\n        value: openai/gpt-5.4-nano",
    "- key: OPENROUTER_APP_NAME\n        value: Atlas",
    "- key: OPENROUTER_SITE_URL\n" +
      "        fromService:\n" +
      "          type: web\n" +
      "          name: atlas\n" +
      "          envVarKey: RENDER_EXTERNAL_URL",
  ]) {
    assert.ok(blueprint.includes(block), `Blueprint is missing the required block for ${block.split("\n")[0]}`);
  }

  for (const key of ["OPENROUTER_API_KEY", "ATLAS_API_TOKEN"]) {
    assert.ok(blueprint.includes(`- key: ${key}\n        sync: false`));
    assert.equal(blueprint.includes(`- key: ${key}\n        value:`), false);
  }

  assert.equal(blueprint.includes('ATLAS_ALLOW_UNAUTHENTICATED_LOCAL\n        value: "true"'), false);
  assert.doesNotMatch(blueprint, /NEXT_PUBLIC_|OPENAI_API_KEY|GEMINI_API_KEY|ANTHROPIC_API_KEY|LIVE_SEARCH_PROVIDER/);
  assert.doesNotMatch(blueprint, /\bsk-(?:or-v1-)?[A-Za-z0-9_-]{32,}\b/);
});

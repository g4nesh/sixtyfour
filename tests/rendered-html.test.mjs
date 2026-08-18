import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Atlas investigation workspace", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Atlas — People Intelligence<\/title>/i);
  assert.match(html, /Investigate a person, not just a name\./);
  assert.match(html, /Auditable public-source research/);
  assert.match(html, /Email → codegraph/);
  assert.match(html, /Same-name separation/);
  assert.match(html, /Role-only resolution/);
  assert.match(html, /class="view-tabs" role="group"/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /Public professional scope only/);
  assert.match(html, /<main id="main-content"/);
  assert.doesNotMatch(html, /Henry Wang|Illustrative public-source run|aria-valuenow="72"/i);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("built Worker health remains available when local bindings are absent", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("health-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(
    new Request("http://localhost/api/health"),
    undefined,
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.status, "ok");
  assert.equal(payload.liveConfigured, false);
  assert.equal(payload.exampleCount, 3);
});

test("built Worker image route fails closed when local bindings are absent", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("image-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(
    new Request("http://localhost/_vinext/image?url=%2Fportrait.png&w=640&q=80"),
    undefined,
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(response.status, 503);
  assert.equal(await response.text(), "Image binding unavailable");
});

test("removes the starter preview and preserves static accessibility foundations", async () => {
  const [page, workbench, layout, css, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/workbench.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  await assert.rejects(access(new URL("app/_sites-preview", projectRoot)));
  assert.doesNotMatch(page, /SkeletonPreview|<svg|dangerouslySetInnerHTML/);
  assert.doesNotMatch(layout, /codex-preview|Starter Project|favicon\.svg/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.match(page, /AtlasWorkbench/);
  assert.match(workbench, /<label htmlFor="target">/);
  assert.match(workbench, /aria-live|role="status"/);
  assert.match(workbench, /aria-describedby="target-help"/);
  assert.match(workbench, /className="view-tabs" role="group"/);
  assert.match(workbench, /aria-pressed=\{activeTab === tab\}/);
  assert.doesNotMatch(workbench, /role="tab(?:list|panel)?"/);
  assert.match(workbench, /role="region" aria-labelledby="tab-dossier"/);
  assert.match(workbench, /ArrowRight/);
  assert.match(workbench, /Sanitized arguments/);
  assert.match(workbench, /AbortController/);
  assert.match(workbench, /\/api\/research/);
  assert.doesNotMatch(workbench, /Henry Wang|fake live|dangerouslySetInnerHTML/i);
  assert.match(workbench, /\.filter\(\(item\) => !candidateId \|\| item\.candidateId === candidateId\)/);
  assert.match(workbench, /onClick=\{focusEvidence\}/);
  assert.match(workbench, /if \(nextMode === mode\) return/);
  assert.match(workbench, /Live mode is disabled or missing server configuration/);
  assert.match(workbench, /server setup/);
  assert.match(workbench, /"report", "terminal"/);
  assert.match(workbench, /exact source excerpts or canonical API claims/);
  assert.match(workbench, /Canonical API claim/);
  assert.match(workbench, /elapsed since run start/);
  assert.match(workbench, /`t\+\$\{/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /\.canonical-claim/);
  assert.match(css, /grid-template-columns:\s*repeat\(9, 1fr\)/);
  assert.match(css, /grid-template-columns:\s*repeat\(3, 1fr\)/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /@media \(max-width: (?:680|900)px\)/);
  assert.match(css, /@media \(max-width: (?:390|410)px\)/);
});

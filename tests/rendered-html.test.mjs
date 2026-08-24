import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

async function listFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
    if (entry.isDirectory()) files.push(...(await listFiles(absolute)));
    else files.push(absolute);
  }
  return files;
}

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

test("config-less SSR loaders cannot overwrite the live Vite dependency cache", async () => {
  const roots = [
    new URL("../tests/", import.meta.url),
    new URL("../scripts/", import.meta.url),
    new URL("../bin/", import.meta.url),
  ];
  const files = (await Promise.all(roots.map(listFiles))).flat();
  const loaders = [];
  for (const file of files) {
    if (!/\.(?:mjs|js|ts)$/.test(file.pathname)) continue;
    const source = await readFile(file, "utf8");
    if (!/configFile:\s*false/.test(source)) continue;
    loaders.push(file.pathname);
    assert.match(
      source,
      /configFile:\s*false,\s*cacheDir:\s*`node_modules\/\.vite-atlas-ssr\/\$\{process\.pid\}`/,
      `${file.pathname} shares Vite's live client cache`,
    );
  }
  assert.ok(loaders.length > 0, "expected at least one config-less SSR loader");
});

test("production builds and Docker contexts exclude ignored local demo fixtures", async () => {
  const [viteConfig, dockerIgnore] = await Promise.all([
    readFile(new URL("../vite.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../.dockerignore", import.meta.url), "utf8"),
  ]);
  assert.match(viteConfig, /localDemoFixturesPlugin\(command === ["']serve["']\)/);
  assert.match(dockerIgnore, /(?:^|\n)local-demo(?:\n|$)/);
});

test("server-renders the black graph-first Atlas workspace", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  assert.equal(
    response.headers.get("content-security-policy"),
    [
      "default-src 'self'",
      "base-uri 'self'",
      "connect-src 'self' data:",
      "font-src 'self' data:",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "img-src 'self' data: blob:",
      "object-src 'none'",
      "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "worker-src 'self' blob:",
    ].join("; "),
  );
  assert.equal(response.headers.get("cross-origin-opener-policy"), "same-origin");
  assert.equal(
    response.headers.get("permissions-policy"),
    "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  );
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-frame-options"), "DENY");

  const html = await response.text();
  assert.match(html, /<title>Atlas<\/title>/i);
  assert.doesNotMatch(html, /Atlas\s*(?:—|-)\s*People Intelligence/i);
  assert.match(html, /class="atlas-shell"/);
  assert.match(html, /Public-professional research input/);
  assert.match(html, /Any public context: name, role, company, city\/region, adult school, URL, or handle/);
  assert.match(html, /<strong>Atlas<\/strong>/);
  assert.doesNotMatch(html, /atlas-research-depth|research-depth-select|>Quick<|>Standard<|>Deep</);
  // Live-first workspace: no replay/example mode switch is exposed in the UI.
  assert.doesNotMatch(html, /Replay/);
  // Public-professional modality toggles are rendered.
  assert.match(html, /Identity/);
  assert.match(html, /Employer &amp; role/);
  assert.match(html, /Profiles &amp; handles/);
  assert.match(html, /Publications/);
  assert.match(html, /Education/);
  // Graph empty-state invites a live run rather than referencing captures.
  assert.match(html, /Run a search to build the graph/);
  assert.match(html, /it is never invented from prose/i);
  // Safety scope banner stays visible on the input.
  assert.match(html, /Home addresses, personal phones, data-broker records, and research about minors are refused/);
  assert.match(html, /<main id="graph-workspace"/);
  assert.doesNotMatch(html, /Investigate a person, not just a name|class="codegraph"|class="dossier-panel"/i);
  assert.doesNotMatch(html, /Henry Wang|Illustrative public-source run|aria-valuenow="72"/i);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("built Worker health remains available when local bindings are absent", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("health-test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(new Request("http://localhost/api/health"), undefined, {
    waitUntil() {},
    passThroughOnException() {},
  });
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

test("graph components preserve canonical state, accessible fallbacks, and client-only heavy libraries", async () => {
  const [
    page,
    workbench,
    graphModel,
    workspace,
    canvas,
    inspector,
    sourceLadder,
    traceRail,
    report,
    layout,
    css,
    packageJson,
    viteConfig,
  ] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/workbench.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/graph-model.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/graph-workspace.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/graph-canvas.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/node-inspector.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/source-ladder.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/trace-rail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/report-sheet.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../vite.config.ts", import.meta.url), "utf8"),
  ]);

  await assert.rejects(access(new URL("app/_sites-preview", projectRoot)));
  assert.doesNotMatch(page, /SkeletonPreview|<svg|dangerouslySetInnerHTML/);
  assert.doesNotMatch(layout, /codex-preview|Starter Project|favicon\.svg/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.match(page, /AtlasWorkbench/);
  assert.match(workbench, /<label className="sr-only" htmlFor="atlas-query">/);
  assert.match(workbench, /aria-live="polite"/);
  assert.match(workbench, /aria-describedby="research-scope-note"/);
  assert.match(workbench, /requestedDepth: "deep"/);
  assert.match(workbench, /\/api\/live\/session/);
  assert.match(workbench, /liveAuthorizationRequired/);
  assert.match(workbench, /credentials: "same-origin"/);
  assert.match(workbench, /type="password"/);
  assert.match(workbench, /short-lived HttpOnly session/);
  assert.doesNotMatch(workbench, /localStorage|sessionStorage/);
  assert.doesNotMatch(workbench, /ResearchDepth|researchDepth|atlas-research-depth|research-depth-select/);
  assert.doesNotMatch(workbench, /<span aria-hidden="true">A<\/span>/);
  assert.match(workbench, /AbortController/);
  assert.match(workbench, /\/api\/research/);
  assert.match(workbench, /mergeGraphEvent/);
  assert.match(workbench, /graphFromReport/);
  assert.match(workbench, /eventStableId/);
  assert.doesNotMatch(workbench, /Henry Wang|fake live|dangerouslySetInnerHTML/i);
  assert.match(workbench, /event\.key\.toLowerCase\(\) === "f"/);
  assert.match(workbench, /event\.key\.toLowerCase\(\) === "l"/);
  assert.match(workbench, /event\.key\.toLowerCase\(\) === "r"/);
  assert.doesNotMatch(workbench, /@xyflow\/react|elkjs/);
  assert.doesNotMatch(css, /\.atlas-wordmark\s*>\s*span|\.research-depth-select/);
  assert.match(layout, /<html lang="en">/);
  assert.doesNotMatch(layout, /next\/font\/google|fonts\.googleapis/);
  assert.match(css, /@font-face\s*\{[\s\S]*font-family:\s*"Geist"/);
  assert.match(css, /url\("\/fonts\/Geist-Variable\.woff2"\)/);
  assert.match(css, /url\("\/fonts\/GeistMono-Variable\.woff2"\)/);
  await Promise.all([
    access(new URL("../public/fonts/Geist-Variable.woff2", import.meta.url)),
    access(new URL("../public/fonts/Geist-Italic-Variable.woff2", import.meta.url)),
    access(new URL("../public/fonts/GeistMono-Variable.woff2", import.meta.url)),
    access(new URL("../public/fonts/GeistMono-Italic-Variable.woff2", import.meta.url)),
    access(new URL("../public/fonts/GEIST-LICENSE.txt", import.meta.url)),
  ]);

  assert.match(graphModel, /value\.schemaVersion !== 2/);
  assert.match(graphModel, /report\.searchGraph/);
  assert.doesNotMatch(graphModel, /report\.candidates|report\.evidence|report\.findings/);
  assert.match(workspace, /dynamic\(/);
  assert.match(workspace, /ssr: false/);
  assert.match(workspace, /graph\.nodes\.map/);
  assert.match(workspace, /graph\.edges\.filter/);
  assert.match(workspace, /rejected same-name candidates remain visible/i);
  assert.match(canvas, /@xyflow\/react/);
  assert.match(canvas, /import\("elkjs\/lib\/elk\.bundled\.js"\)/);
  assert.match(viteConfig, /client:\s*\{\s*\/\/[^]*?optimizeDeps:\s*\{\s*include:/);
  assert.match(viteConfig, /include:\s*\["@xyflow\/react", "elkjs\/lib\/elk\.bundled\.js", "@react-pdf\/renderer"\]/);
  assert.match(canvas, /deterministicGraphLayout/);
  assert.match(canvas, /BaseEdge/);
  assert.match(canvas, /ORTHOGONAL/);
  assert.match(canvas, /isCollisionFreeGraphLayout/);
  assert.match(canvas, /style: \{ width: GRAPH_NODE_WIDTH, height: GRAPH_NODE_HEIGHT \}/);
  assert.match(canvas, /GRAPH_FIT_MIN_ZOOM = 0\.46/);
  assert.match(canvas, /GRAPH_FIT_MIN_ZOOM_COMPACT = 0\.62/);
  assert.match(canvas, /minZoom: readableFitMinimum\(\)/);
  assert.match(canvas, /crossingMinimization\.forceNodeModelOrder": "false"/);
  assert.match(canvas, /nodesDraggable=\{false\}/);
  assert.match(canvas, /nodesFocusable=\{false\}/);
  assert.match(inspector, /nodeRelationships/);
  assert.match(inspector, /Exact query/);
  assert.match(inspector, /Site scope/);
  assert.match(inspector, /Scheduler path cost/);
  assert.match(inspector, /ranking metadata, not an API charge, error, or rejection reason/);
  assert.match(inspector, /check Transport attempts or the trace to see whether a request actually ran/);
  assert.match(inspector, /The\s+score did not reject it/);
  assert.match(inspector, /Attempts and discovery leads are not cited sources/);
  assert.match(inspector, /Web discovery path/);
  assert.match(inspector, /Structured indexes/);
  assert.match(sourceLadder, /Sites:/);
  assert.match(sourceLadder, /Transports attempted/);
  assert.match(sourceLadder, /Web discovery path/);
  assert.match(sourceLadder, /Structured indexes/);
  assert.match(sourceLadder, /Returned leads remain unverified/);
  assert.match(traceRail, /traceSearchQuery/);
  assert.match(traceRail, /returned unverified leads/);
  assert.match(traceRail, /no exact match/);
  assert.match(traceRail, /Structured indexes/);
  assert.match(report, /candidates\.map/);
  assert.match(report, /Queries attempted/);
  assert.match(report, /Web discovery path/);
  assert.match(report, /Structured indexes/);
  assert.match(report, /not cited sources until hardened fetch succeeds/);
  assert.doesNotMatch(report, /selectedCandidate.*filter|candidateId.*filter/);

  assert.match(css, /--atlas-bg:\s*#030604/);
  assert.match(css, /\.atlas-shell/);
  assert.match(css, /\.graph-list-view/);
  assert.match(css, /\.status-rejected/);
  assert.match(css, /grid-template-rows:\s*0\.875rem minmax\(0, 2rem\) 0\.875rem/);
  assert.match(css, /\.source-ladder ol\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(css, /\.source-ladder:not\(\.is-collapsed\) ol\s*\{\s*display:\s*flex/);
  assert.doesNotMatch(css, /\.source-ladder ol\s*\{\s*display:\s*flex/);
  assert.match(css, /:has\(\.source-ladder\.is-collapsed\) \.graph-canvas\s*\{\s*top:\s*13\.5rem/);
  assert.match(css, /\.atlas-flow-controls\s*\{\s*display:\s*none !important/);
  assert.match(css, /\.graph-legend\s*\{\s*display:\s*none/);
  assert.match(css, /:has\(\.node-inspector:not\(\.inspector-empty\)\) \.graph-canvas/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /prefers-contrast:\s*more/);
  assert.match(css, /@media \(max-width: 700px\)/);
  assert.match(css, /@media \(max-width: 400px\)/);
});

test("browser-only graph and PDF libraries stay out of the Worker module graph", async () => {
  const serverRoot = new URL("../dist/server/", import.meta.url);
  const serverFiles = await listFiles(serverRoot);
  const forbiddenChunk = /^(?:pdf-download\.client|elk\.bundled|graph-canvas)-/;
  assert.deepEqual(
    serverFiles.filter((file) => forbiddenChunk.test(file.pathname.split("/").at(-1) ?? "")),
    [],
  );

  const serverJavaScript = (
    await Promise.all(
      serverFiles.filter((file) => /\.(?:js|mjs)$/.test(file.pathname)).map((file) => readFile(file, "utf8")),
    )
  ).join("\n");
  assert.doesNotMatch(serverJavaScript, /@react-pdf\/renderer|@xyflow\/react/);
  assert.doesNotMatch(serverJavaScript, /data:application\/octet-stream;base64,AGFzb/);

  const clientManifest = JSON.parse(
    await readFile(new URL("../dist/client/.vite/manifest.json", import.meta.url), "utf8"),
  );
  assert.equal(Boolean(clientManifest["app/report/pdf-download.client.tsx"]), true);
  assert.equal(Boolean(clientManifest["app/components/graph-canvas.tsx"]), true);
  assert.equal(Boolean(clientManifest["node_modules/elkjs/lib/elk.bundled.js"]), true);
});

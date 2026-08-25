import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "playwright";
import {
  chromeChromeCollisions,
  chromeSelectors,
  denseReplayFixture,
  graphChromeCollisions,
  highNodeCountGraphFixture,
  intersectingRectangles,
  reportEvidenceContextFixture,
} from "./fixture.mjs";

const baseUrl = new URL(process.env.ATLAS_BROWSER_E2E_BASE_URL ?? "http://localhost:3000/");
const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];

function installStreamedResearchFixture({ events, delayMs }) {
  const nativeFetch = window.fetch.bind(window);
  window.__atlasFixtureRequest = null;
  window.__atlasFixtureEmitted = 0;
  window.fetch = (input, init) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(rawUrl, window.location.href);
    if (url.pathname !== "/api/research") return nativeFetch(input, init);
    try {
      window.__atlasFixtureRequest = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
    } catch {
      window.__atlasFixtureRequest = null;
    }
    const encoder = new TextEncoder();
    let canceled = false;
    let nextIndex = 0;
    const stream = new ReadableStream({
      start(controller) {
        const emit = () => {
          if (canceled) return;
          if (nextIndex >= events.length) {
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(`${JSON.stringify(events[nextIndex])}\n`));
          nextIndex += 1;
          window.__atlasFixtureEmitted = nextIndex;
          if (nextIndex >= events.length) window.setTimeout(() => controller.close(), delayMs);
        };
        window.__atlasFixtureAdvance = () => window.setTimeout(emit, delayMs);
        emit();
      },
      cancel() {
        canceled = true;
      },
    });
    return Promise.resolve(
      new Response(stream, {
        status: 200,
        headers: {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
          "x-atlas-execution-mode": "live",
        },
      }),
    );
  };
}

function startLiveGeometrySampler(selectors) {
  const rectangle = (element) => {
    const value = element.getBoundingClientRect();
    return { left: value.left, top: value.top, right: value.right, bottom: value.bottom };
  };
  const intersects = (left, right, tolerance = 0.75) =>
    Math.min(left.right, right.right) - Math.max(left.left, right.left) > tolerance &&
    Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > tolerance;
  const clippedTo = (value, clip) => ({
    left: Math.max(value.left, clip.left),
    top: Math.max(value.top, clip.top),
    right: Math.min(value.right, clip.right),
    bottom: Math.min(value.bottom, clip.bottom),
  });
  window.__atlasLiveGeometry = { positiveCounts: [], failures: [] };
  const recordFailure = (message) => {
    if (!window.__atlasLiveGeometry.failures.includes(message)) {
      window.__atlasLiveGeometry.failures.push(message);
    }
  };
  const sample = () => {
    const canvasElement = document.querySelector(".graph-canvas");
    const canvas = canvasElement ? rectangle(canvasElement) : null;
    const nodes = [...document.querySelectorAll(".react-flow__node")].map((element) => ({
      id: element.getAttribute("data-id") ?? "unknown-node",
      element,
      rect: rectangle(element),
    }));
    if (nodes.length > 0 && !window.__atlasLiveGeometry.positiveCounts.includes(nodes.length)) {
      window.__atlasLiveGeometry.positiveCounts.push(nodes.length);
    }
    for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
        if (intersects(nodes[leftIndex].rect, nodes[rightIndex].rect)) {
          recordFailure(`node overlap: ${nodes[leftIndex].id} / ${nodes[rightIndex].id}`);
        }
      }
      if (
        nodes[leftIndex].rect.right - nodes[leftIndex].rect.left < 120 ||
        nodes[leftIndex].rect.bottom - nodes[leftIndex].rect.top < 38
      ) {
        recordFailure(`unreadable node scale: ${nodes[leftIndex].id}`);
      }
      const button = nodes[leftIndex].element.querySelector("button");
      if (button) {
        const blocks = [
          ...button.querySelectorAll(":scope > .node-topline, :scope > strong, :scope > .node-bottomline"),
        ].map((element) => rectangle(element));
        for (let index = 0; index < blocks.length - 1; index += 1) {
          if (blocks[index].bottom > blocks[index + 1].top + 0.75) {
            recordFailure(`node text overlap: ${nodes[leftIndex].id}`);
          }
        }
      }
    }
    const chrome = selectors.flatMap((selector) =>
      [...document.querySelectorAll(selector)]
        .filter((element) => {
          const style = getComputedStyle(element);
          const bounds = element.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && bounds.width > 0 && bounds.height > 0;
        })
        .map((element) => ({ selector, rect: rectangle(element) })),
    );
    for (const node of nodes) {
      for (const item of chrome) {
        const visibleNode = canvas ? clippedTo(node.rect, canvas) : node.rect;
        if (intersects(visibleNode, item.rect)) recordFailure(`chrome overlap: ${node.id} / ${item.selector}`);
      }
    }
    for (let leftIndex = 0; leftIndex < chrome.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < chrome.length; rightIndex += 1) {
        if (intersects(chrome[leftIndex].rect, chrome[rightIndex].rect)) {
          recordFailure(`chrome/chrome overlap: ${chrome[leftIndex].selector} / ${chrome[rightIndex].selector}`);
        }
      }
    }
    if (document.documentElement.scrollWidth !== window.innerWidth || document.body.scrollWidth !== window.innerWidth) {
      recordFailure("horizontal overflow");
    }
    if (window.__atlasLiveGeometry.failures.length > 100) window.__atlasLiveGeometry.failures.length = 100;
  };
  window.__atlasLiveGeometryTimer = window.setInterval(sample, 75);
  sample();
}

function stopLiveGeometrySampler() {
  window.clearInterval(window.__atlasLiveGeometryTimer);
  return window.__atlasLiveGeometry;
}

function searchGraphFromEvent(event) {
  return event.payload?.searchGraph ?? event.payload?.report?.searchGraph ?? null;
}

function diagnosticsFromEvents(events) {
  return events.flatMap((event) => (Array.isArray(event.payload?.diagnostics) ? event.payload.diagnostics : []));
}

function evidenceUrl(evidence) {
  return (
    evidence?.canonicalUrl ??
    evidence?.sourceUrl ??
    evidence?.url ??
    evidence?.source?.canonicalUrl ??
    evidence?.source?.url
  );
}

async function assertServerReady() {
  try {
    const response = await fetch(baseUrl, { signal: AbortSignal.timeout(10_000) });
    assert.equal(response.ok, true);
  } catch (error) {
    throw new Error(`Atlas is not reachable at ${baseUrl}. Start it with npm run dev before browser QA.`, {
      cause: error,
    });
  }
}

async function renderedLayout(page, graph) {
  return page.evaluate(
    ({ chromeSelectors: selectors, graphEdges }) => {
      const rect = (element, id) => {
        const bounds = element.getBoundingClientRect();
        return {
          id,
          left: bounds.left,
          top: bounds.top,
          right: bounds.right,
          bottom: bounds.bottom,
          width: bounds.width,
          height: bounds.height,
        };
      };
      const nodeElements = [...document.querySelectorAll(".react-flow__node")];
      const canvasElement = document.querySelector(".graph-canvas");
      const canvas = canvasElement ? rect(canvasElement, "graph-canvas") : null;
      const nodes = nodeElements.map((element) => ({
        ...rect(element, element.getAttribute("data-id") ?? "unknown-node"),
        layoutWidth: element.offsetWidth,
        layoutHeight: element.offsetHeight,
        button: element.querySelector("button")
          ? rect(element.querySelector("button"), `${element.getAttribute("data-id")}:button`)
          : null,
        textCollisions: (() => {
          const button = element.querySelector("button");
          if (!button) return ["missing button"];
          const blocks = [
            ...button.querySelectorAll(":scope > .node-topline, :scope > strong, :scope > .node-bottomline"),
          ].map((child, index) => rect(child, `${element.getAttribute("data-id")}:text:${index}`));
          return blocks
            .slice(0, -1)
            .flatMap((block, index) =>
              block.bottom > blocks[index + 1].top + 0.75 ? [`${block.id}/${blocks[index + 1].id}`] : [],
            );
        })(),
      }));
      const visibleNodes = nodes.flatMap((node) => {
        if (!canvas) return [node];
        const visible = {
          ...node,
          left: Math.max(node.left, canvas.left),
          top: Math.max(node.top, canvas.top),
          right: Math.min(node.right, canvas.right),
          bottom: Math.min(node.bottom, canvas.bottom),
        };
        visible.width = Math.max(0, visible.right - visible.left);
        visible.height = Math.max(0, visible.bottom - visible.top);
        return visible.width > 0 && visible.height > 0 ? [visible] : [];
      });
      const chrome = selectors.flatMap((selector) =>
        [...document.querySelectorAll(selector)]
          .filter((element) => {
            const style = getComputedStyle(element);
            const bounds = element.getBoundingClientRect();
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              Number.parseFloat(style.opacity || "1") > 0.05 &&
              bounds.width > 0 &&
              bounds.height > 0
            );
          })
          .map((element, index) => rect(element, `${selector}:${index}`)),
      );
      const edgeById = new Map(graphEdges.map((edge) => [edge.id, edge]));
      const edgeNodeCrossings = [];
      for (const edgeElement of document.querySelectorAll(".react-flow__edge")) {
        const edgeId = edgeElement.getAttribute("data-id");
        const edge = edgeById.get(edgeId);
        const path = edgeElement.querySelector(".react-flow__edge-path");
        if (!edge || !(path instanceof SVGPathElement)) continue;
        const matrix = path.getScreenCTM();
        if (!matrix) continue;
        const length = path.getTotalLength();
        for (const node of nodes) {
          if (node.id === edge.fromNodeId || node.id === edge.toNodeId) continue;
          let crossed = false;
          for (let distance = 0; distance <= length; distance += 4) {
            const sourcePoint = path.getPointAtLength(distance);
            const point = new DOMPoint(sourcePoint.x, sourcePoint.y).matrixTransform(matrix);
            if (
              point.x > node.left + 3 &&
              point.x < node.right - 3 &&
              point.y > node.top + 3 &&
              point.y < node.bottom - 3
            ) {
              crossed = true;
              break;
            }
          }
          if (crossed) edgeNodeCrossings.push({ edge: edgeId, node: node.id });
        }
      }
      return {
        nodes,
        visibleNodes,
        chrome,
        edgeNodeCrossings,
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        viewportWidth: window.innerWidth,
      };
    },
    { chromeSelectors, graphEdges: graph.edges },
  );
}

function assertLayout(layout, graph, viewport) {
  assert.equal(layout.nodes.length, graph.nodes.length, `${viewport.name}: every graph node must render`);
  assert.equal(layout.documentWidth, layout.viewportWidth, `${viewport.name}: document overflowed horizontally`);
  assert.equal(layout.bodyWidth, layout.viewportWidth, `${viewport.name}: body overflowed horizontally`);
  assert.deepEqual(intersectingRectangles(layout.nodes), [], `${viewport.name}: graph nodes overlap`);
  assert.deepEqual(
    graphChromeCollisions(layout.visibleNodes, layout.chrome),
    [],
    `${viewport.name}: visible nodes overlap fixed graph chrome`,
  );
  assert.deepEqual(chromeChromeCollisions(layout.chrome), [], `${viewport.name}: fixed graph chrome overlaps itself`);
  assert.deepEqual(layout.edgeNodeCrossings, [], `${viewport.name}: an edge crosses an unrelated node`);
  assert.equal(
    new Set(layout.nodes.map((node) => node.layoutWidth)).size,
    1,
    `${viewport.name}: node layout widths diverged`,
  );
  assert.equal(
    new Set(layout.nodes.map((node) => node.layoutHeight)).size,
    1,
    `${viewport.name}: node layout heights diverged`,
  );
  for (const node of layout.nodes) {
    assert.ok(
      node.layoutWidth >= 220 && node.layoutWidth <= 360,
      `${viewport.name}: ${node.id} has an invalid layout width ${node.layoutWidth}`,
    );
    assert.ok(
      node.layoutHeight >= 72 && node.layoutHeight <= 120,
      `${viewport.name}: ${node.id} has an invalid layout height ${node.layoutHeight}`,
    );
    assert.ok(node.width >= 120, `${viewport.name}: ${node.id} rendered too narrowly to read (${node.width}px)`);
    assert.ok(node.height >= 38, `${viewport.name}: ${node.id} rendered too short to read (${node.height}px)`);
    assert.ok(node.button, `${viewport.name}: ${node.id} has no interactive card`);
    assert.deepEqual(node.textCollisions, [], `${viewport.name}: ${node.id} has overlapping text regions`);
    assert.ok(
      node.button.left >= node.left - 1 && node.button.right <= node.right + 1,
      `${viewport.name}: ${node.id} card escapes horizontally`,
    );
    assert.ok(
      node.button.top >= node.top - 1 && node.button.bottom <= node.bottom + 1,
      `${viewport.name}: ${node.id} card escapes vertically`,
    );
  }
}

test(
  "235-node paced live graph crosses the dense threshold without resize loops or intermediate refits",
  { timeout: 120_000 },
  async () => {
    await assertServerReady();
    const fixture = await highNodeCountGraphFixture(235, [87, 198]);
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: viewports[0] });
    const pageErrors = [];
    const consoleIssues = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (["warning", "error"].includes(message.type())) consoleIssues.push(`${message.type()}: ${message.text()}`);
    });
    try {
      await page.route("**/api/health", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ status: "ok", liveConfigured: true }),
        }),
      );
      const healthResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/health");
      await page.goto(baseUrl.href, { waitUntil: "domcontentloaded" });
      await healthResponse;
      await page.evaluate(installStreamedResearchFixture, { events: fixture.events, delayMs: 120 });
      await page.getByRole("searchbox", { name: "Public-professional research input" }).fill("Chris Anderson, TED");
      await page.evaluate(() => {
        window.__atlasViewportTransforms = [];
        window.__atlasMaxMountedFlowNodes = 0;
        window.__atlasFlowNodeObserver = new MutationObserver(() => {
          window.__atlasMaxMountedFlowNodes = Math.max(
            window.__atlasMaxMountedFlowNodes,
            document.querySelectorAll(".react-flow__node").length,
          );
        });
        window.__atlasFlowNodeObserver.observe(document.body, { childList: true, subtree: true });
        const sample = () => {
          const transform = document.querySelector(".react-flow__viewport")?.style.transform;
          if (transform && !window.__atlasViewportTransforms.includes(transform)) {
            window.__atlasViewportTransforms.push(transform);
          }
          window.__atlasViewportTransformFrame = window.requestAnimationFrame(sample);
        };
        sample();
      });
      await page.getByRole("button", { name: "Research", exact: true }).click();
      for (let index = 0; index < fixture.events.length; index += 1) {
        const checkpoint = searchGraphFromEvent(fixture.events[index]);
        await page.waitForFunction((emitted) => window.__atlasFixtureEmitted === emitted, index + 1);
        await page.waitForFunction(
          (expected) =>
            document.querySelector('.graph-workspace [role="status"]')?.textContent?.includes(`${expected} nodes`),
          checkpoint.nodes.length,
          { timeout: 20_000 },
        );
        assert.equal(
          await page.locator(".graph-canvas").getAttribute("data-render-mode"),
          "virtualized",
          `the ${checkpoint.nodes.length}-node snapshot left the stable dense render mode`,
        );
        await page.waitForFunction(
          () => document.querySelector(".graph-canvas")?.getAttribute("data-layout-source") === "elk",
          undefined,
          { timeout: 60_000 },
        );
        // Pace each update beyond the layout debounce and viewport rAF. The
        // old implementation therefore exposed every redundant intermediate
        // fit instead of hiding it in one zero-delay event burst.
        await page.waitForTimeout(180);
        if (index < fixture.events.length - 1) await page.evaluate(() => window.__atlasFixtureAdvance());
      }
      await page.waitForTimeout(1_000);
      const renderedNodeCount = await page.locator(".react-flow__node").count();
      const renderWork = await page.evaluate(() => {
        window.cancelAnimationFrame(window.__atlasViewportTransformFrame);
        window.__atlasFlowNodeObserver.disconnect();
        return {
          viewportTransforms: window.__atlasViewportTransforms,
          maxMountedFlowNodes: window.__atlasMaxMountedFlowNodes,
        };
      });
      assert.ok(renderedNodeCount > 0, "large graph virtualization hid every node");
      assert.ok(
        renderedNodeCount < fixture.graph.nodes.length,
        `large graph mounted all ${renderedNodeCount} nodes instead of bounding observer work`,
      );
      const firstSnapshotNodeCount = searchGraphFromEvent(fixture.events[0]).nodes.length;
      assert.ok(
        renderWork.maxMountedFlowNodes < firstSnapshotNodeCount,
        `dense graph mounted ${renderWork.maxMountedFlowNodes} nodes in one observer wave`,
      );
      assert.ok(
        renderWork.viewportTransforms.length <= 3,
        `streaming graph triggered redundant automatic viewport fits: ${JSON.stringify(renderWork.viewportTransforms)}`,
      );
      assert.deepEqual(pageErrors, [], `large graph raised uncaught browser errors: ${JSON.stringify(pageErrors)}`);
      assert.deepEqual(
        consoleIssues,
        [],
        `large graph logged browser warnings/errors: ${JSON.stringify(consoleIssues)}`,
      );
    } finally {
      await page.close();
      await browser.close();
    }
  },
);

test("remote dashboard exchanges the Atlas bearer once and keeps research requests cookie-only", async () => {
  await assertServerReady();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: viewports[0] });
  const atlasAccessToken = "a".repeat(48);
  const sessionRequests = [];
  let researchAuthorization = null;
  try {
    await page.route("**/api/health", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "ok",
          liveConfigured: true,
          liveAuthorizationRequired: true,
        }),
      }),
    );
    await page.route("**/api/live/session", async (route) => {
      const request = route.request();
      sessionRequests.push({ method: request.method(), authorization: request.headers().authorization ?? null });
      if (request.method() === "GET") {
        await route.fulfill({ status: 401, contentType: "application/json", body: '{"authenticated":false}\n' });
        return;
      }
      assert.equal(request.method(), "POST");
      await route.fulfill({
        status: 204,
        headers: {
          "set-cookie": "__Host-atlas_live_session=v1.mock.signature; Path=/; HttpOnly; Secure; SameSite=Strict",
        },
      });
    });
    await page.route("**/api/research", async (route) => {
      researchAuthorization = route.request().headers().authorization ?? null;
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: '{"error":"unauthorized","message":"Session expired."}\n',
      });
    });

    await page.goto(baseUrl.href, { waitUntil: "domcontentloaded" });
    const accessInput = page.getByLabel("Atlas access token");
    await accessInput.waitFor({ state: "visible" });
    assert.equal(await page.getByRole("button", { name: "Research", exact: true }).isDisabled(), true);
    await accessInput.fill(atlasAccessToken);
    await page.getByRole("button", { name: "Unlock", exact: true }).click();
    await accessInput.waitFor({ state: "hidden" });
    assert.equal(await page.getByRole("button", { name: "Research", exact: true }).isEnabled(), true);
    assert.deepEqual(sessionRequests, [
      { method: "GET", authorization: null },
      { method: "POST", authorization: `Bearer ${atlasAccessToken}` },
    ]);

    const browserStorage = await page.evaluate(() => ({
      local: Object.values(localStorage),
      session: Object.values(sessionStorage),
      text: document.body.textContent,
    }));
    assert.equal(browserStorage.local.includes(atlasAccessToken), false);
    assert.equal(browserStorage.session.includes(atlasAccessToken), false);
    assert.equal(browserStorage.text.includes(atlasAccessToken), false);

    await page.getByRole("searchbox", { name: "Public-professional research input" }).fill("Alex Rivera");
    const researchResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/research");
    await page.getByRole("button", { name: "Research", exact: true }).click();
    await researchResponse;
    assert.equal(researchAuthorization, null, "the long-lived Atlas bearer leaked into a research request");
    await page.getByText(/access session expired/i).waitFor({ state: "visible" });
  } finally {
    await browser.close();
  }
});

test(
  "dense intercepted NDJSON has collision-free desktop and mobile graph geometry",
  { timeout: 240_000 },
  async () => {
    await assertServerReady();
    const fixture = await denseReplayFixture();
    const browser = await chromium.launch({ headless: true });
    try {
      for (const viewport of viewports) {
        const page = await browser.newPage({ viewport });
        const consoleIssues = [];
        const pageErrors = [];
        page.on("console", (message) => {
          if (["warning", "error"].includes(message.type())) consoleIssues.push(`${message.type()}: ${message.text()}`);
        });
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await page.route("**/api/health", (route) =>
          route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ status: "ok", liveConfigured: true }),
          }),
        );
        try {
          const healthResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/health");
          await page.goto(baseUrl.href, { waitUntil: "domcontentloaded" });
          await healthResponse;
          assert.equal(await page.locator(".atlas-wordmark").innerText(), "Atlas", "redundant letter-mark remained");
          assert.equal(
            await page.getByRole("combobox", { name: "Research depth" }).count(),
            0,
            "interactive depth chooser must stay removed",
          );
          const bodyFont = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
          assert.match(bodyFont, /Geist/i, `${viewport.name}: the intended UI font was not applied`);
          assert.doesNotMatch(
            bodyFont,
            /(?:^|,\s*)(?:["']?Times(?: New Roman)?["']?|serif)(?:\s*,|$)/i,
            `${viewport.name}: browser fell back to a serif font`,
          );
          await page.evaluate(installStreamedResearchFixture, { events: fixture.events, delayMs: 50 });
          await page.evaluate(startLiveGeometrySampler, chromeSelectors);
          const searchbox = page.getByRole("searchbox", { name: "Public-professional research input" });
          await searchbox.fill("Chris Anderson, TED");
          assert.equal(await searchbox.inputValue(), "Chris Anderson, TED");
          await page.getByRole("button", { name: "Research", exact: true }).click();
          const workspaceStatus = page.locator(".workspace-status");
          await workspaceStatus.waitFor({ state: "visible" });
          const executionMode = workspaceStatus.locator(".execution-mode", { hasText: "Live" });
          await executionMode.waitFor({ state: "attached" });
          assert.equal(
            (await executionMode.innerText()).trim(),
            "Live",
            `${viewport.name}: execution mode was not live`,
          );
          assert.equal(
            await workspaceStatus.locator("strong").innerText(),
            "Running",
            `${viewport.name}: compact run status was not truthful`,
          );
          assert.equal(
            await executionMode.isVisible(),
            viewport.name === "desktop",
            `${viewport.name}: execution-mode visibility diverged from the responsive status contract`,
          );
          const checkpointGraphs = fixture.events.map(searchGraphFromEvent).filter(Boolean);
          for (let index = 0; index < checkpointGraphs.length; index += 1) {
            const checkpoint = checkpointGraphs[index];
            await page.waitForFunction(
              ({ emitted, count }) =>
                window.__atlasFixtureEmitted === emitted &&
                document.querySelectorAll(".react-flow__node").length === count,
              { emitted: index + 1, count: checkpoint.nodes.length },
              { timeout: 20_000 },
            );
            await page.waitForTimeout(350);
            await page.waitForFunction(
              () => document.querySelector(".graph-canvas")?.getAttribute("data-layout-source") === "elk",
              undefined,
              { timeout: 5_000 },
            );
            await page.locator(".graph-fit-button").click();
            await page.waitForTimeout(450);
            assertLayout(await renderedLayout(page, checkpoint), checkpoint, viewport);
            if (index < checkpointGraphs.length - 1) await page.evaluate(() => window.__atlasFixtureAdvance());
          }
          const researchRequest = await page.evaluate(() => window.__atlasFixtureRequest);
          assert.equal(researchRequest?.query, "Chris Anderson, TED");
          assert.equal(researchRequest?.mode, "live");
          assert.equal(
            researchRequest?.requestedDepth,
            "deep",
            "interactive research must execute the full bounded operator program",
          );
          assert.deepEqual(
            researchRequest?.requestedCategories,
            ["identity", "employment", "online_presence", "project", "publication", "education"],
            "interactive name research must default to all six public-professional report categories",
          );
          if (viewport.name === "mobile") {
            const ladder = page.locator(".source-ladder");
            assert.equal(await ladder.locator(".source-ladder-toggle").getAttribute("aria-expanded"), "false");
            assert.equal(
              await ladder.locator("ol").evaluate((element) => getComputedStyle(element).display),
              "none",
              "mobile collapsed ladder content must remain hidden",
            );
          }
          const streamedGeometry = await page.evaluate(stopLiveGeometrySampler);
          assert.deepEqual(
            streamedGeometry.positiveCounts,
            checkpointGraphs.map((graph) => graph.nodes.length),
            `${viewport.name}: every streamed topology must be observed`,
          );
          assert.deepEqual(
            streamedGeometry.failures,
            [],
            `${viewport.name}: streamed geometry must remain collision-free and readable`,
          );
          if (viewport.name === "desktop") {
            const searchFrontier = fixture.graph.frontier.find(
              (entry) => entry.allowedTools.includes("search_web") && /(?:^|\s)site:/i.test(entry.queryHint),
            );
            assert.ok(searchFrontier, "browser fixture omitted its site-scoped search frontier");
            const ladderText = await page.locator(".source-ladder").innerText();
            assert.match(ladderText, /Sites:\s+ted\.com/i, "source ladder hid the actual site scope");
            assert.match(ladderText, /Web discovery path/i);
            assert.match(ladderText, /Structured indexes/i);
            assert.match(ladderText, /Configured web-search provider\s+Unavailable/i);
            assert.match(ladderText, /Google HTML fallback\s+No Safe Leads/i);
            assert.match(ladderText, /DuckDuckGo HTML fallback\s+No Safe Leads/i);
            assert.match(ladderText, /GitHub exact-name fallback\s+No Safe Leads/i);
            assert.match(ladderText, /Semantic Scholar author API\s+No Match/i);
            assert.match(ladderText, /Crossref works API\s+No Match/i);
            assert.match(ladderText, /Returned leads remain unverified/i);
            const configuredIndex = ladderText.indexOf("Configured web-search provider");
            const duckDuckGoIndex = ladderText.indexOf("DuckDuckGo HTML fallback");
            const googleIndex = ladderText.indexOf("Google HTML fallback");
            const githubIndex = ladderText.indexOf("GitHub exact-name fallback");
            assert.ok(
              configuredIndex >= 0 &&
                configuredIndex < duckDuckGoIndex &&
                duckDuckGoIndex < googleIndex &&
                googleIndex < githubIndex,
              "source ladder did not preserve configured → DuckDuckGo → Google → GitHub fallback order",
            );

            await page.locator(`.react-flow__node[data-id="${searchFrontier.nodeId}"] button`).click({ force: true });
            const inspectorText = await page.locator(".node-inspector").innerText();
            assert.match(inspectorText, /Search execution/i);
            assert.ok(inspectorText.includes(searchFrontier.queryHint), "inspector hid the exact search query");
            assert.match(inspectorText, /Site scope\s+ted\.com/i);
            assert.match(inspectorText, /Allowed tools[\s\S]*Search Web/i);
            assert.match(inspectorText, /Web discovery path/i);
            assert.match(inspectorText, /Structured indexes/i);
            assert.match(inspectorText, /Scheduler path cost/i);
            assert.match(inspectorText, /ranking metadata, not an API charge, error, or rejection reason/i);
            assert.match(inspectorText, /Exhausted means this frontier is closed for the run/i);
            assert.match(inspectorText, /check Transport attempts or the trace to see whether a request actually ran/i);
            assert.match(inspectorText, /the score did not reject it/i);
            assert.match(inspectorText, /Attempts and discovery leads are not cited sources/i);
            await page.getByRole("button", { name: "Close node inspector" }).click();

            await page.locator(".trace-rail-handle").click();
            const traceText = await page.locator(".trace-event-list").innerText();
            assert.ok(traceText.includes(searchFrontier.queryHint), "trace hid the exact search query");
            assert.match(traceText, /configured web-search provider exhausted its retryable quota/i);
            assert.match(traceText, /Web path/i);
            assert.match(traceText, /Structured indexes/i);
            assert.match(traceText, /Configured web-search provider: unavailable/i);
            assert.match(traceText, /Google HTML fallback: no safe leads/i);
            assert.match(traceText, /DuckDuckGo HTML fallback: no safe leads/i);
            assert.match(traceText, /GitHub exact-name fallback: no safe leads/i);
            assert.match(traceText, /Semantic Scholar author API: no exact match/i);
            assert.match(traceText, /Crossref works API: no exact match/i);
            await page.locator(".trace-rail-handle").click();

            const zoomedViewport = { name: "desktop at 200% page zoom", width: 720, height: 450 };
            await page.setViewportSize(zoomedViewport);
            await page.locator(".graph-fit-button").click();
            await page.waitForTimeout(500);
            assertLayout(await renderedLayout(page, fixture.graph), fixture.graph, zoomedViewport);
          }
          await page.getByRole("button", { name: "Report", exact: true }).click();
          const reportDialog = page.getByRole("dialog", { name: "Chris Anderson, TED" });
          await reportDialog.waitFor({ state: "visible" });
          const identityAssessmentText = await reportDialog.locator(".report-identity-assessment").innerText();
          assert.match(identityAssessmentText, /Candidate assessment\s+Resolved match/i);
          assert.match(identityAssessmentText, /Chris Anderson/);
          assert.match(identityAssessmentText, /Formal identity status\s+Resolved/i);
          assert.match(identityAssessmentText, /Supporting source families\s+1/i);
          assert.match(identityAssessmentText, /Matched context signals\s+[1-9]\d*/i);
          assert.ok(
            (await reportDialog.locator(".candidate-profile-facts li").count()) >= 1,
            `${viewport.name}: candidate profile omitted its cited direct facts`,
          );
          const coverageText = await reportDialog.locator(".report-coverage-note").innerText();
          const fixtureSearchQuery = fixture.graph.frontier.find(
            (entry) => entry.allowedTools.includes("search_web") && /(?:^|\s)site:/i.test(entry.queryHint),
          )?.queryHint;
          assert.ok(fixtureSearchQuery && coverageText.includes(fixtureSearchQuery));
          assert.match(coverageText, /Transport attempts/i);
          assert.match(coverageText, /Web discovery path/i);
          assert.match(coverageText, /Structured indexes/i);
          assert.match(coverageText, /Configured web-search provider\s+Unavailable/i);
          assert.match(coverageText, /Google HTML fallback\s+No Safe Leads/i);
          assert.match(coverageText, /DuckDuckGo HTML fallback\s+No Safe Leads/i);
          assert.match(coverageText, /GitHub exact-name fallback\s+No Safe Leads/i);
          assert.match(coverageText, /Semantic Scholar author API\s+No Match/i);
          assert.match(coverageText, /Crossref works API\s+No Match/i);
          assert.match(coverageText, /Queries attempted\s+1/i);
          assert.match(coverageText, /not cited sources until hardened fetch succeeds/i);
          const temporalCards = reportDialog.locator(".evidence-temporal");
          assert.equal(
            await temporalCards.count(),
            2,
            `${viewport.name}: temporal comparisons did not render exactly twice`,
          );
          const temporalText = await temporalCards.nth(0).innerText();
          assert.match(temporalText, /Temporal diff\s+bounded comparison/i);
          assert.match(
            temporalText,
            new RegExp(
              `after ${reportEvidenceContextFixture.temporal.observedAfter}\\s+·\\s+on or before ${reportEvidenceContextFixture.temporal.observedOnOrBefore}`,
            ),
          );
          assert.match(temporalText, /Archived response body bytes\s+Changed/i);
          assert.match(temporalText, /Normalized static-HTML text\s+Changed/i);
          assert.match(temporalText, /Page-declared metadata\s+Changed/i);
          assert.match(temporalText, /Static-HTML structure\s+Unchanged/i);
          assert.match(temporalText, /Static-HTML fragment counts\s+1 added\s+·\s+1 removed\s+·\s+3 unchanged/i);
          assert.match(temporalText, /Changed metadata fields\s+Title, Description/i);
          assert.ok(
            temporalText.includes(reportEvidenceContextFixture.temporal.addedTextFragments[0]),
            `${viewport.name}: normalized added fragment was omitted`,
          );
          assert.ok(
            temporalText.includes(reportEvidenceContextFixture.temporal.removedTextFragments[0]),
            `${viewport.name}: normalized removed fragment was omitted`,
          );
          assert.match(temporalText, /do not identify the editor or prove archive completeness/i);
          assert.match(temporalText, /do not describe browser-rendered state/i);

          const bodyOnlyTemporalText = await temporalCards.nth(1).innerText();
          assert.match(bodyOnlyTemporalText, /Temporal diff\s+observed captures/i);
          assert.match(bodyOnlyTemporalText, /Archived response body bytes\s+Changed/i);
          assert.match(bodyOnlyTemporalText, /Normalized static-HTML text\s+Unchanged/i);
          assert.match(bodyOnlyTemporalText, /Page-declared metadata\s+Unchanged/i);
          assert.match(bodyOnlyTemporalText, /Static-HTML structure\s+Unchanged/i);
          assert.match(
            bodyOnlyTemporalText,
            /Static-HTML fragment counts\s+0 added\s+·\s+0 removed\s+·\s+1 unchanged/i,
          );

          const footprint = reportDialog.locator(".evidence-footprint");
          assert.equal(await footprint.count(), 1, `${viewport.name}: page footprint did not render exactly once`);
          const footprintText = await footprint.innerText();
          assert.match(footprintText, /Page-declared footprint\s+(?:projection not truncated|bounded projection)/i);
          assert.ok(
            footprintText.includes(`sha256:${"d".repeat(64)}`),
            `${viewport.name}: footprint hash binding was omitted`,
          );
          assert.ok(
            footprintText.includes("Chris Anderson - TED speaker profile"),
            `${viewport.name}: page-authored title was omitted`,
          );
          assert.ok(
            footprintText.includes(reportEvidenceContextFixture.footprint.description),
            `${viewport.name}: page-authored description was omitted`,
          );
          assert.match(footprintText, /Canonical status\s+Accepted Same Page/i);
          assert.ok(
            footprintText.includes(reportEvidenceContextFixture.footprint.canonicalUrl),
            `${viewport.name}: accepted canonical URL was omitted`,
          );
          assert.match(footprintText, /Language\s+en/i);
          assert.match(footprintText, /Open Graph type\s+profile/i);
          assert.match(footprintText, /Open Graph site\s+TED/i);
          assert.match(footprintText, /Generators\s+Next\.js/i);
          assert.match(footprintText, /Applications\s+TED/i);
          assert.match(footprintText, /Observed providers\s+Jsdelivr, Cloudflare/i);
          for (const host of reportEvidenceContextFixture.footprint.observedResourceHosts) {
            assert.ok(footprintText.includes(host), `${viewport.name}: footprint omitted referenced host ${host}`);
          }
          for (const type of reportEvidenceContextFixture.footprint.jsonLdTypes) {
            assert.ok(footprintText.includes(type), `${viewport.name}: footprint omitted JSON-LD type ${type}`);
          }
          assert.match(
            footprintText,
            /No referenced resource was followed.*no hosting ownership or control is inferred/is,
          );
          assert.equal(
            (await reportDialog.innerText()).includes("ATLAS_CONTEXT_SENTINEL_SHOULD_NOT_RENDER"),
            false,
            `${viewport.name}: hostile or unbound context reached the HTML report`,
          );

          const reportOverflow = await reportDialog.evaluate((dialog) => ({
            documentWidth: document.documentElement.scrollWidth,
            bodyWidth: document.body.scrollWidth,
            viewportWidth: window.innerWidth,
            overflowing: [dialog, ...dialog.querySelectorAll(".report-sheet-body, .evidence-context")]
              .filter((element) => element.scrollWidth > element.clientWidth + 1)
              .map((element) => element.className),
          }));
          assert.equal(
            reportOverflow.documentWidth,
            reportOverflow.viewportWidth,
            `${viewport.name}: report opened with document overflow`,
          );
          assert.equal(
            reportOverflow.bodyWidth,
            reportOverflow.viewportWidth,
            `${viewport.name}: report opened with body overflow`,
          );
          assert.deepEqual(
            reportOverflow.overflowing,
            [],
            `${viewport.name}: report context cards overflow horizontally`,
          );
          const pdfDownloadPromise = page.waitForEvent("download", { timeout: 120_000 });
          await reportDialog.getByRole("button", { name: "PDF", exact: true }).click();
          const pdfDownload = await pdfDownloadPromise;
          assert.equal(await pdfDownload.failure(), null, `${viewport.name}: PDF browser download failed`);
          assert.match(pdfDownload.suggestedFilename(), /\.pdf$/i);
          const pdfPath = await pdfDownload.path();
          assert.ok(pdfPath, `${viewport.name}: PDF download did not produce a local artifact`);
          const pdfBytes = await readFile(pdfPath);
          assert.equal(pdfBytes.subarray(0, 5).toString("ascii"), "%PDF-");
          assert.ok(pdfBytes.byteLength > 1_000, `${viewport.name}: PDF download was unexpectedly small`);
          const pdfSuccessMessage = "PDF intelligence report downloaded.";
          await page.waitForFunction(
            (expected) => document.querySelector(".workspace-message")?.textContent === expected,
            pdfSuccessMessage,
            { timeout: 5_000 },
          );
          if (viewport.name === "desktop") {
            await page.getByText(pdfSuccessMessage).waitFor({ state: "visible", timeout: 5_000 });
          }
          await page.getByRole("button", { name: "Close report" }).click();
          assert.deepEqual(consoleIssues, [], `${viewport.name}: browser console warnings/errors`);
          assert.deepEqual(pageErrors, [], `${viewport.name}: uncaught page errors`);
        } catch (error) {
          const screenshot = `/private/tmp/atlas-browser-${viewport.name}-failure.png`;
          await page.screenshot({ path: screenshot, fullPage: true }).catch(() => undefined);
          throw new Error(
            `${viewport.name} deterministic browser QA failed; screenshot: ${screenshot}; console: ${JSON.stringify(consoleIssues)}; page errors: ${JSON.stringify(pageErrors)}`,
            { cause: error },
          );
        } finally {
          await page.close();
        }
      }
    } finally {
      await browser.close();
    }
  },
);

test(
  "credentialed live browser streams genuine public-web discovery, fetched citations, and grounded findings",
  {
    skip: process.env.ATLAS_LIVE_E2E !== "1",
    timeout: 360_000,
  },
  async (context) => {
    const query = process.env.ATLAS_LIVE_E2E_QUERY?.trim() || "Chris Anderson, TED";
    await assertServerReady();
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: viewports[1] });
    context.after(async () => browser.close());
    const consoleIssues = [];
    const pageErrors = [];
    page.on("console", (message) => {
      if (["warning", "error"].includes(message.type())) consoleIssues.push(`${message.type()}: ${message.text()}`);
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    let responseBody = "";
    try {
      const healthPromise = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/health");
      await page.goto(baseUrl.href, { waitUntil: "domcontentloaded" });
      const health = await (await healthPromise).json();
      assert.equal(health.liveConfigured, true, "localhost live mode is not configured");
      assert.equal("model" in health, false, "health response exposed provider/model configuration");
      await page.evaluate(startLiveGeometrySampler, chromeSelectors);
      await page.getByRole("searchbox", { name: "Public-professional research input" }).fill(query);
      const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/research", {
        timeout: 30_000,
      });
      await page.getByRole("button", { name: "Research", exact: true }).click();
      const response = await responsePromise;
      assert.equal(response.ok(), true, `live API returned HTTP ${response.status()}`);
      await page.getByRole("button", { name: "Report", exact: true }).waitFor({ state: "visible", timeout: 300_000 });
      await page.waitForFunction(
        () => {
          const report = document.querySelector(".report-button");
          const run = document.querySelector(".run-button");
          return report instanceof HTMLButtonElement && !report.disabled && run?.textContent?.includes("Research");
        },
        undefined,
        { timeout: 300_000 },
      );
      responseBody = await response.text();
    } catch (error) {
      const screenshot = "/private/tmp/atlas-browser-live-failure.png";
      await page.screenshot({ path: screenshot, fullPage: true }).catch(() => undefined);
      throw new Error(
        `credentialed live browser run failed; screenshot: ${screenshot}; console: ${JSON.stringify(consoleIssues)}; page errors: ${JSON.stringify(pageErrors)}`,
        { cause: error },
      );
    }
    const events = responseBody
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      events.map((event) => event.seq),
      Array.from({ length: events.length }, (_, index) => index + 1),
    );
    const terminalEvents = events.filter((event) => event.name === "result.terminal");
    assert.equal(terminalEvents.length, 1, "live stream must contain exactly one terminal result");
    const report = terminalEvents[0].payload?.report;
    assert.ok(report, "terminal event omitted its report");
    assert.ok(
      !["failed", "configuration_error", "blocked"].includes(report.status),
      report.stop?.detail ?? `unexpected status ${report.status}`,
    );

    const search = events.find(
      (event) => event.kind === "span_end" && event.name === "tool.search_web" && event.status === "succeeded",
    );
    assert.ok(search, "no successful search_web span was recorded");
    assert.ok(search.usage?.searchCalls >= 1, "search_web did not account for a search call");
    assert.ok(search.usage?.networkRequests >= 1, "search_web did not account for a network request");

    const diagnostics = diagnosticsFromEvents(events);
    const diagnosticCodes = new Set(diagnostics.map((diagnostic) => diagnostic.code));
    const discoveryEvidence = report.evidence.filter((evidence) => evidence.verificationMethod === "search_discovery");
    const discoveryOnlyEvidence = report.evidence.filter((evidence) => evidence.disposition === "discovery_only");
    const publicWebProviders = new Set([
      "gemini:google_search",
      "openai:web_search",
      "openrouter:web_search",
      "duckduckgo:html_search",
    ]);
    const observedPublicWebProviders = new Set(
      discoveryEvidence
        .map((evidence) => evidence.attributes?.provider)
        .filter((provider) => publicWebProviders.has(provider)),
    );
    assert.ok(
      observedPublicWebProviders.size >= 1,
      "search succeeded without provider-native or bounded public-web discovery provenance",
    );
    assert.equal(
      discoveryEvidence.every((evidence) => evidence.attributes?.provider !== "github:public_user_search") ||
        observedPublicWebProviders.size > 0,
      true,
      "GitHub exact-name lookup cannot be the only successful web discovery surface",
    );
    if (diagnosticCodes.has("search_provider_quota_exhausted") || diagnosticCodes.has("search_provider_unavailable")) {
      assert.ok(
        observedPublicWebProviders.has("duckduckgo:html_search"),
        "provider outage did not fail over to genuine public-web discovery",
      );
      assert.ok(
        diagnosticCodes.has("public_web_fallback_used") || diagnosticCodes.has("duckduckgo_html_fallback_used"),
        "public-web fallback use was not diagnosed",
      );
      assert.match(
        await page.locator(".workspace-message").innerText(),
        /public-web fallback/i,
        "degraded provider state was hidden from the run banner",
      );
    }

    const fetchSpan = events.find(
      (event) =>
        event.kind === "span_end" &&
        event.name === "tool.fetch_public_source" &&
        ["succeeded", "partial"].includes(event.status),
    );
    assert.ok(fetchSpan, "no succeeded or partial hardened fetch span was recorded");
    assert.ok(fetchSpan.usage?.networkRequests >= 1, "hardened fetch did not make a network request");
    assert.ok(fetchSpan.usage?.bytesRead > 0, "hardened fetch read no response bytes");

    const directEvidence = report.evidence.filter(
      (evidence) => evidence.verificationMethod === "direct_fetch" && evidence.disposition === "supports",
    );
    assert.ok(directEvidence.length >= 1, "report has no supporting direct-fetch evidence");
    for (const evidence of directEvidence) {
      assert.equal(new URL(evidence.canonicalUrl).protocol, "https:");
      assert.equal(evidence.httpStatus, 200);
      assert.ok(
        evidence.title && !/^Public source at /i.test(evidence.title),
        "direct evidence retained a placeholder title",
      );
      assert.equal(evidence.excerpt, evidence.claim, "direct evidence claim must equal its exact excerpt");
      assert.match(evidence.contentHash, /^sha256:[a-f0-9]{64}$/);
    }
    const directIds = new Set(directEvidence.map((evidence) => evidence.id));
    assert.ok(report.findings.length >= 1, "report has no grounded finding");
    assert.ok(
      report.findings.some((finding) => finding.evidenceIds?.some((id) => directIds.has(id))),
      "no finding cites direct evidence",
    );

    const finalGraph = report.searchGraph;
    assert.ok(finalGraph?.nodes?.length > 0, "live terminal omitted its nonempty graph");
    await page.waitForFunction(
      () => document.querySelector(".graph-canvas")?.getAttribute("data-layout-source") === "elk",
      undefined,
      { timeout: 10_000 },
    );
    const liveGeometry = await page.evaluate(stopLiveGeometrySampler);
    assert.ok(
      liveGeometry.positiveCounts.length >= 2,
      `live UI did not visibly stream graph growth: ${JSON.stringify(liveGeometry.positiveCounts)}`,
    );
    assert.deepEqual(
      liveGeometry.failures,
      [],
      "live mobile graph overlapped, overflowed, or became unreadable while streaming",
    );
    await page.locator(".graph-fit-button").click();
    await page.waitForTimeout(500);
    assertLayout(await renderedLayout(page, finalGraph), finalGraph, viewports[1]);
    await page.setViewportSize(viewports[0]);
    await page.locator(".graph-fit-button").click();
    await page.waitForTimeout(500);
    assertLayout(await renderedLayout(page, finalGraph), finalGraph, viewports[0]);

    const ladder = page.locator(".source-ladder");
    await page.waitForFunction(
      () => document.querySelector(".source-ladder-toggle")?.getAttribute("aria-expanded") === "true",
    );
    const ladderText = await ladder.innerText();
    assert.match(ladderText, /(?:cited|lead|tr(?:y|ies))/i, "source ladder hid all attempts, leads, and citations");

    await page.getByRole("button", { name: "Report", exact: true }).click();
    const reportDialog = page.getByRole("dialog", { name: query });
    await reportDialog.waitFor({ state: "visible" });
    const directUrls = new Set(directEvidence.map(evidenceUrl));
    const ledgerUrls = new Set(
      await reportDialog
        .locator(".evidence-source-link")
        .evaluateAll((anchors) => anchors.map((anchor) => anchor.href)),
    );
    for (const url of directUrls)
      assert.ok(ledgerUrls.has(url), `report evidence ledger omitted direct citation ${url}`);
    const citedDirectUrls = new Set(
      report.findings
        .flatMap((finding) => finding.evidenceIds ?? [])
        .filter((id) => directIds.has(id))
        .map((id) => evidenceUrl(report.evidence.find((evidence) => evidence.id === id))),
    );
    const findingUrls = new Set(
      await reportDialog.locator(".source-cite").evaluateAll((anchors) => anchors.map((anchor) => anchor.href)),
    );
    for (const url of citedDirectUrls)
      assert.ok(findingUrls.has(url), `rendered finding omitted its direct source ${url}`);
    assert.equal(
      await reportDialog.locator(".report-evidence-list .is-discovery-lead").count(),
      discoveryOnlyEvidence.length,
      "discovery-only search leads and passive metadata observations were not visibly separated",
    );
    assert.equal(
      await reportDialog
        .locator(".evidence-source-link")
        .evaluateAll((anchors) => anchors.some((anchor) => /^Public source at /i.test(anchor.textContent ?? ""))),
      false,
      "report rendered a placeholder source title",
    );
    await page.getByRole("button", { name: "Close report" }).click();
    if (diagnostics.some((diagnostic) => diagnostic.severity !== "info")) {
      await page.locator(".trace-rail-handle").click();
      assert.ok((await page.locator(".trace-event-list .has-diagnostic").count()) >= 1, "trace hid live diagnostics");
    }
    assert.deepEqual(consoleIssues, [], "live browser emitted console warnings/errors");
    assert.deepEqual(pageErrors, [], "live browser emitted uncaught errors");
  },
);

import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright";
import {
  chromeSelectors,
  denseReplayFixture,
  graphChromeCollisions,
  intersectingRectangles,
} from "./fixture.mjs";

const baseUrl = new URL(process.env.ATLAS_BROWSER_E2E_BASE_URL ?? "http://localhost:3000/");
const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];

async function assertServerReady() {
  try {
    const response = await fetch(baseUrl, { signal: AbortSignal.timeout(10_000) });
    assert.equal(response.ok, true);
  } catch (error) {
    throw new Error(`Atlas is not reachable at ${baseUrl}. Start it with npm run dev before browser QA.`, { cause: error });
  }
}

async function renderedLayout(page, graph) {
  return page.evaluate(({ chromeSelectors: selectors, graphEdges }) => {
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
    const nodes = nodeElements.map((element) => ({
      ...rect(element, element.getAttribute("data-id") ?? "unknown-node"),
      layoutWidth: element.offsetWidth,
      layoutHeight: element.offsetHeight,
      button: element.querySelector("button")
        ? rect(element.querySelector("button"), `${element.getAttribute("data-id")}:button`)
        : null,
    }));
    const chrome = selectors.flatMap((selector) => [...document.querySelectorAll(selector)]
      .filter((element) => {
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && Number.parseFloat(style.opacity || "1") > 0.05
          && bounds.width > 0
          && bounds.height > 0;
      })
      .map((element, index) => rect(element, `${selector}:${index}`)));
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
            point.x > node.left + 3
            && point.x < node.right - 3
            && point.y > node.top + 3
            && point.y < node.bottom - 3
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
      chrome,
      edgeNodeCrossings,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      viewportWidth: window.innerWidth,
    };
  }, { chromeSelectors, graphEdges: graph.edges });
}

function assertLayout(layout, graph, viewport) {
  assert.equal(layout.nodes.length, graph.nodes.length, `${viewport.name}: every graph node must render`);
  assert.equal(layout.documentWidth, layout.viewportWidth, `${viewport.name}: document overflowed horizontally`);
  assert.equal(layout.bodyWidth, layout.viewportWidth, `${viewport.name}: body overflowed horizontally`);
  assert.deepEqual(intersectingRectangles(layout.nodes), [], `${viewport.name}: graph nodes overlap`);
  assert.deepEqual(graphChromeCollisions(layout.nodes, layout.chrome), [], `${viewport.name}: nodes overlap fixed graph chrome`);
  assert.deepEqual(layout.edgeNodeCrossings, [], `${viewport.name}: an edge crosses an unrelated node`);
  assert.equal(new Set(layout.nodes.map((node) => node.layoutWidth)).size, 1, `${viewport.name}: node layout widths diverged`);
  assert.equal(new Set(layout.nodes.map((node) => node.layoutHeight)).size, 1, `${viewport.name}: node layout heights diverged`);
  for (const node of layout.nodes) {
    assert.ok(node.layoutWidth >= 220 && node.layoutWidth <= 360, `${viewport.name}: ${node.id} has an invalid layout width ${node.layoutWidth}`);
    assert.ok(node.layoutHeight >= 72 && node.layoutHeight <= 120, `${viewport.name}: ${node.id} has an invalid layout height ${node.layoutHeight}`);
    assert.ok(node.button, `${viewport.name}: ${node.id} has no interactive card`);
    assert.ok(node.button.left >= node.left - 1 && node.button.right <= node.right + 1, `${viewport.name}: ${node.id} card escapes horizontally`);
    assert.ok(node.button.top >= node.top - 1 && node.button.bottom <= node.bottom + 1, `${viewport.name}: ${node.id} card escapes vertically`);
  }
}

test("dense intercepted NDJSON has collision-free desktop and mobile graph geometry", { timeout: 90_000 }, async () => {
  await assertServerReady();
  const fixture = await denseReplayFixture();
  const browser = await chromium.launch({ headless: true });
  try {
    for (const viewport of viewports) {
      const page = await browser.newPage({ viewport });
      const consoleIssues = [];
      const pageErrors = [];
      let researchRequest = null;
      page.on("console", (message) => {
        if (["warning", "error"].includes(message.type())) consoleIssues.push(`${message.type()}: ${message.text()}`);
      });
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.route("**/api/health", (route) => route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ status: "ok", liveConfigured: true }),
      }));
      await page.route("**/api/research", async (route) => {
        researchRequest = route.request().postDataJSON();
        await route.fulfill({
          status: 200,
          headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
          body: fixture.ndjson,
        });
      });
      try {
        const healthResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/health");
        await page.goto(baseUrl.href, { waitUntil: "domcontentloaded" });
        await healthResponse;
        const searchbox = page.getByRole("searchbox", { name: "Public-professional research input" });
        await searchbox.fill("Chris Anderson, TED");
        assert.equal(await searchbox.inputValue(), "Chris Anderson, TED");
        const researchResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/research");
        await page.getByRole("button", { name: "Research", exact: true }).click();
        await researchResponse;
        await page.locator(".react-flow__node").nth(fixture.graph.nodes.length - 1).waitFor({ timeout: 20_000 });
        await page.locator(".graph-fit-button").click();
        await page.waitForTimeout(900);
        assert.equal(researchRequest?.query, "Chris Anderson, TED");
        assert.equal(researchRequest?.mode, "live");
        const layout = await renderedLayout(page, fixture.graph);
        assertLayout(layout, fixture.graph, viewport);
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
});

test("credentialed live contract returns fetched citations and grounded findings", {
  skip: process.env.ATLAS_LIVE_E2E !== "1",
  timeout: 300_000,
}, async () => {
  const query = process.env.ATLAS_LIVE_E2E_QUERY?.trim() || "Chris Anderson, TED";
  const response = await fetch(new URL("/api/research", baseUrl), {
    method: "POST",
    headers: { accept: "application/x-ndjson", "content-type": "application/json" },
    body: JSON.stringify({
      query,
      mode: "live",
      requestedDepth: "standard",
      requestedCategories: ["identity", "employment", "online_presence"],
    }),
    signal: AbortSignal.timeout(285_000),
  });
  const responseBody = await response.text();
  assert.equal(response.ok, true, `live API returned HTTP ${response.status}: ${responseBody}`);
  const events = responseBody.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => event.seq), Array.from({ length: events.length }, (_, index) => index + 1));
  const terminalEvents = events.filter((event) => event.name === "result.terminal");
  assert.equal(terminalEvents.length, 1, "live stream must contain exactly one terminal result");
  const report = terminalEvents[0].payload?.report;
  assert.ok(report, "terminal event omitted its report");
  assert.ok(!["failed", "configuration_error", "blocked"].includes(report.status), report.stop?.detail ?? `unexpected status ${report.status}`);

  const search = events.find((event) =>
    event.kind === "span_end"
    && event.name === "tool.search_web"
    && event.status === "succeeded");
  assert.ok(search, "no successful search_web span was recorded");
  assert.ok(search.usage?.searchCalls >= 1, "search_web did not account for a search call");
  assert.ok(search.usage?.networkRequests >= 1, "search_web did not account for a network request");

  const fetchSpan = events.find((event) =>
    event.kind === "span_end"
    && event.name === "tool.fetch_public_source"
    && ["succeeded", "partial"].includes(event.status));
  assert.ok(fetchSpan, "no succeeded or partial hardened fetch span was recorded");
  assert.ok(fetchSpan.usage?.networkRequests >= 1, "hardened fetch did not make a network request");
  assert.ok(fetchSpan.usage?.bytesRead > 0, "hardened fetch read no response bytes");

  const directEvidence = report.evidence.filter((evidence) =>
    evidence.verificationMethod === "direct_fetch"
    && evidence.disposition === "supports");
  assert.ok(directEvidence.length >= 1, "report has no supporting direct-fetch evidence");
  for (const evidence of directEvidence) {
    assert.equal(new URL(evidence.canonicalUrl).protocol, "https:");
    assert.equal(evidence.httpStatus, 200);
    assert.ok(evidence.title && !/^Public source at /i.test(evidence.title), "direct evidence retained a placeholder title");
    assert.equal(evidence.excerpt, evidence.claim, "direct evidence claim must equal its exact excerpt");
    assert.match(evidence.contentHash, /^sha256:[a-f0-9]{64}$/);
  }
  const directIds = new Set(directEvidence.map((evidence) => evidence.id));
  assert.ok(report.findings.length >= 1, "report has no grounded finding");
  assert.ok(report.findings.some((finding) => finding.evidenceIds?.some((id) => directIds.has(id))), "no finding cites direct evidence");
});

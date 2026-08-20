import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { Builder, By, logging, until } from "selenium-webdriver";
import { Options as ChromeOptions } from "selenium-webdriver/chrome.js";
import {
  chromeChromeCollisions,
  chromeSelectors,
  denseReplayFixture,
  graphChromeCollisions,
  intersectingRectangles,
} from "./fixture.mjs";

const baseUrl = new URL(process.env.ATLAS_BROWSER_E2E_BASE_URL ?? "http://localhost:3000/");
const seleniumBrowser = (process.env.ATLAS_SELENIUM_BROWSER ?? "chrome").toLowerCase();
const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];

assert.ok(
  seleniumBrowser === "chrome" || seleniumBrowser === "safari",
  "ATLAS_SELENIUM_BROWSER must be either `chrome` or `safari`.",
);

function installQaInstrumentation() {
  if (window.__atlasQaInstrumentationInstalled) return;
  window.__atlasQaInstrumentationInstalled = true;
  window.__atlasQaErrors = [];
  window.__atlasQaConsoleIssues = [];
  window.addEventListener("error", (event) => window.__atlasQaErrors.push(event.message || "window error"));
  window.addEventListener("unhandledrejection", (event) =>
    window.__atlasQaErrors.push(String(event.reason ?? "unhandled rejection")),
  );
  for (const level of ["warn", "error"]) {
    const original = console[level].bind(console);
    console[level] = (...values) => {
      window.__atlasQaConsoleIssues.push(`${level}: ${values.map((value) => String(value)).join(" ")}`);
      original(...values);
    };
  }
}

function measureInPage(selectors, graphEdges) {
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
    viewportHeight: window.innerHeight,
    consoleIssues: window.__atlasQaConsoleIssues ?? [],
    pageErrors: window.__atlasQaErrors ?? [],
  };
}

function assertLayout(layout, graph, viewport) {
  assert.equal(
    layout.nodes.length,
    graph.nodes.length,
    `${viewport.name}: every node must render in ${seleniumBrowser}`,
  );
  assert.equal(layout.viewportWidth, viewport.width, `${viewport.name}: ${seleniumBrowser} viewport width`);
  assert.equal(layout.viewportHeight, viewport.height, `${viewport.name}: ${seleniumBrowser} viewport height`);
  assert.equal(layout.documentWidth, layout.viewportWidth, `${viewport.name}: ${seleniumBrowser} document overflow`);
  assert.equal(layout.bodyWidth, layout.viewportWidth, `${viewport.name}: ${seleniumBrowser} body overflow`);
  assert.deepEqual(intersectingRectangles(layout.nodes), [], `${viewport.name}: ${seleniumBrowser} node collisions`);
  assert.deepEqual(
    graphChromeCollisions(layout.visibleNodes, layout.chrome),
    [],
    `${viewport.name}: ${seleniumBrowser} graph/chrome collisions`,
  );
  assert.deepEqual(
    chromeChromeCollisions(layout.chrome),
    [],
    `${viewport.name}: ${seleniumBrowser} chrome/chrome collisions`,
  );
  assert.deepEqual(layout.edgeNodeCrossings, [], `${viewport.name}: ${seleniumBrowser} edge crossed an unrelated node`);
  for (const node of layout.nodes) {
    assert.ok(node.width >= 120, `${viewport.name}: ${seleniumBrowser} ${node.id} is too narrow to read`);
    assert.ok(node.height >= 38, `${viewport.name}: ${seleniumBrowser} ${node.id} is too short to read`);
    assert.deepEqual(node.textCollisions, [], `${viewport.name}: ${seleniumBrowser} ${node.id} text overlaps`);
  }
  assert.deepEqual(layout.consoleIssues, [], `${viewport.name}: ${seleniumBrowser} console warnings/errors`);
  assert.deepEqual(layout.pageErrors, [], `${viewport.name}: ${seleniumBrowser} page errors`);
}

async function setViewport(driverInstance, viewport) {
  if (seleniumBrowser === "chrome") {
    await driverInstance.sendDevToolsCommand("Emulation.setDeviceMetricsOverride", {
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      mobile: false,
      screenWidth: viewport.width,
      screenHeight: viewport.height,
    });
    return;
  }
  let width = viewport.width;
  let height = viewport.height;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await driverInstance.manage().window().setRect({ width, height, x: 0, y: 0 });
    const inner = await driverInstance.executeScript(
      "return { width: window.innerWidth, height: window.innerHeight };",
    );
    if (inner.width === viewport.width && inner.height === viewport.height) return;
    width += viewport.width - inner.width;
    height += viewport.height - inner.height;
  }
}

let driver;
try {
  const fixture = await denseReplayFixture();
  const builder = new Builder().forBrowser(seleniumBrowser);
  if (seleniumBrowser === "chrome") {
    const logPreferences = new logging.Preferences();
    logPreferences.setLevel(logging.Type.BROWSER, logging.Level.ALL);
    builder
      .setChromeOptions(
        new ChromeOptions()
          .setChromeBinaryPath("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
          .addArguments(
            "--headless=new",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--no-default-browser-check",
            "--no-first-run",
            "--no-sandbox",
            "--window-size=1440,900",
          ),
      )
      .setLoggingPrefs(logPreferences);
  }
  try {
    driver = await builder.build();
  } catch (error) {
    const hint =
      seleniumBrowser === "safari"
        ? "Enable Remote Automation manually before running this smoke test; the harness intentionally never runs `safaridriver --enable`."
        : "Confirm Google Chrome is installed and allow Selenium Manager to resolve a compatible ChromeDriver.";
    throw new Error(`${seleniumBrowser} WebDriver could not start. ${hint}`, { cause: error });
  }
  await driver.manage().setTimeouts({ implicit: 0, pageLoad: 30_000, script: 30_000 });
  if (seleniumBrowser === "chrome") {
    await driver.sendDevToolsCommand("Page.addScriptToEvaluateOnNewDocument", {
      source: `(${installQaInstrumentation.toString()})();`,
    });
  }
  await driver.get(baseUrl.href);
  await driver.executeScript(installQaInstrumentation);
  await driver.executeScript(function installAtlasFixture(events) {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(rawUrl, window.location.href);
      if (url.pathname === "/api/research") {
        const encoder = new TextEncoder();
        let index = 0;
        let canceled = false;
        const stream = new ReadableStream({
          start(controller) {
            const emit = () => {
              if (canceled) return;
              if (index >= events.length) {
                controller.close();
                return;
              }
              controller.enqueue(encoder.encode(`${JSON.stringify(events[index])}\n`));
              index += 1;
              window.__atlasSeleniumEmitted = index;
              if (index >= events.length) window.setTimeout(() => controller.close(), 50);
            };
            window.__atlasSeleniumAdvance = () => window.setTimeout(emit, 50);
            emit();
          },
          cancel() {
            canceled = true;
          },
        });
        return Promise.resolve(
          new Response(stream, {
            status: 200,
            headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
          }),
        );
      }
      return originalFetch(input, init);
    };
  }, fixture.events);
  await setViewport(driver, viewports[0]);
  const search = await driver.wait(until.elementLocated(By.css('input[name="query"]')), 10_000);
  await driver.wait(
    () =>
      driver.executeScript("return Object.keys(arguments[0]).some((key) => key.startsWith('__reactProps$'));", search),
    10_000,
    "Atlas search input did not hydrate",
  );
  await search.clear();
  await search.sendKeys("Chris Anderson, TED");
  await driver.wait(
    async () => (await search.getAttribute("value")) === "Chris Anderson, TED",
    5_000,
    "Atlas search input did not retain the query",
  );
  await driver.findElement(By.css(".run-button")).click();
  await driver.wait(until.elementIsEnabled(await driver.findElement(By.css(".graph-fit-button"))), 10_000);

  const checkpointGraphs = fixture.events
    .map((event) => event.payload?.searchGraph ?? event.payload?.report?.searchGraph)
    .filter(Boolean);
  for (let index = 0; index < checkpointGraphs.length; index += 1) {
    const checkpoint = checkpointGraphs[index];
    await driver.wait(
      async () =>
        (await driver.executeScript("return window.__atlasSeleniumEmitted;")) === index + 1 &&
        (await driver.findElements(By.css(".react-flow__node"))).length === checkpoint.nodes.length,
      20_000,
      `Selenium did not render streamed graph checkpoint ${index + 1}`,
    );
    await driver.findElement(By.css(".graph-fit-button")).click();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const layout = await driver.executeScript(measureInPage, chromeSelectors, checkpoint.edges);
    assertLayout(layout, checkpoint, viewports[0]);
    if (index < checkpointGraphs.length - 1) {
      await driver.executeScript("window.__atlasSeleniumAdvance();");
    }
  }

  for (const viewport of viewports) {
    await setViewport(driver, viewport);
    await driver.findElement(By.css(".graph-fit-button")).click();
    await new Promise((resolve) => setTimeout(resolve, 900));
    const layout = await driver.executeScript(measureInPage, chromeSelectors, fixture.graph.edges);
    assertLayout(layout, fixture.graph, viewport);
  }
  if (seleniumBrowser === "chrome") {
    const browserLogs = await driver.manage().logs().get(logging.Type.BROWSER);
    const warningOrWorse = browserLogs.filter((entry) => entry.level.value >= logging.Level.WARNING.value);
    assert.deepEqual(warningOrWorse, [], "chrome emitted browser-console warnings/errors");
  }
  console.log(`Selenium/${seleniumBrowser} graph QA passed at desktop and mobile sizes.`);
} catch (caught) {
  const error = caught instanceof Error ? caught : new Error(String(caught));
  if (driver) {
    const screenshot = `/private/tmp/atlas-selenium-${seleniumBrowser}-failure.png`;
    await driver
      .takeScreenshot()
      .then((base64) => writeFile(screenshot, base64, "base64"))
      .catch(() => undefined);
    error.message += ` Screenshot, when available: ${screenshot}`;
  }
  throw error;
} finally {
  await driver?.quit().catch(() => undefined);
}

import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { Builder, By, logging, until } from "selenium-webdriver";
import { Options as ChromeOptions } from "selenium-webdriver/chrome.js";
import {
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
  window.addEventListener("unhandledrejection", (event) => window.__atlasQaErrors.push(String(event.reason ?? "unhandled rejection")));
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
    return { id, left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom, width: bounds.width, height: bounds.height };
  };
  const nodeElements = [...document.querySelectorAll(".react-flow__node")];
  const nodes = nodeElements.map((element) => ({
    ...rect(element, element.getAttribute("data-id") ?? "unknown-node"),
    layoutWidth: element.offsetWidth,
    layoutHeight: element.offsetHeight,
  }));
  const chrome = selectors.flatMap((selector) => [...document.querySelectorAll(selector)]
    .filter((element) => {
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && Number.parseFloat(style.opacity || "1") > 0.05 && bounds.width > 0 && bounds.height > 0;
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
        if (point.x > node.left + 3 && point.x < node.right - 3 && point.y > node.top + 3 && point.y < node.bottom - 3) {
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
    viewportHeight: window.innerHeight,
    consoleIssues: window.__atlasQaConsoleIssues ?? [],
    pageErrors: window.__atlasQaErrors ?? [],
  };
}

function assertLayout(layout, graph, viewport) {
  assert.equal(layout.nodes.length, graph.nodes.length, `${viewport.name}: every node must render in ${seleniumBrowser}`);
  assert.equal(layout.viewportWidth, viewport.width, `${viewport.name}: ${seleniumBrowser} viewport width`);
  assert.equal(layout.viewportHeight, viewport.height, `${viewport.name}: ${seleniumBrowser} viewport height`);
  assert.equal(layout.documentWidth, layout.viewportWidth, `${viewport.name}: ${seleniumBrowser} document overflow`);
  assert.equal(layout.bodyWidth, layout.viewportWidth, `${viewport.name}: ${seleniumBrowser} body overflow`);
  assert.deepEqual(intersectingRectangles(layout.nodes), [], `${viewport.name}: ${seleniumBrowser} node collisions`);
  assert.deepEqual(graphChromeCollisions(layout.nodes, layout.chrome), [], `${viewport.name}: ${seleniumBrowser} graph/chrome collisions`);
  assert.deepEqual(layout.edgeNodeCrossings, [], `${viewport.name}: ${seleniumBrowser} edge crossed an unrelated node`);
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
    const inner = await driverInstance.executeScript("return { width: window.innerWidth, height: window.innerHeight };");
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
      .setChromeOptions(new ChromeOptions()
        .setChromeBinaryPath("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
        .addArguments(
          "--headless=new",
          "--disable-dev-shm-usage",
          "--disable-gpu",
          "--no-default-browser-check",
          "--no-first-run",
          "--no-sandbox",
          "--window-size=1440,900",
        ))
      .setLoggingPrefs(logPreferences);
  }
  try {
    driver = await builder.build();
  } catch (error) {
    const hint = seleniumBrowser === "safari"
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
  await driver.executeScript(function installAtlasFixture(ndjson) {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(rawUrl, window.location.href);
      if (url.pathname === "/api/research") {
        return Promise.resolve(new Response(ndjson, {
          status: 200,
          headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
        }));
      }
      return originalFetch(input, init);
    };
  }, fixture.ndjson);
  const search = await driver.wait(until.elementLocated(By.css('input[name="query"]')), 10_000);
  await driver.wait(
    () => driver.executeScript(
      "return Object.keys(arguments[0]).some((key) => key.startsWith('__reactProps$'));",
      search,
    ),
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
  await driver.wait(async () => (await driver.findElements(By.css(".react-flow__node"))).length === fixture.graph.nodes.length, 20_000);
  await driver.wait(until.elementIsEnabled(await driver.findElement(By.css(".graph-fit-button"))), 10_000);

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
    await driver.takeScreenshot().then((base64) => writeFile(screenshot, base64, "base64")).catch(() => undefined);
    error.message += ` Screenshot, when available: ${screenshot}`;
  }
  throw error;
} finally {
  await driver?.quit().catch(() => undefined);
}

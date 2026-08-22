import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sites } from "@openai/sites-vite-plugin";
import vinext from "vinext";
import { defineConfig, type Plugin } from "vite";

/**
 * Injects optional local-only demo fixtures from a git-ignored `local-demo/`
 * folder as a virtual module. Importing it for side effect installs the
 * captured runs on globalThis, where the API router (lib/api/local-demo.ts)
 * reads them. When the folder is absent — every normal checkout — the module
 * installs an empty list and the app behaves exactly as if it were not here, so
 * no hardcoded demo content is ever required by, or baked into, the tree.
 */
function localDemoFixturesPlugin(enabled: boolean): Plugin {
  const virtualId = "virtual:atlas-local-demo";
  const resolvedId = `\0${virtualId}`;
  const folder = fileURLToPath(new URL("./local-demo/", import.meta.url));

  const readFixtures = (): unknown[] => {
    if (!enabled) return [];
    let entries: string[];
    try {
      entries = readdirSync(folder).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
    const fixtures: unknown[] = [];
    for (const name of entries) {
      try {
        const raw = JSON.parse(readFileSync(new URL(name, new URL("./local-demo/", import.meta.url)), "utf8"));
        if (
          raw &&
          typeof raw === "object" &&
          typeof raw.query === "string" &&
          raw.input &&
          typeof raw.input === "object" &&
          Array.isArray(raw.trace)
        ) {
          fixtures.push(raw);
        }
      } catch {
        // A malformed local fixture is simply skipped; the demo stays inert.
      }
    }
    return fixtures;
  };

  return {
    name: "atlas:local-demo-fixtures",
    resolveId(source) {
      return source === virtualId ? resolvedId : null;
    },
    load(id) {
      if (id !== resolvedId) return null;
      const fixtures = readFixtures();
      return [
        `const fixtures = ${JSON.stringify(fixtures)};`,
        `globalThis.__ATLAS_LOCAL_DEMO_FIXTURES__ = fixtures;`,
        `export const LOCAL_DEMO_FIXTURES = fixtures;`,
      ].join("\n");
    },
  };
}

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
};

/**
 * Vinext's SSR environment otherwise mirrors every client-only lazy chunk into
 * the Worker module graph. Replace only the SSR references with inert stubs;
 * the client environment still receives the real React Flow/ELK and
 * React-PDF download chunks.
 */
function browserHeavySsrStubs(): Plugin {
  const graphCanvasStub = "\0atlas:ssr-graph-canvas";
  const reportDownloadsStub = "\0atlas:ssr-report-downloads";

  return {
    name: "atlas:browser-heavy-ssr-stubs",
    enforce: "pre",
    applyToEnvironment: (environment) => environment.name === "ssr",
    resolveId(source, importer) {
      const normalizedImporter = importer?.replaceAll("\\", "/").split("?", 1)[0];
      if (source === "./graph-canvas" && normalizedImporter?.endsWith("/app/components/graph-workspace.tsx")) {
        return graphCanvasStub;
      }
      if (source === "./report/downloads.client" && normalizedImporter?.endsWith("/app/workbench.tsx")) {
        return reportDownloadsStub;
      }
      return null;
    },
    load(id) {
      if (id === graphCanvasStub) {
        return "export function GraphCanvas() { return null; }";
      }
      if (id === reportDownloadsStub) {
        return [
          'const browserOnly = () => { throw new Error("Report downloads are browser-only."); };',
          "export const downloadReportMarkdown = browserOnly;",
          "export const downloadReportPdf = browserOnly;",
        ].join("\n");
      }
      return null;
    },
  };
}

export default defineConfig(async ({ command }) => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSeatbeltSandbox ? { watch: { useFsEvents: false, usePolling: true } } : undefined,
    environments: {
      client: {
        // These libraries live behind a client-only dynamic import, so Vite's
        // initial scan cannot discover them. Pre-bundling prevents the first
        // graph/PDF render from receiving an Outdated Optimize Dep response.
        optimizeDeps: { include: ["@xyflow/react", "elkjs/lib/elk.bundled.js", "@react-pdf/renderer"] },
      },
    },
    plugins: [
      vinext(),
      browserHeavySsrStubs(),
      // Captured fixtures are a development convenience only. Production
      // builds always install an empty virtual module, even when an ignored
      // local-demo folder happens to exist in the checkout.
      localDemoFixturesPlugin(command === "serve"),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});

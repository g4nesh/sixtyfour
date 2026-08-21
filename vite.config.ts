import { sites } from "@openai/sites-vite-plugin";
import vinext from "vinext";
import { defineConfig, type Plugin } from "vite";

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

export default defineConfig(async () => {
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
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});

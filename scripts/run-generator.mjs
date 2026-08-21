import { createServer } from "vite";

const vite = await createServer({
  configFile: false,
  cacheDir: `node_modules/.vite-atlas-ssr/${process.pid}`,
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true },
});

try {
  await vite.ssrLoadModule("/scripts/generate-examples.ts");
} finally {
  await vite.close();
}

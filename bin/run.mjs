import { createServer } from "vite";

const vite = await createServer({
  configFile: false,
  cacheDir: `node_modules/.vite-atlas-ssr/${process.pid}`,
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true },
});

let exitCode = 1;
try {
  const { main } = await vite.ssrLoadModule("/bin/atlas.ts");
  exitCode = await main(process.argv.slice(2));
} finally {
  await vite.close();
}
process.exitCode = exitCode;

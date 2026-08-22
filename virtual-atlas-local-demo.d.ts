// Type surface for the build-time virtual module produced by the
// `atlas:local-demo-fixtures` plugin in vite.config.ts. The module installs
// optional local-only demo fixtures on globalThis for its side effect; the
// exported list is empty on any checkout without a git-ignored local-demo/
// folder. See lib/api/local-demo.ts for how the runtime consumes them.
declare module "virtual:atlas-local-demo" {
  import type { LocalDemoFixture } from "./lib/api/local-demo";

  export const LOCAL_DEMO_FIXTURES: LocalDemoFixture[];
}

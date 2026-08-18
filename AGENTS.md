# Atlas repository notes

- Use Node 22.13 or newer. The reproducible path is `docker compose build`.
- `npm run verify` is the release gate: typecheck, lint, tests, and a Vinext production build.
- Replays are the default and must remain deterministic and zero-network.
- Live credentials are server-side Worker bindings only. Never introduce a `NEXT_PUBLIC_*` secret.
- Keep `.openai/hosting.json` bindings at `null`; Atlas does not require D1 or R2.
- Do not weaken candidate separation, evidence admission, trace balancing, or hardened-fetch policy to make a provider payload pass.


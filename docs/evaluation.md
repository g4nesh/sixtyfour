# Evaluation

The default evaluation path serves validated static capture bundles. At hydration time Atlas checks the canonical input/target, evidence graph, source derivation, candidate scores, confidence metadata, requested coverage, stop legality, terminal status, trace ordering/balance/privacy, and cassette references before cloning the captured JSON and trace. Runtime replay never executes cassettes or performs an outbound fetch. The separate example generator uses injected clocks and ID sources to make regenerated artifacts canonical and byte-stable.

The bundles are `source_verified_scripted_reconstruction`, not recordings of an LLM run. Exact source projections and raw HTTP response-body SHA-256 hashes were manually captured at `2026-08-18T22:08:17Z`; decisions are explicitly `scripted_local_policy`. Full bodies are intentionally not committed, so offline replay cannot reproduce the HTTP exchange or independently re-hash it. Cassette v2 preserves the root-verified response hash and binds it to each exact admitted excerpt or canonical API subset.

## Included runs

1. `linus-codegraph`: exact, publicly documented email → Linux documentation → bounded GitHub codegraph → immutable commit/account link. The unsigned Git record stays spoofable and a Linux Foundation source supplies a distinct anchor. The optional Keybase lookup observed no verified GitHub proof and contributes no identity weight.
2. `chris-anderson-ted`: a name plus organization resolves the TED leader while a same-name former WIRED editor/3DR executive remains a quarantined candidate with separate evidence.
3. `python-creator`: a role-only query resolves Guido van Rossum from the official Python site and his public biography.

Each example directory contains `input.json`, `output.json`, `trace.json`, `cassette.json`, and `manifest.json`. The cassette is a provenance binding for the static reconstruction, not a runtime execution script or a substitute for the intentionally omitted response body. Direct-fetch findings preserve exact source excerpts; API records preserve a canonical structured projection and clearly labeled claim rather than a fabricated quote.

## Release checks

`npm run verify` runs:

- TypeScript checking;
- ESLint, including React accessibility rules;
- unit and integration tests for input parsing, safety classes, candidates, evidence/confidence, trace privacy and balancing, budgets/stops, tools, SSRF controls, replay stability, NDJSON API behavior, and server rendering;
- the Vinext production build.

The specialist tool fixtures cover incomplete GitHub search, `author: null`, multiple accounts, signature-identity mismatch, stale Keybase proofs, unavailable Wayback, malformed payloads, response-size and timeout limits, `429`/`Retry-After`, cancellation, and retry accounting.

## Honest limits

Public web indexes are incomplete and change over time. A report is a bounded observation, not a background check. Source ownership can change; archived pages and self-authored profiles need corroboration; cryptographic proof may be stale or revoked; exact excerpts can faithfully preserve a source statement that is itself false; and the OpenRouter model can propose poor actions even though policy code constrains their admission. Replays demonstrate invariants and presentation, not current-world freshness after their capture date.

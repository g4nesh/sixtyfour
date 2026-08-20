# Evaluation

The default evaluation path serves validated static capture bundles. At hydration time Atlas checks the canonical input/target, execution graph, source-lane registration, immutable edge and path costs, best-first/tier ordering, mutation math and execution share, graph/action/trace/evidence joins, evidence graph, source derivation, candidate scores, confidence metadata, requested coverage, stop legality, terminal status, trace ordering/balance/privacy, and cassette references before cloning the captured JSON and trace. Runtime replay never executes cassettes or performs an outbound fetch. The separate example generator uses the same frontier kernel plus injected clocks and ID sources to make regenerated artifacts canonical and byte-stable.

The bundles are `source_verified_scripted_reconstruction`, not recordings of an LLM run. Exact source projections and raw HTTP response-body SHA-256 hashes were manually captured at `2026-08-18T22:08:17Z`; decisions are explicitly `scripted_local_policy`. Full bodies are intentionally not committed, so offline replay cannot reproduce the HTTP exchange or independently re-hash it. Cassette v2 preserves the root-verified response hash and binds it to each exact admitted excerpt or canonical API subset.

## Included runs

1. `linus-codegraph`: exact, publicly documented email → first-party documentation → bounded GitHub codegraph → immutable commit/account link. The unsigned Git record stays spoofable and a Linux Foundation source supplies a distinct anchor. One accepted exact-phrase mutation remains visibly deferred and unexecuted, so it contributes no tool call, network request, or evidence. The optional Keybase lookup observed no verified GitHub proof and contributes no identity weight.
2. `chris-anderson-ted`: a name plus organization resolves the TED leader while a same-name former WIRED editor/3DR executive remains a quarantined candidate with separate evidence. A proposed organization-anchor mutation is deterministically rejected and retained.
3. `python-creator`: a role-only query resolves Guido van Rossum from the official Python site and his public biography. An accepted but unselected structured-professional mutation remains visible, demonstrating that the output does not erase unused branches.

Each example directory contains `input.json`, `output.json`, `trace.json`, `cassette.json`, and `manifest.json`. The cassette is a provenance binding for the static reconstruction, not a runtime execution script or a substitute for the intentionally omitted response body. Direct-fetch findings preserve exact source excerpts; API records preserve a canonical structured projection and clearly labeled claim rather than a fabricated quote.

## Release checks

`npm run verify` runs:

- TypeScript checking;
- ESLint, including React accessibility rules;
- unit and integration tests for input parsing, safety classes, source hierarchy, cumulative-cost ordering, mutation math/caps, LangGraph routing, action binding, candidates, evidence/confidence, trace privacy and balancing, budgets/stops, tools, SSRF controls, replay stability, NDJSON API behavior, Markdown exports, client-only PDF boundaries, and server rendering;
- the Vinext production build.

The release procedure additionally runs the opt-in React-PDF byte smoke, renders an example report to PDF, rasterizes every page, and inspects both page images and extracted text. It also regenerates all 15 example artifacts twice and requires byte-for-byte equality, then exercises the CLI/API terminal matrix and performs responsive, zoomed-text, keyboard, reduced-motion, and high-contrast browser checks.

The specialist tool fixtures cover incomplete GitHub search, `author: null`, multiple accounts, signature-identity mismatch, stale Keybase proofs, unavailable Wayback, exact CDX URL binding, edit/revert capture selection, raw-body hashes, bounded added/removed fragments, inert page-footprint extraction, malformed/oversized metadata, prompt injection, response-size and timeout limits, `429`/`Retry-After`, cancellation, and retry accounting. Frontier tests separately prove neutral-baseline/operator ordering, canonical query execution, official App Store classification, exact-URL T5 scheduling, and denial of cloud/account/iOS-binary enumeration tools.

## Honest limits

Public web indexes are incomplete and change over time. A report is a bounded observation, not a background check. Search path cost expresses traversal priority, not truth or identity confidence. Source ownership can change; archived pages and self-authored profiles need corroboration; cryptographic proof may be stale or revoked; exact excerpts can faithfully preserve a source statement that is itself false; and the OpenRouter model can propose poor actions even though policy code constrains their admission. Deterministic mutation explores only a small finite safe neighborhood and is not evidence of broad web coverage. Replays demonstrate invariants and presentation, not current-world freshness after their capture date.

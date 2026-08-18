# Atlas — People Intelligence

Atlas is an auditable public-source research agent for resolving professional identities. It separates same-name candidates, attaches every finding to direct evidence, exposes the full execution trace, and stops honestly when identity or coverage is insufficient.

The default experience is a deterministic, zero-network replay. Live research is an explicit server-side mode backed by OpenRouter; no provider key is required to evaluate the three included runs.

![Atlas People Intelligence workbench](public/og.png)

## Five-minute replay

Requirements: Node.js `>=22.13.0` and npm.

```bash
npm ci --ignore-scripts
npm run dev
```

Open `http://localhost:3000`, select any example chip, and inspect the dossier, evidence, and trace views. The replay path performs no outbound requests.

The same artifacts are available from the CLI:

```bash
npm run atlas -- examples
npm run atlas -- replay linus-codegraph
npm run atlas -- trace chris-anderson-ted
npm run atlas -- research --mode replay --example python-creator "the creator of Python"
```

Or through the Worker API:

```bash
curl --fail http://localhost:3000/api/health
curl --fail http://localhost:3000/api/examples/linus-codegraph
curl --fail \
  -H 'content-type: application/json' \
  -d '{"query":"Chris Anderson, TED","mode":"replay","exampleId":"chris-anderson-ted"}' \
  http://localhost:3000/api/research
```

`POST /api/research` returns `application/x-ndjson`. Every stream ends in one terminal event, including refusals, cancellation, configuration errors, partial results, and failures.

## Included evidence runs

The example evidence projections and raw-response SHA-256 hashes were manually captured from public sources at `2026-08-18T22:08:17Z`. Each bundle is labeled `source_verified_scripted_reconstruction`: it is a deterministic reconstruction with `scripted_local_policy` decisions, not a replayed live execution or a captured LLM run. Full response bodies are intentionally not committed, so the static bundle cannot re-execute or independently re-hash those network responses. Cassette v2 instead binds each root-verified raw-body hash to the exact admitted source excerpt or canonical API subset.

| Example | Input shape | What it demonstrates |
| --- | --- | --- |
| `linus-codegraph` | Exact user-supplied public email | Linux documentation, bounded GitHub public-commit codegraph, immutable commit/account edges, signature inspection, optional Keybase lookup, and an explicit spoofable-Git confidence cap |
| `chris-anderson-ted` | Name + organization | Selection of the TED leader while a same-name former WIRED editor/3DR executive remains a quarantined candidate with separate evidence |
| `python-creator` | Role only | Resolution of Guido van Rossum using direct official/public professional sources |

Each directory in `examples/` contains `input.json`, `output.json`, `trace.json`, `cassette.json`, and `manifest.json`. Direct-fetch evidence is an exact captured source excerpt; structured API evidence has no quote and is rendered as a labeled canonical API claim. Repeated replays are canonical byte-stable and fail tests if they attempt a network request.

## Live research

Copy `.dev.vars.example` to `.dev.vars` for local Worker development, then set the server-side key:

```dotenv
ATLAS_LIVE_ENABLED=true
OPENROUTER_API_KEY=your_server_side_key
OPENROUTER_MODEL=openai/gpt-5.4
OPENROUTER_SITE_URL=http://localhost:3000
OPENROUTER_APP_NAME=Atlas People Intelligence
```

Never use a `NEXT_PUBLIC_*` variable for the key. HTTP live mode is fail-closed unless both the explicit enablement flag and key are present; the CLI's explicit `--mode live` choice supplies the local enablement signal itself. With live mode configured:

```bash
npm run atlas -- research --mode live --depth standard "Grace Hopper public professional background"

curl --fail \
  -H 'content-type: application/json' \
  -d '{"query":"Grace Hopper public professional background","mode":"live","requestedDepth":"standard"}' \
  http://localhost:3000/api/research
```

Live mode calls OpenRouter Chat Completions directly with custom function schemas, `tool_choice: "auto"`, one expected structured function submission per provider turn, and the current `openrouter:web_search` server tool. The kernel may execute an approved action batch concurrently (maximum four); provider-side parallel function submission is deliberately disabled so every returned tool call is closed deterministically. Search annotations are provider-attested discovery leads only. A claim receives zero final weight until a direct source or specialist tool admits a bounded evidence record. General-purpose `fetch_public_source` fails closed unless the server injects a trusted hostname resolver or controlled egress proxy; the shipped API leaves that path disabled by default, while fixed-provider specialist tools remain available.

The included Sites configuration is replay-only: it contains no provider key and reports `liveConfigured: false`. Do not expose a key-backed live endpoint on unauthenticated public ingress. A production operator must add Cloudflare Access or equivalent authentication plus per-principal request, token, and cost limits before setting `ATLAS_LIVE_ENABLED=true`.

Provider `reasoning_details`, when present, are retained only as opaque continuation data required by the provider. They are never logged or streamed. Atlas exposes only normalized usage and a provider-reported reasoning-token count; unavailable values remain `null` with a reason. Missing configuration returns a `configuration_error`, never fabricated live research.

## Agent architecture

Atlas uses a phased evidence graph rather than an unbounded ReAct loop:

```text
intake → classify → plan → discover → separate_candidates
       → corroborate → calibrate → report → terminal
```

The model may propose a bounded action batch and a short decision summary. A pure-TypeScript kernel owns legal tools, request safety, candidate separation, extractive evidence and finding admission, source-family derivation/deduplication, confidence caps, category coverage, budgets, retries, stopping, and terminal legality. At most four approved outbound actions run concurrently. When two independently fetched pages quote the same full name and organization, ordered kernel admission derives the cross-source signal after the batch; the model cannot forge it.

The report schema includes the run/query/status, every identity candidate, the selected candidate and runner-up margin, candidate-scoped findings, applicable coverage, sources/evidence, limitations, telemetry, usage, and stop reason. Every finding names its `candidateId`, supporting `evidenceIds`, and `counterEvidenceIds`; evidence cannot cross candidates.

See [docs/architecture.md](docs/architecture.md) for the trust boundary and scaling design, [docs/safety.md](docs/safety.md) for the threat model, and [docs/evaluation.md](docs/evaluation.md) for replay provenance and the test matrix.

## Differentiated OSINT tactics

### Exact email → GitHub codegraph

`github_email_codegraph` is legal only when the user explicitly supplied one exact email. It searches GitHub public commits with the literal `author-email:<exact> is:public` qualifier, normalizes immutable commit URLs and SHAs, records linked accounts/repositories/dates, and inspects the strongest commit's signature. It may query Keybase only for a GitHub login already linked by that graph.

Raw Git author metadata is labeled spoofable. A verified signature helps only when its verified identity matches the relevant author edge. Git-only support cannot reach high confidence; a distinct non-Git source family or genuinely unique strong anchor is required. Zero hits means “not observed in indexed public default branches,” not “no activity,” and GitHub `incomplete_results` and rate state remain visible.

### Candidate-linked Wayback history

`wayback_profile_history` accepts only an HTTPS profile, team, or personal URL already linked to one candidate. It performs a bounded CDX lookup, collapses duplicate digests, and inspects at most a few snapshots to produce quote-backed Then/Now changes. It cannot discover or merge a candidate, and archive unavailability fails softly.

## Trace semantics

The API, UI, CLI, and examples share one append-only trace schema. Events carry a monotonic `seq`, stable run/event/span and parent IDs, phase, timestamp and cumulative elapsed time, attempt, status, sanitized payload, and normalized usage. The stream covers phase transitions, LLM and tool spans, retries, decisions, candidate gates/scoring, evidence admission, budgets, and the terminal result.

Every started span has exactly one terminal span. Payload sanitation removes secrets, unnecessary contact information, fetched full bodies, and thought/reasoning prose. Provider attempts are reserved before dispatch and charged separately from tool transport; returned prompt, completion, reasoning, and cached-input token counts are normalized, while unavailable fields remain `null` with a reason. The UI can download the structured report as JSON and the exact trace as NDJSON.

## Safety boundary

Atlas is for public professional research only. Its deterministic, tested policy grammar refuses requests for home addresses, phone numbers, family mapping, minors, credentials, medical/financial/protected traits, stalking, contact automation, or precise/live location before any model or network call. The same policy gates action arguments, admitted evidence, open questions, reports, and traces. It is a deliberately bounded fail-closed policy surface rather than a claim to understand every possible euphemism. Atlas never generates or enumerates emails, logs in, uses cookies, bypasses paywalls/CAPTCHAs, queries brokers or breach data, or sends outreach.

Fetched pages are treated as inert hostile data. Direct fetching is HTTPS-only and candidate-scoped, authorizes the exact URL rather than a tracking-stripped lookalike, manually revalidates redirects, blocks localhost/private/link-local/metadata/reserved destinations and suspicious ports, and enforces DNS, MIME, byte, time, redirect, retry, and total-subrequest limits. Arbitrary-host fetching requires an injected trusted resolver or controlled egress proxy and otherwise fails closed.

Atlas is not a background-check service and must not be used for employment, housing, credit, insurance, education, law-enforcement, or other adverse or high-impact decisions.

## Verification

```bash
npm run typecheck
npm run lint
npm test          # production build, then all Node tests
npm run verify    # typecheck + lint + production build + all tests
```

The test suite covers all three target shapes, deterministic safety classes, target parsing, same-name isolation, no cross-candidate evidence, spoofable-confidence caps, source-family deduplication, graph/trace integrity, snippet exclusion, CoT-field exclusion, budgets/cancellation, NDJSON ordering and terminal closure, replay zero-network stability, and rendered accessibility foundations. Tool fixtures cover SSRF/redirect/size/timeout controls, `429`/`Retry-After`, malformed responses, GitHub incomplete results, `author: null`, multiple accounts, signature mismatch, stale Keybase proofs, and unavailable Wayback.

Container verification uses Node 22:

```bash
docker build --target verifier -t atlas-verify .
docker compose up --build
```

The app remains Cloudflare Sites/Vinext compatible. `worker/index.ts` handles the API routes before the Vinext handler; `.openai/hosting.json` intentionally declares no D1 or R2 binding.

## Limits and scaling path

Public indexes are incomplete and change over time. Source ownership, self-authored profiles, archives, commit metadata, and cryptographic proofs can be stale, spoofed, or revoked. Exact excerpts prevent model-authored claims from becoming durable facts, but a quoted source can itself be wrong or misleading; independent corroboration and visible limitations remain necessary. A bounded run can therefore end `ambiguous`, `partial`, rate-limited, budget-exhausted, or canceled rather than forcing an identity.

The current Worker owns one bounded run and keeps no durable user dossier. For higher volume, phase state and trace cursors can move to Cloudflare Workflows, idempotent tool actions to Queues, and encrypted report artifacts to R2 or D1. The centralized evidence-admission and terminal-legality kernel should remain the trust boundary even when provider and tool execution becomes distributed.

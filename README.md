# Atlas — People Intelligence 

Atlas is an auditable public-source research agent for resolving professional identities. Its live scheduler performs a visible best-first search over a canonical execution graph: it expands the lowest-cost legal source frontier first, keeps rejected and ambiguous branches, and reserves a small deterministic Metropolis-Hastings mutation lane for useful adjacent exploration. It separates same-name candidates, attaches every finding to direct evidence, exposes the full execution trace, and stops honestly when identity or coverage is insufficient.

The default experience is a deterministic, zero-network replay. Live research is an explicit server-side mode backed by OpenRouter; no provider key is required to evaluate the three included runs.

![Atlas People Intelligence workbench](public/og.png)

## Five-minute replay

Requirements: Node.js `>=22.13.0` and npm.

```bash
npm ci --ignore-scripts
npm run dev
```

Open `http://localhost:3000`, select a verified capture, and run it. The black graph workspace shows every queued, selected, verified, exhausted, mutated, and rejected path; the source ladder groups retained frontier state and admitted evidence by website tier while execution telemetry reports actual tool calls; the trace remains append-only; and the final report can be downloaded as deterministic Markdown or a polished client-rendered PDF. The replay path performs no outbound requests.

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
| `linus-codegraph` | Exact user-supplied public email | Lowest-cost exact-identifier and first-party paths, a bounded GitHub public-commit codegraph, immutable commit/account edges, signature inspection, an explicit spoofable-Git cap, and one accepted mutation retained as a deferred, unexecuted branch |
| `chris-anderson-ted` | Name + organization | Selection of the TED leader while a same-name former WIRED editor/3DR executive and a rejected organization-anchor mutation remain visible and isolated |
| `python-creator` | Role only | Resolution of Guido van Rossum from first-party and structured professional sources, with the unused accepted mutation branch retained rather than erased |

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

Live mode supports OpenAI, Gemini, or OpenRouter. Structured reasoning uses each provider's chat/tool-calling endpoint; discovery first uses OpenAI Responses `web_search`, Gemini Interactions with native Google Search, or OpenRouter's `openrouter:web_search`. Provider-side parallel function submission is deliberately disabled so every returned tool call is closed deterministically. Search annotations are discovery leads only and remain visibly unverified until Atlas directly fetches and locally quotes the exact HTTPS source. A claim receives zero final weight until a direct source or specialist tool admits a bounded evidence record. General-purpose `fetch_public_source` requires the server-injected DNS resolver used by the shipped HTTP API and still enforces candidate scope, public-address validation, redirects, status/MIME, response size, and request budgets.

`liveConfigured: true` in `/api/health` means a server-side provider is configured; it is not a provider quota probe. Credentialed live smoke tests separately verify a successful search, hardened fetch, admitted exact excerpt, and terminal citation. Rate-limit failures remain explicit and never fabricate a working report.

After a retryable provider-search outage, or a successful provider response with no valid HTTPS source annotations, Atlas attempts one bounded keyless DuckDuckGo HTML request and retains at most eight safe HTTPS titles and targets—never snippets or raw result HTML. For an exact named-person bootstrap, if those public-web results contain no deterministic code-profile lead, Atlas may supplement them with GitHub's official unauthenticated public APIs: exact `in:fullname` search, at most three canonical user-detail records, and exact normalized public-name matches only. GitHub records remain unverified T2 discovery leads; every profile must pass the same DNS-aware hardened HTML fetch and exact-excerpt admission path before it can support a report. Neither fallback retains GitHub email, location, bio, or search snippets.

If structured planning is itself retryably unavailable, a run-scoped circuit breaker permits only policy-derived actions already legal for the selected frontier; it never invents tool arguments or relaxes source tiers. If later synthesis is unavailable, Atlas may retain one explicitly diagnosed deterministic observation only from an unused supporting `direct_fetch` record on the selected non-ambiguous candidate whose claim equals its excerpt, status is HTTP 200, hash is SHA-256, and confidence remains below `0.45`. This low-confidence projection cannot satisfy supported coverage or turn a partial run into a completed one. A successful empty synthesis remains an abstention.

The included Sites configuration is replay-only: it contains no provider key and reports `liveConfigured: false`. Do not expose a key-backed live endpoint on unauthenticated public ingress. A production operator must add Cloudflare Access or equivalent authentication plus per-principal request, token, and cost limits before setting `ATLAS_LIVE_ENABLED=true`.

Provider `reasoning_details`, when present, are retained only as opaque continuation data required by the provider. They are never logged or streamed. Atlas exposes only normalized usage and a provider-reported reasoning-token count; unavailable values remain `null` with a reason. Missing configuration returns a `configuration_error`, never fabricated live research.

The orchestration and presentation layers intentionally reuse mature open-source components: LangGraph.js for conditional agent control, React Flow for the graph canvas, ELK.js for optional client layout, and React-PDF for client-side report rendering. Exact pinned versions and licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Agent architecture

Atlas uses `@langchain/langgraph` as the Worker-safe control harness, but not as a trust boundary. The compiled live graph is explicit:

```text
START → classify → seed_frontier → select_frontier → plan_expansion
      → execute_expansion → admit_expand → assess
      ↘ synthesize ↔ select_frontier → END
```

LangGraph owns conditional control and resumable node boundaries. It does not own tools, evidence, confidence, or stopping. The model may propose a bounded action batch and a short decision summary; Atlas accepts an action only when it binds to a kernel-selected frontier entry with the matching tool, source tier, candidate scope, and stable action ID. A pure-TypeScript kernel owns request safety, candidate separation, extractive evidence and finding admission, source-family derivation/deduplication, confidence caps, category coverage, budgets, retries, stopping, and terminal legality. At most four approved same-tier outbound actions run concurrently. Their results are admitted in stable frontier order, so transport completion order cannot change the graph. When two independently fetched pages quote the same full name and organization, ordered admission derives the cross-source signal after the batch; the model cannot forge it.

### Search frontier

Each frontier edge has a strictly positive immutable cost. The path cost is the parent path cost plus that edge cost; selection sorts by path cost, source tier, depth, insertion ordinal, then ID. Dominated duplicate pivots are pruned, and a higher website tier cannot execute while a legal lower-tier entry remains. Search utility combines relevance, novelty, expected information gain, source prior, transport cost, policy risk, repetition, and depth penalty. These values choose what to investigate next; they never increase evidence or finding confidence.

One seeded proposal slot per batch may use a finite neighboring policy. The acceptance decision is a deterministic SHA-256 draw under a cooled Metropolis-Hastings ratio with forward/reverse neighbor correction. Accepted mutations must still pass every source, safety, candidate, budget, and evidence gate, and executed mutation actions may not exceed 20% of completed tool actions. Rejected, unselected, and exhausted mutation nodes stay in the report graph.

### Website source hierarchy

The kernel searches the strongest legal public-professional tier before broader discovery:

| Tier | Source class | Admission rule |
| --- | --- | --- |
| T0 | Exact user-supplied HTTPS URL, domain/repository/DOI/ORCID/package/handle, or exact email codegraph | Exact-input only; direct content still passes hardened evidence admission |
| T1 | First-party organization pages, official biographies, explicit personal sites | Direct fetch required for evidence |
| T2 | Professional/code profiles, publication indexes, patents, official organization filings, public proof systems | Host-classified and candidate-bound where required; structured claims remain labeled |
| T3 | Universities, conferences, and primary publishers | Direct source required |
| T4 | Reputable reporting and named interviews | Corroboration and timeline context |
| T5 | Candidate-linked Wayback history | Exact already-bound HTTPS URL only |
| T6 | General web discovery and candidate-bound hardened fetches for otherwise unclassified leads | Snippets have zero finding weight; fetched pages still pass identity separation and evidence admission |

People-search sites, reverse-phone services, data brokers, residential/property/tax-assessor surfaces, family mapping, credentials, and private contact enrichment are denied before frontier creation. Official organization filings are allowed only for public-professional organization context.

The schema-v2 report includes the entire canonical `searchGraph` alongside the run/query/status, every identity candidate, selected candidate and runner-up margin, candidate-scoped findings, applicable coverage, sources/evidence, limitations, telemetry, usage, and stop reason. Graph nodes and edges use stable frontier/action IDs that also appear in tool spans and evidence. Every finding names its `candidateId`, supporting `evidenceIds`, and `counterEvidenceIds`; evidence cannot cross candidates. The UI consumes this graph directly and deliberately shows an empty state instead of inventing a network from dossier prose.

See [docs/architecture.md](docs/architecture.md) for the trust boundary and scaling design, [docs/safety.md](docs/safety.md) for the threat model, and [docs/evaluation.md](docs/evaluation.md) for replay provenance and the test matrix.

## Differentiated OSINT tactics

### Exact email → GitHub codegraph

`github_email_codegraph` is legal only when the user explicitly supplied one exact email. It searches GitHub public commits with the literal `author-email:<exact> is:public` qualifier, normalizes immutable commit URLs and SHAs, records linked accounts/repositories/dates, and inspects the strongest commit's signature. It may query Keybase only for a GitHub login already linked by that graph.

Raw Git author metadata is labeled spoofable. A verified signature helps only when its verified identity matches the relevant author edge. Git-only support cannot reach high confidence; a distinct non-Git source family or genuinely unique strong anchor is required. Zero hits means “not observed in indexed public default branches,” not “no activity,” and GitHub `incomplete_results` and rate state remain visible.

### Candidate-linked Wayback history

`wayback_profile_history` accepts only an HTTPS profile, team, or personal URL already linked to one candidate. It performs a bounded CDX lookup, collapses duplicate digests, and inspects at most a few snapshots to produce quote-backed Then/Now changes. It cannot discover or merge a candidate, and archive unavailability fails softly.

## Trace semantics

The API, UI, CLI, and examples share one append-only trace schema. Events carry a monotonic `seq`, stable run/event/span and parent IDs, phase, timestamp and cumulative elapsed time, attempt, status, sanitized payload, and normalized usage. Each live trace batch also attaches the latest sanitized canonical graph snapshot to its final existing event, so the UI can render admitted and status-updated nodes before the terminal report without inventing graph deltas. The stream covers LangGraph node transitions, frontier seeding/selection/pruning/outcomes, source-tier advances, mutation proposals and decisions, LLM and tool spans, retries, candidate gates/scoring, evidence admission, budgets, and the terminal result.

Every started span has exactly one terminal span. Payload sanitation removes secrets, unnecessary contact information, fetched full bodies, and thought/reasoning prose. Provider attempts are reserved before dispatch and charged separately from tool transport; returned prompt, completion, reasoning, and cached-input token counts are normalized, while unavailable fields remain `null` with a reason. The UI can download the deterministic Markdown report, a browser-rendered PDF, the structured report JSON, and the exact trace NDJSON. Markdown and PDF are produced from the same JSON-safe report view model, with stable `E01…` evidence references and explicit labels for exact excerpts versus canonical structured API claims.

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
npm run test:pdf  # opt-in React-PDF byte smoke
npm run report:example  # write matching PDF and Markdown reports under output/
npm run test:browser    # intercepted dense graph in Playwright, desktop + mobile
npm run test:browser:live # opt-in credentialed search/fetch/citation contract
npm run test:selenium   # independent headless Chrome geometry/console pass
```

Set `ATLAS_SELENIUM_BROWSER=safari` to repeat the Selenium smoke in Safari after enabling Safari Developer → Allow Remote Automation. The test harness never changes that operating-system setting itself.

The test suite covers all three target shapes, deterministic safety classes, general identifier parsing, same-name isolation, no cross-candidate evidence, spoofable-confidence caps, source-family deduplication, immutable cumulative costs, tier ordering, dominance pruning, deterministic MH math and mutation-share caps, graph/trace/action integrity, LangGraph control flow, snippet exclusion, CoT-field exclusion, budgets/cancellation, NDJSON ordering and terminal closure, replay zero-network stability, Markdown determinism, PDF smoke, and rendered accessibility foundations. Tool fixtures cover SSRF/redirect/size/timeout controls, `429`/`Retry-After`, malformed responses, GitHub incomplete results, `author: null`, multiple accounts, signature mismatch, stale Keybase proofs, and unavailable Wayback.

Container verification uses Node 22:

```bash
docker build --target verifier -t atlas-verify .
docker compose up --build
```

The app remains Cloudflare Sites/Vinext compatible. `worker/index.ts` handles the API routes before the Vinext handler; `.openai/hosting.json` intentionally declares no D1 or R2 binding.

## Limits and scaling path

Public indexes are incomplete and change over time. Source ownership, self-authored profiles, archives, commit metadata, and cryptographic proofs can be stale, spoofed, or revoked. Exact excerpts prevent model-authored claims from becoming durable facts, but a quoted source can itself be wrong or misleading; independent corroboration and visible limitations remain necessary. A bounded run can therefore end `ambiguous`, `partial`, rate-limited, budget-exhausted, or canceled rather than forcing an identity.

The current Worker owns one bounded run, compiles LangGraph without a checkpointer, and keeps no durable user dossier. For higher volume, canonical graph state and trace cursors can move to a custom Durable Object or Cloudflare Workflow checkpoint boundary, stable-ID tool actions to Queues, and encrypted report artifacts to R2 or D1. The centralized evidence-admission and terminal-legality kernel should remain the trust boundary even when provider and tool execution becomes distributed; a Node-oriented or in-memory LangGraph checkpointer is not a drop-in persistence strategy for a Worker lifecycle.

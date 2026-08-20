# Architecture

Atlas is a best-first public-professional research agent with one canonical execution graph. `@langchain/langgraph` supplies the Worker-safe conditional scheduler; Atlas's deterministic TypeScript kernels remain the only authority for the frontier, safety, candidate separation, evidence, confidence, budgets, and stopping. A language model can propose a small batch of actions and a short user-visible decision summary, but it cannot create graph state or execute an unselected path.

```text
START → classify → seed_frontier → select_frontier → plan_expansion
      → execute_expansion → admit_expand → assess
      ↘ synthesize ↔ select_frontier → END
```

Every transition is explicit. The terminal event is emitted even for a refusal, cancellation, missing provider configuration, budget stop, or partial failure. The harness deliberately does not use a generic `ToolNode` or ReAct executor: `execute_expansion` calls Atlas's policy-gated action layer and `admit_expand` applies results in canonical selected-frontier order.

## Frontier and traversal

`lib/search/frontier.ts` owns the graph transition algebra. Each queued entry records the source lane/tier, target and candidate scope, allowed tools, immutable utility components, strictly positive edge cost, cumulative path cost, depth, stable ordinal, and one action/frontier ID. The comparison key is:

```text
(pathCost, sourceTier, depth, insertionOrdinal, frontierEntryId)
```

This is Dijkstra-like best-first traversal over non-negative immutable costs. Batches contain only entries from the minimum currently executable source tier; within that tier the lowest cumulative-cost legal entries are chosen. The kernel prunes dominated duplicate pivots, rejects lane/tier/tool/candidate forgeries, and prevents callers from deleting nodes or changing an admitted edge or path cost. Parallel transport may finish in any order, but admission uses the original selected order.

The edge-cost function combines relevance, novelty, expected information gain, source prior, execution cost, policy risk, repetition, and depth. It determines exploration order only. It never enters candidate score, evidence confidence, coverage, or stop legality.

### Bounded mutation

At most one slot in a selected batch may be proposed from a finite adjacent policy. The proposal uses a cooled Metropolis-Hastings acceptance probability, including forward and reverse neighbor-count correction, compared with a deterministic SHA-256-derived unit variate. The mutation may alter only an allowlisted search dimension such as an exact phrase, organization anchor, or adjacent source class; it cannot widen the safety boundary or rewrite the target URL/hostname. An executed mutation must still pass all normal action and evidence gates, and completed mutation calls may not exceed 20% of completed tool calls. Proposed, accepted, rejected, and exhausted mutations are retained in `searchGraph` and the trace.

### Source lanes

The source policy is monotone from exact input to broad discovery:

1. T0 exact user-supplied HTTPS URL or public identifier, including exact-email GitHub codegraph.
2. T1 first-party organization pages, official biographies, and explicit personal sites.
3. T2 host-classified professional profiles and structured records: repositories, publication indexes, patents, official organization filings, and public proof systems.
4. T3 universities, conferences, and primary publishers.
5. T4 reputable reporting and named interviews.
6. T5 bounded candidate-linked Wayback history.
7. T6 general web discovery plus candidate-bound hardened fetches for leads that do not deterministically qualify for a stronger lane; annotations remain discovery-only and fetched pages still pass candidate separation.

A higher tier stays queued until lower-tier legal work is exhausted. The hierarchy never turns a source prior into claim confidence. People-search, phonebook, data-broker, residential/property/tax-assessor, family, credential, and private-contact surfaces are denied before graph admission.

## Trust boundary

The model may:

- propose allowlisted tools and JSON arguments for already-selected frontier entries;
- request a stop or synthesis transition for kernel review;
- summarize why a bounded action batch is useful;
- draft findings from already-admitted evidence.

The model may not:

- bypass request safety or outbound URL policy;
- create or merge identity candidates directly;
- convert a search annotation into claim evidence;
- attach one candidate's evidence to another candidate;
- set confidence, budgets, retries, or terminal legality;
- emit hidden reasoning into logs or the client.
- change source tier, cumulative cost, stable action/frontier IDs, or the mutation acceptance result.

The code validates selected-frontier binding, tool names and schemas, charges every attempt, caps action execution at four, admits only direct evidence with a minimal canonical record, derives source families from canonical URLs, materializes findings from exact admitted excerpts, calculates confidence by independent source family, and checks graph and derived-value integrity before reporting. A malformed single-submit provider decision gets at most one constrained repair attempt.

## Canonical execution and evidence graph

The report's required `searchGraph` is runtime state, not a visualization assembled after the run. It contains seed, identifier, source, action, candidate, evidence, finding, and report nodes; explicit expansion, return, support, contradiction, quarantine, grounding, and mutation relationships; every frontier record; source tier/lane; costs; mutation metadata; and telemetry. Stable action/frontier IDs join the selected entry to its tool span, outcome, admitted graph entities, and cassette request. Replays reject dangling edges, forged costs or tiers, invalid Metropolis-Hastings math, illegal tier skips, cross-candidate edges, and mismatched action IDs.

The UI consumes only this exact schema-v2 graph. It does not infer edges from report prose. Rejected same-name candidates, conflicts, unused branches, and exhausted mutations remain visible so the graph is an audit surface rather than a success-only diagram.

The durable graph has four principal nodes:

- `Candidate`: one hypothesized professional identity and its signals.
- `EvidenceRecord`: a direct, bounded public-source observation tied to exactly one candidate.
- `Finding`: a claim tied to one candidate and explicit support and counter-evidence IDs.
- `SourceSummary`: a report-time view grouped by independent source family.

Name equality is never a merge key. Merge-grade signals are strong identifiers such as a corroborated profile URL, personal domain, exact email edge, cryptographic proof, or direct cross-profile link. Name-only first pages become URL-scoped quarantined candidates instead of contaminating a shared-name candidate. Two independent source families that quote the same full name and organization can produce one kernel-derived cross-source resolution signal after ordered batch admission; adapters and the model cannot submit that signal directly. Hard conflicts keep candidates separate. Search snippets and provider annotations are discovery-only and carry zero final claim weight.

Finding titles and descriptions are deterministic projections of exact admitted excerpts. The model may select a proposed grouping, category, and evidence IDs, but the kernel validates the category against quoted text/source semantics, prevents one evidence record from covering unrelated requested categories, and discards model-authored claim prose. This blocks metadata or fluent-summary injection; it cannot prove that the underlying public source itself is truthful.

Confidence uses transparent bands and a rationale-bearing set of caps. Multiple pages from one source family contribute only their strongest evidence. Git author metadata is always spoofable; Git-only support cannot reach `high`. High confidence needs a genuinely unique strong anchor or corroboration from a distinct non-Git source family, without a hard conflict and with a clear runner-up margin.

## Runtime surfaces

- `lib/domain`: versioned JSON-safe schemas, parsing, safety, candidates, evidence, confidence, budgets, stopping, and integrity.
- `lib/search`: ordered source hierarchy, best-first frontier, costs, graph transitions, and deterministic bounded mutation.
- `lib/harness`: explicit LangGraph `StateGraph` topology and conditional routing.
- `lib/agent`: LangGraph-backed run coordinator, deterministic engine, and append-only trace recorder.
- `lib/providers`: hardened OpenAI, Gemini, and OpenRouter clients with native search-grounding normalization and usage accounting.
- `lib/tools`: hardened fetch, exact-email GitHub codegraph, optional Keybase proof lookup, and bounded candidate-linked Wayback history.
- `lib/replay`: immutable example catalog and zero-network replay.
- `lib/report-export`: pure report-to-view-model transformation and deterministic Markdown serialization.
- `lib/api`: Worker-neutral API router used before Vinext's application handler.
- `bin/atlas.ts`: Node CLI sharing the same replay/live orchestration.
- `app`: graph-first client workbench; lazy React Flow/ELK rendering; and click-time React-PDF download rendering.

## Live model protocol

Live mode calls the selected OpenAI, Gemini, or OpenRouter endpoint directly from LangGraph's `plan_expansion` and `synthesize` nodes. Structured turns use custom function schemas, `tool_choice: "auto"`, and one expected structured submission per provider turn (`parallel_tool_calls: false`). Discovery uses the provider's server-side search surface: OpenAI Responses `web_search`, Gemini Interactions with `google_search`, or OpenRouter `openrouter:web_search`. Each path normalizes only server-attested HTTPS citation annotations into discovery capabilities. The planner receives a compact view of the selected frontier and must bind each action to one selected ID. The deterministic runner can execute an approved same-tier batch concurrently, up to four actions. Every provider attempt is reserved before dispatch and settled independently, so repair and concurrent extraction calls count against LLM, network, token, and cost budgets. Provider `reasoning_details`, when returned, are opaque continuation data and are passed back unchanged on the next provider turn. They are never logged or streamed. Only provider-reported prompt, completion, reasoning, and cached-input token counts are exposed; unavailable values remain `null` with a reason.

A retryable provider-search failure on an exact named-person target may invoke one deterministic structured fallback: GitHub's official public user-search API plus at most three canonical user-detail records. Only exact normalized public-name matches become candidate-scoped T2 `code_profile` leads. No API snippet or profile field becomes evidence; the canonical `github.com/<login>` page must still pass hardened DNS/HTTP/body controls and produce a local exact excerpt. The fallback does not apply to role, organization, or broad-topic queries.

Search annotations are provider-attested leads with zero final claim weight. Before egress, Atlas classifies the exact authorized URL from its hostname and already-admitted first-party context; a lead that does not match the selected source lane returns `lead_lane_mismatch` with zero page requests. LinkedIn, for example, is a T2 professional profile rather than a T1 official biography. A final finding must cite an admitted direct-source or specialist-tool evidence record. General-purpose `fetch_public_source` additionally requires a trusted injected hostname resolver or controlled egress proxy and fails closed without one; candidate linkage alone is not presented as DNS-rebinding protection. Hardened transport failures retain a bounded code, HTTP status, attempt, and request count without logging the URL, body, or underlying exception.

## Trace contract

API streams, examples, the UI, and CLI use one append-only event schema. Each event contains a monotonic `seq`, stable run/event/span identifiers, phase, wall timestamp, cumulative elapsed time, attempt, status, sanitized payload, and normalized usage. Live orchestration buffers each runner trace batch until its canonical state update, attaches the sanitized full `searchGraph` to the batch's last existing event, and preserves sequence numbers and event counts. The client accepts only same-run monotonic snapshots, so a stale or empty failure fallback cannot erase useful graph state. Frontier seed/enqueue/select/prune/outcome, tier advance, graph admission, and mutation proposal/decision events retain the audit trail. Span starts have exactly one terminal span event. Payload sanitation removes secret-like values, full response bodies, unnecessary contact information, and any reasoning/thought prose; both SHA hashes and Atlas's canonical `fnv1a32:` content hashes survive structural validation.

## Report rendering

One pure JSON-safe `ReportViewModel` feeds deterministic Markdown and PDF presentation. Evidence receives stable `E01...` references; exact fetched excerpts and canonical structured API claims remain visibly distinct. Markdown escapes hostile syntax and omits raw provider/tool payloads. The browser dynamically imports React-PDF only when the operator clicks PDF download; the Worker API always returns the canonical JSON/NDJSON report, never server-rendered PDF bytes. React Flow and ELK are likewise confined to the client graph chunk, and the accessible list view remains usable without canvas layout.

## Scaling path

The current Worker owns one bounded run and compiles LangGraph without a checkpointer. At higher volume, graph state and the trace cursor can move to a custom Durable Object or Cloudflare Workflow checkpoint boundary, tool actions can be dispatched through Queues with stable action IDs as idempotency keys, and durable reports can be stored in R2 or D1. The evidence admission and terminal legality kernel should remain synchronous and centralized; provider/tool workers should remain untrusted result producers. A generic in-memory or Node-oriented LangGraph checkpointer must not be introduced into the Worker path without a lifecycle and persistence review.

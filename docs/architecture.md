# Architecture

Atlas is a phased evidence-graph agent, not an unbounded chat loop. A language model can propose a small batch of actions and a short, user-visible decision summary. A deterministic TypeScript kernel decides whether those actions are legal and whether their outputs may enter the evidence graph.

```text
intake → classify → plan → discover → separate_candidates
       → corroborate → calibrate → report → terminal
```

Every transition is explicit. The terminal event is emitted even for a refusal, cancellation, missing provider configuration, budget stop, or partial failure.

## Trust boundary

The model may:

- propose allowlisted tools and JSON arguments;
- choose among legal next phases;
- summarize why a bounded action batch is useful;
- draft findings from already-admitted evidence.

The model may not:

- bypass request safety or outbound URL policy;
- create or merge identity candidates directly;
- convert a search annotation into claim evidence;
- attach one candidate's evidence to another candidate;
- set confidence, budgets, retries, or terminal legality;
- emit hidden reasoning into logs or the client.

The code validates tool names and schemas, charges every attempt, caps action execution at four, admits only direct evidence with a minimal canonical record, derives source families from canonical URLs, materializes findings from exact admitted excerpts, calculates confidence by independent source family, and checks graph and derived-value integrity before reporting. A malformed single-submit provider decision gets at most one constrained repair attempt.

## Evidence graph

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
- `lib/agent`: phase runner and append-only trace recorder.
- `lib/providers`: direct OpenRouter Chat Completions client and usage normalization.
- `lib/tools`: hardened fetch, exact-email GitHub codegraph, optional Keybase proof lookup, and bounded candidate-linked Wayback history.
- `lib/replay`: immutable example catalog and zero-network replay.
- `lib/api`: Worker-neutral API router used before Vinext's application handler.
- `bin/atlas.ts`: Node CLI sharing the same replay/live orchestration.
- `app`: client workbench over the same report and trace contracts.

## Live model protocol

Live mode calls OpenRouter Chat Completions directly. It uses custom function schemas, `tool_choice: "auto"`, one expected structured function submission per provider turn (`parallel_tool_calls: false`), and the current `openrouter:web_search` server tool. The deterministic runner can execute an approved action batch concurrently, up to four actions. Every provider attempt is reserved before dispatch and settled independently, so repair and concurrent extraction calls count against LLM, network, token, and cost budgets. Provider `reasoning_details`, when returned, are opaque continuation data and are passed back unchanged on the next provider turn. They are never logged or streamed. Only provider-reported prompt, completion, reasoning, and cached-input token counts are exposed; unavailable values remain `null` with a reason.

Search annotations are provider-attested leads with zero final claim weight. A final finding must cite an admitted direct-source or specialist-tool evidence record. General-purpose `fetch_public_source` additionally requires a trusted injected hostname resolver or controlled egress proxy and fails closed without one; candidate linkage alone is not presented as DNS-rebinding protection.

## Trace contract

API streams, examples, the UI, and CLI use one append-only event schema. Each event contains a monotonic `seq`, stable run/event/span identifiers, phase, wall timestamp, cumulative elapsed time, attempt, status, sanitized payload, and normalized usage. Span starts have exactly one terminal span event. Payload sanitation removes secret-like values, full response bodies, unnecessary contact information, and any reasoning/thought prose.

## Scaling path

The current Worker owns one bounded run. At higher volume, the phase state and trace cursor can move to Cloudflare Workflows, tool actions can be dispatched through Queues with idempotency keys, and durable reports can be stored in R2 or D1. The evidence admission and terminal legality kernel should remain synchronous and centralized; provider/tool workers should remain untrusted result producers.

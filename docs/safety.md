# Safety model

Atlas is restricted to auditable public professional research. It is not for employment, housing, credit, insurance, education, law-enforcement, or other adverse or high-impact decisions.

## Deterministic refusal classes

The deterministic policy grammar is shared by intake, outbound action arguments, evidence/finding admission, open questions, terminal reports, and traces. Its committed boundary matrix covers ordinary variants and professional-domain counterexamples for the classes below. This is a tested, fail-closed policy surface—not a claim of complete semantic understanding of arbitrary language. Intake is blocked before any model or network call when a request seeks:

- home addresses, phone numbers, private contact details, or precise/live location;
- family or relationship mapping, stalking, tracking, harassment, or contact automation;
- minors or vulnerable people;
- credentials, breach data, government identifiers, or financial-account data;
- medical, financial, protected-trait, or other sensitive-personal inference;
- coercion, violence, illegal access, or doxxing.

Atlas never generates or enumerates email addresses. The GitHub email tactic is available only when the user's input already contains one exact email. Allowed reports undergo final redaction and retain only the professional information necessary to support findings.

The checked-in deployment is replay-only. Key-backed live research must remain disabled on public ingress unless an operator adds Cloudflare Access or equivalent authentication and per-principal request, token, and cost limits. `ATLAS_LIVE_ENABLED=true` is an explicit server-side opt-in in addition to the provider key; neither value is exposed to the browser.

## Source policy

No tool may log in, accept cookies, bypass a paywall or CAPTCHA, query a data broker or breach surface, or send outreach. Fetched text is inert hostile data; instructions found in a page do not affect the agent.

The frontier is seeded only with safe public-professional pivots: names, organizations, roles, exact public HTTPS URLs/domains/handles, repositories, DOI/ORCID/publications/packages, and exact user-supplied emails. Raw phone/address input is recognized only to refuse; it never becomes a graph node. Search proceeds T0 exact supplied identifiers → T1 first-party pages → T2 host-classified professional profiles and structured records → T3 institutional/publisher sources → T4 reputable media → T5 candidate-linked Wayback → T6 general discovery and low-trust candidate-bound fetches. Higher tiers cannot run while legal lower-tier work remains. Search ordering changes neither evidence admission nor confidence.

The denied source list includes people-search, reverse-phone, phonebook, data-broker, residential/home-address, property/tax-assessor, family, credential, and breach surfaces, including named common broker/phonebook hosts. These lanes cannot be created by the planner or mutation kernel. Official government or registry pages may be used only for public organization/professional facts, never to enrich a person's residence, property, family, private contact, or protected/sensitive attributes.

Direct fetching is HTTPS-only and candidate-scoped. A provider-attested URL is stored behind an opaque, run-local lead ID; the gate resolves that exact hidden URL for the matching `candidateId`, so a model-rewritten or tracking-stripped lookalike is not sufficient authorization. A deterministic hostname/context classifier must also place that URL in the selected lane before any page request; model prose cannot label LinkedIn as first-party or upgrade a generic host's trust. Credential/private-data query keys, fragments, nested redirect values, URL userinfo, and decoded contact data are rejected before egress or durable evidence admission. Redirects are followed manually only after the new destination passes the same checks. Localhost, loopback, private, link-local, multicast, metadata, reserved/test-network IP literals, suspicious ports, URL credentials, and DNS answers that include blocked address space are rejected. MIME type, byte size, duration, redirects, and retries are capped, including response-stream cleanup and retry-wait failures. General arbitrary-host fetching requires an injected trusted hostname resolver or controlled egress proxy and otherwise fails closed; OpenRouter search annotations remain discovery-only.

Mutation never relaxes this policy. A mutated frontier entry may change only a finite allowlisted search dimension, must resolve to a registered safe source lane/tool/candidate scope, and then passes the same action and evidence gates as a baseline entry. The kernel caps mutation execution at 20% of completed tool calls and retains rejected or exhausted mutation paths for audit.

Retries apply only to idempotent GET requests, at most twice, with bounded exponential backoff, jitter, and `Retry-After` support. Completion POSTs are not retried automatically because doing so can duplicate cost.

## OSINT-specific boundaries

`github_email_codegraph` searches public default-branch commit metadata for the exact supplied email, normalizes immutable commit SHAs/URLs, and optionally checks a few signatures and Keybase proof edges. Git metadata remains spoofable even when it links to a GitHub login. A valid signature is useful only when the verified identity is relevant to the author edge. Zero hits means “not observed in indexed public default branches,” never “no activity.” Incomplete and rate-limited responses are explicit.

`wayback_profile_history` accepts only an HTTPS profile/team/personal URL already linked to one candidate. It collapses duplicate CDX digests and inspects only a few selected snapshots. It can corroborate a temporal change with short quotes, but it cannot discover a candidate, merge candidates, or establish who controlled the page. Archive failure is non-fatal.

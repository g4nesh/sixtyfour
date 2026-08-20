import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "vite";

const vite = await createServer({
  configFile: false,
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true },
});
after(async () => vite.close());

const domain = await vite.ssrLoadModule("/lib/domain/index.ts");
const agent = await vite.ssrLoadModule("/lib/agent/index.ts");
const {
  createLiveDependencies,
  gateExtractedCandidate,
} = await vite.ssrLoadModule("/lib/live/orchestrator.ts");

const ROLE_URL = "https://profiles.example/suzie-bishop";
const UNBOUND_URL = "https://profiles.example/mallory-guess";

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}

function providerResponse({ annotations, content = null, toolCalls, id }) {
  return jsonResponse({
    id,
    model: "test/model",
    choices: [{
      finish_reason: toolCalls ? "tool_calls" : "stop",
      message: {
        role: "assistant",
        content,
        ...(annotations ? { annotations } : {}),
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
      },
    }],
    usage: {
      prompt_tokens: 3,
      completion_tokens: 2,
      reasoning_tokens: 1,
      prompt_tokens_details: { cached_tokens: 1 },
      cost: 0.001,
    },
  });
}

function functionCall(name, value) {
  return {
    id: `call-${name}`,
    type: "function",
    function: { name, arguments: JSON.stringify(value) },
  };
}

function decodeBody(init = {}) {
  if (typeof init.body === "string") return JSON.parse(init.body);
  if (init.body instanceof Uint8Array || init.body instanceof ArrayBuffer) {
    return JSON.parse(new TextDecoder().decode(init.body));
  }
  throw new TypeError("expected JSON request body");
}

function accounting() {
  return { reserve: () => true, settle: () => undefined };
}

function actionContext(engine) {
  return {
    schemaVersion: domain.SCHEMA_VERSION,
    state: engine.snapshot(),
    modelAccounting: accounting(),
  };
}

test("role-only search bootstraps only an attested quarantined candidate, then direct fetch binds it", async () => {
  const input = {
    schemaVersion: domain.SCHEMA_VERSION,
    query: "do deep research on the CTO of Ariglad",
    requestedDepth: "standard",
  };
  const engine = new agent.InvestigationEngine(input, {
    clock: domain.createSequenceClock("2026-08-18T22:00:00.000Z", 2),
    ids: domain.createDeterministicIdFactory("role-engine"),
  });
  assert.equal(engine.snapshot().target.kind, "role_query");

  const fetchedUrls = [];
  const dependencies = createLiveDependencies(input, {
    apiKey: "test-key",
    model: "test/model",
    clock: domain.createSequenceClock("2026-08-18T22:10:00.000Z", 2),
    ids: domain.createDeterministicIdFactory("role-live"),
    resolveHostname: async () => ["93.184.216.34"],
    fetch: async (request, init = {}) => {
      const url = new URL(String(request));
      if (url.hostname === "openrouter.ai") {
        const body = decodeBody(init);
        if (body.tools?.some((tool) => tool.type === "openrouter:web_search")) {
          return providerResponse({
            id: "generation-role-search",
            // Free-form assistant prose is not an authorization or candidate edge.
            content: "Mallory Guess is probably the candidate.",
            annotations: [
              {
                type: "url_citation",
                url_citation: {
                  url: ROLE_URL,
                  title: "Suzie Bishop — CTO at Ariglad | LinkedIn",
                  content: "Suzie Bishop serves as Chief Technology Officer at Ariglad.",
                },
              },
              {
                type: "url_citation",
                url_citation: {
                  url: UNBOUND_URL,
                  title: "Mallory Guess — CFO at Ariglad | LinkedIn",
                  content: "A finance leadership profile.",
                },
              },
            ],
          });
        }
        if (body.tools?.some((tool) => tool.function?.name === "submit_evidence_extraction")) {
          return providerResponse({
            id: "generation-role-extraction",
            toolCalls: [functionCall("submit_evidence_extraction", {
              claim: "Suzie Bishop is Ariglad's CTO.",
              excerpt: "Suzie Bishop is the Chief Technology Officer at Ariglad.",
              publisher: "Profiles Example",
              sourceType: "professional_profile",
              temporalStatus: "current",
              subjectName: "Suzie Bishop",
              organization: "Ariglad",
            })],
          });
        }
        throw new Error("unexpected provider request");
      }
      if (url.href === ROLE_URL) {
        fetchedUrls.push(url.href);
        return new Response(
          "<html><title>Suzie Bishop at Ariglad</title><p>Suzie Bishop is the Chief Technology Officer at Ariglad.</p></html>",
          { headers: { "content-type": "text/html" } },
        );
      }
      throw new Error(`unexpected outbound URL ${url.href}`);
    },
  });

  const search = await dependencies.executeAction({
    schemaVersion: domain.SCHEMA_VERSION,
    id: "action-role-search",
    tool: "search_web",
    purpose: "Find the current CTO from provider-attested public results.",
    arguments: {
      query: "Ariglad CTO",
      candidateName: "Mallory Guess",
    },
    budgetClass: "search",
  }, actionContext(engine));

  assert.equal(search.status, "succeeded");
  assert.equal(search.data.observedCitationCount, 2);
  assert.equal(search.data.citationCount, 1);
  assert.equal(search.candidates.length, 1);
  assert.equal(search.candidates[0].displayName, "Suzie Bishop");
  assert.equal(search.candidates[0].signals.length, 1);
  assert.equal(search.candidates[0].signals[0].kind, "name");
  assert.equal(search.candidates[0].signals[0].assurance, "spoofable");
  assert.equal(JSON.stringify(search).includes("Mallory Guess"), false);
  assert.equal(JSON.stringify(search).includes(UNBOUND_URL), false);
  assert.equal(search.evidence.length, 1);
  assert.equal(search.evidence[0].reliability, 0);
  assert.equal(search.evidence[0].disposition, "discovery_only");
  assert.equal(search.evidence[0].attributes.roleCandidateBootstrap, true);
  assert.equal(typeof search.evidence[0].attributes.leadId, "string");

  const candidate = engine.addCandidate(search.candidates[0]).candidate;
  assert.equal(candidate.status, "separate");
  assert.equal(candidate.score.total, 0);
  assert.equal(engine.admitEvidence({
    ...search.evidence[0],
    candidateId: candidate.id,
    candidateRef: undefined,
  }).admitted, true);

  const direct = await dependencies.executeAction({
    schemaVersion: domain.SCHEMA_VERSION,
    id: "action-role-fetch",
    frontierEntryId: "action-role-fetch",
    tool: "fetch_public_source",
    purpose: "Bind the attested candidate to the exact fetched source.",
    arguments: {
      leadId: search.evidence[0].attributes.leadId,
      claimFocus: "Current CTO role at Ariglad",
    },
    candidateId: candidate.id,
    budgetClass: "fetch",
    sourceTier: 6,
    sourceLaneId: "t6.candidate_public_source",
    pathCost: 1,
    mutated: false,
  }, actionContext(engine));

  assert.equal(direct.status, "succeeded");
  assert.deepEqual(fetchedUrls, [ROLE_URL]);
  assert.equal(direct.evidence.length, 1);
  assert.equal(direct.evidence[0].candidateId, candidate.id);
  assert.equal(direct.evidence[0].verificationMethod, "direct_fetch");
  assert.equal(direct.evidence[0].claim, "Suzie Bishop is the Chief Technology Officer at Ariglad.");
  assert.equal(direct.candidateSignals.length, 1);
  assert.equal(direct.candidateSignals[0].candidateId, candidate.id);
  assert.ok(direct.candidateSignals[0].signals.some((signal) =>
    signal.kind === "organization" && signal.normalizedValue === "ariglad"));

  engine.addCandidateSignals(candidate.id, direct.candidateSignals[0].signals);
  const admission = engine.admitEvidence(direct.evidence[0]);
  assert.equal(admission.admitted, true);
  assert.equal(admission.evidence.disposition, "supports");
  assert.equal(admission.evidence.claim, direct.evidence[0].excerpt);
});

test("a plain-name first page is quarantined with its quote and can be corroborated without contaminating the name candidate", async () => {
  const sourceUrl = "https://first.example/chris-anderson";
  const input = {
    schemaVersion: domain.SCHEMA_VERSION,
    query: "Chris Anderson public professional background",
    requestedDepth: "standard",
  };
  const engine = new agent.InvestigationEngine(input, {
    clock: domain.createSequenceClock("2026-08-18T22:30:00.000Z", 2),
    ids: domain.createDeterministicIdFactory("plain-name-engine"),
  });
  const dependencies = createLiveDependencies(input, {
    apiKey: "test-key",
    model: "test/model",
    clock: domain.createSequenceClock("2026-08-18T22:40:00.000Z", 2),
    ids: domain.createDeterministicIdFactory("plain-name-live"),
    resolveHostname: async () => ["93.184.216.34"],
    fetch: async (request, init = {}) => {
      const url = new URL(String(request));
      if (url.hostname === "openrouter.ai") {
        const body = decodeBody(init);
        if (body.tools?.some((tool) => tool.type === "openrouter:web_search")) {
          return providerResponse({
            id: "generation-plain-search",
            annotations: [{
              type: "url_citation",
              url_citation: {
                url: sourceUrl,
                title: "Chris Anderson — Acme Labs",
                content: "Chris Anderson works at Acme Labs.",
              },
            }],
          });
        }
        if (body.tools?.some((tool) => tool.function?.name === "submit_evidence_extraction")) {
          return providerResponse({
            id: "generation-plain-extraction",
            toolCalls: [functionCall("submit_evidence_extraction", {
              claim: "Chris Anderson works at Acme Labs.",
              excerpt: "Chris Anderson works at Acme Labs.",
              publisher: "First Example",
              sourceType: "professional_profile",
              temporalStatus: "current",
              subjectName: "Chris Anderson",
              organization: "Acme Labs",
            })],
          });
        }
      }
      if (url.href === sourceUrl) {
        return new Response(
          "<html><p>Chris Anderson works at Acme Labs.</p></html>",
          { headers: { "content-type": "text/html" } },
        );
      }
      throw new Error(`unexpected outbound URL ${url.href}`);
    },
  });

  const search = await dependencies.executeAction({
    schemaVersion: domain.SCHEMA_VERSION,
    id: "action-plain-search",
    tool: "search_web",
    purpose: "Find direct public professional sources for the named subject.",
    arguments: { query: "Chris Anderson public professional profile" },
    budgetClass: "search",
  }, actionContext(engine));
  assert.equal(search.status, "succeeded");
  assert.equal(search.candidates.length, 1);
  const primary = engine.addCandidate(search.candidates[0]).candidate;
  const lead = { ...search.evidence[0] };
  delete lead.candidateRef;
  assert.equal(engine.admitEvidence({ ...lead, candidateId: primary.id }).admitted, true);

  const direct = await dependencies.executeAction({
    schemaVersion: domain.SCHEMA_VERSION,
    id: "action-plain-fetch",
    frontierEntryId: "action-plain-fetch",
    tool: "fetch_public_source",
    purpose: "Inspect the exact provider-attested lead without assuming identity.",
    arguments: {
      leadId: search.evidence[0].attributes.leadId,
      claimFocus: "Public professional identity and organization",
    },
    candidateId: primary.id,
    budgetClass: "fetch",
    sourceTier: 6,
    sourceLaneId: "t6.candidate_public_source",
    pathCost: 1,
    mutated: false,
  }, actionContext(engine));

  assert.equal(direct.status, "partial");
  assert.equal(direct.diagnostics.some((item) =>
    item.code === "candidate_binding_strong_binding_missing"), true);
  assert.equal(direct.candidates, undefined);
  assert.equal(direct.candidateBranches.length, 1);
  assert.equal(direct.candidateBranches[0].parentCandidateId, primary.id);
  assert.equal(direct.candidateBranches[0].reason, "fetched_subject_unverified");
  assert.equal(direct.evidence.length, 2);
  const metadataObservation = direct.evidence.find((item) =>
    item.attributes.metadataObservation === true);
  assert.ok(metadataObservation);
  assert.equal(metadataObservation.candidateId, primary.id);
  assert.equal(metadataObservation.disposition, "discovery_only");
  assert.equal(metadataObservation.excerpt ?? null, null);
  const quarantinedDraft = direct.evidence.find((item) =>
    typeof item.candidateRef === "string");
  assert.ok(quarantinedDraft);
  assert.equal(quarantinedDraft.candidateId, undefined);
  assert.equal(quarantinedDraft.attributes.quarantinedFromCandidateId, primary.id);
  assert.equal(quarantinedDraft.excerpt, "Chris Anderson works at Acme Labs.");
  assert.equal(engine.snapshot().evidence.every((item) =>
    item.candidateId !== primary.id || item.disposition === "discovery_only"), true);

  const quarantined = engine.addCandidate(direct.candidateBranches[0].candidate).candidate;
  const quoted = { ...quarantinedDraft };
  delete quoted.candidateRef;
  assert.equal(engine.admitEvidence({ ...quoted, candidateId: quarantined.id }).admitted, true);
  assert.notEqual(quarantined.id, primary.id);
  assert.deepEqual(
    gateExtractedCandidate(
      engine.snapshot(),
      quarantined.id,
      "Chris Anderson",
      "Acme Labs",
      "https://second.example/chris-anderson",
    ),
    { allowed: true, reason: "matched" },
  );
  assert.deepEqual(
    gateExtractedCandidate(
      engine.snapshot(),
      quarantined.id,
      "Chris Anderson",
      "Beta Labs",
      "https://second.example/chris-anderson",
    ),
    { allowed: false, reason: "organization_mismatch" },
  );
});

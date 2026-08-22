import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const vite = await createServer({
  root: projectRoot,
  configFile: false,
  cacheDir: `node_modules/.vite-atlas-ssr/${process.pid}`,
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true },
});
const domain = await vite.ssrLoadModule("/lib/domain/index.ts");
const agent = await vite.ssrLoadModule("/lib/agent/index.ts");

after(async () => {
  await vite.close();
});

test("target parsing distinguishes names, exact user identifiers, and role-only targets", () => {
  const named = domain.parseTarget("Henry wang, sixtyfour ai");
  assert.equal(named.kind, "named_person");
  assert.equal(named.name, "Henry Wang");
  assert.equal(named.organizationHints[0].normalizedName, "sixtyfour ai");

  const email = domain.parseTarget("andrew.goering@ramp.com");
  assert.equal(email.kind, "email");
  assert.deepEqual(email.identifiers[0], {
    kind: "email",
    value: "andrew.goering@ramp.com",
    normalizedValue: "andrew.goering@ramp.com",
    assurance: "self_asserted",
    provenance: "user_input",
  });

  const roleOnly = domain.parseTarget("the creator of Python");
  assert.equal(roleOnly.kind, "role_query");
  assert.ok(roleOnly.roleHints.includes("Creator"));
  assert.equal(roleOnly.organizationHints[0].name, "Python");

  const briefRole = domain.parseTarget("do deep research on the CTO of Ariglad");
  assert.equal(briefRole.kind, "role_query");
  assert.ok(briefRole.roleHints.includes("Chief Technology Officer"));
  assert.equal(briefRole.organizationHints[0].name, "Ariglad");

  for (const query of [
    "Grace Hopper public professional background",
    "research Grace Hopper public professional profile",
  ]) {
    const scopedName = domain.parseTarget(query);
    assert.equal(scopedName.kind, "named_person");
    assert.equal(scopedName.name, "Grace Hopper");
  }
  assert.equal(domain.parseTarget("Mary Background").name, "Mary Background");
  assert.equal(domain.parseTarget("Chris Public").name, "Chris Public");
});

test("target and identity normalization preserve non-Latin public names deterministically", () => {
  for (const [raw, expectedName, expectedNormalized] of [
    ["张伟", "张伟", "张伟"],
    ["Ольга Иванова", "Ольга Иванова", "ольга иванова"],
    ["अनन्या शर्मा", "अनन्या शर्मा", "अनन्या शर्मा"],
  ]) {
    const target = domain.parseTarget(raw);
    assert.equal(target.kind, "named_person", raw);
    assert.equal(target.name, expectedName, raw);
    assert.equal(target.normalizedName, expectedNormalized, raw);
    assert.equal(domain.normalizeComparable(raw), expectedNormalized, raw);
  }

  const cjkEvidence = {
    id: "evidence-cjk-name",
    candidateId: "candidate-cjk-name",
    disposition: "supports",
    sourceType: "official_profile",
    sourceFamily: "example.edu",
    claim: "张伟",
    excerpt: "张伟",
    title: "张伟",
    publisher: "Example University",
    sourceUrl: "https://example.edu/people/zhang-wei",
    canonicalUrl: "https://example.edu/people/zhang-wei",
    canonicalSubset: null,
    attributes: {},
  };
  assert.equal(
    domain.identitySignalGroundedByEvidence(
      {
        kind: "name",
        value: "张伟",
        normalizedValue: "张伟",
        strength: "strong",
        assurance: "spoofable",
        sourceFamily: "example.edu",
        sourceEvidenceId: cjkEvidence.id,
      },
      cjkEvidence,
    ),
    true,
  );
  assert.equal(
    domain.identitySignalGroundedByEvidence(
      {
        kind: "social_handle",
        value: "张伟",
        normalizedValue: "张伟",
        strength: "strong",
        assurance: "spoofable",
        sourceFamily: "example.edu",
        sourceEvidenceId: cjkEvidence.id,
      },
      cjkEvidence,
    ),
    false,
    "short non-Latin names must not weaken the minimum for unrelated signal kinds",
  );
});

test("target parsing retains bounded public-professional context for mononyms, roles, affiliations, and locations", () => {
  const mononym = domain.parseTarget("Usher");
  assert.equal(mononym.kind, "named_person");
  assert.equal(mononym.name, "Usher");
  assert.deepEqual(mononym.organizationHints, []);

  const explicitOrganization = domain.parseTarget("organization Microsoft");
  assert.equal(explicitOrganization.kind, "organization");
  assert.equal(explicitOrganization.name, undefined);
  assert.equal(explicitOrganization.organizationHints[0].name, "Microsoft");
  assert.equal(domain.parseTarget("Example Labs").kind, "organization");

  const professor = domain.parseTarget("Michael Jordan, professor at UC Berkeley");
  assert.equal(professor.kind, "named_person");
  assert.equal(professor.name, "Michael Jordan");
  assert.deepEqual(professor.roleHints, ["Professor"]);
  assert.deepEqual(professor.organizationHints, [
    { name: "UC Berkeley", normalizedName: "uc berkeley", relationship: "current" },
  ]);

  for (const [query, location] of [
    ["Ganesh Talluri based in Peoria", "Peoria"],
    ["Ganesh Talluri from Phoenix", "Phoenix"],
    ["Ganesh Talluri in Tempe", "Tempe"],
  ]) {
    const target = domain.parseTarget(query);
    assert.equal(target.kind, "named_person", query);
    assert.equal(target.name, "Ganesh Talluri", query);
    assert.deepEqual(target.locationHints, [location], query);
  }

  for (const [query, organization] of [
    ["Ganesh Talluri at Arizona State University", "Arizona State University"],
    ["Ganesh Talluri with Example Labs", "Example Labs"],
  ]) {
    const target = domain.parseTarget(query);
    assert.equal(target.kind, "named_person", query);
    assert.equal(target.name, "Ganesh Talluri", query);
    assert.deepEqual(target.organizationHints, [
      { name: organization, normalizedName: organization.toLocaleLowerCase("en-US"), relationship: "current" },
    ]);
  }

  for (const [query, organization, relationship] of [
    ["Chinmay Bhat studies at Arizona State University", "Arizona State University", "current"],
    ["Chinmay Bhat attends ASU", "ASU", "current"],
    ["Chinmay Bhat student at ASU", "ASU", "current"],
    ["Chinmay Bhat school Arizona State University", "Arizona State University", "current"],
    ["Chinmay Bhat went to Arizona State University", "Arizona State University", "former"],
    ["Chinmay Bhat, school: Arizona State University", "Arizona State University", "current"],
  ]) {
    const target = domain.parseTarget(query);
    assert.equal(target.kind, "named_person", query);
    assert.equal(target.name, "Chinmay Bhat", query);
    assert.deepEqual(
      target.organizationHints,
      [
        {
          name: organization,
          normalizedName: organization.toLocaleLowerCase("en-US"),
          relationship,
        },
      ],
      query,
    );
    assert.notEqual(domain.classifySafety(query).level, "block", query);
  }

  for (const query of [
    "Alex Kim attends Central High School",
    "Alex Kim student at Central High School",
    "Alex Kim, school: Central Middle School",
  ]) {
    const target = domain.parseTarget(query);
    assert.deepEqual(target.organizationHints, [], query);
    const safety = domain.classifySafety(query);
    assert.equal(safety.level, "block", query);
    assert.ok(
      safety.reasons.some((reason) => reason.code === "minor_or_vulnerable_person"),
      query,
    );
  }

  for (const query of [
    "Alex Kim student at Lincoln",
    "Alex Kim student at Lincoln Academy",
    "Alex Kim student at HS",
    "Alex Kim student at asu",
  ]) {
    const ambiguousSchool = domain.parseTarget(query);
    assert.equal(ambiguousSchool.kind, "unknown", query);
    assert.equal(ambiguousSchool.name, undefined, query);
    assert.deepEqual(ambiguousSchool.organizationHints, [], query);
  }

  for (const query of ["Ada Lovelace based in 123 Main Street", "Ada Lovelace based in 6025550199"]) {
    const target = domain.parseTarget(query);
    assert.equal(target.name, "Ada Lovelace", query);
    assert.deepEqual(target.locationHints, [], query);
  }
});

test("safety policy permits public professional research and blocks dangerous scope expansions", () => {
  assert.equal(domain.classifySafety("Henry Wang, Sixtyfour AI").level, "allow");
  assert.equal(domain.classifySafety("andrew.goering@ramp.com").level, "caution");
  assert.equal(domain.classifySafety("Ganesh Talluri based in Peoria").level, "allow");

  const blocked = [
    ["Henry's phone number", "precise_location_or_contact"],
    ["find 6025550199", "sensitive_personal_data"],
    ["6025550199", "sensitive_personal_data"],
    ["find ６０２５５５０１９９", "sensitive_personal_data"],
    ["find ٦٠٢٥٥٥٠١٩٩", "sensitive_personal_data"],
    ["map his spouse and children", "family_or_relationship_mapping"],
    ["automate outreach and email them", "contact_automation"],
    ["background check this candidate before hiring", "high_impact_decision"],
    ["find their diagnosis and medication", "sensitive_personal_data"],
    ["determine their religion and ethnicity", "sensitive_personal_data"],
    ["find their debt and bank balance", "sensitive_personal_data"],
    ["find their SSN and bank account", "credential_or_financial_data"],
    ["stalk and harass this person", "targeting_or_harassment"],
    ["research this child and their school", "minor_or_vulnerable_person"],
    ["hack their account", "illegal_or_violent_intent"],
  ];
  for (const [query, expectedCode] of blocked) {
    const decision = domain.classifySafety(query);
    assert.equal(decision.level, "block", query);
    assert.ok(
      decision.reasons.some((reason) => reason.code === expectedCode),
      query,
    );
  }
  assert.equal(
    agent.isActionPolicyCompliant(
      {
        tool: "search_web",
        purpose: "Research a public professional profile",
        arguments: { phone: 6025550199 },
      },
      ["search_web"],
    ).allowed,
    false,
  );
  assert.equal(
    agent.isActionPolicyCompliant(
      {
        tool: "search_web",
        purpose: "Research a public professional profile",
        arguments: { query: 6025550199 },
      },
      ["search_web"],
    ).allowed,
    false,
  );
  for (const query of ["６０２５５５０１９９", "٦٠٢٥٥٥٠١٩٩"]) {
    assert.equal(
      agent.isActionPolicyCompliant(
        {
          tool: "search_web",
          purpose: "Find the supplied number",
          arguments: { query },
        },
        ["search_web"],
      ).allowed,
      false,
      query,
    );
  }
});

test("same-name candidates stay separate until a strong verified identifier matches", () => {
  const target = domain.parseTarget("Alex Kim, Example Labs");
  const clock = domain.createSequenceClock();
  const first = domain.createCandidate({ displayName: "Alex Kim", signals: [] }, target, "candidate_1", clock.now());
  const second = domain.createCandidate({ displayName: "Alex Kim", signals: [] }, target, "candidate_2", clock.now());
  assert.deepEqual(domain.canMergeCandidates(first, second), {
    allowed: false,
    reason: "name_only",
  });

  const sharedEmail = {
    kind: "email",
    value: "alex@example.com",
    normalizedValue: "alex@example.com",
    strength: "strong",
    assurance: "verified",
    sourceFamily: "example.com",
  };
  const withEmailOne = domain.addCandidateSignals(first, [sharedEmail], target, clock.now());
  const withEmailTwo = domain.addCandidateSignals(second, [sharedEmail], target, clock.now());
  assert.equal(domain.canMergeCandidates(withEmailOne, withEmailTwo).allowed, true);
});

test("evidence admission preserves complete audit metadata and deduplicates source families", () => {
  const clock = domain.createSequenceClock();
  const ids = domain.createDeterministicIdFactory("audit");
  const target = domain.parseTarget("Ada Lovelace, Analytical Engine");
  const candidate = domain.createCandidate({ displayName: "Ada Lovelace" }, target, "candidate_ada", clock.now());
  const context = {
    candidateIds: new Set([candidate.id]),
    existing: [],
    ids,
    clock,
  };
  const first = domain.admitEvidence(
    {
      candidateId: candidate.id,
      claim: "Ada published notes on the Analytical Engine.",
      sourceUrl: "https://www.example.com/bio/?utm_source=test#life",
      queryUrl: "https://search.example/?q=ada",
      sourceType: "public_document",
      publisher: "Example Archive",
      excerpt: "Published notes on the Analytical Engine.",
      observedAt: "2025-01-02T00:00:00.000Z",
      httpStatus: 200,
      toolCallId: "action_1",
      verificationMethod: "direct_fetch",
      temporalStatus: "historical",
    },
    context,
  );
  assert.equal(first.admitted, true);
  assert.equal(first.evidence.sourceFamily, "example.com");
  assert.equal(first.evidence.sourceUrl, "https://www.example.com/bio");
  assert.equal(first.evidence.canonicalUrl, "https://www.example.com/bio");
  assert.equal(first.evidence.queryUrl, "https://search.example/?q=ada");
  assert.match(first.evidence.contentHash, /^fnv1a32:/);
  assert.equal(first.evidence.toolCallId, "action_1");
  assert.equal(first.evidence.httpStatus, 200);

  const duplicate = domain.admitEvidence(
    {
      candidateId: candidate.id,
      claim: "Ada published notes on the Analytical Engine.",
      sourceUrl: "https://example.com/a-second-page",
      sourceType: "public_document",
      excerpt: "Published notes on the Analytical Engine.",
    },
    { ...context, existing: [first.evidence] },
  );
  assert.equal(duplicate.admitted, false);
  assert.equal(duplicate.reason, "duplicate_source_family");
  const copiedRecord = { ...first.evidence, id: "copied_exact_quote" };
  assert.equal(
    domain.assessConfidence([first.evidence, copiedRecord]).score,
    domain.assessConfidence([first.evidence]).score,
  );
});

test("evidence admission rejects exact durable URLs that the final report content policy restricts", () => {
  const clock = domain.createSequenceClock();
  const ids = domain.createDeterministicIdFactory("restricted-crossref-url");
  const candidateId = "candidate_crossref";
  const restrictedUrl = "https://api.crossref.org/works/10.5555%2F602-555-0199";
  assert.equal(domain.containsRestrictedPublicContent(restrictedUrl), true);

  const admission = domain.admitEvidence(
    {
      candidateId,
      claim: "Crossref surfaced a possible authored-work record; it is a discovery lead only.",
      sourceUrl: restrictedUrl,
      sourceType: "search_result",
      canonicalSubset: { officialApiObservedUrl: true },
      verificationMethod: "search_discovery",
    },
    { candidateIds: new Set([candidateId]), existing: [], ids, clock },
  );

  assert.deepEqual(admission, { admitted: false, reason: "sensitive_content" });
});

test("search snippets cannot support findings and spoofable-only evidence is confidence capped", () => {
  const clock = domain.createSequenceClock();
  const ids = domain.createDeterministicIdFactory("confidence");
  const candidateId = "candidate_1";
  const base = {
    candidateId,
    claim: "The profile belongs to the target.",
    sourceType: "professional_profile",
    excerpt: "Matching self-asserted profile.",
    reliability: 1,
    spoofable: true,
  };
  const records = ["linkedin.com", "about.me", "example.dev"].map(
    (host) =>
      domain.admitEvidence(
        { ...base, sourceUrl: `https://${host}/alex` },
        { candidateIds: new Set([candidateId]), existing: [], ids, clock },
      ).evidence,
  );
  const confidence = domain.assessConfidence(records);
  assert.equal(confidence.score, domain.SPOOFABLE_CONFIDENCE_CAP);
  assert.ok(confidence.appliedCaps.includes("spoofable_only"));

  const discovery = domain.admitEvidence(
    {
      candidateId,
      claim: "A search result mentions the target.",
      sourceUrl: "https://search.example/result/1",
      sourceType: "search_result",
      excerpt: "Unopened search snippet.",
    },
    { candidateIds: new Set([candidateId]), existing: [], ids, clock },
  );
  assert.equal(discovery.evidence.disposition, "discovery_only");
});

test("findings expose counter-evidence and preserve candidate/evidence referential integrity", () => {
  const clock = domain.createSequenceClock();
  const ids = domain.createDeterministicIdFactory("finding");
  const target = domain.parseTarget("Alex Kim, Example Labs");
  let candidate = domain.createCandidate({ displayName: "Alex Kim" }, target, "candidate_alex", clock.now());
  const context = { candidateIds: new Set([candidate.id]), existing: [], ids, clock };
  const supporting = domain.admitEvidence(
    {
      candidateId: candidate.id,
      claim: "Alex works at Example Labs.",
      sourceUrl: "https://example.com/team/alex",
      sourceType: "company_page",
      excerpt: "Alex Kim — engineer.",
      disposition: "supports",
    },
    context,
  ).evidence;
  const counter = domain.admitEvidence(
    {
      candidateId: candidate.id,
      claim: "An older page lists a different employer.",
      sourceUrl: "https://archive.example.net/alex",
      sourceType: "web_archive",
      excerpt: "Alex previously worked elsewhere.",
      disposition: "contradicts",
    },
    { ...context, existing: [supporting] },
  ).evidence;
  candidate = { ...candidate, evidenceIds: [supporting.id, counter.id] };
  const finding = domain.createFinding(
    {
      candidateId: candidate.id,
      title: "Employment at Example Labs",
      description: "A current company page supports the role, while an older page creates a timeline caveat.",
      category: "employment",
      evidenceIds: [supporting.id],
      counterEvidenceIds: [counter.id],
    },
    [candidate],
    [supporting, counter],
    ids,
    clock,
  );
  assert.deepEqual(finding.counterEvidenceIds, [counter.id]);
  assert.deepEqual(
    domain.validateReferentialIntegrity({
      candidates: [candidate],
      evidence: [supporting, counter],
      findings: [finding],
    }),
    [],
  );
});

test("coverage never borrows evidence from a quarantined runner-up candidate", () => {
  const clock = domain.createSequenceClock();
  const ids = domain.createDeterministicIdFactory("coverage");
  const target = domain.parseTarget("Alex Kim, Example Labs");
  const base = domain.createCandidate({ displayName: "Alex Kim" }, target, "selected", clock.now());
  const selected = {
    ...base,
    status: "resolved",
    score: { ...base.score, total: 0.92 },
  };
  const decoyBase = domain.createCandidate({ displayName: "Alex Kim" }, target, "decoy", clock.now());
  const decoy = {
    ...decoyBase,
    status: "plausible",
    score: { ...decoyBase.score, total: 0.41 },
  };
  const selectedEvidence = domain.admitEvidence(
    {
      candidateId: selected.id,
      claim: "Selected candidate evidence.",
      sourceUrl: "https://selected.example/profile",
      sourceType: "official_profile",
      excerpt: "Selected profile.",
    },
    { candidateIds: new Set([selected.id, decoy.id]), existing: [], ids, clock },
  ).evidence;
  const decoyEvidence = domain.admitEvidence(
    {
      candidateId: decoy.id,
      claim: "Decoy candidate evidence.",
      sourceUrl: "https://wired.com/decoy",
      sourceType: "news",
      excerpt: "A different Alex Kim.",
    },
    { candidateIds: new Set([selected.id, decoy.id]), existing: [], ids, clock },
  ).evidence;
  const coverage = domain.summarizeCoverage({
    candidates: [selected, decoy],
    findings: [],
    evidence: [selectedEvidence, decoyEvidence],
    openQuestions: [],
  });
  assert.equal(coverage.independentSourceFamilyCount, 1);
});

test("identity resolution reports a quarantined same-name runner-up and its real margin", () => {
  const clock = domain.createSequenceClock();
  const target = domain.parseTarget("Alex Kim, Example Labs");
  const selectedBase = domain.createCandidate({ displayName: "Alex Kim" }, target, "selected", clock.now());
  const decoyBase = domain.createCandidate({ displayName: "Alex Kim" }, target, "decoy", clock.now());
  const selected = {
    ...selectedBase,
    status: "resolved",
    score: { ...selectedBase.score, total: 0.91 },
  };
  const quarantined = {
    ...decoyBase,
    status: "rejected",
    score: { ...decoyBase.score, total: 0.22 },
  };
  const identity = domain.resolveIdentity([selected, quarantined]);
  assert.equal(identity.status, "resolved");
  assert.equal(identity.selectedCandidateId, selected.id);
  assert.equal(identity.runnerUpCandidateId, quarantined.id);
  assert.equal(identity.runnerUpCandidate.status, "rejected");
  assert.equal(identity.runnerUpScore, 0.22);
  assert.equal(identity.runnerUpMargin, 0.69);

  const higherScoringRejected = {
    ...quarantined,
    score: { ...quarantined.score, total: 0.97 },
  };
  const unresolved = domain.resolveIdentity([selected, higherScoringRejected]);
  assert.equal(unresolved.status, "unresolved");
  assert.equal(unresolved.runnerUpCandidateId, higherScoringRejected.id);
  assert.equal(unresolved.runnerUpScore, 0.97);
  assert.equal(unresolved.runnerUpMargin, 0);
});

test("budget ledger charges LLM, search, evidence, and phase attempts explicitly", () => {
  const limits = domain.resolveBudgetLimits("quick", {
    maxTurns: 10,
    maxLlmCalls: 2,
    maxSearchCalls: 1,
    maxEvidenceAttempts: 1,
    phaseCaps: { discover: 1 },
  });
  const ledger = new domain.BudgetLedger(limits, 0);
  assert.equal(ledger.canStartTurn("discover", 0), true);
  ledger.beginTurn("discover", 1);
  ledger.recordLlmCall(2);
  ledger.recordToolCall(1, true, 3);
  ledger.recordEvidenceAttempt(4);
  const usage = ledger.snapshot(5);
  assert.equal(usage.llmCalls, 1);
  assert.equal(usage.searchCalls, 1);
  assert.equal(usage.evidenceAttempts, 1);
  assert.equal(usage.phaseTurns.discover, 1);
  assert.equal(ledger.canStartTurn("discover", 6), false);
  assert.ok(domain.exhaustedBudgetDimensions(limits, usage).includes("search_calls"));
});

test("trace recorder is append-only, balanced, JSON-safe, and never persists chain-of-thought", () => {
  const clock = domain.createSequenceClock("2026-01-01T00:00:00.000Z", 5);
  const ids = domain.createDeterministicIdFactory("trace");
  const trace = new agent.TraceRecorder("run_1", clock, ids);
  const span = trace.startSpan({
    name: "planner.decision",
    phase: "plan",
    attempt: 2,
    payload: {
      reasoning: "secret chain of thought",
      decisionSummary: "Search the public company page.",
      authorization: "Bearer should-never-persist",
      apiKey: "test-secret-key",
      accessToken: "test-access-token",
      token: "test-generic-token",
      credentials: "test-credentials",
      cookie: "session=test-cookie",
      password: "test-password",
      privateKey: "test-private-key",
      body: "full fetched response",
      responseBody: "full upstream response",
      normalizedText: "full normalized document",
      phone: "+1 555 0100",
      homeAddress: "123 Private Street",
      sourceUrl: "https://example.test/profile?q=public&api_key=test-secret&access_token=test-token",
      nested: { cookie: "nested-cookie", retained: "public summary" },
    },
  });
  trace.endSpan(span, {
    status: "succeeded",
    usage: { inputTokens: 10, cachedInputTokens: 3, outputTokens: 4, thinkingTokens: 7 },
  });
  trace.assertBalanced();
  const events = trace.snapshot();
  assert.equal(
    events.every((event) => event.schemaVersion === domain.SCHEMA_VERSION),
    true,
  );
  assert.deepEqual(
    events.map((event) => event.seq),
    [1, 2],
  );
  assert.ok(events[1].elapsedMs >= events[0].elapsedMs);
  assert.equal(events[0].spanId, span);
  assert.equal(events[0].parentSpanId, null);
  assert.equal(events[0].attempt, 2);
  assert.equal(events[0].status, "started");
  assert.equal(events[0].payload.reasoning, undefined);
  assert.equal(events[0].payload.decisionSummary, "Search the public company page.");
  for (const key of [
    "authorization",
    "apiKey",
    "accessToken",
    "token",
    "credentials",
    "cookie",
    "password",
    "privateKey",
    "body",
    "responseBody",
    "normalizedText",
    "phone",
    "homeAddress",
  ]) {
    assert.equal(events[0].payload[key], undefined, key);
  }
  assert.deepEqual(events[0].payload.nested, { retained: "public summary" });
  const sanitizedUrl = new URL(events[0].payload.sourceUrl);
  assert.equal(sanitizedUrl.searchParams.get("q"), "public");
  assert.equal(sanitizedUrl.searchParams.has("api_key"), false);
  assert.equal(sanitizedUrl.searchParams.has("access_token"), false);
  assert.doesNotMatch(JSON.stringify(events), /test-secret|test-token|test-cookie|Private Street/);
  assert.equal(events[1].usage.cachedInputTokens, 3);
  assert.equal(events[1].usage.thinkingTokens, 7);
  assert.equal(events[1].usage.networkRequests, null);
  assert.equal(events[1].usage.unavailableReason, "not_reported");
  assert.equal(events.every(agent.isTraceEvent), true);
  assert.throws(() => trace.endSpan(span, { status: "succeeded" }), /not open/);
});

test("tool bridge keeps CDX metadata discovery-only and admits quote-backed snapshots", () => {
  const shared = {
    sourceUrl: "https://web.archive.org/web/20200101000000/https://example.com",
    title: "Archived example",
    observedAt: "2026-01-01T00:00:00.000Z",
    attributes: { targetUrl: "https://example.com" },
  };
  const context = {
    claim: "The target page existed in the archive.",
    candidateId: "candidate_1",
    toolCallId: "action_1",
  };
  const cdx = agent.toolEvidenceToDraft({ ...shared, sourceType: "wayback_cdx_capture" }, context);
  const snapshot = agent.toolEvidenceToDraft(
    { ...shared, sourceType: "wayback_snapshot", excerpt: "Quote from the archived page." },
    context,
  );
  assert.equal(cdx.sourceType, "web_archive");
  assert.equal(cdx.disposition, "discovery_only");
  assert.equal(snapshot.disposition, "supports");
  assert.equal(snapshot.verificationMethod, "archive_snapshot");
});

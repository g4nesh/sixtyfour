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

test("bare name-context hypotheses preserve the full primary name and guard multipart names", () => {
  const target = domain.parseTarget("alex rivera meridian collective");
  assert.equal(target.name, "Alex Rivera Meridian Collective");
  assert.deepEqual(domain.bareNameContextHypotheses(target), [
    {
      subjectName: "Alex Rivera",
      normalizedSubjectName: "alex rivera",
      contextPhrase: "Meridian Collective",
      normalizedContextPhrase: "meridian collective",
    },
  ]);
  for (const multipartName of ["ludwig van beethoven society", "jean claude van damme", "juan carlos de la vega"]) {
    assert.deepEqual(domain.bareNameContextHypotheses(domain.parseTarget(multipartName)), [], multipartName);
  }
  assert.deepEqual(domain.bareNameContextHypotheses(domain.parseTarget("alex rivera central high school")), []);
  for (const excerpt of [
    "Jane Doe is a student researcher at Meridian Academy.",
    "Meridian Academy enrolls Jane Doe as a pupil.",
    "Meridian Academy's grade 11 robotics team includes Jane Doe.",
    "Jane Doe joined the robotics club at Meridian Academy.",
    "Jane Doe researches at Meridian Academy.",
    "Jane Doe joined Meridian Academy.",
    "Jane Doe is an intern at Meridian Academy.",
    "Jane Doe attended Meridian Academy.",
    "Jane Doe says Bob Chen worked at Meridian Academy.",
    "Jane Doe says Bob Chen graduated from Meridian Academy.",
    "Meridian Academy employed Bob Chen, according to Jane Doe.",
  ]) {
    assert.equal(domain.matchBareContextRelation(excerpt, "Jane Doe", "Meridian Academy"), null, excerpt);
  }
  assert.equal(
    domain.matchBareContextRelation("Jane Doe graduated from Meridian Academy.", "Jane Doe", "Meridian Academy"),
    "alumni",
  );
  assert.equal(
    domain.matchBareContextRelation("Meridian Academy alumna Jane Doe.", "Jane Doe", "Meridian Academy"),
    "alumni",
  );
  assert.equal(
    domain.matchBareContextRelation(
      "Jane Doe worked as an engineer at Meridian Academy.",
      "Jane Doe",
      "Meridian Academy",
    ),
    "professional",
  );
  assert.equal(
    domain.matchBareContextRelation(
      "Meridian Academy employed Jane Doe as an engineer.",
      "Jane Doe",
      "Meridian Academy",
    ),
    "professional",
  );
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

test("overlapping cross-source family pairs count as one derived identity feature", () => {
  const target = domain.parseTarget("Alex Rivera, Northstar Labs");
  const signal = (left, right, index) => ({
    kind: "cross_source_match",
    value: `Alex Rivera at Northstar Labs is independently quoted by ${left} and ${right}`,
    normalizedValue: `alex rivera|northstar labs|${left}|${right}`,
    strength: "strong",
    assurance: "corroborated",
    sourceFamily: `cross-source:${left}+${right}`,
    sourceEvidenceId: `evidence-cross-source-${index}`,
  });
  const first = signal("alpha.example", "beta.example", 1);
  const overlapping = [first, signal("alpha.example", "gamma.example", 2), signal("beta.example", "gamma.example", 3)];
  const singleScore = domain.scoreCandidate({ displayName: "Alex Rivera", signals: [first] }, target);
  const overlappingScore = domain.scoreCandidate({ displayName: "Alex Rivera", signals: overlapping }, target);

  assert.equal(overlappingScore.total, singleScore.total);
  assert.deepEqual(overlappingScore.independentFamilies, singleScore.independentFamilies);
});

test("cross-source identity provenance requires the same exact subject-organization tuple", () => {
  const buildBranch = (suffix, organizations) => {
    const target = domain.parseTarget("Alex Rivera, Northstar Labs");
    const clock = domain.createSequenceClock();
    const ids = domain.createDeterministicIdFactory(`cross-source-${suffix}`);
    let candidate = domain.createCandidate(
      { displayName: "Alex Rivera" },
      target,
      `candidate-cross-source-${suffix}`,
      clock.now(),
    );
    const evidence = [];
    for (const [index, organization] of organizations.entries()) {
      const excerpt = `Alex Rivera works at ${organization}.`;
      const admission = domain.admitEvidence(
        {
          candidateId: candidate.id,
          claim: excerpt,
          sourceUrl: `https://${index === 0 ? "alpha" : "beta"}.example/alex-rivera`,
          sourceType: "public_document",
          excerpt,
          reliability: 0.7,
          spoofable: true,
          httpStatus: 200,
          contentHash: `sha256:${String(index + 11).padStart(64, "0")}`,
          toolCallId: `cross-source-${suffix}-action-${index}`,
          verificationMethod: "direct_fetch",
          attributes: {
            untrustedContent: true,
            extractedSubjectName: "Alex Rivera",
            extractedOrganization: organization,
          },
        },
        { candidateIds: new Set([candidate.id]), existing: evidence, ids, clock },
      );
      assert.equal(admission.admitted, true);
      evidence.push(admission.evidence);
    }
    candidate = { ...candidate, evidenceIds: evidence.map((record) => record.id).sort() };
    const families = evidence.map((record) => record.sourceFamily).sort();
    const source = evidence.find((record) => record.sourceFamily === families[0]);
    const organization = organizations[0];
    candidate = domain.addCandidateSignals(
      candidate,
      [
        {
          kind: "cross_source_match",
          value: `Alex Rivera at ${organization} is independently quoted by ${families.join(" and ")}`,
          normalizedValue: domain.normalizeComparable(`alex rivera|${organization}|${families.join("|")}`),
          strength: "strong",
          assurance: "corroborated",
          sourceFamily: `cross-source:${families.join("+")}`,
          sourceEvidenceId: source.id,
        },
      ],
      target,
      clock.now(),
    );
    return { target, candidate, evidence };
  };

  const valid = buildBranch("valid", ["Northstar Labs", "Northstar Labs"]);
  assert.equal(
    domain
      .validateReferentialIntegrity({ ...valid, candidates: [valid.candidate], findings: [] })
      .some((issue) => issue.code === "candidate_signal_provenance_mismatch"),
    false,
  );

  const forged = buildBranch("forged", ["Northstar Labs", "Meridian Collective"]);
  assert.equal(
    domain
      .validateReferentialIntegrity({ ...forged, candidates: [forged.candidate], findings: [] })
      .some((issue) => issue.code === "candidate_signal_provenance_mismatch"),
    true,
  );
});

function createContextCandidateBranch({ target, candidateId, sources, ids, clock }) {
  let candidate = domain.createCandidate({ displayName: "Alex Rivera" }, target, candidateId, clock.now());
  const evidence = sources.map((source, index) => {
    const admission = domain.admitEvidence(
      {
        candidateId,
        claim: source.excerpt,
        sourceUrl: source.url,
        sourceType: source.sourceType,
        excerpt: source.excerpt,
        disposition: source.disposition ?? "supports",
        reliability: source.reliability ?? 0.55,
        spoofable: source.spoofable ?? true,
        httpStatus: 200,
        contentHash: `sha256:${String(index + 1).padStart(64, "0")}`,
        toolCallId: `${candidateId}-action-${index}`,
        verificationMethod: "direct_fetch",
      },
      { candidateIds: new Set([candidateId]), existing: [], ids, clock },
    );
    assert.equal(admission.admitted, true);
    return admission.evidence;
  });
  candidate = { ...candidate, evidenceIds: evidence.map((record) => record.id).sort() };
  const signals = evidence
    .filter((record) => record.disposition === "supports")
    .flatMap((record) => [
      {
        kind: "name",
        value: "Alex Rivera",
        normalizedValue: "alex rivera",
        strength: "strong",
        assurance: "spoofable",
        sourceFamily: record.sourceFamily,
        sourceEvidenceId: record.id,
      },
      {
        kind: "organization",
        value: "Northstar Labs",
        normalizedValue: "northstar labs",
        strength: "strong",
        assurance: "spoofable",
        sourceFamily: record.sourceFamily,
        sourceEvidenceId: record.id,
      },
      ...(record.excerpt.includes("Researcher")
        ? [
            {
              kind: "role",
              value: "Researcher",
              normalizedValue: "researcher",
              strength: "strong",
              assurance: "spoofable",
              sourceFamily: record.sourceFamily,
              sourceEvidenceId: record.id,
            },
          ]
        : []),
      ...(record.excerpt.includes("Mesa")
        ? [
            {
              kind: "location",
              value: "Mesa",
              normalizedValue: "mesa",
              strength: "strong",
              assurance: "spoofable",
              sourceFamily: record.sourceFamily,
              sourceEvidenceId: record.id,
            },
          ]
        : []),
    ]);
  candidate = domain.addCandidateSignals(candidate, signals, target, clock.now());
  return { candidate, evidence };
}

test("two direct families with an authoritative route resolve exact requested context", () => {
  const target = domain.parseTarget("Alex Rivera, Northstar Labs, Researcher, in Mesa");
  const clock = domain.createSequenceClock();
  const ids = domain.createDeterministicIdFactory("context-resolved");
  const branch = createContextCandidateBranch({
    target,
    candidateId: "candidate-context-resolved",
    ids,
    clock,
    sources: [
      {
        url: "https://northstar.example/team/alex-rivera",
        sourceType: "company_page",
        excerpt: "Alex Rivera is a Researcher at Northstar Labs in Mesa.",
        spoofable: false,
      },
      {
        url: "https://civic-records.example/profiles/alex-rivera",
        sourceType: "official_profile",
        excerpt: "Alex Rivera is a Researcher at Northstar Labs in Mesa.",
      },
    ],
  });

  const corroboration = domain.assessCandidateContextCorroboration(branch.candidate, branch.evidence, target);
  assert.ok(corroboration);
  assert.deepEqual(corroboration.sourceFamilies, ["civic-records.example", "northstar.example"]);
  assert.deepEqual(corroboration.authoritativeSourceFamilies, ["civic-records.example", "northstar.example"]);
  assert.equal(corroboration.allSourcesSpoofable, false);
  assert.equal(corroboration.decision, "resolved_eligible");
  assert.ok(corroboration.score >= domain.IDENTITY_RESOLUTION_THRESHOLD);
  const identity = domain.resolveIdentity([branch.candidate], branch.evidence, target);
  assert.equal(identity.status, "resolved");
  assert.equal(identity.resolutionBasis, "context_corroboration");
  assert.equal(identity.contextDecision, "resolved_eligible");
  assert.deepEqual(identity.resolutionEvidenceIds, corroboration.evidenceIds);
  assert.deepEqual(identity.resolutionSourceFamilies, corroboration.sourceFamilies);
  assert.deepEqual(identity.resolutionContextKeys, corroboration.matchedContextKeys);
  assert.equal(
    domain.reportTelemetry({
      candidates: [branch.candidate],
      evidence: branch.evidence,
      findings: [],
      evidenceTelemetry: {
        admitted: branch.evidence.length,
        rejected: 0,
        duplicate: 0,
        discoveryOnly: 0,
        supporting: branch.evidence.length,
        contradicting: 0,
      },
      target,
    }).resolvedCandidateCount,
    1,
  );
  assert.equal(
    domain.terminalStatusForStop("budget_exhausted", [branch.candidate], branch.evidence, target),
    "partial",
  );
  assert.deepEqual(
    domain.validateReferentialIntegrity({
      candidates: [branch.candidate],
      evidence: branch.evidence,
      findings: [],
      target,
      identity,
    }),
    [],
  );
  const forgedIdentity = {
    ...identity,
    resolutionContextKeys: [...identity.resolutionContextKeys, "organization:forged context"].sort(),
  };
  assert.ok(
    domain
      .validateReferentialIntegrity({
        candidates: [branch.candidate],
        evidence: branch.evidence,
        findings: [],
        target,
        identity: forgedIdentity,
      })
      .some((issue) => issue.code === "identity_resolution_provenance_mismatch"),
  );
  const findingConfidence = domain.assessConfidence(branch.evidence);
  assert.ok(findingConfidence.score <= domain.SPOOFABLE_CONFIDENCE_CAP);
  assert.equal(findingConfidence.label, "moderate");
});

test("structural-looking authoritative routes remain probable when every record is spoofable", () => {
  const target = domain.parseTarget("Alex Rivera, Northstar Labs, Researcher, in Mesa");
  const clock = domain.createSequenceClock();
  const ids = domain.createDeterministicIdFactory("context-spoofable-authorities");
  const branch = createContextCandidateBranch({
    target,
    candidateId: "candidate-context-spoofable-authorities",
    ids,
    clock,
    sources: [
      {
        url: "https://northstar.example/team/alex-rivera",
        sourceType: "company_page",
        excerpt: "Alex Rivera is a Researcher at Northstar Labs in Mesa.",
      },
      {
        url: "https://civic-records.example/profiles/alex-rivera",
        sourceType: "official_profile",
        excerpt: "Alex Rivera is a Researcher at Northstar Labs in Mesa.",
      },
    ],
  });

  const corroboration = domain.assessCandidateContextCorroboration(branch.candidate, branch.evidence, target);
  assert.ok(corroboration);
  assert.equal(corroboration.allSourcesSpoofable, true);
  assert.deepEqual(corroboration.authoritativeSourceFamilies, ["civic-records.example", "northstar.example"]);
  assert.equal(corroboration.decision, "probable");
  assert.equal(corroboration.decisionBasis, "needs_nonspoofable_authority");
  assert.ok(corroboration.score <= domain.CONTEXT_CORROBORATION_PROBABLE_CAP);
  assert.notEqual(domain.resolveIdentity([branch.candidate], branch.evidence, target).status, "resolved");
});

test("one exact direct family is a bounded probable lead that cannot resolve", () => {
  const target = domain.parseTarget("Alex Rivera, Northstar Labs, Researcher, in Mesa");
  const clock = domain.createSequenceClock();
  const ids = domain.createDeterministicIdFactory("context-one-family");
  const branch = createContextCandidateBranch({
    target,
    candidateId: "candidate-context-one-family",
    ids,
    clock,
    sources: [
      {
        url: "https://northstar.example/team/alex-rivera",
        sourceType: "company_page",
        excerpt: "Alex Rivera is a Researcher at Northstar Labs in Mesa.",
        spoofable: false,
      },
    ],
  });

  const corroboration = domain.assessCandidateContextCorroboration(branch.candidate, branch.evidence, target);
  assert.ok(corroboration);
  assert.equal(corroboration.decision, "probable");
  assert.equal(corroboration.decisionBasis, "needs_second_family");
  assert.deepEqual(corroboration.sourceFamilies, ["northstar.example"]);
  assert.ok(corroboration.score <= domain.CONTEXT_CORROBORATION_ONE_FAMILY_CAP);
  const identity = domain.resolveIdentity([branch.candidate], branch.evidence, target);
  assert.notEqual(identity.status, "resolved");
  assert.equal(identity.contextDecision, "probable");
  assert.deepEqual(identity.resolutionSourceFamilies, ["northstar.example"]);
});

test("two self-asserted profile families remain unresolved even with exact context", () => {
  const target = domain.parseTarget("Alex Rivera, Northstar Labs, Researcher, in Mesa");
  const clock = domain.createSequenceClock();
  const ids = domain.createDeterministicIdFactory("context-spoofable-only");
  const branch = createContextCandidateBranch({
    target,
    candidateId: "candidate-context-spoofable-only",
    ids,
    clock,
    sources: [
      {
        url: "https://profiles.example/alex-rivera",
        sourceType: "professional_profile",
        excerpt: "Alex Rivera is a Researcher at Northstar Labs in Mesa.",
      },
      {
        url: "https://social.example/alex-rivera",
        sourceType: "code_profile",
        excerpt: "Alex Rivera is a Researcher at Northstar Labs in Mesa.",
      },
    ],
  });

  const corroboration = domain.assessCandidateContextCorroboration(branch.candidate, branch.evidence, target);
  assert.ok(corroboration);
  assert.equal(corroboration.decision, "probable");
  assert.ok(corroboration.score < domain.IDENTITY_RESOLUTION_THRESHOLD);
  const identity = domain.resolveIdentity([branch.candidate], branch.evidence, target);
  assert.notEqual(identity.status, "resolved");
  assert.equal(identity.resolutionBasis, "context_corroboration");
  assert.equal(identity.contextDecision, "probable");
  assert.ok(identity.resolutionScore <= domain.CONTEXT_CORROBORATION_PROBABLE_CAP);
});

test("one authoritative context family needs an independently grounded strong identifier", () => {
  const target = domain.parseTarget("Alex Rivera, Northstar Labs, Researcher, in Mesa");
  const clock = domain.createSequenceClock();
  const ids = domain.createDeterministicIdFactory("context-authority-identifier");
  const branch = createContextCandidateBranch({
    target,
    candidateId: "candidate-context-authority-identifier",
    ids,
    clock,
    sources: [
      {
        url: "https://northstar.example/team/alex-rivera",
        sourceType: "company_page",
        excerpt: "Alex Rivera is a Researcher at Northstar Labs in Mesa.",
        spoofable: false,
      },
      {
        url: "https://profiles.example/alex-rivera",
        sourceType: "professional_profile",
        excerpt: "Alex Rivera is a Researcher at Northstar Labs in Mesa.",
      },
    ],
  });
  const profileUrl = "https://identity.example/alex-rivera";
  const excerpt = "Alex Rivera maintains this verified public profile.";
  const admission = domain.admitEvidence(
    {
      candidateId: branch.candidate.id,
      claim: excerpt,
      sourceUrl: profileUrl,
      sourceType: "official_profile",
      excerpt,
      reliability: 0.7,
      spoofable: true,
      httpStatus: 200,
      contentHash: `sha256:${"a".repeat(64)}`,
      toolCallId: "context-identifier-action",
      verificationMethod: "direct_fetch",
    },
    {
      candidateIds: new Set([branch.candidate.id]),
      existing: branch.evidence,
      ids,
      clock,
    },
  );
  assert.equal(admission.admitted, true);
  const evidence = [...branch.evidence, admission.evidence];
  let candidate = {
    ...branch.candidate,
    evidenceIds: [...branch.candidate.evidenceIds, admission.evidence.id].sort(),
  };
  candidate = domain.addCandidateSignals(
    candidate,
    [
      {
        kind: "profile_url",
        value: profileUrl,
        normalizedValue: domain.normalizeComparable(profileUrl),
        strength: "strong",
        assurance: "verified",
        sourceFamily: admission.evidence.sourceFamily,
        sourceEvidenceId: admission.evidence.id,
      },
    ],
    target,
    clock.now(),
  );

  const corroboration = domain.assessCandidateContextCorroboration(candidate, evidence, target);
  assert.ok(corroboration);
  assert.equal(corroboration.decision, "resolved_eligible");
  assert.equal(corroboration.decisionBasis, "authoritative_plus_identifier");
  assert.deepEqual(corroboration.identifierEvidenceIds, [admission.evidence.id]);
  assert.equal(domain.resolveIdentity([candidate], evidence, target).status, "resolved");
});

test("three exact all-spoofable families remain probable without inflating finding confidence", () => {
  const target = domain.parseTarget("Alex Rivera, Northstar Labs, Researcher, in Mesa");
  const clock = domain.createSequenceClock();
  const ids = domain.createDeterministicIdFactory("context-three-spoofable");
  const branch = createContextCandidateBranch({
    target,
    candidateId: "candidate-context-three-spoofable",
    ids,
    clock,
    sources: [
      {
        url: "https://profiles.example/alex-rivera",
        sourceType: "professional_profile",
        excerpt: "Alex Rivera is a Researcher at Northstar Labs in Mesa.",
      },
      {
        url: "https://social.example/alex-rivera",
        sourceType: "code_profile",
        excerpt: "Alex Rivera is a Researcher at Northstar Labs in Mesa.",
      },
      {
        url: "https://portfolio.example/alex-rivera",
        sourceType: "professional_profile",
        excerpt: "Alex Rivera is a Researcher at Northstar Labs in Mesa.",
      },
    ],
  });

  const corroboration = domain.assessCandidateContextCorroboration(branch.candidate, branch.evidence, target);
  assert.ok(corroboration);
  assert.equal(corroboration.allSourcesSpoofable, true);
  assert.deepEqual(corroboration.authoritativeSourceFamilies, []);
  assert.equal(corroboration.decision, "probable");
  assert.ok(corroboration.score <= domain.CONTEXT_CORROBORATION_PROBABLE_CAP);
  assert.notEqual(domain.resolveIdentity([branch.candidate], branch.evidence, target).status, "resolved");
  const findingConfidence = domain.assessConfidence(branch.evidence);
  assert.ok(findingConfidence.score <= domain.SPOOFABLE_CONFIDENCE_CAP);
  assert.notEqual(findingConfidence.label, "high");
});

test("direct evidence can resolve a bare name-context hypothesis without rewriting the primary target", () => {
  const target = domain.parseTarget("alex rivera meridian collective");
  const hypothesis = domain.bareNameContextHypotheses(target)[0];
  assert.equal(target.name, "Alex Rivera Meridian Collective");
  assert.deepEqual(hypothesis, {
    subjectName: "Alex Rivera",
    normalizedSubjectName: "alex rivera",
    contextPhrase: "Meridian Collective",
    normalizedContextPhrase: "meridian collective",
  });

  const clock = domain.createSequenceClock();
  const ids = domain.createDeterministicIdFactory("bare-context-resolution");
  let candidate = domain.createCandidate(
    { displayName: hypothesis.subjectName },
    target,
    "candidate-bare-context",
    clock.now(),
  );
  const evidence = [
    {
      url: "https://meridian.example/team/alex-rivera",
      sourceType: "company_page",
      spoofable: false,
    },
    {
      url: "https://records.example/alex-rivera",
      sourceType: "official_profile",
      spoofable: true,
    },
  ].map((source, index) => {
    const excerpt = "Alex Rivera worked with Meridian Collective.";
    const admission = domain.admitEvidence(
      {
        candidateId: candidate.id,
        claim: excerpt,
        sourceUrl: source.url,
        sourceType: source.sourceType,
        excerpt,
        reliability: 0.55,
        spoofable: source.spoofable,
        httpStatus: 200,
        contentHash: `sha256:${String(index + 7).padStart(64, "0")}`,
        toolCallId: `bare-context-action-${index}`,
        verificationMethod: "direct_fetch",
        attributes: {
          matchedBareContextPhrase: hypothesis.contextPhrase,
          matchedBareContextRelation: "professional",
        },
      },
      { candidateIds: new Set([candidate.id]), existing: [], ids, clock },
    );
    assert.equal(admission.admitted, true);
    return admission.evidence;
  });
  candidate = { ...candidate, evidenceIds: evidence.map((record) => record.id).sort() };
  candidate = domain.addCandidateSignals(
    candidate,
    evidence.flatMap((record) => [
      {
        kind: "name",
        value: hypothesis.subjectName,
        normalizedValue: hypothesis.normalizedSubjectName,
        strength: "strong",
        assurance: "spoofable",
        sourceFamily: record.sourceFamily,
        sourceEvidenceId: record.id,
      },
      {
        kind: "bio_phrase",
        value: hypothesis.contextPhrase,
        normalizedValue: hypothesis.normalizedContextPhrase,
        strength: "strong",
        assurance: "spoofable",
        sourceFamily: record.sourceFamily,
        sourceEvidenceId: record.id,
      },
    ]),
    target,
    clock.now(),
  );

  const corroboration = domain.assessCandidateContextCorroboration(candidate, evidence, target);
  assert.ok(corroboration);
  assert.equal(corroboration.contextBasis, "bare_name_context_hypothesis");
  const identity = domain.resolveIdentity([candidate], evidence, target);
  assert.equal(identity.status, "resolved");
  assert.equal(identity.resolutionBasis, "context_corroboration");
  assert.equal(identity.contextDecision, "resolved_eligible");
  assert.equal(identity.selectedScore, candidate.score.total);
  assert.ok(identity.resolutionScore >= domain.IDENTITY_RESOLUTION_THRESHOLD);

  // Persisted extractor annotations are display/audit metadata, not proof of
  // a relationship. Recompute the relation from the exact claim and reject a
  // forged co-occurrence-only ledger even when every attribute says it matched.
  const cooccurrenceOnly = "Alex Rivera and Meridian Collective are listed on this page.";
  const forgedEvidence = evidence.map((record) => ({
    ...record,
    claim: cooccurrenceOnly,
    normalizedClaim: domain.normalizeComparable(cooccurrenceOnly),
    excerpt: cooccurrenceOnly,
    attributes: {
      ...record.attributes,
      matchedBareContextRelation: "professional",
    },
  }));
  assert.equal(domain.assessCandidateContextCorroboration(candidate, forgedEvidence, target), null);
});

test("page-scoped completed education is replay-verifiable, source-isolated, and probable only", () => {
  const target = domain.parseTarget("alex rivera meridian academy");
  const hypothesis = domain.bareNameContextHypotheses(target)[0];
  assert.ok(hypothesis);
  const clock = domain.createSequenceClock("2026-08-25T04:00:00.000Z", 1);
  const ids = domain.createDeterministicIdFactory("page-scoped-education-domain");
  let candidate = domain.createCandidate(
    { displayName: hypothesis.subjectName },
    target,
    "candidate-page-scoped-education",
    clock.now(),
  );
  const sourceUrl = "https://alexrivera.example/profile/";
  const canonicalUrl = "https://alexrivera.example/profile";
  const observedAt = "2026-08-25T04:00:00.000Z";
  const claim = "Education Meridian Academy High School Diploma August 2022 - May 2026";
  const safetyWindow = `${claim} Cumulative GPA: 4.7/5.0`;
  const contentHash = `sha256:${"a".repeat(64)}`;
  const proof = {
    schemaVersion: "page_scoped_completed_education_v1",
    safetyWindow,
    safetyWindowLength: safetyWindow.length,
    fullTextContentHash: contentHash,
    fullTextLength: 512,
    fetchedTitle: hypothesis.subjectName,
    observedAt,
    authorizedUrl: sourceUrl,
    finalUrl: sourceUrl,
    explicitMinorMarkersAbsent: true,
    requestedContextContradictionAbsent: true,
  };
  const admission = domain.admitEvidence(
    {
      candidateId: candidate.id,
      claim,
      sourceUrl,
      sourceType: "other",
      title: hypothesis.subjectName,
      observedAt,
      httpStatus: 200,
      contentHash,
      excerpt: claim,
      canonicalSubset: { mimeType: "text/html", truncated: false, pageScopedEducationProof: proof },
      toolCallId: "page-scoped-education-fetch",
      verificationMethod: "direct_fetch",
      temporalStatus: "historical",
      reliability: 0.55,
      spoofable: true,
      attributes: {
        untrustedContent: true,
        fullBodyRetained: false,
        ownershipVerified: false,
        extractedSubjectLabel: hypothesis.subjectName,
        queryBoundSubjectName: hypothesis.subjectName,
        matchedBareContextPhrase: hypothesis.contextPhrase,
        matchedBareContextRelation: "alumni",
        pageScopedSubjectScope: "exact_fetched_title_personal_profile",
        pageScopedAuthorizedUrl: sourceUrl,
        extractiveClaim: true,
        extractionMethod: "deterministic_page_scoped_completed_education",
      },
    },
    { candidateIds: new Set([candidate.id]), existing: [], ids, clock },
  );
  assert.equal(admission.admitted, true);
  const record = admission.evidence;
  assert.equal(record.sourceUrl, canonicalUrl, "the proof tolerates normal evidence URL canonicalization");
  candidate = { ...candidate, evidenceIds: [record.id] };
  candidate = domain.addCandidateSignals(
    candidate,
    [
      {
        kind: "name",
        value: hypothesis.subjectName,
        normalizedValue: hypothesis.normalizedSubjectName,
        strength: "strong",
        assurance: "spoofable",
        sourceFamily: record.sourceFamily,
        sourceEvidenceId: record.id,
      },
      {
        kind: "bio_phrase",
        value: hypothesis.contextPhrase,
        normalizedValue: hypothesis.normalizedContextPhrase,
        strength: "strong",
        assurance: "spoofable",
        sourceFamily: record.sourceFamily,
        sourceEvidenceId: record.id,
      },
    ],
    target,
    clock.now(),
  );

  assert.equal(
    domain.isPageScopedCompletedEducationEvidence(record, candidate, hypothesis.subjectName, hypothesis.contextPhrase),
    true,
  );
  const corroboration = domain.assessCandidateContextCorroboration(candidate, [record], target);
  assert.ok(corroboration);
  assert.equal(corroboration.decision, "probable");
  assert.equal(corroboration.decisionBasis, "needs_second_family");
  assert.equal(corroboration.sourceFamilies.length, 1);
  assert.equal(corroboration.allSourcesSpoofable, true);
  assert.ok(corroboration.score <= domain.CONTEXT_CORROBORATION_ONE_FAMILY_CAP);
  assert.notEqual(domain.resolveIdentity([candidate], [record], target).status, "resolved");

  const withProof = (patch) => ({
    ...record,
    canonicalSubset: {
      ...record.canonicalSubset,
      pageScopedEducationProof: { ...record.canonicalSubset.pageScopedEducationProof, ...patch },
    },
  });
  const secondPersonClaim = "Education Jordan Lee — Meridian Academy High School Diploma August 2022 - May 2026";
  const forged = [
    { ...record, title: "Alex Rivera Smith" },
    {
      ...record,
      sourceUrl: "https://alexriverajr.example/profile",
      canonicalUrl: "https://alexriverajr.example/profile",
    },
    { ...record, attributes: { ...record.attributes, matchedBareContextPhrase: "Meridian Academies" } },
    { ...record, attributes: { ...record.attributes, matchedBareContextRelation: "professional" } },
    { ...record, attributes: { ...record.attributes, extractiveClaim: false } },
    { ...record, temporalStatus: "current" },
    { ...record, canonicalSubset: { ...record.canonicalSubset, mimeType: "text/plain" } },
    withProof({ observedAt: "2035" }),
    withProof({ authorizedUrl: "https://attacker.example/profile" }),
    withProof({ explicitMinorMarkersAbsent: false }),
    withProof({ requestedContextContradictionAbsent: false }),
    withProof({ safetyWindowLength: safetyWindow.length + 1 }),
    {
      ...withProof({ safetyWindow: secondPersonClaim, safetyWindowLength: secondPersonClaim.length }),
      claim: secondPersonClaim,
      excerpt: secondPersonClaim,
    },
    { ...record, reliability: 0.8 },
    { ...record, spoofable: false },
  ];
  for (const forgedRecord of forged) {
    assert.equal(
      domain.isPageScopedCompletedEducationEvidence(
        forgedRecord,
        candidate,
        hypothesis.subjectName,
        hypothesis.contextPhrase,
      ),
      false,
    );
  }
  assert.equal(
    domain
      .validateReferentialIntegrity({ target, candidates: [candidate], evidence: [record], findings: [] })
      .some((issue) => issue.code === "candidate_signal_provenance_mismatch"),
    false,
  );
  assert.equal(
    domain
      .validateReferentialIntegrity({
        target,
        candidates: [candidate],
        evidence: [withProof({ requestedContextContradictionAbsent: false })],
        findings: [],
      })
      .some((issue) => issue.code === "candidate_signal_provenance_mismatch"),
    true,
    "integrity replay recomputes the canonical page-scoped proof instead of trusting its selector",
  );
  const {
    pageScopedSubjectScope: _scope,
    extractionMethod: _method,
    ...strippedSelectorAttributes
  } = record.attributes;
  assert.equal(
    domain
      .validateReferentialIntegrity({
        target,
        candidates: [candidate],
        evidence: [{ ...record, attributes: strippedSelectorAttributes }],
        findings: [],
      })
      .some((issue) => issue.code === "candidate_signal_provenance_mismatch"),
    true,
    "a cassette-bound page proof cannot bypass integrity when unbound selector attributes are stripped",
  );
});

test("contradictory direct context prevents resolution", () => {
  const target = domain.parseTarget("Alex Rivera, Northstar Labs, Researcher, in Mesa");
  const clock = domain.createSequenceClock();
  const ids = domain.createDeterministicIdFactory("context-contradiction");
  const branch = createContextCandidateBranch({
    target,
    candidateId: "candidate-context-contradiction",
    ids,
    clock,
    sources: [
      {
        url: "https://northstar.example/team/alex-rivera",
        sourceType: "company_page",
        excerpt: "Alex Rivera is a Researcher at Northstar Labs in Mesa.",
        spoofable: false,
      },
      {
        url: "https://civic-records.example/profiles/alex-rivera",
        sourceType: "public_document",
        excerpt: "Alex Rivera is a Researcher at Northstar Labs in Mesa.",
      },
      {
        url: "https://corrections.example/alex-rivera",
        sourceType: "public_document",
        excerpt: "Alex Rivera is not affiliated with Northstar Labs.",
        disposition: "contradicts",
      },
    ],
  });

  assert.equal(domain.assessCandidateContextCorroboration(branch.candidate, branch.evidence, target), null);
  assert.notEqual(domain.resolveIdentity([branch.candidate], branch.evidence, target).status, "resolved");
});

test("adjacent or subordinate people cannot satisfy requested context", () => {
  const target = domain.parseTarget("Alex Rivera, Northstar Labs, Researcher, in Mesa");
  const clock = domain.createSequenceClock();
  const ids = domain.createDeterministicIdFactory("context-adjacent-person");
  for (const [key, excerpt] of [
    ["adjacent", "Alex Rivera is listed in the directory, Bob Chen is a Researcher at Northstar Labs in Mesa."],
    ["subordinate", "Alex Rivera says Bob Chen is a Researcher at Northstar Labs in Mesa."],
    ["reverse-owner", "Northstar Labs employs Bob Chen, according to Alex Rivera, who is a Researcher in Mesa."],
  ]) {
    const branch = createContextCandidateBranch({
      target,
      candidateId: `candidate-context-${key}-person`,
      ids,
      clock,
      sources: [
        {
          url: `https://northstar.example/${key}-directory`,
          sourceType: "company_page",
          excerpt,
          spoofable: false,
        },
        {
          url: `https://records.example/${key}-directory`,
          sourceType: "public_document",
          excerpt,
        },
      ],
    });

    assert.equal(domain.assessCandidateContextCorroboration(branch.candidate, branch.evidence, target), null, key);
    assert.notEqual(domain.resolveIdentity([branch.candidate], branch.evidence, target).status, "resolved", key);
  }
});

test("competing exact-context branches remain ambiguous without the resolution margin", () => {
  const target = domain.parseTarget("Alex Rivera, Northstar Labs, Researcher, in Mesa");
  const clock = domain.createSequenceClock();
  const ids = domain.createDeterministicIdFactory("context-margin");
  const first = createContextCandidateBranch({
    target,
    candidateId: "candidate-context-alpha",
    ids,
    clock,
    sources: [
      {
        url: "https://northstar-one.example/team/alex-rivera",
        sourceType: "company_page",
        excerpt: "Alex Rivera is a Researcher at Northstar Labs in Mesa.",
        spoofable: false,
      },
      {
        url: "https://records-one.example/alex-rivera",
        sourceType: "official_profile",
        excerpt: "Alex Rivera is a Researcher at Northstar Labs in Mesa.",
      },
    ],
  });
  const second = createContextCandidateBranch({
    target,
    candidateId: "candidate-context-beta",
    ids,
    clock,
    sources: [
      {
        url: "https://northstar-two.example/team/alex-rivera",
        sourceType: "company_page",
        excerpt: "Alex Rivera is a Researcher at Northstar Labs in Mesa.",
        spoofable: false,
      },
      {
        url: "https://records-two.example/alex-rivera",
        sourceType: "official_profile",
        excerpt: "Alex Rivera is a Researcher at Northstar Labs in Mesa.",
      },
    ],
  });

  const identity = domain.resolveIdentity(
    [first.candidate, second.candidate],
    [...first.evidence, ...second.evidence],
    target,
  );
  assert.equal(identity.status, "ambiguous");
  assert.ok(identity.runnerUpMargin < domain.IDENTITY_MARGIN_THRESHOLD);
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

test("report artifact policy rejects private technical artifacts while preserving typed provenance hashes", () => {
  const bcrypt = "$2b$12$" + "A".repeat(53);
  const argon2 = "$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$ZGlnZXN0ZGlnZXN0";
  for (const artifact of [
    "The page exposed 198.51.100.42.",
    "The page exposed 2001:db8::42.",
    "Jordan Vale appears in breached accounts.",
    "A credential dump lists Jordan Vale.",
    "An account paste contains Jordan Vale.",
    "A creden\u200btial dump lists Jordan Vale.",
    bcrypt,
    argon2,
    "credential hash: " + "a".repeat(64),
    "jordan.vale@example.test:" + "b".repeat(32),
    "https%3A%2F%2F%5B2001%3Adb8%3A%3A42%5D%2Fprofile",
  ]) {
    assert.equal(domain.containsRestrictedReportArtifact(artifact), true, artifact);
  }

  for (const ordinaryProfessionalText of [
    "Jordan Vale published a paper on data breach prevention.",
    "Jordan Vale maintains a core dump analysis tool.",
    "Jordan Vale built a code paste formatter.",
    "sha256:" + "a".repeat(64),
    "fnv1a32:deadbeef",
    "The release identifier is 999.999.999.999.",
  ]) {
    assert.equal(domain.containsRestrictedReportArtifact(ordinaryProfessionalText), false, ordinaryProfessionalText);
  }

  const sha256 = "sha256:" + "c".repeat(64);
  const rawSha256 = "d".repeat(64);
  for (const obfuscated of [
    "private\u200b-contact@example.test",
    "password\u200b=" + "x".repeat(32),
    "https://example.test/?access\u200b_token=secret",
  ]) {
    assert.equal(domain.containsRestrictedPublicContent(obfuscated), true, obfuscated);
  }
  const paths = domain.restrictedReportArtifactJsonPaths(
    {
      contentHash: sha256,
      pageFootprintHash: sha256,
      sourcePageContentHash: sha256,
      parentSourceContentHash: sha256,
      fullTextContentHash: sha256,
      footprintHash: sha256,
      bodyHashSha256: rawSha256,
      contentHashSha256: rawSha256,
      metadataHashSha256: rawSha256,
      structureHashSha256: rawSha256,
      arbitraryDigest: rawSha256,
      publicationDigest: rawSha256,
      tokenizationHash: rawSha256,
      hostile: {
        apiKeyFingerprint: rawSha256,
        credentialSha256: rawSha256,
        digestOfRefreshToken: rawSha256,
        passwordHash: "e".repeat(64),
        "password\u200bDigest": rawSha256,
        ipAddress: "198.51.100.42",
        note: bcrypt,
      },
      malformedProvenance: {
        contentHash: 42,
        pageFootprintHash: "sha256:not-a-hash",
      },
    },
    "report",
  );
  assert.deepEqual(paths.sort(), [
    "report.hostile.apiKeyFingerprint",
    "report.hostile.credentialSha256",
    "report.hostile.digestOfRefreshToken",
    "report.hostile.ipAddress",
    "report.hostile.note",
    "report.hostile.passwordHash",
    "report.hostile.password\u200bDigest",
    "report.malformedProvenance.contentHash",
    "report.malformedProvenance.pageFootprintHash",
  ]);
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

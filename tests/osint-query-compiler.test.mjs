import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "vite";

const vite = await createServer({
  configFile: false,
  cacheDir: `node_modules/.vite-atlas-ssr/${process.pid}`,
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true },
});
after(async () => vite.close());

const domain = await vite.ssrLoadModule("/lib/domain/index.ts");
const search = await vite.ssrLoadModule("/lib/search/index.ts");

const exclusions = ["-jobs", '-"resume template"', '-"name meaning"', '-"stock photo"', "-quotes", "-crossword"];

test("compiler emits a finite, ordered exact-name plan with public-professional operators", () => {
  const plan = search.compileOsintQueries(domain.parseTarget("Denise Hilary"), {
    institutionDomains: ["asu.edu", "ox.ac.uk"],
  });

  assert.equal(plan.status, "compiled");
  assert.equal(plan.compilerVersion, 2);
  assert.deepEqual(plan.acceptedInstitutionDomains, ["asu.edu", "ox.ac.uk"]);
  assert.ok(plan.queries.length <= search.MAX_OSINT_QUERY_VARIANTS);
  assert.deepEqual(
    plan.queries.map((query) => query.kind),
    [
      "exact_baseline",
      "exact_refinement",
      "professional_site",
      "professional_site",
      "public_metadata_site",
      "professional_site",
      "public_scholarly_site",
      "public_academic_site",
      "professional_content",
      "public_thread",
      "public_forum",
      "authored_content",
      "interview_discussion",
      "institution_site",
      "institution_site",
      "public_document",
    ],
  );
  assert.equal(plan.queries[0].query, '"Denise Hilary"');
  assert.equal(plan.queries[0].refinement, "none");
  assert.equal(plan.queries[0].derivedFrom, "target_subject_baseline");
  assert.equal(plan.queries[0].query.includes("-"), false);
  assert.match(plan.queries[1].query, /^"Denise Hilary" \(official OR biography OR leadership OR executive\) /);
  assert.equal(plan.queries[1].refinement, "public_web_noise_exclusions");
  assert.equal(plan.queries[1].derivedFrom, "compiler_public_professional_refinement");
  assert.equal(
    plan.queries.find((query) => query.site === "github.com")?.query.startsWith('"Denise Hilary" site:github.com '),
    true,
  );
  assert.equal(
    plan.queries.find((query) => query.site === "linkedin.com")?.query.startsWith('"Denise Hilary" site:linkedin.com '),
    true,
  );
  const professionalIdentity = plan.queries.find((query) => query.kind === "professional_site" && query.site === null);
  assert.equal(professionalIdentity?.derivedFrom, "compiler_professional_allowlist");
  for (const site of ["orcid.org", "scholar.google.com"])
    assert.ok(professionalIdentity?.query.includes(`site:${site}`), site);
  const appStore = plan.queries.find((query) => query.site === "apps.apple.com");
  assert.equal(appStore?.kind, "public_metadata_site");
  assert.equal(appStore?.derivedFrom, "compiler_public_metadata_allowlist");
  assert.equal(appStore?.query.startsWith('"Denise Hilary" site:apps.apple.com '), true);
  const publicScholarly = plan.queries.find((query) => query.kind === "public_scholarly_site");
  assert.equal(publicScholarly?.site, null);
  assert.equal(publicScholarly?.derivedFrom, "compiler_public_scholarly_allowlist");
  for (const site of ["openreview.net", "semanticscholar.org", "crossref.org"])
    assert.ok(publicScholarly?.query.includes(`site:${site}`), site);
  const publicAcademic = plan.queries.find((query) => query.kind === "public_academic_site");
  assert.equal(publicAcademic?.site, null);
  assert.equal(publicAcademic?.derivedFrom, "compiler_public_academic_allowlist");
  for (const site of ["openalex.org", "researchgate.net"])
    assert.ok(publicAcademic?.query.includes(`site:${site}`), site);
  const linkedInContent = plan.queries.find((query) => query.kind === "professional_content");
  assert.equal(linkedInContent?.resultShape, "linkedin_content");
  assert.match(linkedInContent?.query ?? "", /site:linkedin\.com \(posts OR pulse OR activity\)/);
  const publicThread = plan.queries.find((query) => query.kind === "public_thread");
  assert.equal(publicThread?.resultShape, "x_thread");
  for (const site of ["x.com", "twitter.com"]) assert.ok(publicThread?.query.includes(`site:${site}`), site);
  const publicForum = plan.queries.find((query) => query.kind === "public_forum");
  assert.equal(publicForum?.resultShape, "reddit_discussion");
  assert.match(publicForum?.query ?? "", /site:reddit\.com \(comments OR AMA OR discussion\)/);
  assert.ok(plan.queries.some((query) => query.kind === "authored_content"));
  assert.ok(plan.queries.some((query) => query.kind === "interview_discussion"));
  assert.ok(
    plan.queries.some(
      (query) =>
        query.kind === "public_document" &&
        query.query.includes("filetype:pdf") &&
        query.query.includes("intitle:profile"),
    ),
  );
  for (const query of plan.queries.slice(1)) {
    assert.equal(query.refinement, "public_web_noise_exclusions");
    for (const exclusion of exclusions) assert.ok(query.query.includes(exclusion));
    assert.equal(/https?:\/\//.test(query.query), false, "compiler emitted a search-engine URL");
  }
  const allowedSites = new Set([
    "github.com",
    "linkedin.com",
    "orcid.org",
    "scholar.google.com",
    "openreview.net",
    "apps.apple.com",
    "asu.edu",
    "ox.ac.uk",
  ]);
  assert.ok(plan.queries.every((query) => query.site === null || allowedSites.has(query.site)));
  assert.ok(plan.diagnostics.some((item) => item.code === "query_limit_applied" && item.count === 1));
});

test("deep social queries admit only exact public post, thread, and discussion permalinks", () => {
  const shapes = new Map(
    search
      .compileOsintQueries(domain.parseTarget("Denise Hilary"))
      .queries.filter((query) => query.resultShape !== "any")
      .map((query) => [query.resultShape, query]),
  );

  for (const [shape, accepted, rejected] of [
    [
      "linkedin_content",
      "https://www.linkedin.com/posts/denise-hilary_atlas-research-activity-1234567890123456789-abcd",
      "https://www.linkedin.com/search/results/people/?keywords=Denise%20Hilary",
    ],
    ["x_thread", "https://x.com/denise_h/status/1234567890123456789", "https://x.com/explore"],
    [
      "reddit_discussion",
      "https://www.reddit.com/r/MachineLearning/comments/abc123/denise_hilary_ama/",
      "https://www.reddit.com/search/?q=Denise%20Hilary",
    ],
  ]) {
    assert.ok(shapes.has(shape), shape);
    assert.equal(search.matchesCompiledOsintResultShape(shape, accepted), true, accepted);
    assert.equal(search.matchesCompiledOsintResultShape(shape, rejected), false, rejected);
  }
  assert.equal(
    search.matchesCompiledOsintResultShape("x_thread", "https://x.com.example/denise_h/status/1234567890123"),
    false,
  );
});

test("compiler remains query-generic for multiple Latin and non-Latin names", () => {
  for (const name of ["Ashwin Rokkam", "Chinmay Bhat", "张伟", "Ольга Иванова", "अनन्या शर्मा"]) {
    const target = domain.parseTarget(name);
    const plan = search.compileOsintQueries(target);
    assert.equal(target.kind, "named_person", name);
    assert.equal(plan.status, "compiled", name);
    assert.equal(plan.queries[0].query, `"${target.name}"`, name);
    assert.ok(
      plan.queries.some((query) => query.site === "github.com"),
      name,
    );
    assert.ok(
      plan.queries.some((query) => query.query.includes("site:scholar.google.com")),
      name,
    );
    assert.ok(
      plan.queries.some((query) => query.kind === "public_document"),
      name,
    );
    assert.ok(
      plan.queries.every((query) => query.query.includes(`"${query.subjectPhrase}"`)),
      name,
    );
  }
});

test("deep compiler spends its sixteen-query cap on one subject's focused source families", () => {
  const plan = search.compileOsintQueries(domain.parseTarget("Renée D'Angelo Smith, Example Labs, in Phoenix"), {
    institutionDomains: ["asu.edu", "ox.ac.uk"],
  });

  assert.equal(search.MAX_OSINT_QUERY_VARIANTS, 16);
  assert.equal(plan.queries.length, 16);
  assert.ok(plan.diagnostics.some((item) => item.code === "query_limit_applied" && item.count === 2));
  assert.deepEqual(
    plan.queries.filter((query) => query.site).map((query) => query.site),
    ["github.com", "linkedin.com", "apps.apple.com", "asu.edu", "ox.ac.uk"],
  );
  assert.equal(
    plan.queries.some((query) => query.kind === "orthographic_name"),
    false,
  );
  assert.equal(
    plan.queries.some((query) => query.kind === "initial_name"),
    false,
  );
  const groupedScopes = plan.queries.filter(
    (query) => query.kind === "professional_site" || query.kind === "public_scholarly_site",
  );
  for (const site of ["orcid.org", "scholar.google.com", "openreview.net", "semanticscholar.org", "crossref.org"])
    assert.ok(
      groupedScopes.some((query) => query.query.includes(`site:${site}`)),
      site,
    );
  for (const kind of [
    "professional_content",
    "public_thread",
    "public_forum",
    "authored_content",
    "interview_discussion",
  ])
    assert.ok(
      plan.queries.some((query) => query.kind === kind),
      kind,
    );
  assert.ok(plan.queries.some((query) => query.kind === "public_academic_site"));
  assert.ok(plan.queries.some((query) => query.kind === "public_document"));
  assert.equal(
    plan.queries.some((query) => query.kind === "exact_refinement"),
    false,
  );
  assert.equal(
    plan.queries.some((query) => query.kind === "regulatory_filing"),
    false,
  );
});

test("focused compilation omits alias-like name transformations before deep source branches", () => {
  const target = {
    ...domain.parseTarget("Renée D'Angelo Smith"),
    name: "Renée D'Angelo Smith",
  };
  const plan = search.compileOsintQueries(target);
  assert.equal(
    plan.queries.some((query) => query.kind === "orthographic_name"),
    false,
  );
  assert.equal(
    plan.queries.some((query) => query.kind === "initial_name"),
    false,
  );
  for (const kind of ["professional_content", "public_thread", "public_forum"])
    assert.ok(
      plan.queries.some((query) => query.kind === kind),
      kind,
    );
  assert.equal(
    plan.queries.some((query) => /alias|nickname|gmail|yahoo/i.test(query.query)),
    false,
  );
});

test("parsed organization and role context produce quoted, deterministic professional queries", () => {
  const named = search.compileOsintQueries(domain.parseTarget("Alex Kim, Example Labs"));
  assert.ok(
    named.queries.some(
      (query) => query.kind === "exact_context" && query.query.startsWith('"Alex Kim" "Example Labs"'),
    ),
  );
  for (const site of ["linkedin.com"]) {
    assert.ok(
      named.queries.some(
        (query) => query.site === site && query.query.startsWith(`"Alex Kim" "Example Labs" site:${site}`),
      ),
      site,
    );
  }
  for (const site of ["scholar.google.com", "crossref.org"]) {
    assert.ok(
      named.queries.some((query) => query.site === null && query.query.includes(`site:${site}`)),
      site,
    );
  }
  assert.ok(
    named.queries.some(
      (query) => query.kind === "public_document" && query.query.startsWith('"Alex Kim" "Example Labs" filetype:pdf'),
    ),
  );

  const role = search.compileOsintQueries(domain.parseTarget("the CTO of Ariglad"));
  assert.equal(role.status, "compiled");
  assert.equal(role.queries[0].subjectPhrase, "Chief Technology Officer");
  assert.ok(
    role.queries.some(
      (query) => query.kind === "exact_context" && query.query.startsWith('"Chief Technology Officer" "Ariglad"'),
    ),
  );
  assert.ok(
    role.queries.some((query) => query.kind === "public_document" && query.query.includes("intitle:leadership")),
  );
});

test("natural adult-school context remains quoted across scoped and institutional document queries", () => {
  const target = domain.parseTarget("Chinmay Bhat studies at Arizona State University");
  const plan = search.compileOsintQueries(target);
  assert.equal(plan.status, "compiled");
  const contextual = plan.queries.filter(
    (query) => query.kind !== "exact_context" && query.query.includes('"Chinmay Bhat" "Arizona State University"'),
  );
  assert.equal(contextual.length, 13);
  assert.ok(
    contextual.every((query) => query.query.includes('"Chinmay Bhat" "Arizona State University"')),
    JSON.stringify(contextual),
  );
  assert.ok(contextual.some((query) => query.site === "linkedin.com"));
  assert.ok(contextual.some((query) => query.query.includes("site:scholar.google.com")));
  assert.ok(contextual.some((query) => query.kind === "public_scholarly_site"));
  assert.ok(contextual.some((query) => query.kind === "public_academic_site"));
  assert.ok(contextual.some((query) => query.kind === "professional_content"));
  assert.ok(contextual.some((query) => query.kind === "public_thread"));
  assert.ok(contextual.some((query) => query.kind === "public_forum"));
  assert.ok(contextual.some((query) => query.kind === "authored_content"));
  assert.ok(contextual.some((query) => query.kind === "interview_discussion"));
  assert.ok(contextual.some((query) => query.kind === "public_document"));
});

test("bare name-context discovery preserves the full-name primary and emits one auditable T1 hypothesis", () => {
  const target = domain.parseTarget("alex rivera meridian collective");
  const plan = search.compileOsintQueries(target);
  const hypothesis = plan.queries.filter((query) => query.kind === "bare_context_hypothesis");

  assert.equal(target.name, "Alex Rivera Meridian Collective");
  assert.equal(hypothesis.length, 1);
  assert.equal(hypothesis[0].subjectPhrase, "Alex Rivera");
  assert.equal(hypothesis[0].hypothesisContextPhrase, "Meridian Collective");
  assert.equal(hypothesis[0].derivedFrom, "target_bare_context_hypothesis");
  assert.ok(hypothesis[0].query.startsWith('"Alex Rivera" "Meridian Collective" '));

  const lane = search.sourceLaneById("t1.first_party");
  assert.ok(lane);
  assert.ok(search.compiledQueriesForLane(target, lane).some((query) => query.query === hypothesis[0].query));
  assert.equal(
    search
      .compileOsintQueries(domain.parseTarget("ludwig van beethoven society"))
      .queries.some((query) => query.kind === "bare_context_hypothesis"),
    false,
  );
});

test("context compiler supports mononyms and retains bounded organization, role, and location discriminators", () => {
  const mononym = search.compileOsintQueries(domain.parseTarget("Usher"));
  assert.equal(mononym.status, "compiled");
  assert.equal(mononym.queries[0].query, '"Usher"');
  assert.equal(
    mononym.queries.some((query) => query.kind === "initial_name"),
    false,
  );

  const professor = search.compileOsintQueries(domain.parseTarget("Michael Jordan, professor at UC Berkeley"));
  assert.ok(
    professor.queries.some(
      (query) => query.kind === "exact_context" && query.query.startsWith('"Michael Jordan" "UC Berkeley" "Professor"'),
    ),
  );

  const location = search.compileOsintQueries(domain.parseTarget("Ganesh Talluri based in Peoria"));
  assert.ok(
    location.queries.some(
      (query) => query.kind === "exact_context" && query.query.startsWith('"Ganesh Talluri" "Peoria"'),
    ),
  );

  for (const query of ["Ganesh Talluri at Arizona State University", "Ganesh Talluri with Example Labs"]) {
    const plan = search.compileOsintQueries(domain.parseTarget(query));
    assert.ok(
      plan.queries.some((item) => item.kind === "exact_context"),
      query,
    );
  }
});

test("context compiler drops restricted location fragments before rendering search syntax", () => {
  const base = domain.parseTarget("Ada Lovelace");
  for (const unsafeContext of ["123 Main Street", "6025550199", "high school student age 16"]) {
    const plan = search.compileOsintQueries({ ...base, locationHints: [unsafeContext] });
    assert.equal(plan.status, "compiled");
    assert.equal(JSON.stringify(plan).includes(unsafeContext), false, unsafeContext);
    assert.equal(
      plan.queries.some((query) => query.kind === "exact_context"),
      false,
      unsafeContext,
    );
  }
});

test("institution scopes are academic-only, bounded, deduplicated, and never echo rejects", () => {
  const plan = search.compileOsintQueries(domain.parseTarget("Denise Hilary"), {
    institutionDomains: [
      "ASU.EDU",
      "asu.edu",
      "people.ox.ac.uk",
      "example.com",
      "evil.edu.example.com",
      "asu.edu site:private.example",
      "https://stanford.edu/people",
    ],
  });

  assert.deepEqual(plan.acceptedInstitutionDomains, ["asu.edu", "people.ox.ac.uk"]);
  assert.deepEqual(
    plan.queries.filter((query) => query.kind === "institution_site").map((query) => query.site),
    ["asu.edu", "people.ox.ac.uk"],
  );
  const rejection = plan.diagnostics.find((item) => item.code === "institution_domains_rejected");
  assert.equal(rejection?.count, 4);
  assert.equal(JSON.stringify(plan).includes("private.example"), false);
  assert.equal(JSON.stringify(plan).includes("stanford.edu/people"), false);
});

test("a name plus exact supplied academic URL compiles only its domain as an institution scope", () => {
  const target = domain.parseTarget("Denise Hilary, https://asu.edu");
  assert.equal(target.kind, "url");
  const institutionDomains = target.identifiers
    .filter((identifier) => identifier.kind === "domain" && identifier.provenance === "user_input")
    .map((identifier) => identifier.normalizedValue);
  const plan = search.compileOsintQueries(target, { institutionDomains });
  assert.equal(plan.status, "compiled");
  assert.equal(plan.queries[0].query, '"Denise Hilary"');
  assert.ok(plan.queries.some((query) => query.kind === "institution_site" && query.site === "asu.edu"));
  assert.equal(
    plan.queries.some((query) => query.query.includes("https://asu.edu")),
    false,
  );
});

test("email and other identifier targets never enter this compiler or produce inferred contact queries", () => {
  for (const raw of ["denise@example.com", "https://example.com/denise", "github:denise", "repo:example/project"]) {
    const plan = search.compileOsintQueries(domain.parseTarget(raw));
    assert.equal(plan.status, "unsupported");
    assert.deepEqual(plan.queries, []);
    assert.equal(plan.diagnostics[0].code, "unsupported_target_kind");
    assert.equal(JSON.stringify(plan).includes("denise@example.com"), false);
  }
});

test("manually forged contact and credential subjects fail closed without echoing the value", () => {
  const organization = domain.parseTarget("Example Labs");
  for (const unsafeName of ["AWS SECRET ACCESS KEY", "person@example.com", "+1 (602) 555-0100", "123 Main Street"]) {
    const plan = search.compileOsintQueries({
      ...organization,
      kind: "organization",
      organizationHints: [
        {
          name: unsafeName,
          normalizedName: unsafeName.toLocaleLowerCase("en-US"),
          relationship: "unspecified",
        },
      ],
    });
    assert.equal(plan.status, "unsupported");
    assert.deepEqual(plan.queries, []);
    assert.equal(plan.diagnostics[0].code, "invalid_public_professional_subject");
    assert.equal(JSON.stringify(plan).includes(unsafeName), false);
  }
});

test("query limit is clamped and reports omitted variants without changing stable IDs", () => {
  const plan = search.compileOsintQueries(domain.parseTarget("Denise Hilary"), {
    institutionDomains: ["asu.edu", "ox.ac.uk"],
    maxQueries: 3,
  });
  assert.equal(plan.queries.length, 3);
  assert.deepEqual(
    plan.queries.map((query) => query.id),
    ["osint_query_01", "osint_query_02", "osint_query_03"],
  );
  assert.ok(plan.diagnostics.some((item) => item.code === "query_limit_applied" && item.count === 14));

  const clamped = search.compileOsintQueries(domain.parseTarget("Denise Hilary"), {
    maxQueries: 100_000,
  });
  assert.ok(clamped.queries.length <= search.MAX_OSINT_QUERY_VARIANTS);
});

test("compiler preserves complete quotes and operators at the runtime query-length boundary", () => {
  const longName = ["A".repeat(28), "B".repeat(28), "C".repeat(28), "D".repeat(28), "E".repeat(28)].join(" ");
  const longOrganization = `${"O".repeat(130)} Labs`;
  const target = {
    ...domain.parseTarget("Ada Lovelace, Example Labs"),
    name: longName,
    normalizedQuery: `${longName}, ${longOrganization}`,
    organizationHints: [
      {
        name: longOrganization,
        normalizedName: longOrganization.toLocaleLowerCase("en-US"),
        relationship: "unspecified",
      },
    ],
    roleHints: ["Chief Technology Officer"],
  };
  const plan = search.compileOsintQueries(target);

  assert.equal(plan.status, "compiled");
  assert.ok(plan.queries.length > 0);
  assert.ok(plan.queries.every((query) => query.query.length <= search.MAX_COMPILED_OSINT_QUERY_CHARACTERS));
  assert.ok(plan.queries.every((query) => (query.query.match(/"/g) ?? []).length % 2 === 0));
  const context = plan.queries.find((query) => query.kind === "exact_context");
  assert.ok(context?.query.includes('"Chief Technology Officer"'));
  assert.equal(context?.query.includes(longOrganization), false, "an oversized context phrase must be omitted whole");
  assert.ok(plan.diagnostics.some((item) => item.code === "query_length_constraint_applied" && item.count === 1));

  for (const laneId of [
    "t1.first_party",
    "t2.structured_professional",
    "t3.institutional",
    "t4.reputable_media",
    "t6.general_discovery",
  ]) {
    const lane = search.sourceLaneById(laneId);
    const queries = search.compiledQueriesForLane(target, lane);
    if (queries.length === 0) continue;
    assert.equal(search.sourceLaneQueryHint(target, lane), queries[0].query);
  }
});

import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createServer } from "vite";

const vite = await createServer({
  configFile: false,
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true },
});
after(async () => vite.close());

const domain = await vite.ssrLoadModule("/lib/domain/index.ts");
const search = await vite.ssrLoadModule("/lib/search/index.ts");

const exclusions = ["-jobs", '-"resume template"', '-"name meaning"', '-"stock photo"'];

test("compiler emits a finite, ordered exact-name plan with public-professional operators", () => {
  const plan = search.compileOsintQueries(domain.parseTarget("Denise Hilary"), {
    institutionDomains: ["asu.edu", "ox.ac.uk"],
  });

  assert.equal(plan.status, "compiled");
  assert.equal(plan.compilerVersion, 1);
  assert.deepEqual(plan.acceptedInstitutionDomains, ["asu.edu", "ox.ac.uk"]);
  assert.ok(plan.queries.length <= search.MAX_OSINT_QUERY_VARIANTS);
  assert.deepEqual(
    plan.queries.map((query) => query.kind),
    [
      "exact_baseline",
      "exact_refinement",
      "initial_name",
      "professional_site",
      "professional_site",
      "professional_site",
      "public_metadata_site",
      "institution_site",
      "institution_site",
      "public_document",
    ],
  );
  assert.equal(plan.queries[0].query, '"Denise Hilary"');
  assert.equal(plan.queries[0].refinement, "none");
  assert.equal(plan.queries[0].derivedFrom, "target_subject_baseline");
  assert.equal(plan.queries[0].query.includes("-"), false);
  assert.match(plan.queries[1].query, /^"Denise Hilary" professional /);
  assert.equal(plan.queries[1].refinement, "public_web_noise_exclusions");
  assert.equal(plan.queries[1].derivedFrom, "compiler_public_professional_refinement");
  assert.equal(
    plan.queries.find((query) => query.site === "github.com")?.query.startsWith('"Denise Hilary" site:github.com '),
    true,
  );
  assert.equal(
    plan.queries.find((query) => query.site === "orcid.org")?.query.startsWith('"Denise Hilary" site:orcid.org '),
    true,
  );
  assert.equal(
    plan.queries
      .find((query) => query.site === "scholar.google.com")
      ?.query.startsWith('"Denise Hilary" site:scholar.google.com '),
    true,
  );
  const appStore = plan.queries.find((query) => query.site === "apps.apple.com");
  assert.equal(appStore?.kind, "public_metadata_site");
  assert.equal(appStore?.derivedFrom, "compiler_public_metadata_allowlist");
  assert.equal(appStore?.query.startsWith('"Denise Hilary" site:apps.apple.com '), true);
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
    "orcid.org",
    "scholar.google.com",
    "apps.apple.com",
    "asu.edu",
    "ox.ac.uk",
  ]);
  assert.ok(plan.queries.every((query) => query.site === null || allowedSites.has(query.site)));
});

test("name transformations are mechanical and retain their derivation", () => {
  const target = {
    ...domain.parseTarget("Renée D'Angelo Smith"),
    name: "Renée D'Angelo Smith",
  };
  const plan = search.compileOsintQueries(target);
  const orthographic = plan.queries.find((query) => query.kind === "orthographic_name");
  const initials = plan.queries.find((query) => query.kind === "initial_name");

  assert.equal(orthographic?.subjectPhrase, "Renee D Angelo Smith");
  assert.equal(orthographic?.derivedFrom, "target_name_orthography");
  assert.equal(initials?.subjectPhrase, "Renée D. Smith");
  assert.equal(initials?.derivedFrom, "target_name_initials");
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
  assert.ok(plan.diagnostics.some((item) => item.code === "query_limit_applied" && item.count === 7));

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

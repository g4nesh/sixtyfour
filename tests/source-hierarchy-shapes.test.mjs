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
const search = await vite.ssrLoadModule("/lib/search/index.ts");
const domain = await vite.ssrLoadModule("/lib/domain/index.ts");

after(async () => {
  await vite.close();
});

function assertClassified(url, sourceType, sourceTier, laneId) {
  const classifiedType = search.deterministicSourceTypeForUrl(url);
  assert.equal(classifiedType, sourceType, url);
  const classifiedTier = search.sourceTierForUrl(url, classifiedType);
  assert.equal(classifiedTier, sourceTier, url);
  assert.equal(search.classifiedFetchLaneId(classifiedType, classifiedTier, true), laneId, url);
}

test("GitHub T2 classification admits only canonical users, repositories, commits, and code blobs", () => {
  const commit = "0123456789abcdef0123456789abcdef01234567";
  for (const [url, sourceType] of [
    ["https://github.com/torvalds", "code_profile"],
    ["https://github.com/torvalds/linux", "code_profile"],
    ["https://github.com/github/docs", "code_profile"],
    [`https://github.com/torvalds/linux/commit/${commit}`, "code_commit"],
    ["https://github.com/torvalds/linux/blob/master/README", "code_profile"],
  ]) {
    assertClassified(url, sourceType, 2, "t2.structured_professional");
  }

  assert.equal(search.githubHandleFromCanonicalProfileUrl("https://github.com/torvalds"), "torvalds");
  assert.equal(search.githubHandleFromCanonicalProfileUrl("https://github.com/torvalds/linux"), null);
  assert.ok(search.sourceLaneById("t0.explicit_url").sourceTypes.includes("code_commit"));
  assert.equal(search.sourceTierForUrl(`https://github.com/torvalds/linux/commit/${commit}`, "code_commit", true), 0);
});

test("GitHub navigation and collaboration routes stay other/T6 even when their host is GitHub", () => {
  for (const url of [
    "https://github.com/topics/artificial-intelligence",
    "https://github.com/search?q=Elon+Musk&type=repositories",
    "https://github.com/issues",
    "https://github.com/pulls",
    "https://github.com/stars",
    "https://github.com/trending",
    "https://github.com/watching",
    "https://github.com/torvalds/linux/issues",
    "https://github.com/torvalds/linux/issues/1",
    "https://github.com/torvalds/linux/pulls",
    "https://github.com/torvalds/linux/actions",
    "https://github.com/torvalds/linux/tree/master",
    "https://github.com/torvalds/linux/commit/not-a-commit",
    "https://gist.github.com/torvalds/0123456789abcdef",
    "https://torvalds.github.io/project",
  ]) {
    assertClassified(url, "other", 6, "t6.candidate_public_source");
    assert.equal(search.sourceTierForUrl(url, "code_profile"), 6, `${url} must not be promoted by a claimed type`);
  }
});

test("LinkedIn professional profiles require the canonical /in/<slug> path", () => {
  for (const url of ["https://www.linkedin.com/in/elon-musk", "https://linkedin.com/in/elon-musk-687b63196/"]) {
    assertClassified(url, "professional_profile", 2, "t2.structured_professional");
  }

  for (const url of [
    "https://www.linkedin.com/jobs/search/?keywords=Elon%20Musk",
    "https://www.linkedin.com/search/results/people/?keywords=Elon%20Musk",
    "https://www.linkedin.com/feed/",
    "https://www.linkedin.com/company/spacex",
    "https://www.linkedin.com/in/elon-musk/details/experience/",
  ]) {
    assertClassified(url, "other", 6, "t6.candidate_public_source");
    assert.equal(
      search.sourceTierForUrl(url, "professional_profile"),
      6,
      `${url} must not be promoted by a claimed type`,
    );
  }
});

test("ResearchGate distinguishes person profiles from publication records by exact path shape", () => {
  assertClassified(
    "https://www.researchgate.net/profile/Example-Researcher-2",
    "professional_profile",
    2,
    "t2.structured_professional",
  );
  assertClassified(
    "https://www.researchgate.net/publication/373262455_Example_Publication",
    "public_document",
    3,
    "t3.institutional",
  );
  assert.equal(
    search.sourceTierForUrl(
      "https://www.researchgate.net/publication/373262455_Example_Publication",
      "professional_profile",
    ),
    3,
    "a claimed profile type cannot promote an exact publication path to T2",
  );

  for (const url of [
    "https://www.researchgate.net/search/publication?q=example",
    "https://www.researchgate.net/profile/Example-Researcher-2/publications",
    "https://www.researchgate.net/jobs",
  ]) {
    assertClassified(url, "other", 6, "t6.candidate_public_source");
  }
});

test("App Store listings remain public metadata without becoming T2 person-identity fetches", () => {
  for (const url of [
    "https://apps.apple.com/us/app/example/id123456789",
    "https://apps.apple.com/app/id123456789?platform=iphone",
  ]) {
    assertClassified(url, "public_document", 3, "t3.institutional");
    assert.equal(
      search.sourceTierForUrl(url, "professional_profile"),
      3,
      "a claimed profile type cannot promote App Store metadata to T2",
    );
  }
  assertClassified("https://apps.apple.com/us/developer/example/id123456789", "other", 6, "t6.candidate_public_source");
});

test("discovery scheduling rejects non-professional title and URL shapes before direct fetch", () => {
  const context = search.sourceTierContextForState(
    { target: domain.parseTarget("Elon Musk"), candidates: [], evidence: [] },
    undefined,
  );
  assert.deepEqual(context.personNames, ["Elon Musk"]);
  for (const [url, title, reason] of [
    ["https://apps.apple.com/us/app/motivation-daily-quotes/id123456789", "Motivation — Daily quotes", "quote_content"],
    ["https://www.gettyimages.com/", "Getty Images", "stock_media"],
    ["https://github.com/topics/elon-musk", "elon-musk · GitHub Topics", "non_professional_navigation"],
    ["https://www.linkedin.com/jobs/search/?keywords=Elon%20Musk", "Elon Musk jobs", "non_professional_navigation"],
    ["https://example.com/resume-templates/elon-musk", "Elon Musk Resume Template", "resume_or_template"],
    ["https://example.com/?Q=Elon+Musk", "Search results", "non_professional_navigation"],
    ["https://brainyquote.com/authors/elon-musk-quotes", "Elon Musk Quotes", "quote_content"],
  ]) {
    assert.deepEqual(search.discoveryLeadSchedulingDecision(url, title, context), {
      disposition: "reject",
      reason,
    });
  }
});

test("discovery scheduling prioritizes bounded person-page shapes without changing source trust", () => {
  const context = { personNames: ["Elon Musk"] };
  for (const [url, title] of [
    ["https://company.example/elon-musk", "Elon Musk | Company"],
    ["https://company.example/about/leadership/elon-musk", "Elon Musk | Company Leadership"],
    ["https://company.example/team", "Elon Musk | Company Leadership"],
  ]) {
    assert.deepEqual(search.discoveryLeadSchedulingDecision(url, title, context), {
      disposition: "prioritize",
      reason: "candidate_bio_path",
    });
    assert.equal(search.deterministicSourceTypeForUrl(url, context), "other");
    assert.equal(search.sourceTierForUrl(url, "other", false, context), 6);
  }

  assert.deepEqual(search.discoveryLeadSchedulingDecision("https://example.com/", "Example", context), {
    disposition: "deprioritize",
    reason: "generic_person_homepage",
  });
  assert.deepEqual(
    search.discoveryLeadSchedulingDecision("https://random.example/articles/elon-musk", "Elon Musk | Company", context),
    { disposition: "neutral", reason: "neutral" },
    "a provider title alone cannot promote an unrelated article path",
  );
  assert.deepEqual(
    search.discoveryLeadSchedulingDecision("https://gist.github.com/example/0123456789abcdef", "Elon Musk", context),
    { disposition: "deprioritize", reason: "non_professional_navigation" },
  );
});

test("discovery scheduling recognizes an exact-title personal-domain profile without fuzzy host matching", () => {
  const context = { personNames: ["Alex Rivera"] };
  const personalProfile = "https://alexrivera.example/profile";

  assert.deepEqual(search.discoveryLeadSchedulingDecision(personalProfile, "Alex Rivera", context), {
    disposition: "prioritize",
    reason: "candidate_bio_path",
  });
  assert.equal(search.deterministicSourceTypeForUrl(personalProfile, context), "other");
  assert.equal(search.sourceTierForUrl(personalProfile, "other", false, context), 6);
  for (const url of ["https://www.alexrivera.com/profile", "https://profile.alexrivera.co.uk/bio"]) {
    assert.deepEqual(search.discoveryLeadSchedulingDecision(url, "Alex Rivera", context), {
      disposition: "prioritize",
      reason: "candidate_bio_path",
    });
  }

  for (const [url, title] of [
    ["https://alexriverajr.example/profile", "Alex Rivera"],
    ["https://notalexrivera.example/profile", "Alex Rivera"],
    ["https://alexrivera.attacker.example/profile", "Alex Rivera"],
    [personalProfile, "Alex Rivera Smith"],
    ["https://alexrivera.example/portfolio", "Alex Rivera"],
  ]) {
    assert.deepEqual(
      search.discoveryLeadSchedulingDecision(url, title, context),
      { disposition: "neutral", reason: "neutral" },
      `${url} — ${title}`,
    );
  }
});

test("page-scoped completed education selects only an exact past credential row", () => {
  const observedAt = "2026-08-25T04:00:00.000Z";
  const positive = "Education BASIS Peoria High School Diploma August 2022 - May 2026";
  assert.equal(domain.extractPageScopedCompletedEducationExcerpt(positive, "BASIS Peoria", observedAt), positive);
  assert.equal(domain.matchPageScopedCompletedEducationRelation(positive, "BASIS Peoria", observedAt), "alumni");

  for (const excerpt of [
    "Education BASIS Peoria High School Diploma August 2022 - Present",
    "Education BASIS Peoria Expected High School Diploma August 2022 - May 2027",
    "Education BASIS Peoria Current student High School Diploma August 2022 - May 2026",
    "Education BASIS Peoria High School senior Diploma August 2022 - May 2026",
    "Education BASIS Peoria 17-year-old High School Diploma August 2022 - May 2026",
    "Education BASIS Peoria Robotics Club team High School Diploma August 2022 - May 2026",
    "Education BASIS Peoria Jordan Lee — High School Diploma August 2022 - May 2026",
    "Education Jordan Lee — BASIS Peoria — High School Diploma August 2022 - May 2026",
    "Education Jordan Lee BASIS Peoria High School Diploma August 2022 - May 2026",
    "Education BASIS Peoria May 2020 - May 2021 High School Diploma Program",
    "Education BASIS Peoria High School Diploma August 2022 - September 2026",
    "Education BASIS Peoria High School Diploma Program August 2022 - May 2026",
    "Education BASIS Peoria Graduate Program August 2022 - May 2026",
    "Education BASIS Peoria Graduate Researcher August 2022 - May 2026",
    "Education BASIS Peoria Alumni Association August 2022 - May 2026",
    "Education BASIS Peoria High School Diploma",
    "BASIS Peoria High School Diploma August 2022 - May 2026",
    "Education BASIS Peoria High School Diploma August 2022 - May 2026 — current student",
    "Education BASIS Peoria High School Diploma August 2022 - May 2026 — expected completion",
    "Education BASIS Peoria High School Diploma August 2022 - May 2026 — Robotics Club team",
    "Education BASIS Peoria High School Diploma August 2022 - May 2026 — Jordan Lee",
    "About I am 17 years old. Education BASIS Peoria High School Diploma August 2022 - May 2026",
    "Born 2008. Education BASIS Peoria High School Diploma August 2022 - May 2026",
    "Current student at BASIS Peoria. Education BASIS Peoria High School Diploma August 2022 - May 2026",
    "Student at BASIS Peoria. Education BASIS Peoria High School Diploma August 2022 - May 2026",
    "Attends BASIS Peoria. Education BASIS Peoria High School Diploma August 2022 - May 2026",
  ]) {
    assert.equal(domain.extractPageScopedCompletedEducationExcerpt(excerpt, "BASIS Peoria", observedAt), null, excerpt);
    assert.equal(domain.matchPageScopedCompletedEducationRelation(excerpt, "BASIS Peoria", observedAt), null, excerpt);
  }
  assert.equal(domain.extractPageScopedCompletedEducationExcerpt(positive, "BASIS Peoria", "invalid"), null);
  assert.equal(domain.extractPageScopedCompletedEducationExcerpt(positive, "BASIS Peoria", "2035"), null);
  const actualShape = "Education Meridian Academy High School Diploma Aug 2020 – May 2024";
  assert.equal(
    domain.extractPageScopedCompletedEducationExcerpt(actualShape, "Meridian Academy", observedAt),
    actualShape,
  );
  assert.equal(
    domain.extractPageScopedCompletedEducationExcerpt(
      `${actualShape} Arizona State University Bachelor of Science August 2024 - Present`,
      "Meridian Academy",
      observedAt,
    ),
    actualShape,
    "a separate adult current-university row does not rewrite completed-school history",
  );
  assert.equal(
    domain.extractPageScopedCompletedEducationExcerpt(
      `${actualShape} Arizona State University — Student at the School of Computing`,
      "Meridian Academy",
      observedAt,
    ),
    actualShape,
    "a separate adult university student row is not bound to the requested completed-school context",
  );
  assert.equal(
    domain.extractPageScopedCompletedEducationExcerpt(
      `${actualShape} Cumulative GPA: 4.7/5.0 Experience Research Fellow`,
      "Meridian Academy",
      observedAt,
    ),
    actualShape,
    "a benign education metric before the next section is not mistaken for another person",
  );
  const concreteAdapterShape =
    "Education BASIS Peoria High School Diploma Aug 2022 – May 2026 Cumulative GPA: 4.7/5.0 15 APs, 1510 SAT Attended the top-ranked public hackathon (U.S. News 2024) National Merit Scholarship Commended Scholar AP Scholar with Distinction and public research awards";
  assert.equal(
    domain.extractPageScopedCompletedEducationExcerpt(concreteAdapterShape, "Basis Peoria", observedAt),
    "Education BASIS Peoria High School Diploma Aug 2022 – May 2026",
    "benign education metrics and an attended-event sentence cannot resemble another person",
  );
});

test("exact fetched person-bio paths require an exact title, terminal slug, and non-document route marker", () => {
  const context = { personNames: ["Alex Rivera"] };

  for (const url of [
    "https://registry.example/profile/alex-rivera",
    "https://biographies.example/business-leaders/alex-rivera",
    "https://directory.example/our%20leadership/alex-rivera",
  ]) {
    assert.equal(search.exactFetchedPersonBioPath(url, "Alex Rivera", context), true, url);
    assert.equal(search.deterministicSourceTypeForUrl(url, context), "other", url);
    assert.equal(search.sourceTierForUrl(url, "other", false, context), 6, url);
  }

  assert.equal(
    search.exactFetchedPersonBioPath(
      "https://biographies.example/business-leaders/alex-rivera",
      "Alex Rivera: Biography, Entrepreneur and Founder",
      context,
    ),
    true,
    "an exact-name title prefix needs an explicit professional suffix marker",
  );

  for (const [url, title] of [
    ["https://registry.example/profile/alex-rivera", "Morgan Lee"],
    ["https://registry.example/profile/morgan-lee", "Alex Rivera"],
    ["https://registry.example/profile/alex-rivera", "Alex Rivera Says Markets Are Changing"],
    ["https://registry.example/profile/alex-rivera", "Alex Rivera: Markets Are Changing"],
    ["https://registry.example/profile/alex-rivera", "Alex Rivera-Smith: Biography and Founder"],
    ["https://gazette.example/articles/alex-rivera", "Alex Rivera"],
    ["https://gazette.example/articles/alex-rivera", "Alex Rivera: Biography and Founder"],
    ["https://gazette.example/articles/profile/alex-rivera", "Alex Rivera"],
    ["https://directory.example/search-results/profile/alex-rivera", "Alex Rivera"],
    ["https://registry.example/profile/alex-rivera/details", "Alex Rivera"],
  ]) {
    assert.equal(search.exactFetchedPersonBioPath(url, title, context), false, `${url} — ${title}`);
  }

  assert.deepEqual(
    search.discoveryLeadSchedulingDecision(
      "https://biographies.example/business-leaders/alex-rivera",
      "Alex Rivera | Biographies",
      context,
    ),
    { disposition: "prioritize", reason: "candidate_bio_path" },
    "hyphenated route markers are tokenized for bounded discovery scheduling",
  );
  assert.deepEqual(
    search.discoveryLeadSchedulingDecision(
      "https://registry.example/directory/taylor-leader",
      "Taylor Leader | Registry",
      { personNames: ["Taylor Leader"] },
    ),
    { disposition: "neutral", reason: "neutral" },
    "a marker-looking token inside the person's terminal slug is not a profile-route marker",
  );
});

test("structured records resist noisy titles and regulatory queries map only to T3", () => {
  assert.deepEqual(
    search.discoveryLeadSchedulingDecision("https://github.com/example/quotes", "Daily quotes", {
      personNames: ["Elon Musk"],
    }),
    { disposition: "neutral", reason: "neutral" },
    "an exact repository shape must not be rejected merely because untrusted title text says quotes",
  );
  assert.deepEqual(
    search.discoveryLeadSchedulingDecision(
      "https://www.reuters.com/world/elon-musk-comments-2026-08-21/",
      "Elon Musk quotes company leadership",
      { personNames: ["Elon Musk"] },
    ),
    { disposition: "neutral", reason: "neutral" },
    "reputable reporting must not be mistaken for a quote widget",
  );

  const target = domain.parseTarget("Elon Musk");
  const regulatory = search.compileOsintQueries(target).queries.filter((query) => query.kind === "regulatory_filing");
  assert.equal(regulatory.length, 1);
  const t3 = search.compiledQueriesForLane(target, search.sourceLaneById("t3.institutional"));
  assert.deepEqual(
    t3.filter((query) => query.kind === "regulatory_filing").map((query) => query.id),
    regulatory.map((query) => query.id),
  );
  for (const laneId of ["t1.first_party", "t2.structured_professional", "t6.general_discovery"]) {
    assert.equal(
      search
        .compiledQueriesForLane(target, search.sourceLaneById(laneId))
        .some((query) => query.kind === "regulatory_filing"),
      false,
      laneId,
    );
  }
});

test("scholarly aggregators require exact canonical author and work record routes", () => {
  for (const url of [
    "https://orcid.org/0000-0002-1825-0097",
    "https://www.semanticscholar.org/author/Example-Person/123456",
    "https://api.semanticscholar.org/graph/v1/author/123456",
    "https://openalex.org/A123456789",
    "https://api.openalex.org/authors/A123456789",
    "https://openreview.net/profile?id=~Example_Person1",
  ]) {
    assertClassified(url, "professional_profile", 2, "t2.structured_professional");
  }
  const explicitOrcid = "https://orcid.org/0000-0002-1825-0097";
  const explicitOrcidType = search.deterministicSourceTypeForUrl(explicitOrcid);
  assert.ok(search.sourceLaneById("t0.explicit_url").sourceTypes.includes("professional_profile"));
  assert.equal(search.sourceTierForUrl(explicitOrcid, explicitOrcidType, true), 0);
  assert.equal(search.classifiedFetchLaneId(explicitOrcidType, 0, false), "t0.explicit_url");
  assertClassified(
    "https://scholar.google.com/citations?user=abcD_123&hl=en",
    "public_document",
    2,
    "t2.structured_professional",
  );

  for (const url of [
    "https://www.semanticscholar.org/paper/Example-Paper/0123456789abcdef0123456789abcdef01234567",
    "https://api.semanticscholar.org/graph/v1/paper/0123456789abcdef0123456789abcdef01234567",
    "https://openalex.org/W123456789",
    "https://api.openalex.org/works/W123456789",
    "https://openreview.net/forum?id=abcD_123",
    "https://openreview.net/pdf?id=abcD_123",
    "https://api.crossref.org/works/10.5555%2Fatlas.2026.2",
    "https://doi.org/10.5555/atlas.2026.2",
  ]) {
    assertClassified(url, "public_document", 3, "t3.institutional");
  }
});

test("scholarly home, search, and navigation routes cannot inherit host-wide T2", () => {
  for (const url of [
    "https://orcid.org/",
    "https://orcid.org/0000-0002-1825-0098",
    "https://orcid.org/0000-0002-1825-0097/works",
    "https://orcid.org/orcid-search/search?searchQuery=Example",
    "https://scholar.google.com/scholar?q=Example",
    "https://scholar.google.com/citations?user=abcD_123&view_op=list_works",
    "https://www.semanticscholar.org/",
    "https://www.semanticscholar.org/search?q=Example",
    "https://www.semanticscholar.org/author/Example-Person/not-numeric",
    "https://www.semanticscholar.org/author/Example-Person/123456/papers",
    "https://www.semanticscholar.org/paper/Example-Paper/0123456789abcdef/references",
    "https://api.semanticscholar.org/author/123456",
    "https://api.semanticscholar.org/graph/v1/author/search?query=Example",
    "https://provider.semanticscholar.org/author/123456",
    "https://openalex.org/",
    "https://openalex.org/authors",
    "https://openalex.org/A123456789/works",
    "https://api.openalex.org/A123456789",
    "https://api.openalex.org/authors?search=Example",
    "https://provider.openalex.org/A123456789",
    "https://openreview.net/",
    "https://openreview.net/search?term=Example",
    "https://openreview.net/group?id=Example.cc",
    "https://openreview.net/profile?id=~Example_Person1&sort=asc",
    "https://openreview.net/profile?id=~Example_Person1&id=~Another_Person1",
    "https://api2.openreview.net/notes?content.authorids=Example",
    "https://api2.openreview.net/profile?id=~Example_Person1",
    "https://www.crossref.org/",
    "https://search.crossref.org/?q=Example",
    "https://api.crossref.org/works?query.author=Example",
    "https://api.crossref.org/funders/10.5555",
    "https://doi.org/",
  ]) {
    assertClassified(url, "other", 6, "t6.candidate_public_source");
    assert.equal(search.sourceTierForUrl(url, "professional_profile"), 6, url);
    assert.equal(search.sourceTierForUrl(url, "public_document"), 6, url);
    assert.equal(search.sourceTierForUrl(url, "other", true), 0, `${url} remains T0 when explicitly supplied`);
  }
});

test("institutional profile scheduling requires exact subject plus matching host context", () => {
  const context = { personNames: ["Chinmay Bhat"], organizationNames: ["Arizona State University"] };
  const url = "https://search.asu.edu/profile/chinmay-bhat";
  assert.deepEqual(search.discoveryLeadSchedulingDecision(url, "Chinmay Bhat | Arizona State University", context), {
    disposition: "prioritize",
    reason: "candidate_bio_path",
  });
  assert.deepEqual(search.discoveryLeadSchedulingDecision(url, "Chinmay Bhat | ASU Search", context), {
    disposition: "prioritize",
    reason: "candidate_bio_path",
  });
  assert.deepEqual(search.discoveryLeadSchedulingDecision(url, "Chinmay Bhat | University of Florida", context), {
    disposition: "neutral",
    reason: "neutral",
  });
  assert.deepEqual(
    search.discoveryLeadSchedulingDecision(url, "Chinmay Bhat | ASU Search", {
      personNames: ["Chinmay Bhat"],
      organizationNames: ["University of Florida"],
    }),
    { disposition: "neutral", reason: "neutral" },
  );
  assert.deepEqual(search.discoveryLeadSchedulingDecision(url, "Another Person | ASU Search", context), {
    disposition: "neutral",
    reason: "neutral",
  });
  assert.deepEqual(
    search.discoveryLeadSchedulingDecision(
      "https://profiles.berkeley.edu/ashwin-rokkam",
      "Ashwin Rokkam | UC Berkeley",
      { personNames: ["Ashwin Rokkam"], organizationNames: ["UC Berkeley"] },
    ),
    { disposition: "prioritize", reason: "candidate_bio_path" },
  );
  assert.deepEqual(
    search.discoveryLeadSchedulingDecision(
      "https://unrelated.example/profile/chinmay-bhat",
      "Chinmay Bhat | Arizona State University",
      context,
    ),
    { disposition: "neutral", reason: "neutral" },
  );
  assert.equal(search.deterministicSourceTypeForUrl(url, context), "public_document");
  assert.equal(search.sourceTierForUrl(url, "public_document", false, context), 3);
});

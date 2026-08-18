import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { InvestigationEngine } from "../lib/agent/engine.ts";
import {
  buildInvestigationReport,
  requestedCategoriesForInput,
  resolveIdentity,
  summarizeCoverage,
} from "../lib/domain/report.ts";
import { evaluateStop } from "../lib/domain/stopping.ts";
import {
  cloneJson,
  createDeterministicIdFactory,
  createSequenceClock,
} from "../lib/domain/runtime.ts";
import type {
  EvidenceDraft,
  InvestigationInput,
  InvestigationReport,
  JsonObject,
  ResearchPhase,
} from "../lib/domain/types.ts";
import {
  VERIFIED_CAPTURED_AT,
  VERIFIED_GITHUB_STRONGEST_SHA,
  applyVerifiedCaptureMetadata,
  assertVerifiedEvidenceContract,
  verifiedApiEvidence,
  verifiedDirectEvidence,
} from "./capture-contract.ts";

import linusInputJson from "../examples/linus-codegraph/input.json" with { type: "json" };
import chrisInputJson from "../examples/chris-anderson-ted/input.json" with { type: "json" };
import pythonInputJson from "../examples/python-creator/input.json" with { type: "json" };
import linusCassetteJson from "../examples/linus-codegraph/cassette.json" with { type: "json" };
import chrisCassetteJson from "../examples/chris-anderson-ted/cassette.json" with { type: "json" };
import pythonCassetteJson from "../examples/python-creator/cassette.json" with { type: "json" };
import linusManifestJson from "../examples/linus-codegraph/manifest.json" with { type: "json" };
import chrisManifestJson from "../examples/chris-anderson-ted/manifest.json" with { type: "json" };
import pythonManifestJson from "../examples/python-creator/manifest.json" with { type: "json" };

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const capturedAt = VERIFIED_CAPTURED_AT;

interface GeneratedExample {
  id: string;
  report: InvestigationReport;
  trace: JsonObject[];
}

function input(value: unknown): InvestigationInput {
  return cloneJson(value) as InvestigationInput;
}

function advance(
  engine: InvestigationEngine,
  phase: Exclude<ResearchPhase, "intake" | "terminal">,
  decisionSummary: string,
): void {
  engine.transition(phase);
  engine.trace.record("decision", {
    phase,
    payload: {
      decisionSummary,
      decisionProvenance: "scripted_local_policy",
      provider: null,
    },
    usage: { unavailableReason: "scripted_replay_no_provider" },
  });
}

function recordCapturedTool(
  engine: InvestigationEngine,
  tool: string,
  requestFingerprint: string,
  options: {
    status?: "succeeded" | "partial";
    networkRequests?: number;
    bytesRead?: number | null;
    payload?: JsonObject;
    search?: boolean;
  } = {},
): void {
  const networkRequests = options.networkRequests ?? 1;
  const spanId = engine.trace.startSpan({
    name: `tool.${tool}`,
    phase: engine.phase,
    payload: {
      requestFingerprint,
      replayNetwork: "forbidden",
      captureProvenance: "source_verified_scripted_reconstruction",
    },
    usage: { unavailableReason: "captured_request_start" },
  });
  engine.recordToolCall(networkRequests, options.search ?? false);
  engine.trace.endSpan(spanId, {
    status: options.status ?? "succeeded",
    payload: {
      ...(options.payload ?? {}),
      responseBodyRetained: false,
    },
    usage: {
      networkRequests,
      ...(typeof options.bytesRead === "number" ? { bytesRead: options.bytesRead } : {}),
      unavailableReason: "provider_tokens_not_applicable",
    },
  });
}

function admit(engine: InvestigationEngine, draft: EvidenceDraft): string {
  const result = engine.admitEvidence(draft);
  if (!result.admitted || !result.evidence) {
    throw new Error(`example evidence was rejected: ${result.reason}`);
  }
  return result.evidence.id;
}

function finish(
  id: string,
  engine: InvestigationEngine,
  detail: string,
): GeneratedExample {
  advance(engine, "report", "Compiled only referentially valid findings and explicit limitations into the versioned report.");
  const stop = evaluateStop(engine.snapshot());
  if (!stop.allowed || stop.reason !== "goal_satisfied") {
    const state = engine.snapshot();
    throw new Error(
      `example ${id} is not legally complete: ${stop.detail}; identity=${JSON.stringify(resolveIdentity(state.candidates))}; coverage=${JSON.stringify(summarizeCoverage(state, requestedCategoriesForInput(state.input)))}`,
    );
  }
  engine.stopDecision({ ...stop, detail });
  engine.assertIntegrity();
  const report = buildInvestigationReport(engine.snapshot(), engine.clock);
  engine.trace.record("result.terminal", {
    phase: "terminal",
    payload: {
      status: report.status,
      stopReason: report.stop.reason,
      report: cloneJson(report) as unknown as JsonObject,
    },
    usage: { unavailableReason: "scripted_replay_no_provider" },
  });
  engine.trace.assertBalanced();
  return {
    id,
    report,
    trace: engine.trace.snapshot() as unknown as JsonObject[],
  };
}

function buildLinus(): GeneratedExample {
  const clock = createSequenceClock(capturedAt, 7);
  const ids = createDeterministicIdFactory("linus_replay");
  const engine = new InvestigationEngine(input(linusInputJson), { clock, ids }, {
    runId: "replay-linus-codegraph-v1",
  });

  advance(engine, "classify", "The query contains one exact user-supplied email and is limited to public professional correlation.");
  advance(engine, "plan", "Use direct Linux documentation as the non-Git anchor, then run the bounded exact-email codegraph and inspect its strongest commit.");
  advance(engine, "discover", "Fetch direct sources before admitting any claim; treat provider/search summaries as discovery-only.");

  const candidate = engine.addCandidate({
    displayName: "Linus Torvalds",
    signals: [
      {
        kind: "email",
        value: "torvalds@linux-foundation.org",
        normalizedValue: "torvalds@linux-foundation.org",
        strength: "strong",
        assurance: "self_asserted",
      },
    ],
  }).candidate;

  recordCapturedTool(
    engine,
    "fetch_public_source",
    "GET https://github.com/torvalds/linux/blob/master/Documentation/process/submitting-patches.rst accept:text/html",
  );
  recordCapturedTool(
    engine,
    "fetch_public_source",
    "GET https://www.linuxfoundation.org/about/leadership accept:text/html",
  );
  recordCapturedTool(
    engine,
    "github_email_codegraph",
    "GET https://api.github.com/search/commits?q=repo%3Atorvalds%2Flinux+author-email%3Atorvalds%40linux-foundation.org+is%3Apublic&sort=committer-date&order=desc&per_page=3 accept:application/vnd.github+json",
    {
      networkRequests: 2,
      search: true,
      payload: {
        returnedCommits: 3,
        totalCountReported: 29714,
        incompleteResults: false,
        strongestCommitSha: VERIFIED_GITHUB_STRONGEST_SHA,
        strongestCommitSignature: "unsigned",
      },
    },
  );
  recordCapturedTool(
    engine,
    "keybase_identity_proofs",
    "GET https://keybase.io/_/api/1.0/user/lookup.json?github=torvalds&fields=basics%2Cproofs_summary%2Cremote_key_proofs accept:application/json",
    {
      status: "partial",
      payload: {
        providerStatus: "OK",
        linkedUsernameObserved: false,
        verifiedGithubProofs: 0,
        admittedIdentityEvidence: 0,
      },
    },
  );

  advance(engine, "separate_candidates", "The exact email, public Linux documentation, and linked GitHub login form one candidate; Git metadata remains a spoofable signal, not a merge authority.");
  advance(engine, "corroborate", "Admit minimal direct-source records and require the Linux Foundation source before allowing high-confidence identity findings.");

  const linuxDoc = admit(engine, verifiedDirectEvidence("req-linux-doc", 0, {
    candidateId: candidate.id,
    sourceUrl: "https://github.com/torvalds/linux/blob/master/Documentation/process/submitting-patches.rst",
    queryUrl: null,
    sourceType: "public_document",
    title: "Submitting patches: the essential guide",
    publisher: "Linux kernel project",
    sourceFamily: "github.com",
    observedAt: capturedAt,
    httpStatus: 200,
    temporalStatus: "current",
    reliability: 1,
    spoofable: false,
  }));
  const foundation = admit(engine, verifiedDirectEvidence("req-linux-foundation", 0, {
    candidateId: candidate.id,
    sourceUrl: "https://www.linuxfoundation.org/about/leadership",
    queryUrl: null,
    sourceType: "official_profile",
    title: "Linux Foundation leadership",
    publisher: "Linux Foundation",
    sourceFamily: "linuxfoundation.org",
    observedAt: capturedAt,
    httpStatus: 200,
    temporalStatus: "current",
    reliability: 1,
    spoofable: false,
  }));
  const commit = admit(engine, verifiedApiEvidence("req-github-commit", {
    candidateId: candidate.id,
    sourceUrl: `https://github.com/torvalds/linux/commit/${VERIFIED_GITHUB_STRONGEST_SHA}`,
    queryUrl: `https://api.github.com/repos/torvalds/linux/commits/${VERIFIED_GITHUB_STRONGEST_SHA}`,
    sourceType: "code_commit",
    title: "Public commit metadata in torvalds/linux",
    publisher: "GitHub",
    sourceFamily: "github.com",
    publishedAt: "2026-08-18T21:13:43.000Z",
    observedAt: capturedAt,
    httpStatus: 200,
    temporalStatus: "current",
    reliability: 1,
    spoofable: true,
    attributes: {
      sha: VERIFIED_GITHUB_STRONGEST_SHA,
      repository: "torvalds/linux",
      login: "torvalds",
      signature: "unsigned",
    },
  }));

  engine.addCandidateSignals(candidate.id, [
    {
      kind: "name",
      value: "Linus Torvalds",
      normalizedValue: "linus torvalds",
      strength: "strong",
      assurance: "verified",
      sourceEvidenceId: foundation,
      sourceFamily: "linuxfoundation.org",
    },
    {
      kind: "profile_url",
      value: "https://www.linuxfoundation.org/about/leadership",
      normalizedValue: "https://www.linuxfoundation.org/about/leadership",
      strength: "strong",
      assurance: "corroborated",
      sourceEvidenceId: foundation,
      sourceFamily: "linuxfoundation.org",
    },
    {
      kind: "cross_profile_link",
      value: "Linux guide exact-email association",
      normalizedValue: "linux guide exact email association",
      strength: "strong",
      assurance: "corroborated",
      sourceEvidenceId: linuxDoc,
      sourceFamily: "github.com",
    },
    {
      kind: "github_commit_email",
      value: "torvalds@linux-foundation.org",
      normalizedValue: "torvalds@linux-foundation.org",
      strength: "strong",
      assurance: "spoofable",
      sourceEvidenceId: commit,
      sourceFamily: "github.com",
    },
    {
      kind: "social_handle",
      value: "torvalds",
      normalizedValue: "torvalds",
      strength: "medium",
      assurance: "spoofable",
      sourceEvidenceId: commit,
      sourceFamily: "github.com",
    },
  ]);

  advance(engine, "calibrate", "The non-Git Linux Foundation anchor lifts the resolved candidate beyond the spoofable-only cap; the Git-specific finding retains its caveat.");
  engine.addFinding({
    candidateId: candidate.id,
    title: "Exact email resolves to Linus Torvalds in the bounded public record",
    description: "Two independent source families identify Linus Torvalds: the Linux guide publishes the exact supplied email, and the Linux Foundation names him as a Fellow.",
    category: "identity",
    evidenceIds: [linuxDoc, foundation],
    counterEvidenceIds: [],
  });
  engine.addFinding({
    candidateId: candidate.id,
    title: "Public GitHub codegraph links the email to @torvalds",
    description: "GitHub's commit API returned an immutable commit in torvalds/linux, linked it to @torvalds with an exact author-email match, and reported it unsigned.",
    category: "online_presence",
    evidenceIds: [commit],
    counterEvidenceIds: [],
    caveats: [
      "Git author metadata can be spoofed.",
      "The inspected strongest commit was unsigned.",
      "The bounded search describes indexed public default branches, not all Git activity.",
    ],
  });
  return finish(
    "linus-codegraph",
    engine,
    "Resolved the professional identity with auditable findings, an independent non-Git anchor, and explicit Git metadata limitations.",
  );
}

function buildChris(): GeneratedExample {
  const clock = createSequenceClock(capturedAt, 7);
  const ids = createDeterministicIdFactory("chris_replay");
  const engine = new InvestigationEngine(input(chrisInputJson), { clock, ids }, {
    runId: "replay-chris-anderson-ted-v1",
  });

  advance(engine, "classify", "The query provides a person's name plus TED as an organization constraint.");
  advance(engine, "plan", "Fetch the TED-constrained profile and actively search for same-name professional candidates before selection.");
  advance(engine, "discover", "Direct profiles reveal two public professionals named Chris Anderson and require explicit separation.");

  const selected = engine.addCandidate({ displayName: "Chris Anderson" }).candidate;
  const decoy = engine.addCandidate({ displayName: "Chris Anderson" }).candidate;

  recordCapturedTool(
    engine,
    "fetch_public_source",
    "GET https://www.ted.com/speakers/chris_anderson_ted accept:text/html",
  );
  recordCapturedTool(
    engine,
    "fetch_public_source",
    "GET https://www.ted.com/speakers/chris_anderson_wired accept:text/html",
  );
  recordCapturedTool(
    engine,
    "fetch_public_source",
    "GET https://www.wired.com/story/airware-drones/ accept:text/html",
  );

  advance(engine, "separate_candidates", "Name equality is weak evidence: the TED leader and the former WIRED editor/3DR executive remain separate candidates with separate ledgers.");
  advance(engine, "corroborate", "Admit the direct TED and WIRED records to their own candidate IDs and preserve the organization conflict.");

  const tedProfile = admit(engine, verifiedDirectEvidence("req-ted-selected", 0, {
    candidateId: selected.id,
    sourceUrl: "https://www.ted.com/speakers/chris_anderson_ted",
    queryUrl: null,
    sourceType: "official_profile",
    title: "Chris Anderson — TED speaker profile",
    publisher: "TED",
    sourceFamily: "ted.com",
    observedAt: capturedAt,
    httpStatus: 200,
    temporalStatus: "current",
    reliability: 1,
    spoofable: false,
    attributes: { organization: "TED", role: "Chairman, TED" },
  }));
  const tedEmployment = admit(engine, verifiedDirectEvidence("req-ted-selected", 1, {
    candidateId: selected.id,
    sourceUrl: "https://www.ted.com/speakers/chris_anderson_ted",
    queryUrl: null,
    sourceType: "official_profile",
    title: "Chris Anderson — TED leadership",
    publisher: "TED",
    sourceFamily: "ted.com",
    observedAt: capturedAt,
    httpStatus: 200,
    temporalStatus: "current",
    reliability: 1,
    spoofable: false,
  }));
  const tedDecoy = admit(engine, verifiedDirectEvidence("req-ted-decoy", 0, {
    candidateId: decoy.id,
    disposition: "supports",
    sourceUrl: "https://www.ted.com/speakers/chris_anderson_wired",
    queryUrl: null,
    sourceType: "official_profile",
    title: "Chris Anderson — separate TED speaker profile",
    publisher: "TED",
    sourceFamily: "ted.com",
    observedAt: capturedAt,
    httpStatus: 200,
    temporalStatus: "current",
    reliability: 1,
    spoofable: false,
  }));
  const wiredDecoy = admit(engine, verifiedDirectEvidence("req-wired-decoy", 0, {
    candidateId: decoy.id,
    sourceUrl: "https://www.wired.com/story/airware-drones/",
    queryUrl: null,
    sourceType: "news",
    title: "Airware drones",
    publisher: "WIRED",
    sourceFamily: "wired.com",
    observedAt: capturedAt,
    httpStatus: 200,
    temporalStatus: "historical",
    reliability: 0.9,
    spoofable: false,
  }));

  engine.addCandidateSignals(selected.id, [
    {
      kind: "name",
      value: "Chris Anderson",
      normalizedValue: "chris anderson",
      strength: "strong",
      assurance: "verified",
      sourceEvidenceId: tedProfile,
    },
    {
      kind: "organization",
      value: "TED",
      normalizedValue: "ted",
      strength: "strong",
      assurance: "verified",
      sourceEvidenceId: tedProfile,
      sourceFamily: "ted.com",
    },
    {
      kind: "role",
      value: "Chairman, TED",
      normalizedValue: "chairman ted",
      strength: "strong",
      assurance: "verified",
      sourceEvidenceId: tedProfile,
      sourceFamily: "ted.com",
    },
    {
      kind: "profile_url",
      value: "https://www.ted.com/speakers/chris_anderson_ted",
      normalizedValue: "https://www.ted.com/speakers/chris_anderson_ted",
      strength: "strong",
      assurance: "verified",
      sourceEvidenceId: tedProfile,
      sourceFamily: "ted.com",
    },
    {
      kind: "cross_profile_link",
      value: "Chris Anderson at TED",
      normalizedValue: "chris anderson at ted",
      strength: "strong",
      assurance: "corroborated",
      sourceEvidenceId: tedProfile,
    },
    {
      kind: "bio_phrase",
      value: "became the curator of the TED Conference in 2002",
      normalizedValue: "became the curator of the ted conference in 2002",
      strength: "weak",
      assurance: "verified",
      sourceEvidenceId: tedEmployment,
    },
  ]);
  engine.addCandidateSignals(decoy.id, [
    {
      kind: "name",
      value: "Chris Anderson",
      normalizedValue: "chris anderson",
      strength: "strong",
      assurance: "verified",
      sourceEvidenceId: tedDecoy,
      sourceFamily: "ted.com",
    },
    {
      kind: "organization",
      value: "3D Robotics",
      normalizedValue: "3d robotics",
      strength: "strong",
      assurance: "corroborated",
      sourceEvidenceId: wiredDecoy,
      sourceFamily: "wired.com",
    },
    {
      kind: "conflict",
      value: "TED profile explicitly says this is not the conference curator",
      normalizedValue: "not ted curator",
      strength: "strong",
      assurance: "verified",
      sourceEvidenceId: tedDecoy,
      sourceFamily: "ted.com",
    },
    {
      kind: "profile_url",
      value: "https://www.ted.com/speakers/chris_anderson_wired",
      normalizedValue: "https://www.ted.com/speakers/chris_anderson_wired",
      strength: "strong",
      assurance: "verified",
      sourceEvidenceId: tedDecoy,
      sourceFamily: "ted.com",
    },
  ]);

  advance(engine, "calibrate", "The TED-constrained profile supplies a unique strong anchor and clear runner-up margin; decoy evidence is quarantined rather than cited across candidates.");
  engine.addFinding({
    candidateId: selected.id,
    title: "The TED-constrained identity is Chris Anderson, Chairman, TED",
    description: "TED's direct profile exactly names Chris Anderson as Chairman, TED and supplies a candidate-specific official profile URL.",
    category: "identity",
    evidenceIds: [tedProfile],
    counterEvidenceIds: [],
    caveats: ["This finding relies on a genuinely unique official profile anchor rather than two source families."],
  });
  engine.addFinding({
    candidateId: selected.id,
    title: "TED records his conference leadership from 2002",
    description: "The official profile says Anderson became curator of the TED Conference in 2002 and currently labels him Chairman, TED.",
    category: "employment",
    evidenceIds: [tedEmployment],
    counterEvidenceIds: [],
  });
  return finish(
    "chris-anderson-ted",
    engine,
    "Resolved the TED-constrained candidate with a unique official anchor and preserved the same-name decoy as a separate rejected candidate.",
  );
}

function buildPython(): GeneratedExample {
  const clock = createSequenceClock(capturedAt, 7);
  const ids = createDeterministicIdFactory("python_replay");
  const engine = new InvestigationEngine(input(pythonInputJson), { clock, ids }, {
    runId: "replay-python-creator-v1",
  });

  advance(engine, "classify", "The query is a role-only public figure request: resolve the creator of Python without assuming a name.");
  advance(engine, "plan", "Use the official Python site and the candidate's public biography as independent direct sources.");
  advance(engine, "discover", "Both direct sources name the same person and describe the same unique creator role.");

  const candidate = engine.addCandidate({ displayName: "Guido van Rossum" }).candidate;
  recordCapturedTool(
    engine,
    "fetch_public_source",
    "GET https://www.python.org/doc/essays/foreword/ accept:text/html",
  );
  recordCapturedTool(
    engine,
    "fetch_public_source",
    "GET https://gvanrossum.github.io/bio accept:text/html",
  );

  advance(engine, "separate_candidates", "The role phrase remains a clue until two direct sources converge on the same named candidate and unique personal domain.");
  advance(engine, "corroborate", "Admit the official ecosystem foreword and the candidate's public biography as two independent source families.");

  const pythonForeword = admit(engine, verifiedDirectEvidence("req-python-foreword", 0, {
    candidateId: candidate.id,
    sourceUrl: "https://www.python.org/doc/essays/foreword/",
    queryUrl: null,
    sourceType: "public_document",
    title: "Foreword for Programming Python",
    publisher: "Python Software Foundation",
    sourceFamily: "python.org",
    observedAt: capturedAt,
    httpStatus: 200,
    temporalStatus: "historical",
    reliability: 1,
    spoofable: false,
  }));
  const publicBio = admit(engine, verifiedDirectEvidence("req-guido-bio", 0, {
    candidateId: candidate.id,
    sourceUrl: "https://gvanrossum.github.io/bio",
    queryUrl: null,
    sourceType: "official_profile",
    title: "Guido van Rossum — brief bio",
    publisher: "Guido van Rossum",
    sourceFamily: "github.io",
    observedAt: capturedAt,
    httpStatus: 200,
    temporalStatus: "current",
    reliability: 1,
    spoofable: false,
  }));

  engine.addCandidateSignals(candidate.id, [
    {
      kind: "name",
      value: "Guido van Rossum",
      normalizedValue: "guido van rossum",
      strength: "strong",
      assurance: "verified",
      sourceEvidenceId: publicBio,
      sourceFamily: "github.io",
    },
    {
      kind: "role",
      value: "Creator of Python",
      normalizedValue: "creator of python",
      strength: "strong",
      assurance: "corroborated",
      sourceEvidenceId: pythonForeword,
      sourceFamily: "python.org",
    },
    {
      kind: "cross_profile_link",
      value: "Python creator",
      normalizedValue: "python creator",
      strength: "strong",
      assurance: "corroborated",
      sourceEvidenceId: pythonForeword,
      sourceFamily: "python.org",
    },
    {
      kind: "profile_url",
      value: "https://gvanrossum.github.io/bio",
      normalizedValue: "https://gvanrossum.github.io/bio",
      strength: "strong",
      assurance: "verified",
      sourceEvidenceId: publicBio,
      sourceFamily: "github.io",
    },
    {
      kind: "personal_domain",
      value: "gvanrossum.github.io",
      normalizedValue: "gvanrossum.github.io",
      strength: "strong",
      assurance: "corroborated",
      sourceEvidenceId: publicBio,
    },
  ]);

  advance(engine, "calibrate", "Two independent direct source families support the same unique creator role with no hard conflict.");
  engine.addFinding({
    candidateId: candidate.id,
    title: "The creator of Python resolves to Guido van Rossum",
    description: "The official Python site and van Rossum's public biography independently identify him as Python's creator.",
    category: "identity",
    evidenceIds: [publicBio],
    counterEvidenceIds: [],
  });
  engine.addFinding({
    candidateId: candidate.id,
    title: "Van Rossum created the Python programming language",
    description: "His public biography states that he created Python in 1990, while the official Python foreword independently describes his creator role.",
    category: "project",
    evidenceIds: [pythonForeword],
    counterEvidenceIds: [],
  });
  return finish(
    "python-creator",
    engine,
    "Resolved the role-only query with two independent direct source families and no competing candidate above the ambiguity threshold.",
  );
}

async function writeExample(example: GeneratedExample): Promise<void> {
  const directory = resolve(repositoryRoot, "examples", example.id);
  const cassetteTemplates: Record<string, JsonObject> = {
    "linus-codegraph": linusCassetteJson as unknown as JsonObject,
    "chris-anderson-ted": chrisCassetteJson as unknown as JsonObject,
    "python-creator": pythonCassetteJson as unknown as JsonObject,
  };
  const manifestTemplates: Record<string, JsonObject> = {
    "linus-codegraph": linusManifestJson as unknown as JsonObject,
    "chris-anderson-ted": chrisManifestJson as unknown as JsonObject,
    "python-creator": pythonManifestJson as unknown as JsonObject,
  };
  const descriptions: Record<string, string> = {
    "linus-codegraph": "A scripted reconstruction from source-verified public captures that connects an exact user-supplied email to Linux documentation and bounded GitHub commit metadata while preserving the spoofable-metadata confidence cap.",
    "chris-anderson-ted": "A scripted reconstruction from source-verified public captures that selects the TED leader and explicitly quarantines the former WIRED editor and 3DR executive as a different Chris Anderson.",
    "python-creator": "A scripted reconstruction from source-verified public captures that resolves a role description to Guido van Rossum using the official Python site and his public biography.",
  };
  assertVerifiedEvidenceContract(example.report.evidence);
  const cassette = cloneJson(cassetteTemplates[example.id]);
  cassette.cassetteVersion = 2;
  applyVerifiedCaptureMetadata(cassette);
  for (const request of cassette.requests as JsonObject[]) {
    const response = request.response as JsonObject;
    response.evidenceBindings = example.report.evidence
      .filter((evidence) => evidence.toolCallId === request.id)
      .map((evidence) => ({
        evidenceId: evidence.id,
        candidateId: evidence.candidateId,
        sourceUrl: evidence.sourceUrl,
        normalizedClaim: evidence.normalizedClaim,
        excerpt: evidence.excerpt,
        canonicalSubset: evidence.canonicalSubset,
      }));
  }
  const manifest = cloneJson(manifestTemplates[example.id]);
  manifest.description = descriptions[example.id];
  manifest.capturedAt = capturedAt;
  manifest.captureMode = "source_verified_scripted_reconstruction";
  manifest.decisionProvenance = "scripted_local_policy";
  manifest.provider = null;
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(resolve(directory, "cassette.json"), `${JSON.stringify(cassette, null, 2)}\n`, "utf8"),
    writeFile(resolve(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    writeFile(resolve(directory, "output.json"), `${JSON.stringify(example.report, null, 2)}\n`, "utf8"),
    writeFile(resolve(directory, "trace.json"), `${JSON.stringify(example.trace, null, 2)}\n`, "utf8"),
  ]);
}

const examples = [buildLinus(), buildChris(), buildPython()];
await Promise.all(examples.map(writeExample));
process.stdout.write(`Generated ${examples.length} deterministic examples.\n`);

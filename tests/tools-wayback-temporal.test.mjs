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

const { inspectWaybackHistory } = await vite.ssrLoadModule("/lib/tools/wayback.ts");

const jsonResponse = (body, init = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });

const header = ["timestamp", "original", "mimetype", "statuscode", "digest", "length"];
const candidate = { candidateId: "candidate-denise", basis: "resolved_candidate_profile" };

test("Wayback compares exact raw bodies plus bounded static-HTML text, metadata, and structure", async () => {
  const targetUrl = "https://profile.example/about";
  const requested = [];
  const result = await inspectWaybackHistory(
    { url: targetUrl, candidate },
    {
      clock: () => Date.parse("2026-08-20T18:00:00Z"),
      fetch: async (input, init) => {
        const url = new URL(String(input));
        requested.push(url.href);
        assert.equal(init?.method, "GET");
        assert.notEqual(
          url.pathname.includes("save"),
          true,
          "the adapter is read-only and never invokes Save Page Now",
        );
        if (url.pathname === "/cdx/search/cdx") {
          assert.equal(url.searchParams.get("url"), targetUrl);
          assert.equal(url.searchParams.get("matchType"), "exact");
          assert.equal(url.searchParams.get("collapse"), "digest");
          assert.equal(url.searchParams.get("limit"), "-24", "CDX must return the newest bounded exact rows");
          assert.equal(url.searchParams.get("from"), "20170101000000");
          assert.equal(url.searchParams.get("to"), "20250101000000");
          assert.ok(
            url.searchParams.getAll("filter").includes("original:^https://profile\\.example/about$"),
            "CDX must constrain its bounded result window to the exact escaped original URL",
          );
          return jsonResponse([
            header,
            ["20240102030405", targetUrl, "text/html", "200", "DIGEST-NEW", "440"],
            ["20180102030405", targetUrl, "text/html", "200", "DIGEST-OLD", "310"],
            ["20200102030405", "https://foreign.example/about", "text/html", "200", "FOREIGN", "999"],
            ["20220102030405", targetUrl, "text/html", "200", "DIGEST-MIDDLE", "370"],
            ["20220102030405", targetUrl, "text/html", "200", "DIGEST-MIDDLE", "370"],
          ]);
        }
        assert.match(url.pathname, /id_\/https:\/\/profile\.example\/about$/);
        if (url.pathname.includes("20180102030405")) {
          return new Response(
            `<!doctype html><html lang="en"><head>
          <title>Denise Hilary — Researcher</title>
          <meta name="description" content="Independent systems researcher">
          <meta property="article:modified_time" content="2018-01-01T00:00:00Z">
          <link rel="canonical" href="/about"><link rel="stylesheet" href="/old.css">
        </head><body><main><h1>Denise Hilary</h1><p>Research assistant.</p><img src="portrait.png"></main></body></html>`,
            {
              headers: { "content-type": "text/html; charset=utf-8" },
            },
          );
        }
        assert.ok(url.pathname.includes("20240102030405"), "the second raw request is the newest returned exact row");
        return new Response(
          `<!doctype html><html lang="en-us"><head>
        <title>Denise Hilary — Research Lead</title>
        <meta name="description" content="Product and systems research lead">
        <meta property="article:modified_time" content="2024-01-01T00:00:00Z">
        <link rel="canonical" href="https://unrelated.example/other"><link rel="stylesheet" href="/new.css">
        <script src="app.js">const inert = '<meta name="description" content="spoof"><form>';</script>
      </head><body><main><h1>Denise Hilary</h1><h2>Current work</h2><p>Product research lead.</p>
        <form><input name="public-query"></form></main></body></html>`,
          {
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        );
      },
    },
    {
      maxCaptures: 6,
      maxSnapshots: 2,
      maxChangedFragments: 4,
      from: "20170101000000",
      to: "20250101000000",
    },
  );

  assert.equal(result.status, "partial", "discarded foreign and duplicate rows keep incompleteness explicit");
  assert.equal(result.meta.requests, 3);
  assert.equal(requested.length, 3);
  assert.equal(requested.filter((url) => url.includes("id_/")).length, 2);
  assert.equal(result.data.cdxRequestUrl, requested[0], "adapter data must preserve the exact dispatched CDX URL");
  const cdxRequest = new URL(result.data.cdxRequestUrl);
  assert.deepEqual(cdxRequest.searchParams.getAll("filter"), [
    "statuscode:200",
    "mimetype:text/html",
    "original:^https://profile\\.example/about$",
  ]);
  assert.equal(cdxRequest.searchParams.get("limit"), "-24");
  assert.equal(cdxRequest.searchParams.get("from"), "20170101000000");
  assert.equal(cdxRequest.searchParams.get("to"), "20250101000000");
  assert.equal(result.data.rawRowsAccepted, 3);
  assert.equal(result.data.uniqueDigests, 3);
  assert.deepEqual(result.data.snapshotSelection, {
    strategy: "earliest_distinct_digest_to_latest",
    boundedToReturnedRows: true,
    earliestObservedTimestamp: "2018-01-02T03:04:05.000Z",
    latestObservedTimestamp: "2024-01-02T03:04:05.000Z",
    selectedTimestamps: ["2018-01-02T03:04:05.000Z", "2024-01-02T03:04:05.000Z"],
  });
  assert.equal(result.data.snapshots.at(-1).timestamp, "2024-01-02T03:04:05.000Z");
  assert.match(result.data.snapshots[0].bodyHashSha256, /^[a-f0-9]{64}$/);
  assert.match(result.data.snapshots[0].contentHashSha256, /^[a-f0-9]{64}$/);
  assert.match(result.data.snapshots[0].metadataHashSha256, /^[a-f0-9]{64}$/);
  assert.match(result.data.snapshots[0].structureHashSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.data.snapshots[0].metadata.title, "Denise Hilary — Researcher");
  assert.equal(result.data.snapshots[0].metadata.canonicalUrl, targetUrl);
  assert.equal(result.data.snapshots[1].metadata.canonicalUrl, null, "foreign canonical metadata is not retained");
  assert.equal(result.data.snapshots[1].metadata.description, "Product and systems research lead");
  assert.equal(result.data.snapshots[1].structure.formCount, 1);
  assert.equal(result.data.snapshots[1].structure.scriptCount, 1);
  assert.equal(result.data.temporalChange.bodyChanged, true);
  assert.equal(result.data.temporalChange.visibleTextChanged, true);
  assert.equal(result.data.temporalChange.metadataChanged, true);
  assert.equal(result.data.temporalChange.structureChanged, true);
  assert.ok(result.data.temporalChange.changedMetadataFields.includes("title"));
  assert.ok(result.data.temporalChange.addedTextFragments.some((text) => text.includes("Product research lead")));
  assert.ok(result.data.temporalChange.removedTextFragments.some((text) => text.includes("Research assistant")));
  assert.match(result.data.temporalChange.scopeNote, /archive completeness/);
  assert.ok(result.diagnostics.some((item) => item.code === "wayback_rows_discarded"));
});

test("Wayback chooses newest plus an earlier distinct digest after an edit-and-revert sequence", async () => {
  const targetUrl = "https://profile.example/history";
  const rawTimestamps = [];
  const result = await inspectWaybackHistory(
    { url: targetUrl, candidate },
    {
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/cdx/search/cdx")
          return jsonResponse([
            header,
            ["20200101000000", targetUrl, "text/html", "200", "DIGEST-A", "100"],
            ["20210101000000", targetUrl, "text/html", "200", "DIGEST-B", "120"],
            ["20220101000000", targetUrl, "text/html", "200", "DIGEST-A", "100"],
          ]);
        const timestamp = url.pathname.match(/\/web\/(\d{14})id_\//)?.[1];
        rawTimestamps.push(timestamp);
        return new Response(
          timestamp === "20210101000000"
            ? "<html><body><p>Temporary role.</p></body></html>"
            : "<html><body><p>Original role.</p></body></html>",
          {
            headers: { "content-type": "text/html" },
          },
        );
      },
    },
  );

  assert.deepEqual(rawTimestamps, ["20210101000000", "20220101000000"]);
  assert.equal(result.data.snapshotSelection.strategy, "earliest_distinct_digest_to_latest");
  assert.equal(result.data.snapshotSelection.earliestObservedTimestamp, "2020-01-01T00:00:00.000Z");
  assert.equal(result.data.snapshotSelection.latestObservedTimestamp, "2022-01-01T00:00:00.000Z");
  assert.deepEqual(
    result.data.captureTimeline.map((item) => item.digest),
    ["DIGEST-A", "DIGEST-B", "DIGEST-A"],
  );
  assert.equal(result.data.temporalChange.then.timestamp, "2021-01-01T00:00:00.000Z");
  assert.equal(result.data.temporalChange.now.timestamp, "2022-01-01T00:00:00.000Z");
});

test("Wayback never promotes script-only template strings into static-HTML temporal fragments", async () => {
  const targetUrl = "https://profile.example/script-only-change";
  const oldScriptText = "SCRIPT OLD";
  const newScriptText = "SCRIPT NEW";
  const result = await inspectWaybackHistory(
    { url: targetUrl, candidate },
    {
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/cdx/search/cdx")
          return jsonResponse([
            header,
            ["20200101000000", targetUrl, "text/html", "200", "DIGEST-SCRIPT-A", "100"],
            ["20240101000000", targetUrl, "text/html", "200", "DIGEST-SCRIPT-B", "120"],
          ]);
        const scriptText = url.pathname.includes("20200101000000id_") ? oldScriptText : newScriptText;
        return new Response(
          `<html><body><p>Stable public biography.</p><script>const template = "<p>${scriptText}</p>";</script></body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      },
    },
  );

  assert.ok(result.data.temporalChange, "the exact raw-body hash still records the script-only change");
  assert.equal(result.data.temporalChange.bodyChanged, true);
  assert.equal(result.data.temporalChange.visibleTextChanged, false);
  assert.deepEqual(result.data.temporalChange.addedTextFragments, []);
  assert.deepEqual(result.data.temporalChange.removedTextFragments, []);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(oldScriptText), false);
  assert.equal(serialized.includes(newScriptText), false);
});

test("Wayback never reinterprets markup-looking active-tag attributes", async () => {
  const targetUrl = "https://profile.example/quoted-attribute-change";
  const result = await inspectWaybackHistory(
    { url: targetUrl, candidate },
    {
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/cdx/search/cdx")
          return jsonResponse([
            header,
            ["20200101000000", targetUrl, "text/html", "200", "DIGEST-ATTR-A", "100"],
            ["20240101000000", targetUrl, "text/html", "200", "DIGEST-ATTR-B", "120"],
          ]);
        const forged = url.pathname.includes("20200101000000id_") ? "FORGED OLD" : "FORGED NEW";
        return new Response(
          `<html><head><title>Stable profile</title><div data-template="<meta name=description content=${forged}><p>${forged}</p><img src=https://evil.cloudflare.com/x.png>"></div><meta name=description content=REAL-DESCRIPTION></head><body><p>Visible stable biography.</p></body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      },
    },
  );

  assert.ok(result.data.temporalChange);
  assert.equal(result.data.temporalChange.bodyChanged, true);
  assert.equal(result.data.temporalChange.visibleTextChanged, false);
  assert.equal(result.data.temporalChange.metadataChanged, false);
  assert.equal(result.data.temporalChange.structureChanged, false);
  assert.deepEqual(result.data.temporalChange.addedTextFragments, []);
  assert.deepEqual(result.data.temporalChange.removedTextFragments, []);
  assert.equal(
    result.data.snapshots.every((snapshot) => snapshot.metadata.description === "REAL-DESCRIPTION"),
    true,
  );
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes("FORGED OLD"), false);
  assert.equal(serialized.includes("FORGED NEW"), false);
  assert.equal(serialized.includes("evil.cloudflare.com"), false);
});

test("Wayback removes nested inactive containers from text, metadata, structure, and diffs", async () => {
  const targetUrl = "https://profile.example/nested-template-change";
  const oldHidden = "HIDDEN OLD";
  const newHidden = "HIDDEN NEW";
  const result = await inspectWaybackHistory(
    { url: targetUrl, candidate },
    {
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/cdx/search/cdx")
          return jsonResponse([
            header,
            ["20200101000000", targetUrl, "text/html", "200", "DIGEST-NESTED-A", "100"],
            ["20240101000000", targetUrl, "text/html", "200", "DIGEST-NESTED-B", "120"],
          ]);
        const hidden = url.pathname.includes("20200101000000id_") ? oldHidden : newHidden;
        return new Response(
          `<html><head><title>Stable profile</title></head><body><p>Stable public biography.</p><template><template><meta name="description" content="${hidden}"></template><script>const close = "</template>";<p>${hidden}</p></script><p>${hidden}</p></template></body></html>`,
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      },
    },
  );

  assert.ok(result.data.temporalChange);
  assert.equal(result.data.temporalChange.bodyChanged, true);
  assert.equal(result.data.temporalChange.visibleTextChanged, false);
  assert.equal(result.data.temporalChange.metadataChanged, false);
  assert.equal(result.data.temporalChange.structureChanged, false);
  assert.deepEqual(result.data.temporalChange.addedTextFragments, []);
  assert.deepEqual(result.data.temporalChange.removedTextFragments, []);
  assert.equal(
    result.data.snapshots.every((snapshot) => snapshot.metadata.description === null),
    true,
  );
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(oldHidden), false);
  assert.equal(serialized.includes(newHidden), false);
});

test("Wayback treats title RCDATA and plaintext suffixes as inert projections", async () => {
  const targetUrl = "https://profile.example/raw-text-change";
  const result = await inspectWaybackHistory(
    { url: targetUrl, candidate },
    {
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/cdx/search/cdx")
          return jsonResponse([
            header,
            ["20200101000000", targetUrl, "text/html", "200", "DIGEST-RAW-A", "100"],
            ["20240101000000", targetUrl, "text/html", "200", "DIGEST-RAW-B", "120"],
          ]);
        const hidden = url.pathname.includes("20200101000000id_") ? "HIDDEN OLD" : "HIDDEN NEW";
        return new Response(
          `<!DOCTYPE html PUBLIC "<meta name=description content=${hidden}>"><?xml value="<p>${hidden}</p>"><![CDATA[<p>${hidden}</p>]]><html><head><title>Stable <meta name="description" content="TITLE STATIC"><script>TITLE STATIC</script></title></head><body><p>Stable public biography.</p><plaintext>${hidden}</plaintext><p>${hidden}</p></body></html>`,
          { headers: { "content-type": "text/html" } },
        );
      },
    },
  );
  assert.equal(result.data.temporalChange.visibleTextChanged, false);
  assert.equal(result.data.temporalChange.metadataChanged, false);
  assert.equal(result.data.temporalChange.structureChanged, false);
  assert.deepEqual(result.data.temporalChange.addedTextFragments, []);
  assert.deepEqual(result.data.temporalChange.removedTextFragments, []);
  assert.equal(JSON.stringify(result).includes("HIDDEN OLD"), false);
  assert.equal(JSON.stringify(result).includes("HIDDEN NEW"), false);
});

test("Wayback decodes references and format controls before retaining metadata, excerpts, or diffs", async () => {
  const targetUrl = "https://profile.example/encoded-credential-change";
  const thenToken = `ghp&#x5f${"G".repeat(36)}`;
  const nowToken = `ghp&amp;#x5f;${"H".repeat(36)}`;
  const result = await inspectWaybackHistory(
    { url: targetUrl, candidate },
    {
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/cdx/search/cdx")
          return jsonResponse([
            header,
            ["20230101000000", targetUrl, "text/html", "200", "DIGEST-ENCODED-A", "180"],
            ["20240101000000", targetUrl, "text/html", "200", "DIGEST-ENCODED-B", "180"],
          ]);
        const then = url.pathname.includes("20230101000000");
        const token = then ? thenToken : nowToken;
        const email = then ? "private&commat;example.com" : "other&commat;example.com";
        const zeroWidthToken = `ghp_${then ? "\u200b" : "\u2060"}${"K".repeat(36)}`;
        return new Response(
          `<html><head><title>${token}</title><meta name="description" content="${email}"></head><body><p>Stable public biography.</p><p>${token}</p><p>${zeroWidthToken}</p></body></html>`,
          {
            headers: {
              "content-type": `text/html; charset=utf-8; x-padding=${"A".repeat(180)}; x-token=ghp_${"Z".repeat(36)}`,
            },
          },
        );
      },
    },
  );

  assert.equal(
    result.data.snapshots.every((snapshot) => snapshot.metadata.title === null),
    true,
  );
  assert.equal(
    result.data.snapshots.every((snapshot) => snapshot.metadata.description === null),
    true,
  );
  assert.equal(
    result.data.snapshots.every((snapshot) => snapshot.responseContentType === "text/html; charset=utf-8"),
    true,
  );
  assert.deepEqual(result.data.temporalChange.addedTextFragments, []);
  assert.deepEqual(result.data.temporalChange.removedTextFragments, []);
  const serialized = JSON.stringify(result.data);
  for (const forbidden of [
    "ghp_",
    "ghp&#",
    "commat",
    "private@example.com",
    "other@example.com",
    "x-padding",
    "x-token",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

test("Wayback retains common named references with case-correct text", async () => {
  const targetUrl = "https://profile.example/common-entities";
  const result = await inspectWaybackHistory(
    { url: targetUrl, candidate },
    {
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/cdx/search/cdx")
          return jsonResponse([header, ["20240101000000", targetUrl, "text/html", "200", "DIGEST-COMMON", "180"]]);
        return new Response(
          '<html><head><title>&Eacute;lodie&rsquo;s R&eacute;sum&eacute; &mdash; Research &copy;</title><meta name="description" content="&ldquo;Registered&rdquo; &reg; profile"></head><body><p>Public R&eacute;sum&eacute;.</p></body></html>',
          {
            headers: { "content-type": "text/html; charset=utf-8" },
          },
        );
      },
    },
  );
  assert.equal(result.data.snapshots[0].metadata.title, "Élodie’s Résumé — Research ©");
  assert.equal(result.data.snapshots[0].metadata.description, "“Registered” ® profile");
  assert.equal(result.data.snapshots[0].textExcerpt, "Public Résumé.");
});

test("Wayback requires exact ASCII closing-tag delimiters for every inactive container", async () => {
  const targetUrl = "https://profile.example/strict-closes";
  const result = await inspectWaybackHistory(
    { url: targetUrl, candidate },
    {
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/cdx/search/cdx")
          return jsonResponse([
            header,
            ["20230101000000", targetUrl, "text/html", "200", "DIGEST-CLOSE-A", "180"],
            ["20240101000000", targetUrl, "text/html", "200", "DIGEST-CLOSE-B", "180"],
          ]);
        const hidden = url.pathname.includes("20230101000000") ? "HIDDEN OLD" : "HIDDEN NEW";
        return new Response(
          `<html><head><title>Stable profile</title></head><body><p>Stable public biography.</p><script>${hidden}</script!><p>${hidden}</p></script><textarea>${hidden}</ textarea><p>${hidden}</p></textarea><template>${hidden}</template\u00a0><p>${hidden}</p></template></body></html>`,
          {
            headers: { "content-type": "text/html" },
          },
        );
      },
    },
  );
  assert.equal(result.data.temporalChange.bodyChanged, true);
  assert.equal(result.data.temporalChange.visibleTextChanged, false);
  assert.equal(result.data.temporalChange.metadataChanged, false);
  assert.equal(result.data.temporalChange.structureChanged, false);
  assert.deepEqual(result.data.temporalChange.addedTextFragments, []);
  assert.deepEqual(result.data.temporalChange.removedTextFragments, []);
  assert.equal(JSON.stringify(result.data).includes("HIDDEN"), false);
});

test("Wayback hashes but never retains credential literals from archived HTML", async () => {
  const targetUrl = "https://profile.example/credential-test";
  const credentials = [
    `AKIA${"A".repeat(16)}`,
    `AIza${"B".repeat(35)}`,
    `ghp_${"c".repeat(36)}`,
    `eyJ${"a".repeat(8)}.${"b".repeat(12)}.${"c".repeat(16)}`,
    `sk-proj-${"d".repeat(48)}`,
    `npm_${"e".repeat(48)}`,
  ];
  const result = await inspectWaybackHistory(
    { url: targetUrl, candidate },
    {
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/cdx/search/cdx")
          return jsonResponse([header, ["20240101000000", targetUrl, "text/html", "200", "DIGEST-SECRET", "400"]]);
        return new Response(
          `<html><head><title>${credentials[0]}</title><meta name="description" content="${credentials[1]}"></head><body>${credentials
            .slice(2)
            .map((credential) => `<p>${credential}</p>`)
            .join("")}</body></html>`,
          {
            headers: { "content-type": "text/html" },
          },
        );
      },
    },
  );

  assert.equal(result.data.snapshots.length, 1);
  assert.match(result.data.snapshots[0].bodyHashSha256, /^[a-f0-9]{64}$/);
  assert.equal(result.data.snapshots[0].metadata.title, null);
  assert.equal(result.data.snapshots[0].metadata.description, null);
  assert.equal(result.data.snapshots[0].textExcerpt, null);
  for (const credential of credentials) assert.equal(JSON.stringify(result.data).includes(credential), false);
});

test("Wayback temporal fallback never reintroduces rejected bare credential text", async () => {
  const targetUrl = "https://profile.example/credential-diff";
  const thenToken = `sk-proj-${"a".repeat(48)}`;
  const nowToken = `npm_${"b".repeat(48)}`;
  const result = await inspectWaybackHistory(
    { url: targetUrl, candidate },
    {
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/cdx/search/cdx")
          return jsonResponse([
            header,
            ["20230101000000", targetUrl, "text/html", "200", "DIGEST-THEN", "180"],
            ["20240101000000", targetUrl, "text/html", "200", "DIGEST-NOW", "180"],
          ]);
        const token = url.pathname.includes("20230101000000") ? thenToken : nowToken;
        return new Response(`<html><body>${token}</body></html>`, {
          headers: { "content-type": "text/html" },
        });
      },
    },
  );

  assert.ok(result.data.temporalChange, "different exact raw bodies should retain a hash-only temporal change");
  assert.deepEqual(result.data.temporalChange.addedTextFragments, []);
  assert.deepEqual(result.data.temporalChange.removedTextFragments, []);
  assert.equal(JSON.stringify(result).includes(thenToken), false);
  assert.equal(JSON.stringify(result).includes(nowToken), false);
});

test("Wayback checks complete normalized text before excerpt bounding", async () => {
  const targetUrl = "https://profile.example/credential-boundary";
  const token = `ghp_${"B".repeat(36)}`;
  const result = await inspectWaybackHistory(
    { url: targetUrl, candidate },
    {
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname === "/cdx/search/cdx")
          return jsonResponse([header, ["20240101000000", targetUrl, "text/html", "200", "DIGEST-BOUNDARY", "180"]]);
        return new Response(`<html><body><p>${"A".repeat(70)} ${token}</p></body></html>`, {
          headers: { "content-type": "text/html" },
        });
      },
    },
    { maxExcerptCharacters: 80 },
  );
  assert.equal(result.data.snapshots[0].textExcerpt, null);
  assert.equal(JSON.stringify(result).includes("ghp_"), false);
});

test("Wayback rejects secret-bearing URLs and reversed ranges without any request", async () => {
  let calls = 0;
  const context = {
    fetch: async () => {
      calls += 1;
      throw new Error("must not fetch");
    },
  };
  const secretUrl = await inspectWaybackHistory(
    {
      url: "https://profile.example/about?access_token=secret",
      candidate,
    },
    context,
  );
  const reversedRange = await inspectWaybackHistory(
    {
      url: "https://profile.example/about",
      candidate,
    },
    context,
    { from: "2025", to: "2024" },
  );
  assert.equal(secretUrl.status, "skipped");
  assert.ok(secretUrl.diagnostics.some((item) => item.code === "invalid_candidate_url"));
  assert.equal(reversedRange.status, "skipped");
  assert.ok(reversedRange.diagnostics.some((item) => item.code === "invalid_wayback_range"));
  assert.equal(calls, 0);
});

test("Wayback treats absent or redirected exact captures as non-proof and never substitutes another snapshot", async () => {
  const targetUrl = "https://profile.example/about";
  let calls = 0;
  const absent = await inspectWaybackHistory(
    { url: targetUrl, candidate },
    {
      fetch: async () => {
        calls += 1;
        return jsonResponse([
          header,
          ["20200101000000", "https://foreign.example/about", "text/html", "200", "FOREIGN", "10"],
        ]);
      },
    },
  );
  assert.equal(absent.status, "not_found");
  assert.equal(absent.data.snapshots.length, 0);
  assert.match(
    absent.diagnostics.find((item) => item.code === "wayback_captures_not_observed").message,
    /does not prove/,
  );

  const requested = [];
  const redirected = await inspectWaybackHistory(
    { url: targetUrl, candidate },
    {
      fetch: async (input) => {
        calls += 1;
        const url = new URL(String(input));
        requested.push(url.href);
        if (url.pathname === "/cdx/search/cdx")
          return jsonResponse([header, ["20200101000000", targetUrl, "text/html", "200", "DIGEST-A", "100"]]);
        return new Response(null, {
          status: 302,
          headers: { location: `https://web.archive.org/web/20250101000000id_/${targetUrl}` },
        });
      },
    },
  );
  assert.equal(redirected.status, "partial");
  assert.equal(redirected.data.snapshots.length, 0);
  assert.ok(redirected.diagnostics.some((item) => item.code === "wayback_snapshot_unavailable"));
  assert.equal(requested.length, 2, "the redirected replacement capture is never requested");
  assert.equal(calls, 3);
});

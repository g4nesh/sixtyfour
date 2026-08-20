import assert from "node:assert/strict";
import test from "node:test";

import {
  asHardenedFetchError,
  createHardenedFetch,
  isBlockedIpAddress,
  parseRetryAfter,
} from "../lib/tools/hardened-fetch.ts";

const jsonResponse = (body, init = {}) => new Response(JSON.stringify(body), {
  ...init,
  headers: { "content-type": "application/json", ...(init.headers ?? {}) },
});

test("private and special-use addresses are rejected before fetch", async () => {
  let calls = 0;
  const hardenedFetch = createHardenedFetch({
    allowedHostnames: ["127.0.0.1", "169.254.169.254", "[::1]"],
    fetch: async () => {
      calls += 1;
      return jsonResponse({ unexpected: true });
    },
  });

  await assert.rejects(() => hardenedFetch("https://127.0.0.1/private"), { code: "blocked_address" });
  await assert.rejects(() => hardenedFetch("https://169.254.169.254/latest/meta-data"), { code: "blocked_address" });
  assert.equal(calls, 0);
  assert.equal(isBlockedIpAddress("::ffff:127.0.0.1"), true);
  assert.equal(isBlockedIpAddress("93.184.216.34"), false);
});

test("every redirect is revalidated and sensitive destinations are blocked", async () => {
  let calls = 0;
  const hardenedFetch = createHardenedFetch({
    allowedHostnames: ["public.example.com", "169.254.169.254"],
    fetch: async () => {
      calls += 1;
      return new Response(null, {
        status: 302,
        headers: { location: "https://169.254.169.254/latest/meta-data" },
      });
    },
  });

  await assert.rejects(() => hardenedFetch("https://public.example.com/start"), { code: "blocked_address" });
  assert.equal(calls, 1);
});

test("redirect cleanup failures retain a specific hardened transport diagnostic", async () => {
  const response = {
    status: 302,
    headers: new Headers({ location: "https://public.example.com/next" }),
    body: { cancel: async () => { throw new Error("cross-runtime stream cleanup failed"); } },
  };
  const hardenedFetch = createHardenedFetch({
    allowedHostnames: ["public.example.com"],
    fetch: async () => response,
  });
  await assert.rejects(() => hardenedFetch("https://public.example.com/start"), {
    name: "HardenedFetchError",
    code: "network_error",
    status: 302,
    requests: 1,
  });

  const rehydrated = asHardenedFetchError({
    name: "HardenedFetchError",
    code: "timeout",
    retryable: true,
    status: null,
    attempt: 2,
    requests: 2,
  });
  assert.equal(rehydrated.code, "timeout");
  assert.equal(rehydrated.requests, 2);
  assert.equal(asHardenedFetchError({ name: "Error", code: "timeout" }), null);
});

test("DNS answers are fail-closed when a resolver is supplied", async () => {
  let fetchCalls = 0;
  const hardenedFetch = createHardenedFetch({
    resolveHostname: async () => ["10.0.0.8", "93.184.216.34"],
    fetch: async () => {
      fetchCalls += 1;
      return jsonResponse({ unexpected: true });
    },
  });

  await assert.rejects(() => hardenedFetch("https://attacker.example/path"), { code: "blocked_address" });
  assert.equal(fetchCalls, 0);
});

test("response MIME and byte limits are enforced", async () => {
  const wrongMime = createHardenedFetch({
    allowedHostnames: ["public.example.com"],
    allowedMimeTypes: ["application/json"],
    fetch: async () => new Response("markup", { headers: { "content-type": "text/html" } }),
  });
  await assert.rejects(() => wrongMime("https://public.example.com/"), { code: "mime_not_allowed" });

  const oversized = createHardenedFetch({
    allowedHostnames: ["public.example.com"],
    maxBytes: 4,
    fetch: async () => new Response("12345", { headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(() => oversized("https://public.example.com/"), { code: "response_too_large" });
});

test("idempotent requests honor bounded Retry-After and report attempts", async () => {
  const sleeps = [];
  const budgetedRequests = [];
  let calls = 0;
  const hardenedFetch = createHardenedFetch({
    allowedHostnames: ["api.example.com"],
    maxRetries: 1,
    maxRetryAfterMs: 1_500,
    sleep: async (milliseconds) => sleeps.push(milliseconds),
    beforeRequest: async (attempt) => {
      budgetedRequests.push(attempt.requestNumber);
      return true;
    },
    fetch: async () => {
      calls += 1;
      return calls === 1
        ? jsonResponse({ limited: true }, { status: 429, headers: { "retry-after": "2" } })
        : jsonResponse({ ok: true });
    },
  });

  const result = await hardenedFetch("https://api.example.com/data");
  assert.equal(result.attempts, 2);
  assert.equal(result.requests, 2);
  assert.deepEqual(sleeps, [1_500]);
  assert.deepEqual(budgetedRequests, [1, 2]);
  assert.deepEqual(await result.response.json(), { ok: true });
  assert.equal(parseRetryAfter("999", 0, 10_000), 10_000);
  assert.equal(parseRetryAfter("not-a-date", 0, 10_000), null);
});

test("non-HTTPS and nonstandard-port requests are rejected", async () => {
  const hardenedFetch = createHardenedFetch({
    allowedHostnames: ["public.example.com"],
    fetch: async () => jsonResponse({ unexpected: true }),
  });
  await assert.rejects(() => hardenedFetch("http://public.example.com/"), { code: "blocked_scheme" });
  await assert.rejects(() => hardenedFetch("https://public.example.com:8443/"), { code: "blocked_port" });
});

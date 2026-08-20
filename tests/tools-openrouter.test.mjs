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

const {
  appendAssistantTurn,
  createOpenRouterClient,
  functionTool,
  normalizeOpenRouterUsage,
  toolResultMessage,
  webSearchTool,
} = await vite.ssrLoadModule("/lib/providers/openrouter.ts");

test("missing API keys fail as configuration errors before network work", () => {
  assert.throws(
    () => createOpenRouterClient({ apiKey: "  ", model: "anthropic/claude-sonnet" }),
    { code: "openrouter_configuration_error" },
  );
});

test("web search and custom functions default to auto single-submit tool calling", async () => {
  const requests = [];
  const logs = [];
  const opaqueReasoning = [{ type: "reasoning.encrypted", id: "r1", data: "opaque-ciphertext" }];
  const client = createOpenRouterClient({
    apiKey: "test-key-not-real",
    model: "anthropic/claude-sonnet",
    endpoint: "https://router.example.com/api/v1/chat/completions",
    logger: (event) => logs.push(event),
    fetch: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(new TextDecoder().decode(init.body)) });
      return new Response(JSON.stringify({
        id: "gen-1",
        model: "anthropic/claude-sonnet",
        provider: "Anthropic",
        choices: [{
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            reasoning: "plaintext chain that must be discarded",
            reasoning_details: opaqueReasoning,
            tool_calls: [{
              id: "call-1",
              type: "function",
              function: { name: "github_codegraph", arguments: "{\"email\":\"person@example.com\"}" },
            }],
          },
        }],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 8,
          total_tokens: 3,
          completion_tokens_details: { reasoning_tokens: 5 },
          prompt_tokens_details: { cached_tokens: 4 },
          cost: "0.001",
        },
      }), { headers: { "content-type": "application/json", "x-request-id": "req-1" } });
    },
  });

  const githubTool = functionTool({
    name: "github_codegraph",
    description: "Correlate an exact email with public commit metadata.",
    parameters: {
      type: "object",
      properties: { email: { type: "string" } },
      required: ["email"],
      additionalProperties: false,
    },
    strict: true,
  });
  const completion = await client.complete({
    messages: [{ role: "user", content: "research the supplied target" }],
    tools: [githubTool],
    webSearch: { max_results: 4, max_total_results: 10, allowed_domains: ["example.com"] },
    reasoning: { effort: "high" },
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.tool_choice, "auto");
  assert.equal(
    requests[0].body.parallel_tool_calls,
    false,
    "omitting parallelToolCalls must fail closed in the provider request body",
  );
  assert.deepEqual(requests[0].body.tools.map((tool) => tool.type), ["function", "openrouter:web_search"]);
  assert.deepEqual(completion.message.reasoning_details, opaqueReasoning);
  assert.equal(Object.hasOwn(completion.message, "reasoning"), false);
  assert.equal(completion.usage.totalTokens, 20, "defensive normalization cannot undercount known token components");
  assert.equal(completion.usage.reasoningTokens, 5);
  assert.equal(completion.usage.cachedInputTokens, 4);
  assert.equal(completion.requestId, "req-1");
  assert.equal(JSON.stringify(logs).includes("plaintext chain"), false);
  assert.equal(JSON.stringify(logs).includes("opaque-ciphertext"), false);

  const nextMessages = appendAssistantTurn(
    [{ role: "user", content: "research the supplied target" }],
    completion,
  );
  assert.equal(
    nextMessages[1].reasoning_details,
    completion.message.reasoning_details,
    "opaque continuation must be passed back unchanged",
  );
  const toolMessage = toolResultMessage("call-1", { ok: true });
  assert.deepEqual(toolMessage, {
    role: "tool",
    tool_call_id: "call-1",
    content: "{\"ok\":true}",
  });
  await client.complete({ messages: [...nextMessages, toolMessage], tools: [githubTool] });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body.parallel_tool_calls, false);
  assert.deepEqual(requests[1].body.messages[1].reasoning_details, opaqueReasoning);
});

test("provider errors never echo response bodies", async () => {
  const secretEcho = "sensitive prompt fragment";
  const logs = [];
  const client = createOpenRouterClient({
    apiKey: "test-key-not-real",
    model: "test/model",
    endpoint: "https://router.example.com/api/v1/chat/completions",
    logger: (event) => logs.push(event),
    fetch: async () => new Response(JSON.stringify({ error: { message: secretEcho } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    }),
  });

  await assert.rejects(
    () => client.complete({ messages: [{ role: "user", content: secretEcho }] }),
    (error) => error.code === "http_error" && !error.message.includes(secretEcho),
  );
  assert.equal(JSON.stringify(logs).includes(secretEcho), false);
});

test("Gemini web discovery uses native Google Search and preserves server citations", async () => {
  const requests = [];
  const client = createOpenRouterClient({
    provider: "gemini",
    apiKey: "gemini-test-key-not-real",
    model: "gemini-3.6-flash",
    fetch: async (url, init) => {
      requests.push({
        url: String(url),
        headers: new Headers(init.headers),
        body: JSON.parse(new TextDecoder().decode(init.body)),
      });
      return new Response(JSON.stringify({
        id: "interaction-1",
        model: "gemini-3.6-flash",
        steps: [{
          type: "model_output",
          content: [{
            type: "text",
            text: "A grounded result.",
            annotations: [{
              type: "url_citation",
              url: "https://example.edu/people/ada?utm_source=search",
              title: "Ada Lovelace — Example University",
              start_index: 0,
              end_index: 17,
            }],
          }],
        }],
        usage: { input_tokens: 12, output_tokens: 6, total_tokens: 18 },
      }), {
        headers: { "content-type": "application/json", "x-goog-request-id": "gemini-request-1" },
      });
    },
  });

  const completion = await client.complete({
    messages: [
      { role: "system", content: "Find direct public professional sources." },
      { role: "user", content: "Ada Lovelace" },
    ],
    webSearch: { max_results: 4 },
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.equal(requests[0].headers.get("x-goog-api-key"), "gemini-test-key-not-real");
  assert.deepEqual(requests[0].body.tools, [{ type: "google_search" }]);
  assert.match(requests[0].body.input, /Ada Lovelace/);
  assert.equal(completion.provider, "gemini:google_search");
  assert.equal(completion.requestId, "gemini-request-1");
  assert.equal(completion.usage.totalTokens, 18);
  assert.deepEqual(completion.message.annotations, [{
    type: "url_citation",
    url_citation: {
      url: "https://example.edu/people/ada",
      title: "Ada Lovelace — Example University",
    },
  }]);
});

test("usage normalization rejects negative and non-finite counters", () => {
  assert.deepEqual(normalizeOpenRouterUsage({
    input_tokens: -2,
    output_tokens: "not-a-number",
    total_tokens: Infinity,
    reasoning_tokens: -1,
    cost: "-3",
  }), {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    reasoningTokens: null,
    cachedInputTokens: null,
    costUsd: null,
  });
  assert.throws(
    () => webSearchTool({ allowed_domains: ["https://example.com/path"] }),
    { code: "openrouter_configuration_error" },
  );
});

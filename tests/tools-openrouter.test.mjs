import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createServer } from "vite";

const vite = await createServer({
  configFile: false,
  cacheDir: `node_modules/.vite-atlas-ssr/${process.pid}`,
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
  assert.throws(() => createOpenRouterClient({ apiKey: "  ", model: "anthropic/claude-sonnet" }), {
    code: "openrouter_configuration_error",
  });
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
      return new Response(
        JSON.stringify({
          id: "gen-1",
          model: "anthropic/claude-sonnet",
          provider: "Anthropic",
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                reasoning: "plaintext chain that must be discarded",
                reasoning_details: opaqueReasoning,
                tool_calls: [
                  {
                    id: "call-1",
                    type: "function",
                    function: { name: "github_codegraph", arguments: '{"email":"person@example.com"}' },
                  },
                ],
              },
            },
          ],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 8,
            total_tokens: 3,
            completion_tokens_details: { reasoning_tokens: 5 },
            prompt_tokens_details: { cached_tokens: 4 },
            cost: "0.001",
          },
        }),
        { headers: { "content-type": "application/json", "x-request-id": "req-1" } },
      );
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
    webSearch: { max_uses: 9, max_results: 4, max_total_results: 10, allowed_domains: ["example.com"] },
    reasoning: { effort: "high" },
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.tool_choice, "auto");
  assert.equal(
    requests[0].body.parallel_tool_calls,
    false,
    "omitting parallelToolCalls must fail closed in the provider request body",
  );
  assert.deepEqual(
    requests[0].body.tools.map((tool) => tool.type),
    ["function", "openrouter:web_search"],
  );
  assert.deepEqual(requests[0].body.tools[1], {
    type: "openrouter:web_search",
    parameters: {
      max_uses: 1,
      max_results: 4,
      max_total_results: 10,
      allowed_domains: ["example.com"],
    },
  });
  assert.equal(
    requests[0].body.max_tool_calls,
    1,
    "OpenRouter must enforce one provider-independent server-tool step in addition to the native max_uses hint",
  );
  assert.deepEqual(completion.message.reasoning_details, opaqueReasoning);
  assert.equal(Object.hasOwn(completion.message, "reasoning"), false);
  assert.equal(completion.usage.totalTokens, 20, "defensive normalization cannot undercount known token components");
  assert.equal(completion.usage.reasoningTokens, 5);
  assert.equal(completion.usage.cachedInputTokens, 4);
  assert.equal(completion.requestId, "req-1");
  assert.equal(JSON.stringify(logs).includes("plaintext chain"), false);
  assert.equal(JSON.stringify(logs).includes("opaque-ciphertext"), false);

  const nextMessages = appendAssistantTurn([{ role: "user", content: "research the supplied target" }], completion);
  assert.equal(
    nextMessages[1].reasoning_details,
    completion.message.reasoning_details,
    "opaque continuation must be passed back unchanged",
  );
  const toolMessage = toolResultMessage("call-1", { ok: true });
  assert.deepEqual(toolMessage, {
    role: "tool",
    tool_call_id: "call-1",
    content: '{"ok":true}',
  });
  await client.complete({ messages: [...nextMessages, toolMessage], tools: [githubTool] });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body.parallel_tool_calls, false);
  assert.equal(
    "max_tool_calls" in requests[1].body,
    false,
    "ordinary function-only turns must not inherit the search-specific tool-call cap",
  );
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
    fetch: async () =>
      new Response(JSON.stringify({ error: { message: secretEcho } }), {
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
      return new Response(
        JSON.stringify({
          id: "interaction-1",
          model: "gemini-3.6-flash",
          steps: [
            {
              type: "model_output",
              content: [
                {
                  type: "text",
                  text: "A grounded result.",
                  annotations: [
                    {
                      type: "url_citation",
                      url: "https://example.edu/people/ada?utm_source=search",
                      title: "Ada Lovelace — Example University",
                      start_index: 0,
                      end_index: 17,
                    },
                  ],
                },
              ],
            },
          ],
          usage: { input_tokens: 12, output_tokens: 6, total_tokens: 18 },
        }),
        {
          headers: { "content-type": "application/json", "x-goog-request-id": "gemini-request-1" },
        },
      );
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
  assert.deepEqual(completion.message.annotations, [
    {
      type: "url_citation",
      url_citation: {
        url: "https://example.edu/people/ada",
        title: "Ada Lovelace — Example University",
      },
    },
  ]);
});

test("Anthropic uses the native Messages API and round-trips structured tool calls", async () => {
  const requests = [];
  const responses = [
    {
      type: "message",
      id: "msg-1",
      model: "claude-test-model",
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "" },
        {
          type: "tool_use",
          id: "toolu-1",
          name: "submit_result",
          input: { accepted: true },
        },
      ],
      usage: { input_tokens: 14, output_tokens: 6, cache_read_input_tokens: 3 },
    },
    {
      type: "message",
      id: "msg-2",
      model: "claude-test-model",
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Done." }],
      usage: { input_tokens: 20, output_tokens: 2 },
    },
  ];
  const client = createOpenRouterClient({
    provider: "anthropic",
    apiKey: "anthropic-test-key-not-real",
    model: "claude-test-model",
    fetch: async (url, init) => {
      requests.push({
        url: String(url),
        headers: new Headers(init.headers),
        body: JSON.parse(new TextDecoder().decode(init.body)),
      });
      return new Response(JSON.stringify(responses[requests.length - 1]), {
        headers: { "content-type": "application/json", "request-id": `anthropic-request-${requests.length}` },
      });
    },
  });
  const tool = functionTool({
    name: "submit_result",
    description: "Submit the bounded result.",
    parameters: {
      type: "object",
      properties: { accepted: { type: "boolean" } },
      required: ["accepted"],
      additionalProperties: false,
    },
    strict: true,
  });
  const initialMessages = [
    { role: "system", content: "Use the provided function." },
    { role: "user", content: "Submit one result." },
  ];
  const first = await client.complete({
    messages: initialMessages,
    tools: [tool],
    maxCompletionTokens: 700,
    temperature: 0,
    parallelToolCalls: false,
    reasoning: { effort: "medium" },
  });

  assert.equal(requests[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(requests[0].headers.get("x-api-key"), "anthropic-test-key-not-real");
  assert.equal(requests[0].headers.get("anthropic-version"), "2023-06-01");
  assert.equal(requests[0].headers.has("authorization"), false);
  assert.equal(requests[0].body.system, "Use the provided function.");
  assert.equal(requests[0].body.max_tokens, 700);
  assert.deepEqual(requests[0].body.tools, [
    {
      name: "submit_result",
      description: "Submit the bounded result.",
      input_schema: tool.function.parameters,
    },
  ]);
  assert.deepEqual(requests[0].body.tool_choice, { type: "auto" });
  assert.equal("parallel_tool_calls" in requests[0].body, false);
  assert.equal("reasoning" in requests[0].body, false);
  assert.deepEqual(first.message.tool_calls, [
    {
      id: "toolu-1",
      type: "function",
      function: { name: "submit_result", arguments: '{"accepted":true}' },
    },
  ]);
  assert.equal(first.usage.inputTokens, 17);
  assert.equal(first.usage.totalTokens, 23);
  assert.equal(first.usage.cachedInputTokens, 3);
  assert.equal(first.requestId, "anthropic-request-1");

  const nextMessages = appendAssistantTurn(initialMessages, first);
  nextMessages.push(toolResultMessage("toolu-1", { accepted: true }));
  const second = await client.complete({ messages: nextMessages, tools: [tool], temperature: 0 });
  assert.equal(second.message.content, "Done.");
  assert.deepEqual(requests[1].body.messages[1], {
    role: "assistant",
    content: [{ type: "tool_use", id: "toolu-1", name: "submit_result", input: { accepted: true } }],
  });
  assert.deepEqual(requests[1].body.messages[2], {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: "toolu-1", content: '{"accepted":true}' }],
  });
});

test("Anthropic native web search is single-use and normalizes only server citation URLs", async () => {
  const requests = [];
  const client = createOpenRouterClient({
    provider: "anthropic",
    apiKey: "anthropic-test-key-not-real",
    model: "claude-test-model",
    fetch: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(new TextDecoder().decode(init.body)) });
      return new Response(
        JSON.stringify({
          type: "message",
          id: "msg-search",
          model: "claude-test-model",
          stop_reason: "end_turn",
          content: [
            {
              type: "web_search_tool_result",
              tool_use_id: "srvtoolu-1",
              content: [
                {
                  type: "web_search_result",
                  url: "https://example.edu/profile?utm_source=search",
                  title: "Example University profile",
                  encrypted_content: "opaque-and-discarded",
                },
              ],
            },
            {
              type: "text",
              text: "A grounded result.",
              citations: [
                {
                  type: "web_search_result_location",
                  url: "https://example.edu/profile?utm_source=search",
                  title: "Example University profile",
                  cited_text: "discarded source prose",
                },
              ],
            },
          ],
          usage: { input_tokens: 9, output_tokens: 4 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  });

  const completion = await client.complete({
    messages: [{ role: "user", content: "Find a public profile." }],
    webSearch: { max_results: 8, max_total_results: 12 },
    maxCompletionTokens: 900,
    temperature: 0,
  });

  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].body.tools, [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }]);
  assert.equal(completion.provider, "anthropic:web_search");
  assert.equal(completion.usage.totalTokens, 13);
  assert.deepEqual(completion.message.annotations, [
    {
      type: "url_citation",
      url_citation: { url: "https://example.edu/profile", title: "Example University profile" },
    },
  ]);
  assert.equal(JSON.stringify(completion).includes("opaque-and-discarded"), false);
  assert.equal(JSON.stringify(completion).includes("discarded source prose"), false);
});

test("usage normalization rejects negative and non-finite counters", () => {
  assert.deepEqual(
    normalizeOpenRouterUsage({
      input_tokens: -2,
      output_tokens: "not-a-number",
      total_tokens: Infinity,
      reasoning_tokens: -1,
      cost: "-3",
    }),
    {
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      reasoningTokens: null,
      cachedInputTokens: null,
      costUsd: null,
    },
  );
  assert.throws(() => webSearchTool({ allowed_domains: ["https://example.com/path"] }), {
    code: "openrouter_configuration_error",
  });
  assert.equal(webSearchTool({ max_uses: 20 }).parameters.max_uses, 1);
});

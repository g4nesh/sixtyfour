import { handleApiRequest } from "../lib/api/router";
import type { TraceEvent } from "../lib/agent/trace";
import { canonicalJson, getReplayExample, listReplayExamples } from "../lib/replay/catalog";
import type { JsonValue } from "../lib/domain/types";
import { once } from "node:events";

interface ParsedArguments {
  command: "examples" | "replay" | "trace" | "research" | "help";
  positional: string[];
  mode: "replay" | "live";
  exampleId?: string;
  ndjson: boolean;
  depth?: "quick" | "standard" | "deep";
}

const help = `Atlas People Intelligence CLI

Usage:
  npm run atlas -- examples
  npm run atlas -- replay <example-id>
  npm run atlas -- trace <example-id>
  npm run atlas -- research [--mode replay|live] [--example <id>] [--depth quick|standard|deep] [--ndjson] <query>

Replay is the default and performs zero network requests. Live mode requires
a server-side Gemini, OpenAI, or OpenRouter key in the process environment.
Use LIVE_PROVIDER=gemini|openai|openrouter to prefer one when its key is configured;
otherwise Atlas selects the first configured provider in its documented order.
Ctrl-C propagates cancellation to the same engine used by the HTTP API.
`;

function parseArguments(arguments_: string[]): ParsedArguments {
  if (arguments_.length === 0 || ["help", "--help", "-h"].includes(arguments_[0])) {
    return { command: "help", positional: [], mode: "replay", ndjson: false };
  }
  const command = arguments_[0];
  if (!["examples", "replay", "trace", "research"].includes(command)) {
    throw new TypeError(`Unknown command: ${command}`);
  }
  const parsed: ParsedArguments = {
    command: command as ParsedArguments["command"],
    positional: [],
    mode: "replay",
    ndjson: false,
  };
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--ndjson") {
      parsed.ndjson = true;
      continue;
    }
    if (argument === "--mode") {
      const mode = arguments_[index + 1];
      if (mode !== "replay" && mode !== "live") throw new TypeError("--mode must be replay or live");
      parsed.mode = mode;
      index += 1;
      continue;
    }
    if (argument === "--example") {
      const id = arguments_[index + 1];
      if (!id) throw new TypeError("--example requires an ID");
      parsed.exampleId = id;
      index += 1;
      continue;
    }
    if (argument === "--depth") {
      const depth = arguments_[index + 1];
      if (depth !== "quick" && depth !== "standard" && depth !== "deep") {
        throw new TypeError("--depth must be quick, standard, or deep");
      }
      parsed.depth = depth;
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) throw new TypeError(`Unknown option: ${argument}`);
    parsed.positional.push(argument);
  }
  return parsed;
}

function terminalReport(events: TraceEvent[]): Record<string, unknown> | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const report = events[index].payload.report;
    if (report && typeof report === "object" && !Array.isArray(report)) {
      return report as Record<string, unknown>;
    }
  }
  return null;
}

function exitCodeForReport(report: Record<string, unknown>): number {
  if (report.status === "failed") return 1;
  if (report.status === "configuration_error") return 2;
  if (report.status === "blocked") return 3;
  if (report.status === "canceled") return 130;
  return 0;
}

async function writeStdout(value: string): Promise<void> {
  if (value && !process.stdout.write(value)) await once(process.stdout, "drain");
}

async function consumeTraceStream(
  response: Response,
  mirrorNdjson: boolean,
): Promise<Record<string, unknown> | null> {
  if (!response.body) throw new Error("Research response did not include a trace stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const events: TraceEvent[] = [];

  const consumeLines = (flush: boolean) => {
    const lines = buffer.split("\n");
    buffer = flush ? "" : lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      events.push(JSON.parse(line) as TraceEvent);
    }
    if (flush && buffer.trim()) events.push(JSON.parse(buffer) as TraceEvent);
  };

  while (true) {
    const item = await reader.read();
    if (item.done) break;
    const text = decoder.decode(item.value, { stream: true });
    if (mirrorNdjson) await writeStdout(text);
    buffer += text;
    consumeLines(false);
  }
  const tail = decoder.decode();
  if (mirrorNdjson) await writeStdout(tail);
  buffer += tail;
  consumeLines(true);
  return terminalReport(events);
}

async function research(arguments_: ParsedArguments): Promise<number> {
  const query = arguments_.positional.join(" ").trim();
  if (!query) throw new TypeError("research requires a query");
  const abort = new AbortController();
  const onInterrupt = () => abort.abort(new Error("CLI interrupted"));
  process.once("SIGINT", onInterrupt);
  try {
    const response = await handleApiRequest(
      new Request("http://atlas.local/api/research", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/x-ndjson" },
        body: JSON.stringify({
          query,
          mode: arguments_.mode,
          ...(arguments_.exampleId ? { exampleId: arguments_.exampleId } : {}),
          ...(arguments_.depth ? { requestedDepth: arguments_.depth } : {}),
        }),
        signal: abort.signal,
      }),
      {
        // An explicit CLI `--mode live` is the local operator opt-in. Public
        // HTTP ingress remains disabled unless its server binding is enabled.
        ATLAS_LIVE_ENABLED: arguments_.mode === "live" ? "true" : undefined,
        LIVE_PROVIDER: process.env.LIVE_PROVIDER,
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        OPENAI_MODEL: process.env.OPENAI_MODEL,
        OPENAI_SEARCH_MODEL: process.env.OPENAI_SEARCH_MODEL,
        OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
        GEMINI_API_KEY: process.env.GEMINI_API_KEY,
        GEMINI_MODEL: process.env.GEMINI_MODEL,
        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
        OPENROUTER_MODEL: process.env.OPENROUTER_MODEL,
        OPENROUTER_SITE_URL: process.env.OPENROUTER_SITE_URL,
        OPENROUTER_APP_NAME: process.env.OPENROUTER_APP_NAME,
      },
    );
    if (!response) throw new Error("API router did not handle the research request");
    if (!response.ok) {
      process.stderr.write(await response.text());
      return 1;
    }
    const report = await consumeTraceStream(response, arguments_.ndjson);
    if (!report) {
      process.stderr.write("Research stream ended without a terminal report.\n");
      return 1;
    }
    if (!arguments_.ndjson) await writeStdout(`${JSON.stringify(report, null, 2)}\n`);
    return exitCodeForReport(report);
  } catch (error) {
    if (abort.signal.aborted) {
      process.stderr.write("Research canceled.\n");
      return 130;
    }
    throw error;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
  }
}

export async function main(arguments_ = process.argv.slice(2)): Promise<number> {
  let parsed: ParsedArguments;
  try {
    parsed = parseArguments(arguments_);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${help}`);
    return 1;
  }
  if (parsed.command === "help") {
    process.stdout.write(help);
    return 0;
  }
  if (parsed.command === "examples") {
    for (const example of listReplayExamples()) {
      process.stdout.write(`${example.id}\t${example.manifest.title}\t${example.input.query}\n`);
    }
    return 0;
  }
  if (parsed.command === "research") {
    try {
      return await research(parsed);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  const id = parsed.positional[0];
  if (!id) {
    process.stderr.write(`${parsed.command} requires an example ID.\n`);
    return 1;
  }
  const example = getReplayExample(id);
  if (!example) {
    process.stderr.write(`Unknown example: ${id}\n`);
    return 1;
  }
  if (parsed.command === "trace") {
    process.stdout.write(example.trace.map((event) => JSON.stringify(event)).join("\n") + "\n");
  } else {
    process.stdout.write(canonicalJson(example.output as unknown as JsonValue));
  }
  return 0;
}

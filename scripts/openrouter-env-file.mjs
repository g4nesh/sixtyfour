import { open } from "node:fs/promises";
import { parseEnv } from "node:util";

export const DEFAULT_ENV_FILE_MAX_BYTES = 16 * 1024;

function validateOpenRouterKey(value) {
  if (!/^sk-or-v1-[A-Za-z0-9_-]{32,}$/.test(value ?? "")) {
    throw new TypeError("OPENROUTER_API_KEY must contain a valid OpenRouter key.");
  }
  return value;
}

export function parseValidatedOpenRouterKeyFromEnvText(text) {
  const parsed = parseEnv(text);
  return validateOpenRouterKey(parsed.OPENROUTER_API_KEY?.trim());
}

export async function readValidatedOpenRouterKeyFromEnvFile(
  envFilePath,
  { maxBytes = DEFAULT_ENV_FILE_MAX_BYTES } = {},
) {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError("maxBytes must be a positive integer.");
  }
  const handle = await open(envFilePath, "r");
  try {
    const chunkSize = Math.min(maxBytes, 4096);
    const buffer = Buffer.allocUnsafe(chunkSize);
    let contents = "";
    let totalBytesRead = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      totalBytesRead += bytesRead;
      if (totalBytesRead > maxBytes) {
        throw new RangeError("The env file exceeded the allowed size limit.");
      }
      contents += buffer.toString("utf8", 0, bytesRead);
    }
    return parseValidatedOpenRouterKeyFromEnvText(contents);
  } finally {
    await handle.close();
  }
}

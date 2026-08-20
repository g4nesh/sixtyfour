import type { HostnameResolver } from "./contracts";

/**
 * DNS-over-HTTPS hostname resolver. Live public-source fetches require an
 * injected resolver so the hardened fetch can validate every DNS answer against
 * private/loopback ranges before connecting (SSRF defense). DoH is used instead
 * of `node:dns` so the same resolver works in both Node and Worker runtimes.
 *
 * The resolver only returns address literals; it never widens the fetch policy.
 * The hardened fetch remains the authority on which addresses are admissible.
 */
const DEFAULT_DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

interface DohAnswer {
  name?: string;
  type?: number;
  data?: string;
}

interface DohResponse {
  Status?: number;
  Answer?: DohAnswer[];
}

const A = 1;
const AAAA = 28;

function isAddressLiteral(value: string): boolean {
  // IPv4
  if (/^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(value)) return true;
  // IPv6 (loose; the hardened fetch performs the authoritative range check)
  return value.includes(":") && /^[0-9a-fA-F:.]+$/.test(value);
}

async function queryDoh(endpoint: string, hostname: string, type: number, signal?: AbortSignal): Promise<string[]> {
  const url = new URL(endpoint);
  url.searchParams.set("name", hostname);
  url.searchParams.set("type", String(type));
  const response = await fetch(url.toString(), {
    method: "GET",
    headers: { accept: "application/dns-json" },
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) return [];
  const payload = (await response.json()) as DohResponse;
  if (typeof payload.Status === "number" && payload.Status !== 0) return [];
  return (payload.Answer ?? [])
    .filter((answer) => answer.type === type && typeof answer.data === "string")
    .map((answer) => (answer.data as string).trim())
    .filter(isAddressLiteral);
}

/** Create a DoH-backed resolver returning A and AAAA address literals. */
export function createDohResolver(options: { endpoint?: string } = {}): HostnameResolver {
  const endpoint = options.endpoint ?? DEFAULT_DOH_ENDPOINT;
  return async (hostname: string, signal?: AbortSignal): Promise<readonly string[]> => {
    const host = hostname.trim().toLocaleLowerCase("en-US");
    if (!host) return [];
    const [v4, v6] = await Promise.all([
      queryDoh(endpoint, host, A, signal).catch(() => []),
      queryDoh(endpoint, host, AAAA, signal).catch(() => []),
    ]);
    return [...new Set([...v4, ...v6])];
  };
}

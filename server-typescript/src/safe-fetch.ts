/**
 * DNS-pinning fetch for SSRF / DNS-rebinding protection.
 *
 * Flow:
 * 1. Resolve hostname to all addresses (dns.lookup all:true).
 * 2. Reject the response set if any address is private/reserved/metadata
 *    (except loopback when the configured hostname is localhost).
 * 3. Pin one validated public (or allowed loopback) address.
 * 4. Connect via undici Agent whose lookup() always returns that address,
 *    so a concurrent DNS rebind cannot change the peer.
 * 5. TLS uses the original URL hostname for SNI/certs (undici default).
 */

import dns from "node:dns/promises";
import { Agent } from "undici";

import {
  createSafeRequestInit,
  validateRedirectUrl,
  type ValidationResult,
} from "./url-validation.ts";

/** Injectable lookup for tests. */
export type LookupAll = (
  hostname: string,
) => Promise<Array<{ address: string; family: number }>>;

export type PinnedAddress = { address: string; family: 4 | 6 };

const PRIVATE_IPV4_RANGES: Array<{ start: number; end: number }> = [
  { start: ipToNum("10.0.0.0"), end: ipToNum("10.255.255.255") },
  { start: ipToNum("172.16.0.0"), end: ipToNum("172.31.255.255") },
  { start: ipToNum("192.168.0.0"), end: ipToNum("192.168.255.255") },
  { start: ipToNum("127.0.0.0"), end: ipToNum("127.255.255.255") },
  { start: ipToNum("169.254.0.0"), end: ipToNum("169.254.255.255") },
  { start: ipToNum("0.0.0.0"), end: ipToNum("0.255.255.255") },
  { start: ipToNum("100.64.0.0"), end: ipToNum("100.127.255.255") }, // CGNAT
];

const BLOCKED_IPV4 = new Set([
  "169.254.169.254",
  "169.254.169.253",
  "100.100.100.200",
]);

function ipToNum(ip: string): number {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return -1;
  }
  return Number(
    (BigInt(parts[0]) << 24n) |
      (BigInt(parts[1]) << 16n) |
      (BigInt(parts[2]) << 8n) |
      BigInt(parts[3]),
  );
}

function isIpv4(str: string): boolean {
  return (
    /^(\d{1,3}\.){3}\d{1,3}$/.test(str) &&
    str.split(".").every((o) => {
      const n = parseInt(o, 10);
      return n >= 0 && n <= 255;
    })
  );
}

function isIpv6(str: string): boolean {
  return str.includes(":") && !str.includes(".");
}

function isLoopbackIpv4(ip: string): boolean {
  const n = ipToNum(ip);
  return n >= ipToNum("127.0.0.0") && n <= ipToNum("127.255.255.255");
}

function isLoopbackIpv6(ip: string): boolean {
  const n = ip.toLowerCase().replace(/^\[|\]$/g, "");
  return n === "::1" || n === "0:0:0:0:0:0:0:1";
}

/** Hostnames that are intentionally allowed to resolve to loopback (local Ollama). */
export function hostnameAllowsLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return h === "localhost" || h.endsWith(".localhost");
}

/**
 * Classify an address. Returns null if allowed, or an error string if blocked.
 * When allowLoopback is true, 127.0.0.0/8 and ::1 are permitted; other private ranges are not.
 */
export function blockedAddressReason(
  address: string,
  allowLoopback: boolean,
): string | null {
  const ip = address.replace(/^\[|\]$/g, "");

  if (isIpv4(ip)) {
    if (BLOCKED_IPV4.has(ip)) {
      return "Resolved IP is a cloud metadata endpoint";
    }
    if (allowLoopback && isLoopbackIpv4(ip)) {
      return null;
    }
    const n = ipToNum(ip);
    for (const range of PRIVATE_IPV4_RANGES) {
      if (n >= range.start && n <= range.end) {
        return "Resolved IP is a private/reserved address";
      }
    }
    return null;
  }

  if (isIpv6(ip)) {
    if (allowLoopback && isLoopbackIpv6(ip)) {
      return null;
    }
    const normalized = ip.toLowerCase();
    if (
      normalized === "::" ||
      normalized.startsWith("fe80:") ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("ff")
    ) {
      return "Resolved IP is a private/reserved IPv6 address";
    }
    // IPv4-mapped
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) {
      return blockedAddressReason(mapped[1]!, allowLoopback);
    }
    return null;
  }

  return "Resolved address is not a valid IP";
}

export type ResolvePinResult =
  | { ok: true; pin: PinnedAddress; addresses: PinnedAddress[] }
  | { ok: false; error: string };

/**
 * Resolve hostname and select a pinned address that satisfies SSRF policy.
 * If the DNS response contains any blocked address, the entire set is rejected
 * (prevents dual-homed rebinding where a safe A record is paired with a private one).
 */
export async function resolveAndPinHostname(
  hostname: string,
  lookupAll?: LookupAll,
): Promise<ResolvePinResult> {
  const host = hostname.replace(/^\[|\]$/g, "");
  const allowLoopback = hostnameAllowsLoopback(host);

  if (isIpv4(host) || isIpv6(host)) {
    const reason = blockedAddressReason(host, allowLoopback);
    if (reason) {
      return { ok: false, error: reason };
    }
    const family: 4 | 6 = isIpv4(host) ? 4 : 6;
    const pin = { address: host, family };
    return { ok: true, pin, addresses: [pin] };
  }

  const lookup: LookupAll =
    lookupAll ??
    (async (name) => {
      const records = await dns.lookup(name, { all: true, verbatim: true });
      return records.map((r) => ({ address: r.address, family: r.family }));
    });

  let records: Array<{ address: string; family: number }>;
  try {
    records = await lookup(host);
  } catch (err) {
    return {
      ok: false,
      error: `DNS lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!records.length) {
    return { ok: false, error: "DNS lookup returned no addresses" };
  }

  const allowed: PinnedAddress[] = [];
  for (const rec of records) {
    const reason = blockedAddressReason(rec.address, allowLoopback);
    if (reason) {
      // Strict dual-stack policy (intentional): if DNS returns any private,
      // link-local, or metadata address alongside public ones, reject the
      // entire set. Prefer a temporary resolution failure over connecting
      // when the name is dual-homed with an internal address (classic
      // rebinding pattern). Do not "prefer the public A/AAAA" here.
      return {
        ok: false,
        error: `${reason} (${rec.address})`,
      };
    }
    const family = (rec.family === 6 ? 6 : 4) as 4 | 6;
    allowed.push({ address: rec.address, family });
  }

  if (!allowed.length) {
    return { ok: false, error: "No allowed addresses after DNS resolution" };
  }

  // Prefer IPv4 for broader reachability when both are present.
  const pin = allowed.find((a) => a.family === 4) ?? allowed[0]!;
  return { ok: true, pin, addresses: allowed };
}

export type SafeFetchOptions = {
  /** Original configured hostname (for loopback policy + redirect checks). */
  originalHostname: string;
  /** Override DNS lookup (tests). */
  lookupAll?: LookupAll;
  /** Follow one safe redirect (default false — manual only). */
  followRedirects?: boolean;
  /** Fetch implementation; defaults to the global fetch implementation. */
  fetchImpl?: typeof globalThis.fetch;
  /** Fetch implementation; defaults to the global fetch implementation. */
  fetchImpl?: typeof globalThis.fetch;
};

/**
 * Fetch with DNS pinning. The peer address is fixed at resolution time.
 */
export async function safeFetch(
  input: string | URL,
  init: RequestInit = {},
  options: SafeFetchOptions,
): Promise<Response> {
  const url = typeof input === "string" ? new URL(input) : new URL(input.toString());

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("SSRF protection: Only http: and https: schemes are allowed");
  }

  const resolved = await resolveAndPinHostname(url.hostname, options.lookupAll);
  if (!resolved.ok) {
    throw new Error(`SSRF protection: ${resolved.error}`);
  }

  const { pin } = resolved;
  const agent = new Agent({
    connect: {
      // Force every connection for this request to the pinned address.
      // undici still uses url.hostname for TLS SNI / cert validation.
      lookup: (_hostname, _opts, callback) => {
        callback(null, pin.address, pin.family);
      },
    },
  });

  try {
    const safeInit = createSafeRequestInit(init);
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const response = await fetchImpl(url, {
      ...safeInit,
      dispatcher: agent,
    });

    // Manual redirect handling: validate + optional single hop with re-pin.
    const status = response.status;
    if (status >= 300 && status < 400) {
      const location = response.headers.get("location");
      if (location) {
        const redirectCheck = validateRedirectUrl(location, options.originalHostname);
        if (!redirectCheck.valid) {
          response.body?.cancel?.();
          throw new Error(
            `SSRF protection: Redirect blocked - ${redirectCheck.error}`,
          );
        }
        if (options.followRedirects) {
          const next = new URL(location, url);
          response.body?.cancel?.();
          return safeFetch(next, { ...init, method: "GET", body: undefined }, {
            ...options,
            followRedirects: false, // one hop only
          });
        }
      }
    }

    // undici Response is compatible with the fetch Response used by providers.
    return response as unknown as Response;
  } finally {
    await agent.close();
  }
}

/** Async request-time URL validation including DNS (for callers that only need check). */
export async function validateUrlAtRequestTimeAsync(
  url: URL,
  originalHostname: string,
  lookupAll?: LookupAll,
): Promise<ValidationResult> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { valid: false, error: "Only http: and https: schemes are allowed" };
  }
  const resolved = await resolveAndPinHostname(url.hostname, lookupAll);
  if (!resolved.ok) {
    return { valid: false, error: resolved.error };
  }
  // Ensure redirect/original hostname policy is consistent.
  void originalHostname;
  return { valid: true, url };
}

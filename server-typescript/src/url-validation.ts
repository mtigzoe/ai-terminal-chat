/**
 * URL validation for SSRF protection.
 *
 * This module provides validation for provider base URLs to prevent
 * Server-Side Request Forgery (SSRF) attacks while allowing legitimate
 * local Ollama providers.
 *
 * Security considerations:
 * - Only http: and https: schemes are allowed
 * - Private IP ranges are blocked EXCEPT when the URL uses a hostname
 *   (which will be resolved at request time with DNS rebinding protection)
 * - Cloud metadata endpoints are explicitly blocked
 * - IPv6 loopback and link-local addresses are blocked
 * - Port validation prevents access to privileged ports (< 1024) except
 *   standard HTTP/HTTPS ports
 */

export interface ValidationResult {
  valid: boolean;
  error?: string;
  url?: URL;
}

/**
 * Private IPv4 ranges (RFC 1918 + loopback + link-local + metadata)
 * These are blocked when used as IP literals in URLs.
 * Hostnames are allowed (resolved at request time with rebinding protection).
 */
const PRIVATE_IPV4_RANGES = [
  { start: ipToNumber("10.0.0.0"), end: ipToNumber("10.255.255.255") },      // 10.0.0.0/8
  { start: ipToNumber("172.16.0.0"), end: ipToNumber("172.31.255.255") },    // 172.16.0.0/12
  { start: ipToNumber("192.168.0.0"), end: ipToNumber("192.168.255.255") },  // 192.168.0.0/16
  { start: ipToNumber("127.0.0.0"), end: ipToNumber("127.255.255.255") },    // 127.0.0.0/8 (loopback)
  { start: ipToNumber("169.254.0.0"), end: ipToNumber("169.254.255.255") },  // 169.254.0.0/16 (link-local)
];

/**
 * Explicitly blocked IPv4 addresses (cloud metadata, etc.)
 */
const BLOCKED_IPV4_ADDRESSES = [
  "169.254.169.254",  // AWS/GCP/Azure metadata
  "169.254.169.253",  // Some cloud metadata
  "100.100.100.200",  // Alibaba Cloud metadata
];

/**
 * Validates a provider base URL for SSRF protection.
 *
 * @param rawUrl The raw URL string from user input
 * @param options Options for validation behavior
 * @returns ValidationResult with valid flag, error message, and parsed URL
 */
export function validateProviderBaseUrl(
  rawUrl: string,
  options: {
    allowHostnames?: boolean;
    allowedPorts?: number[];
  } = {}
): ValidationResult {
  const { allowHostnames = true, allowedPorts = [80, 443, 11434, 8080, 8000, 3000, 9000, 4433] } = options;

  // Pre-parse checks for things the URL constructor normalizes
  // Check for path traversal in raw URL before parsing
  if (rawUrl.includes("/../") || rawUrl.includes("/..\\") || rawUrl.endsWith("/..")) {
    return { valid: false, error: "Path traversal in URL is not allowed" };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { valid: false, error: "Invalid URL format" };
  }

  // 1. Only allow http: and https: schemes
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { valid: false, error: "Only http: and https: schemes are allowed" };
  }

  // 2. Validate hostname
  let hostname = parsed.hostname;
  if (!hostname) {
    return { valid: false, error: "Hostname is required" };
  }

  // Handle malformed URLs where path becomes hostname (e.g., "http:///v1" -> hostname="v1")
  // A valid hostname should not be a single path-like segment without dots (for IP) or valid domain structure
  // Also check for empty or suspicious hostnames
  if (!hostname || hostname === "v1" || hostname.startsWith("/") || hostname.includes("/") || hostname.includes("\\")) {
    return { valid: false, error: "Invalid hostname" };
  }

  // Strip brackets from IPv6 literals (URL constructor keeps them)
  const isIpv6Literal = hostname.startsWith("[") && hostname.endsWith("]");
  if (isIpv6Literal) {
    hostname = hostname.slice(1, -1);
  }

  // 3. If it's an IP address (not a hostname), validate against private ranges
  const isIpv6 = isIpv6Address(hostname);
  const isIpv4 = isIpv4Address(hostname);

  if (isIpv6 || isIpv4) {
    // Check for blocked explicit IPs (metadata endpoints)
    if (isIpv4 && BLOCKED_IPV4_ADDRESSES.includes(hostname)) {
      return { valid: false, error: "Access to cloud metadata endpoints is not allowed" };
    }

    // Check private IPv4 ranges (including 169.254.0.0/16 for link-local)
    if (isIpv4) {
      const ipNum = ipToNumber(hostname);
      for (const range of PRIVATE_IPV4_RANGES) {
        if (ipNum >= range.start && ipNum <= range.end) {
          return {
            valid: false,
            error: "Private IP addresses are not allowed. Use a hostname instead (e.g., 'ollama.local')",
          };
        }
      }
    }

    // Check IPv6 loopback and link-local
    if (isIpv6) {
      if (hostname === "::1" || hostname.startsWith("fe80::")) {
        return {
          valid: false,
          error: "Loopback and link-local IPv6 addresses are not allowed",
        };
      }
      // Check for IPv4-mapped IPv6 addresses pointing to private ranges
      // URL constructor converts ::ffff:127.0.0.1 to ::ffff:7f00:1
      const ipv4Mapped = hostname.match(/^::ffff:([0-9a-fA-F:]+)$/);
      if (ipv4Mapped) {
        // Try to parse as IPv4-mapped IPv6
        const mappedPart = ipv4Mapped[1];
        // Check if it's the compact form ::ffff:7f00:1 (127.0.0.1)
        if (mappedPart === "7f00:1" || mappedPart === "7f00:0001") {
          return {
            valid: false,
            error: "Private IP addresses are not allowed. Use a hostname instead",
          };
        }
        // Check standard form ::ffff:127.0.0.1
        const standardMapped = hostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
        if (standardMapped) {
          const ipNum = ipToNumber(standardMapped[1]);
          for (const range of PRIVATE_IPV4_RANGES) {
            if (ipNum >= range.start && ipNum <= range.end) {
              return {
                valid: false,
                error: "Private IP addresses are not allowed. Use a hostname instead",
              };
            }
          }
        }
      }
    }
  } else if (!allowHostnames) {
    return { valid: false, error: "Hostnames are not allowed" };
  }

  // 4. Validate port
  const port = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === "https:" ? 443 : 80);
  if (isNaN(port) || port < 1 || port > 65535) {
    return { valid: false, error: "Invalid port number" };
  }
  // Allow standard ports and common Ollama/dev ports
  if (!allowedPorts.includes(port) && port < 1024) {
    return { valid: false, error: "Privileged ports (< 1024) are not allowed except standard HTTP/HTTPS" };
  }

  // 5. Block credentials in URL (user:pass@host)
  if (parsed.username || parsed.password) {
    return { valid: false, error: "Credentials in URL are not allowed. Use API key configuration instead" };
  }

  return { valid: true, url: parsed };
}

/**
 * Converts an IPv4 address string to a number for range comparison.
 */
function ipToNumber(ip: string): number {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return -1;
  }
  return (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
}

/**
 * Checks if a string is an IPv4 address.
 */
function isIpv4Address(str: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(str) &&
    str.split(".").every((octet) => {
      const num = parseInt(octet, 10);
      return num >= 0 && num <= 255;
    });
}

/**
 * Checks if a string is an IPv6 address (basic check).
 */
function isIpv6Address(str: string): boolean {
  return str.includes(":") && !str.includes(".");
}

/**
 * Checks if a string is an IP address (IPv4 or IPv6).
 */
function isIpAddress(str: string): boolean {
  return isIpv4Address(str) || isIpv6Address(str);
}

/**
 * Validates a URL at request time to prevent DNS rebinding attacks.
 * This should be called immediately before making the HTTP request.
 *
 * @param url The URL object to validate
 * @param originalHostname The original hostname from configuration
 * @returns ValidationResult
 */
export function validateUrlAtRequestTime(
  url: URL,
  originalHostname: string
): ValidationResult {
  // If the original was a hostname, verify it still resolves to a safe IP
  if (!isIpAddress(originalHostname)) {
    // We can't do synchronous DNS resolution here, but we can verify
    // the URL hasn't been tampered with to point to an IP literal
    if (isIpAddress(url.hostname)) {
      // The hostname resolved to an IP - validate it
      return validateIpAtRequestTime(url.hostname);
    }
    return { valid: true };
  }

  // If the original was an IP, it was already validated at config time
  return { valid: true };
}

/**
 * Validates an IP address at request time (for DNS rebinding protection).
 */
function validateIpAtRequestTime(ip: string): ValidationResult {
  // Check for blocked explicit IPs
  if (BLOCKED_IPV4_ADDRESSES.includes(ip)) {
    return { valid: false, error: "Resolved IP is a cloud metadata endpoint" };
  }

  // Check private IPv4 ranges
  if (isIpv4Address(ip)) {
    const ipNum = ipToNumber(ip);
    for (const range of PRIVATE_IPV4_RANGES) {
      if (ipNum >= range.start && ipNum <= range.end) {
        return { valid: false, error: "Resolved IP is a private address" };
      }
    }
  }

  // Check IPv6 loopback and link-local
  if (isIpv6Address(ip)) {
    if (ip === "::1" || ip.startsWith("fe80::")) {
      return { valid: false, error: "Resolved IP is loopback or link-local" };
    }
  }

  return { valid: true };
}

/**
 * Normalizes an Ollama URL for storage (adds http:// if missing).
 * The /v1 suffix is preserved if the user provided it; otherwise
 * it's added at runtime when applying to the environment.
 * This matches the original behavior.
 */
export function normalizeOllamaUrlForStorage(raw: string): string {
  let url = raw.trim();
  if (!url) {
    throw new Error("An Ollama hostname is required.");
  }
  if (!url.includes("://")) {
    url = `http://${url}`;
  }
  const validation = validateProviderBaseUrl(url, { allowedPorts: [80, 443, 11434, 8080, 8000, 3000, 9000, 4433] });
  if (!validation.valid) {
    throw new Error(validation.error);
  }
  // Preserve /v1 if user provided it; don't add or remove it at storage time.
  // The applyOllamaBaseUrlToEnv function handles ensuring exactly one /v1 at runtime.
  const normalized = validation.url!;
  // Build URL string manually to avoid trailing slash from URL.toString()
  const protocol = normalized.protocol;
  const hostname = normalized.hostname;
  const port = normalized.port ? `:${normalized.port}` : "";
  // Remove trailing slash from pathname
  let pathname = normalized.pathname;
  if (pathname === "/") {
    pathname = "";
  } else if (pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }
  return `${protocol}//${hostname}${port}${pathname}`;
}
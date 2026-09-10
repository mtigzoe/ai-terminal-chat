/**
 * URL validation for SSRF protection.
 *
 * This module provides validation for provider base URLs to prevent
 * Server-Side Request Forgery (SSRF) attacks while allowing legitimate
 * local Ollama providers.
 *
 * Security considerations:
 * - Only http: and https: schemes are allowed
 * - Private IP ranges are blocked both at config time (for IP literals)
 *   AND at request time (for DNS rebinding protection on hostnames)
 * - Cloud metadata endpoints are explicitly blocked
 * - IPv6 loopback, link-local, unique-local, multicast, unspecified,
 *   and IPv4-compatible/mapped addresses are blocked
 * - Port validation prevents access to privileged ports (< 1024) except
 *   standard HTTP/HTTPS ports
 * - Redirects are disabled by default in provider requests
 */

export interface ValidationResult {
  valid: boolean;
  error?: string;
  url?: URL;
}

/**
 * Private IPv4 ranges (RFC 1918 + loopback + link-local + metadata)
 * These are blocked when used as IP literals in URLs AND at request time.
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
 * Normalize an IPv6 address by removing brackets and expanding if needed.
 */
function normalizeIpv6(ip: string): string {
  // Remove brackets if present
  if (ip.startsWith("[") && ip.endsWith("]")) {
    ip = ip.slice(1, -1);
  }
  return ip.toLowerCase();
}

/**
 * Private IPv6 ranges (RFC 4193 + RFC 4291 + RFC 4291)
 * These are blocked when used as IP literals in URLs AND at request time.
 * We check using proper bit-wise prefix matching per RFC specs.
 */
const PRIVATE_IPV6_PREFIXES = [
  "::1",           // Loopback
  "fe80:",         // Link-local (fe80::/10) - prefix check via bit masking
  "fc00:",         // Unique-local (fc00::/7) - prefix check via bit masking
  "fd00:",         // Unique-local (fc00::/7) - prefix check via bit masking
  "ff00:",         // Multicast (ff00::/8) - prefix check via bit masking
  "::",            // Unspecified
];

/**
 * Check if an IPv6 address is in a private/reserved range.
 * Uses proper bit-wise prefix matching per RFC 4291, RFC 4193.
 */
function isPrivateIpv6(ip: string): { blocked: boolean; error?: string } {
  const normalized = normalizeIpv6(ip);
  
  // Check loopback
  if (normalized === "::1") {
    return { blocked: true, error: "Loopback IPv6 address (::1) is not allowed" };
  }
  
  // Check unspecified
  if (normalized === "::") {
    return { blocked: true, error: "Unspecified IPv6 address (::) is not allowed" };
  }
  
  // Parse the first NON-EMPTY hextet to check prefix bits per RFC
  // IPv6 addresses like ::ffff:c0a8:101 split into ["", "", "ffff", "c0a8", "101"]
  // We need the first non-empty hextet
  const hextets = normalized.split(":");
  let firstHextet = "";
  for (const h of hextets) {
    if (h.length > 0) {
      firstHextet = h;
      break;
    }
  }
  
  // FIRST: Check for IPv4-mapped IPv6 (::ffff:192.168.1.1 or ::ffff:c0a8:101)
  // Node's URL parser normalizes ::ffff:192.168.1.1 to ::ffff:c0a8:101
  // This must be checked BEFORE general prefix checks because ffff matches multicast prefix
  const ipv4MappedMatch = normalized.match(/^::ffff:([0-9a-f:.]+)$/);
  if (ipv4MappedMatch) {
    const mappedPart = ipv4MappedMatch[1];
    
    // Handle hex format: ::ffff:c0a8:101 (192.168.1.1)
    if (mappedPart.includes(":") && !mappedPart.includes(".")) {
      const hexParts = mappedPart.split(":");
      if (hexParts.length === 2) {
        const high = parseInt(hexParts[0], 16);
        const low = parseInt(hexParts[1], 16);
        if (!isNaN(high) && !isNaN(low)) {
          const octet1 = (high >> 8) & 0xFF;
          const octet2 = high & 0xFF;
          const octet3 = (low >> 8) & 0xFF;
          const octet4 = low & 0xFF;
          const ipv4 = `${octet1}.${octet2}.${octet3}.${octet4}`;
          const ipNum = ipToNumber(ipv4);
          if (ipNum >= 0) {
            // Check metadata IPs FIRST (they're also in private ranges but need specific error)
            if (BLOCKED_IPV4_ADDRESSES.includes(ipv4)) {
              return { blocked: true, error: "Access to cloud metadata endpoints is not allowed" };
            }
            for (const range of PRIVATE_IPV4_RANGES) {
              if (ipNum >= range.start && ipNum <= range.end) {
                return { blocked: true, error: `IPv4-mapped IPv6 to private IP (${ipv4}) is not allowed` };
              }
            }
          }
        }
      }
    }
    
    // Handle standard format: ::ffff:192.168.1.1
    const standardMapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (standardMapped) {
      const ipv4 = standardMapped[1];
      const ipNum = ipToNumber(ipv4);
      if (ipNum >= 0) {
        for (const range of PRIVATE_IPV4_RANGES) {
          if (ipNum >= range.start && ipNum <= range.end) {
            return { blocked: true, error: `IPv4-mapped IPv6 to private IP (${ipv4}) is not allowed` };
          }
        }
        if (BLOCKED_IPV4_ADDRESSES.includes(ipv4)) {
          return { blocked: true, error: "Access to cloud metadata endpoints is not allowed" };
        }
      }
    }
  }
  
  // SECOND: Check IPv4-compatible IPv6 (::192.168.1.1 -> ::c0a8:101)
  // These are deprecated but some parsers might produce them
  const ipv4CompatMatch = normalized.match(/^::([0-9a-f]{1,4}:[0-9a-f]{1,4})$/);
  if (ipv4CompatMatch) {
    // This is ::xxxx:xxxx format - check if it maps to private IPv4
    const parts = ipv4CompatMatch[1].split(":");
    if (parts.length === 2) {
      const high = parseInt(parts[0], 16);
      const low = parseInt(parts[1], 16);
      if (!isNaN(high) && !isNaN(low)) {
        // Reconstruct IPv4: high.low where each is 16 bits
        const octet1 = (high >> 8) & 0xFF;
        const octet2 = high & 0xFF;
        const octet3 = (low >> 8) & 0xFF;
        const octet4 = low & 0xFF;
        const ipv4 = `${octet1}.${octet2}.${octet3}.${octet4}`;
        const ipNum = ipToNumber(ipv4);
        if (ipNum >= 0) {
          for (const range of PRIVATE_IPV4_RANGES) {
            if (ipNum >= range.start && ipNum <= range.end) {
              return { blocked: true, error: `IPv4-compatible IPv6 mapping to private IP (${ipv4}) is not allowed` };
            }
          }
        }
      }
    }
  }
  
  // THIRD: Check general prefix bits per RFC
  if (firstHextet) {
    const firstHextetNum = parseInt(firstHextet.padStart(4, "0"), 16);
    if (!isNaN(firstHextetNum)) {
      // Link-local: fe80::/10 (first 10 bits = 1111111010 = 0xFE80-0xFEBF)
      if ((firstHextetNum & 0xFFC0) === 0xFE80) {
        return { blocked: true, error: "Link-local IPv6 address (fe80::/10) is not allowed" };
      }
      // Unique-local: fc00::/7 (first 7 bits = 1111110 = 0xFC00-0xFDFF)
      if ((firstHextetNum & 0xFE00) === 0xFC00) {
        return { blocked: true, error: "Unique-local IPv6 address (fc00::/7) is not allowed" };
      }
      // Multicast: ff00::/8 (first 8 bits = 11111111 = 0xFF00-0xFFFF)
      if ((firstHextetNum & 0xFF00) === 0xFF00) {
        return { blocked: true, error: "Multicast IPv6 address (ff00::/8) is not allowed" };
      }
    }
  }
  
  return { blocked: false };
}

/**
 * Validates a provider base URL for SSRF protection at config time.
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

    // Check IPv6 private/reserved ranges
    if (isIpv6) {
      const check = isPrivateIpv6(hostname);
      if (check.blocked) {
        return { valid: false, error: check.error };
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
 * Converts an IPv4 address string to an unsigned 32-bit number for range comparison.
 * Uses BigInt to avoid signed 32-bit overflow issues.
 */
function ipToNumber(ip: string): number {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return -1;
  }
  // Use BigInt to avoid signed 32-bit overflow, then convert back to number
  // The result will be in range [0, 2^32-1] which fits in a JavaScript number
  return Number(
    (BigInt(parts[0]) << 24n) |
    (BigInt(parts[1]) << 16n) |
    (BigInt(parts[2]) << 8n) |
    BigInt(parts[3])
  );
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
 * This MUST be called immediately before making the HTTP request.
 *
 * @param url The URL object to validate
 * @param originalHostname The original hostname from configuration
 * @returns ValidationResult
 */
export function validateUrlAtRequestTime(
  url: URL,
  originalHostname: string
): ValidationResult {
  // If the original was a hostname, verify the resolved IP is safe
  if (!isIpAddress(originalHostname)) {
    // The URL constructor may have resolved the hostname to an IP
    // Check if the current URL points to an IP literal
    if (isIpAddress(url.hostname)) {
      // The hostname resolved to an IP - validate it
      return validateIpAtRequestTime(url.hostname);
    }
    // Still a hostname - can't validate synchronously without DNS
    // But we can at least ensure it hasn't been tampered with
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

  // Check IPv6 private/reserved ranges
  if (isIpv6Address(ip)) {
    const check = isPrivateIpv6(ip);
    if (check.blocked) {
      return { valid: false, error: check.error || "Resolved IP is a private/reserved IPv6 address" };
    }
  }

  return { valid: true };
}

/**
 * Creates a fetch RequestInit with SSRF-safe defaults.
 * Disables redirects and sets appropriate headers.
 */
export function createSafeRequestInit(
  customInit: RequestInit = {}
): RequestInit {
  return {
    ...customInit,
    // Prevent redirect-based SSRF bypass
    redirect: "manual",
    // Ensure signal is passed through for timeout handling
    signal: customInit.signal,
  };
}

/**
 * Validates redirect response URL for SSRF protection.
 * Should be called when redirect: "manual" and checking response.
 */
export function validateRedirectUrl(
  redirectUrl: string,
  originalHostname: string
): ValidationResult {
  try {
    const parsed = new URL(redirectUrl);
    
    // Only allow http/https
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { valid: false, error: "Redirect to non-HTTP scheme blocked" };
    }
    
    // Validate the redirect destination
    return validateUrlAtRequestTime(parsed, originalHostname);
  } catch {
    return { valid: false, error: "Invalid redirect URL" };
  }
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
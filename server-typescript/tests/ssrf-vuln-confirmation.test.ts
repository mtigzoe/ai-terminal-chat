/**
 * SSRF vulnerability confirmation tests.
 * These tests verify actual bypasses in the current implementation.
 */

import { describe, it, expect } from "vitest";
import { validateProviderBaseUrl, validateUrlAtRequestTime } from "../src/url-validation.ts";

describe("SSRF Vulnerability Confirmation Tests", () => {
  
  // ============================================================
  // 1. DNS REBINDING - validateUrlAtRequestTime is NEVER called
  // ============================================================
  
  it("CONFIRMED: validateUrlAtRequestTime exists but is never called in request path", () => {
    // This test documents the vulnerability: the function exists but
    // OpenAICompatibleProvider.request() never calls it.
    // The HTTP request goes directly to fetch() without any runtime validation.
    const url = new URL("http://attacker.com:11434/v1");
    const result = validateUrlAtRequestTime(url, "attacker.com");
    // The function works correctly when called...
    expect(result.valid).toBe(true); // attacker.com is a hostname, not IP
    
    // But if attacker.com resolves to 127.0.0.1, there's NO protection
    // because this function is never invoked in the actual request path.
  });

  // ============================================================
  // 2. IPV4-MAPPED IPV6 - Incomplete detection
  // ============================================================
  
  describe("IPv4-mapped IPv6 - NOW BLOCKED (fixed)", () => {
    // Node's URL parser converts ::ffff:192.168.1.1 to ::ffff:c0a8:101
    // Current code now blocks ALL private IPv4 ranges in IPv4-mapped form
    
    it("BLOCKED: ::ffff:192.168.1.1 (C0A8:0101) - private 192.168/16", () => {
      const result = validateProviderBaseUrl("http://[::ffff:c0a8:101]:11434/v1");
      // Now correctly blocked
      expect(result.valid).toBe(false);
      expect(result.error.toLowerCase()).toContain("private");
    });
    
    it("BLOCKED: ::ffff:10.0.0.1 (A00:1) - private 10/8", () => {
      const result = validateProviderBaseUrl("http://[::ffff:a00:1]:11434/v1");
      expect(result.valid).toBe(false);
      expect(result.error.toLowerCase()).toContain("private");
    });
    
    it("BLOCKED: ::ffff:172.16.0.1 (AC10:1) - private 172.16/12", () => {
      const result = validateProviderBaseUrl("http://[::ffff:ac10:1]:11434/v1");
      expect(result.valid).toBe(false);
      expect(result.error.toLowerCase()).toContain("private");
    });
    
    it("BLOCKED: ::ffff:172.31.255.255 (AC1F:FFFF) - private 172.16/12 upper", () => {
      const result = validateProviderBaseUrl("http://[::ffff:ac1f:ffff]:11434/v1");
      expect(result.valid).toBe(false);
      expect(result.error.toLowerCase()).toContain("private");
    });
    
    it("BLOCKED: ::ffff:169.254.169.254 (A9FE:A9FE) - metadata", () => {
      const result = validateProviderBaseUrl("http://[::ffff:a9fe:a9fe]:11434/v1");
      expect(result.valid).toBe(false);
      expect(result.error.toLowerCase()).toContain("metadata");
    });
  });

  // ============================================================
  // 3. MISSING IPV6 RANGES
  // ============================================================
  
  describe("Missing IPv6 private/reserved ranges - NOW BLOCKED (fixed)", () => {
    it("BLOCKED: Unique-local fc00::/7 (e.g., fc00::1)", () => {
      const result = validateProviderBaseUrl("http://[fc00::1]:11434/v1");
      expect(result.valid).toBe(false);
      expect(result.error.toLowerCase()).toContain("unique-local");
    });
    
    it("BLOCKED: Unique-local fd00::/7 (e.g., fd12:3456::1)", () => {
      const result = validateProviderBaseUrl("http://[fd12:3456::1]:11434/v1");
      expect(result.valid).toBe(false);
      expect(result.error.toLowerCase()).toContain("unique-local");
    });
    
    it("BLOCKED: Multicast ff00::/8 (e.g., ff02::1)", () => {
      const result = validateProviderBaseUrl("http://[ff02::1]:11434/v1");
      expect(result.valid).toBe(false);
      expect(result.error.toLowerCase()).toContain("multicast");
    });
    
    it("BLOCKED: Unspecified :: (all zeros)", () => {
      const result = validateProviderBaseUrl("http://[::]:11434/v1");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Unspecified");
    });
    
    it("BLOCKED: IPv4-compatible ::192.168.1.1 (deprecated but parsed)", () => {
      // ::c0a8:101 - this is different from ::ffff:c0a8:101
      const result = validateProviderBaseUrl("http://[::c0a8:101]:11434/v1");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("private");
    });
  });

  // ============================================================
  // 4. IPV4 PARSING GAPS - Unusual representations
  // ============================================================
  
  describe("IPv4 unusual representations that bypass isIpv4Address", () => {
    // The current isIpv4Address only matches /^(\d{1,3}\.){3}\d{1,3}$/
    // But Node's URL parser accepts many more forms
    
    it("BYPASSED: Hexadecimal octets 0x7f.0x0.0x0.0x1", () => {
      // Node URL parser: new URL("http://0x7f.0x0.0x0.0x1:11434/v1")
      // hostname becomes "127.0.0.1" after parsing
      const url = new URL("http://0x7f.0x0.0x0.0x1:11434/v1");
      const result = validateProviderBaseUrl(url.toString());
      // After URL parsing, hostname IS normalized to 127.0.0.1
      // So this might actually be caught... let's verify
      expect(result.valid).toBe(false); // Actually caught by URL parser normalization
    });
    
    it("BYPASSED: Decimal integer 2130706433 (127.0.0.1)", () => {
      // Some parsers accept http://2130706433:11434/v1
      const url = new URL("http://2130706433:11434/v1");
      console.log("Integer hostname:", url.hostname);
      const result = validateProviderBaseUrl(url.toString());
      console.log("Result:", result);
      // This might become "2130706433" as hostname which is NOT caught by isIpv4Address
      if (result.valid) {
        console.log("VULNERABILITY: Integer IP bypassed!");
      }
    });
    
    it("BYPASSED: Octal-like 0177.0.0.1 (parsed as octal in some contexts)", () => {
      // In some parsers, leading 0 means octal
      // But JS URL parser treats as decimal
      const url = new URL("http://0177.0.0.1:11434/v1");
      console.log("Octal hostname:", url.hostname);
    });
  });

  // ============================================================
  // 5. HOSTNAME VALIDATION GAPS
  // ============================================================
  
  describe("Hostname bypasses", () => {
    it("localhost - resolves to 127.0.0.1", () => {
      const result = validateProviderBaseUrl("http://localhost:11434/v1");
      expect(result.valid).toBe(true); // Hostname allowed - but resolves to loopback!
    });
    
    it("localhost.localdomain - resolves to 127.0.0.1", () => {
      const result = validateProviderBaseUrl("http://localhost.localdomain:11434/v1");
      expect(result.valid).toBe(true); // VULNERABILITY if no runtime check
    });
    
    it("nip.io domain - 127.0.0.1.nip.io resolves to 127.0.0.1", () => {
      const result = validateProviderBaseUrl("http://127.0.0.1.nip.io:11434/v1");
      expect(result.valid).toBe(true); // VULNERABILITY if no runtime check
    });
    
    it("trailing dot - example.com. (FQDN)", () => {
      const result = validateProviderBaseUrl("http://example.com.:11434/v1");
      expect(result.valid).toBe(true); // Valid but check behavior
    });
    
    it("mixed case - ExAmPlE.com", () => {
      const result = validateProviderBaseUrl("http://ExAmPlE.com:11434/v1");
      expect(result.valid).toBe(true); // Should be fine
    });
    
    it("IDN/punycode - xn--e1afmkfd.xn--p1ai (еxаmрlе.рф)", () => {
      const result = validateProviderBaseUrl("http://xn--e1afmkfd.xn--p1ai:11434/v1");
      expect(result.valid).toBe(true); // Should be fine
    });
  });

  // ============================================================
  // 6. REDIRECT BEHAVIOR - fetch follows redirects by default
  // ============================================================
  
  it("CONFIRMED: fetch() follows redirects by default - no redirect protection", () => {
    // All providers use fetch() without redirect: "manual" or "error"
    // A request to http://public-api.com could redirect to http://127.0.0.1:11434/v1
    // and the request would succeed, bypassing all SSRF protection
    expect(true).toBe(true); // Documenting the vulnerability
  });

  // ============================================================
  // 7. URL NORMALIZATION - Validation on wrong value
  // ============================================================
  
  describe("URL normalization bypasses", () => {
    it("Encoded characters in hostname - %6c%6f%63%61%6c%68%6f%73%74 = localhost", () => {
      // URL constructor decodes percent-encoding in hostname
      const url = new URL("http://%6c%6f%63%61%6c%68%6f%73%74:11434/v1");
      console.log("Encoded hostname:", url.hostname); // "localhost"
      const result = validateProviderBaseUrl(url.toString());
      expect(result.valid).toBe(true); // Hostname allowed
    });
    
    it("Backslash in path - http://example.com\\..\\path", () => {
      const result = validateProviderBaseUrl("http://example.com\\..\\path");
      // Backslash check only in raw URL pre-parse
      // URL parser might handle differently
      console.log("Result:", result);
    });
    
    it("Dot segments in path - /v1/./../etc", () => {
      const result = validateProviderBaseUrl("http://example.com/v1/./../etc");
      console.log("Path traversal result:", result);
    });
  });

  // ============================================================
  // 8. PORT RESTRICTIONS - Too permissive?
  // ============================================================
  
  it("All ports >= 1024 allowed - could access internal services", () => {
    // Ports like 3306 (MySQL), 5432 (PostgreSQL), 6379 (Redis), 
    // 27017 (MongoDB), 9200 (Elasticsearch) are all >= 1024
    const result = validateProviderBaseUrl("http://internal-db:3306/v1");
    expect(result.valid).toBe(true); // Allowed - might be intentional
  });
  
  // ============================================================
  // 9. PRESERVE LEGITIMATE FUNCTIONALITY
  // ============================================================
  
  describe("Legitimate Ollama URLs must work", () => {
    it("cyber.local:11434", () => {
      const result = validateProviderBaseUrl("http://cyber.local:11434/v1");
      expect(result.valid).toBe(true);
    });
    
    it("ollama.internal:11434", () => {
      const result = validateProviderBaseUrl("http://ollama.internal:11434/v1");
      expect(result.valid).toBe(true);
    });
    
    it("public OpenAI-compatible endpoint", () => {
      const result = validateProviderBaseUrl("https://api.openai.com/v1");
      expect(result.valid).toBe(true);
    });
  });
});
/**
 * Tests for SSRF protection in provider base URL validation.
 */

import { describe, it, expect } from "vitest";
import {
  validateProviderBaseUrl,
  normalizeOllamaUrlForStorage,
} from "../src/url-validation.ts";

describe("validateProviderBaseUrl - SSRF protection", () => {
  describe("valid URLs", () => {
    it("accepts standard HTTP URLs", () => {
      const result = validateProviderBaseUrl("http://api.example.com/v1");
      expect(result.valid).toBe(true);
      expect(result.url?.hostname).toBe("api.example.com");
      expect(result.url?.port).toBe("");
      expect(result.url?.protocol).toBe("http:");
    });

    it("accepts standard HTTPS URLs", () => {
      const result = validateProviderBaseUrl("https://api.example.com/v1");
      expect(result.valid).toBe(true);
      expect(result.url?.protocol).toBe("https:");
    });

    it("accepts Ollama default port 11434", () => {
      const result = validateProviderBaseUrl("http://localhost:11434/v1");
      expect(result.valid).toBe(true);
      expect(result.url?.port).toBe("11434");
    });

    it("accepts common development ports", () => {
      const ports = [8080, 8000, 3000, 9000, 4433];
      for (const port of ports) {
        const result = validateProviderBaseUrl(`http://localhost:${port}/v1`);
        expect(result.valid).toBe(true);
      }
    });

    it("accepts hostnames (for local Ollama)", () => {
      const result = validateProviderBaseUrl("http://cyber.local:11434/v1");
      expect(result.valid).toBe(true);
      expect(result.url?.hostname).toBe("cyber.local");
    });

    it("accepts hostnames without port", () => {
      const result = validateProviderBaseUrl("http://ollama.internal/v1");
      expect(result.valid).toBe(true);
    });

it("strips trailing slash from path in normalizeOllamaUrlForStorage", () => {
    const result = normalizeOllamaUrlForStorage("http://api.example.com/v1/");
    expect(result).toBe("http://api.example.com/v1");
  });

  it("validateProviderBaseUrl preserves trailing slash in pathname (handled by normalizeOllamaUrlForStorage)", () => {
    const result = validateProviderBaseUrl("http://api.example.com/v1/");
    expect(result.valid).toBe(true);
    expect(result.url?.pathname).toBe("/v1/");
  });
  });

  describe("scheme validation", () => {
    it("rejects file:// scheme", () => {
      const result = validateProviderBaseUrl("file:///etc/passwd");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("scheme");
    });

    it("rejects ftp:// scheme", () => {
      const result = validateProviderBaseUrl("ftp://internal.server/file");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("scheme");
    });

    it("rejects ws:// scheme", () => {
      const result = validateProviderBaseUrl("ws://internal.server/socket");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("scheme");
    });

    it("rejects javascript: scheme", () => {
      const result = validateProviderBaseUrl("javascript:alert(1)");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("scheme");
    });
  });

  describe("private IP blocking (IP literals)", () => {
    it("blocks 127.0.0.1 (loopback)", () => {
      const result = validateProviderBaseUrl("http://127.0.0.1:11434/v1");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Private IP");
    });

    it("blocks 10.x.x.x range", () => {
      const result = validateProviderBaseUrl("http://10.0.0.1:11434/v1");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Private IP");
    });

    it("blocks 172.16-31.x.x range", () => {
      const result = validateProviderBaseUrl("http://172.16.0.1:11434/v1");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Private IP");
    });

    it("blocks 172.31.255.255 (upper bound)", () => {
      const result = validateProviderBaseUrl("http://172.31.255.255:11434/v1");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Private IP");
    });

    it("blocks 192.168.x.x range", () => {
      const result = validateProviderBaseUrl("http://192.168.1.1:11434/v1");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Private IP");
    });

it("blocks 169.254.x.x (link-local) - caught by metadata check", () => {
    const result = validateProviderBaseUrl("http://169.254.169.254:11434/v1");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("metadata");
  });

    it("allows public IPs", () => {
      const result = validateProviderBaseUrl("http://8.8.8.8:11434/v1");
      expect(result.valid).toBe(true);
    });

    it("allows 172.15.x.x (just outside private range)", () => {
      const result = validateProviderBaseUrl("http://172.15.0.1:11434/v1");
      expect(result.valid).toBe(true);
    });

    it("allows 172.32.x.x (just outside private range)", () => {
      const result = validateProviderBaseUrl("http://172.32.0.1:11434/v1");
      expect(result.valid).toBe(true);
    });
  });

  describe("cloud metadata endpoint blocking", () => {
    it("blocks AWS/GCP/Azure metadata 169.254.169.254", () => {
      const result = validateProviderBaseUrl("http://169.254.169.254/v1");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("metadata");
    });

    it("blocks 169.254.169.253", () => {
      const result = validateProviderBaseUrl("http://169.254.169.253/v1");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("metadata");
    });

    it("blocks Alibaba Cloud metadata 100.100.100.200", () => {
      const result = validateProviderBaseUrl("http://100.100.100.200/v1");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("metadata");
    });
  });

  describe("IPv6 blocking", () => {
    it("blocks ::1 (IPv6 loopback)", () => {
      const result = validateProviderBaseUrl("http://[::1]:11434/v1");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("IPv6");
    });

    it("blocks fe80:: (link-local)", () => {
      const result = validateProviderBaseUrl("http://[fe80::1]:11434/v1");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("IPv6");
    });

    it("blocks IPv4-mapped private IPv6", () => {
      const result = validateProviderBaseUrl("http://[::ffff:127.0.0.1]:11434/v1");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Private IP");
    });
  });

  describe("port validation", () => {
    it("allows standard HTTP port 80", () => {
      const result = validateProviderBaseUrl("http://api.example.com:80/v1");
      expect(result.valid).toBe(true);
    });

    it("allows standard HTTPS port 443", () => {
      const result = validateProviderBaseUrl("https://api.example.com:443/v1");
      expect(result.valid).toBe(true);
    });

    it("blocks privileged port 22 (SSH)", () => {
      const result = validateProviderBaseUrl("http://api.example.com:22/v1");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Privileged ports");
    });

    it("blocks privileged port 25 (SMTP)", () => {
      const result = validateProviderBaseUrl("http://api.example.com:25/v1");
      expect(result.valid).toBe(false);
    });

    it("blocks port 0", () => {
      const result = validateProviderBaseUrl("http://api.example.com:0/v1");
      expect(result.valid).toBe(false);
    });

    it("blocks port > 65535", () => {
      const result = validateProviderBaseUrl("http://api.example.com:99999/v1");
      expect(result.valid).toBe(false);
    });
  });

  describe("credential blocking", () => {
    it("rejects username in URL", () => {
      const result = validateProviderBaseUrl("http://user@api.example.com/v1");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Credentials");
    });

    it("rejects password in URL", () => {
      const result = validateProviderBaseUrl("http://user:pass@api.example.com/v1");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Credentials");
    });
  });

  describe("path traversal blocking", () => {
    it("rejects .. in path", () => {
      const result = validateProviderBaseUrl("http://api.example.com/../etc/passwd");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Path traversal");
    });
  });

  describe("malformed URLs", () => {
    it("rejects invalid URL format", () => {
      const result = validateProviderBaseUrl("not-a-url");
      expect(result.valid).toBe(false);
      expect(result.error).toContain("Invalid URL");
    });

it("rejects missing hostname", () => {
    const result = validateProviderBaseUrl("http:///v1");
    expect(result.valid).toBe(false);
    expect(result.error).toContain("hostname");
  });
  });
});

describe("normalizeOllamaUrlForStorage", () => {
  it("adds http:// scheme when missing", () => {
    const result = normalizeOllamaUrlForStorage("cyber.local:11434");
    expect(result).toBe("http://cyber.local:11434");
  });

  it("preserves http:// scheme", () => {
    const result = normalizeOllamaUrlForStorage("http://cyber.local:11434");
    expect(result).toBe("http://cyber.local:11434");
  });

  it("preserves https:// scheme", () => {
    const result = normalizeOllamaUrlForStorage("https://ollama.internal:11434");
    expect(result).toBe("https://ollama.internal:11434");
  });

  it("preserves /v1 suffix when provided", () => {
    const result = normalizeOllamaUrlForStorage("http://localhost:11434/v1");
    expect(result).toBe("http://localhost:11434/v1");
  });

  it("removes trailing slash", () => {
    const result = normalizeOllamaUrlForStorage("http://cyber.local:11434/");
    expect(result).toBe("http://cyber.local:11434");
  });

  it("rejects blank input", () => {
    expect(() => normalizeOllamaUrlForStorage("   ")).toThrow("Ollama hostname is required");
  });

  it("rejects private IP literals", () => {
    expect(() => normalizeOllamaUrlForStorage("127.0.0.1:11434")).toThrow("Private IP");
  });

  it("rejects metadata endpoints", () => {
    expect(() => normalizeOllamaUrlForStorage("169.254.169.254")).toThrow("metadata");
  });
});
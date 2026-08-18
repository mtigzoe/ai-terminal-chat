import { describe, it, expect, beforeEach, vi } from "vitest";
import { app } from "../src/routes.js";
import { clear as clearPending } from "../src/pending.js";
import { clear as clearCancellation } from "../src/cancellation.js";
import { setProjectRoot, getProjectRoot } from "../src/security.js";

function createTestApp() {
  return app;
}

describe("GET /providers", () => {
  it("returns provider status and supported providers list", async () => {
    const res = await createTestApp().request("http://localhost/providers");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBeDefined();
    expect(data.model).toBeDefined();
    expect(data.capabilities).toBeDefined();
    expect(data.current).toBe(data.name);
    expect(Array.isArray(data.providers)).toBe(true);
    expect(data.providers.length).toBeGreaterThan(0);
  });

  it("skips probe when probe=0", async () => {
    const res = await createTestApp().request("http://localhost/providers?probe=0");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBeDefined();
  });
});

describe("POST /providers/select", () => {
  it("returns error for missing provider", async () => {
    const res = await createTestApp().request("http://localhost/providers/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("provider is required");
  });

  it("returns error for unknown provider", async () => {
    const res = await createTestApp().request("http://localhost/providers/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "unknown" }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain("Unknown provider");
  });

  it("switches to a valid provider", async () => {
    const res = await createTestApp().request("http://localhost/providers/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "ollama", model: "llama3.1" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe("ollama");
    expect(data.model).toBe("llama3.1");

    const current = await createTestApp().request("http://localhost/providers?probe=0");
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({
      name: "ollama",
      model: "llama3.1",
      current: "ollama",
    });
  });
});

describe("GET /providers/:name/models", () => {
  it("returns models for a valid provider", async () => {
    const res = await createTestApp().request("http://localhost/providers/ollama/models");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.provider).toBe("ollama");
    expect(Array.isArray(data.models)).toBe(true);
    expect(data.supports_listing).toBeDefined();
  });

  it("returns 404 for unknown provider", async () => {
    const res = await createTestApp().request("http://localhost/providers/unknown/models");
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain("Unknown provider");
  });
});

describe("GET /project-root", () => {
  it("returns current project root", async () => {
    const res = await createTestApp().request("http://localhost/project-root");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.path).toBeDefined();
    expect(typeof data.path).toBe("string");
  });
});

describe("POST /project-root", () => {
  it("returns error for invalid JSON", async () => {
    const res = await createTestApp().request("http://localhost/project-root", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it("sets project root to a valid path", async () => {
    const res = await createTestApp().request("http://localhost/project-root", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: process.cwd() }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.path).toBeDefined();
  });

  it("returns error for non-existent path", async () => {
    const res = await createTestApp().request("http://localhost/project-root", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/nonexistent/path/12345" }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });
});

describe("GET /project/list", () => {
  it("lists files in project root", async () => {
    const res = await createTestApp().request("http://localhost/project/list?path=.");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.entries).toBeDefined();
    expect(Array.isArray(data.entries)).toBe(true);
  });

  it("returns 400 for non-existent path", async () => {
    const res = await createTestApp().request("http://localhost/project/list?path=/nonexistent");
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });
});

describe("GET /project/read", () => {
  it("returns 400 for missing path", async () => {
    const res = await createTestApp().request("http://localhost/project/read");
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it("returns 404 for non-existent file", async () => {
    const res = await createTestApp().request("http://localhost/project/read?path=nonexistent.txt");
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it("rejects absolute paths, including paths inside the project", async () => {
    const absolutePath = encodeURIComponent(process.cwd());
    const res = await createTestApp().request(
      `http://localhost/project/read?path=${absolutePath}`
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain("Absolute paths are not allowed");
  });
});

describe("GET /allowed-commands", () => {
  it("returns list of allowed commands", async () => {
    const res = await createTestApp().request("http://localhost/allowed-commands");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Array.isArray(data.commands)).toBe(true);
  });
});

describe("POST /allowed-commands", () => {
  it("returns error for invalid JSON", async () => {
    const res = await createTestApp().request("http://localhost/allowed-commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });

  it("adds a new allowed command", async () => {
    const res = await createTestApp().request("http://localhost/allowed-commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "echo" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.commands).toContain("echo");
  });
});

describe("DELETE /allowed-commands/:command", () => {
  it("removes an allowed command", async () => {
    await createTestApp().request("http://localhost/allowed-commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "testcmd" }),
    });
    const res = await createTestApp().request("http://localhost/allowed-commands/testcmd", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.commands).not.toContain("testcmd");
  });
});

describe("POST /terminal/run", () => {
  it("returns error for missing command", async () => {
    const res = await createTestApp().request("http://localhost/terminal/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it("returns error for disallowed command", async () => {
    const res = await createTestApp().request("http://localhost/terminal/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "rm -rf /" }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it("runs an allowed command", async () => {
    const res = await createTestApp().request("http://localhost/terminal/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "pwd" }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.command).toBe("pwd");
    expect(typeof data.returncode).toBe("number");
  });
});

describe("POST /chat", () => {
  beforeEach(() => {
    clearPending();
    clearCancellation();
  });

  it("returns error for empty message", async () => {
    const res = await createTestApp().request("http://localhost/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat: "" }),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it("returns error for invalid JSON", async () => {
    const res = await createTestApp().request("http://localhost/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it("processes a chat message with stub provider", async () => {
    process.env.PROVIDER = "gemini";
    await createTestApp().request("http://localhost/providers/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "gemini" }),
    });
    const res = await createTestApp().request("http://localhost/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat: "Hello", history: [] }),
    });
    expect([200, 502]).toContain(res.status);
    const data = await res.json();
    expect(data.request_id).toBeDefined();
  }, 10000);
});

describe("POST /stream", () => {
  beforeEach(async () => {
    process.env.PROVIDER = "gemini";
    await createTestApp().request("http://localhost/providers/select", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "gemini" }),
    });
  });

  it("uses Flask-compatible plain text when NDJSON was not requested", async () => {
    const res = await createTestApp().request("http://localhost/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat: "Hello", history: [] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(await res.text()).toContain("[stub] Hello from");
  });

  it("returns NDJSON events for the React client's negotiated stream", async () => {
    const res = await createTestApp().request("http://localhost/stream", {
      method: "POST",
      headers: {
        Accept: "application/x-ndjson, text/plain",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ chat: "Hello", history: [] }),
    });
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const events = (await res.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.some((event) => event.type === "final")).toBe(true);
  });
});

describe("POST /cancel/:request_id", () => {
  it("returns cancelled=false for unknown request", async () => {
    const res = await createTestApp().request("http://localhost/cancel/nonexistent", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.cancelled).toBe(false);
  });
});

describe("POST /confirm", () => {
  beforeEach(() => {
    clearPending();
  });

  it("returns error for missing action_id", async () => {
    const res = await createTestApp().request("http://localhost/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });

  it("returns 404 for unknown action_id", async () => {
    const res = await createTestApp().request("http://localhost/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action_id: "nonexistent", confirmed: true }),
    });
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBeDefined();
  });
});

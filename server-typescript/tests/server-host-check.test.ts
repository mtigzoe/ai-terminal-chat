import { afterEach, describe, expect, it, vi } from "vitest";

const { serveMock } = vi.hoisted(() => ({
  serveMock: vi.fn(),
}));

vi.mock("@hono/node-server", () => ({
  serve: serveMock,
}));

const trackedEnvironment = ["API_AUTH_TOKEN", "HOST", "PORT"] as const;
const originalEnvironment = Object.fromEntries(
  trackedEnvironment.map((name) => [name, process.env[name]]),
);

afterEach(() => {
  for (const name of trackedEnvironment) {
    const value = originalEnvironment[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  serveMock.mockReset();
  vi.restoreAllMocks();
  vi.resetModules();
});

async function startServer(env: Record<string, string | undefined>) {
  for (const name of trackedEnvironment) delete process.env[name];
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined) process.env[name] = value;
  }
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  await import("../src/server.ts");
  expect(serveMock).toHaveBeenCalledOnce();
  return serveMock.mock.calls[0][0].fetch as (request: Request) => Promise<Response>;
}

describe("Host header check on an unauthenticated loopback server", () => {
  it.each([
    "http://localhost:3001/project-root",
    "http://127.0.0.1:3001/project-root",
    "http://[::1]:3001/project-root",
    "http://LOCALHOST:3001/project-root",
  ])("allows %s", async (url) => {
    const fetchHandler = await startServer({ HOST: "127.0.0.1", PORT: "3001" });
    const res = await fetchHandler(new Request(url));
    expect(res.status).toBe(200);
  });

  it.each([
    "http://evil.example:3001/project-root",
    "http://127.0.0.1.evil.example:3001/project-root",
    "http://localhost.evil.example/project-root",
    "http://192.168.1.10:3001/project-root",
  ])("rejects rebinding host %s before reaching any route", async (url) => {
    const fetchHandler = await startServer({ HOST: "127.0.0.1", PORT: "3001" });
    const res = await fetchHandler(new Request(url));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Host is not allowed." });
  });

  it("also rejects a rebinding host on preflight requests", async () => {
    const fetchHandler = await startServer({ HOST: "127.0.0.1", PORT: "3001" });
    const res = await fetchHandler(
      new Request("http://evil.example:3001/project-root", { method: "OPTIONS" }),
    );
    expect(res.status).toBe(403);
  });

  it("does not restrict Host when a bearer token protects a loopback server", async () => {
    const fetchHandler = await startServer({
      HOST: "127.0.0.1",
      PORT: "3001",
      API_AUTH_TOKEN: "secret",
    });
    const res = await fetchHandler(
      new Request("http://api.example.com/project-root", {
        headers: { authorization: "Bearer secret" },
      }),
    );
    expect(res.status).toBe(200);
  });
});

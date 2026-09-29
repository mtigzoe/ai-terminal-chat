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
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("server runtime configuration", () => {
  it("normalizes HOST and invalid PORT before starting the listener", async () => {
    process.env.HOST = " 0.0.0.0 ";
    process.env.PORT = "not-a-number";
    process.env.API_AUTH_TOKEN = "test-token";
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await import("../src/server.ts");

    expect(serveMock).toHaveBeenCalledOnce();
    expect(serveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: "0.0.0.0",
        port: 9000,
      }),
    );
  });
});

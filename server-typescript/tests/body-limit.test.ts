import { describe, expect, it } from "vitest";
import { app } from "../src/routes.ts";

describe("request body limits", () => {
  it("rejects oversized request bodies before route processing", async () => {
    const oversized = JSON.stringify({
      command: "echo",
      padding: "x".repeat(2 * 1024 * 1024),
    });

    const response = await app.request("/allowed-commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: oversized,
    });

    expect(response.status).toBe(413);
    expect(await response.text()).toBe("Payload Too Large");
  });

  it("allows request bodies within the configured limit", async () => {
    const response = await app.request("/allowed-commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "echo" }),
    });

    expect(response.status).not.toBe(413);
  });
});

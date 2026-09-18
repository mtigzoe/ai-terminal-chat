import { describe, expect, it } from "vitest";
import { limitRequestBody } from "../src/request-body-limit.ts";

describe("limitRequestBody", () => {
  it("rejects oversized content-length bodies", async () => {
    const request = new Request("http://localhost/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(2 * 1024 * 1024) }),
    });

    const result = await limitRequestBody(request);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
  });

  it("rejects oversized chunked-style bodies without content-length", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(2 * 1024 * 1024)));
        controller.close();
      },
    });
    const request = new Request("http://localhost/test", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const result = await limitRequestBody(request);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(413);
  });

  it("rebuilds an accepted chunked-style body for downstream consumers", async () => {
    const request = new Request("http://localhost/test", {
      method: "POST",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("hello"));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const result = await limitRequestBody(request);
    expect(result).toBeInstanceOf(Request);
    expect(await (result as Request).text()).toBe("hello");
  });
});

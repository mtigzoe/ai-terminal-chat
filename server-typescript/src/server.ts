import "dotenv/config";
import { serve } from "@hono/node-server";
import { app, type AppType } from "./routes.ts";
import { runWithAllowedReadPaths } from "./security.ts";

// Default 127.0.0.1 keeps the non-Docker local workflow unchanged.
// Docker sets HOST=0.0.0.0 so the API is reachable from the host.
const host = process.env.HOST || "127.0.0.1";
const port = parseInt(process.env.PORT || "9000", 10);

async function securedFetch(request: Request): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  if (request.method !== "POST" || (pathname !== "/chat" && pathname !== "/stream")) {
    return app.fetch(request);
  }

  let allowedPaths: unknown[] = [];
  try {
    // Clone the request so Hono can still consume the original body normally.
    const data = (await request.clone().json()) as Record<string, unknown>;
    if (Array.isArray(data.allowed_paths)) {
      allowedPaths = data.allowed_paths;
    }
  } catch {
    // The route will produce its normal invalid-JSON response.
  }

  return runWithAllowedReadPaths(allowedPaths, () => app.fetch(request));
}

console.log(`Server running on http://${host}:${port}`);

serve({
  fetch: securedFetch,
  hostname: host,
  port,
});

export { app };
export type { AppType };

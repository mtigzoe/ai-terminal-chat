import "dotenv/config";
import { serve } from "@hono/node-server";
import { app, type AppType } from "./routes.ts";
import { runWithAllowedReadPaths } from "./security.ts";

// Default 127.0.0.1 keeps the non-Docker local workflow unchanged.
// Docker sets HOST=0.0.0.0 so the API is reachable from the host.
const host = process.env.HOST || "127.0.0.1";
const port = parseInt(process.env.PORT || "9000", 10);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const isLoopbackServer = LOOPBACK_HOSTS.has(host.toLowerCase());
const apiAuthToken = process.env.API_AUTH_TOKEN?.trim() || "";

// A non-loopback bind exposes powerful local filesystem/terminal capabilities
// to the network. Require an explicit bearer token rather than silently
// exposing the API. Local development remains token-free on loopback.
if (!isLoopbackServer && !apiAuthToken) {
  throw new Error(
    "API_AUTH_TOKEN is required when HOST is not a loopback address.",
  );
}

const configuredOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const DEFAULT_LOCAL_ORIGINS = new Set([
  "http://localhost:3000",
  "http://localhost:5173",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5173",
]);

const allowedOrigins = new Set(
  configuredOrigins.length > 0 ? configuredOrigins : DEFAULT_LOCAL_ORIGINS,
);

function originIsAllowed(origin: string | null): boolean {
  if (!origin) return true;
  return allowedOrigins.has(origin);
}

function hasValidBearerToken(request: Request): boolean {
  if (!apiAuthToken) return isLoopbackServer;
  const authorization = request.headers.get("authorization") || "";
  return authorization === `Bearer ${apiAuthToken}`;
}

async function securedFetch(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");

  // Reject browser requests from untrusted origins before dispatching the
  // request to any route. CORS headers alone are not sufficient because the
  // route would otherwise execute before the browser blocks the response.
  if (!originIsAllowed(origin)) {
    return new Response(JSON.stringify({ error: "Origin is not allowed." }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  }

  // Non-loopback deployments must authenticate every API request. OPTIONS is
  // exempt so the browser can complete a preflight before sending a request.
  if (request.method !== "OPTIONS" && !hasValidBearerToken(request)) {
    return new Response(JSON.stringify({ error: "Authentication required." }), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": "Bearer",
      },
    });
  }

  const pathname = new URL(request.url).pathname;
  if (request.method !== "POST" || (pathname !== "/chat" && pathname !== "/stream")) {
    const response = await app.fetch(request);
    return applyCorsPolicy(response, origin);
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

  const response = await runWithAllowedReadPaths(allowedPaths, () => app.fetch(request));
  return applyCorsPolicy(response, origin);
}

function applyCorsPolicy(response: Response, origin: string | null): Response {
  if (!origin) return response;

  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.append("vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

console.log(`Server running on http://${host}:${port}`);

serve({
  fetch: securedFetch,
  hostname: host,
  port,
});

export { app };
export type { AppType };
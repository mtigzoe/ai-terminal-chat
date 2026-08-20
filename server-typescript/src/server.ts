import "dotenv/config";
import { serve } from "@hono/node-server";
import { app, type AppType } from "./routes.ts";

// Default 127.0.0.1 keeps the non-Docker local workflow unchanged.
// Docker sets HOST=0.0.0.0 so the API is reachable from the host.
const host = process.env.HOST || "127.0.0.1";
const port = parseInt(process.env.PORT || "9000", 10);

console.log(`Server running on http://${host}:${port}`);

serve({
  fetch: app.fetch,
  hostname: host,
  port,
});

export { app };
export type { AppType };

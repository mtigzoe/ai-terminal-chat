import "dotenv/config";
import { serve } from "@hono/node-server";
import { app, type AppType } from "./routes.ts";

const port = parseInt(process.env.PORT || "9000", 10);

console.log(`Server running on http://127.0.0.1:${port}`);

serve({
  fetch: app.fetch,
  port,
});

export { app };
export type { AppType };

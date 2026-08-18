import { Hono } from "hono";
import { cors } from "hono/cors";
import { getProvider, buildProviderStatus } from "./providers/factory.ts";
import { SUPPORTED_PROVIDERS } from "./providers/config.ts";
import { getProjectRoot, setProjectRoot } from "./security.ts";
import { listFiles, readFile, searchFiles } from "./filesystem.ts";
import { gitStatus, gitDiff, gitLog, gitBranch } from "./git.ts";
import {
  getAllowedCommands,
  addAllowedCommand,
  removeAllowedCommand,
  runCommand,
} from "./terminal.ts";
import { createPending, getPending, popPending } from "./pending.ts";
import { cancel, release, register } from "./cancellation.ts";
import { runAgentLoop, type AgentEvent } from "./agent.ts";

type Env = Record<string, never>;

export const app = new Hono<{ Bindings: Env }>();

app.use("*", cors());

app.get("/providers", async (c) => {
  const probe = c.req.query("probe") !== "0";
  const provider = getProvider();
  const status = await buildProviderStatus(provider, probe);
  return c.json({
    ...status,
    current: status.name,
    providers: SUPPORTED_PROVIDERS,
  });
});

app.post("/providers/select", async (c) => {
  let data: Record<string, unknown> = {};
  try {
    data = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400 as any);
  }

  const name = String(data.provider || "").trim().toLowerCase();
  const model = data.model ? String(data.model).trim() : null;
  const hasApiKey = "api_key" in data;
  const apiKey = data.api_key ? String(data.api_key).trim() : "";

  if (!name) {
    return c.json({ error: "provider is required." }, 400 as any);
  }

  if (!SUPPORTED_PROVIDERS.includes(name as typeof SUPPORTED_PROVIDERS[number])) {
    return c.json(
      {
        error: `Unknown provider '${name}'. Expected one of: ${SUPPORTED_PROVIDERS.join(", ")}.`,
      },
      400 as any
    );
  }

  const envApiKeyMap: Record<string, string | undefined> = {
    gemini: "GOOGLE_API_KEY",
    kilo: "KILO_API_KEY",
    openai: "OPENAI_API_KEY",
    xai: "XAI_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
  };
  const envName = envApiKeyMap[name];
  const previousApiKey = envName ? process.env[envName] : undefined;

  if (hasApiKey && envName) {
    if (apiKey) {
      process.env[envName] = apiKey;
    } else {
      delete process.env[envName];
    }
  }

  try {
    const candidate = getProvider(name, model ? { model } : undefined);
    const status = await buildProviderStatus(candidate, true);
    return c.json(status);
  } catch (exc) {
    if (hasApiKey && envName) {
      if (previousApiKey === undefined) {
        delete process.env[envName];
      } else {
        process.env[envName] = previousApiKey;
      }
    }
    return c.json({ error: `Could not switch to '${name}': ${exc}` }, 400 as any);
  }
});

app.get("/providers/:name/models", async (c) => {
  const name = String(c.req.param("name") || "").toLowerCase();
  if (!SUPPORTED_PROVIDERS.includes(name as typeof SUPPORTED_PROVIDERS[number])) {
    return c.json(
      {
        error: `Unknown provider '${name}'. Expected one of: ${SUPPORTED_PROVIDERS.join(", ")}.`,
      },
      404 as any
    );
  }

  try {
    const candidate = getProvider(name);
    const models = await candidate.listModels();
    const supportsListing = candidate.capabilities.model_listing;
    const probe = await candidate.probe();

    const payload: Record<string, unknown> = {
      provider: name,
      supports_listing: supportsListing,
      models,
    };
    payload.available = probe.available;

    if (!probe.available) {
      payload.error =
        probe.error || `${candidate.displayName || name} is not reachable.`;
    } else if (!models.length) {
      payload.error = `${
        candidate.displayName || name
      } is reachable but reports no installed models. Pull a model and try again.`;
    }

    return c.json(payload);
  } catch (exc) {
    return c.json({ provider: name, models: [], error: String(exc) }, 200 as any);
  }
});

app.get("/project-root", (c) => {
  return c.json({ path: getProjectRoot() });
});

app.post("/project-root", async (c) => {
  let data: Record<string, unknown> = {};
  try {
    data = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400 as any);
  }

  const path = String(data.path || "").trim();
  try {
    const root = setProjectRoot(path);
    return c.json({ path: String(root) });
  } catch (exc) {
    return c.json({ error: String(exc) }, 400 as any);
  }
});

app.get("/project/list", (c) => {
  const relPath = c.req.query("path") || ".";
  const result = listFiles(relPath);
  if (result && typeof result === "object" && "error" in result) {
    return c.json(result, 400 as any);
  }
  return c.json(result);
});

app.get("/project/read", (c) => {
  const relPath = c.req.query("path") || "";
  if (!String(relPath).trim()) {
    return c.json({ error: "path is required." }, 400 as any);
  }
  const result = readFile(String(relPath));
  if (result && typeof result === "object" && "error" in result) {
    const err = String(result.error).toLowerCase();
    let status = 400;
    if (err.includes("does not exist")) {
      status = 404;
    } else if (
      err.includes("refusing") ||
      err.includes("outside") ||
      err.includes("absolute")
    ) {
      status = 403;
    }
    return c.json(result, status as any);
  }
  return c.json(result);
});

app.get("/allowed-commands", (c) => {
  return c.json({ commands: getAllowedCommands() });
});

app.post("/allowed-commands", async (c) => {
  let data: Record<string, unknown> = {};
  try {
    data = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400 as any);
  }

  const prefix = String(data.command || data.prefix || "").trim();
  try {
    const commands = addAllowedCommand(prefix);
    return c.json({ commands, added: prefix });
  } catch (exc) {
    return c.json({ error: String(exc) }, 400 as any);
  }
});

app.delete("/allowed-commands/:command", (c) => {
  const command = c.req.param("command");
  try {
    const commands = removeAllowedCommand(command);
    return c.json({ commands, removed: command });
  } catch (exc) {
    return c.json({ error: String(exc) }, 400 as any);
  }
});

app.post("/terminal/run", async (c) => {
  let data: Record<string, unknown> = {};
  try {
    data = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400 as any);
  }

  const command = String(data.command || "").trim();
  if (!command) {
    return c.json({ error: "command is required." }, 400 as any);
  }
  const result = runCommand(command);
  if (result && typeof result === "object" && "error" in result) {
    return c.json(result, 400 as any);
  }
  return c.json(result);
});

app.post("/chat", async (c) => {
  let data: Record<string, unknown> = {};
  try {
    data = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ text: "", error: "Invalid JSON body." }, 400 as any);
  }

  const msg = String(data.chat || "").trim();
  const history: unknown[] = Array.isArray(data.history) ? data.history : [];
  const requestId = String(data.request_id || crypto.randomUUID());

  if (!msg) {
    return c.json({ text: "", error: "Message must not be empty." }, 400 as any);
  }

  const provider = getProvider();
  let contents: unknown[];
  try {
    contents = provider.buildContents(msg, history);
  } catch (exc) {
    return c.json(
      { text: "", error: `Could not process conversation history: ${exc}` },
      400 as any
    );
  }

  const toolActivity: AgentEvent[] = [];
  let finalText = "";
  let errorMessage: string | null = null;
  let cancelled = false;
  const cancelSignal = register(requestId);

  try {
    for await (const event of runAgentLoop({
      provider,
      contents,
      toolFunctions: getToolFunctions(),
      cancelSignal,
      createPending: (toolName, args, preview) => {
        const action = createPending(toolName, args, preview);
        return { action_id: action.action_id };
      },
    })) {
      if (event.type === "progress") {
        toolActivity.push({
          type: "progress",
          phase: event.phase,
          message: event.message,
          round: event.round,
          tool: event.tool,
        });
      } else if (event.type === "tool_call") {
        toolActivity.push(event);
      } else if (event.type === "tool_result") {
        toolActivity.push(event);
      } else if (event.type === "pending_confirmation") {
        toolActivity.push(event);
      } else if (event.type === "final") {
        finalText = event.text;
      } else if (event.type === "error") {
        errorMessage = event.message;
      } else if (event.type === "cancelled") {
        cancelled = true;
      }
    }
  } catch (exc) {
    errorMessage = `Unexpected server error: ${exc}`;
  } finally {
    release(requestId);
  }

  if (cancelled) {
    return c.json({
      text: finalText,
      tool_activity: toolActivity,
      cancelled: true,
      request_id: requestId,
    });
  }

  if (errorMessage && !finalText) {
    return c.json(
      {
        text: "",
        error: errorMessage,
        tool_activity: toolActivity,
        request_id: requestId,
      },
      502 as any
    );
  }

  return c.json({
    text: finalText,
    tool_activity: toolActivity,
    request_id: requestId,
  });
});

app.post("/stream", async (c) => {
  let data: Record<string, unknown> = {};
  try {
    data = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.text("Please enter a message.");
  }

  const msg = String(data.chat || "").trim();
  const history: unknown[] = Array.isArray(data.history) ? data.history : [];
  const requestId = String(data.request_id || crypto.randomUUID());

  if (!msg) {
    return c.text("Please enter a message.");
  }

  const provider = getProvider();
  let contents: unknown[];
  try {
    contents = provider.buildContents(msg, history);
  } catch (exc) {
    return c.text(`[Error building request: ${exc}]`);
  }

  const cancelSignal = register(requestId);
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      (async () => {
        try {
          for await (const event of runAgentLoop({
            provider,
            contents,
            toolFunctions: getToolFunctions(),
            cancelSignal,
            createPending: (toolName, args, preview) => {
              const action = createPending(toolName, args, preview);
              return { action_id: action.action_id };
            },
          })) {
            if (cancelSignal.aborted) break;
            const line = JSON.stringify(event) + "\n";
            controller.enqueue(encoder.encode(line));
          }
        } catch (exc) {
          controller.enqueue(
            encoder.encode(
              JSON.stringify({ type: "error", message: String(exc) }) + "\n"
            )
          );
        } finally {
          release(requestId);
          controller.close();
        }
      })();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain",
      "Cache-Control": "no-cache",
    },
  });
});

app.post("/cancel/:request_id", (c) => {
  const requestId = c.req.param("request_id");
  const cancelled = cancel(requestId);
  return c.json({ request_id: requestId, cancelled });
});

app.post("/confirm", async (c) => {
  let data: Record<string, unknown> = {};
  try {
    data = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400 as any);
  }

  const actionId = String(data.action_id || "").trim();
  const confirmed = data.confirmed === true;

  if (!actionId) {
    return c.json({ error: "action_id is required." }, 400 as any);
  }

  if (!confirmed) {
    const action = popPending(actionId);
    if (!action) {
      return c.json({ error: "Pending action not found or already resolved." }, 404 as any);
    }
    return c.json({
      confirmed: false,
      action_id: actionId,
      cancelled: true,
    });
  }

  const action = popPending(actionId);
  if (!action) {
    return c.json({ error: "Pending action not found or already resolved." }, 404 as any);
  }

  const WRITE_TOOLS = new Set([
    "create_file",
    "write_file",
    "apply_patch",
    "delete_file",
    "git_add",
  ]);
  if (!WRITE_TOOLS.has(action.tool_name)) {
    return c.json({ error: "Only pending write actions can be confirmed." }, 400 as any);
  }

  const fn = getToolFunctions()[action.tool_name];
  if (!fn) {
    return c.json({ error: `Tool no longer exists: ${action.tool_name}` }, 500 as any);
  }

  const confirmedArgs = { ...action.args, confirm: true };
  const timeoutSeconds = 60;

  try {
    const result = await Promise.race([
      Promise.resolve(fn(confirmedArgs)),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), timeoutSeconds * 1000)
      ),
    ]);

    if (result && typeof result === "object" && "error" in result && result.error) {
      return c.json(
        {
          confirmed: true,
          action_id: actionId,
          tool: action.tool_name,
          result,
        },
        400 as any
      );
    }

    return c.json({
      confirmed: true,
      action_id: actionId,
      tool: action.tool_name,
      result,
    });
  } catch (exc) {
    return c.json({ error: `Tool ${action.tool_name} failed: ${exc}` }, 500 as any);
  }
});

function getToolFunctions(): Record<string, (args: Record<string, unknown>) => unknown> {
  return {
    list_files: (args) => listFiles(String(args.path || ".")),
    read_file: (args) => readFile(String(args.path || "")),
    search_files: (args) =>
      searchFiles(String(args.query || ""), String(args.path || ".")),
    run_command: (args) => runCommand(String(args.command || "")),
    git_status: () => gitStatus(),
    git_diff: (args) =>
      gitDiff(String(args.path || ""), Boolean(args.staged)),
    git_log: (args) => gitLog(Number(args.max_count || 10)),
    git_branch: () => gitBranch(),
    create_file: () => ({ error: "File creation is not yet implemented in TypeScript." }),
    write_file: () => ({ error: "File writing is not yet implemented in TypeScript." }),
    apply_patch: () => ({ error: "Patch application is not yet implemented in TypeScript." }),
    delete_file: () => ({ error: "File deletion is not yet implemented in TypeScript." }),
    git_add: () => ({ error: "Git add is not yet implemented in TypeScript." }),
  };
}

export type AppType = typeof app;

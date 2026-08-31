import { Hono } from "hono";
import { cors } from "hono/cors";
import { getProvider, buildProviderStatus } from "./providers/factory.ts";
import type { Provider } from "./providers/base.ts";
import { SUPPORTED_PROVIDERS } from "./providers/config.ts";
import {
  getProjectRoot,
  setProjectRoot,
  loadProviderSelection,
  persistProviderSelection,
} from "./security.ts";
import fs from "node:fs";
import path from "node:path";
import { listFiles, readFile, searchFiles } from "./filesystem.ts";
import { gitCommittedFileCount, gitDiff, gitLog, gitBranch } from "./git.ts";
import { gitStatusSummary } from "./git-status-summary.ts";
import {
  getAllowedCommands,
  addAllowedCommand,
  removeAllowedCommand,
  runCommand,
} from "./terminal.ts";
import { createPending, getPending, popPending } from "./pending.ts";
import { cancel, release, register } from "./cancellation.ts";
import { runAgentLoop, type AgentEvent } from "./agent.ts";
import {
  create_file,
  write_file,
  apply_patch,
  delete_file,
  git_add,
} from "./write-tools.ts";

type Env = Record<string, never>;

export const app = new Hono<{ Bindings: Env }>();

// Flask keeps the successfully selected provider in process memory. Keep the
// same lifetime here so /providers, /chat, and /stream all use the provider
// selected through /providers/select rather than rebuilding from PROVIDER.
let activeProvider: Provider | undefined;

function getActiveProvider(): Provider {
  return activeProvider ?? getProvider();
}

/**
 * Restore provider + model from config.json at startup.
 * Matches Python: does NOT re-apply persisted ollama_base_url to env.
 */
export function restoreProviderFromConfig(): void {
  try {
    const saved = loadProviderSelection();
    if (saved.provider) {
      activeProvider = getProvider(
        saved.provider,
        saved.model ? { model: saved.model } : undefined
      );
    }
  } catch {
    // Fall back to env / default provider on any restore failure.
  }
}

restoreProviderFromConfig();

/** Scheme-normalise an Ollama host/URL for config persistence (matches Python). */
function normalizeOllamaBaseUrlForPersist(raw: string): string {
  let url = raw.trim();
  if (!url) {
    throw new Error("An Ollama hostname is required.");
  }
  if (!url.includes("://")) {
    url = `http://${url}`;
  }
  return url;
}

/**
 * Apply Ollama base URL to process env for provider construction.
 * OpenAI-compatible TS client appends /models and /chat/completions, so the
 * env value must include a single /v1 (avoid /v1/v1).
 */
function applyOllamaBaseUrlToEnv(schemeNormalized: string): void {
  const stripped = schemeNormalized.replace(/\/+$/, "");
  process.env.OLLAMA_BASE_URL = stripped.endsWith("/v1")
    ? stripped
    : `${stripped}/v1`;
}

function validateProjectPath(projectPath: string): string {
  const trimmed = String(projectPath).trim();
  if (!trimmed) {
    throw new Error("A project path is required.");
  }
  const candidate = path.resolve(trimmed);
  if (!fs.existsSync(candidate)) {
    throw new Error(`Project path does not exist: ${candidate}`);
  }
  if (!fs.statSync(candidate).isDirectory()) {
    throw new Error(`Project path is not a directory: ${candidate}`);
  }
  return candidate;
}

app.use("*", cors());

app.get("/providers", async (c) => {
  const probe = c.req.query("probe") !== "0";
  const provider = getActiveProvider();
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
  const hasOllamaBaseUrl = "ollama_base_url" in data;
  const ollamaBaseUrlRaw =
    data.ollama_base_url !== undefined && data.ollama_base_url !== null
      ? String(data.ollama_base_url)
      : null;
  const hasProjectPath = "project_path" in data;
  const projectPathRaw =
    data.project_path !== undefined && data.project_path !== null
      ? String(data.project_path)
      : null;

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

  let pendingProjectPath: string | null = null;
  if (hasProjectPath) {
    try {
      pendingProjectPath = validateProjectPath(projectPathRaw ?? "");
    } catch (exc) {
      return c.json(
        { error: `Could not switch to '${name}': ${exc instanceof Error ? exc.message : String(exc)}` },
        400 as any
      );
    }
  }

  let normalizedOllamaUrl: string | null = null;
  if (name === "ollama" && hasOllamaBaseUrl) {
    try {
      normalizedOllamaUrl = normalizeOllamaBaseUrlForPersist(ollamaBaseUrlRaw ?? "");
      applyOllamaBaseUrlToEnv(normalizedOllamaUrl);
    } catch (exc) {
      return c.json(
        { error: `Could not switch to '${name}': ${exc instanceof Error ? exc.message : String(exc)}` },
        400 as any
      );
    }
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
    activeProvider = candidate;

    if (pendingProjectPath !== null) {
      setProjectRoot(pendingProjectPath);
    }

    try {
      persistProviderSelection(
        name,
        model,
        name === "ollama" && hasOllamaBaseUrl
          ? normalizedOllamaUrl
          : name === "ollama"
            ? undefined
            : null
      );
    } catch (persistExc) {
      console.warn(
        `[Warning] Could not persist provider selection: ${persistExc}`
      );
    }

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
    const payload: Record<string, unknown> = {
      provider: name,
      supports_listing: supportsListing,
      models,
    };
    // The Flask API probes and reports reachability only for local providers.
    // Remote providers that do not implement model listing simply return an
    // empty model list without turning it into a reachability error.
    if (candidate.capabilities.local) {
      const probe = await candidate.probe();
      payload.available = probe.available;
      if (!probe.available) {
        payload.error =
          probe.error || `${candidate.displayName || name} is not reachable.`;
      } else if (!models.length) {
        payload.error = `${
          candidate.displayName || name
        } is reachable but reports no installed models. Pull a model and try again.`;
      }
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
    const error = String(exc);
    const isValidationError =
      error.includes("project path is required") ||
      error.includes("Project path does not exist") ||
      error.includes("Project path is not a directory") ||
      error.includes("Native folder picker");
    return c.json(
      { error: isValidationError ? error : `Could not save project path: ${error}` },
      (isValidationError ? 400 : 500) as any
    );
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
    const error = String(exc);
    const isValidationError =
      error.includes("non-empty command prefix") ||
      error.includes("not permitted for safety reasons");
    return c.json(
      { error: isValidationError ? error : `Could not save allowed commands: ${error}` },
      (isValidationError ? 400 : 500) as any
    );
  }
});

app.delete("/allowed-commands/:command", (c) => {
  const command = c.req.param("command");
  try {
    const commands = removeAllowedCommand(command);
    return c.json({ commands, removed: command });
  } catch (exc) {
    const error = String(exc);
    const isValidationError =
      error.includes("non-empty command prefix") ||
      error.includes("is not in the allowlist");
    return c.json(
      { error: isValidationError ? error : `Could not save allowed commands: ${error}` },
      (isValidationError ? 400 : 500) as any
    );
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
  const result = await runCommand(command);
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

  const provider = getActiveProvider();
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

  const provider = getActiveProvider();
  let contents: unknown[];
  try {
    contents = provider.buildContents(msg, history);
  } catch (exc) {
    return c.text(`[Error building request: ${exc}]`);
  }

  const cancelSignal = register(requestId);
  const wantsNdjson = c.req.header("Accept")?.includes("application/x-ndjson") ?? false;
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
            const line = wantsNdjson
              ? JSON.stringify(event) + "\n"
              : formatPlainStreamEvent(event);
            controller.enqueue(encoder.encode(line));
          }
        } catch (exc) {
          const event: AgentEvent = { type: "error", message: String(exc) };
          controller.enqueue(encoder.encode(
            wantsNdjson ? JSON.stringify(event) + "\n" : formatPlainStreamEvent(event)
          ));
        } finally {
          release(requestId);
          controller.close();
        }
      })();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": wantsNdjson ? "application/x-ndjson" : "text/plain; charset=utf-8",
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
    git_status: () => gitStatusSummary(),
    git_committed_file_count: () => gitCommittedFileCount(),
    git_diff: (args) =>
      gitDiff(String(args.path || ""), Boolean(args.staged)),
    git_log: (args) => gitLog(Number(args.max_count || 10)),
    git_branch: () => gitBranch(),
    create_file: (args) => create_file(String(args.path || ""), String(args.contents || ""), Boolean(args.confirm)),
    write_file: (args) => write_file(String(args.path || ""), String(args.contents || ""), Boolean(args.confirm)),
    apply_patch: (args) => apply_patch(String(args.patch || ""), Boolean(args.confirm)),
    delete_file: (args) => delete_file(String(args.path || ""), Boolean(args.confirm)),
    git_add: (args) => git_add(String(args.path || ""), Boolean(args.confirm)),
  };
}

function formatPlainStreamEvent(event: AgentEvent): string {
  if (event.type === "progress") {
    return `\n[${event.phase || "progress"}] ${event.message || ""}\n`;
  }
  if (event.type === "tool_call") {
    const args = Object.entries(event.args)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(", ");
    return `\n⚙️ ${event.name}(${args})\n`;
  }
  if (event.type === "tool_result") {
    const result = event.result;
    if (result && typeof result === "object" && "error" in result && result.error) {
      return `⚠️ ${event.name}: ${String(result.error)}\n`;
    }
    return "";
  }
  if (event.type === "pending_confirmation") {
    return `\n[Confirmation required: ${event.name} action_id=${event.action_id}] Waiting for explicit user confirmation.\n`;
  }
  if (event.type === "final") return event.text;
  if (event.type === "error") return `\n[Error: ${event.message}]`;
  return "\n[cancelled] Cancelled by user request.\n";
}

export type AppType = typeof app;

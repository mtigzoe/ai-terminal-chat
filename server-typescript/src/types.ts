// Shared TypeScript types for API contracts, providers, tools, and agent state.
//
// This module has no runtime behavior — it is the single source of truth for
// shapes that server-python currently expresses as ad-hoc dicts/dataclasses
// across app.py, base.py, providers.py, tools.py, agent.py, and pending.py.
// Defining these up front (Phase 1) lets every later phase import instead of
// re-declaring, per the "avoid duplicated types" migration principle.
//
// Two families of types live here, and it matters which one you're looking at:
//
//   1. WIRE types — anything that crosses the HTTP boundary to client-react
//      (request/response bodies, agent progress events sent to the browser).
//      These intentionally keep the existing snake_case JSON key names
//      (e.g. `tool_activity`, `request_id`, `bytes_written`) because
//      client-react/src consumes those exact keys today and the migration
//      goal is byte-for-byte API compatibility, not idiomatic renaming.
//
//   2. DOMAIN types — internal TypeScript-side contracts (e.g. the Provider
//      interface) that never get serialized directly. These use ordinary
//      camelCase TypeScript conventions.
//
// Source of truth for each section is noted in its heading.

// ---------------------------------------------------------------------------
// Tool identity (server-python/tools.py: TOOL_FUNCTIONS / *_TOOL_NAMES)
// ---------------------------------------------------------------------------

/** Tools that only read/inspect the project. Never require confirmation. */
export const READ_ONLY_TOOL_NAMES = [
  "list_files",
  "read_file",
  "search_files",
  "run_command",
  "git_status",
  "git_diff",
  "git_log",
  "git_branch",
] as const;

/** Tools that create, modify, or delete files. Always preview-then-confirm. */
export const WRITE_TOOL_NAMES = [
  "create_file",
  "write_file",
  "apply_patch",
  "delete_file",
] as const;

/** Git tools that mutate repository state. Always preview-then-confirm. */
export const GIT_CONFIRM_TOOL_NAMES = ["git_add"] as const;

export type ReadOnlyToolName = (typeof READ_ONLY_TOOL_NAMES)[number];
export type WriteToolName = (typeof WRITE_TOOL_NAMES)[number];
export type GitConfirmToolName = (typeof GIT_CONFIRM_TOOL_NAMES)[number];

/** Every tool name the agent/HTTP layer may invoke. */
export type ToolName = ReadOnlyToolName | WriteToolName | GitConfirmToolName;

// ---------------------------------------------------------------------------
// Tool results (server-python/tools.py)
// ---------------------------------------------------------------------------
//
// Every tool function returns either a success payload or `{ error }`.
// Write/git-confirm tools have a third shape: a `requires_confirmation`
// preview returned when `confirm` is not `true`. Modeled as discriminated
// unions below rather than one loose `Record<string, unknown>` so later
// phases (tools.ts, agent.ts, app.ts) get compile-time checking on which
// fields are actually present for a given outcome.

/** Common failure shape returned by every tool function. */
export interface ToolError {
  error: string;
}

export function isToolError(value: unknown): value is ToolError {
  return (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof (value as { error: unknown }).error === "string"
  );
}

export interface FileEntry {
  name: string;
  type: "file" | "directory";
}

export type ListFilesResult = { path: string; entries: FileEntry[] } | ToolError;

export type ReadFileResult = { path: string; contents: string } | ToolError;

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export type SearchFilesResult =
  | { query: string; path: string; matches: SearchMatch[]; truncated: boolean }
  | ToolError;

export type RunCommandResult =
  | {
      command: string;
      returncode: number;
      stdout: string;
      stderr: string;
      truncated: boolean;
      truncation_note?: string;
    }
  | ToolError;

export type GitStatusResult =
  | { status: string; truncated: boolean; truncation_note?: string }
  | ToolError;

export type GitDiffResult =
  | { diff: string; truncated: boolean; truncation_note?: string }
  | ToolError;

export type GitLogResult =
  | { log: string; truncated: boolean; truncation_note?: string }
  | ToolError;

export type GitBranchResult =
  | { branches: string; truncated: boolean; truncation_note?: string }
  | ToolError;

export type GitAddResult =
  | { requires_confirmation: true; path: string; message: string }
  | { path: string; staged: true }
  | ToolError;

export type CreateFileResult =
  | {
      requires_confirmation: true;
      path: string;
      preview: string;
      preview_truncated: boolean;
      message: string;
    }
  | { path: string; created: true; bytes_written: number }
  | ToolError;

export type WriteFileResult =
  | {
      requires_confirmation: true;
      path: string;
      action: "overwrite" | "create";
      diff: string | null;
      message: string;
    }
  | { path: string; overwritten: boolean; bytes_written: number }
  | ToolError;

export type DeleteFileResult =
  | { requires_confirmation: true; path: string; message: string }
  | { path: string; deleted: true }
  | ToolError;

export type ApplyPatchResult =
  | { requires_confirmation: true; files: string[]; message: string }
  | { files: string[]; applied: true }
  | ToolError;

/** Union of every tool's possible return shape. */
export type ToolResult =
  | ListFilesResult
  | ReadFileResult
  | SearchFilesResult
  | RunCommandResult
  | GitStatusResult
  | GitDiffResult
  | GitLogResult
  | GitBranchResult
  | GitAddResult
  | CreateFileResult
  | WriteFileResult
  | DeleteFileResult
  | ApplyPatchResult;

/** True for the preview payload write/git-confirm tools return before `confirm=true`. */
export function requiresConfirmation(
  result: ToolResult,
): result is Extract<ToolResult, { requires_confirmation: true }> {
  return (
    typeof result === "object" &&
    result !== null &&
    "requires_confirmation" in result &&
    (result as { requires_confirmation: unknown }).requires_confirmation === true
  );
}

/** Per-tool argument shapes (server-python/tools.py: TOOL_SCHEMAS). */
export interface ToolArgsByName {
  list_files: { path?: string };
  read_file: { path: string };
  search_files: { query: string; path?: string };
  run_command: { command: string };
  git_status: Record<string, never>;
  git_diff: { path?: string; staged?: boolean };
  git_log: { max_count?: number };
  git_branch: Record<string, never>;
  git_add: { path: string; confirm?: boolean };
  create_file: { path: string; contents?: string; confirm?: boolean };
  write_file: { path: string; contents: string; confirm?: boolean };
  delete_file: { path: string; confirm?: boolean };
  apply_patch: { patch: string; confirm?: boolean };
}

// ---------------------------------------------------------------------------
// Pending confirmations (server-python/pending.py)
// ---------------------------------------------------------------------------

export interface PendingAction {
  action_id: string;
  tool_name: WriteToolName | GitConfirmToolName;
  args: Record<string, unknown>;
  preview: unknown;
}

// ---------------------------------------------------------------------------
// Agent event stream (server-python/agent.py: run_agent_loop)
// ---------------------------------------------------------------------------
//
// Wire types: these are exactly what /chat accumulates into `tool_activity`
// and what /stream renders as plain text, so field names must not change
// without a matching client-react update.

export type AgentPhase =
  | "plan"
  | "inspect"
  | "execute"
  | "confirm"
  | "verify"
  | "recover"
  | "complete"
  | "error"
  | "cancelled";

export interface ProgressEvent {
  type: "progress";
  phase: AgentPhase;
  message: string;
  round?: number;
  max_rounds?: number;
  tool?: string;
  action_id?: string;
}

export interface ToolCallEvent {
  type: "tool_call";
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResultEvent {
  type: "tool_result";
  name: string;
  result: ToolResult;
}

export interface PendingConfirmationEvent {
  type: "pending_confirmation";
  action_id: string;
  name: string;
  args: Record<string, unknown>;
  preview: ToolResult;
}

export interface FinalEvent {
  type: "final";
  text: string;
}

export interface AgentErrorEvent {
  type: "error";
  message: string;
}

export interface CancelledEvent {
  type: "cancelled";
}

/** Every event `run_agent_loop` may yield, in the order agent.ts (Phase 6) will implement. */
export type AgentEvent =
  | ProgressEvent
  | ToolCallEvent
  | ToolResultEvent
  | PendingConfirmationEvent
  | FinalEvent
  | AgentErrorEvent
  | CancelledEvent;

/** The subset of AgentEvent accumulated into /chat's `tool_activity` array. */
export type ToolActivityEntry =
  | ProgressEvent
  | ToolCallEvent
  | ToolResultEvent
  | PendingConfirmationEvent;

// ---------------------------------------------------------------------------
// Providers (server-python/base.py, server-python/providers.py)
// ---------------------------------------------------------------------------

/** Providers server-python currently supports (providers.py: SUPPORTED_PROVIDERS). */
export const SUPPORTED_PROVIDERS = [
  "gemini",
  "ollama",
  "kilo",
  "openai",
  "xai",
  "openrouter",
  "anthropic",
] as const;

export type ProviderName = (typeof SUPPORTED_PROVIDERS)[number];

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  id?: string;
}

export interface ProviderCapabilities {
  tools: boolean;
  streaming: boolean;
  model_listing: boolean;
  requires_api_key: boolean;
  local: boolean;
  notes: string;
}

export interface ProviderResponse {
  text: string | null;
  tool_calls: ToolCall[];
  raw?: unknown;
}

export interface ProviderProbeResult {
  available: boolean;
  error: string | null;
}

export interface ProviderModelInfo {
  id: string;
  [key: string]: unknown;
}

/** Env-derived provider configuration (providers.py: ProviderConfig dataclass). */
export interface ProviderConfig {
  provider: ProviderName;
  model: string;
  base_url?: string | null;
  api_key?: string | null;
  timeout: number;
}

/** ProviderConfig.to_public_dict() — never includes api_key. */
export interface PublicProviderConfig {
  provider: ProviderName;
  model: string;
  base_url: string | null;
  timeout: number;
}

export interface ChatHistoryEntry {
  role?: string;
  text?: string;
  [key: string]: unknown;
}

/**
 * One backend's chat + tool-calling API, normalized to four methods —
 * mirrors the abstract `Provider` base class in server-python/base.py.
 * Implemented per provider in providers.ts (Phase 4); consumed by
 * agent.ts (Phase 6) without needing to know which concrete provider
 * is live.
 */
export interface Provider {
  readonly name: string;
  readonly model: string;
  readonly capabilities: ProviderCapabilities;
  readonly providerConfig?: ProviderConfig;

  listModels(): ProviderModelInfo[] | Promise<ProviderModelInfo[]>;
  probe(): ProviderProbeResult | Promise<ProviderProbeResult>;
  refreshCapabilities?(): ProviderCapabilities | Promise<ProviderCapabilities>;

  buildContents(msg: string, history: ChatHistoryEntry[]): unknown[];
  generate(contents: unknown[]): Promise<ProviderResponse>;
  appendModelTurn(contents: unknown[], response: ProviderResponse): unknown[];
  appendToolResults(contents: unknown[], results: ToolResultEntry[]): unknown[];
}

export interface ToolResultEntry {
  name: string;
  result: ToolResult;
}

// ---------------------------------------------------------------------------
// HTTP API contracts (server-python/app.py)
// ---------------------------------------------------------------------------

export interface ApiErrorResponse {
  error: string;
}

export interface ProviderDiagnostics {
  provider: string | null;
  server: string | null;
  model: string | null;
  possible_causes: string[];
  detail: string;
}

/** GET /providers */
export interface ProviderStatusResponse {
  name: string | null;
  model: string | null;
  capabilities: ProviderCapabilities;
  base_url?: string | null;
  available?: boolean;
  error?: string | null;
  diagnostics?: ProviderDiagnostics;
  current: string | null;
  providers: readonly ProviderName[];
}

/** GET /project-root */
export interface ProjectRootGetResponse {
  path: string;
}

/** POST /project-root */
export interface ProjectRootPostRequest {
  path: string;
}
export type ProjectRootPostResponse = ProjectRootGetResponse | ApiErrorResponse;

/** GET /providers/<name>/models */
export type ProviderModelsResponse =
  | { provider: string; supports_listing: boolean; models: ProviderModelInfo[] }
  | { provider: string; models: []; error: string };

/** POST /providers/select */
export interface ProviderSelectRequestBody {
  provider: string;
  model?: string;
  api_key?: string;
  project_path?: string;
}
export type ProviderSelectResponse = ProviderStatusResponse | ApiErrorResponse;

/** POST /cancel/<request_id> */
export interface CancelResponse {
  request_id: string;
  cancelled: boolean;
}

/** POST /confirm */
export interface ConfirmRequestBody {
  action_id: string;
  confirmed?: boolean;
}
export type ConfirmResponse =
  | { confirmed: false; action_id: string; cancelled: true }
  | { confirmed: true; action_id: string; tool: ToolName; result: ToolResult }
  | ApiErrorResponse;

/** POST /chat and POST /stream (shared request body) */
export interface ChatRequestBody {
  chat: string;
  history?: ChatHistoryEntry[];
  request_id?: string;
}

/** POST /chat response body */
export interface ChatResponseBody {
  text: string;
  tool_activity: ToolActivityEntry[];
  request_id: string;
  cancelled?: boolean;
  error?: string;
}

/** GET /project/list */
export interface ProjectListResponse {
  path: string;
  entries: FileEntry[];
}

/** GET /project/read */
export interface ProjectReadResponse {
  path: string;
  contents: string;
}

/** POST /terminal/run */
export interface TerminalRunRequestBody {
  command: string;
}

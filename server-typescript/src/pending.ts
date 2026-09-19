/**
 * Everything needed to continue an agent loop that paused mid-round for
 * confirmation, once the user Allows or Declines. Mirrors the `resume=`
 * dict built in server-python/agent.py's `_agent_loop` (see the
 * `resume={...}` literal passed to `create_pending`) and consumed by
 * `resume_agent_loop()`. Carries the loop's exact state at the moment it
 * paused so a compound request (e.g. "add, commit, and push") can finish
 * across several Allow clicks instead of stopping after the first one.
 */
import { getProjectRoot } from "./security.ts";
import { getProvider } from "./providers/factory.ts";
import { loadProviderSelection } from "./security.ts";
import {
  captureConfirmationFileStates,
  confirmationFileStatesMatch,
  confirmationPathsForPending,
  type ConfirmationFileStates,
} from "./confirmation-state.ts";

export interface ResumeState {
  provider_fingerprint: string;
  /** Absolute, resolved project root where this action was created. */
  project_root?: string;
  contents: unknown[];
  round_index: number;
  tool_results: { name: string; result: unknown }[];
  remaining_calls: { name: string; args: Record<string, unknown>; id?: string }[];
  last_call_signature: [string, string] | null;
  consecutive_repeat_count: number;
  consecutive_error_count: number;
}

export interface PendingAction {
  action_id: string;
  tool_name: string;
  args: Record<string, unknown>;
  preview: Record<string, unknown>;
  // Captured immediately after the preview and before the pending action is
  // exposed to the user. Confirmation is rejected if any target changed.
  confirmation_file_states?: ConfirmationFileStates;
  // Present when this action was created mid-agent-loop (as opposed to a
  // standalone/legacy pending action). See agent.resumeAgentLoop() for how
  // this is consumed.
  resume?: ResumeState;
}

const MAX_PENDING_ACTIONS = 100;
const _PENDING = new Map<string, PendingAction>();

export function createPending(
  toolName: string,
  args: Record<string, unknown>,
  preview: Record<string, unknown>,
  resume?: ResumeState
): PendingAction {
  const paths = confirmationPathsForPending(toolName, args);
  const confirmation_file_states = paths.length
    ? captureConfirmationFileStates(paths)
    : undefined;

  const action: PendingAction = {
    action_id: crypto.randomUUID(),
    tool_name: toolName,
    args: { ...args },
    preview: { ...preview },
    ...(confirmation_file_states ? { confirmation_file_states } : {}),
    ...(resume
      ? { resume: { ...resume, project_root: resume.project_root ?? getProjectRoot() } }
      : {}),
  };

  if (_PENDING.size >= MAX_PENDING_ACTIONS) {
    const oldestId = _PENDING.keys().next().value!;
    _PENDING.delete(oldestId);
  }

  _PENDING.set(action.action_id, action);
  return action;
}

export function getPending(actionId: string): PendingAction | undefined {
  return _PENDING.get(actionId);
}

function currentProviderFingerprint(): string | undefined {
  try {
    const saved = loadProviderSelection();
    const provider = getProvider(saved.provider, saved.model ? { model: saved.model } : undefined);
    return `${provider.name}:${provider.model || ""}`;
  } catch {
    return undefined;
  }
}

export function restorePending(action: PendingAction): boolean {
  if (_PENDING.has(action.action_id)) return false;

  if (_PENDING.size >= MAX_PENDING_ACTIONS) {
    const oldestId = _PENDING.keys().next().value!;
    _PENDING.delete(oldestId);
  }

  _PENDING.set(action.action_id, action);
  return true;
}

export function popPending(actionId: string): PendingAction | undefined {
  const action = _PENDING.get(actionId);
  if (!action) return undefined;

  if (action.resume?.project_root && action.resume.project_root !== getProjectRoot()) {
    _PENDING.delete(actionId);
    return undefined;
  }

  if (
    action.resume &&
    action.resume.provider_fingerprint !== currentProviderFingerprint()
  ) {
    _PENDING.delete(actionId);
    return undefined;
  }

  if (
    action.confirmation_file_states &&
    !confirmationFileStatesMatch(action.confirmation_file_states)
  ) {
    _PENDING.delete(actionId);
    return undefined;
  }

  _PENDING.delete(actionId);
  return action;
}

export function clear(): void {
  _PENDING.clear();
}

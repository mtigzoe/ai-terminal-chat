/**
 * Helpers for agent progress / confirmation status.
 * Keeps phase labeling and announcement text in one place.
 */

const PHASE_LABELS = {
  plan: 'Planning',
  inspect: 'Inspecting',
  execute: 'Executing',
  confirm: 'Waiting for confirmation',
  verify: 'Verifying',
  recover: 'Recovering',
  complete: 'Completed',
  error: 'Error',
};

/** Phases that should use assertive live-region announcements. */
export const ASSERTIVE_PHASES = new Set(['confirm', 'error']);

export function phaseLabel(phase) {
  if (!phase) return 'Agent';
  return PHASE_LABELS[phase] || phase;
}

/**
 * Build a concise status object from a progress event.
 * Returns null if the event should not update status.
 */
export function statusFromProgressEvent(event) {
  if (!event || event.type !== 'progress') return null;
  const phase = event.phase || 'plan';
  const message = event.message || phaseLabel(phase);
  return {
    phase,
    message,
    assertive: ASSERTIVE_PHASES.has(phase),
  };
}

/**
 * Build status from a pending_confirmation event.
 */
export function statusFromPendingConfirmation(event) {
  if (!event || event.type !== 'pending_confirmation') return null;

  const name = event.name || 'write operation';
  const path =
    event.args?.path ||
    event.preview?.path ||
    (Array.isArray(event.preview?.files) ? event.preview.files.join(', ') : null);

  const target = path ? ` affecting ${path}` : '';
  const message =
    `Confirmation required: ${name}${target}. ` +
    'You must explicitly approve or reject this change before it is applied.';

  return {
    phase: 'confirm',
    message,
    assertive: true,
    actionId: event.action_id,
    tool: name,
    path: path || null,
  };
}

/**
 * Build status from an error event.
 */
export function statusFromErrorEvent(event) {
  if (!event || event.type !== 'error') return null;
  return {
    phase: 'error',
    message: event.message || 'An error occurred.',
    assertive: true,
  };
}

/**
 * Scan tool_activity for the most important status to show after a turn.
 * Prefers confirmation and error over routine progress.
 */
export function statusFromToolActivity(activity = []) {
  if (!Array.isArray(activity) || activity.length === 0) return null;

  let lastProgress = null;
  let pending = null;
  let error = null;

  for (const item of activity) {
    if (item.type === 'progress') {
      lastProgress = statusFromProgressEvent(item);
    } else if (item.type === 'pending_confirmation') {
      pending = statusFromPendingConfirmation(item);
    } else if (item.type === 'error') {
      error = statusFromErrorEvent(item);
    }
  }

  return pending || error || lastProgress;
}

/**
 * Parse a plain-text stream line emitted by the backend /stream endpoint.
 * Matches lines like: [plan] Planning next step
 * or confirmation markers.
 */
export function statusFromStreamLine(line) {
  if (!line || typeof line !== 'string') return null;
  const trimmed = line.trim();
  if (!trimmed) return null;

  const progressMatch = trimmed.match(
    /^\[(plan|inspect|execute|confirm|verify|recover|complete|error|progress)\]\s*(.*)$/i
  );
  if (progressMatch) {
    const phase = progressMatch[1].toLowerCase();
    const message = progressMatch[2] || phaseLabel(phase);
    return {
      phase: phase === 'progress' ? 'plan' : phase,
      message,
      assertive: ASSERTIVE_PHASES.has(phase),
    };
  }

  if (/confirmation required/i.test(trimmed)) {
    return {
      phase: 'confirm',
      message: trimmed.replace(/^\[|\]$/g, '').trim(),
      assertive: true,
    };
  }

  if (/^\[Error:/i.test(trimmed)) {
    return {
      phase: 'error',
      message: trimmed.replace(/^\[Error:\s*/i, '').replace(/\]$/, ''),
      assertive: true,
    };
  }

  return null;
}

/**
 * True if a stream line is agent status (not model chat text).
 */
export function isAgentStatusStreamLine(line) {
  return statusFromStreamLine(line) !== null;
}

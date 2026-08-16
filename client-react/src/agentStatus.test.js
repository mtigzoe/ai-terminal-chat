import { describe, expect, it } from 'vitest';
import {
  phaseLabel,
  statusFromProgressEvent,
  statusFromPendingConfirmation,
  statusFromErrorEvent,
  statusFromToolActivity,
  statusFromStreamLine,
  isAgentStatusStreamLine,
  ASSERTIVE_PHASES,
} from './agentStatus.js';

describe('agentStatus helpers', () => {
  it('maps phases and progress events', () => {
    expect(phaseLabel('plan')).toBe('Planning');
    expect(phaseLabel('confirm')).toBe('Waiting for confirmation');

    const progress = statusFromProgressEvent({
      type: 'progress',
      phase: 'inspect',
      message: 'Inspecting app.py',
    });
    expect(progress?.phase).toBe('inspect');
    expect(progress?.message).toBe('Inspecting app.py');
    expect(progress?.assertive).toBe(false);

    const confirmProgress = statusFromProgressEvent({
      type: 'progress',
      phase: 'confirm',
      message: 'Waiting for confirmation to modify app.py',
    });
    expect(confirmProgress?.assertive).toBe(true);
    expect(ASSERTIVE_PHASES.has('error')).toBe(true);
  });

  it('creates an assertive status for pending confirmation', () => {
    const pending = statusFromPendingConfirmation({
      type: 'pending_confirmation',
      name: 'write_file',
      action_id: 'abc',
      args: { path: 'app.py' },
      preview: { path: 'app.py' },
    });
    expect(pending?.phase).toBe('confirm');
    expect(pending?.assertive).toBe(true);
    expect(pending?.message).toContain('write_file');
    expect(pending?.message).toContain('app.py');
    expect(pending?.message.toLowerCase()).toContain('approve');
  });

  it('creates error and tool-activity statuses', () => {
    const err = statusFromErrorEvent({
      type: 'error',
      message: 'Provider failed',
    });
    expect(err?.phase).toBe('error');
    expect(err?.assertive).toBe(true);

    const activityStatus = statusFromToolActivity([
      { type: 'progress', phase: 'plan', message: 'Planning next step' },
      { type: 'progress', phase: 'inspect', message: 'Inspecting app.py' },
      {
        type: 'pending_confirmation',
        name: 'apply_patch',
        args: { path: 'x.py' },
        preview: { path: 'x.py' },
      },
    ]);
    expect(activityStatus?.phase).toBe('confirm');
  });

  it('parses status lines from the stream', () => {
    const streamStatus = statusFromStreamLine('[inspect] Inspecting app.py');
    expect(streamStatus?.phase).toBe('inspect');
    expect(streamStatus?.message).toBe('Inspecting app.py');
    expect(isAgentStatusStreamLine('[plan] Planning next step')).toBe(true);
    expect(isAgentStatusStreamLine('Hello from the model')).toBe(false);
    expect(isAgentStatusStreamLine('[Confirmation required: write_file action_id=xyz]')).toBe(true);
  });
});

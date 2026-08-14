/**
 * Lightweight tests for agent status helpers.
 * Run with: node --experimental-vm-modules src/agentStatus.test.js
 * (or any ESM-capable runner). Does not claim screen-reader coverage.
 */

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

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed += 1;
  } else {
    failed += 1;
    console.error('FAIL:', message);
  }
}

assert(phaseLabel('plan') === 'Planning', 'phaseLabel plan');
assert(phaseLabel('confirm') === 'Waiting for confirmation', 'phaseLabel confirm');

const progress = statusFromProgressEvent({
  type: 'progress',
  phase: 'inspect',
  message: 'Inspecting app.py',
});
assert(progress?.phase === 'inspect', 'progress phase');
assert(progress?.message === 'Inspecting app.py', 'progress message');
assert(progress?.assertive === false, 'inspect is polite');

const confirmProgress = statusFromProgressEvent({
  type: 'progress',
  phase: 'confirm',
  message: 'Waiting for confirmation to modify app.py',
});
assert(confirmProgress?.assertive === true, 'confirm progress assertive');
assert(ASSERTIVE_PHASES.has('error'), 'error is assertive');

const pending = statusFromPendingConfirmation({
  type: 'pending_confirmation',
  name: 'write_file',
  action_id: 'abc',
  args: { path: 'app.py' },
  preview: { path: 'app.py' },
});
assert(pending?.phase === 'confirm', 'pending phase');
assert(pending?.assertive === true, 'pending assertive');
assert(pending?.message.includes('write_file'), 'pending mentions tool');
assert(pending?.message.includes('app.py'), 'pending mentions path');
assert(pending?.message.toLowerCase().includes('approve'), 'pending asks approval');

const err = statusFromErrorEvent({
  type: 'error',
  message: 'Provider failed',
});
assert(err?.phase === 'error' && err.assertive, 'error status');

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
assert(activityStatus?.phase === 'confirm', 'activity prefers pending');

const streamStatus = statusFromStreamLine('[inspect] Inspecting app.py');
assert(streamStatus?.phase === 'inspect', 'stream line phase');
assert(streamStatus?.message === 'Inspecting app.py', 'stream line message');
assert(isAgentStatusStreamLine('[plan] Planning next step'), 'status line detected');
assert(!isAgentStatusStreamLine('Hello from the model'), 'chat text not status');
assert(isAgentStatusStreamLine('[Confirmation required: write_file action_id=xyz]'), 'confirm line');

console.log(`agentStatus tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

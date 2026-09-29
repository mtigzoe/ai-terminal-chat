import { render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import MessageInput from './MessageInput.jsx';
import ConversationDisplayArea from './ConversationDisplayArea.jsx';

vi.mock('./GitStatusPanel.jsx', () => ({ default: () => null }));

const inputRef = { current: null };

const renderStatus = (agentStatus) => {
  const { container } = render(
    <ConversationDisplayArea
      data={[]}
      agentStatus={agentStatus}
      activity={[]}
      waiting={false}
    />
  );
  return container.querySelector('#agent-status-live');
};

const settle = () => new Promise((r) => setTimeout(r, 120));

describe('MessageInput live region', () => {
  // Regression: the two live-region fragments were adjacent JSX expression
  // containers with no separator. App.jsx commits setPendingConfirmation() and
  // setWaiting(true) together inside a flushSync() when a streaming turn pauses
  // for approval, so both were truthy at once and the region read
  // "Waiting for responseConfirmation required — respond above".
  it('separates the two states when both waiting and pendingConfirmation are set', () => {
    render(
      <MessageInput
        inputRef={inputRef}
        waiting={true}
        pendingConfirmation={{ name: 'create_file' }}
        handleClick={() => {}}
      />
    );
    const text = document.getElementById('message-input-status').textContent;
    expect(text).not.toBe('Waiting for responseConfirmation required — respond above');
    expect(text).toContain('Waiting for response');
    expect(text).toContain('Confirmation required');
    // Words from the two fragments must not run into each other.
    expect(text).not.toMatch(/responseConfirmation/);
  });

  it.each([
    [true, null, 'Waiting for response'],
    [false, { name: 'write_file' }, 'Confirmation required — respond above'],
    [false, null, ''],
  ])(
    'renders a single state cleanly (waiting=%s, pending=%s)',
    (waiting, pending, expected) => {
      render(
        <MessageInput
          inputRef={inputRef}
          waiting={waiting}
          pendingConfirmation={pending}
          handleClick={() => {}}
        />
      );
      expect(document.getElementById('message-input-status').textContent).toBe(expected);
    }
  );
});

describe('AgentStatusRegion', () => {
  // Regression: the announcement was built as "<Phase>. <message>" while the
  // phase label was *also* rendered in its own span, so the chip read
  // "PlanningPlanning. Planning next step" (CSS adds a visual ":" between the
  // spans). The region must contribute only the message; the span supplies the
  // label.
  it.each([
    ['plan', 'Planning next step', 'Planning'],
    ['error', 'Provider offline', 'Error'],
    ['complete', 'Response complete.', 'Completed'],
  ])('renders the message only, for phase=%s', async (phase, message, label) => {
    const region = renderStatus({ phase, message });
    await settle();

    // The two spans are the label and the message; textContent is their
    // concatenation, with no synthesized "<label>. " prefix in between.
    expect(region.textContent).toBe(`${label}${message}`);
    expect(region.textContent).not.toContain(`${label}. `);
  });

  it('does not repeat the phase in the announcement', async () => {
    const region = renderStatus({ phase: 'plan', message: 'Planning next step' });
    await settle();
    // Guard the specific regression: the old code produced a second,
    // synthesized "Planning. " run of text.
    expect(region.textContent).not.toMatch(/^Planning:?\s*Planning\./);
  });

  it('keeps the phase span and message span as separate elements', async () => {
    const region = renderStatus({ phase: 'error', message: 'Provider offline' });
    await settle();
    expect(region.querySelector('.agent-status-phase').textContent).toBe('Error');
    expect(region.querySelector('.agent-status-message').textContent).toBe('Provider offline');
  });

  it('tolerates a status with no message', async () => {
    // The phase span is deliberately gated on there being an announcement, so
    // a message-less status renders an empty region rather than a dangling
    // "Planning:" chip.
    const region = renderStatus({ phase: 'plan' });
    await settle();
    expect(region.querySelector('.agent-status-message').textContent).toBe('');
    expect(region.textContent).toBe('');
  });

  it('announces an empty status region without crashing', () => {
    const region = renderStatus(null);
    expect(region.textContent).toBe('');
  });
});

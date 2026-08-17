import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import ChatArea, { AgentStatusRegion } from './components/ConversationDisplayArea';

describe('ConversationDisplayArea accessibility', () => {
  test('renders a live region for agent status', () => {
    render(<ChatArea data={[]} streamdiv={false} answer="" streamToolActivity={[]} agentStatus={null} waiting={false} />);
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  test('uses polite live region for non-error status', async () => {
    render(<AgentStatusRegion status={{ phase: 'plan', message: 'Planning next step', assertive: false }} />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    await waitFor(() => {
      expect(status).toHaveTextContent('Planning next step');
    });
  });

  test('uses assertive live region for error status', async () => {
    render(<AgentStatusRegion status={{ phase: 'error', message: 'Something went wrong.', assertive: true }} />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'assertive');
    await waitFor(() => {
      expect(status).toHaveTextContent('Something went wrong.');
    });
  });

  test('messages have accessible labels identifying them as user or assistant', () => {
    const data = [
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'hello' }] },
    ];
    render(<ChatArea data={data} streamdiv={false} answer="" streamToolActivity={[]} agentStatus={null} waiting={false} />);

    expect(screen.getByLabelText(/your message, message 1/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/assistant message, message 2/i)).toBeInTheDocument();
  });

  test('the empty state renders no articles', () => {
    render(<ChatArea data={[]} streamdiv={false} answer="" streamToolActivity={[]} agentStatus={null} waiting={false} />);
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });

  test('marks the conversation main area as aria-busy while waiting', () => {
    render(<ChatArea data={[]} streamdiv={false} answer="" streamToolActivity={[]} agentStatus={null} waiting={true} />);
    expect(screen.getByRole('main', { name: /conversation/i })).toHaveAttribute('aria-busy', 'true');
  });

  test('does not mark the conversation as busy when idle', () => {
    render(<ChatArea data={[]} streamdiv={false} answer="" streamToolActivity={[]} agentStatus={null} waiting={false} />);
    expect(screen.getByRole('main', { name: /conversation/i })).toHaveAttribute('aria-busy', 'false');
  });

  test('streaming response uses aria-live=off', () => {
    render(<ChatArea data={[]} streamdiv={true} answer="partial" streamToolActivity={[]} agentStatus={null} waiting={true} />);
    const streaming = screen.getByLabelText(/assistant response in progress/i);
    expect(streaming).toHaveAttribute('aria-live', 'off');
  });

  test('decorative icons are hidden from assistive technology', () => {
    const data = [{ role: 'user', parts: [{ text: 'hi' }] }];
    const { container } = render(<ChatArea data={data} streamdiv={false} answer="" streamToolActivity={[]} agentStatus={null} waiting={false} />);

    const images = container.querySelectorAll('img');
    expect(images.length).toBeGreaterThan(0);
    for (const img of images) {
      expect(img).toHaveAttribute('alt', '');
      expect(img).toHaveAttribute('aria-hidden', 'true');
    }
  });

  test('agent activity section is labelled', () => {
    const data = [{
      role: 'model',
      parts: [{ text: 'done' }],
      toolActivity: [
        { type: 'tool_call', name: 'read_file', args: { path: 'a.txt' } },
      ],
    }];
    render(<ChatArea data={data} streamdiv={false} answer="" streamToolActivity={[]} agentStatus={null} waiting={false} />);

    expect(screen.getByText('Agent activity')).toBeInTheDocument();
  });
});

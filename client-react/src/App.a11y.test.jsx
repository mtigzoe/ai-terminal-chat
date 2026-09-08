import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { vi } from 'vitest';
import App from './App';
import { AgentStatusRegion } from './components/ConversationDisplayArea.jsx';

// See App.test.jsx for why axios is mocked here (avoids a real,
// unmocked network call to /project-root on every test run).
vi.mock('axios', () => ({
  default: {
    get: vi.fn(() => Promise.resolve({ data: { path: '/tmp/project' } })),
    post: vi.fn(),
    isCancel: vi.fn(() => false),
  },
}));

expect.extend(toHaveNoViolations);

test('chat has no automated accessibility violations', async () => {
  const { container } = render(<App />);
  const results = await axe(container);
  expect(results).toHaveNoViolations();
});

test('chat has no automated accessibility violations with streaming mode', async () => {
  const { container, rerender } = render(<App />);
  // Toggle streaming mode
  fireEvent.click(screen.getByRole('button', { name: /stream response off/i }));
  
  const results = await axe(container);
  expect(results).toHaveNoViolations();
});

test('chat has no automated accessibility violations while waiting for response', async () => {
  const axios = (await import('axios')).default;
  axios.post.mockReturnValue(new Promise(() => {}));
  
  const { container } = render(<App />);
  const textarea = screen.getByLabelText(/^message$/i);
  fireEvent.change(textarea, { target: { value: 'hi' } });
  fireEvent.click(screen.getByRole('button', { name: /send message/i }));
  
  await waitFor(() => {
    expect(screen.getByRole('button', { name: /cancel response/i })).toBeInTheDocument();
  });
  
  const results = await axe(container);
  expect(results).toHaveNoViolations();
});

test('agent status region has no automated accessibility violations', async () => {
  const { container } = render(
    <AgentStatusRegion status={{ phase: 'plan', message: 'Planning next step', assertive: false }} />
  );
  const results = await axe(container);
  expect(results).toHaveNoViolations();
});

test('agent status region has no violations for error state', async () => {
  const { container } = render(
    <AgentStatusRegion status={{ phase: 'error', message: 'Request failed.', assertive: true }} />
  );
  const results = await axe(container);
  expect(results).toHaveNoViolations();
});

test('agent status region has no violations for complete state', async () => {
  const { container } = render(
    <AgentStatusRegion status={{ phase: 'complete', message: 'Response complete.', assertive: false }} />
  );
  const results = await axe(container);
  expect(results).toHaveNoViolations();
});

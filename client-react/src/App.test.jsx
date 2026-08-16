import { fireEvent, render, screen } from '@testing-library/react';
import { vi } from 'vitest';
import App from './App';
import { AgentStatusRegion } from './components/ConversationDisplayArea.jsx';

// Mock axios so the mount-time GET /project-root call never hits a
// real socket (previously this produced real ECONNREFUSED noise in
// every test run and made the suite depend on nothing listening on
// 127.0.0.1:9000). No existing test assertions change below.
vi.mock('axios', () => ({
  default: {
    get: vi.fn(() => Promise.resolve({ data: { path: '/tmp/project' } })),
    post: vi.fn(),
    isCancel: vi.fn(() => false),
  },
}));

test('renders core keyboard and screen-reader targets', () => {
  render(<App />);

  expect(screen.getByRole('heading', { name: /chat/i })).toBeInTheDocument();
  expect(screen.getByRole('main', { name: /conversation/i })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /settings/i })).toBeInTheDocument();
  expect(screen.getByLabelText(/^message$/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /send message/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /stream response off/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /clear conversation/i })).toBeInTheDocument();
  expect(document.getElementById('agent-status-live')).toBeTruthy();
});

test('opens an accessible clear-conversation confirmation dialog', () => {
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: /clear conversation/i }));

  expect(screen.getByRole('dialog', { name: /clear conversation\?/i })).toBeInTheDocument();
  expect(screen.getByText(/remove the current conversation/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^cancel$/i })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('announces response lifecycle states through one accessible status region', () => {
  const { rerender } = render(
    <AgentStatusRegion status={{ phase: 'plan', message: 'Planning next step', assertive: false }} />
  );

  const status = screen.getByRole('status');
  expect(status).toHaveAttribute('aria-live', 'polite');
  expect(status).toHaveTextContent('Planning next step');

  rerender(
    <AgentStatusRegion status={{ phase: 'complete', message: 'Response complete.', assertive: false }} />
  );
  expect(screen.getByRole('status')).toHaveTextContent('Response complete.');

  rerender(
    <AgentStatusRegion status={{ phase: 'cancelled', message: 'Response cancelled.', assertive: false }} />
  );
  expect(screen.getByRole('status')).toHaveTextContent('Response cancelled.');
});

test('uses assertive announcements only for error states', () => {
  const { rerender } = render(
    <AgentStatusRegion status={{ phase: 'plan', message: 'Planning next step', assertive: false }} />
  );
  expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');

  rerender(
    <AgentStatusRegion status={{ phase: 'error', message: 'Request failed.', assertive: true }} />
  );
  expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'assertive');
  expect(screen.getByRole('status')).toHaveTextContent('Request failed.');
});

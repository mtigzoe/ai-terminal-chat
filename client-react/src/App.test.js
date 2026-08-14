/**
 * Basic App smoke test.
 * Note: this project uses Vite; full RTL tests require a configured test runner.
 * The placeholder CRA test was replaced so it no longer asserts on missing text.
 */

import { render, screen } from '@testing-library/react';
import App from './App';

test('renders chat app header and message input', () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: /example chat app/i })).toBeInTheDocument();
  expect(screen.getByLabelText(/chat message/i)).toBeInTheDocument();
  // Live region exists even when idle (screen-reader status target).
  expect(document.getElementById('agent-status-live')).toBeTruthy();
});

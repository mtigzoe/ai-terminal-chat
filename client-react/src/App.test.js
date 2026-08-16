/**
 * Basic accessibility smoke test.
 * Note: this project uses Vite; full RTL tests require a configured test runner.
 */

import { render, screen } from '@testing-library/react';
import App from './App';

test('renders core keyboard and screen-reader targets', () => {
  render(<App />);

  expect(screen.getByRole('heading', { name: /example chat app/i })).toBeInTheDocument();
  expect(screen.getByRole('main', { name: /conversation/i })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /settings/i })).toBeInTheDocument();
  expect(screen.getByLabelText(/chat message/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /send message/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /stream response off/i })).toBeInTheDocument();
  expect(document.getElementById('agent-status-live')).toBeTruthy();
});

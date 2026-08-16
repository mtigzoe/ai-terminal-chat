/**
 * Basic accessibility smoke test.
 * Note: this project uses Vite; full RTL tests require a configured test runner.
 */

import { fireEvent, render, screen } from '@testing-library/react';
import App from './App';

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
  expect(screen.getAllByRole('button', { name: /clear conversation/i })).toHaveLength(2);

  fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

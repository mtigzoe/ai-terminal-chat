import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import App from './App';

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    isCancel: vi.fn(() => false),
  },
}));

import axios from 'axios';

function getTextarea() {
  return screen.getByLabelText(/^message$/i);
}

function getSendButton() {
  return screen.getByRole('button', { name: /send message/i });
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  axios.get.mockResolvedValue({ data: { path: '/tmp/project' } });
  axios.post.mockResolvedValue({ data: { text: 'done', tool_activity: [] } });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete global.fetch;
  sessionStorage.clear();
});

test('non-streaming chat sends selected Project paths as allowed_paths', async () => {
  sessionStorage.setItem(
    'ai-terminal-chat:allowed-paths',
    JSON.stringify(['README.md', 'src/App.jsx'])
  );

  render(<App />);
  fireEvent.change(getTextarea(), { target: { value: 'Read the selected files.' } });
  fireEvent.click(getSendButton());

  await waitFor(() => expect(axios.post).toHaveBeenCalled());

  const [, payload] = axios.post.mock.calls[0];
  expect(payload.allowed_paths).toEqual(['README.md', 'src/App.jsx']);
});

test('non-streaming chat sends an empty selection when no Project files are selected', async () => {
  render(<App />);
  fireEvent.change(getTextarea(), { target: { value: 'Read the project.' } });
  fireEvent.click(getSendButton());

  await waitFor(() => expect(axios.post).toHaveBeenCalled());

  const [, payload] = axios.post.mock.calls[0];
  expect(payload.allowed_paths).toEqual([]);
});

test('streaming chat sends selected Project paths as allowed_paths', async () => {
  sessionStorage.setItem(
    'ai-terminal-chat:allowed-paths',
    JSON.stringify(['README.md'])
  );

  let readCount = 0;
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    body: {
      getReader() {
        return {
          read: () => {
            readCount += 1;
            if (readCount === 1) {
              const bytes = new TextEncoder().encode(
                JSON.stringify({ type: 'final', text: 'done' }) + '\n'
              );
              return Promise.resolve({ value: bytes, done: false });
            }
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    },
  });

  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: /stream response off/i }));
  fireEvent.change(getTextarea(), { target: { value: 'Read README.md.' } });
  fireEvent.click(getSendButton());

  await waitFor(() => expect(global.fetch).toHaveBeenCalled());

  const [, request] = global.fetch.mock.calls[0];
  const payload = JSON.parse(request.body);
  expect(payload.allowed_paths).toEqual(['README.md']);
});

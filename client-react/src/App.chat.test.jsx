import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import App from './App';

// App.jsx talks to the backend through axios (chat, project-root) and
// through the raw fetch API (streaming, cancellation). Both are mocked
// here so these tests are deterministic and never touch a real socket
// (previously, App.test.jsx's unmocked axios.get calls produced real
// ECONNREFUSED noise in test output).
vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    isCancel: vi.fn(() => false),
  },
}));

import axios from 'axios';

function makeStreamResponse(chunks, { ok = true, status = 200, statusText = 'OK' } = {}) {
  let index = 0;
  const encoder = new TextEncoder();
  return {
    ok,
    status,
    statusText,
    body: {
      getReader() {
        return {
          read: () => {
            if (index < chunks.length) {
              const chunk = encoder.encode(chunks[index]);
              index += 1;
              return Promise.resolve({ value: chunk, done: false });
            }
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    },
    json: () => Promise.resolve({}),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  axios.get.mockResolvedValue({ data: { path: '/tmp/project' } });
  axios.isCancel.mockReturnValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete global.fetch;
});

function getTextarea() {
  return screen.getByLabelText(/^message$/i);
}

function getSendButton() {
  return screen.getByRole('button', { name: /send message/i });
}

async function sendMessage(text) {
  fireEvent.change(getTextarea(), { target: { value: text } });
  fireEvent.click(getSendButton());
}

describe('non-streaming chat lifecycle', () => {
  test('loading state shows a cancel control, then success displays the response and re-enables input', async () => {
    let resolvePost;
    axios.post.mockReturnValue(
      new Promise((resolve) => {
        resolvePost = resolve;
      })
    );

    render(<App />);
    await sendMessage('hi there');

    // Loading state: a cancel control appears and the send button is
    // disabled (waiting), but the textarea itself must stay usable —
    // see the composer-availability regression test below.
    expect(await screen.findByRole('button', { name: /cancel response/i })).toBeInTheDocument();
    expect(getSendButton()).toBeDisabled();

    resolvePost({ data: { text: 'Hello back', tool_activity: [], request_id: 'req-1' } });

    await screen.findByText('Hello back');
    expect(screen.queryByRole('button', { name: /cancel response/i })).not.toBeInTheDocument();

    const textarea = getTextarea();
    expect(textarea).not.toBeDisabled();
    expect(textarea.value).toBe('');
    fireEvent.change(textarea, { target: { value: 'a follow-up message' } });
    expect(getSendButton()).not.toBeDisabled();
  });

  test('reports tool activity and pending confirmations without losing the final answer', async () => {
    axios.post.mockResolvedValue({
      data: {
        text: 'Done reading the file',
        tool_activity: [
          { type: 'tool_call', name: 'read_file', args: { path: 'a.txt' } },
          { type: 'tool_result', name: 'read_file', result: { contents: 'hi' } },
        ],
        request_id: 'req-2',
      },
    });

    render(<App />);
    await sendMessage('read a.txt');

    await screen.findByText('Done reading the file');
    expect(screen.getAllByText(/read_file/).length).toBeGreaterThan(0);
  });

  test('recovers from a server error response and remains usable', async () => {
    axios.post.mockRejectedValue({ response: { data: { error: 'Provider offline' } } });

    render(<App />);
    await sendMessage('hi');

    await screen.findByText(/Error: Provider offline/);

    const status = document.getElementById('agent-status-live');
    expect(status).toHaveAttribute('aria-live', 'assertive');
    await waitFor(() => {
      expect(status).toHaveTextContent(/provider offline/i);
    });

    const textarea = getTextarea();
    expect(textarea).not.toBeDisabled();
    fireEvent.change(textarea, { target: { value: 'try again' } });
    expect(getSendButton()).not.toBeDisabled();
  });

  test('recovers from a network error with no response payload', async () => {
    axios.post.mockRejectedValue(new Error('Network Error'));

    render(<App />);
    await sendMessage('hi');

    await screen.findByText(/Error: Cannot reach the backend at http:\/\/localhost:9000/);
    expect(getTextarea()).not.toBeDisabled();
  });

  test('cancelling an in-flight request stops it, notifies the backend, and re-enables input', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    axios.post.mockImplementation((url, data, config) => (
      new Promise((resolve, reject) => {
        config.signal.addEventListener('abort', () => {
          const err = new Error('canceled');
          err.name = 'CanceledError';
          err.code = 'ERR_CANCELED';
          reject(err);
        });
      })
    ));

    render(<App />);
    await sendMessage('hi');

    const cancelButton = await screen.findByRole('button', { name: /cancel response/i });
    fireEvent.click(cancelButton);

    await screen.findByText(/Response stopped by user/i);
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/cancel/'),
      expect.objectContaining({ method: 'POST' })
    );
    expect(screen.queryByRole('button', { name: /cancel response/i })).not.toBeInTheDocument();

    const textarea = getTextarea();
    expect(textarea).not.toBeDisabled();
    fireEvent.change(textarea, { target: { value: 'next message' } });
    expect(getSendButton()).not.toBeDisabled();
  });

  test('regression: message composer stays available while a response is pending', async () => {
    // Regression test for "Fix message composer state after sending" —
    // the textarea must remain enabled and editable *during* waiting
    // so the user can prepare their next message; only the send button
    // is disabled until the response finishes or is cancelled.
    axios.post.mockReturnValue(new Promise(() => {})); // never resolves

    render(<App />);
    await sendMessage('hi');

    await screen.findByRole('button', { name: /cancel response/i });

    const textarea = getTextarea();
    expect(textarea).not.toBeDisabled();
    fireEvent.change(textarea, { target: { value: 'queued next message' } });
    expect(textarea.value).toBe('queued next message');
    expect(getSendButton()).toBeDisabled();
  });
});

describe('streaming chat lifecycle', () => {
  function enableStreaming() {
    fireEvent.click(screen.getByRole('button', { name: /stream response off/i }));
  }

  test('streams a response incrementally and displays the final text', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      makeStreamResponse(['Hello ', 'streamed world'])
    );

    render(<App />);
    enableStreaming();
    await sendMessage('hi');

    await screen.findByText('Hello streamed world');
  });

  test('reports an HTTP error from the stream endpoint and remains usable', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      body: null,
      json: () => Promise.reject(new Error('no body')),
    });

    render(<App />);
    enableStreaming();
    await sendMessage('hi');

    await screen.findByText(/Error: Internal Server Error/);
    expect(getTextarea()).not.toBeDisabled();
  });

  test('cancelling a stream mid-flight shows a cancellation message', async () => {
    const abortError = new Error('The user aborted a request.');
    abortError.name = 'AbortError';
    global.fetch = vi.fn().mockImplementation(
      () => new Promise((_resolve, reject) => {
        // Simulate an in-flight request that the AbortController cancels.
        reject(abortError);
      })
    );

    render(<App />);
    enableStreaming();
    await sendMessage('hi');

    await screen.findByText(/Streaming stopped by user/i);
  });
});

describe('tool confirmation resolution', () => {
  test('appends the tool result only to the message that requested confirmation, not every past message', async () => {
    // First turn: an ordinary answer with no tool activity at all.
    axios.post.mockResolvedValueOnce({
      data: { text: 'First answer', tool_activity: [], request_id: 'req-1' },
    });

    render(<App />);
    await sendMessage('first question');
    await screen.findByText('First answer');

    // Second turn: the assistant wants to write a file and needs confirmation.
    axios.post.mockResolvedValueOnce({
      data: {
        text: 'I need permission to write the file',
        tool_activity: [
          { type: 'pending_confirmation', action_id: 'abc123', name: 'write_file', args: { path: 'notes.txt' } },
        ],
        request_id: 'req-2',
      },
    });
    await sendMessage('please write notes.txt');
    await screen.findByText('I need permission to write the file');

    const dialog = await screen.findByRole('dialog', { name: /confirmation required/i });
    expect(dialog).toBeInTheDocument();

    // Resolving the confirmation posts to /confirm and should attach the
    // resulting tool_result to the second (most recent) assistant message
    // only — not to every assistant message in the conversation so far.
    axios.post.mockResolvedValueOnce({ data: { result: { written: true } } });
    fireEvent.click(screen.getByRole('button', { name: /^allow$/i }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    const completedEntries = await screen.findAllByText(/write_file — completed/i);
    expect(completedEntries).toHaveLength(1);

    // "First answer" is the assistant's reply to the first (index 0) user
    // message, so it renders as the second article overall.
    const firstMessage = screen.getByRole('article', { name: 'Assistant message, message 2' });
    expect(within(firstMessage).queryByText(/write_file/i)).not.toBeInTheDocument();
  });
});

describe('project root loading', () => {
  test('shows a status message when the current project cannot be loaded', async () => {
    axios.get.mockRejectedValue(new Error('network down'));

    render(<App />);

    await screen.findByText(/unable to load project directory/i);
  });
});


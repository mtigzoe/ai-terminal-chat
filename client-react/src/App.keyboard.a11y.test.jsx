import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import App from './App';
import axios from 'axios';

vi.mock('axios', () => ({
  default: {
    get: vi.fn(() => Promise.resolve({ data: { path: '/tmp/project' } })),
    post: vi.fn(),
    isCancel: vi.fn(() => false),
  },
}));

describe('keyboard accessibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete global.fetch;
    localStorage.clear();
  });

  test('Enter in the message input submits the message', async () => {
    render(<App />);
    const textarea = screen.getByLabelText(/^message$/i);
    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect(screen.getByText('hello')).toBeInTheDocument();
  });

  test('Shift+Enter in the message input does not submit', () => {
    render(<App />);
    const textarea = screen.getByLabelText(/^message$/i);
    fireEvent.change(textarea, { target: { value: 'line one' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(screen.queryByRole('article', { name: /your message/i })).not.toBeInTheDocument();
  });

  test('Escape closes the clear-conversation confirmation dialog', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /clear conversation/i }));

    expect(screen.getByRole('dialog', { name: /clear conversation\?/i })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('focus returns to the message input after a non-streaming response completes', async () => {
    let resolvePost;
    const axios = (await import('axios')).default;
    axios.post.mockReturnValue(
      new Promise((resolve) => {
        resolvePost = resolve;
      })
    );

    render(<App />);
    const textarea = screen.getByLabelText(/^message$/i);
    fireEvent.change(textarea, { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));

    await screen.findByRole('button', { name: /cancel response/i });

    resolvePost({ data: { text: 'Done', tool_activity: [], request_id: 'req-1' } });

    await screen.findByText('Done');
    expect(textarea).toHaveFocus();
  });

  test('focus returns to the message input after a streaming response completes', async () => {
    const axios = (await import('axios')).default;
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      body: {
        getReader() {
          return {
            read: () => Promise.resolve({ value: new TextEncoder().encode('streamed\n'), done: true }),
          };
        },
      },
    });

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /stream response off/i }));

    const textarea = screen.getByLabelText(/^message$/i);
    fireEvent.change(textarea, { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /cancel response/i })).not.toBeInTheDocument();
    }, { timeout: 3000 });

    await waitFor(() => {
      expect(document.activeElement).toBe(textarea);
    }, { timeout: 3000 });
  });

  test('the send button is disabled while waiting but the textarea stays enabled', async () => {
    axios.post.mockReturnValue(new Promise(() => {}));

    render(<App />);
    const textarea = screen.getByLabelText(/^message$/i);
    fireEvent.change(textarea, { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));

    await screen.findByRole('button', { name: /cancel response/i }, { timeout: 5000 });
    expect(screen.getByRole('button', { name: /send message/i })).toBeDisabled();
    expect(textarea).not.toBeDisabled();
  });
});

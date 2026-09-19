import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import axios from 'axios';
import App from './App';
import SettingsPage from './components/SettingsPage.jsx';
import InstructionsPage from './components/InstructionsPage.jsx';

// ---------------------------------------------------------------------------
// Shared mocks
// ---------------------------------------------------------------------------

// App.jsx and SettingsPage both hit the backend through axios. Mock them so
// smoke tests are deterministic and never touch a real socket.
vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    isCancel: vi.fn(() => false),
  },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  try {
    delete globalThis.fetch;
  } catch {
    // no-op
  }
  try {
    localStorage.clear();
  } catch {
    // ignore unavailable localStorage
  }
});

function mockAxiosGet(data) {
  axios.get.mockResolvedValue({ data });
}

function mockAxiosPost(data) {
  axios.post.mockResolvedValue({ data: { ...data, request_id: 'smoke-req-1' } });
}

function defaultFetch() {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({}),
    text: async () => '',
    headers: new Headers(),
    url: '',
  });
}

// ---------------------------------------------------------------------------
// Smoke tests — high-value application-level checks that the critical
// paths are not broken. These deliberately avoid duplicating the detailed
// component/unit tests already in the suite.
// ---------------------------------------------------------------------------

describe('client-react smoke tests', () => {
  // -----------------------------------------------------------------------
  // 1. Main application shell renders without crashing
  // -----------------------------------------------------------------------
  describe('App shell', () => {
    test('renders the main chat UI and its primary regions', () => {
      mockAxiosGet({ path: '/tmp/project' });
      mockAxiosPost({ text: 'ok' });
      defaultFetch();
      render(<App />);

      expect(screen.getByRole('heading', { name: /chat/i })).toBeInTheDocument();
      expect(screen.getByRole('main', { name: /conversation/i })).toBeInTheDocument();
      expect(screen.getByLabelText(/chat message/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /send message/i })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /settings/i })).toBeInTheDocument();
    });

    test('renders the terminal side panel', () => {
      mockAxiosGet({ path: '/tmp/project' });
      render(<App />);

      expect(screen.getByRole('complementary', { name: /terminal/i })).toBeInTheDocument();
    });
  });

  // -----------------------------------------------------------------------
  // 2. Chat happy path: send a message and handle a successful response
  // -----------------------------------------------------------------------
  describe('chat happy path', () => {
    test('sends a message and displays the response', async () => {
      mockAxiosGet({ path: '/tmp/project' });
      mockAxiosPost({ text: 'Smoke OK', tool_activity: [], request_id: 'r1' });
      defaultFetch();
      render(<App />);

      fireEvent.change(screen.getByLabelText(/chat message/i), { target: { value: 'hello' } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));

      await screen.findByText('Smoke OK');
      expect(screen.getByLabelText(/chat message/i).value).toBe('');
    });
  });

  // -----------------------------------------------------------------------
  // 3. Chat error path: server error does not crash the app
  // -----------------------------------------------------------------------
  describe('chat error path', () => {
    test('recovers from a provider error and keeps input usable', async () => {
      axios.post.mockRejectedValue({ response: { data: { error: 'Smoke failure' } } });
      mockAxiosGet({ path: '/tmp/project' });
      render(<App />);

      fireEvent.change(screen.getByLabelText(/chat message/i), { target: { value: 'hello' } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));

      await screen.findByRole('article', { name: /assistant message/i }).then(el => 
        expect(el).toHaveTextContent(/Error: Smoke failure/)
      );

      const textarea = screen.getByLabelText(/chat message/i);
      expect(textarea).not.toBeDisabled();
      fireEvent.change(textarea, { target: { value: 'retry' } });
      expect(screen.getByRole('button', { name: /send message/i })).not.toBeDisabled();
    });
  });

  // -----------------------------------------------------------------------
  // 4. Settings / Provider path: selecting a provider and saving
  // -----------------------------------------------------------------------
  describe('Settings provider path', () => {
    test('can select a provider and persist the selection via save', async () => {
      mockAxiosGet({
        providers: ['gemini', 'ollama'],
        name: 'gemini',
        model: 'gemini-3.6-flash',
        commands: [],
      });
      mockAxiosPost({ confirmed: true });
      render(<SettingsPage host="http://localhost:9000" />);

      const providerSelect = await waitFor(() => screen.getByLabelText(/ai provider/i));
      expect(providerSelect).toBeTruthy();

      fireEvent.change(providerSelect, { target: { value: 'ollama' } });

      fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
      await waitFor(() => {
        const raw = localStorage.getItem('ai-terminal-chat:provider-selection');
        expect(raw).toBeTruthy();
        const parsed = JSON.parse(raw);
        expect(parsed.provider).toBe('ollama');
      });
    });
  });

  // -----------------------------------------------------------------------
  // 5. Instructions path: saved instructions participate in chat request
  // -----------------------------------------------------------------------
  describe('Instructions path', () => {
    test('saves instructions and includes them in the next chat payload', async () => {
      mockAxiosGet({ path: '/tmp/project' });
      mockAxiosPost({ text: 'ack', tool_activity: [], request_id: 'r1' });
      defaultFetch();

      // Save instructions through the InstructionsPage.
      render(<InstructionsPage />);
      fireEvent.change(screen.getByLabelText(/instructions text/i), { target: { value: 'Use TypeScript.' } });
      fireEvent.click(screen.getByRole('button', { name: /save instructions/i }));
      await screen.findByText(/Instructions saved/);

      // Now send a chat message from the main App and verify the payload.
      render(<App />);
      fireEvent.change(screen.getByLabelText(/chat message/i), { target: { value: 'hi' } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));

      await waitFor(() => {
        expect(axios.post).toHaveBeenCalledWith(
          expect.stringContaining('/chat'),
          expect.objectContaining({ user_instructions: 'Use TypeScript.' }),
          expect.any(Object)
        );
      });
    });
  });

  // -----------------------------------------------------------------------
  // 6. Project / file-selection path: allowed_paths flow through to /chat
  // -----------------------------------------------------------------------
  describe('Project file-selection path', () => {
    test('selected files are sent as allowed_paths in the chat request', async () => {
      mockAxiosGet({ path: '/tmp/project' });
      mockAxiosPost({ text: 'ack', tool_activity: [], request_id: 'r1' });
      defaultFetch();
      localStorage.setItem(
        'ai-terminal-chat:pending-files',
        JSON.stringify([{ path: 'README.md', content: '# README' }])
      );

      render(<App />);
      fireEvent.change(screen.getByLabelText(/chat message/i), { target: { value: 'hi' } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));

      await waitFor(() => {
        expect(axios.post).toHaveBeenCalledWith(
          expect.stringContaining('/chat'),
          expect.objectContaining({ allowed_paths: ['README.md'] }),
          expect.any(Object)
        );
      });
    });
  });

  // -----------------------------------------------------------------------
  // 7. Confirmation path: preserve selected-file read access when resuming
  describe('Confirmation path', () => {
    test('sends current allowed_paths when confirming an agent action', async () => {
      mockAxiosGet({ path: '/tmp/project' });
      defaultFetch();
      localStorage.setItem(
        'ai-terminal-chat:allowed-paths',
        JSON.stringify(['src/App.jsx'])
      );

      axios.post
        .mockResolvedValueOnce({
          data: {
            text: '',
            tool_activity: [{
              type: 'pending_confirmation',
              name: 'write_file',
              action_id: 'action-1',
              args: { path: 'src/App.jsx', contents: 'updated' },
              preview: { description: 'Write src/App.jsx' },
            }],
            request_id: 'r-confirm',
            pending_confirmation: {
              type: 'pending_confirmation',
              name: 'write_file',
              action_id: 'action-1',
              args: { path: 'src/App.jsx', contents: 'updated' },
              preview: { description: 'Write src/App.jsx' },
            },
          },
        })
        .mockResolvedValueOnce({
          data: {
            text: 'Done',
            tool_activity: [
              {
                type: 'tool_result',
                name: 'write_file',
                result: { ok: true },
              },
            ],
          },
        });

      render(<App />);
      fireEvent.change(screen.getByLabelText(/chat message/i), { target: { value: 'update the file' } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));

      const allow = await screen.findByRole('button', { name: /^allow$/i });
      fireEvent.click(allow);

      await waitFor(() => {
        expect(axios.post).toHaveBeenLastCalledWith(
          expect.stringContaining('/confirm'),
          expect.objectContaining({
            action_id: 'action-1',
            confirmed: true,
            allowed_paths: ['src/App.jsx'],
          })
        );
      });
    });
  });


});

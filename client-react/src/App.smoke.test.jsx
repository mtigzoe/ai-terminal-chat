import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import axios from 'axios';
import App from './App';
import SettingsPage from './components/SettingsPage.jsx';
import InstructionsPage from './components/InstructionsPage.jsx';
import ProjectExplorer from './components/ProjectExplorer.jsx';

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
// Smoke tests — these verify the application is not fundamentally broken.
// They deliberately avoid duplicating the detailed lifecycle assertions
// already covered by App.chat.test.jsx and the component a11y tests.
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

      // Heading and conversation region
      expect(screen.getByRole('heading', { name: /chat/i })).toBeInTheDocument();
      expect(screen.getByRole('main', { name: /conversation/i })).toBeInTheDocument();

      // Input and send control
      expect(screen.getByLabelText(/^message$/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /send message/i })).toBeInTheDocument();

      // Navigation link to Settings
      expect(screen.getByRole('link', { name: /settings/i })).toBeInTheDocument();
    });

    test('renders the terminal side panel', () => {
      mockAxiosGet({ path: '/tmp/project' });
      render(<App />);

      // Terminal region
      expect(screen.getByRole('complementary', { name: /terminal/i })).toBeInTheDocument();
    });
  });

  // -----------------------------------------------------------------------
  // 2. Major pages render without crashing
  // -----------------------------------------------------------------------
  describe('major pages', () => {
    test('Settings page renders its core heading and provider controls', async () => {
      mockAxiosGet({
        providers: ['gemini', 'ollama'],
        name: 'gemini',
        model: 'gemini-3.6-flash',
        commands: [],
      });
      mockAxiosPost({ confirmed: true });
      render(<SettingsPage host="http://localhost:9000" />);

      expect(screen.getByRole('heading', { name: /settings/i })).toBeInTheDocument();

      // Use the id-based selector to avoid matching the App's ProviderSelector shim.
      await waitFor(() => {
        expect(document.getElementById('settings-provider')).toBeTruthy();
      });
    });

    test('Instructions page renders its editor and save control', () => {
      render(<InstructionsPage />);

      // Use exact name to avoid matching the nav link text.
      expect(screen.getByRole('heading', { name: 'Instructions' })).toBeInTheDocument();
      expect(screen.getByLabelText(/instructions text/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /save instructions/i })).toBeInTheDocument();
    });

    test('ProjectExplorer renders its heading and file tree region', () => {
      mockAxiosGet({ entries: [], path: '.' });
      render(<ProjectExplorer host="http://localhost:9000" projectRoot="" />);

      expect(screen.getByRole('heading', { name: /project/i })).toBeInTheDocument();
    });
  });

  // -----------------------------------------------------------------------
  // 3. Chat request path: send a message and handle a successful response
  // -----------------------------------------------------------------------
  describe('chat happy path', () => {
    test('sends a message and displays the response', async () => {
      mockAxiosGet({ path: '/tmp/project' });
      mockAxiosPost({ text: 'Smoke OK', tool_activity: [], request_id: 'r1' });
      defaultFetch();
      render(<App />);

      fireEvent.change(screen.getByLabelText(/^message$/i), { target: { value: 'hello' } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));

      await screen.findByText('Smoke OK');
      expect(screen.getByLabelText(/^message$/i).value).toBe('');
    });
  });

  // -----------------------------------------------------------------------
  // 4. Chat error path: server error does not crash the app
  // -----------------------------------------------------------------------
  describe('chat error path', () => {
    test('recovers from a provider error and keeps input usable', async () => {
      axios.post.mockRejectedValue({ response: { data: { error: 'Smoke failure' } } });
      mockAxiosGet({ path: '/tmp/project' });
      render(<App />);

      fireEvent.change(screen.getByLabelText(/^message$/i), { target: { value: 'hello' } });
      fireEvent.click(screen.getByRole('button', { name: /send message/i }));

      await screen.findByText(/Error: Smoke failure/);

      // The app must remain interactive after an error.
      const textarea = screen.getByLabelText(/^message$/i);
      expect(textarea).not.toBeDisabled();
      fireEvent.change(textarea, { target: { value: 'retry' } });
      expect(screen.getByRole('button', { name: /send message/i })).not.toBeDisabled();
    });
  });

  // -----------------------------------------------------------------------
  // 5. Settings / Provider path: selecting a provider and saving
  // -----------------------------------------------------------------------
  describe('Settings provider path', () => {
    test('Settings page renders and the provider form is present', async () => {
      mockAxiosGet({
        providers: ['gemini', 'ollama'],
        name: 'gemini',
        model: 'gemini-3.6-flash',
        commands: [],
      });
      mockAxiosPost({ confirmed: true });
      render(<SettingsPage host="http://localhost:9000" />);

      expect(screen.getByRole('heading', { name: /settings/i })).toBeInTheDocument();

      // Wait for the loading state to finish and the provider form to appear.
      await waitFor(() => {
        expect(screen.getByLabelText(/ai provider/i)).toBeInTheDocument();
      });
    });

    test('can select a provider and persist the selection via save', async () => {
      mockAxiosGet({
        providers: ['gemini', 'ollama'],
        name: 'gemini',
        model: 'gemini-3.6-flash',
        commands: [],
      });
      mockAxiosPost({ confirmed: true });
      render(<SettingsPage host="http://localhost:9000" />);

      // Wait for the provider dropdown to appear after loading.
      const providerSelect = await waitFor(() => screen.getByLabelText(/ai provider/i));
      expect(providerSelect).toBeTruthy();

      fireEvent.change(providerSelect, { target: { value: 'ollama' } });

      // Click save and verify the selection was persisted to localStorage.
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
  // 6. Instructions path: saved instructions participate in chat request
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
      fireEvent.change(screen.getByLabelText(/^message$/i), { target: { value: 'hi' } });
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
  // 7. Project / file-selection path: allowed_paths flow through to /chat
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
      fireEvent.change(screen.getByLabelText(/^message$/i), { target: { value: 'hi' } });
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
});

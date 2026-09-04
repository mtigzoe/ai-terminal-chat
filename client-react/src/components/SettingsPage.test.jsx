import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import SettingsPage from './SettingsPage.jsx';

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

import axios from 'axios';

const HOST = 'http://localhost:9000';

function mockSuccessfulLoad({ provider = 'gemini', model = 'gemini-3.6-flash', ollamaInstalled = false } = {}) {
  axios.get.mockImplementation((url) => {
    if (url === `${HOST}/providers?probe=0`) {
      return Promise.resolve({
        data: { providers: ['gemini', 'ollama'], name: provider, model },
      });
    }
    if (url === `${HOST}/project-root`) {
      return Promise.resolve({ data: { path: '/tmp/project' } });
    }
    if (url === `${HOST}/allowed-commands`) {
      return Promise.resolve({ data: { commands: [] } });
    }
    if (url === `${HOST}/providers/ollama/status`) {
      return Promise.resolve({ data: { installed: ollamaInstalled } });
    }
    if (url.startsWith(`${HOST}/providers/`) && url.endsWith('/models')) {
      return Promise.resolve({ data: { models: [], supports_listing: false } });
    }
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function renderLoaded(options) {
  mockSuccessfulLoad(options);
  render(<SettingsPage host={HOST} />);
  await waitFor(() => expect(screen.queryByText(/loading settings/i)).not.toBeInTheDocument());
}

describe('loading settings', () => {
  test('shows a loading status before settings arrive', () => {
    axios.get.mockReturnValue(new Promise(() => {})); // never resolves

    render(<SettingsPage host={HOST} />);

    expect(screen.getByText(/loading settings/i)).toBeInTheDocument();
  });

  test('populates the form from the backend once loaded', async () => {
    await renderLoaded();

    expect(screen.getByRole('heading', { name: /active project/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /provider settings/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/ai provider/i)).toHaveValue('gemini');
    expect(screen.getByLabelText(/^model$/i)).toHaveValue('gemini-3.6-flash');
  });

  test('shows an error status when settings fail to load, without crashing', async () => {
    axios.get.mockRejectedValue(new Error('network down'));

    render(<SettingsPage host={HOST} />);

    await screen.findByText(/could not load settings from the backend/i);
    // The form must still render (not a blank/crashed page) so the
    // user can retry once the backend is reachable again.
    expect(screen.getByLabelText(/ai provider/i)).toBeInTheDocument();
  });

  test('populates a model dropdown when the provider supports listing', async () => {
    axios.get.mockImplementation((url) => {
      if (url === `${HOST}/providers?probe=0`) {
        return Promise.resolve({
          data: { providers: ['ollama'], name: 'ollama', model: 'llama3.1' },
        });
      }
      if (url === `${HOST}/project-root`) {
        return Promise.resolve({ data: { path: '/tmp/project' } });
      }
      if (url === `${HOST}/allowed-commands`) {
        return Promise.resolve({ data: { commands: [] } });
      }
      if (url === `${HOST}/providers/ollama/status`) {
        return Promise.resolve({ data: { installed: false } });
      }
      if (url === `${HOST}/providers/ollama/models`) {
        return Promise.resolve({
          data: { supports_listing: true, models: [{ id: 'llama3.1' }, { id: 'qwen3.5' }] },
        });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    render(<SettingsPage host={HOST} />);
    await waitFor(() => expect(screen.queryByText(/loading settings/i)).not.toBeInTheDocument());

    const modelSelect = screen.getByLabelText(/^model$/i);
    expect(modelSelect.tagName).toBe('SELECT');
    expect(screen.getByRole('option', { name: 'llama3.1' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'qwen3.5' })).toBeInTheDocument();
  });

  test('surfaces Ollama model listing errors from the backend', async () => {
    axios.get.mockImplementation((url) => {
      if (url === `${HOST}/providers?probe=0`) {
        return Promise.resolve({
          data: { providers: ['ollama'], name: 'ollama', model: 'llama3.1' },
        });
      }
      if (url === `${HOST}/project-root`) {
        return Promise.resolve({ data: { path: '/tmp/project' } });
      }
      if (url === `${HOST}/allowed-commands`) {
        return Promise.resolve({ data: { commands: [] } });
      }
      if (url === `${HOST}/providers/ollama/status`) {
        return Promise.resolve({ data: { installed: false } });
      }
      if (url === `${HOST}/providers/ollama/models`) {
        return Promise.resolve({
          data: {
            supports_listing: true,
            models: [],
            available: false,
            error: 'Could not reach Ollama at http://localhost:11434. Is Ollama running?',
          },
        });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    render(<SettingsPage host={HOST} />);
    await waitFor(() => expect(screen.queryByText(/loading settings/i)).not.toBeInTheDocument());

    expect(
      screen.getByText(/could not reach ollama at http:\/\/localhost:11434/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/for ollama, choose a model/i)).toBeInTheDocument();
  });
});

describe('saving settings', () => {
  test('a successful save updates the status message and clears the API key field', async () => {
    await renderLoaded();
    axios.post.mockImplementation((url, payload) => {
      if (url === `${HOST}/providers/select`) {
        return Promise.resolve({ data: { name: payload.provider, model: payload.model } });
      }
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });

    fireEvent.change(screen.getByLabelText(/api key/i), { target: { value: 'sk-test-123' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await screen.findByText(/settings saved for gemini/i);
    expect(screen.getByLabelText(/api key/i)).toHaveValue('');
    expect(screen.getByRole('button', { name: /^save$/i })).not.toBeDisabled();
  });

  test('a failed save surfaces the backend error and resets the saving state', async () => {
    await renderLoaded();
    axios.post.mockRejectedValue({
      response: { data: { error: 'Could not verify the provided API key.' } },
    });

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await screen.findByText(/could not verify the provided api key/i);
    const saveButton = screen.getByRole('button', { name: /^save$/i });
    expect(saveButton).not.toBeDisabled();
    expect(saveButton).toHaveTextContent(/^save$/i);
  });

  test('a network-level save failure (no response payload) still surfaces a usable message', async () => {
    await renderLoaded();
    axios.post.mockRejectedValue(new Error('Network Error'));

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await screen.findByText(/network error/i);
    expect(screen.getByRole('button', { name: /^save$/i })).not.toBeDisabled();
  });

  test('saving Ollama with capability notes surfaces them as status feedback', async () => {
    await renderLoaded({ provider: 'ollama', model: 'llama3.1' });
    axios.post.mockImplementation((url, payload) => {
      if (url === `${HOST}/providers/select`) {
        return Promise.resolve({
          data: {
            name: 'ollama',
            model: payload.model,
            available: true,
            capabilities: {
              notes: "Ollama is reachable but model 'llama3.1' is not installed.",
            },
          },
        });
      }
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });

    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await screen.findByText(/is not installed/i);
  });
});

describe('Install/Run Ollama action', () => {
  test('is not shown for a non-Ollama provider', async () => {
    await renderLoaded({ provider: 'gemini' });

    expect(screen.queryByRole('link', { name: /install ollama/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /run ollama/i })).not.toBeInTheDocument();
  });

  test('shows a checking status while the CLI check is in flight', async () => {
    axios.get.mockImplementation((url) => {
      if (url === `${HOST}/providers?probe=0`) {
        return Promise.resolve({
          data: { providers: ['gemini', 'ollama'], name: 'ollama', model: 'llama3.1' },
        });
      }
      if (url === `${HOST}/project-root`) {
        return Promise.resolve({ data: { path: '/tmp/project' } });
      }
      if (url === `${HOST}/allowed-commands`) {
        return Promise.resolve({ data: { commands: [] } });
      }
      if (url === `${HOST}/providers/ollama/status`) {
        return new Promise(() => {}); // never resolves
      }
      if (url === `${HOST}/providers/ollama/models`) {
        return Promise.resolve({ data: { models: [], supports_listing: false } });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    render(<SettingsPage host={HOST} />);
    await waitFor(() => expect(screen.queryByText(/loading settings/i)).not.toBeInTheDocument());

    expect(screen.getByText(/checking for ollama/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /install ollama/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /run ollama/i })).not.toBeInTheDocument();
  });

  test('offers an Install Ollama link to the official site when the CLI is not found', async () => {
    await renderLoaded({ provider: 'ollama', model: 'llama3.1', ollamaInstalled: false });

    expect(screen.getByText(/ollama is not installed/i)).toBeInTheDocument();
    const installLink = screen.getByRole('link', { name: /install ollama/i });
    expect(installLink).toHaveAttribute('href', 'https://ollama.com/download');
    expect(installLink).toHaveAttribute('target', '_blank');
    expect(screen.queryByRole('button', { name: /run ollama/i })).not.toBeInTheDocument();
  });

  test('offers a Run Ollama button when the CLI is recognized', async () => {
    await renderLoaded({ provider: 'ollama', model: 'llama3.1', ollamaInstalled: true });

    expect(screen.getByText(/ollama is installed/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /run ollama/i })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /install ollama/i })).not.toBeInTheDocument();
  });

  test('clicking Run Ollama starts the model without the user typing a command', async () => {
    await renderLoaded({ provider: 'ollama', model: 'llama3.1', ollamaInstalled: true });
    axios.post.mockImplementation((url) => {
      if (url === `${HOST}/providers/ollama/run`) {
        return Promise.resolve({ data: { started: true, model: 'llama3.1', pid: 123 } });
      }
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });

    fireEvent.click(screen.getByRole('button', { name: /run ollama/i }));

    await screen.findByText(/started `ollama run llama3\.1`/i);
    expect(axios.post).toHaveBeenCalledWith(`${HOST}/providers/ollama/run`, { model: 'llama3.1' });
  });

  test('a failed Run Ollama request surfaces the backend error', async () => {
    await renderLoaded({ provider: 'ollama', model: 'llama3.1', ollamaInstalled: true });
    axios.post.mockRejectedValue({
      response: { data: { error: 'The `ollama` command was not found on PATH.' } },
    });

    fireEvent.click(screen.getByRole('button', { name: /run ollama/i }));

    await screen.findByText(/was not found on path/i);
    expect(screen.getByRole('button', { name: /run ollama/i })).not.toBeDisabled();
  });

  test('the Run Ollama button is disabled until a model is chosen', async () => {
    await renderLoaded({ provider: 'ollama', model: '', ollamaInstalled: true });

    expect(screen.getByRole('button', { name: /run ollama/i })).toBeDisabled();
  });

  test('re-checks CLI status when switching the provider to Ollama', async () => {
    await renderLoaded({ provider: 'gemini' });
    axios.get.mockImplementation((url) => {
      if (url === `${HOST}/providers/ollama/status`) {
        return Promise.resolve({ data: { installed: true } });
      }
      if (url === `${HOST}/providers/ollama/models`) {
        return Promise.resolve({ data: { models: [], supports_listing: false } });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    fireEvent.change(screen.getByLabelText(/ai provider/i), { target: { value: 'ollama' } });

    await screen.findByRole('button', { name: /run ollama/i });
  });
});

describe('page structure', () => {
  test('places Active Project between navigation and Provider settings', async () => {
    await renderLoaded();

    const nav = screen.getByRole('navigation', { name: /main/i });
    const activeProject = screen.getByRole('heading', { name: /active project/i });
    const providerSettings = screen.getByRole('heading', { name: /provider settings/i });

    expect(nav.compareDocumentPosition(activeProject) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(activeProject.compareDocumentPosition(providerSettings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

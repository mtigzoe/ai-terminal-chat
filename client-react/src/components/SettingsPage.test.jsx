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

function mockSuccessfulLoad({ provider = 'gemini', model = 'gemini-3.6-flash' } = {}) {
  axios.get.mockImplementation((url) => {
    if (url === `${HOST}/providers?probe=0`) {
      return Promise.resolve({
        data: { providers: ['gemini', 'ollama'], name: provider, model },
      });
    }
    if (url === `${HOST}/project-root`) {
      return Promise.resolve({ data: { path: '/tmp/project' } });
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

    expect(screen.getByLabelText(/default project path/i)).toHaveValue('/tmp/project');
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
});

describe('saving settings', () => {
  test('a successful save updates the status message and clears the API key field', async () => {
    await renderLoaded();
    axios.post.mockImplementation((url, payload) => {
      if (url === `${HOST}/providers/select`) {
        return Promise.resolve({ data: { name: payload.provider, model: payload.model } });
      }
      if (url === `${HOST}/project-root`) {
        return Promise.resolve({ data: { path: payload.path } });
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
});

describe('folder picker', () => {
  test('a folder-picker failure surfaces an error and resets the button label', async () => {
    await renderLoaded();
    axios.post.mockRejectedValue({
      response: { data: { error: 'The native folder picker is unavailable on this system.' } },
    });

    const chooseButton = screen.getByRole('button', { name: /choose a folder/i });
    fireEvent.click(chooseButton);

    await screen.findByText(/native folder picker is unavailable/i);
    expect(screen.getByRole('button', { name: /choose a folder/i })).not.toBeDisabled();
  });

  test('a successful folder pick updates the project path field', async () => {
    await renderLoaded();
    axios.post.mockImplementation((url, payload) => {
      if (url === `${HOST}/project-root` && payload.path === '__CHOOSE_PROJECT_ROOT__') {
        return Promise.resolve({ data: { path: '/tmp/chosen-project' } });
      }
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });

    fireEvent.click(screen.getByRole('button', { name: /choose a folder/i }));

    await waitFor(() =>
      expect(screen.getByLabelText(/default project path/i)).toHaveValue('/tmp/chosen-project')
    );
  });
});

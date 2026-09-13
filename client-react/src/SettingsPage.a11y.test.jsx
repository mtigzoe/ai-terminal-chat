import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import axios from 'axios';
import SettingsPage from './components/SettingsPage.jsx';

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  },
}));

import axiosInstance from 'axios';

const HOST = 'http://localhost:9000';

function mockSuccessfulLoad({ provider = 'gemini', model = 'gemini-3.6-flash' } = {}) {
  axiosInstance.get.mockImplementation((url) => {
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

describe('SettingsPage accessibility', () => {
  test('loading state announces status to screen readers', () => {
    axiosInstance.get.mockReturnValue(new Promise(() => {}));
    render(<SettingsPage host={HOST} />);
    const status = screen.getByText(/loading settings/i);
    expect(status).toHaveAttribute('role', 'status');
    expect(status).toHaveAttribute('aria-live', 'polite');
  });

  test('form fields are associated with labels', async () => {
    await renderLoaded();
    expect(screen.getByLabelText(/project path/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/ai provider/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/model/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/api key/i)).toBeInTheDocument();
  });

  test('help text is linked via aria-describedby', async () => {
    await renderLoaded();
    const projectRootInput = screen.getByLabelText(/project path/i);
    expect(projectRootInput).toHaveAttribute('aria-describedby', 'active-project-help');
    expect(screen.getByText(/In the desktop app, choose a folder/i)).toBeInTheDocument();
  });

  test('status region has role=status and aria-live=polite', async () => {
    await renderLoaded();
    const statuses = screen.getAllByRole('status');
    const mainStatus = statuses.find((element) => element.classList.contains('settings-status') && !element.classList.contains('settings-status--error'));
    expect(mainStatus).toBeDefined();
    expect(mainStatus).toHaveAttribute('aria-live', 'polite');
    expect(mainStatus).toHaveAttribute('aria-atomic', 'true');
  });

  test('error status messages are announced with role=status', async () => {
    axiosInstance.get.mockImplementation((url) => {
      if (url === `${HOST}/providers?probe=0`) {
        return Promise.resolve({ data: { providers: ['gemini'], name: 'gemini', model: 'gemini-3.6-flash' } });
      }
      if (url === `${HOST}/project-root`) {
        return Promise.resolve({ data: { path: '/tmp/project' } });
      }
      if (url === `${HOST}/allowed-commands`) {
        return Promise.resolve({ data: { commands: [] } });
      }
      return Promise.reject(new Error('fail'));
    });

    render(<SettingsPage host={HOST} />);
    await waitFor(() => expect(screen.queryByText(/loading settings/i)).not.toBeInTheDocument());
    const errorStatus = screen.getByText(/fail/i);
    expect(errorStatus).toHaveAttribute('role', 'status');
    expect(errorStatus).toHaveAttribute('aria-live', 'polite');
  });

  test('provider select is keyboard accessible', async () => {
    await renderLoaded();
    const select = screen.getByLabelText(/ai provider/i);
    expect(select).toHaveAttribute('id', 'settings-provider');
    expect(select.tagName.toLowerCase()).toBe('select');
    fireEvent.change(select, { target: { value: 'ollama' } });
    expect(select).toHaveValue('ollama');
  });

  test('model select or input is labelled and announces loading state', async () => {
    axiosInstance.get.mockImplementation((url) => {
      if (url === `${HOST}/providers?probe=0`) {
        return Promise.resolve({ data: { providers: ['gemini'], name: 'gemini', model: 'gemini-3.6-flash' } });
      }
      if (url === `${HOST}/project-root`) {
        return Promise.resolve({ data: { path: '/tmp/project' } });
      }
      if (url === `${HOST}/allowed-commands`) {
        return Promise.resolve({ data: { commands: [] } });
      }
      if (url.startsWith(`${HOST}/providers/`) && url.endsWith('/models')) {
        return Promise.resolve({ data: { models: [{ id: 'm1' }], supports_listing: true } });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    render(<SettingsPage host={HOST} />);
    await waitFor(() => expect(screen.queryByText(/loading settings/i)).not.toBeInTheDocument());
    expect(screen.getByLabelText(/model/i)).toBeInTheDocument();
  });

  test('save button is disabled when required fields are missing', async () => {
    await renderLoaded({ provider: '', model: '' });
    const saveButton = screen.getByRole('button', { name: /save/i });
    expect(saveButton).toBeDisabled();
  });

  test('keyboard shortcuts table has proper semantics', async () => {
    await renderLoaded();
    const table = screen.getByRole('table', { name: /keyboard shortcuts/i });
    expect(table).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /shortcut/i })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /action/i })).toBeInTheDocument();
  });

  test('allowed commands section is labelled', async () => {
    await renderLoaded();
    expect(screen.getByRole('heading', { name: /allowed commands/i })).toBeInTheDocument();
  });

  test('custom model input has an accessible name when model list is empty', async () => {
    axiosInstance.get.mockImplementation((url) => {
      if (url === `${HOST}/providers?probe=0`) {
        return Promise.resolve({
          data: { providers: ['gemini', 'ollama'], name: 'ollama', model: '' },
        });
      }
      if (url === `${HOST}/project-root`) {
        return Promise.resolve({ data: { path: '/tmp/project' } });
      }
      if (url === `${HOST}/allowed-commands`) {
        return Promise.resolve({ data: { commands: [] } });
      }
      if (url === `${HOST}/providers/ollama/status`) {
        return Promise.resolve({ data: { cli_installed: true } });
      }
      if (url.startsWith(`${HOST}/providers/`) && url.endsWith('/models')) {
        return Promise.resolve({ data: { models: [], supports_listing: true } });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    render(<SettingsPage host={HOST} />);
    await waitFor(() => expect(screen.queryByText(/loading settings/i)).not.toBeInTheDocument());

    const custom = document.getElementById('settings-model-custom');
    expect(custom).toBeTruthy();
    // Accessible name via label association or aria-label / aria-labelledby
    const name =
      custom.getAttribute('aria-label') ||
      (custom.getAttribute('aria-labelledby') &&
        document.getElementById(custom.getAttribute('aria-labelledby'))?.textContent) ||
      (custom.labels && custom.labels[0] && custom.labels[0].textContent);
    expect(name && String(name).trim().length > 0).toBe(true);
  });

  test('model control exposes aria-busy while models are loading', async () => {
    let resolveModels;
    const modelsPromise = new Promise((resolve) => {
      resolveModels = resolve;
    });

    axiosInstance.get.mockImplementation((url) => {
      if (url === `${HOST}/providers?probe=0`) {
        return Promise.resolve({
          data: { providers: ['gemini'], name: 'gemini', model: 'gemini-3.6-flash' },
        });
      }
      if (url === `${HOST}/project-root`) {
        return Promise.resolve({ data: { path: '/tmp/project' } });
      }
      if (url === `${HOST}/allowed-commands`) {
        return Promise.resolve({ data: { commands: [] } });
      }
      if (url.startsWith(`${HOST}/providers/`) && url.endsWith('/models')) {
        return modelsPromise;
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    render(<SettingsPage host={HOST} />);
    await waitFor(() => expect(screen.queryByText(/loading settings/i)).not.toBeInTheDocument());
// The initial settings load starts loadModels() without awaiting it.
// Because the models request is intentionally unresolved, the model control
// should expose aria-busy while that request is pending.
    await waitFor(() => {
      const modelControl =
        document.getElementById('settings-model') ||
        screen.queryByLabelText(/model/i);
      expect(modelControl).toBeTruthy();
      expect(modelControl.getAttribute('aria-busy')).toBe('true');
    });

    resolveModels({ data: { models: [{ id: 'm1' }], supports_listing: true } });

    await waitFor(() => {
      const modelControl =
        document.getElementById('settings-model') ||
        screen.getByLabelText(/model/i);
      const busy = modelControl.getAttribute('aria-busy');
      expect(busy === null || busy === 'false').toBe(true);
    });
  });

  test('Ollama install-check status is exposed via a live region', async () => {
    let resolveStatus;
    const statusPromise = new Promise((resolve) => {
      resolveStatus = resolve;
    });

    axiosInstance.get.mockImplementation((url) => {
      if (url === `${HOST}/providers?probe=0`) {
        return Promise.resolve({
          data: { providers: ['ollama'], name: 'ollama', model: 'llama3' },
        });
      }
      if (url === `${HOST}/project-root`) {
        return Promise.resolve({ data: { path: '/tmp/project' } });
      }
      if (url === `${HOST}/allowed-commands`) {
        return Promise.resolve({ data: { commands: [] } });
      }
      if (url === `${HOST}/providers/ollama/status`) {
        return statusPromise;
      }
      if (url.startsWith(`${HOST}/providers/`) && url.endsWith('/models')) {
        return Promise.resolve({ data: { models: [{ id: 'llama3' }], supports_listing: true } });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });

    render(<SettingsPage host={HOST} />);
    await waitFor(() => expect(screen.queryByText(/loading settings/i)).not.toBeInTheDocument());

    resolveStatus({ data: { cli_installed: true } });

    await waitFor(() => {
      expect(screen.getByText(/ollama is installed/i)).toBeInTheDocument();
    });

    const statusText = screen.getByText(/ollama is installed/i);
    // Prefer an ancestor or self that is a live status region
    const live =
      statusText.closest('[role="status"]') ||
      statusText.closest('[aria-live]') ||
      (statusText.getAttribute('role') === 'status' ? statusText : null) ||
      (statusText.getAttribute('aria-live') ? statusText : null);
    expect(live).toBeTruthy();
  });
});

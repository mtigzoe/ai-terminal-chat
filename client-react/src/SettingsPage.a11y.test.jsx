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
    expect(screen.getByLabelText(/default project path/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/ai provider/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/model/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/api key/i)).toBeInTheDocument();
  });

  test('help text is linked via aria-describedby', async () => {
    await renderLoaded();
    const projectRootInput = screen.getByLabelText(/default project path/i);
    expect(projectRootInput).toHaveAttribute('aria-describedby', 'settings-project-root-help');
    expect(screen.getByText(/the backend uses this directory/i)).toBeInTheDocument();
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

  test('back link navigates to chat', async () => {
    await renderLoaded();
    const backLink = screen.getByRole('link', { name: /back to chat/i });
    expect(backLink).toHaveAttribute('href', '/');
  });

  test('allowed commands section is labelled', async () => {
    await renderLoaded();
    expect(screen.getByRole('heading', { name: /allowed commands/i })).toBeInTheDocument();
  });
});

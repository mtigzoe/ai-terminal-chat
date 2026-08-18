import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import axios from 'axios';
import ProjectRootManager from './ProjectRootManager';

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

describe('ProjectRootManager accessibility and project switching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.electronAPI = {
      chooseFolder: vi.fn(),
    };
    axios.get.mockResolvedValue({ data: { path: 'C:\\Projects\\current' } });
  });

  test('exposes an accessible active-project region and current path', async () => {
    render(<ProjectRootManager host="http://localhost:9000" />);

    expect(screen.getByRole('region', { name: /active project/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /choose and use project folder/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /refresh project/i })).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('C:\\Projects\\current')).toBeInTheDocument();
    });
  });

  test('chooses a native folder and persists it immediately', async () => {
    window.electronAPI.chooseFolder.mockResolvedValue('C:\\Projects\\new-project');
    axios.post.mockResolvedValue({ data: { path: 'C:\\Projects\\new-project' } });

    render(<ProjectRootManager host="http://localhost:9000" />);
    await waitFor(() => expect(axios.get).toHaveBeenCalledWith('http://localhost:9000/project-root'));

    fireEvent.click(screen.getByRole('button', { name: /choose and use project folder/i }));

    await waitFor(() => {
      expect(window.electronAPI.chooseFolder).toHaveBeenCalledWith('C:\\Projects\\current');
      expect(axios.post).toHaveBeenCalledWith('http://localhost:9000/project-root', {
        path: 'C:\\Projects\\new-project',
      });
      expect(screen.getByText('Active project changed to C:\\Projects\\new-project.')).toBeInTheDocument();
    });
  });

  test('leaves the current project unchanged when the native picker is cancelled', async () => {
    window.electronAPI.chooseFolder.mockResolvedValue(null);

    render(<ProjectRootManager host="http://localhost:9000" />);
    await waitFor(() => expect(screen.getByText('C:\\Projects\\current')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /choose and use project folder/i }));

    await waitFor(() => {
      expect(screen.getByText('Folder selection cancelled.')).toBeInTheDocument();
    });
    expect(axios.post).not.toHaveBeenCalled();
    expect(screen.getByText('C:\\Projects\\current')).toBeInTheDocument();
  });

  test('does not claim native selection is available in a browser-only environment', async () => {
    delete window.electronAPI;

    render(<ProjectRootManager host="http://localhost:9000" />);
    await waitFor(() => expect(screen.getByText('C:\\Projects\\current')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /choose and use project folder/i }));

    await waitFor(() => {
      expect(screen.getByText(/available in the Electron desktop app/i)).toBeInTheDocument();
    });
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('Choose and use project folder button is keyboard accessible', async () => {
    render(<ProjectRootManager host="http://localhost:9000" />);
    await waitFor(() => expect(screen.getByText('C:\\Projects\\current')).toBeInTheDocument());

    const button = screen.getByRole('button', { name: /choose and use project folder/i });
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute('type', 'button');
    expect(button).toHaveAttribute('aria-describedby', 'active-project-help');
  });

  test('restores focus after a successful native selection', async () => {
    window.electronAPI.chooseFolder.mockResolvedValue('C:\\Projects\\new-project');
    axios.post.mockResolvedValue({ data: { path: 'C:\\Projects\\new-project' } });

    render(<ProjectRootManager host="http://localhost:9000" />);
    await waitFor(() => expect(screen.getByText('C:\\Projects\\current')).toBeInTheDocument());

    const button = screen.getByRole('button', { name: /choose and use project folder/i });
    button.focus();
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText('Active project changed to C:\\Projects\\new-project.')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: /choose and use project folder/i })
      );
    });
  });

  test('restores focus after native picker cancellation', async () => {
    window.electronAPI.chooseFolder.mockResolvedValue(null);

    render(<ProjectRootManager host="http://localhost:9000" />);
    await waitFor(() => expect(screen.getByText('C:\\Projects\\current')).toBeInTheDocument());

    const button = screen.getByRole('button', { name: /choose and use project folder/i });
    button.focus();
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText('Folder selection cancelled.')).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: /choose and use project folder/i })
      );
    });
  });

  test('restores focus after a native selection error', async () => {
    window.electronAPI.chooseFolder.mockRejectedValue(new Error('Native dialog failed'));

    render(<ProjectRootManager host="http://localhost:9000" />);
    await waitFor(() => expect(screen.getByText('C:\\Projects\\current')).toBeInTheDocument());

    const button = screen.getByRole('button', { name: /choose and use project folder/i });
    button.focus();
    fireEvent.click(button);

    await waitFor(() => {
      expect(screen.getByText(/native dialog failed/i)).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: /choose and use project folder/i })
      );
    });
  });

  test('status region announces outcomes without a second live path region', async () => {
    window.electronAPI.chooseFolder.mockResolvedValue('C:\\Projects\\new-project');
    axios.post.mockResolvedValue({ data: { path: 'C:\\Projects\\new-project' } });

    render(<ProjectRootManager host="http://localhost:9000" />);
    await waitFor(() => expect(screen.getByText('C:\\Projects\\current')).toBeInTheDocument());

    const pathOutput = screen.getByText('C:\\Projects\\current');
    expect(pathOutput.closest('output')).not.toHaveAttribute('aria-live');

    fireEvent.click(screen.getByRole('button', { name: /choose and use project folder/i }));

    await waitFor(() => {
      expect(screen.getByText('Active project changed to C:\\Projects\\new-project.')).toBeInTheDocument();
    });

    const status = screen.getByText('Active project changed to C:\\Projects\\new-project.');
    expect(status).toHaveAttribute('role', 'status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveAttribute('aria-atomic', 'true');
  });
});

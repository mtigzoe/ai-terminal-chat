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
});

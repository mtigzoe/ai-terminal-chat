import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import axios from 'axios';
import GitStatusPanel, { formatGitStatusLine, REPO_MUTATING_TOOLS } from './GitStatusPanel.jsx';

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
  },
}));

describe('formatGitStatusLine', () => {
  test('formats clean branch', () => {
    expect(formatGitStatusLine({ branch: 'main', clean: true })).toBe(
      'Git status — main — clean'
    );
  });

  test('formats modified and untracked counts', () => {
    expect(
      formatGitStatusLine({
        branch: 'main',
        clean: false,
        changed: 2,
        staged: 0,
        untracked: 3,
      })
    ).toBe('Git status — main — 2 modified, 3 untracked');
  });
});

describe('GitStatusPanel real-time refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('refetches when refreshToken increases after a mutating tool', async () => {
    axios.get
      .mockResolvedValueOnce({
        data: { branch: 'main', clean: true, changed: 0, staged: 0, untracked: 0 },
      })
      .mockResolvedValueOnce({
        data: {
          branch: 'main',
          clean: false,
          changed: 1,
          staged: 0,
          untracked: 2,
        },
      });

    const { rerender } = render(
      <GitStatusPanel host="http://localhost:9000" waiting={true} refreshToken={0} />
    );

    await screen.findByText('Git status — main — clean');
    expect(axios.get).toHaveBeenCalledWith(
      'http://localhost:9000/git-status',
      expect.any(Object)
    );

    rerender(
      <GitStatusPanel host="http://localhost:9000" waiting={true} refreshToken={1} />
    );

    await waitFor(() => {
      expect(
        screen.getByText('Git status — main — 1 modified, 2 untracked')
      ).toBeInTheDocument();
    });
    expect(axios.get).toHaveBeenCalledTimes(2);
  });

  test('mutating tool set includes write_file and git_add', () => {
    expect(REPO_MUTATING_TOOLS.has('write_file')).toBe(true);
    expect(REPO_MUTATING_TOOLS.has('git_add')).toBe(true);
    expect(REPO_MUTATING_TOOLS.has('read_file')).toBe(false);
  });
});

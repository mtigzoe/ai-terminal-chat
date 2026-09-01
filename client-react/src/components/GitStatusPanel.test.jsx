import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import axios from 'axios';
import GitStatusPanel, { formatGitStatusLine, parseGitStatus } from './GitStatusPanel.jsx';

vi.mock('axios', () => ({
  default: {
    post: vi.fn(),
  },
}));

describe('parseGitStatus', () => {
  test('parses a clean branch', () => {
    expect(parseGitStatus('## main...origin/main\n')).toEqual({
      branch: 'main',
      clean: true,
      staged: 0,
      changed: 0,
      modified: 0,
      untracked: 0,
      conflicts: 0,
    });
  });

  test('counts staged, modified, untracked, and conflict entries', () => {
    const status = parseGitStatus([
      '## main...origin/main [ahead 1]',
      'M  staged.txt',
      ' M modified.txt',
      '?? new.txt',
      'UU conflict.txt',
    ].join('\n'));

    expect(status).toMatchObject({
      branch: 'main',
      clean: false,
      staged: 1,
      modified: 2,
      untracked: 1,
      conflicts: 1,
    });
  });
});

describe('formatGitStatusLine', () => {
  test('formats clean branch', () => {
    expect(formatGitStatusLine({ branch: 'main', clean: true })).toBe(
      'Git status — main — clean',
    );
  });

  test('formats modified and untracked counts', () => {
    expect(formatGitStatusLine({
      branch: 'main',
      clean: false,
      staged: 0,
      modified: 2,
      untracked: 3,
    })).toBe('Git status — main — 2 modified, 3 untracked');
  });
});

describe('GitStatusPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.body.innerHTML = '';
    axios.post.mockResolvedValue({
      data: { stdout: '## main...origin/main\n M app.txt\n?? new.txt\n' },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('renders exactly one status region', async () => {
    render(<GitStatusPanel />);

    await screen.findAllByText('Git status — main — 1 modified, 1 untracked', {}, { timeout: 5000 });

    expect(document.querySelectorAll('#git-status-region')).toHaveLength(1);
    expect(document.querySelector('#git-status-mount')).toBeNull();
  });

  test('queries the terminal endpoint with git status', async () => {
    render(<GitStatusPanel />);

    await waitFor(() => {
      expect(axios.post).toHaveBeenCalledWith(
        'http://localhost:9000/terminal/run',
        { command: 'git status --porcelain=v1 -b' },
        { timeout: 8000 },
      );
    });
  });
});

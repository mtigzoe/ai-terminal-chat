import { render, screen, waitFor } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import GitStatusPanel, { parseGitStatus, formatGitStatusLine } from './GitStatusPanel.jsx';

expect.extend(toHaveNoViolations);

vi.mock('axios', () => ({
  default: {
    post: vi.fn(),
  },
}));

import axios from 'axios';

const HOST = 'http://localhost:9000';

describe('GitStatusPanel accessibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('has no automated accessibility violations (clean state)', async () => {
    axios.post.mockResolvedValue({ data: { stdout: '## main\n', stderr: '', returncode: 0 } });
    const { container } = render(<GitStatusPanel />);
    await waitFor(() => expect(screen.getAllByText(/git status — main — clean/i)).toHaveLength(2));
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  test('has no automated accessibility violations (dirty state)', async () => {
    axios.post.mockResolvedValue({ data: { stdout: '## main\n M file.txt\n?? new.txt\n', stderr: '', returncode: 0 } });
    const { container } = render(<GitStatusPanel />);
    await waitFor(() => expect(screen.getAllByText(/git status — main — 1 modified, 1 untracked/i)).toHaveLength(2));
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  test('has no automated accessibility violations (error state)', async () => {
    axios.post.mockRejectedValue({ code: 'ECONNABORTED' });
    const { container } = render(<GitStatusPanel />);
    await waitFor(() => expect(screen.getAllByText(/git status — git status timed out/i)).toHaveLength(2));
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  test('summary text has accessible label', async () => {
    axios.post.mockResolvedValue({ data: { stdout: '## main\n', stderr: '', returncode: 0 } });
    render(<GitStatusPanel />);
    await waitFor(() => {
      const summary = screen.getByLabelText('Repository Git status');
      expect(summary).toHaveAttribute('aria-label', 'Repository Git status');
    });
  });

  test('live region announces status changes with role=status', async () => {
    axios.post.mockResolvedValue({ data: { stdout: '## main\n', stderr: '', returncode: 0 } });
    render(<GitStatusPanel />);
    await waitFor(() => {
      const liveRegion = screen.getByRole('status');
      expect(liveRegion).toHaveAttribute('aria-live', 'polite');
      expect(liveRegion).toHaveAttribute('aria-atomic', 'true');
      expect(liveRegion).toHaveTextContent(/git status — main — clean/i);
    });
  });

  test('error state is announced via live region', async () => {
    axios.post.mockRejectedValue({ code: 'ECONNABORTED' });
    render(<GitStatusPanel />);
    await waitFor(() => {
      const liveRegion = screen.getByRole('status');
      expect(liveRegion).toHaveTextContent(/git status — git status timed out/i);
    });
  });

  test('container has id for targeting', async () => {
    axios.post.mockResolvedValue({ data: { stdout: '## main\n', stderr: '', returncode: 0 } });
    render(<GitStatusPanel />);
    await waitFor(() => {
      expect(document.getElementById('git-status-region')).toBeInTheDocument();
    });
  });

  describe('parseGitStatus', () => {
    test('parses clean status', () => {
      const result = parseGitStatus('## main\n');
      expect(result).toEqual({ branch: 'main', clean: true, staged: 0, changed: 0, modified: 0, untracked: 0, conflicts: 0 });
    });

    test('parses staged and modified files', () => {
      const result = parseGitStatus('## main\nM  staged.txt\n M modified.txt\n');
      expect(result.staged).toBe(1);
      expect(result.modified).toBe(1);
      expect(result.changed).toBe(2);
    });

    test('parses untracked files', () => {
      const result = parseGitStatus('## main\n?? new.txt\n?? another.txt\n');
      expect(result.untracked).toBe(2);
    });

    test('detects conflicts', () => {
      const result = parseGitStatus('## main\nUU conflict.txt\n');
      expect(result.conflicts).toBe(1);
      expect(result.clean).toBe(false);
    });

    test('handles empty output', () => {
      const result = parseGitStatus('');
      expect(result.branch).toBe('');
      expect(result.clean).toBe(true);
    });

    test('handles output with only branch', () => {
      const result = parseGitStatus('## feature-branch\n');
      expect(result.branch).toBe('feature-branch');
      expect(result.clean).toBe(true);
    });
  });

  describe('formatGitStatusLine', () => {
    test('formats clean status', () => {
      expect(formatGitStatusLine({ branch: 'main', clean: true })).toBe('Git status — main — clean');
    });

    test('formats dirty status with details', () => {
      expect(formatGitStatusLine({ branch: 'main', clean: false, staged: 1, modified: 2, untracked: 1, conflicts: 0 }))
        .toBe('Git status — main — 1 staged, 2 modified, 1 untracked');
    });

    test('handles conflicts', () => {
      expect(formatGitStatusLine({ branch: 'main', clean: false, staged: 0, modified: 0, untracked: 0, conflicts: 2 }))
        .toBe('Git status — main — 2 conflicts');
    });

    test('handles error status', () => {
      expect(formatGitStatusLine({ error: 'not a git repo' })).toBe('Git status — not a git repo');
    });

    test('handles null/undefined', () => {
      expect(formatGitStatusLine(null)).toBe('Git status — unavailable');
      expect(formatGitStatusLine(undefined)).toBe('Git status — unavailable');
    });
  });
});

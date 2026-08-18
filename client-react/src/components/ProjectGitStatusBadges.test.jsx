import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import axios from 'axios';
import ProjectGitStatusBadges, { buildDirectoryStatuses, parseGitStatus } from './ProjectGitStatusBadges';

vi.mock('axios', () => ({
  default: {
    post: vi.fn(),
  },
}));

describe('ProjectGitStatusBadges', () => {
  test('parses porcelain git status output', () => {
    const statuses = parseGitStatus(' M src/App.jsx\n?? notes.txt\nA  new.py\n');
    expect(statuses.get('src/App.jsx')).toBe('M');
    expect(statuses.get('notes.txt')).toBe('?');
    expect(statuses.get('new.py')).toBe('A');
  });

  test('propagates file status to parent directories', () => {
    const statuses = buildDirectoryStatuses(new Map([
      ['src/components/App.jsx', 'M'],
      ['docs/notes.txt', '?'],
    ]));
    expect(statuses.get('src')).toBe('M');
    expect(statuses.get('src/components')).toBe('M');
    expect(statuses.get('docs')).toBe('?');
  });

  test('renders a badge and exposes the status in the treeitem name', async () => {
    axios.post.mockResolvedValueOnce({ data: { stdout: ' M App.jsx\n?? notes.txt\n' } });
    render(
      <>
        <div role="tree">
          <div role="treeitem" tabIndex="0" aria-label="App.jsx, file" data-tree-path="App.jsx">App.jsx</div>
          <div role="treeitem" tabIndex="-1" aria-label="notes.txt, file" data-tree-path="notes.txt">notes.txt</div>
        </div>
        <ProjectGitStatusBadges />
      </>
    );

    await waitFor(() => {
      expect(screen.getByRole('treeitem', { name: /App\.jsx, file, modified/i })).toBeInTheDocument();
      expect(screen.getByRole('treeitem', { name: /notes\.txt, file, untracked/i })).toBeInTheDocument();
    });

    expect(screen.getByText('[M]')).toHaveAttribute('title', 'Git status: modified');
    expect(screen.getByText('[U]')).toHaveAttribute('title', 'Git status: untracked');
    expect(screen.getByText('[M]')).toHaveAttribute('aria-hidden', 'true');
  });

  test('does not break the tree when git status fails', async () => {
    axios.post.mockRejectedValueOnce(new Error('not a git repository'));
    render(
      <>
        <div role="tree">
          <div role="treeitem" tabIndex="0" aria-label="App.jsx, file" data-tree-path="App.jsx">App.jsx</div>
        </div>
        <ProjectGitStatusBadges />
      </>
    );

    fireEvent.focus(screen.getByRole('treeitem'));
    await waitFor(() => expect(screen.getByRole('treeitem')).toHaveFocus());
    expect(screen.queryByText('[M]')).not.toBeInTheDocument();
  });
});

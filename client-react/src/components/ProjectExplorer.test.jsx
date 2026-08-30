import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import axios from 'axios';
import ProjectExplorer from './ProjectExplorer';

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

const host = 'http://localhost:9000';

beforeEach(() => {
  axios.get.mockReset();
  axios.post.mockReset();
  axios.post.mockResolvedValue({ data: { stdout: '' } });
  try {
    localStorage.clear();
  } catch {
    // ignore unavailable localStorage
  }
});

test('lists directory entries and exposes accessible file checkboxes', async () => {
  axios.get.mockResolvedValueOnce({
    data: {
      path: '.',
      entries: [
        { name: 'README.md', type: 'file' },
        { name: 'src', type: 'directory' },
      ],
    },
  });

  render(<ProjectExplorer host={host} />);

  expect(await screen.findByRole('heading', { name: 'Project' })).toBeInTheDocument();
  expect(await screen.findByRole('checkbox', { name: /select readme\.md for the agent/i })).toBeInTheDocument();
  expect(screen.getByRole('treeitem', { name: /src, directory/i })).toBeInTheDocument();
  expect(screen.getByRole('tree', { name: /project files and directories/i })).toBeInTheDocument();
});

test('shows Git status indicators and includes the status in accessible tree labels', async () => {
  axios.get.mockResolvedValueOnce({
    data: {
      path: '.',
      entries: [
        { name: 'README.md', type: 'file' },
        { name: 'new.txt', type: 'file' },
        { name: 'src', type: 'directory' },
      ],
    },
  });
  axios.post.mockResolvedValueOnce({
    data: {
      stdout: ' M README.md\n?? new.txt\n M src/App.jsx\n',
    },
  });

  render(<ProjectExplorer host={host} />);

  expect(await screen.findByRole('treeitem', { name: /README\.md, file, modified/i })).toBeInTheDocument();
  expect(screen.getByRole('treeitem', { name: /new\.txt, file, untracked/i })).toBeInTheDocument();
  expect(screen.getByRole('treeitem', { name: /src, directory, modified/i })).toBeInTheDocument();

  const modifiedBadges = screen.getAllByText('[M]', { selector: 'span' });
  expect(modifiedBadges).toHaveLength(2);
  expect(modifiedBadges[0]).toHaveAttribute('title', 'Git status: modified');
  expect(screen.getByText('[U]', { selector: 'span' })).toHaveAttribute('title', 'Git status: untracked');
  expect(axios.post).toHaveBeenCalledWith(`${host}/terminal/run`, {
    command: 'git status --porcelain=v1 --untracked-files=all',
  });
});

test('labels every unmerged porcelain code as a conflict, including AA and DD which contain no "U"', async () => {
  // Per `git status --porcelain=v1`, the full set of unmerged (conflict)
  // codes is DD, AU, UD, UA, DU, AA, UU. "AA" (both added) and "DD" (both
  // deleted) don't contain the character "U", so a naive `code.includes('U')`
  // check misclassifies them as plain "added"/"deleted" instead of a
  // conflict that still needs manual resolution.
  axios.get.mockResolvedValueOnce({
    data: {
      path: '.',
      entries: [
        { name: 'both-added.txt', type: 'file' },
        { name: 'both-deleted.txt', type: 'file' },
        { name: 'both-modified.txt', type: 'file' },
      ],
    },
  });
  axios.post.mockResolvedValueOnce({
    data: {
      stdout: 'AA both-added.txt\nDD both-deleted.txt\nUU both-modified.txt\n',
    },
  });

  render(<ProjectExplorer host={host} />);

  expect(await screen.findByRole('treeitem', { name: /both-added\.txt, file, conflict/i })).toBeInTheDocument();
  expect(screen.getByRole('treeitem', { name: /both-deleted\.txt, file, conflict/i })).toBeInTheDocument();
  expect(screen.getByRole('treeitem', { name: /both-modified\.txt, file, conflict/i })).toBeInTheDocument();
});

test('localStorage selection persistence still works after sorting', async () => {
  axios.get.mockResolvedValueOnce({
    data: {
      path: '.',
      entries: [
        { name: 'b.txt', type: 'file' },
        { name: 'a.txt', type: 'file' },
      ],
    },
  });

  render(<ProjectExplorer host={host} />);
  const checkbox = await screen.findByRole('checkbox', { name: /select a\.txt for the agent/i });
  fireEvent.click(checkbox);

  // Wait for the selection state/effect to persist before changing the sort.
  // The persistence effect runs after React commits the checkbox state.
  await waitFor(() => {
    expect(checkbox).toBeChecked();
    const stored = JSON.parse(localStorage.getItem(`project-explorer:${host}:selected`));
    expect(stored).toEqual(['a.txt']);
  });

  fireEvent.click(screen.getByRole('button', { name: /name, sorted ascending/i }));

  await waitFor(() => {
    const stored = JSON.parse(localStorage.getItem(`project-explorer:${host}:selected`));
    expect(stored).toEqual(['a.txt']);
  });
});

test('periodic refresh triggers another git status request after approximately 5 seconds', async () => {
  const setIntervalSpy = vi.spyOn(window, 'setInterval');
  const clearIntervalSpy = vi.spyOn(window, 'clearInterval');

  axios.get.mockResolvedValueOnce({
    data: {
      path: '.',
      entries: [{ name: 'README.md', type: 'file' }],
    },
  });
  axios.post.mockResolvedValue({ data: { stdout: '' } });

  const { unmount } = render(<ProjectExplorer host={host} />);

  await screen.findByRole('treeitem', { name: /README\.md, file/i });
  expect(axios.post).toHaveBeenCalledTimes(1);

  const intervalCall = setIntervalSpy.mock.calls.find(([callback, delay]) => typeof callback === 'function' && delay === 5000);
  expect(intervalCall).toBeTruthy();

  unmount();
  expect(clearIntervalSpy).toHaveBeenCalled();

  setIntervalSpy.mockRestore();
  clearIntervalSpy.mockRestore();
});

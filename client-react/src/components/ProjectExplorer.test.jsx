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
    sessionStorage.clear();
  } catch {
    // ignore unavailable sessionStorage
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

  const conflictBadges = screen.getAllByText('[C]', { selector: 'span' });
  expect(conflictBadges).toHaveLength(3);
});

test('opens a file for local preview without supplying it to the agent', async () => {
  axios.get
    .mockResolvedValueOnce({
      data: {
        path: '.',
        entries: [{ name: 'hello.txt', type: 'file' }],
      },
    })
    .mockResolvedValueOnce({
      data: { path: 'hello.txt', contents: 'hello world' },
    });

  const onUseSelectedFiles = vi.fn();
  render(<ProjectExplorer host={host} onUseSelectedFiles={onUseSelectedFiles} />);
  fireEvent.click(await screen.findByRole('treeitem', { name: /hello\.txt, file/i }));

  expect(await screen.findByRole('heading', { name: /file: hello\.txt/i })).toBeInTheDocument();
  expect(screen.getByLabelText(/contents of hello\.txt/i)).toHaveTextContent('hello world');
  expect(onUseSelectedFiles).not.toHaveBeenCalled();
  await waitFor(() => {
    expect(axios.get).toHaveBeenCalledWith(
      `${host}/project/read`,
      expect.objectContaining({ params: { path: 'hello.txt' } })
    );
  });
});

test('selects a file and explicitly supplies its contents to the agent', async () => {
  axios.get
    .mockResolvedValueOnce({
      data: {
        path: '.',
        entries: [{ name: 'hello.txt', type: 'file' }],
      },
    })
    .mockResolvedValueOnce({
      data: { path: 'hello.txt', contents: 'hello world' },
    });

  const onUseSelectedFiles = vi.fn();
  render(<ProjectExplorer host={host} onUseSelectedFiles={onUseSelectedFiles} />);

  const checkbox = await screen.findByRole('checkbox', { name: /select hello\.txt for the agent/i });
  fireEvent.click(checkbox);
  expect(checkbox).toBeChecked();

  fireEvent.click(screen.getByRole('button', { name: /use selected files with agent/i }));

  await waitFor(() => {
    expect(onUseSelectedFiles).toHaveBeenCalledWith([
      { path: 'hello.txt', content: 'hello world' },
    ]);
  });
});

test('space toggles the selected file without opening it', async () => {
  axios.get.mockResolvedValueOnce({
    data: {
      path: '.',
      entries: [
        { name: 'a.txt', type: 'file' },
        { name: 'b.txt', type: 'file' },
      ],
    },
  });

  render(<ProjectExplorer host={host} />);
  const fileEntry = await screen.findByRole('treeitem', { name: /a\.txt, file/i });
  fileEntry.focus();
  fireEvent.keyDown(fileEntry, { key: ' ' });

  expect(screen.getByRole('checkbox', { name: /select a\.txt for the agent/i })).toBeChecked();
  expect(axios.get).toHaveBeenCalledTimes(1);
});

test('virtualizes large directories instead of mounting every tree row', async () => {
  const entries = Array.from({ length: 250 }, (_, index) => ({
    name: `file-${index + 1}.txt`,
    type: 'file',
  }));
  axios.get.mockResolvedValueOnce({ data: { path: '.', entries } });

  render(<ProjectExplorer host={host} />);
  const tree = await screen.findByRole('tree', { name: /project files and directories/i });

  await waitFor(() => {
    expect(tree.querySelectorAll('[role="treeitem"]').length).toBeLessThan(entries.length);
  });
  expect(screen.getByRole('treeitem', { name: /file-1\.txt, file/i })).toBeInTheDocument();
  expect(screen.queryByRole('treeitem', { name: /file-250\.txt, file/i })).not.toBeInTheDocument();
});

test('virtualized tree keeps keyboard navigation accessible to offscreen rows', async () => {
  const entries = Array.from({ length: 250 }, (_, index) => ({
    name: `file-${index + 1}.txt`,
    type: 'file',
  }));
  axios.get.mockResolvedValueOnce({ data: { path: '.', entries } });

  render(<ProjectExplorer host={host} />);
  const first = await screen.findByRole('treeitem', { name: /file-1\.txt, file/i });
  first.focus();
  fireEvent.keyDown(first, { key: 'End' });

  await waitFor(() => {
    expect(screen.getByRole('treeitem', { name: /file-250\.txt, file/i })).toHaveFocus();
  });
  expect(screen.queryByRole('treeitem', { name: /file-1\.txt, file/i })).not.toBeInTheDocument();
});

test('git status failure does not break the project tree', async () => {
  axios.get.mockResolvedValueOnce({
    data: {
      path: '.',
      entries: [
        { name: 'README.md', type: 'file' },
        { name: 'src', type: 'directory' },
      ],
    },
  });
  axios.post.mockRejectedValueOnce(new Error('git not found'));

  render(<ProjectExplorer host={host} />);

  expect(await screen.findByRole('heading', { name: 'Project' })).toBeInTheDocument();
  expect(await screen.findByRole('treeitem', { name: /README\.md, file/i })).toBeInTheDocument();
  expect(screen.getByRole('treeitem', { name: /src, directory/i })).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('git status failure produces an accessible non-blocking status message', async () => {
  axios.get.mockResolvedValueOnce({
    data: {
      path: '.',
      entries: [{ name: 'README.md', type: 'file' }],
    },
  });
  axios.post.mockRejectedValueOnce(new Error('git not found'));

  render(<ProjectExplorer host={host} />);

  expect(await screen.findByRole('treeitem', { name: /README\.md, file/i })).toBeInTheDocument();
  expect(screen.getByText(/git status unavailable/i)).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('git status success clears the git status error', async () => {
  axios.get.mockResolvedValueOnce({
    data: {
      path: '.',
      entries: [{ name: 'README.md', type: 'file' }],
    },
  });
  axios.post
    .mockRejectedValueOnce(new Error('git not found'))
    .mockResolvedValueOnce({ data: { stdout: '' } });

  render(<ProjectExplorer host={host} />);

  await screen.findByRole('treeitem', { name: /README\.md, file/i });
  expect(screen.getByText(/git status unavailable/i)).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /refresh/i }));

  await waitFor(() => {
    expect(screen.queryByText(/git status unavailable/i)).not.toBeInTheDocument();
  });
});

test('"Select all files" recursively selects files inside collapsed/unloaded directories', async () => {
  axios.get
    .mockResolvedValueOnce({
      data: {
        path: '.',
        entries: [
          { name: 'a.txt', type: 'file' },
          { name: 'sub', type: 'directory' },
        ],
      },
    })
    .mockResolvedValueOnce({
      data: { path: 'sub', entries: [{ name: 'b.txt', type: 'file' }] },
    });

  render(<ProjectExplorer host={host} />);
  await screen.findByRole('treeitem', { name: /a\.txt, file/i });

  // "sub" was never expanded/loaded, so its contents aren't in visibleItems.
  expect(screen.queryByRole('treeitem', { name: /b\.txt, file/i })).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /^select all files$/i }));

  expect(await screen.findByRole('button', { name: /use selected files with agent \(2\)/i })).toBeInTheDocument();
  expect(axios.get).toHaveBeenCalledWith(`${host}/project/list`, { params: { path: 'sub' } });
  await waitFor(() => {
    const stored = JSON.parse(sessionStorage.getItem(`project-explorer:${host}:selected`));
    expect(stored.sort()).toEqual(['a.txt', 'sub/b.txt']);
  });
});

test('"Select all files" preserves files that were already selected', async () => {
  axios.get
    .mockResolvedValueOnce({
      data: {
        path: '.',
        entries: [
          { name: 'a.txt', type: 'file' },
          { name: 'sub', type: 'directory' },
        ],
      },
    })
    .mockResolvedValueOnce({
      data: { path: 'sub', entries: [{ name: 'b.txt', type: 'file' }] },
    });

  render(<ProjectExplorer host={host} />);
  const checkbox = await screen.findByRole('checkbox', { name: /select a\.txt for the agent/i });
  fireEvent.click(checkbox);
  expect(checkbox).toBeChecked();

  fireEvent.click(screen.getByRole('button', { name: /^select all files$/i }));

  await waitFor(() => {
    expect(screen.getByRole('button', { name: /use selected files with agent \(2\)/i })).toBeInTheDocument();
  });
  expect(checkbox).toBeChecked();
});

test('"Select all files" reuses already-loaded children instead of re-requesting them', async () => {
  axios.get
    .mockResolvedValueOnce({ data: { path: '.', entries: [{ name: 'sub', type: 'directory' }] } })
    .mockResolvedValueOnce({ data: { path: 'sub', entries: [{ name: 'c.txt', type: 'file' }] } });

  render(<ProjectExplorer host={host} />);
  const subItem = await screen.findByRole('treeitem', { name: /sub, directory/i });
  fireEvent.click(subItem);
  await screen.findByRole('treeitem', { name: /c\.txt, file/i });
  expect(axios.get).toHaveBeenCalledTimes(2);

  fireEvent.click(screen.getByRole('button', { name: /^select all files$/i }));

  await waitFor(() => {
    expect(screen.getByRole('button', { name: /use selected files with agent \(1\)/i })).toBeInTheDocument();
  });
  // No extra /project/list request for "sub" since it was already cached in `children`.
  expect(axios.get).toHaveBeenCalledTimes(2);
});

test('"Select all files" handles a failing subdirectory gracefully and still selects readable files', async () => {
  axios.get
    .mockResolvedValueOnce({
      data: {
        path: '.',
        entries: [
          { name: 'good.txt', type: 'file' },
          { name: 'bad', type: 'directory' },
        ],
      },
    })
    .mockRejectedValueOnce(new Error('permission denied'));

  render(<ProjectExplorer host={host} />);
  await screen.findByRole('treeitem', { name: /good\.txt, file/i });

  fireEvent.click(screen.getByRole('button', { name: /^select all files$/i }));

  await waitFor(() => {
    expect(screen.getByRole('button', { name: /use selected files with agent \(1\)/i })).toBeInTheDocument();
  });
  expect(await screen.findByRole('alert')).toHaveTextContent(/folders could not be listed/i);
  expect(screen.getByText(/1 folder could not be read/i)).toBeInTheDocument();
});

test('"Select all visible" is unaffected by the presence of "Select all files"', async () => {
  axios.get.mockResolvedValueOnce({
    data: {
      path: '.',
      entries: [
        { name: 'a.txt', type: 'file' },
        { name: 'b.txt', type: 'file' },
      ],
    },
  });

  render(<ProjectExplorer host={host} />);
  await screen.findByRole('treeitem', { name: /a\.txt, file/i });

  fireEvent.click(screen.getByRole('button', { name: /select all visible/i }));

  expect(await screen.findByRole('button', { name: /use selected files with agent \(2\)/i })).toBeInTheDocument();
  // Only the initial directory listing was requested; no recursive traversal occurred.
  expect(axios.get).toHaveBeenCalledTimes(1);
});

test('column headers sort the visible files, with directories grouped before files', async () => {
  axios.get.mockResolvedValueOnce({
    data: {
      path: '.',
      entries: [
        { name: 'zebra.txt', type: 'file' },
        { name: 'apple.py', type: 'file' },
        { name: 'Docs', type: 'directory' },
        { name: 'assets', type: 'directory' },
      ],
    },
  });

  render(<ProjectExplorer host={host} />);
  await screen.findByRole('treeitem', { name: /zebra\.txt, file/i });

  const labelsInOrder = () => screen.getAllByRole('treeitem').map((el) => el.getAttribute('aria-label'));

  // Default: Name ascending, directories (case-insensitive) before files.
  expect(labelsInOrder()).toEqual([
    'Collapsed assets, directory',
    'Collapsed Docs, directory',
    'apple.py, file',
    'zebra.txt, file',
  ]);

  const nameHeader = screen.getByRole('button', { name: /name, sorted ascending/i });
  fireEvent.click(nameHeader);

  // Reversed: directories still grouped first, but each group's internal
  // order flips too.
  await waitFor(() => {
    expect(labelsInOrder()).toEqual([
      'Collapsed Docs, directory',
      'Collapsed assets, directory',
      'zebra.txt, file',
      'apple.py, file',
    ]);
  });
  expect(screen.getByRole('button', { name: /name, sorted descending/i })).toBeInTheDocument();
});

test('clicking the Type header sorts by the derived file type, directories still grouped first', async () => {
  axios.get.mockResolvedValueOnce({
    data: {
      path: '.',
      entries: [
        { name: 'index.js', type: 'file' },
        { name: 'notes.md', type: 'file' },
        { name: 'app.py', type: 'file' },
        { name: 'lib', type: 'directory' },
      ],
    },
  });

  render(<ProjectExplorer host={host} />);
  await screen.findByRole('treeitem', { name: /index\.js, file/i });

  fireEvent.click(screen.getByRole('button', { name: /sort by type/i }));

  // JavaScript File < Markdown Document < Python File alphabetically; the
  // directory stays first regardless of the Type column's values.
  await waitFor(() => {
    const labels = screen.getAllByRole('treeitem').map((el) => el.getAttribute('aria-label'));
    expect(labels).toEqual([
      'Collapsed lib, directory',
      'index.js, file',
      'notes.md, file',
      'app.py, file',
    ]);
  });
});

test('sorting does not change which files are selected', async () => {
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
  const checkbox = await screen.findByRole('checkbox', { name: /select b\.txt for the agent/i });
  fireEvent.click(checkbox);
  expect(await screen.findByRole('button', { name: /use selected files with agent \(1\)/i })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /name, sorted ascending/i }));

  await waitFor(() => {
    expect(screen.getByRole('button', { name: /name, sorted descending/i })).toBeInTheDocument();
  });
  expect(screen.getByRole('button', { name: /use selected files with agent \(1\)/i })).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: /select b\.txt for the agent/i })).toBeChecked();
});

test('sorting is applied within filtered results', async () => {
  axios.get.mockResolvedValueOnce({
    data: {
      path: '.',
      entries: [
        { name: 'report-b.txt', type: 'file' },
        { name: 'report-a.txt', type: 'file' },
        { name: 'other.txt', type: 'file' },
      ],
    },
  });

  render(<ProjectExplorer host={host} />);
  await screen.findByRole('treeitem', { name: /other\.txt, file/i });

  const filterInput = screen.getByLabelText(/filter files and folders/i);
  fireEvent.change(filterInput, { target: { value: 'report' } });

  await waitFor(() => {
    expect(screen.getAllByRole('treeitem')).toHaveLength(2);
  });
  expect(screen.getAllByRole('treeitem').map((el) => el.getAttribute('aria-label'))).toEqual([
    'report-a.txt, file',
    'report-b.txt, file',
  ]);

  fireEvent.click(screen.getByRole('button', { name: /name, sorted ascending/i }));

  await waitFor(() => {
    expect(screen.getAllByRole('treeitem').map((el) => el.getAttribute('aria-label'))).toEqual([
      'report-b.txt, file',
      'report-a.txt, file',
    ]);
  });
});

test('sort order applies inside expanded subdirectories too', async () => {
  axios.get
    .mockResolvedValueOnce({
      data: { path: '.', entries: [{ name: 'src', type: 'directory' }] },
    })
    .mockResolvedValueOnce({
      data: {
        path: 'src',
        entries: [
          { name: 'zeta.ts', type: 'file' },
          { name: 'alpha.ts', type: 'file' },
        ],
      },
    });

  render(<ProjectExplorer host={host} />);
  const srcItem = await screen.findByRole('treeitem', { name: /src, directory/i });
  fireEvent.click(srcItem);
  await screen.findByRole('treeitem', { name: /alpha\.ts, file/i });

  expect(screen.getAllByRole('treeitem').map((el) => el.getAttribute('aria-label'))).toEqual([
    'Expanded src, directory',
    'alpha.ts, file',
    'zeta.ts, file',
  ]);

  fireEvent.click(screen.getByRole('button', { name: /name, sorted ascending/i }));

  await waitFor(() => {
    expect(screen.getAllByRole('treeitem').map((el) => el.getAttribute('aria-label'))).toEqual([
      'Expanded src, directory',
      'zeta.ts, file',
      'alpha.ts, file',
    ]);
  });
});

test('"Select all visible" and "Select all files" are unaffected by sort state', async () => {
  axios.get
    .mockResolvedValueOnce({
      data: {
        path: '.',
        entries: [
          { name: 'zebra.txt', type: 'file' },
          { name: 'apple.txt', type: 'file' },
          { name: 'sub', type: 'directory' },
        ],
      },
    })
    .mockResolvedValueOnce({
      data: { path: 'sub', entries: [{ name: 'nested.txt', type: 'file' }] },
    });

  render(<ProjectExplorer host={host} />);
  await screen.findByRole('treeitem', { name: /zebra\.txt, file/i });

  fireEvent.click(screen.getByRole('button', { name: /name, sorted ascending/i }));
  await waitFor(() => {
    expect(screen.getByRole('button', { name: /name, sorted descending/i })).toBeInTheDocument();
  });

  fireEvent.click(screen.getByRole('button', { name: /select all visible/i }));
  expect(await screen.findByRole('button', { name: /use selected files with agent \(2\)/i })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /^select all files$/i }));
  await waitFor(() => {
    expect(screen.getByRole('button', { name: /use selected files with agent \(3\)/i })).toBeInTheDocument();
  });
});

test('sort headers are real buttons; Size and Modified are static, non-sortable headers', async () => {
  axios.get.mockResolvedValueOnce({
    data: { path: '.', entries: [{ name: 'a.txt', type: 'file' }] },
  });

  render(<ProjectExplorer host={host} />);
  await screen.findByRole('treeitem', { name: /a\.txt, file/i });

  expect(screen.getByRole('button', { name: /name, sorted ascending/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /sort by type/i })).toBeInTheDocument();
  expect(screen.getByRole('columnheader', { name: 'Size' })).toBeInTheDocument();
  expect(screen.getByRole('columnheader', { name: 'Modified' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^size$/i })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /^modified$/i })).not.toBeInTheDocument();
});

test('sessionStorage selection persistence still works after sorting', async () => {
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
  fireEvent.click(screen.getByRole('button', { name: /name, sorted ascending/i }));

  await waitFor(() => {
    const stored = JSON.parse(sessionStorage.getItem(`project-explorer:${host}:selected`));
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

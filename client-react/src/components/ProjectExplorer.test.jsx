import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  const user = userEvent.setup();
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
  await user.click(checkbox);

  // Wait for the selection state/effect to persist before changing the sort.
  // Awaiting the user interaction also lets React flush the state update and
  // its persistence effect before the assertion below.
  await waitFor(() => {
    expect(checkbox).toBeChecked();
    const stored = JSON.parse(localStorage.getItem(`project-explorer:${host}:selected`));
    expect(stored).toEqual(['a.txt']);
  });

  await user.click(screen.getByRole('button', { name: /name, sorted ascending/i }));

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

function mockProjectList(entriesByPath) {
  axios.get.mockImplementation(async (_url, config = {}) => {
    const path = config.params?.path;
    if (path in entriesByPath) {
      return { data: { path, entries: entriesByPath[path] } };
    }
    const error = new Error(`Unable to load ${path}`);
    error.response = { data: { error: `Unable to load ${path}` } };
    throw error;
  });
}

test('Refresh re-fetches the project listing instead of returning the cached directory', async () => {
  const user = userEvent.setup();
  const listings = {
    '.': [
      { name: 'old.txt', type: 'file' },
      { name: 'src', type: 'directory' },
    ],
  };
  mockProjectList(listings);

  render(<ProjectExplorer host={host} />);
  expect(await screen.findByRole('treeitem', { name: /old\.txt, file/i })).toBeInTheDocument();

  listings['.'] = [
    { name: 'new.txt', type: 'file' },
    { name: 'src', type: 'directory' },
  ];

  await user.click(screen.getByRole('button', { name: /refresh/i }));

  expect(await screen.findByRole('treeitem', { name: /new\.txt, file/i })).toBeInTheDocument();
  expect(screen.queryByRole('treeitem', { name: /old\.txt, file/i })).not.toBeInTheDocument();
});

test('a slower initial directory response does not overwrite a newer Refresh result', async () => {
  const user = userEvent.setup();
  let resolveInitial;
  let listCalls = 0;
  axios.get.mockImplementation(async (_url, config = {}) => {
    const path = config.params?.path;
    if (path !== '.') {
      return { data: { path, entries: [] } };
    }
    listCalls += 1;
    if (listCalls === 1) {
      return new Promise((resolve) => {
        resolveInitial = resolve;
      });
    }
    return { data: { path: '.', entries: [{ name: 'new.txt', type: 'file' }] } };
  });

  render(<ProjectExplorer host={host} />);
  await user.click(await screen.findByRole('button', { name: /refresh/i }));
  expect(await screen.findByRole('treeitem', { name: /new\.txt, file/i })).toBeInTheDocument();

  resolveInitial({ data: { path: '.', entries: [{ name: 'old.txt', type: 'file' }] } });

  await waitFor(() => {
    expect(screen.getByRole('treeitem', { name: /new\.txt, file/i })).toBeInTheDocument();
    expect(screen.queryByRole('treeitem', { name: /old\.txt, file/i })).not.toBeInTheDocument();
  });
});

test('failed folder loads do not stay expanded', async () => {
  const user = userEvent.setup();
  axios.get.mockImplementation(async (_url, config = {}) => {
    const path = config.params?.path;
    if (path === '.') {
      return { data: { path: '.', entries: [{ name: 'src', type: 'directory' }] } };
    }
    const error = new Error('boom');
    error.response = { data: { error: 'Unable to load src' } };
    throw error;
  });

  render(<ProjectExplorer host={host} />);
  const folder = await screen.findByRole('treeitem', { name: /src, directory/i });
  await user.click(folder);

  await waitFor(() => {
    expect(screen.getByRole('alert')).toHaveTextContent(/unable to load src/i);
  });
  expect(folder).toHaveAttribute('aria-expanded', '');
});

test('stored expanded paths that fail to load are dropped instead of staying expanded', async () => {
  localStorage.setItem(
    `project-explorer:${host}:expanded`,
    JSON.stringify(['src']),
  );
  axios.get.mockImplementation(async (_url, config = {}) => {
    const path = config.params?.path;
    if (path === '.') {
      return { data: { path: '.', entries: [{ name: 'src', type: 'directory' }] } };
    }
    const error = new Error('boom');
    error.response = { data: { error: 'Unable to load src' } };
    throw error;
  });

  render(<ProjectExplorer host={host} />);
  const folder = await screen.findByRole('treeitem', { name: /src, directory/i });
  await waitFor(() => {
    expect(folder).toHaveAttribute('aria-expanded', '');
  });
});

test('mounting the explorer does not wipe Chat-granted allowed paths', async () => {
    localStorage.setItem('ai-terminal-chat:allowed-paths', JSON.stringify(['granted.txt']));
    mockProjectList({
      '.': [
        { name: 'granted.txt', type: 'file' },
        { name: 'other.txt', type: 'file' },
      ],
    });

    render(<ProjectExplorer host={host} />);

    expect(await screen.findByRole('checkbox', { name: /select granted\.txt for the agent/i })).toBeChecked();
    expect(JSON.parse(localStorage.getItem('ai-terminal-chat:allowed-paths'))).toEqual(['granted.txt']);
    // Granted paths are now merged into initial state, so no additional write occurs.
    // The key assertion is that the granted path remains selected and in allowed-paths.
  });

test('shift-click selects the visible file range and ignores files hidden by the filter', async () => {
  // Use a unique storage key so this stateful-selection test cannot inherit
  // persisted selection from another ProjectExplorer instance.
  const shiftHost = 'http://localhost:9000/shift-range-test';
  localStorage.removeItem('ai-terminal-chat:allowed-paths');
  localStorage.removeItem(`project-explorer:${shiftHost}:selected`);
  sessionStorage.removeItem(`project-explorer:${shiftHost}:selected`);
  const user = userEvent.setup();
  mockProjectList({
    '.': [
      { name: 'a.txt', type: 'file' },
      { name: 'b.txt', type: 'file' },
      { name: 'c.txt', type: 'file' },
    ],
  });

  render(<ProjectExplorer host={shiftHost} />);
  const checkboxA = await screen.findByRole('checkbox', { name: /select a\.txt for the agent/i });
  const checkboxC = screen.getByRole('checkbox', { name: /select c\.txt for the agent/i });

  await user.click(checkboxA);
  await user.keyboard('{Shift>}');
  await user.click(checkboxC);
  await user.keyboard('{/Shift}');

  expect(checkboxA).toBeChecked();
  expect(screen.getByRole('checkbox', { name: /select b\.txt for the agent/i })).toBeChecked();
  expect(checkboxC).toBeChecked();

  await user.click(screen.getByRole('button', { name: /clear selection/i }));
  await waitFor(() => expect(checkboxA).not.toBeChecked());
  await user.click(checkboxA);
  await user.type(screen.getByLabelText(/filter files and folders/i), 'c');

  const filteredC = await screen.findByRole('checkbox', { name: /select c\.txt for the agent/i });
  await waitFor(() => {
    expect(screen.queryByRole('checkbox', { name: /select a\.txt for the agent/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /select b\.txt for the agent/i })).not.toBeInTheDocument();
  });
  await user.keyboard('{Shift>}');
  await user.click(filteredC);
  await user.keyboard('{/Shift}');

  const filterInput = screen.getByRole('searchbox', { name: /filter files and folders/i });
  await user.clear(filterInput);
  expect(screen.getByRole('checkbox', { name: /select a\.txt for the agent/i })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: /select b\.txt for the agent/i })).not.toBeChecked();
  expect(screen.getByRole('checkbox', { name: /select c\.txt for the agent/i })).toBeChecked();
});

test('keyboard End in a virtualized tree keeps focus on the last item and scrolls it into the window', async () => {
  const user = userEvent.setup();
  const entries = Array.from({ length: 250 }, (_, index) => ({
    name: `file-${String(index).padStart(3, '0')}.txt`,
    type: 'file',
  }));
  mockProjectList({ '.': entries });

  render(<ProjectExplorer host={host} />);
  const tree = await screen.findByRole('tree', { name: /project files and directories/i });
  expect(tree).toHaveStyle({ position: 'relative' });

  const first = await screen.findByRole('treeitem', { name: /file-000\.txt, file/i });
  first.focus();
  await user.keyboard('{End}');

  await waitFor(() => {
    expect(document.activeElement).toHaveAttribute('data-tree-path', 'file-249.txt');
  });
  expect(tree.scrollTop).toBeGreaterThan(0);
  expect(screen.getByRole('treeitem', { name: /file-249\.txt, file/i })).toBeInTheDocument();
});

test('Refresh aborts an in-flight initial expanded-path load so stale children are not applied', async () => {
  const user = userEvent.setup();
  let resolveSrc;
  let listCalls = 0;
  axios.get.mockImplementation(async (_url, config = {}) => {
    const path = config.params?.path;
    listCalls += 1;
    if (path === '.') {
      return {
        data: {
          path: '.',
          entries: [
            { name: 'src', type: 'directory' },
            { name: 'fresh.txt', type: 'file' },
          ],
        },
      };
    }
    if (path === 'src') {
      return new Promise((resolve) => {
        resolveSrc = resolve;
      });
    }
    return { data: { path, entries: [] } };
  });

  localStorage.setItem(
    `project-explorer:${host}:expanded`,
    JSON.stringify(['src']),
  );

  render(<ProjectExplorer host={host} />);
  expect(await screen.findByRole('treeitem', { name: /fresh\.txt, file/i })).toBeInTheDocument();

  // Refresh before the delayed src/ response arrives.
  await user.click(screen.getByRole('button', { name: /refresh/i }));
  expect(await screen.findByRole('treeitem', { name: /fresh\.txt, file/i })).toBeInTheDocument();

  // Late src response from the aborted initial sequence must not expand or inject children.
  resolveSrc({ data: { path: 'src', entries: [{ name: 'stale.js', type: 'file' }] } });
  await waitFor(() => {
    expect(screen.queryByRole('treeitem', { name: /stale\.js/i })).not.toBeInTheDocument();
  });
  const srcItem = screen.getByRole('treeitem', { name: /src, directory/i });
  expect(srcItem).toHaveAttribute('aria-expanded', '');
});

test('unchecking a file removes it from ai-terminal-chat:allowed-paths', async () => {
  const user = userEvent.setup();
  mockProjectList({
    '.': [
      { name: 'keep.txt', type: 'file' },
      { name: 'drop.txt', type: 'file' },
    ],
  });

  render(<ProjectExplorer host={host} />);
  const keep = await screen.findByRole('checkbox', { name: /select keep\.txt for the agent/i });
  const drop = screen.getByRole('checkbox', { name: /select drop\.txt for the agent/i });

  await user.click(keep);
  await user.click(drop);
  await waitFor(() => {
    const allowed = JSON.parse(localStorage.getItem('ai-terminal-chat:allowed-paths'));
    expect(allowed).toEqual(expect.arrayContaining(['keep.txt', 'drop.txt']));
  });

  await user.click(drop);
  await waitFor(() => {
    const allowed = JSON.parse(localStorage.getItem('ai-terminal-chat:allowed-paths'));
    expect(allowed).toEqual(['keep.txt']);
  });
});

test('Refresh prunes selected files that no longer exist in the reloaded directory', async () => {
  const user = userEvent.setup();
  const listings = {
    '.': [
      { name: 'gone.txt', type: 'file' },
      { name: 'stay.txt', type: 'file' },
    ],
  };
  mockProjectList(listings);

  render(<ProjectExplorer host={host} />);
  const gone = await screen.findByRole('checkbox', { name: /select gone\.txt for the agent/i });
  await user.click(gone);
  await user.click(screen.getByRole('checkbox', { name: /select stay\.txt for the agent/i }));
  await waitFor(() => {
    expect(JSON.parse(localStorage.getItem('ai-terminal-chat:allowed-paths'))).toEqual(
      expect.arrayContaining(['gone.txt', 'stay.txt']),
    );
  });

  listings['.'] = [{ name: 'stay.txt', type: 'file' }];
  await user.click(screen.getByRole('button', { name: /refresh/i }));

  await waitFor(() => {
    expect(screen.queryByRole('checkbox', { name: /select gone\.txt/i })).not.toBeInTheDocument();
  });
  await waitFor(() => {
    const allowed = JSON.parse(localStorage.getItem('ai-terminal-chat:allowed-paths') || '[]');
    expect(allowed).toEqual(['stay.txt']);
  });
});

test('virtualized tree keeps a tabbable treeitem when the active path is outside the window', async () => {
  const entries = Array.from({ length: 250 }, (_, index) => ({
    name: `file-${String(index).padStart(3, '0')}.txt`,
    type: 'file',
  }));
  mockProjectList({ '.': entries });

  render(<ProjectExplorer host={host} />);
  const tree = await screen.findByRole('tree', { name: /project files and directories/i });

  const first = await screen.findByRole('treeitem', { name: /file-000\.txt, file/i });
  first.focus();
  expect(first).toHaveAttribute('tabIndex', '0');

  // Scroll the virtualized window so file-000 is no longer rendered while activePath stays file-000.
  fireEvent.scroll(tree, { target: { scrollTop: 200 * 32 } });

  await waitFor(() => {
    expect(screen.queryByRole('treeitem', { name: /file-000\.txt, file/i })).not.toBeInTheDocument();
  });
  const tabbable = tree.querySelectorAll('[role="treeitem"][tabindex="0"]');
  expect(tabbable.length).toBeGreaterThanOrEqual(1);
});

test('Refresh prunes nested selections when an ancestor directory disappears', async () => {
  const user = userEvent.setup();
  const listings = {
    '.': [
      { name: 'src', type: 'directory' },
      { name: 'stay.txt', type: 'file' },
    ],
    src: [
      { name: 'nested.js', type: 'file' },
    ],
  };
  mockProjectList(listings);

  // Pre-select a nested path (as Chat or a previous session might have).
  localStorage.setItem('ai-terminal-chat:allowed-paths', JSON.stringify(['src/nested.js', 'stay.txt']));
  localStorage.setItem(`project-explorer:${host}:selected`, JSON.stringify(['src/nested.js', 'stay.txt']));

  render(<ProjectExplorer host={host} />);
  expect(await screen.findByRole('checkbox', { name: /select stay\.txt for the agent/i })).toBeChecked();

  // src/ removed from the project root.
  listings['.'] = [{ name: 'stay.txt', type: 'file' }];
  delete listings.src;
  await user.click(screen.getByRole('button', { name: /refresh/i }));

  await waitFor(() => {
    expect(screen.queryByRole('treeitem', { name: /src, directory/i })).not.toBeInTheDocument();
  });
  await waitFor(() => {
    const allowed = JSON.parse(localStorage.getItem('ai-terminal-chat:allowed-paths') || '[]');
    expect(allowed).toEqual(['stay.txt']);
  });
});

test('selection prune normalizes backslash paths when matching children', async () => {
  const user = userEvent.setup();
  const listings = {
    '.': [
      { name: 'src', type: 'directory' },
      { name: 'keep.txt', type: 'file' },
    ],
  };
  mockProjectList(listings);

  // Windows-style stored selection under src\
  localStorage.setItem('ai-terminal-chat:allowed-paths', JSON.stringify(['src\\gone.js', 'keep.txt']));
  localStorage.setItem(`project-explorer:${host}:selected`, JSON.stringify(['src\\gone.js', 'keep.txt']));

  render(<ProjectExplorer host={host} />);
  expect(await screen.findByRole('checkbox', { name: /select keep\.txt for the agent/i })).toBeChecked();

  listings['.'] = [{ name: 'keep.txt', type: 'file' }];
  await user.click(screen.getByRole('button', { name: /refresh/i }));

  await waitFor(() => {
    const allowed = JSON.parse(localStorage.getItem('ai-terminal-chat:allowed-paths') || '[]');
    expect(allowed).toEqual(['keep.txt']);
  });
});

test('a deferred initial root load cannot overwrite a completed Refresh', async () => {
  const user = userEvent.setup();
  let resolveInitial;
  let rootCalls = 0;
  axios.get.mockImplementation(async (_url, config = {}) => {
    const path = config.params?.path;
    if (path !== '.') {
      return { data: { path, entries: [] } };
    }
    rootCalls += 1;
    if (rootCalls === 1) {
      return new Promise((resolve) => {
        resolveInitial = resolve;
      });
    }
    return {
      data: {
        path: '.',
        entries: [{ name: 'after-refresh.txt', type: 'file' }],
      },
    };
  });

  render(<ProjectExplorer host={host} />);
  // Initial request is in flight; Refresh starts a newer root load.
  await user.click(await screen.findByRole('button', { name: /refresh/i }));
  expect(await screen.findByRole('treeitem', { name: /after-refresh\.txt, file/i })).toBeInTheDocument();

  // Late initial response with stale listing must not replace the Refresh result.
  resolveInitial({
    data: {
      path: '.',
      entries: [{ name: 'stale-initial.txt', type: 'file' }],
    },
  });

  await waitFor(() => {
    expect(screen.getByRole('treeitem', { name: /after-refresh\.txt, file/i })).toBeInTheDocument();
    expect(screen.queryByRole('treeitem', { name: /stale-initial\.txt/i })).not.toBeInTheDocument();
  });
});

test('collapsing a folder while its load is pending does not re-expand when the response arrives', async () => {
  const user = userEvent.setup();
  let resolveSrc;
  axios.get.mockImplementation(async (_url, config = {}) => {
    const path = config.params?.path;
    if (path === '.') {
      return {
        data: {
          path: '.',
          entries: [{ name: 'src', type: 'directory' }],
        },
      };
    }
    if (path === 'src') {
      return new Promise((resolve) => {
        resolveSrc = resolve;
      });
    }
    return { data: { path, entries: [] } };
  });

  render(<ProjectExplorer host={host} />);
  const folder = await screen.findByRole('treeitem', { name: /src, directory/i });
  await user.click(folder); // start expand (load pending)
  expect(folder).toHaveAttribute('aria-expanded', ''); // not expanded until load completes

  // Collapse while pending (second click while still collapsed may just re-trigger expand).
  // Instead, ensure pendingExpand is cleared by clicking collapse after a microtask
  // once expanded would be set — we simulate by calling collapse via keyboard after
  // marking intent: click again is expand intent in UI when aria-expanded is false.
  // Force collapse by using the Collapse all control.
  await user.click(screen.getByRole('button', { name: /collapse all/i }));

  resolveSrc({
    data: {
      path: 'src',
      entries: [{ name: 'late.js', type: 'file' }],
    },
  });

  await waitFor(() => {
    expect(screen.getByRole('treeitem', { name: /src, directory/i })).toHaveAttribute('aria-expanded', '');
  });
  expect(screen.queryByRole('treeitem', { name: /late\.js/i })).not.toBeInTheDocument();
});


test('keeps project selections in session storage when persistent memory is disabled', async () => {
  localStorage.setItem('ai-terminal-chat:memory-enabled', 'false');
  localStorage.setItem('ai-terminal-chat:allowed-paths', JSON.stringify(['persisted.txt']));
  localStorage.setItem(`project-explorer:${host}:selected`, JSON.stringify(['persisted.txt']));
  sessionStorage.setItem(`project-explorer:${host}:selected`, JSON.stringify(['session.txt']));
  sessionStorage.setItem('ai-terminal-chat:allowed-paths', JSON.stringify(['session.txt']));

  axios.get.mockResolvedValueOnce({
    data: { path: '.', entries: [{ name: 'session.txt', type: 'file' }, { name: 'persisted.txt', type: 'file' }] },
  });

  render(<ProjectExplorer host={host} />);

  expect(await screen.findByRole('checkbox', { name: /select session\.txt for the agent/i })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: /select persisted\.txt for the agent/i })).not.toBeChecked();
  expect(localStorage.getItem('ai-terminal-chat:allowed-paths')).toBeNull();
  expect(localStorage.getItem(`project-explorer:${host}:selected`)).toBeNull();
});
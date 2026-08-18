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

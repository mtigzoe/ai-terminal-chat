import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import axios from 'axios';
import ProjectExplorer from './ProjectExplorer';

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
  },
}));

const host = 'http://localhost:9000';

beforeEach(() => {
  axios.get.mockReset();
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
  expect(screen.getByRole('checkbox', { name: /select readme\.md for the agent/i })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /open directory src/i })).toBeInTheDocument();
  expect(screen.getByRole('listbox', { name: /project files and directories/i })).toBeInTheDocument();
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
  fireEvent.click(await screen.findByRole('button', { name: /open hello\.txt/i }));

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
  const fileButton = await screen.findByRole('button', { name: /open a\.txt/i });
  fileButton.focus();
  fireEvent.keyDown(screen.getByRole('option', { name: /a\.txt, file/i }), { key: ' ' });

  expect(screen.getByRole('checkbox', { name: /select a\.txt for the agent/i })).toBeChecked();
  expect(axios.get).toHaveBeenCalledTimes(1);
});

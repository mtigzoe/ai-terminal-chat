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
});

test('lists directory entries and announces path', async () => {
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

  expect(await screen.findByRole('heading', { name: /project files/i })).toBeInTheDocument();
  expect(await screen.findByRole('option', { name: /readme\.md, file/i })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: /src, directory/i })).toBeInTheDocument();
  expect(screen.getByRole('listbox', { name: /files in/i })).toBeInTheDocument();
});

test('opens a file and shows contents', async () => {
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

  render(<ProjectExplorer host={host} />);
  const fileOption = await screen.findByRole('option', { name: /hello\.txt, file/i });
  fireEvent.click(fileOption);

  expect(await screen.findByRole('heading', { name: /file:/i })).toBeInTheDocument();
  expect(screen.getByLabelText(/contents of hello\.txt/i)).toHaveTextContent('hello world');
  await waitFor(() => {
    expect(axios.get).toHaveBeenCalledWith(
      `${host}/project/read`,
      expect.objectContaining({ params: { path: 'hello.txt' } })
    );
  });
});

test('keyboard navigation moves selection', async () => {
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
  const listbox = await screen.findByRole('listbox');
  listbox.focus();
  fireEvent.keyDown(listbox, { key: 'ArrowDown' });
  expect(screen.getByRole('option', { name: /b\.txt, file/i })).toHaveAttribute('aria-selected', 'true');
});

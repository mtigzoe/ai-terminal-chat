import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import axios from 'axios';
import TerminalPanel from './TerminalPanel';

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

const host = 'http://localhost:9000';

beforeEach(() => {
  axios.post.mockReset();
});

test('renders accessible terminal controls', () => {
  render(<TerminalPanel host={host} />);
  expect(screen.getByRole('heading', { name: /^terminal$/i })).toBeInTheDocument();
  expect(screen.getByLabelText(/^command$/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^run$/i })).toBeInTheDocument();
  expect(screen.getByRole('log', { name: /terminal output/i })).toBeInTheDocument();
});

test('runs a command and shows output', async () => {
  axios.post.mockResolvedValueOnce({
    data: {
      command: 'pwd',
      returncode: 0,
      stdout: '/tmp/project\n',
      stderr: '',
      truncated: false,
    },
  });

  render(<TerminalPanel host={host} />);
  fireEvent.change(screen.getByLabelText(/^command$/i), { target: { value: 'pwd' } });
  fireEvent.click(screen.getByRole('button', { name: /^run$/i }));

  await waitFor(() => {
    expect(axios.post).toHaveBeenCalledWith(`${host}/terminal/run`, { command: 'pwd' });
  });
  expect(await screen.findByText(/\/tmp\/project/)).toBeInTheDocument();
  expect(screen.getByText(/exit code: 0/i)).toBeInTheDocument();
});

test('shows backend error for blocked command', async () => {
  axios.post.mockRejectedValueOnce({
    response: { data: { error: 'Command not allowed: rm -rf /' } },
  });

  render(<TerminalPanel host={host} />);
  fireEvent.change(screen.getByLabelText(/^command$/i), { target: { value: 'rm -rf /' } });
  fireEvent.click(screen.getByRole('button', { name: /^run$/i }));

  expect(await screen.findByRole('alert')).toHaveTextContent(/command not allowed/i);
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import axios from 'axios';
import TerminalPanel from './components/TerminalPanel';

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

const host = 'http://localhost:9000';

describe('TerminalPanel accessibility', () => {
  beforeEach(() => {
    axios.post.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('renders accessible terminal controls', () => {
    render(<TerminalPanel host={host} />);
    expect(screen.getByRole('heading', { name: /^terminal$/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/^command$/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^run$/i })).toBeInTheDocument();
    expect(screen.getByRole('log', { name: /terminal output/i })).toBeInTheDocument();
  });

  test('terminal output region has aria-live=polite', () => {
    render(<TerminalPanel host={host} />);
    const log = screen.getByRole('log', { name: /terminal output/i });
    expect(log).toHaveAttribute('aria-live', 'polite');
  });

  test('terminal status region has role=status and aria-live=polite', () => {
    render(<TerminalPanel host={host} />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent(/terminal ready/i);
  });

  test('Enter in the command input submits the command', async () => {
    axios.post.mockResolvedValueOnce({
      data: { command: 'pwd', returncode: 0, stdout: '/tmp/project\n', stderr: '' },
    });

    render(<TerminalPanel host={host} />);
    const input = screen.getByLabelText(/^command$/i);
    fireEvent.change(input, { target: { value: 'pwd' } });
    fireEvent.submit(input.closest('form'));

    await waitFor(() => {
      expect(axios.post).toHaveBeenCalledWith(`${host}/terminal/run`, { command: 'pwd' });
    });
  });

  test('focus returns to the command input after a command completes', async () => {
    axios.post.mockResolvedValueOnce({
      data: { command: 'pwd', returncode: 0, stdout: '/tmp/project\n', stderr: '' },
    });

    render(<TerminalPanel host={host} />);
    const input = screen.getByLabelText(/^command$/i);
    fireEvent.change(input, { target: { value: 'pwd' } });
    fireEvent.submit(input.closest('form'));

    await waitFor(() => {
      expect(input).toHaveFocus();
    });
  });

  test('stderr output is announced with role=alert', async () => {
    axios.post.mockResolvedValueOnce({
      data: { command: 'bad', returncode: 1, stdout: '', stderr: 'command not found' },
    });

    render(<TerminalPanel host={host} />);
    const input = screen.getByLabelText(/^command$/i);
    fireEvent.change(input, { target: { value: 'bad' } });
    fireEvent.submit(input.closest('form'));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/command not found/i);
  });

  test('the run button is disabled while a command is running and re-enabled afterwards', async () => {
    let resolvePost;
    axios.post.mockReturnValue(
      new Promise((resolve) => {
        resolvePost = resolve;
      })
    );

    render(<TerminalPanel host={host} />);
    const input = screen.getByLabelText(/^command$/i);

    fireEvent.change(input, { target: { value: 'sleep 1' } });
    fireEvent.submit(input.closest('form'));

    expect(screen.getByRole('button', { name: /^running/i })).toBeDisabled();

    resolvePost({ data: { command: 'sleep 1', returncode: 0, stdout: '', stderr: '' } });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^run$/i })).toBeDisabled();
    });

    fireEvent.change(input, { target: { value: 'echo done' } });
    expect(screen.getByRole('button', { name: /^run$/i })).not.toBeDisabled();
  });
});

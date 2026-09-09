import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import HistoryPage from './HistoryPage.jsx';

expect.extend(toHaveNoViolations);

const mockLocalStorage = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
};

Object.defineProperty(window, 'localStorage', {
  value: mockLocalStorage,
  writable: true,
});

Object.defineProperty(window, 'location', {
  value: { assign: vi.fn(), pathname: '/history.html' },
  writable: true,
});

describe('HistoryPage accessibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLocalStorage.getItem.mockReturnValue(null);
    window.location.assign.mockClear();
  });

  test('has no automated accessibility violations', async () => {
    const { container } = render(<HistoryPage />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  test('renders main landmark with accessible heading', () => {
    render(<HistoryPage />);
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /history/i })).toBeInTheDocument();
  });

  test('includes main navigation', () => {
    render(<HistoryPage />);
    expect(screen.getByRole('navigation', { name: /main/i })).toBeInTheDocument();
  });

  test('search input is labelled and announces results', async () => {
    const chats = [
      { id: '1', title: 'First chat', date: '2024-01-01T10:00:00Z', messages: [{ parts: [{ text: 'hello' }] }] },
      { id: '2', title: 'Second chat', date: '2024-01-02T10:00:00Z', messages: [{ parts: [{ text: 'world' }] }] },
    ];
    mockLocalStorage.getItem.mockReturnValue(JSON.stringify(chats));

    render(<HistoryPage />);
    await waitFor(() => {
      expect(screen.getByLabelText(/search history/i)).toBeInTheDocument();
    });
    const search = screen.getByLabelText(/search history/i);
    expect(search).toHaveAttribute('type', 'search');
    expect(search).toHaveAttribute('id', 'history-search');

    fireEvent.change(search, { target: { value: 'first' } });
    await waitFor(() => {
      expect(screen.getByText(/first chat/i)).toBeInTheDocument();
      expect(screen.queryByText(/second chat/i)).not.toBeInTheDocument();
    });
  });

  test('chat list uses semantic list markup', async () => {
    const chats = [
      { id: '1', title: 'First chat', date: '2024-01-01T10:00:00Z', messages: [{ parts: [{ text: 'hello' }] }] },
    ];
    mockLocalStorage.getItem.mockReturnValue(JSON.stringify(chats));

    render(<HistoryPage />);
    await waitFor(() => {
      const lists = screen.getAllByRole('list');
      // Find the history list (not the nav list)
      const historyList = lists.find(list => list.closest('.history-section'));
      expect(historyList).toBeInTheDocument();
    });
  });

  test('restore buttons have accessible names with chat titles', async () => {
    const chats = [
      { id: '1', title: 'My chat', date: '2024-01-01T10:00:00Z', messages: [{ parts: [{ text: 'hello' }] }] },
    ];
    mockLocalStorage.getItem.mockReturnValue(JSON.stringify(chats));

    render(<HistoryPage />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /restore chat: my chat/i })).toBeInTheDocument();
    });
  });

  test('rename buttons have accessible names', async () => {
    const chats = [
      { id: '1', title: 'My chat', date: '2024-01-01T10:00:00Z', messages: [{ parts: [{ text: 'hello' }] }] },
    ];
    mockLocalStorage.getItem.mockReturnValue(JSON.stringify(chats));

    render(<HistoryPage />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /rename my chat/i })).toBeInTheDocument();
    });
  });

  test('rename input is labelled and keyboard accessible', async () => {
    const chats = [
      { id: '1', title: 'My chat', date: '2024-01-01T10:00:00Z', messages: [{ parts: [{ text: 'hello' }] }] },
    ];
    mockLocalStorage.getItem.mockReturnValue(JSON.stringify(chats));

    render(<HistoryPage />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /rename my chat/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /rename my chat/i }));
    await waitFor(() => {
      const renameInput = screen.getByLabelText(/rename chat/i);
      expect(renameInput).toBeInTheDocument();
      renameInput.focus();
      expect(renameInput).toHaveFocus();
    });
  });

  test('Escape cancels rename', async () => {
    const chats = [
      { id: '1', title: 'My chat', date: '2024-01-01T10:00:00Z', messages: [{ parts: [{ text: 'hello' }] }] },
    ];
    mockLocalStorage.getItem.mockReturnValue(JSON.stringify(chats));

    render(<HistoryPage />);
    await waitFor(() => {
      const renameButton = screen.getByRole('button', { name: /rename my chat/i });
      renameButton.focus();
      fireEvent.click(renameButton);
    });
    await waitFor(() => {
      expect(screen.getByLabelText(/rename chat/i)).toBeInTheDocument();
    });
    const renameInput = screen.getByLabelText(/rename chat/i);
    renameInput.focus();
    fireEvent.keyDown(renameInput, { key: 'Escape' });
    // Just verify the rename input is gone
    await waitFor(() => {
      expect(screen.queryByLabelText(/rename chat/i)).not.toBeInTheDocument();
    });
  });

  test('clear history button has help text via aria-describedby', async () => {
    const chats = [
      { id: '1', title: 'My chat', date: '2024-01-01T10:00:00Z', messages: [{ parts: [{ text: 'hello' }] }] },
    ];
    mockLocalStorage.getItem.mockReturnValue(JSON.stringify(chats));

    render(<HistoryPage />);
    await waitFor(() => {
      const clearButton = screen.getByRole('button', { name: /clear/i });
      expect(clearButton).toHaveAttribute('aria-describedby', 'history-clear-help');
      expect(screen.getByText(/remove all saved chats from history/i)).toBeInTheDocument();
    });
  });

  test('status region announces clear success', async () => {
    const chats = [
      { id: '1', title: 'My chat', date: '2024-01-01T10:00:00Z', messages: [{ parts: [{ text: 'hello' }] }] },
    ];
    mockLocalStorage.getItem.mockReturnValue(JSON.stringify(chats));

    render(<HistoryPage />);
    await waitFor(() => {
      const clearButton = screen.getByRole('button', { name: /clear/i });
      fireEvent.click(clearButton);
    });
    await waitFor(() => {
      const status = screen.getByRole('status');
      expect(status).toHaveTextContent(/chat history cleared/i);
    });
  });

  test('error messages use role=alert with aria-live=assertive', async () => {
    const chats = [
      { id: '1', title: 'My chat', date: '2024-01-01T10:00:00Z', messages: [{ parts: [{ text: 'hello' }] }] },
    ];
    mockLocalStorage.getItem.mockReturnValue(JSON.stringify(chats));
    mockLocalStorage.removeItem.mockImplementation(() => { throw new Error('fail'); });

    render(<HistoryPage />);
    await waitFor(() => {
      const clearButton = screen.getByRole('button', { name: /clear/i });
      fireEvent.click(clearButton);
    });
    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert).toHaveAttribute('aria-live', 'assertive');
      expect(alert).toHaveTextContent(/could not clear chat history/i);
    });
  });

  test('empty state is announced', async () => {
    mockLocalStorage.getItem.mockReturnValue('[]');
    render(<HistoryPage />);
    await waitFor(() => {
      expect(screen.getByText(/no saved chats yet/i)).toBeInTheDocument();
    });
  });

  test('chat message count is accessible', async () => {
    const chats = [
      { id: '1', title: 'My chat', date: '2024-01-01T10:00:00Z', messages: [
        { parts: [{ text: 'msg1' }] },
        { parts: [{ text: 'msg2' }] },
      ] },
    ];
    mockLocalStorage.getItem.mockReturnValue(JSON.stringify(chats));

    render(<HistoryPage />);
    await waitFor(() => {
      expect(screen.getByLabelText(/2 messages/i)).toBeInTheDocument();
    });
  });
});
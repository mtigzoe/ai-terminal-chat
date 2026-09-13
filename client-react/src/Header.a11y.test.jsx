import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import Header from './components/Header';

describe('Header accessibility', () => {
  test('stream toggle has aria-pressed reflecting its state', () => {
    const { rerender } = render(<Header toggled={false} setToggled={() => {}} waiting={false} />);
    const toggle = screen.getByRole('button', { name: /stream response/i });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    rerender(<Header toggled={true} setToggled={() => {}} waiting={false} />);
    const toggleOn = screen.getByRole('button', { name: /stream response/i });
    expect(toggleOn).toHaveAttribute('aria-pressed', 'true');
  });

  test('clear conversation button has an accessible name', () => {
    render(<Header toggled={false} setToggled={() => {}} waiting={false} />);
    expect(screen.getByRole('button', { name: /clear conversation/i })).toBeInTheDocument();
  });

  test('clicking clear conversation opens an accessible dialog', () => {
    render(<Header toggled={false} setToggled={() => {}} waiting={false} />);
    fireEvent.click(screen.getByRole('button', { name: /clear conversation/i }));

    const dialog = screen.getByRole('dialog', { name: /clear conversation\?/i });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText(/remove the current conversation/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeInTheDocument();
  });

  test('Escape closes the clear-conversation dialog', () => {
    render(<Header toggled={false} setToggled={() => {}} waiting={false} />);
    fireEvent.click(screen.getByRole('button', { name: /clear conversation/i }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('clear conversation button is disabled while waiting', () => {
    render(<Header toggled={false} setToggled={() => {}} waiting={true} />);
    expect(screen.getByRole('button', { name: /clear conversation/i })).toBeDisabled();
  });

  test('the dialog is labelled with aria-labelledby', () => {
    render(<Header toggled={false} setToggled={() => {}} waiting={false} />);
    fireEvent.click(screen.getByRole('button', { name: /clear conversation/i }));

    const dialog = screen.getByRole('dialog', { name: /clear conversation\?/i });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby', 'clear-conversation-title');
  });

  test('waiting status is announced once and clears after two seconds', () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<Header toggled={false} setToggled={() => {}} waiting={false} />);
      rerender(<Header toggled={false} setToggled={() => {}} waiting={true} />);

      const status = screen.getByRole('status');
      expect(status).toHaveTextContent('Response in progress — clear conversation unavailable');

      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(status).toHaveTextContent('');

      rerender(<Header toggled={false} setToggled={() => {}} waiting={true} />);
      expect(status).toHaveTextContent('');
    } finally {
      vi.useRealTimers();
    }
  });
});

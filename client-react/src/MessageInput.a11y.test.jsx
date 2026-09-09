import { fireEvent, render, screen } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { describe, expect, test, vi } from 'vitest';
import MessageInput from './components/MessageInput';

expect.extend(toHaveNoViolations);

describe('MessageInput accessibility', () => {
  const defaultProps = {
    inputRef: { current: null },
    waiting: false,
    handleClick: () => {},
  };

  test('has no automated accessibility violations', async () => {
    const { container } = render(<MessageInput {...defaultProps} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  test('has no automated accessibility violations while waiting', async () => {
    const { container } = render(<MessageInput {...defaultProps} waiting={true} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  test('has no automated accessibility violations with pending confirmation', async () => {
    const { container } = render(<MessageInput {...defaultProps} pendingConfirmation={true} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  test('associates a label with the textarea', () => {
    render(<MessageInput {...defaultProps} />);
    expect(screen.getByLabelText(/^message$/i)).toBeInTheDocument();
  });

  test('exposes help text through aria-describedby', () => {
    render(<MessageInput {...defaultProps} />);
    const textarea = screen.getByLabelText(/^message$/i);
    expect(textarea).toHaveAttribute('aria-describedby', 'message-input-help');
    expect(screen.getByText(/press enter to send/i)).toBeInTheDocument();
  });

  test('Enter submits the message', () => {
    const handleClick = () => {};
    render(<MessageInput {...defaultProps} handleClick={handleClick} />);
    const textarea = screen.getByLabelText(/^message$/i);
    fireEvent.change(textarea, { target: { value: 'hello' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
  });

  test('Shift+Enter does not submit the message', () => {
    const handleClick = vi.fn();
    render(<MessageInput {...defaultProps} handleClick={handleClick} />);
    const textarea = screen.getByLabelText(/^message$/i);
    fireEvent.change(textarea, { target: { value: 'line one' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(handleClick).not.toHaveBeenCalled();
  });

  test('the send button has an accessible name', () => {
    render(<MessageInput {...defaultProps} />);
    expect(screen.getByRole('button', { name: /send message/i })).toBeInTheDocument();
  });

  test('the send button is disabled while waiting', () => {
    render(<MessageInput {...defaultProps} waiting={true} />);
    expect(screen.getByRole('button', { name: /send message/i })).toBeDisabled();
  });
});

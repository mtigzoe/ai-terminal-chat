import { fireEvent, render, screen } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { describe, expect, test, vi } from 'vitest';
import InstructionsPage from './InstructionsPage.jsx';

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

describe('InstructionsPage accessibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLocalStorage.getItem.mockReturnValue(null);
  });

  test('has no automated accessibility violations', async () => {
    const { container } = render(<InstructionsPage />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  test('renders main landmark with accessible heading', () => {
    render(<InstructionsPage />);
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /instructions/i })).toBeInTheDocument();
  });

  test('associates label with textarea via htmlFor/id', () => {
    render(<InstructionsPage />);
    const textarea = screen.getByLabelText(/instructions text/i);
    expect(textarea).toBeInTheDocument();
    expect(textarea).toHaveAttribute('id', 'user-instructions');
  });

  test('links help text via aria-describedby', () => {
    render(<InstructionsPage />);
    const textarea = screen.getByLabelText(/instructions text/i);
    expect(textarea).toHaveAttribute('aria-describedby', 'user-instructions-help');
    expect(screen.getByText(/leave empty to send no extra instructions/i)).toBeInTheDocument();
  });

  test('save and clear buttons have accessible names', () => {
    render(<InstructionsPage />);
    expect(screen.getByRole('button', { name: /save instructions/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /clear/i })).toBeInTheDocument();
  });

  test('status region announces save/clear results', async () => {
    render(<InstructionsPage />);
    const saveButton = screen.getByRole('button', { name: /save instructions/i });
    fireEvent.click(saveButton);
    await vi.waitFor(() => {
      const status = screen.getByRole('status');
      expect(status).toHaveTextContent(/instructions saved/i);
    });
  });

  test('textarea retains focus after save', async () => {
    render(<InstructionsPage />);
    const textarea = screen.getByLabelText(/instructions text/i);
    textarea.focus();
    const saveButton = screen.getByRole('button', { name: /save instructions/i });
    fireEvent.click(saveButton);
    await vi.waitFor(() => {
      expect(textarea).toHaveFocus();
    });
  });

  test('loads saved instructions from localStorage on mount', () => {
    mockLocalStorage.getItem.mockReturnValue('Custom instruction');
    render(<InstructionsPage />);
    expect(screen.getByLabelText(/instructions text/i)).toHaveValue('Custom instruction');
  });
});
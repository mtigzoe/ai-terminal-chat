import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import axios from 'axios';
import App from './App';

vi.mock('axios', () => ({
  default: {
    get: vi.fn(() => Promise.resolve({ data: { path: '/tmp/project' } })),
    post: vi.fn(),
    isCancel: vi.fn(() => false),
  },
}));

import axiosInstance from 'axios';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete global.fetch;
});

describe('ConfirmationDialog accessibility', () => {
  test('is labelled with aria-labelledby and described by dynamic preview text', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /clear conversation/i }));

    const dialog = screen.getByRole('dialog', { name: /clear conversation\?/i });
    expect(dialog).toHaveAttribute('aria-labelledby', 'clear-conversation-title');
    expect(dialog).toHaveAttribute('aria-describedby', 'clear-conversation-description');
  });

  test('focus moves to the deny button when opened', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /clear conversation/i }));
    expect(screen.getByRole('button', { name: /^cancel$/i })).toHaveFocus();
  });

  test('Escape closes the dialog and returns focus to the trigger', async () => {
    render(<App />);
    const trigger = screen.getByRole('button', { name: /clear conversation/i });
    trigger.focus();
    fireEvent.click(trigger);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(trigger).toHaveFocus();
  });

  test('Tab is trapped inside the dialog', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /clear conversation/i }));

    const dialog = screen.getByRole('dialog');
    const denyButton = within(dialog).getByRole('button', { name: /^cancel$/i });
    const allowButton = within(dialog).getByRole('button', { name: /^clear conversation$/i });

    denyButton.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(allowButton).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Tab' });
    expect(denyButton).toHaveFocus();
  });

  test('Shift+Tab cycles backward inside the dialog', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /clear conversation/i }));

    const dialog = screen.getByRole('dialog');
    const denyButton = within(dialog).getByRole('button', { name: /^cancel$/i });
    const allowButton = within(dialog).getByRole('button', { name: /^clear conversation$/i });

    allowButton.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(denyButton).toHaveFocus();
  });
});

describe('App-level focus and skip links', () => {
  test('skip links are present and target major regions', () => {
    render(<App />);
    const skipLinks = screen.getAllByRole('link', { name: /skip to/i });
    expect(skipLinks.length).toBeGreaterThanOrEqual(3);
    expect(skipLinks[0]).toHaveAttribute('href', '#main-conversation');
    expect(skipLinks[1]).toHaveAttribute('href', '#message-input-region');
    expect(skipLinks[2]).toHaveAttribute('href', '#workspace-panels');
  });

  test('F6 moves focus from chat to project tree', async () => {
    render(<App />);
    const textarea = screen.getByLabelText(/^message$/i);
    textarea.focus();
    expect(document.activeElement).toBe(textarea);

    fireEvent.keyDown(document, { key: 'F6' });
    await waitFor(() => {
      const tree = document.querySelector('[data-focus-target="project-tree"]');
      expect(document.activeElement).toBe(tree?.querySelector('[role="treeitem"]') || tree);
    });
  });

  test('F6 moves focus from project to terminal', async () => {
    render(<App />);
    const tree = document.querySelector('[data-focus-target="project-tree"]');
    const treeItem = tree?.querySelector('[role="treeitem"]');
    if (treeItem) treeItem.focus();

    fireEvent.keyDown(document, { key: 'F6' });
    await waitFor(() => {
      const terminalInput = document.querySelector('[data-focus-target="terminal-input"]');
      expect(document.activeElement).toBe(terminalInput);
    });
  });

  test('Shift+F6 moves focus from terminal to chat', async () => {
    render(<App />);
    const terminalInput = document.querySelector('[data-focus-target="terminal-input"]');
    if (terminalInput) terminalInput.focus();

    fireEvent.keyDown(document, { key: 'F6', shiftKey: true });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText(/^message$/i));
    });
  });

  test('cancel response button is present while waiting', async () => {
    axiosInstance.post.mockReturnValue(new Promise(() => {}));
    render(<App />);
    const textarea = screen.getByLabelText(/^message$/i);
    fireEvent.change(textarea, { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: /send message/i }));

    const cancelButton = await screen.findByRole('button', { name: /cancel response/i });
    expect(cancelButton).toBeInTheDocument();
  });
});

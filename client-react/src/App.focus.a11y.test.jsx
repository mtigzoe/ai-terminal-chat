import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import axios from 'axios';
import App from './App';

expect.extend(toHaveNoViolations);

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
  // Default mock for project-root
  axiosInstance.get.mockResolvedValue({ data: { path: '/tmp/project' } });
  axiosInstance.isCancel.mockReturnValue(false);
  try {
    localStorage.clear();
  } catch {
    // ignore unavailable localStorage
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  delete global.fetch;
});

function makeStreamResponse(chunks, { ok = true, status = 200, statusText = 'OK' } = {}) {
  let index = 0;
  const encoder = new TextEncoder();
  return {
    ok,
    status,
    statusText,
    body: {
      getReader() {
        return {
          read: () => {
            if (index < chunks.length) {
              const chunk = encoder.encode(chunks[index]);
              index += 1;
              return Promise.resolve({ value: chunk, done: false });
            }
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    },
    json: () => Promise.resolve({}),
  };
}

function getTextarea() {
  return screen.getByLabelText(/^message$/i);
}

function getSendButton() {
  const inputRegion = document.getElementById('message-input-region');
  return within(inputRegion).getByRole('button', { name: /send message/i });
}

async function sendMessage(text) {
  fireEvent.change(getTextarea(), { target: { value: text } });
  fireEvent.click(getSendButton());
}

// Helper to mock the confirmation resolution response
function mockConfirmResponse(cancelled = true) {
  axiosInstance.post.mockResolvedValueOnce({
    data: { result: { cancelled } },
  });
}

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
    mockConfirmResponse(true);
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

describe('ConfirmationDialog variant: clear conversation', () => {
  test('has no automated accessibility violations', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /clear conversation/i }));

    const dialog = screen.getByRole('dialog', { name: /clear conversation\?/i });
    const results = await axe(dialog);
    expect(results).toHaveNoViolations();
  });

  test('has role=dialog and aria-modal=true', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /clear conversation/i }));

    const dialog = screen.getByRole('dialog', { name: /clear conversation\?/i });
    expect(dialog).toHaveAttribute('role', 'dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  test('aria-labelledby points to existing title element', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /clear conversation/i }));

    const dialog = screen.getByRole('dialog', { name: /clear conversation\?/i });
    expect(dialog).toHaveAttribute('aria-labelledby', 'clear-conversation-title');
    expect(document.getElementById('clear-conversation-title')).toHaveTextContent(/clear conversation\?/i);
  });

  test('aria-describedby points to existing description elements', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /clear conversation/i }));

    const dialog = screen.getByRole('dialog', { name: /clear conversation\?/i });
    expect(dialog).toHaveAttribute('aria-describedby', 'clear-conversation-description');
    expect(document.getElementById('clear-conversation-description')).toBeInTheDocument();
  });

  test('has accessible title and meaningful description', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /clear conversation/i }));

    expect(screen.getByRole('dialog', { name: /clear conversation\?/i })).toBeInTheDocument();
    expect(screen.getByText(/this will remove all messages/i)).toBeInTheDocument();
  });

  test('both buttons have accessible names', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /clear conversation/i }));

    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^clear conversation$/i })).toBeInTheDocument();
  });

  test('initial focus goes to deny button', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /clear conversation/i }));

    expect(screen.getByRole('button', { name: /^cancel$/i })).toHaveFocus();
  });

  test('Tab remains trapped inside the dialog', () => {
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

  test('Shift+Tab remains trapped inside the dialog', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /clear conversation/i }));

    const dialog = screen.getByRole('dialog');
    const denyButton = within(dialog).getByRole('button', { name: /^cancel$/i });
    const allowButton = within(dialog).getByRole('button', { name: /^clear conversation$/i });

    allowButton.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(denyButton).toHaveFocus();
  });

  test('Escape closes the dialog and returns focus to trigger', async () => {
    render(<App />);
    const trigger = screen.getByRole('button', { name: /clear conversation/i });
    trigger.focus();
    fireEvent.click(trigger);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    mockConfirmResponse(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(trigger).toHaveFocus();
  });

  test('no duplicate or stale aria IDs', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /clear conversation/i }));

    const ids = [
      'clear-conversation-title',
      'clear-conversation-description',
    ];
    ids.forEach((id) => {
      const elements = document.querySelectorAll(`[id="${id}"]`);
      expect(elements).toHaveLength(1);
    });
  });
});

describe('ConfirmationDialog variant: file read permission', () => {
  test('has no automated accessibility violations', async () => {
    // Mock a file read permission pending confirmation
    axiosInstance.post
      .mockResolvedValueOnce({
        data: {
          tool_activity: [
            {
              type: 'pending_confirmation',
              action_id: 'read-1',
              name: 'read_file_permission',
              args: { path: 'secret.txt' },
              preview: { path: 'secret.txt', message: 'This file contains sensitive data.' },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: { result: { cancelled: true } },
      });

    render(<App />);
    await sendMessage('read secret.txt');

    const dialog = await screen.findByRole('dialog', { name: /file access requested/i });
    const results = await axe(dialog);
    expect(results).toHaveNoViolations();
  });

  test('has role=dialog and aria-modal=true', async () => {
    axiosInstance.post
      .mockResolvedValueOnce({
        data: {
          tool_activity: [
            {
              type: 'pending_confirmation',
              action_id: 'read-1',
              name: 'read_file_permission',
              args: { path: 'secret.txt' },
              preview: { path: 'secret.txt', message: 'This file contains sensitive data.' },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: { result: { cancelled: true } },
      });

    render(<App />);
    await sendMessage('read secret.txt');

    const dialog = await screen.findByRole('dialog', { name: /file access requested/i });
    expect(dialog).toHaveAttribute('role', 'dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  test('title is "File access requested" for read permission', async () => {
    axiosInstance.post
      .mockResolvedValueOnce({
        data: {
          tool_activity: [
            {
              type: 'pending_confirmation',
              action_id: 'read-1',
              name: 'read_file_permission',
              args: { path: 'secret.txt' },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: { result: { cancelled: true } },
      });

    render(<App />);
    await sendMessage('read secret.txt');

    const dialog = await screen.findByRole('dialog', { name: /file access requested/i });
    expect(dialog).toBeInTheDocument();
    expect(document.getElementById('confirmation-dialog-title')).toHaveTextContent(/file access requested/i);
  });

  test('includes file path in description', async () => {
    axiosInstance.post
      .mockResolvedValueOnce({
        data: {
          tool_activity: [
            {
              type: 'pending_confirmation',
              action_id: 'read-1',
              name: 'read_file_permission',
              args: { path: 'secret.txt' },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: { result: { cancelled: true } },
      });

    render(<App />);
    await sendMessage('read secret.txt');

    await screen.findByRole('dialog');
    expect(document.getElementById('confirmation-dialog-description')).toHaveTextContent(/secret\.txt/i);
  });

  test('includes preview text in aria-describedby when present', async () => {
    axiosInstance.post
      .mockResolvedValueOnce({
        data: {
          tool_activity: [
            {
              type: 'pending_confirmation',
              action_id: 'read-1',
              name: 'read_file_permission',
              args: { path: 'secret.txt' },
              preview: { path: 'secret.txt', message: 'This file contains sensitive data.' },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: { result: { cancelled: true } },
      });

    render(<App />);
    await sendMessage('read secret.txt');

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-describedby', expect.stringContaining('confirmation-dialog-preview'));
    expect(document.getElementById('confirmation-dialog-preview')).toHaveTextContent(/sensitive data/i);
  });

  test('omits preview element when preview is absent', async () => {
    axiosInstance.post
      .mockResolvedValueOnce({
        data: {
          tool_activity: [
            {
              type: 'pending_confirmation',
              action_id: 'read-1',
              name: 'read_file_permission',
              args: { path: 'secret.txt' },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: { result: { cancelled: true } },
      });

    render(<App />);
    await sendMessage('read secret.txt');

    await screen.findByRole('dialog');
    expect(document.getElementById('confirmation-dialog-preview')).toBeNull();
  });

  test('includes safety text specific to file read permission', async () => {
    axiosInstance.post
      .mockResolvedValueOnce({
        data: {
          tool_activity: [
            {
              type: 'pending_confirmation',
              action_id: 'read-1',
              name: 'read_file_permission',
              args: { path: 'secret.txt' },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: { result: { cancelled: true } },
      });

    render(<App />);
    await sendMessage('read secret.txt');

    await screen.findByRole('dialog');
    expect(document.getElementById('confirmation-dialog-safety')).toHaveTextContent(/add this file to the agent selection/i);
  });

  test('initial focus goes to allow button for file read permission', async () => {
    // Note: ConfirmationDialog focuses allowRef by default (line 33 in App.jsx)
    axiosInstance.post
      .mockResolvedValueOnce({
        data: {
          tool_activity: [
            {
              type: 'pending_confirmation',
              action_id: 'read-1',
              name: 'read_file_permission',
              args: { path: 'secret.txt' },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: { result: { cancelled: true } },
      });

    render(<App />);
    await sendMessage('read secret.txt');

    await screen.findByRole('dialog');
    expect(screen.getByRole('button', { name: /allow/i })).toHaveFocus();
  });

  test('Tab remains trapped inside the dialog', async () => {
    axiosInstance.post
      .mockResolvedValueOnce({
        data: {
          tool_activity: [
            {
              type: 'pending_confirmation',
              action_id: 'read-1',
              name: 'read_file_permission',
              args: { path: 'secret.txt' },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: { result: { cancelled: true } },
      });

    render(<App />);
    await sendMessage('read secret.txt');

    const dialog = await screen.findByRole('dialog');
    const denyButton = within(dialog).getByRole('button', { name: /decline/i });
    const allowButton = within(dialog).getByRole('button', { name: /allow/i });

    denyButton.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(allowButton).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Tab' });
    expect(denyButton).toHaveFocus();
  });

  test('Shift+Tab remains trapped inside the dialog', async () => {
    axiosInstance.post
      .mockResolvedValueOnce({
        data: {
          tool_activity: [
            {
              type: 'pending_confirmation',
              action_id: 'read-1',
              name: 'read_file_permission',
              args: { path: 'secret.txt' },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: { result: { cancelled: true } },
      });

    render(<App />);
    await sendMessage('read secret.txt');

    const dialog = await screen.findByRole('dialog');
    const denyButton = within(dialog).getByRole('button', { name: /decline/i });
    const allowButton = within(dialog).getByRole('button', { name: /allow/i });

    allowButton.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(denyButton).toHaveFocus();
  });

  test('Escape closes the dialog and returns focus to trigger', async () => {
    axiosInstance.post
      .mockResolvedValueOnce({
        data: {
          tool_activity: [
            {
              type: 'pending_confirmation',
              action_id: 'read-1',
              name: 'read_file_permission',
              args: { path: 'secret.txt' },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: { result: { cancelled: true } },
      });

    render(<App />);
    await sendMessage('read secret.txt');

    const dialog = await screen.findByRole('dialog');
    mockConfirmResponse(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  test('no duplicate or stale aria IDs', async () => {
    axiosInstance.post
      .mockResolvedValueOnce({
        data: {
          tool_activity: [
            {
              type: 'pending_confirmation',
              action_id: 'read-1',
              name: 'read_file_permission',
              args: { path: 'secret.txt' },
              preview: { path: 'secret.txt', message: 'Preview text' },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: { result: { cancelled: true } },
      });

    render(<App />);
    await sendMessage('read secret.txt');

    await screen.findByRole('dialog');
    const ids = [
      'confirmation-dialog-title',
      'confirmation-dialog-description',
      'confirmation-dialog-preview',
      'confirmation-dialog-safety',
    ];
    ids.forEach((id) => {
      const elements = document.querySelectorAll(`[id="${id}"]`);
      expect(elements).toHaveLength(1);
    });
  });
});

describe('ConfirmationDialog variant: tool confirmation', () => {
  test('has no automated accessibility violations', async () => {
    axiosInstance.post
      .mockResolvedValueOnce({
        data: {
          tool_activity: [
            {
              type: 'pending_confirmation',
              action_id: 'write-1',
              name: 'write_file',
              args: { path: 'notes.txt', content: 'Hello' },
              preview: { path: 'notes.txt', message: 'Create a new file with content.' },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: { result: { cancelled: true } },
      });

    render(<App />);
    await sendMessage('create notes.txt');

    const dialog = await screen.findByRole('dialog', { name: /confirmation required/i });
    const results = await axe(dialog);
    expect(results).toHaveNoViolations();
  });

  test('has role=dialog and aria-modal=true', async () => {
    axiosInstance.post
      .mockResolvedValueOnce({
        data: {
          tool_activity: [
            {
              type: 'pending_confirmation',
              action_id: 'write-1',
              name: 'write_file',
              args: { path: 'notes.txt' },
              preview: { path: 'notes.txt' },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: { result: { cancelled: true } },
      });

    render(<App />);
    await sendMessage('create notes.txt');

    const dialog = await screen.findByRole('dialog', { name: /confirmation required/i });
    expect(dialog).toHaveAttribute('role', 'dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  test('title is "Confirmation required" for tool confirmation', async () => {
    axiosInstance.post
      .mockResolvedValueOnce({
        data: {
          tool_activity: [
            {
              type: 'pending_confirmation',
              action_id: 'write-1',
              name: 'write_file',
              args: { path: 'notes.txt' },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: { result: { cancelled: true } },
      });

    render(<App />);
    await sendMessage('create notes.txt');

    const dialog = await screen.findByRole('dialog', { name: /confirmation required/i });
    expect(dialog).toBeInTheDocument();
    expect(document.getElementById('confirmation-dialog-title')).toHaveTextContent(/confirmation required/i);
  });

  test('includes tool name and args in description', async () => {
    axiosInstance.post
      .mockResolvedValueOnce({
        data: {
          tool_activity: [
            {
              type: 'pending_confirmation',
              action_id: 'write-1',
              name: 'write_file',
              args: { path: 'notes.txt', content: 'Hello' },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: { result: { cancelled: true } },
      });

    render(<App />);
    await sendMessage('create notes.txt');

    await screen.findByRole('dialog');
    expect(document.getElementById('confirmation-dialog-description')).toHaveTextContent(/write_file/i);
    expect(document.getElementById('confirmation-dialog-description')).toHaveTextContent(/notes\.txt/i);
  });

  test('includes preview text when present', async () => {
    axiosInstance.post
      .mockResolvedValueOnce({
        data: {
          tool_activity: [
            {
              type: 'pending_confirmation',
              action_id: 'write-1',
              name: 'write_file',
              args: { path: 'notes.txt' },
              preview: { path: 'notes.txt', message: 'Create a new file with content.' },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: { result: { cancelled: true } },
      });

    render(<App />);
    await sendMessage('create notes.txt');

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-describedby', expect.stringContaining('confirmation-dialog-preview'));
    expect(document.getElementById('confirmation-dialog-preview')).toHaveTextContent(/create a new file/i);
  });

  test('omits preview element when preview is absent', async () => {
    axiosInstance.post
      .mockResolvedValueOnce({
        data: {
          tool_activity: [
            {
              type: 'pending_confirmation',
              action_id: 'write-1',
              name: 'write_file',
              args: { path: 'notes.txt' },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: { result: { cancelled: true } },
      });

    render(<App />);
    await sendMessage('create notes.txt');

    await screen.findByRole('dialog');
    expect(document.getElementById('confirmation-dialog-preview')).toBeNull();
  });

  test('includes generic safety text for tool confirmation', async () => {
    axiosInstance.post
      .mockResolvedValueOnce({
        data: {
          tool_activity: [
            {
              type: 'pending_confirmation',
              action_id: 'write-1',
              name: 'write_file',
              args: { path: 'notes.txt' },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: { result: { cancelled: true } },
      });

    render(<App />);
    await sendMessage('create notes.txt');

    await screen.findByRole('dialog');
    expect(document.getElementById('confirmation-dialog-safety')).toHaveTextContent(/nothing will be changed unless you choose allow/i);
  });

  test('initial focus goes to allow button for tool confirmation', async () => {
    axiosInstance.post
      .mockResolvedValueOnce({
        data: {
          tool_activity: [
            {
              type: 'pending_confirmation',
              action_id: 'write-1',
              name: 'write_file',
              args: { path: 'notes.txt' },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: { result: { cancelled: true } },
      });

    render(<App />);
    await sendMessage('create notes.txt');

    await screen.findByRole('dialog');
    expect(screen.getByRole('button', { name: /allow/i })).toHaveFocus();
  });

  test('Tab remains trapped inside the dialog', async () => {
    axiosInstance.post
      .mockResolvedValueOnce({
        data: {
          tool_activity: [
            {
              type: 'pending_confirmation',
              action_id: 'write-1',
              name: 'write_file',
              args: { path: 'notes.txt' },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: { result: { cancelled: true } },
      });

    render(<App />);
    await sendMessage('create notes.txt');

    const dialog = await screen.findByRole('dialog');
    const denyButton = within(dialog).getByRole('button', { name: /decline/i });
    const allowButton = within(dialog).getByRole('button', { name: /allow/i });

    denyButton.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(allowButton).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Tab' });
    expect(denyButton).toHaveFocus();
  });

  test('Shift+Tab remains trapped inside the dialog', async () => {
    axiosInstance.post
      .mockResolvedValueOnce({
        data: {
          tool_activity: [
            {
              type: 'pending_confirmation',
              action_id: 'write-1',
              name: 'write_file',
              args: { path: 'notes.txt' },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: { result: { cancelled: true } },
      });

    render(<App />);
    await sendMessage('create notes.txt');

    const dialog = await screen.findByRole('dialog');
    const denyButton = within(dialog).getByRole('button', { name: /decline/i });
    const allowButton = within(dialog).getByRole('button', { name: /allow/i });

    allowButton.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(denyButton).toHaveFocus();
  });

  test('Escape closes the dialog and returns focus to trigger', async () => {
    axiosInstance.post
      .mockResolvedValueOnce({
        data: {
          tool_activity: [
            {
              type: 'pending_confirmation',
              action_id: 'write-1',
              name: 'write_file',
              args: { path: 'notes.txt' },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: { result: { cancelled: true } },
      });

    render(<App />);
    await sendMessage('create notes.txt');

    const dialog = await screen.findByRole('dialog');
    mockConfirmResponse(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  test('no duplicate or stale aria IDs', async () => {
    axiosInstance.post
      .mockResolvedValueOnce({
        data: {
          tool_activity: [
            {
              type: 'pending_confirmation',
              action_id: 'write-1',
              name: 'write_file',
              args: { path: 'notes.txt' },
              preview: { message: 'Preview text' },
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: { result: { cancelled: true } },
      });

    render(<App />);
    await sendMessage('create notes.txt');

    await screen.findByRole('dialog');
    const ids = [
      'confirmation-dialog-title',
      'confirmation-dialog-description',
      'confirmation-dialog-preview',
      'confirmation-dialog-safety',
    ];
    ids.forEach((id) => {
      const elements = document.querySelectorAll(`[id="${id}"]`);
      expect(elements).toHaveLength(1);
    });
  });
});

describe('ConfirmationDialog: cross-variant behavior', () => {
  test('all variants have no automated accessibility violations', async () => {
    // Clear conversation
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /clear conversation/i }));
    await screen.findByRole('dialog');
    let results = await axe(screen.getByRole('dialog'));
    expect(results).toHaveNoViolations();

    // Close dialog
    mockConfirmResponse(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  test('each variant has correct initial focus target', async () => {
    // Clear conversation - focuses Cancel button
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /clear conversation/i }));
    const clearDialog = screen.getByRole('dialog');
    expect(within(clearDialog).getByRole('button', { name: /^cancel$/i })).toHaveFocus();

    mockConfirmResponse(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  test('all variants have appropriate buttons with accessible names', async () => {
    // Clear conversation - uses "Cancel" and "Clear conversation"
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /clear conversation/i }));
    const clearDialog = screen.getByRole('dialog');
    within(clearDialog).getByRole('button', { name: /^cancel$/i });
    within(clearDialog).getByRole('button', { name: /^clear conversation$/i });

    mockConfirmResponse(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});

describe('App-level focus and skip links', () => {
  test('skip links are present and target major regions in document order', () => {
    render(<App />);
    const skipLinks = screen.getAllByRole('link', { name: /skip to/i });
    expect(skipLinks).toHaveLength(3);
    expect(skipLinks[0]).toHaveAttribute('href', '#main-conversation');
    expect(skipLinks[1]).toHaveAttribute('href', '#message-input-region');
    expect(skipLinks[2]).toHaveAttribute('href', '#terminal-region');
  });

  test('F6 moves focus from chat to terminal', async () => {
    render(<App />);
    const textarea = screen.getByLabelText(/^message$/i);
    textarea.focus();
    expect(document.activeElement).toBe(textarea);

    fireEvent.keyDown(document, { key: 'F6' });
    await waitFor(() => {
      expect(document.activeElement).toBe(document.querySelector('[data-focus-target="terminal-input"]'));
    });
  });

  test('F6 moves focus from terminal to chat', async () => {
    render(<App />);
    const terminalInput = document.querySelector('[data-focus-target="terminal-input"]');
    terminalInput?.focus();

    fireEvent.keyDown(document, { key: 'F6' });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText(/^message$/i));
    });
  });

  test('Shift+F6 moves focus from terminal to chat', async () => {
    render(<App />);
    const terminalInput = document.querySelector('[data-focus-target="terminal-input"]');
    terminalInput?.focus();

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
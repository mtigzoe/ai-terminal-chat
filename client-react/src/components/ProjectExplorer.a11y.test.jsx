import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import axios from 'axios';
import ProjectExplorer from './ProjectExplorer.jsx';

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

describe('ProjectExplorer accessibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    axios.post.mockResolvedValue({ data: { stdout: '' } });
    axios.get.mockImplementation(async (_url, config = {}) => {
      const path = config.params?.path;
      if (path === '.') {
        return {
          data: {
            path: '.',
            entries: [
              { name: 'src', type: 'directory' },
              { name: 'README.md', type: 'file' },
            ],
          },
        };
      }
      if (path === 'src') {
        return {
          data: {
            path: 'src',
            entries: [
              { name: 'index.js', type: 'file' },
              { name: 'utils.js', type: 'file' },
            ],
          },
        };
      }
      if (path === 'README.md') {
        return {
          data: {
            path: 'README.md',
            contents: '# Test project',
          },
        };
      }
      throw new Error(`Unexpected GET path: ${path}`);
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  test('tree items report position within their own sibling set', async () => {
    render(<ProjectExplorer host="http://localhost:9000" projectRoot="/project" />);

    await waitFor(() => expect(screen.getAllByRole('treeitem')).toHaveLength(2));

    const rootItems = screen.getAllByRole('treeitem');
    expect(rootItems[0]).toHaveAttribute('aria-posinset', '1');
    expect(rootItems[0]).toHaveAttribute('aria-setsize', '2');
    expect(rootItems[1]).toHaveAttribute('aria-posinset', '2');
    expect(rootItems[1]).toHaveAttribute('aria-setsize', '2');

    fireEvent.click(screen.getByRole('treeitem', { name: /src, directory/i }));

    await waitFor(() => expect(screen.getAllByRole('treeitem')).toHaveLength(4));

    const index = screen.getByRole('treeitem', { name: /index\.js, file/i });
    const utils = screen.getByRole('treeitem', { name: /utils\.js, file/i });
    expect(index).toHaveAttribute('aria-posinset', '1');
    expect(index).toHaveAttribute('aria-setsize', '2');
    expect(utils).toHaveAttribute('aria-posinset', '2');
    expect(utils).toHaveAttribute('aria-setsize', '2');
  });

  test('treeitem aria-selected does not track keyboard focus', async () => {
    render(<ProjectExplorer host="http://localhost:9000" projectRoot="/project" />);

    await waitFor(() => expect(screen.getAllByRole('treeitem')).toHaveLength(2));

    const file = screen.getByRole('treeitem', { name: /README\.md, file/i });
    fireEvent.focus(file);

    expect(file).not.toHaveAttribute('aria-selected');
  });

  test('file selection is exposed by the checkbox instead of treeitem selection', async () => {
    render(<ProjectExplorer host="http://localhost:9000" projectRoot="/project" />);

    await waitFor(() => expect(screen.getAllByRole('treeitem')).toHaveLength(2));

    const file = screen.getByRole('treeitem', { name: /README\.md, file/i });
    const checkbox = screen.getByRole('checkbox', { name: /select README\.md for the agent/i });

    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);

    expect(checkbox).toBeChecked();
    expect(file).not.toHaveAttribute('aria-selected');
  });

  test('preview traps keyboard focus inside the modal dialog', async () => {
    axios.get.mockResolvedValueOnce({
      data: { path: '.', entries: [
        { name: 'README.md', type: 'file' },
      ] },
    });
    axios.post.mockResolvedValueOnce({ data: { stdout: '' } });
    axios.get.mockResolvedValueOnce({
      data: { path: 'README.md', contents: '# Hello' },
    });

    render(<ProjectExplorer host="http://localhost:9000" projectRoot="/project" />);

    const file = await screen.findByRole('treeitem', { name: /README\.md, file/i });
    file.focus();
    fireEvent.keyDown(file, { key: 'Enter' });

    const closeButton = await screen.findByRole('button', { name: 'Close' });
    // Focus is set in a useEffect, so wait for it to be applied
    await waitFor(() => expect(closeButton).toHaveFocus());

    fireEvent.keyDown(document, { key: 'Tab' });

    // After Tab, focus should still be on closeButton (only focusable element in dialog)
    await waitFor(() => expect(closeButton).toHaveFocus());
  });

  test('Escape closes preview and restores focus to the file treeitem', async () => {
    render(<ProjectExplorer host="http://localhost:9000" projectRoot="/project" />);

    const file = await screen.findByRole('treeitem', { name: /README\.md, file/i });
    file.focus();
    fireEvent.keyDown(file, { key: 'Enter' });

    await screen.findByRole('button', { name: 'Close' });

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    // Allow the setTimeout in closePreview to execute and restore focus
    await waitFor(() => {
      expect(file).toHaveFocus();
    });
  });
});

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import axios from 'axios';
import ProjectExplorer from './components/ProjectExplorer';

expect.extend(toHaveNoViolations);

vi.mock('axios', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

import axiosInstance from 'axios';

const host = 'http://localhost:9000';

beforeEach(() => {
  axiosInstance.get.mockReset();
  axiosInstance.post.mockReset();
  axiosInstance.post.mockResolvedValue({ data: { stdout: '' } });
  try {
    localStorage.clear();
  } catch {
    // ignore
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ProjectExplorer accessibility', () => {
  test('has no automated accessibility violations', async () => {
    axiosInstance.get.mockResolvedValueOnce({
      data: { path: '.', entries: [
        { name: 'README.md', type: 'file' },
        { name: 'src', type: 'directory' },
      ] },
    });
    axiosInstance.post.mockResolvedValueOnce({ data: { stdout: '' } });

    const { container } = render(<ProjectExplorer host={host} />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
  test('renders an accessible tree with labelled panels', async () => {
    axiosInstance.get.mockResolvedValueOnce({
      data: { path: '.', entries: [
        { name: 'README.md', type: 'file' },
        { name: 'src', type: 'directory' },
      ] },
    });
    axiosInstance.post.mockResolvedValueOnce({ data: { stdout: '' } });

    render(<ProjectExplorer host={host} />);

    expect(await screen.findByRole('tree', { name: /project files and directories/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /project/i })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: /README\.md, file/i })).toBeInTheDocument();
    expect(screen.getByRole('treeitem', { name: /src, directory/i })).toBeInTheDocument();
  });

  test('tree items include git status in their accessible names', async () => {
    axiosInstance.get.mockResolvedValueOnce({
      data: { path: '.', entries: [
        { name: 'README.md', type: 'file' },
      ] },
    });
    axiosInstance.post.mockResolvedValueOnce({
      data: { stdout: ' M README.md\n' },
    });

    render(<ProjectExplorer host={host} />);

    await waitFor(() => {
      expect(screen.getByRole('treeitem', { name: /README\.md, file/i })).toHaveAccessibleName(/README\.md, file.*modified/i);
    });
  });

  test('checkboxes are labelled for file selection', async () => {
    axiosInstance.get.mockResolvedValueOnce({
      data: { path: '.', entries: [
        { name: 'app.ts', type: 'file' },
      ] },
    });
    axiosInstance.post.mockResolvedValueOnce({ data: { stdout: '' } });

    render(<ProjectExplorer host={host} />);

    expect(await screen.findByRole('checkbox', { name: /select app\.ts for the agent/i })).toBeInTheDocument();
  });

  test('filter input is labelled and linked to the tree', async () => {
    axiosInstance.get.mockResolvedValueOnce({
      data: { path: '.', entries: [] },
    });
    axiosInstance.post.mockResolvedValueOnce({ data: { stdout: '' } });

    render(<ProjectExplorer host={host} />);

    const filter = screen.getByLabelText(/filter files and folders/i);
    expect(filter).toHaveAttribute('id', 'project-filter-input');
    expect(filter).toHaveAttribute('aria-controls', 'project-tree-list');
  });

  test('Enter opens a file', async () => {
    axiosInstance.get.mockResolvedValueOnce({
      data: { path: '.', entries: [
        { name: 'README.md', type: 'file' },
      ] },
    });
    axiosInstance.post.mockResolvedValueOnce({ data: { stdout: '' } });
    axiosInstance.get.mockResolvedValueOnce({
      data: { path: 'README.md', contents: '# Hello' },
    });

    render(<ProjectExplorer host={host} />);

    const treeItem = await screen.findByRole('treeitem', { name: /README\.md, file/i });
    treeItem.focus();
    fireEvent.keyDown(treeItem, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: /file: README\.md/i })).toBeInTheDocument();
    });
  });

  test('Space toggles file selection without opening', async () => {
    axiosInstance.get.mockResolvedValueOnce({
      data: { path: '.', entries: [
        { name: 'README.md', type: 'file' },
      ] },
    });
    axiosInstance.post.mockResolvedValueOnce({ data: { stdout: '' } });

    render(<ProjectExplorer host={host} />);

    const treeItem = await screen.findByRole('treeitem', { name: /README\.md, file/i });
    treeItem.focus();
    fireEvent.keyDown(treeItem, { key: ' ' });

    await waitFor(() => {
      expect(screen.getByText(/selected for the agent/i)).toBeInTheDocument();
    });
  });

  test('Enter or Space expands a collapsed folder', async () => {
    axiosInstance.get.mockResolvedValueOnce({
      data: { path: '.', entries: [
        { name: 'src', type: 'directory' },
      ] },
    });
    axiosInstance.post.mockResolvedValueOnce({ data: { stdout: '' } });

    render(<ProjectExplorer host={host} />);

    const treeItem = await screen.findByRole('treeitem', { name: /src, directory/i });
    treeItem.focus();
    fireEvent.keyDown(treeItem, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByText(/src expanded/i)).toBeInTheDocument();
    });
  });

  test('ArrowRight expands a folder', async () => {
    axiosInstance.get.mockResolvedValueOnce({
      data: { path: '.', entries: [
        { name: 'src', type: 'directory' },
      ] },
    });
    axiosInstance.post.mockResolvedValueOnce({ data: { stdout: '' } });

    render(<ProjectExplorer host={host} />);

    const treeItem = await screen.findByRole('treeitem', { name: /src, directory/i });
    treeItem.focus();
    fireEvent.keyDown(treeItem, { key: 'ArrowRight' });

    await waitFor(() => {
      expect(screen.getByText(/src expanded/i)).toBeInTheDocument();
    });
  });

  test('ArrowLeft collapses an expanded folder', async () => {
    axiosInstance.get.mockResolvedValueOnce({
      data: { path: '.', entries: [
        { name: 'src', type: 'directory' },
      ] },
    });
    axiosInstance.post.mockResolvedValueOnce({ data: { stdout: '' } });

    render(<ProjectExplorer host={host} />);

    const treeItem = await screen.findByRole('treeitem', { name: /src, directory/i });
    treeItem.focus();
    fireEvent.keyDown(treeItem, { key: 'ArrowRight' });
    await waitFor(() => expect(screen.getByText(/src expanded/i)).toBeInTheDocument());

    fireEvent.keyDown(treeItem, { key: 'ArrowLeft' });
    await waitFor(() => {
      expect(screen.getByText(/src collapsed/i)).toBeInTheDocument();
    });
  });

  test('ArrowDown and ArrowUp move between tree items', async () => {
    axiosInstance.get.mockResolvedValueOnce({
      data: { path: '.', entries: [
        { name: 'README.md', type: 'file' },
        { name: 'src', type: 'directory' },
      ] },
    });
    axiosInstance.post.mockResolvedValueOnce({ data: { stdout: '' } });

    render(<ProjectExplorer host={host} />);

    const treeItems = await screen.findAllByRole('treeitem');
    treeItems[0].focus();
    fireEvent.keyDown(treeItems[0], { key: 'ArrowDown' });
    await waitFor(() => {
      expect(document.activeElement).toBe(treeItems[1]);
    });

    fireEvent.keyDown(treeItems[1], { key: 'ArrowUp' });
    await waitFor(() => {
      expect(document.activeElement).toBe(treeItems[0]);
    });
  });

  test('Home and End move to first and last tree items', async () => {
    axiosInstance.get.mockResolvedValueOnce({
      data: { path: '.', entries: [
        { name: 'README.md', type: 'file' },
        { name: 'src', type: 'directory' },
      ] },
    });
    axiosInstance.post.mockResolvedValueOnce({ data: { stdout: '' } });

    render(<ProjectExplorer host={host} />);

    const treeItems = await screen.findAllByRole('treeitem');
    treeItems[1].focus();
    fireEvent.keyDown(treeItems[1], { key: 'Home' });
    await waitFor(() => {
      expect(document.activeElement).toBe(treeItems[0]);
    });

    fireEvent.keyDown(treeItems[0], { key: 'End' });
    await waitFor(() => {
      expect(document.activeElement).toBe(treeItems[1]);
    });
  });

  test('status region announces tree actions', async () => {
    axiosInstance.get.mockResolvedValueOnce({
      data: { path: '.', entries: [
        { name: 'src', type: 'directory' },
      ] },
    });
    axiosInstance.post.mockResolvedValueOnce({ data: { stdout: '' } });

    render(<ProjectExplorer host={host} />);

    const treeItem = await screen.findByRole('treeitem', { name: /src, directory/i });
    treeItem.focus();
    fireEvent.keyDown(treeItem, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByText(/src expanded/i)).toBeInTheDocument();
    });
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent(/src expanded/i);
  });

  test('file preview dialog is accessible and closes with Escape', async () => {
    axiosInstance.get.mockResolvedValueOnce({
      data: { path: '.', entries: [
        { name: 'README.md', type: 'file' },
      ] },
    });
    axiosInstance.post.mockResolvedValueOnce({ data: { stdout: '' } });
    axiosInstance.get.mockResolvedValueOnce({
      data: { path: 'README.md', contents: '# Hello' },
    });

    render(<ProjectExplorer host={host} />);

    const treeItem = await screen.findByRole('treeitem', { name: /README\.md, file/i });
    treeItem.focus();
    fireEvent.keyDown(treeItem, { key: 'Enter' });

    const dialog = await screen.findByRole('dialog', { name: /file: README\.md/i });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby', 'project-file-preview-heading');

    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  test('use selected files button is disabled when nothing is selected', async () => {
    axiosInstance.get.mockResolvedValueOnce({
      data: { path: '.', entries: [
        { name: 'README.md', type: 'file' },
      ] },
    });
    axiosInstance.post.mockResolvedValueOnce({ data: { stdout: '' } });

    render(<ProjectExplorer host={host} />);

    await waitFor(() => {
      const button = screen.getByRole('button', { name: /use selected files/i });
      expect(button).toBeDisabled();
    });
  });

  test('sort column headers use aria-sort and announce the current/next sort state', async () => {
    axiosInstance.get.mockResolvedValueOnce({
      data: {
        path: '.',
        entries: [
          { name: 'b.txt', type: 'file' },
          { name: 'a.txt', type: 'file' },
        ],
      },
    });
    axiosInstance.post.mockResolvedValueOnce({ data: { stdout: '' } });

    render(<ProjectExplorer host={host} />);
    await screen.findByRole('treeitem', { name: /a\.txt, file/i });

    // The "Name" columnheader itself carries aria-sort so table-navigation
    // screen reading (e.g. JAWS) announces the sort state on arrival.
    const nameHeaderCell = screen.getByRole('columnheader', { name: 'Name' });
    expect(nameHeaderCell).toHaveAttribute('aria-sort', 'ascending');

    // "Type" isn't the active sort column, so it carries no aria-sort at all
    // (rather than an ambiguous "none") until it becomes active.
    const typeHeaderCell = screen.getByRole('columnheader', { name: 'Type' });
    expect(typeHeaderCell).not.toHaveAttribute('aria-sort');

    // The interactive control itself also carries the full state in its own
    // accessible name, for AT that reaches it via Tab rather than table
    // navigation.
    const nameButton = screen.getByRole('button', { name: /name, sorted ascending\. activate to sort descending\./i });
    expect(nameButton).toBeInTheDocument();

    fireEvent.click(nameButton);

    await waitFor(() => {
      expect(screen.getByRole('columnheader', { name: 'Name' })).toHaveAttribute('aria-sort', 'descending');
    });
    expect(screen.getByRole('button', { name: /name, sorted descending\. activate to sort ascending\./i })).toBeInTheDocument();

    const status = screen.getByRole('status');
    expect(status).toHaveTextContent(/sorted by name, descending/i);
  });

  test('sort header buttons are reachable and operable with the keyboard alone', async () => {
    axiosInstance.get.mockResolvedValueOnce({
      data: {
        path: '.',
        entries: [
          { name: 'b.txt', type: 'file' },
          { name: 'a.txt', type: 'file' },
        ],
      },
    });
    axiosInstance.post.mockResolvedValueOnce({ data: { stdout: '' } });

    render(<ProjectExplorer host={host} />);
    await screen.findByRole('treeitem', { name: /a\.txt, file/i });

    const typeButton = screen.getByRole('button', { name: /sort by type/i });
    typeButton.focus();
    expect(typeButton).toHaveFocus();
    fireEvent.click(typeButton);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /type, sorted ascending/i })).toBeInTheDocument();
    });
  });

  test('empty tree state is announced', async () => {
    axiosInstance.get.mockResolvedValueOnce({
      data: { path: '.', entries: [] },
    });
    axiosInstance.post.mockResolvedValueOnce({ data: { stdout: '' } });

    render(<ProjectExplorer host={host} />);

    await waitFor(() => {
      const status = screen.getByRole('status');
      expect(status).toHaveTextContent(/0 items/i);
    });
  });

  test('filtered matching descendants under collapsed folder show aria-expanded=true on parent', async () => {
    // Setup: src folder with index.js inside
    axiosInstance.get.mockResolvedValueOnce({
      data: { path: '.', entries: [{ name: 'src', type: 'directory' }] },
    });
    axiosInstance.post.mockResolvedValueOnce({ data: { stdout: '' } });

    // When src is expanded, it returns index.js
    axiosInstance.get.mockResolvedValueOnce({
      data: { path: 'src', entries: [{ name: 'index.js', type: 'file' }] },
    });

    render(<ProjectExplorer host={host} />);

    // Initially src is collapsed (aria-expanded is empty string for false in jsdom)
    const srcItem = await screen.findByRole('treeitem', { name: /src, directory/i });
    // In jsdom, aria-expanded={false} renders as empty string, not "false"
    expect(srcItem).toHaveAttribute('aria-expanded', '');

    // First expand src to load its children
    fireEvent.keyDown(srcItem, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByText(/src expanded/i)).toBeInTheDocument();
    });
    expect(srcItem).toHaveAttribute('aria-expanded', 'true');

    // Then collapse it again
    fireEvent.keyDown(srcItem, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByText(/src collapsed/i)).toBeInTheDocument();
    });
    expect(srcItem).toHaveAttribute('aria-expanded', '');

    // Now apply filter for index.js - the matching child should be visible
    // and src should show aria-expanded="true" because its matching descendant is visible
    const filter = screen.getByLabelText(/filter files and folders/i);
    fireEvent.change(filter, { target: { value: 'index.js' } });

    // Wait for filter to apply and tree to update
    await waitFor(() => {
      expect(screen.getByRole('treeitem', { name: /index\.js, file/i })).toBeInTheDocument();
    });

    // The src folder should now show aria-expanded="true" because its matching
    // descendant is visible (even though user didn't explicitly expand it)
    expect(srcItem).toHaveAttribute('aria-expanded', 'true');
  });

  test('activePath moves to first visible item when filtered item is removed and tree has focus', async () => {
    axiosInstance.get.mockResolvedValueOnce({
      data: { path: '.', entries: [
        { name: 'a.txt', type: 'file' },
        { name: 'b.txt', type: 'file' },
      ] },
    });
    axiosInstance.post.mockResolvedValueOnce({ data: { stdout: '' } });

    render(<ProjectExplorer host={host} />);

    const aItem = await screen.findByRole('treeitem', { name: /a\.txt, file/i });
    const bItem = screen.getByRole('treeitem', { name: /b\.txt, file/i });

    // Focus a.txt
    aItem.focus();
    expect(aItem).toHaveFocus();

    // Filter to only show b.txt - a.txt should no longer be visible
    const filter = screen.getByLabelText(/filter files and folders/i);
    fireEvent.change(filter, { target: { value: 'b.txt' } });

    // Wait for filter to apply
    await waitFor(() => {
      expect(screen.queryByRole('treeitem', { name: /a\.txt, file/i })).not.toBeInTheDocument();
    });

    // Focus should move to b.txt (first visible item) since tree had focus
    await waitFor(() => {
      expect(bItem).toHaveFocus();
    });
  });

  test('activePath clears when filter removes all items and tree has focus', async () => {
    axiosInstance.get.mockResolvedValueOnce({
      data: { path: '.', entries: [
        { name: 'a.txt', type: 'file' },
      ] },
    });
    axiosInstance.post.mockResolvedValueOnce({ data: { stdout: '' } });

    render(<ProjectExplorer host={host} />);

    const aItem = await screen.findByRole('treeitem', { name: /a\.txt, file/i });
    aItem.focus();
    expect(aItem).toHaveFocus();

    // Filter to match nothing
    const filter = screen.getByLabelText(/filter files and folders/i);
    fireEvent.change(filter, { target: { value: 'nonexistent' } });

    // Wait for filter to apply - tree should be empty
    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/No entries match "nonexistent"/i);
    });

    // activePath should be cleared (no focused item in tree)
    const tree = screen.getByRole('tree');
    expect(tree).not.toHaveFocus();
  });

  test('activePath does not move when filter input has focus', async () => {
    axiosInstance.get.mockResolvedValueOnce({
      data: { path: '.', entries: [
        { name: 'a.txt', type: 'file' },
        { name: 'b.txt', type: 'file' },
      ] },
    });
    axiosInstance.post.mockResolvedValueOnce({ data: { stdout: '' } });

    render(<ProjectExplorer host={host} />);

    const aItem = await screen.findByRole('treeitem', { name: /a\.txt, file/i });
    const bItem = screen.getByRole('treeitem', { name: /b\.txt, file/i });

    // Focus a.txt
    aItem.focus();
    expect(aItem).toHaveFocus();

    // Focus the filter input
    const filter = screen.getByLabelText(/filter files and folders/i);
    filter.focus();
    expect(filter).toHaveFocus();

    // Filter to only show b.txt
    fireEvent.change(filter, { target: { value: 'b.txt' } });

    // Wait for filter to apply
    await waitFor(() => {
      expect(screen.queryByRole('treeitem', { name: /a\.txt, file/i })).not.toBeInTheDocument();
    });

    // Focus should remain on the filter input, not move to b.txt
    await waitFor(() => {
      expect(filter).toHaveFocus();
    });
    expect(bItem).not.toHaveFocus();
  });

  test('activePath does not move focus when tree lost focus before filter change', async () => {
    axiosInstance.get.mockResolvedValueOnce({
      data: { path: '.', entries: [
        { name: 'a.txt', type: 'file' },
        { name: 'b.txt', type: 'file' },
      ] },
    });
    axiosInstance.post.mockResolvedValueOnce({ data: { stdout: '' } });

    render(<ProjectExplorer host={host} />);

    const aItem = await screen.findByRole('treeitem', { name: /a\.txt, file/i });
    const bItem = screen.getByRole('treeitem', { name: /b\.txt, file/i });

    // Focus a.txt (tree has focus)
    aItem.focus();
    expect(aItem).toHaveFocus();

    // Move focus to a sort button (outside the tree)
    const sortButton = screen.getByRole('button', { name: /name, sorted ascending. activate to sort descending/i });
    sortButton.focus();
    expect(sortButton).toHaveFocus();

    // Now filter to only show b.txt
    const filter = screen.getByLabelText(/filter files and folders/i);
    fireEvent.change(filter, { target: { value: 'b.txt' } });

    // Wait for filter to apply
    await waitFor(() => {
      expect(screen.queryByRole('treeitem', { name: /a\.txt, file/i })).not.toBeInTheDocument();
    });

    // Focus should stay on the sort button, not move to b.txt
    await waitFor(() => {
      expect(sortButton).toHaveFocus();
    });
    expect(bItem).not.toHaveFocus();
  });

  test('activePath updates to visible item when filter input has focus, but DOM focus stays on filter', async () => {
    axiosInstance.get.mockResolvedValueOnce({
      data: { path: '.', entries: [
        { name: 'a.txt', type: 'file' },
        { name: 'b.txt', type: 'file' },
      ] },
    });
    axiosInstance.post.mockResolvedValueOnce({ data: { stdout: '' } });

    render(<ProjectExplorer host={host} />);

    const aItem = await screen.findByRole('treeitem', { name: /a\.txt, file/i });
    const bItem = screen.getByRole('treeitem', { name: /b\.txt, file/i });

    // Focus a.txt
    aItem.focus();
    expect(aItem).toHaveFocus();

    // Move focus to the filter input
    const filter = screen.getByLabelText(/filter files and folders/i);
    filter.focus();
    expect(filter).toHaveFocus();

    // Filter to only show b.txt (a.txt will be hidden)
    fireEvent.change(filter, { target: { value: 'b.txt' } });

    // Wait for filter to apply and a.txt to be removed from DOM
    await waitFor(() => {
      expect(screen.queryByRole('treeitem', { name: /a\.txt, file/i })).not.toBeInTheDocument();
    });

    // Focus should remain on the filter input
    await waitFor(() => {
      expect(filter).toHaveFocus();
    });

    // b.txt should be the new activePath (tabIndex="0") but NOT have DOM focus
    expect(bItem).not.toHaveFocus();
    expect(bItem).toHaveAttribute('tabIndex', '0');

    // a.txt should no longer be in the document
    expect(screen.queryByRole('treeitem', { name: /a\.txt, file/i })).not.toBeInTheDocument();
  });
});

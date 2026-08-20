import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import axios from 'axios';
import ProjectExplorer from './components/ProjectExplorer';

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
    sessionStorage.clear();
  } catch {
    // ignore
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ProjectExplorer accessibility', () => {
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
      expect(screen.getByRole('treeitem', { name: /README\.md, file/i })).toBeInTheDocument();
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
});

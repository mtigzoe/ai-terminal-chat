import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { handleEditorOpen } from './editor-handler.cjs';

function createChild() {
  const child = new EventEmitter();
  child.unref = vi.fn();
  return child;
}

describe('editor handler', () => {
  it('reports success after the editor process emits spawn', async () => {
    const child = createChild();
    const spawn = vi.fn(() => child);
    const openPath = vi.fn();

    const resultPromise = handleEditorOpen({ spawn, openPath }, '/project/file.txt', 'code');
    child.emit('spawn');

    await expect(resultPromise).resolves.toBe(true);
    expect(spawn).toHaveBeenCalledOnce();
    expect(child.unref).toHaveBeenCalledOnce();
    expect(openPath).not.toHaveBeenCalled();
  });

  it('falls back to the system opener when the editor emits an error', async () => {
    const child = createChild();
    const spawn = vi.fn(() => child);
    const openPath = vi.fn().mockResolvedValue('');

    const resultPromise = handleEditorOpen({ spawn, openPath }, '/project/file.txt', 'code');
    child.emit('error', new Error('ENOENT'));

    await expect(resultPromise).resolves.toBe(false);
    expect(openPath).toHaveBeenCalledWith('/project/file.txt');
    expect(child.unref).not.toHaveBeenCalled();
  });

  it('falls back when spawn throws synchronously', async () => {
    const spawn = vi.fn(() => {
      throw new Error('spawn failed');
    });
    const openPath = vi.fn().mockResolvedValue('');

    await expect(
      handleEditorOpen({ spawn, openPath }, '/project/file.txt', 'code'),
    ).resolves.toBe(false);
    expect(openPath).toHaveBeenCalledWith('/project/file.txt');
  });
});

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleEditorOpen, buildEditorSpawn, KNOWN_EDITORS } from './editor-handler.cjs';
import { validateProjectPath } from './security-utils.cjs';

function createChild() {
  const child = new EventEmitter();
  child.unref = vi.fn();
  return child;
}

describe('editor handler', () => {
  it('reports native editor success after the process emits spawn', async () => {
    const child = createChild();
    const spawn = vi.fn(() => child);
    const openPath = vi.fn();

    const resultPromise = handleEditorOpen({ spawn, openPath }, '/project/file.txt', 'sublime');
    child.emit('spawn');

    await expect(resultPromise).resolves.toBe(true);
    expect(spawn).toHaveBeenCalledOnce();
    expect(child.unref).toHaveBeenCalledOnce();
    expect(openPath).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledWith('subl', ['/project/file.txt'], { detached: true, stdio: 'ignore' });
  });

  it('falls back to the system opener when the editor emits an error', async () => {
    const child = createChild();
    const spawn = vi.fn(() => child);
    const openPath = vi.fn().mockResolvedValue('');

    const resultPromise = handleEditorOpen({ spawn, openPath }, '/project/file.txt', 'code');
    child.emit('error', new Error('ENOENT'));

    // The fallback did open the file, so the call succeeded. The old code
    // returned false here, which told the caller a working open had failed.
    await expect(resultPromise).resolves.toBe(true);
    expect(openPath).toHaveBeenCalledWith('/project/file.txt');
  });

  it('falls back when spawn throws synchronously', async () => {
    const spawn = vi.fn(() => {
      throw new Error('spawn failed');
    });
    const openPath = vi.fn().mockResolvedValue('');

    await expect(
      handleEditorOpen({ spawn, openPath }, '/project/file.txt', 'code'),
    ).resolves.toBe(true);
    expect(openPath).toHaveBeenCalledWith('/project/file.txt');
  });

  it('does not report success for an unknown editor id', async () => {
    const spawn = vi.fn();
    const openPath = vi.fn();
    await expect(
      handleEditorOpen({ spawn, openPath }, '/project/file.txt', 'emacs'),
    ).resolves.toBe(false);
    expect(spawn).not.toHaveBeenCalled();
    expect(openPath).not.toHaveBeenCalled();
  });
});

// Regression: since Node 18.20.2 / 20.12.2 / 22.0.0 (CVE-2024-27980),
// spawn() of a .bat/.cmd without a shell throws EINVAL on Windows. The editor
// entry points are .cmd shims, so "Open in VS Code" always fell through to the
// system opener. scripts/prepare-server.cjs already routes npm.cmd through
// cmd.exe for exactly this reason; this is the same workaround.
describe('editor handler: Windows .cmd shims', () => {
  const isWin = process.platform === 'win32';

  it('routes a safe .cmd editor invocation through cmd.exe on Windows', () => {
    if (!isWin) return;
    const { command, args } = buildEditorSpawn('code.cmd', 'C:\\proj\\a b.txt');
    expect(command).toBe(process.env.ComSpec || 'cmd.exe');
    expect(args).toEqual(['/d', '/s', '/v:off', '/c', 'code.cmd "C:\\proj\\a b.txt"']);
  });

  it.each([
    'C:\\proj\\a&whoami.txt',
    'C:\\proj\\a|whoami.txt',
    'C:\\proj\\a^whoami.txt',
    'C:\\proj\\a%PATH%.txt',
    'C:\\proj\\a!PATH!.txt',
    'C:\\proj\\a>out.txt',
    'C:\\proj\\a<in.txt',
    'C:\\proj\\a"quoted.txt',
    'C:\\proj\\a\rfile.txt',
    'C:\\proj\\a\nfile.txt',
  ])('refuses cmd metacharacters before they reach cmd.exe: %s', (filePath) => {
    if (!isWin) return;
    expect(() => buildEditorSpawn('code.cmd', filePath)).toThrow(/unsafe for cmd\.exe/i);
  });

  it('falls back to the system opener for a metacharacter path instead of spawning cmd.exe', async () => {
    if (!isWin) return;
    const spawn = vi.fn();
    const openPath = vi.fn().mockResolvedValue('');
    await expect(
      handleEditorOpen({ spawn, openPath }, 'C:\\proj\\a&whoami.txt', 'code'),
    ).resolves.toBe(true);
    expect(spawn).not.toHaveBeenCalled();
    expect(openPath).toHaveBeenCalledWith('C:\\proj\\a&whoami.txt');
  });

  it('does not use shell:true', () => {
    if (!isWin) return;
    const child = createChild();
    const spawn = vi.fn(() => child);
    const promise = handleEditorOpen({ spawn, openPath: vi.fn() }, 'C:\\proj\\a.txt', 'code');
    child.emit('spawn');
    child.emit('exit', 0, null);
    return promise.then(() => {
      const opts = spawn.mock.calls[0][2];
      expect(opts).toBeDefined();
      expect(opts.shell).toBeFalsy();
      expect(opts.windowsVerbatimArguments).toBe(true);
      expect(opts.windowsHide).toBe(true);
    });
  });

  it('every Windows .cmd editor is launched through cmd.exe', () => {
    if (!isWin) return;
    for (const editor of KNOWN_EDITORS.filter((e) => e.bin.endsWith('.cmd'))) {
      const { command } = buildEditorSpawn(editor.bin, 'C:\\proj\\a.txt');
      expect(command).toBe(process.env.ComSpec || 'cmd.exe');
    }
  });

  it.each(['code.cmd', 'code.CMD', 'editor.bat', 'editor.BAT'])('recognizes the %s shim suffix', (editorBin) => {
    if (!isWin) return;
    const result = buildEditorSpawn(editorBin, 'C:\\normal\\readme notes.txt');
    expect(result.isCmdShim).toBe(true);
    expect(result.command).toBe(process.env.ComSpec || 'cmd.exe');
    expect(result.args).toEqual(['/d', '/s', '/v:off', '/c', editorBin + ' "C:\\normal\\readme notes.txt"']);
  });

  it('waits for the editor shim to succeed rather than just CMD spawning', async () => {
    if (!isWin) return;
    const child = createChild();
    const openPath = vi.fn();
    let settled = false;
    const promise = handleEditorOpen({ spawn: () => child, openPath }, 'C:\\normal\\readme.txt', 'code');
    promise.then(() => { settled = true; });
    child.emit('spawn');
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(child.unref).not.toHaveBeenCalled();
    child.emit('exit', 0, null);
    await expect(promise).resolves.toBe(true);
    expect(child.unref).toHaveBeenCalledOnce();
    expect(openPath).not.toHaveBeenCalled();
  });

  it.each([[1, null], [null, 'SIGTERM']])('falls back when the shim exits with code %s and signal %s', async (code, signal) => {
    if (!isWin) return;
    const child = createChild();
    const openPath = vi.fn().mockResolvedValue('');
    const promise = handleEditorOpen({ spawn: () => child, openPath }, 'C:\\normal\\readme.txt', 'code');
    child.emit('spawn');
    expect(openPath).not.toHaveBeenCalled();
    child.emit('exit', code, signal);
    await expect(promise).resolves.toBe(true);
    expect(openPath).toHaveBeenCalledExactlyOnceWith('C:\\normal\\readme.txt');
    expect(child.unref).not.toHaveBeenCalled();
  });

  it('reports success when the fallback actually opened the file', async () => {
    const spawn = vi.fn(() => {
      throw new Error('spawn EINVAL');
    });
    const openPath = vi.fn().mockResolvedValue('');

    await expect(
      handleEditorOpen({ spawn, openPath }, '/project/file.txt', 'code'),
    ).resolves.toBe(true);
    expect(openPath).toHaveBeenCalledWith('/project/file.txt');
  });
});

describe('validateProjectPath: in-project names beginning with two dots', () => {
  let root;
  let outsideRoot;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'vpp-root-'));
    outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vpp-outside-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
  });

  const mk = (...segments) => {
    const p = path.join(root, ...segments);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'x');
    return p;
  };

  // Regression: the containment test was `relative.startsWith('..')`, which
  // also matches a legitimate in-project entry named '..data'. Such files were
  // rejected as "outside project root", silently breaking Open-in-editor and
  // Reveal-in-explorer for those entries.
  it.each([
    ['..data', 'notes.txt'],
    ['..config', 'a.txt'],
    ['..cache', 'b.txt'],
  ])('accepts an in-project file under %s', (dir, file) => {
    const p = mk(dir, file);
    expect(() => validateProjectPath(p, root)).not.toThrow();
  });

  it('accepts a nested in-project directory starting with two dots', () => {
    const p = mk('src', '..cfg', 'c.txt');
    expect(() => validateProjectPath(p, root)).not.toThrow();
  });

  it('still rejects a path outside the root', () => {
    const outside = path.join(outsideRoot, 'secret.txt');
    fs.writeFileSync(outside, 'x');
    expect(() => validateProjectPath(outside, root)).toThrow(/outside project root/);
  });

  it('still rejects parent traversal', () => {
    const escape = path.join(root, '..', 'escape.txt');
    fs.writeFileSync(escape, 'x');
    expect(() => validateProjectPath(escape, root)).toThrow(/outside project root/);
  });

  it('still rejects a sibling directory that shares a name prefix', () => {
    const sibling = `${root}-sibling`;
    fs.mkdirSync(sibling, { recursive: true });
    const p = path.join(sibling, 'secret.txt');
    fs.writeFileSync(p, 'x');
    try {
      expect(() => validateProjectPath(p, root)).toThrow(/outside project root/);
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });

  it('still throws when no project root is configured', () => {
    const p = mk('a.txt');
    expect(() => validateProjectPath(p, null)).toThrow(/No project root configured/);
  });
});

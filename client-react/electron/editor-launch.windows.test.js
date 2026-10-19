import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleEditorOpen } from './editor-handler.cjs';

// Use real CMD with an isolated PATH, never an installed editor or OS opener.
describe.runIf(process.platform === 'win32')('Windows editor shim integration', () => {
  let directory;

  afterEach(() => {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  function prepare(shim) {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'editor launch '));
    const capture = path.join(directory, 'capture.cjs');
    fs.writeFileSync(capture, 'require("node:fs").writeFileSync(__dirname + "/argv.json", JSON.stringify(process.argv.slice(2)));');
    if (shim !== undefined) fs.writeFileSync(path.join(directory, 'code.cmd'), shim(capture));
    const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') || 'PATH';
    const env = { ...process.env, [pathKey]: directory };
    let errors = '';
    let finished;
    const launch = vi.fn((command, args, options) => {
      const child = spawn(command, args, { ...options, cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.resume();
      // Drain stderr so an unexpected failure cannot block the child process.
      child.stderr.on('data', (chunk) => { errors += chunk.toString(); });
      finished = once(child, 'close');
      return child;
    });
    return { launch, errors: () => errors, finished: () => finished };
  }

  it.each(['filename with spaces, Unicode and parentheses', 'drive root'])('passes a %s to a real .cmd shim unchanged', async (kind) => {
    const execution = prepare((capture) => '@echo off\r\n"' + process.execPath + '" "' + capture + '" %*\r\n');
    const filePath = kind === 'drive root' ? path.parse(directory).root : path.join(directory, 'normal readme résumé (draft).txt');
    if (kind !== 'drive root') fs.writeFileSync(filePath, 'fixture');
    const openPath = vi.fn();
    await expect(handleEditorOpen({ spawn: execution.launch, openPath }, filePath, 'code')).resolves.toBe(true);
    await execution.finished();
    expect(openPath).not.toHaveBeenCalled();
    expect(execution.errors()).toBe('');
    expect(JSON.parse(fs.readFileSync(path.join(directory, 'argv.json'), 'utf8'))).toEqual([filePath]);
  });

  it.each(['missing', 'failed'])('uses the OS fallback for a %s shim after CMD exits', async (kind) => {
    const execution = prepare(kind === 'failed' ? () => '@exit /b 1\r\n' : undefined);
    const filePath = path.join(directory, 'normal readme.txt');
    const openPath = vi.fn().mockResolvedValue('');
    await expect(handleEditorOpen({ spawn: execution.launch, openPath }, filePath, 'code')).resolves.toBe(true);
    const [code] = await execution.finished();
    expect(code).not.toBe(0);
    expect(execution.launch).toHaveBeenCalledOnce();
    expect(openPath).toHaveBeenCalledExactlyOnceWith(filePath);
  });
});

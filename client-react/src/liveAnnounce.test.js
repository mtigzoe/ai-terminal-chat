import { describe, expect, it } from 'vitest';
import { announce, summarizeTerminalResult } from './liveAnnounce.js';

describe('announce', () => {
  it('sets aria-live and text on a region element', async () => {
    const region = document.createElement('div');
    announce(region, 'Hello world');
    // announce uses setTimeout(40ms) to clear then set text.
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.getAttribute('aria-atomic')).toBe('true');
    expect(region.getAttribute('role')).toBe('status');
    expect(region.textContent).toBe('Hello world');
  });

  it('uses assertive live region when requested', async () => {
    const region = document.createElement('div');
    announce(region, 'Error!', { assertive: true });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(region.getAttribute('aria-live')).toBe('assertive');
    expect(region.textContent).toBe('Error!');
  });

  it('ignores null region', () => {
    expect(() => announce(null, 'msg')).not.toThrow();
  });

  it('ignores non-string messages', () => {
    const region = document.createElement('div');
    expect(() => announce(region, 123)).not.toThrow();
    expect(region.textContent).toBe('');
  });

  it('ignores empty or whitespace-only strings', () => {
    const region = document.createElement('div');
    announce(region, '   ');
    expect(region.textContent).toBe('');
  });

  it('clears first so identical consecutive messages re-announce', async () => {
    const region = document.createElement('div');
    region.textContent = 'Hello';
    announce(region, 'Hello');
    expect(region.textContent).toBe('');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(region.textContent).toBe('Hello');
  });
});

describe('summarizeTerminalResult', () => {
  it('summarizes a successful command with stdout', () => {
    const result = summarizeTerminalResult({
      command: 'pwd',
      stdout: '/tmp/project\n',
      stderr: '',
      exitCode: 0,
    });
    expect(result).toBe('Command pwd finished with exit code 0. 1 line of standard output.');
  });

  it('summarizes a successful command with stderr', () => {
    const result = summarizeTerminalResult({
      command: 'ls',
      stdout: '',
      stderr: 'warning: something\n',
      exitCode: 0,
    });
    expect(result).toBe('Command ls finished with exit code 0. 1 line of standard error.');
  });

  it('summarizes a command with both stdout and stderr', () => {
    const result = summarizeTerminalResult({
      command: 'python script.py',
      stdout: 'result\nmore\n',
      stderr: 'warn\n',
      exitCode: 0,
    });
    expect(result).toBe(
      'Command python script.py finished with exit code 0. 2 lines of standard output. 1 line of standard error.'
    );
  });

  it('summarizes a command with no output', () => {
    const result = summarizeTerminalResult({
      command: 'touch file',
      stdout: '',
      stderr: '',
      exitCode: 0,
    });
    expect(result).toBe('Command touch file finished with exit code 0. No output.');
  });

  it('uses singular "line" for exactly one output line', () => {
    const result = summarizeTerminalResult({
      command: 'echo hi',
      stdout: 'hi\n',
      stderr: '',
      exitCode: 0,
    });
    expect(result).toBe('Command echo hi finished with exit code 0. 1 line of standard output.');
    expect(result).toContain('1 line of standard output');
    expect(result).not.toContain('lines of standard output');
  });

  it('uses plural "lines" for multiple output lines', () => {
    const result = summarizeTerminalResult({
      command: 'cat file',
      stdout: 'line1\nline2\nline3\n',
      stderr: '',
      exitCode: 0,
    });
    expect(result).toBe(
      'Command cat file finished with exit code 0. 3 lines of standard output.'
    );
    expect(result).toContain('3 lines of standard output');
  });

  it('reports failed command when exitCode is null', () => {
    const result = summarizeTerminalResult({
      command: 'badcmd',
      stdout: '',
      stderr: 'command not found\n',
      exitCode: null,
    });
    expect(result).toBe('Command badcmd finished with failed. 1 line of standard error.');
    expect(result).toContain('finished with failed');
  });

  it('does not count empty lines', () => {
    const result = summarizeTerminalResult({
      command: 'cat file',
      stdout: 'line1\n\n\nline2\n',
      stderr: '',
      exitCode: 0,
    });
    expect(result).toBe(
      'Command cat file finished with exit code 0. 2 lines of standard output.'
    );
  });

  it('produces a concise summary for long stdout/stderr', () => {
    const longLine = 'a'.repeat(5000);
    const result = summarizeTerminalResult({
      command: 'cat huge',
      stdout: `${longLine}\n${longLine}\n`,
      stderr: `${longLine}\n`,
      exitCode: 0,
    });
    // Should only mention line counts, not embed raw output.
    expect(result).toBe(
      'Command cat huge finished with exit code 0. 2 lines of standard output. 1 line of standard error.'
    );
    expect(result).not.toContain('aaaaa');
  });
});

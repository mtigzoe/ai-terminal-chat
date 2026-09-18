import { describe, expect, it } from 'vitest';
import { isAllowedNavigationUrl, isAuthorizedProjectRoot } from './security-utils.cjs';

describe('Electron navigation boundary', () => {
  it('allows the configured development renderer origin', () => {
    const entry = { type: 'url', target: 'http://localhost:3000' };
    expect(isAllowedNavigationUrl('http://localhost:3000/', entry)).toBe(true);
    expect(isAllowedNavigationUrl('http://localhost:3000/chat', entry)).toBe(true);
  });

  it('rejects other origins and unsafe schemes', () => {
    const entry = { type: 'url', target: 'http://localhost:3000' };
    expect(isAllowedNavigationUrl('http://127.0.0.1:3000/', entry)).toBe(false);
    expect(isAllowedNavigationUrl('https://example.com/', entry)).toBe(false);
    expect(isAllowedNavigationUrl('javascript:alert(1)', entry)).toBe(false);
    expect(isAllowedNavigationUrl('data:text/html,test', entry)).toBe(false);
  });

  it('allows only the packaged renderer file', () => {
    // The packaged renderer lives at a POSIX path in the Linux packaging
    // and at a drive-letter path on Windows; a drive-letter-less file://
    // URL is not a valid absolute Windows path (fileURLToPath rejects
    // it), so use the platform's real packaged path to exercise the
    // same allow/deny comparison.
    const isWin = process.platform === 'win32';
    const target = isWin
      ? 'C:\\app\\client-react\\dist\\index.html'
      : '/app/client-react/dist/index.html';
    const indexUrl = isWin
      ? 'file:///C:/app/client-react/dist/index.html'
      : 'file:///app/client-react/dist/index.html';
    const otherUrl = isWin
      ? 'file:///C:/app/client-react/dist/other.html'
      : 'file:///app/client-react/dist/other.html';
    const entry = { type: 'file', target };
    expect(isAllowedNavigationUrl(indexUrl, entry)).toBe(true);
    expect(isAllowedNavigationUrl(otherUrl, entry)).toBe(false);
    expect(isAllowedNavigationUrl('https://example.com/', entry)).toBe(false);
  });
});


describe('Electron project root authorization', () => {
  it('accepts only roots previously approved by the native picker', () => {
    const root = process.cwd();
    const approved = new Set([root]);
    expect(isAuthorizedProjectRoot(root, approved)).toBe(true);
    expect(isAuthorizedProjectRoot(require('node:path').dirname(root), approved)).toBe(false);
  });

  it('rejects missing or malformed roots', () => {
    expect(isAuthorizedProjectRoot('', new Set())).toBe(false);
    expect(isAuthorizedProjectRoot('/path/that/does/not/exist', new Set())).toBe(false);
  });
});

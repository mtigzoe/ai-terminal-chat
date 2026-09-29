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

  it('allows the packaged multi-page renderer set, and nothing outside it', () => {
    // The packaged renderer lives at a POSIX path in the Linux packaging
    // and at a drive-letter path on Windows; a drive-letter-less file://
    // URL is not a valid absolute Windows path (fileURLToPath rejects
    // it), so use the platform's real packaged path to exercise the
    // same allow/deny comparison.
    const isWin = process.platform === 'win32';
    const dist = isWin ? 'C:\\app\\client-react\\dist' : '/app/client-react/dist';
    const target = isWin ? `${dist}\\\\index.html` : `${dist}/index.html`;
    const fileUrl = (name) => (isWin
      ? `file:///C:/app/client-react/dist/${name}`
      : `file:///app/client-react/dist/${name}`);
    const entry = { type: 'file', target };

    // Regression: navigation required an exact match on the entry document,
    // so every sibling page the main nav links to (History, Project, Settings,
    // Instructions) was blocked. The app worked over the dev server
    // (same-origin) and silently did nothing in the packaged desktop app.
    for (const page of ['index.html', 'history.html', 'project.html', 'settings.html', 'instructions.html']) {
      expect(isAllowedNavigationUrl(fileUrl(page), entry)).toBe(true);
    }

    // The entry document itself is still allowed, and other origins and
    // unsafe schemes are still rejected.
    expect(isAllowedNavigationUrl('https://example.com/', entry)).toBe(false);
    expect(isAllowedNavigationUrl('javascript:alert(1)', entry)).toBe(false);
    expect(isAllowedNavigationUrl(fileUrl('other.html'), entry)).toBe(false);
  });

  it('blocks navigation that leaves the renderer directory', () => {
    const isWin = process.platform === 'win32';
    const target = isWin ? 'C:\\app\\client-react\\dist\\index.html' : '/app/client-react/dist/index.html';
    const entry = { type: 'file', target };

    // Same extension, different directory: must not inherit the preload bridge.
    const escapeUrl = isWin
      ? 'file:///C:/app/client-react/secrets.html'
      : 'file:///app/client-react/secrets.html';
    expect(isAllowedNavigationUrl(escapeUrl, entry)).toBe(false);

    // Traversal out of the renderer directory must not resolve back in.
    const traversalUrl = isWin
      ? 'file:///C:/app/client-react/dist/../secrets.html'
      : 'file:///app/client-react/dist/../secrets.html';
    expect(isAllowedNavigationUrl(traversalUrl, entry)).toBe(false);
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

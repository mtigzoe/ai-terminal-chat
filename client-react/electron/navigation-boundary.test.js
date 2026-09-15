import { describe, expect, it } from 'vitest';
import { isAllowedNavigationUrl } from './security-utils.cjs';

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
    const entry = { type: 'file', target: '/app/client-react/dist/index.html' };
    expect(isAllowedNavigationUrl('file:///app/client-react/dist/index.html', entry)).toBe(true);
    expect(isAllowedNavigationUrl('file:///app/client-react/dist/other.html', entry)).toBe(false);
    expect(isAllowedNavigationUrl('https://example.com/', entry)).toBe(false);
  });
});

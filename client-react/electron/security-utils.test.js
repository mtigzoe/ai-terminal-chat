import { describe, expect, it } from 'vitest';
import { isAllowedNavigationUrl } from './security-utils.cjs';

describe('isAllowedNavigationUrl', () => {
  it('allows the configured development renderer origin', () => {
    const entry = { type: 'url', target: 'http://localhost:3000' };

    expect(isAllowedNavigationUrl('http://localhost:3000/', entry)).toBe(true);
    expect(isAllowedNavigationUrl('http://localhost:3000/chat', entry)).toBe(true);
  });

  it('rejects navigation to another origin in development', () => {
    const entry = { type: 'url', target: 'http://localhost:3000' };

    expect(isAllowedNavigationUrl('http://127.0.0.1:3000/', entry)).toBe(false);
    expect(isAllowedNavigationUrl('https://localhost:3000/', entry)).toBe(false);
    expect(isAllowedNavigationUrl('https://example.com/', entry)).toBe(false);
  });

  it('allows only the exact packaged renderer file', () => {
    const entry = {
      type: 'file',
      target: '/app/client-react/dist/index.html',
    };

    expect(
      isAllowedNavigationUrl('file:///app/client-react/dist/index.html', entry),
    ).toBe(true);
    expect(
      isAllowedNavigationUrl('file:///app/client-react/dist/other.html', entry),
    ).toBe(false);
    expect(isAllowedNavigationUrl('https://example.com/', entry)).toBe(false);
  });

  it('fails closed for malformed or unsupported navigation input', () => {
    expect(isAllowedNavigationUrl('', { type: 'url', target: 'http://localhost:3000' })).toBe(false);
    expect(isAllowedNavigationUrl('javascript:alert(1)', { type: 'url', target: 'http://localhost:3000' })).toBe(false);
    expect(isAllowedNavigationUrl('data:text/html,<script>alert(1)</script>', { type: 'url', target: 'http://localhost:3000' })).toBe(false);
    expect(isAllowedNavigationUrl('https://example.com/', null)).toBe(false);
  });
});

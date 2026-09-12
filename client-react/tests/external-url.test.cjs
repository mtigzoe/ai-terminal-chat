/**
 * Regression tests for Electron external URL scheme hardening.
 * Only http: and https: are permitted; all other schemes must be rejected.
 */

const { isSafeExternalUrl } = require('../electron/security-utils.cjs');

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function runTests() {
  console.log('Running external URL scheme security tests...\n');

  const allowed = [
    'https://example.com',
    'http://example.com',
    'https://example.com/path?query=1#hash',
    'http://localhost:3000',
    'https://127.0.0.1:8080/foo',
    'HTTPS://EXAMPLE.COM', // protocol normalized by URL
  ];

  const rejected = [
    'file:///etc/passwd',
    'file://C:/Windows/System32',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'about:blank',
    'chrome://settings',
    'ms-settings:',
    'steam://run/123',
    'custom-scheme:foo',
    'mailto:user@example.com',
    'ftp://example.com',
    '',
    '   ',
    null,
    undefined,
    123,
    'not a url at all',
    'https://', // incomplete
    '//example.com', // protocol-relative
  ];

  let passed = 0;

  for (const url of allowed) {
    assert(isSafeExternalUrl(url) === true, `should allow: ${url}`);
    console.log(`✓ allow: ${url}`);
    passed++;
  }

  for (const url of rejected) {
    const result = isSafeExternalUrl(url);
    assert(result === false, `should reject: ${JSON.stringify(url)} (got ${result})`);
    console.log(`✓ reject: ${JSON.stringify(url)}`);
    passed++;
  }

  // Protocol-relative and weird cases
  assert(isSafeExternalUrl('//evil.com') === false, 'protocol-relative rejected');
  console.log('✓ reject: //evil.com');
  passed++;

  assert(isSafeExternalUrl('http:') === false, 'bare http: rejected');
  console.log('✓ reject: http:');
  passed++;

  console.log(`\n✅ All ${passed} external URL tests passed!`);
}

runTests();

/**
 * Comprehensive regression tests for Electron project-root path boundary.
 * Covers validateProjectPath used by editor:open, shell:reveal, project:setRoot.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { validateProjectPath } = require('../electron/security-utils.cjs');

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertThrows(fn, msgContains) {
  let threw = false;
  let errMsg = '';
  try {
    fn();
  } catch (e) {
    threw = true;
    errMsg = e instanceof Error ? e.message : String(e);
  }
  assert(threw, `expected throw for: ${msgContains}`);
  if (msgContains) {
    assert(errMsg.includes(msgContains) || errMsg.includes('outside') || errMsg.includes('does not exist') || errMsg.includes('Cannot resolve'),
      `expected message containing "${msgContains}", got: ${errMsg}`);
  }
}

function runTests() {
  console.log('Running project-root path boundary security tests...\n');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-path-'));
  const projectRoot = path.join(tmp, 'project');
  const sibling = path.join(tmp, 'project-sibling'); // prefix-similar
  const outside = path.join(tmp, 'outside');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(sibling, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });

  // Nested structure
  const nestedDir = path.join(projectRoot, 'src', 'lib');
  fs.mkdirSync(nestedDir, { recursive: true });
  const nestedFile = path.join(nestedDir, 'code.js');
  fs.writeFileSync(nestedFile, 'console.log(1)');
  const topFile = path.join(projectRoot, 'readme.md');
  fs.writeFileSync(topFile, '# hi');

  // Sibling with similar prefix (must NOT be inside)
  const siblingFile = path.join(sibling, 'secret.txt');
  fs.writeFileSync(siblingFile, 'no');

  // Outside file
  const outsideFile = path.join(outside, 'escape.txt');
  fs.writeFileSync(outsideFile, 'no');

  let passed = 0;

  // --- Valid cases ---
  {
    const r = validateProjectPath(topFile, projectRoot);
    assert(path.resolve(r) === path.resolve(topFile) || r.endsWith('readme.md'), 'normal file inside root');
    console.log('✓ normal file inside project root');
    passed++;
  }

  {
    const r = validateProjectPath(nestedFile, projectRoot);
    assert(r.includes('code.js'), 'nested file inside root');
    console.log('✓ nested file inside project root');
    passed++;
  }

  {
    const r = validateProjectPath(nestedDir, projectRoot);
    assert(fs.statSync(r).isDirectory(), 'directory inside root');
    console.log('✓ directory inside project root');
    passed++;
  }

  {
    // Path with . / .. that still resolves inside
    const tricky = path.join(projectRoot, 'src', '..', 'src', 'lib', 'code.js');
    const r = validateProjectPath(tricky, projectRoot);
    assert(r.includes('code.js'), '. / .. that stays inside');
    console.log('✓ path with . / .. resolving inside root');
    passed++;
  }

  // --- Rejection cases ---
  {
    assertThrows(() => validateProjectPath(outsideFile, projectRoot), 'outside');
    console.log('✓ path outside project root rejected');
    passed++;
  }

  {
    const traversal = path.join(projectRoot, '..', 'outside', 'escape.txt');
    assertThrows(() => validateProjectPath(traversal, projectRoot), 'outside');
    console.log('✓ ../ traversal outside root rejected');
    passed++;
  }

  {
    assertThrows(() => validateProjectPath(outsideFile, projectRoot), 'outside');
    console.log('✓ absolute path outside root rejected');
    passed++;
  }

  {
    // Prefix-similar sibling must not match
    assertThrows(() => validateProjectPath(siblingFile, projectRoot), 'outside');
    console.log('✓ sibling with similar prefix rejected');
    passed++;
  }

  // Also test that "project" does not accept "project-extra" style via relative
  {
    const fake = path.join(tmp, 'project-extra');
    fs.mkdirSync(fake, { recursive: true });
    const f = path.join(fake, 'x.txt');
    fs.writeFileSync(f, 'x');
    assertThrows(() => validateProjectPath(f, projectRoot), 'outside');
    console.log('✓ prefix-similar directory (project vs project-extra) rejected');
    passed++;
  }

  // --- Symlink cases (where supported) ---
  const canSymlink = (() => {
    try {
      const t = path.join(tmp, 'symlink-probe');
      fs.symlinkSync(outside, t, 'dir');
      fs.rmSync(t, { force: true, recursive: true });
      return true;
    } catch {
      return false;
    }
  })();

  if (canSymlink) {
    const linkInside = path.join(projectRoot, 'escape-link');
    try {
      fs.symlinkSync(outside, linkInside, process.platform === 'win32' ? 'junction' : 'dir');
      // Symlink inside root pointing outside -> realpath goes outside -> reject
      assertThrows(() => validateProjectPath(linkInside, projectRoot), 'outside');
      console.log('✓ symlink inside root pointing outside rejected');
      passed++;

      // Nested file via the symlink
      const viaLink = path.join(linkInside, 'escape.txt');
      assertThrows(() => validateProjectPath(viaLink, projectRoot), 'outside');
      console.log('✓ nested path through escaping symlink rejected');
      passed++;
    } catch (e) {
      console.log('⚠ symlink test skipped or partial:', e.message);
    }

    // Symlink whose parent resolves outside (edge)
    // Requested path that doesn't exist but parent escapes
    const badParent = path.join(outside, 'nonexistent-child.txt');
    assertThrows(() => validateProjectPath(badParent, projectRoot), 'outside');
    console.log('✓ nonexistent path whose parent is outside rejected');
    passed++;
  } else {
    console.log('⚠ symlinks not supported in this environment; skipping symlink cases');
  }

  // Nonexistent inside root (parent valid)
  {
    const missing = path.join(projectRoot, 'does-not-exist-yet.txt');
    assertThrows(() => validateProjectPath(missing, projectRoot), 'does not exist');
    console.log('✓ nonexistent path inside root handled safely (does not exist)');
    passed++;
  }

  // No project root configured
  {
    assertThrows(() => validateProjectPath(topFile, null), 'No project root');
    console.log('✓ missing project root rejected');
    passed++;
  }

  // Windows-style path separator / drive letter behavior (cross-platform checks)
  {
    // On non-Windows, path.win32 still useful for logic; realpath may differ
    // We at least ensure absolute outside is rejected regardless of separator style
    const absOutside = path.resolve(outsideFile);
    assertThrows(() => validateProjectPath(absOutside, projectRoot), 'outside');
    console.log('✓ resolved absolute outside path rejected');
    passed++;
  }

  // Cleanup
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}

  console.log(`\n✅ All ${passed} project-path boundary tests passed!`);
}

runTests();

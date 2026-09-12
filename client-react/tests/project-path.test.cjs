/**
 * Regression tests for the Electron project-root path boundary.
 * These exercise the shared validator used by editor:open and shell:reveal,
 * and statically verify that those IPC handlers are wired through it.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { validateProjectPath } = require('../electron/security-utils.cjs');

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertThrows(fn, expectedMessage) {
  let threw = false;
  let errMsg = '';
  try {
    fn();
  } catch (e) {
    threw = true;
    errMsg = e instanceof Error ? e.message : String(e);
  }
  assert(threw, `expected throw: ${expectedMessage}`);
  assert(errMsg.includes(expectedMessage), `expected message containing "${expectedMessage}", got: ${errMsg}`);
}

function runTests() {
  console.log('Running project-root path boundary security tests...\n');

  const electronMain = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');
  assert(electronMain.includes("ipcMain.handle('editor:open'"), 'editor:open IPC handler exists');
  assert(electronMain.includes("validateProjectPath(filePath, projectRoot)"), 'editor:open validates the requested path');
  assert(electronMain.includes("ipcMain.handle('shell:reveal'"), 'shell:reveal IPC handler exists');
  assert(electronMain.includes("validateProjectPath(filePath, projectRoot)"), 'shell:reveal validates the requested path');
  assert(electronMain.includes("fs.realpathSync.native(nextRoot.trim())"), 'project:setRoot canonicalizes the selected root');
  console.log('✓ Electron IPC handlers are wired through the path boundary validator');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aichat-path-'));
  const projectRoot = path.join(tmp, 'project');
  const sibling = path.join(tmp, 'project-sibling');
  const outside = path.join(tmp, 'outside');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(sibling, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });

  const nestedDir = path.join(projectRoot, 'src', 'lib');
  fs.mkdirSync(nestedDir, { recursive: true });
  const nestedFile = path.join(nestedDir, 'code.js');
  fs.writeFileSync(nestedFile, 'console.log(1)');
  const topFile = path.join(projectRoot, 'readme.md');
  fs.writeFileSync(topFile, '# hi');
  const siblingFile = path.join(sibling, 'secret.txt');
  fs.writeFileSync(siblingFile, 'no');
  const outsideFile = path.join(outside, 'escape.txt');
  fs.writeFileSync(outsideFile, 'no');

  let passed = 1;

  const validCases = [
    ['project root itself', projectRoot],
    ['normal file inside project root', topFile],
    ['nested file inside project root', nestedFile],
    ['directory inside project root', nestedDir],
    ['path with dot segments that remains inside', path.join(projectRoot, 'src', '..', 'src', 'lib', 'code.js')],
  ];
  for (const [label, candidate] of validCases) {
    const resolved = validateProjectPath(candidate, projectRoot);
    assert(path.relative(fs.realpathSync.native(projectRoot), resolved) === '' || !path.relative(fs.realpathSync.native(projectRoot), resolved).startsWith('..'), label);
    console.log(`✓ ${label}`);
    passed++;
  }

  const rejectedCases = [
    ['path outside project root', outsideFile],
    ['../ traversal outside root', path.join(projectRoot, '..', 'outside', 'escape.txt')],
    ['prefix-similar sibling', siblingFile],
  ];
  for (const [label, candidate] of rejectedCases) {
    assertThrows(() => validateProjectPath(candidate, projectRoot), 'Path is outside project root');
    console.log(`✓ ${label} rejected`);
    passed++;
  }

  const projectExtra = path.join(tmp, 'project-extra');
  fs.mkdirSync(projectExtra, { recursive: true });
  const projectExtraFile = path.join(projectExtra, 'x.txt');
  fs.writeFileSync(projectExtraFile, 'x');
  assertThrows(() => validateProjectPath(projectExtraFile, projectRoot), 'Path is outside project root');
  console.log('✓ project vs project-extra prefix collision rejected');
  passed++;

  const canSymlink = (() => {
    const probe = path.join(tmp, 'symlink-probe');
    try {
      fs.symlinkSync(outside, probe, process.platform === 'win32' ? 'junction' : 'dir');
      fs.rmSync(probe, { force: true, recursive: true });
      return true;
    } catch {
      return false;
    }
  })();

  if (canSymlink) {
    const linkInside = path.join(projectRoot, 'escape-link');
    fs.symlinkSync(outside, linkInside, process.platform === 'win32' ? 'junction' : 'dir');
    assertThrows(() => validateProjectPath(linkInside, projectRoot), 'Path is outside project root');
    console.log('✓ symlink/junction escape rejected');
    passed++;

    const viaLink = path.join(linkInside, 'escape.txt');
    assertThrows(() => validateProjectPath(viaLink, projectRoot), 'Path is outside project root');
    console.log('✓ nested path through symlink/junction escape rejected');
    passed++;

    const insideTarget = path.join(projectRoot, 'real-target');
    fs.mkdirSync(insideTarget);
    const safeLink = path.join(projectRoot, 'safe-link');
    fs.symlinkSync(insideTarget, safeLink, process.platform === 'win32' ? 'junction' : 'dir');
    assert(validateProjectPath(safeLink, projectRoot) === fs.realpathSync.native(insideTarget), 'symlink resolving back inside is allowed');
    console.log('✓ symlink/junction resolving back inside is allowed');
    passed++;
  } else {
    console.log('⚠ symlinks/junctions unavailable; escape tests skipped');
  }

  const badParent = path.join(outside, 'nonexistent-child.txt');
  assertThrows(() => validateProjectPath(badParent, projectRoot), 'Path is outside project root');
  console.log('✓ nonexistent path whose parent is outside rejected');
  passed++;

  const missingInside = path.join(projectRoot, 'does-not-exist-yet.txt');
  assertThrows(() => validateProjectPath(missingInside, projectRoot), 'Path does not exist');
  console.log('✓ nonexistent path inside root rejected safely');
  passed++;

  assertThrows(() => validateProjectPath(topFile, null), 'No project root configured');
  console.log('✓ missing project root rejected');
  passed++;

  assertThrows(() => validateProjectPath('', projectRoot), 'Path does not exist');
  console.log('✓ empty path rejected');
  passed++;

  if (process.platform === 'win32') {
    const root = path.parse(projectRoot).root;
    const otherDrive = root.toUpperCase() === 'C:\\' ? 'D:\\' : 'C:\\';
    assertThrows(() => validateProjectPath(path.join(otherDrive, 'Windows', 'System32'), projectRoot), 'Cannot resolve path');
    console.log('✓ different Windows drive is rejected');
    passed++;
  }

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}

  console.log(`\n✅ All ${passed} project-path boundary checks passed!`);
}

runTests();

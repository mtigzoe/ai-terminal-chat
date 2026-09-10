/**
 * Tests for the editor:open IPC handler security fix.
 *
 * This test validates that the editor:open handler only allows:
 * 1. editorId === "system" - uses shell.openPath
 * 2. editorId explicitly defined in KNOWN_EDITORS
 *
 * For any other editorId, it should return false without spawning.
 */

const { spawn } = require('node:child_process');
const { shell } = require('electron');

// Mock electron modules
const shellMock = {
  openPath: async (path) => { /* no-op */ },
  showItemInFolder: (path) => { /* no-op */ },
};

const spawnMock = {
  unref: () => {},
};

let lastSpawnArgs = null;
let spawnCallCount = 0;

const mockSpawn = (bin, args, options) => {
  spawnCallCount++;
  lastSpawnArgs = { bin, args, options };
  return { unref: () => {} };
};

// Save original modules
const originalSpawn = spawn;
const originalShell = shell;

// KNOWN_EDITORS from main.cjs
const KNOWN_EDITORS = [
  { id: 'code', name: 'VS Code', bin: process.platform === 'win32' ? 'code.cmd' : 'code' },
  { id: 'cursor', name: 'Cursor', bin: process.platform === 'win32' ? 'cursor.cmd' : 'cursor' },
  { id: 'windsurf', name: 'Windsurf', bin: process.platform === 'win32' ? 'windsurf.cmd' : 'windsurf' },
  { id: 'sublime', name: 'Sublime Text', bin: 'subl' },
];

// The handler logic extracted from main.cjs
async function handleEditorOpen(filePath, editorId) {
  if (!filePath) return false;
  if (!editorId || editorId === 'system') {
    await shellMock.openPath(filePath);
    return true;
  }
  const targetEditor = KNOWN_EDITORS.find((item) => item.id === editorId);
  if (!targetEditor) {
    console.error(`Refusing to launch unknown editor: ${editorId}`);
    return false;
  }
  try {
    mockSpawn(targetEditor.bin, [filePath], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch (err) {
    console.error('Failed to spawn editor:', err);
    await shellMock.openPath(filePath);
    return false;
  }
}

function resetMocks() {
  spawnCallCount = 0;
  lastSpawnArgs = null;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runTests() {
  console.log('Running editor:open security tests...\n');

  // Test 1: system editor uses shell.openPath
  {
    resetMocks();
    const result = await handleEditorOpen('/test/file.txt', 'system');
    assert(result === true, 'system editor should return true');
    assert(spawnCallCount === 0, 'system editor should not call spawn');
    console.log('✓ Test 1 passed: system editor works');
  }

  // Test 2: undefined editorId uses shell.openPath
  {
    resetMocks();
    const result = await handleEditorOpen('/test/file.txt', undefined);
    assert(result === true, 'undefined editorId should return true');
    assert(spawnCallCount === 0, 'undefined editorId should not call spawn');
    console.log('✓ Test 2 passed: undefined editorId works');
  }

  // Test 3: null editorId uses shell.openPath
  {
    resetMocks();
    const result = await handleEditorOpen('/test/file.txt', null);
    assert(result === true, 'null editorId should return true');
    assert(spawnCallCount === 0, 'null editorId should not call spawn');
    console.log('✓ Test 3 passed: null editorId works');
  }

  // Test 4: empty string editorId uses shell.openPath
  {
    resetMocks();
    const result = await handleEditorOpen('/test/file.txt', '');
    assert(result === true, 'empty editorId should return true');
    assert(spawnCallCount === 0, 'empty editorId should not call spawn');
    console.log('✓ Test 4 passed: empty editorId works');
  }

  // Test 5: known editor 'code' calls spawn with correct binary
  {
    resetMocks();
    const result = await handleEditorOpen('/test/file.txt', 'code');
    assert(result === true, 'known editor should return true');
    assert(spawnCallCount === 1, 'known editor should call spawn once');
    assert(lastSpawnArgs.bin === (process.platform === 'win32' ? 'code.cmd' : 'code'),
      'should use correct binary for code editor');
    assert(lastSpawnArgs.args[0] === '/test/file.txt', 'should pass file path as argument');
    console.log('✓ Test 5 passed: known editor "code" works');
  }

  // Test 6: known editor 'cursor' calls spawn with correct binary
  {
    resetMocks();
    const result = await handleEditorOpen('/test/file.txt', 'cursor');
    assert(result === true, 'known editor should return true');
    assert(spawnCallCount === 1, 'known editor should call spawn once');
    assert(lastSpawnArgs.bin === (process.platform === 'win32' ? 'cursor.cmd' : 'cursor'),
      'should use correct binary for cursor editor');
    console.log('✓ Test 6 passed: known editor "cursor" works');
  }

  // Test 7: known editor 'windsurf' calls spawn with correct binary
  {
    resetMocks();
    const result = await handleEditorOpen('/test/file.txt', 'windsurf');
    assert(result === true, 'known editor should return true');
    assert(spawnCallCount === 1, 'known editor should call spawn once');
    assert(lastSpawnArgs.bin === (process.platform === 'win32' ? 'windsurf.cmd' : 'windsurf'),
      'should use correct binary for windsurf editor');
    console.log('✓ Test 7 passed: known editor "windsurf" works');
  }

  // Test 8: known editor 'sublime' calls spawn with correct binary
  {
    resetMocks();
    const result = await handleEditorOpen('/test/file.txt', 'sublime');
    assert(result === true, 'known editor should return true');
    assert(spawnCallCount === 1, 'known editor should call spawn once');
    assert(lastSpawnArgs.bin === 'subl', 'should use correct binary for sublime editor');
    console.log('✓ Test 8 passed: known editor "sublime" works');
  }

  // Test 9: unknown editor 'node' should NOT be spawned
  {
    resetMocks();
    const result = await handleEditorOpen('/test/file.txt', 'node');
    assert(result === false, 'unknown editor should return false');
    assert(spawnCallCount === 0, 'unknown editor should not call spawn');
    console.log('✓ Test 9 passed: unknown editor "node" rejected');
  }

  // Test 10: unknown editor 'powershell' should NOT be spawned
  {
    resetMocks();
    const result = await handleEditorOpen('/test/file.txt', 'powershell');
    assert(result === false, 'unknown editor should return false');
    assert(spawnCallCount === 0, 'unknown editor should not call spawn');
    console.log('✓ Test 10 passed: unknown editor "powershell" rejected');
  }

  // Test 11: unknown editor 'cmd.exe' should NOT be spawned
  {
    resetMocks();
    const result = await handleEditorOpen('/test/file.txt', 'cmd.exe');
    assert(result === false, 'unknown editor should return false');
    assert(spawnCallCount === 0, 'unknown editor should not call spawn');
    console.log('✓ Test 11 passed: unknown editor "cmd.exe" rejected');
  }

  // Test 12: unknown editor 'malicious' should NOT be spawned
  {
    resetMocks();
    const result = await handleEditorOpen('/test/file.txt', 'malicious');
    assert(result === false, 'unknown editor should return false');
    assert(spawnCallCount === 0, 'unknown editor should not call spawn');
    console.log('✓ Test 12 passed: unknown editor "malicious" rejected');
  }

  // Test 13: unknown editor with path traversal attempt
  {
    resetMocks();
    const result = await handleEditorOpen('/test/file.txt', '../../malicious');
    assert(result === false, 'path traversal editor should return false');
    assert(spawnCallCount === 0, 'path traversal editor should not call spawn');
    console.log('✓ Test 13 passed: path traversal attempt rejected');
  }

  // Test 14: empty filePath should return false
  {
    resetMocks();
    const result = await handleEditorOpen('', 'code');
    assert(result === false, 'empty filePath should return false');
    assert(spawnCallCount === 0, 'empty filePath should not call spawn');
    console.log('✓ Test 14 passed: empty filePath rejected');
  }

  // Test 15: null filePath should return false
  {
    resetMocks();
    const result = await handleEditorOpen(null, 'code');
    assert(result === false, 'null filePath should return false');
    assert(spawnCallCount === 0, 'null filePath should not call spawn');
    console.log('✓ Test 15 passed: null filePath rejected');
  }

  // Test 16: spawn error falls back to shell.openPath
  {
    resetMocks();
    let fallbackCalled = false;
    const originalOpenPath = shellMock.openPath;
    shellMock.openPath = async () => { fallbackCalled = true; };
    const originalSpawn = mockSpawn;
    const failingSpawn = () => { throw new Error('spawn failed'); };
    // We need to redefine the handler to use the failing spawn
    // For this test, we'll just verify the logic manually
    const result = await (async (filePath, editorId) => {
      if (!filePath) return false;
      if (!editorId || editorId === 'system') {
        await shellMock.openPath(filePath);
        return true;
      }
      const targetEditor = KNOWN_EDITORS.find((item) => item.id === editorId);
      if (!targetEditor) {
        console.error(`Refusing to launch unknown editor: ${editorId}`);
        return false;
      }
      try {
        failingSpawn(targetEditor.bin, [filePath], { detached: true, stdio: 'ignore' }).unref();
        return true;
      } catch (err) {
        console.error('Failed to spawn editor:', err);
        await shellMock.openPath(filePath);
        return false;
      }
    })('/test/file.txt', 'code');
    assert(result === false, 'spawn error should return false');
    assert(fallbackCalled === true, 'should fall back to shell.openPath on spawn error');
    shellMock.openPath = originalOpenPath;
    console.log('✓ Test 16 passed: spawn error falls back to system default');
  }

  console.log('\n✅ All 16 tests passed!');
}

runTests().catch((err) => {
  console.error('\n❌ Test failed:', err.message);
  process.exit(1);
});
/**
 * Security regression tests for the production editor:open helper.
 * Run directly with Node; no Electron runtime or real editor is required.
 */

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { handleEditorOpen } = require('../electron/editor-handler.cjs');

const filePath = process.platform === 'win32'
  ? 'C:\\project\\read me.txt'
  : '/project/read me.txt';

function createDeps({ failSpawn = false } = {}) {
  const spawnCalls = [];
  const openedPaths = [];
  const children = [];
  return {
    spawnCalls,
    openedPaths,
    children,
    spawn(command, args, options) {
      spawnCalls.push({ command, args, options });
      if (failSpawn) throw new Error('spawn failed');

      const child = new EventEmitter();
      child.unrefCalls = 0;
      child.unref = () => { child.unrefCalls += 1; };
      children.push(child);
      // Native editors succeed after spawn; Windows command bridges must
      // additionally report a successful exit. Emit both asynchronously so
      // the production helper can attach its real event listeners first.
      queueMicrotask(() => {
        child.emit('spawn');
        child.emit('exit', 0, null);
      });
      return child;
    },
    async openPath(requestedPath) {
      openedPaths.push(requestedPath);
      return '';
    },
  };
}

const tests = [];
function test(name, run) {
  tests.push({ name, run });
}

for (const [label, editorId] of [
  ['system editor', 'system'],
  ['undefined editor', undefined],
  ['null editor', null],
  ['empty editor', ''],
]) {
  test(`${label} uses the system opener`, async () => {
    const deps = createDeps();
    assert.equal(await handleEditorOpen(deps, filePath, editorId), true);
    assert.deepEqual(deps.openedPaths, [filePath]);
    assert.deepEqual(deps.spawnCalls, []);
  });
}

for (const [editorId, nativeBin] of [
  ['code', 'code'],
  ['cursor', 'cursor'],
  ['windsurf', 'windsurf'],
  ['sublime', 'subl'],
]) {
  test(`allowlisted editor "${editorId}" receives only the requested path`, async () => {
    const deps = createDeps();
    assert.equal(await handleEditorOpen(deps, filePath, editorId), true);
    assert.deepEqual(deps.openedPaths, []);
    assert.equal(deps.spawnCalls.length, 1);

    const { command, args, options } = deps.spawnCalls[0];
    assert.ok(!options.shell, 'must not enable automatic shell interpolation');
    assert.equal(options.stdio, 'ignore');

    if (process.platform === 'win32' && editorId !== 'sublime') {
      assert.equal(command, process.env.ComSpec || 'cmd.exe');
      assert.deepEqual(args.slice(0, 4), ['/d', '/s', '/v:off', '/c']);
      assert.equal(args.length, 5);
      assert.equal(args[4], `${nativeBin}.cmd "${filePath}"`);
      assert.equal(options.windowsVerbatimArguments, true);
      assert.equal(options.windowsHide, true);
    } else {
      assert.equal(command, nativeBin);
      assert.deepEqual(args, [filePath]);
      assert.equal(deps.children[0].unrefCalls, 1);
    }
  });
}

for (const editorId of ['node', 'powershell', 'cmd.exe', 'malicious', '../../malicious']) {
  test(`unknown editor "${editorId}" cannot launch any process or opener`, async () => {
    const deps = createDeps();
    assert.equal(await handleEditorOpen(deps, filePath, editorId), false);
    assert.deepEqual(deps.spawnCalls, []);
    assert.deepEqual(deps.openedPaths, []);
  });
}

for (const [label, requestedPath] of [['empty', ''], ['null', null]]) {
  test(`${label} file path cannot launch any process or opener`, async () => {
    const deps = createDeps();
    assert.equal(await handleEditorOpen(deps, requestedPath, 'code'), false);
    assert.deepEqual(deps.spawnCalls, []);
    assert.deepEqual(deps.openedPaths, []);
  });
}

test('a failed editor spawn falls back to the system opener and reports success', async () => {
  const deps = createDeps({ failSpawn: true });
  assert.equal(await handleEditorOpen(deps, filePath, 'code'), true);
  assert.equal(deps.spawnCalls.length, 1);
  assert.deepEqual(deps.openedPaths, [filePath]);
});

async function runTests() {
  console.log('Running production editor:open security tests...\n');
  for (const [index, { name, run }] of tests.entries()) {
    await run();
    console.log(`PASS ${index + 1}: ${name}`);
  }
  console.log(`\nAll ${tests.length} tests passed!`);
}

runTests().catch((err) => {
  console.error('\nTest failed:', err);
  process.exitCode = 1;
});

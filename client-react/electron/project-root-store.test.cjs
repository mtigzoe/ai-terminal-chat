const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadAuthorizedProjectRoots, saveAuthorizedProjectRoots } = require('./project-root-store.cjs');

describe('project-root-store', () => {
  let userDataDir;
  let projectDir;

  beforeEach(() => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-terminal-chat-user-data-'));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-terminal-chat-project-'));
  });

  afterEach(() => {
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  test('round-trips approved project roots across app restarts', () => {
    const roots = new Set([fs.realpathSync.native(projectDir)]);
    expect(saveAuthorizedProjectRoots(userDataDir, roots)).toBe(true);

    const restored = loadAuthorizedProjectRoots(userDataDir);
    expect(restored).toEqual([fs.realpathSync.native(projectDir)]);
  });

  test('ignores malformed and missing roots', () => {
    fs.writeFileSync(
      path.join(userDataDir, 'authorized-project-roots.json'),
      JSON.stringify(['not-a-real-path', 123, '', projectDir])
    );

    expect(loadAuthorizedProjectRoots(userDataDir)).toEqual([fs.realpathSync.native(projectDir)]);
  });

  test('does not fail when the store is missing or malformed', () => {
    expect(loadAuthorizedProjectRoots(userDataDir)).toEqual([]);
    fs.writeFileSync(path.join(userDataDir, 'authorized-project-roots.json'), '{broken');
    expect(loadAuthorizedProjectRoots(userDataDir)).toEqual([]);
  });
});

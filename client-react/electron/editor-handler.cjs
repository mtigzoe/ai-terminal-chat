/**
 * Editor handler logic - extracted for testability.
 * This module contains the core logic for the editor:open IPC handler
 * without Electron-specific dependencies.
 */

const KNOWN_EDITORS = [
  { id: 'code', name: 'VS Code', bin: process.platform === 'win32' ? 'code.cmd' : 'code' },
  { id: 'cursor', name: 'Cursor', bin: process.platform === 'win32' ? 'cursor.cmd' : 'cursor' },
  { id: 'windsurf', name: 'Windsurf', bin: process.platform === 'win32' ? 'windsurf.cmd' : 'windsurf' },
  { id: 'sublime', name: 'Sublime Text', bin: 'subl' },
];

/**
 * Timing-safe string comparison to prevent timing attacks.
 */
function timingSafeEqual(a, b) {
  const crypto = require('node:crypto');
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, Buffer.from('x'.repeat(bufA.length)));
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Build the argv for launching an editor.
 *
 * On Windows the editor entry points are `.cmd` shims. Since Node
 * 18.20.2 / 20.12.2 / 22.0.0 (CVE-2024-27980) `spawn()` of a `.bat`/`.cmd`
 * without a shell throws `Error: spawn EINVAL`, so every "Open in VS Code"
 * silently fell through to the system opener. Route through `cmd.exe` the
 * same way `scripts/prepare-server.cjs` already does for `npm.cmd`; argv
 * stays an array, so the path is never concatenated into a shell string.
 */
function buildEditorSpawn(editorBin, filePath) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(editorBin)) {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', editorBin, filePath],
    };
  }
  return { command: editorBin, args: [filePath] };
}

/**
 * Handle editor open request.
 * @param {Object} deps - Dependencies (for testability)
 * @param {Function} deps.spawn - spawn function (child_process.spawn)
 * @param {Function} deps.openPath - shell.openPath function
 * @param {string} filePath - Path to file to open (already validated against project root)
 * @param {string} editorId - Editor identifier
 * @returns {Promise<boolean>} Success status
 */
async function handleEditorOpen({ spawn, openPath }, filePath, editorId) {
  if (!filePath) return false;
  if (!editorId || editorId === 'system') {
    await openPath(filePath);
    return true;
  }
  const targetEditor = KNOWN_EDITORS.find((item) => item.id === editorId);
  if (!targetEditor) {
    console.error(`Refusing to launch unknown editor: ${editorId}`);
    return false;
  }
  let child;
  try {
    const { command, args } = buildEditorSpawn(targetEditor.bin, filePath);
    child = spawn(command, args, { detached: true, stdio: 'ignore' });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
    return true;
  } catch (err) {
    console.error('Failed to spawn editor:', err);
    // The fallback did open the file, so report success rather than making
    // the caller treat a working open as a failure.
    await openPath(filePath);
    return true;
  }
}

/**
 * Get available editors list.
 * @returns {Array} List of available editors including system default
 */
function getAvailableEditors() {
  return [{ id: 'system', name: 'System Default' }, ...KNOWN_EDITORS];
}

module.exports = {
  handleEditorOpen,
  getAvailableEditors,
  buildEditorSpawn,
  KNOWN_EDITORS,
};

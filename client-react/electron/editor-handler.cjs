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
  try {
    spawn(targetEditor.bin, [filePath], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch (err) {
    console.error('Failed to spawn editor:', err);
    await openPath(filePath);
    return false;
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
  KNOWN_EDITORS,
};
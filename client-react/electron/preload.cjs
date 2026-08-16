/**
 * Preload script — Stage 1
 *
 * Runs in an isolated context before the renderer loads.
 * At this stage no privileged APIs are exposed to the page.
 * The bridge can be extended later (e.g. native dialogs, app info)
 * without changing the React codebase.
 */

const { contextBridge } = require('electron');

// Expose a minimal, read-only marker so the React app can detect
// that it is running inside Electron if needed in the future.
contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
});

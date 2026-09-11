/**
 * Preload script — Stage 1
 *
 * Runs in an isolated context before the renderer loads.
 * Exposes a minimal, privilege-limited bridge to the React UI.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  /**
   * Open a native directory picker and return the selected path,
   * or null if the user cancelled.
   * @param {string} [defaultPath]
   * @returns {Promise<string|null>}
   */
  chooseFolder: (defaultPath) => ipcRenderer.invoke('dialog:chooseFolder', defaultPath),
  /**
   * Open a target file or folder in a specified editor or system default.
   */
  openInEditor: (filePath, editorId) =>
    ipcRenderer.invoke('editor:open', { filePath, editorId }),
  revealInFileExplorer: (filePath) =>
    ipcRenderer.invoke('shell:reveal', filePath),
  getAvailableEditors: () =>
    ipcRenderer.invoke('editor:getAvailable'),
  /**
   * Sync the active project root into the main process so editor/reveal
   * path validation matches the backend after HTTP-based root changes.
   * @param {string} path
   * @returns {Promise<boolean>}
   */
  setProjectRoot: (path) => ipcRenderer.invoke('project:setRoot', path),
});

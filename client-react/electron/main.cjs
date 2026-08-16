/**
 * Electron main process — Stage 1
 *
 * Loads the existing React/Vite frontend.
 *
 * - Development (unpackaged): always loads the Vite dev server at
 *   http://localhost:3000 so a leftover dist/ folder cannot override it.
 * - Packaged / production: loads dist/index.html from the application
 *   resources.
 *
 * The Flask backend is expected to be started separately (as in the
 * browser workflow). No automatic process management is performed here.
 */

const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

/** @type {BrowserWindow | null} */
let mainWindow = null;

/**
 * Resolve the URL or file path that the renderer should load.
 *
 * Development (not packaged) always uses the Vite dev server.
 * Packaged builds load the production assets from dist/.
 */
function getRendererEntry() {
  // Unpackaged runs are development: never prefer a stale dist/.
  if (!app.isPackaged) {
    return { type: 'url', target: 'http://localhost:3000' };
  }

  const distIndex = path.join(__dirname, '..', 'dist', 'index.html');
  if (fs.existsSync(distIndex)) {
    return { type: 'file', target: distIndex };
  }

  // Fallback for unexpected packaging layouts.
  return { type: 'url', target: 'http://localhost:3000' };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    title: 'AI Terminal Chat',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const entry = getRendererEntry();

  if (entry.type === 'file') {
    mainWindow.loadFile(entry.target);
  } else {
    mainWindow.loadURL(entry.target);
  }

  // Show only after the first paint to avoid a blank flash.
  mainWindow.once('ready-to-show', () => {
    if (mainWindow) {
      mainWindow.show();
    }
  });

  // Open external links in the system browser rather than inside Electron.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    // On macOS it is common to re-create a window when the dock icon is clicked
    // and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // On macOS applications usually stay active until the user quits explicitly
  // with Cmd + Q; on other platforms we quit when all windows are closed.
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

/**
 * Electron main process.
 *
 * - Development: loads the Vite dev server at http://localhost:3000.
 * - Production: loads client-react/dist/index.html.
 *
 * Set ELECTRON_PRODUCTION=1 when running the production renderer from an
 * unpackaged checkout. Packaged Electron applications always use dist/.
 */

const { app, BrowserWindow, shell, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

/** @type {BrowserWindow | null} */
let mainWindow = null;

function getRendererEntry() {
  const production = app.isPackaged || process.env.ELECTRON_PRODUCTION === '1';

  if (!production) {
    return { type: 'url', target: 'http://localhost:3000' };
  }

  const distIndex = path.join(__dirname, '..', 'dist', 'index.html');
  if (!fs.existsSync(distIndex)) {
    throw new Error(
      `Production renderer not found at ${distIndex}. Run "npm run build" first.`
    );
  }

  return { type: 'file', target: distIndex };
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

  mainWindow.once('ready-to-show', () => {
    if (mainWindow) {
      mainWindow.show();
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

ipcMain.handle('dialog:chooseFolder', async (event, defaultPath) => {
  const browserWindow = BrowserWindow.fromWebContents(event.sender);
  const options = {
    title: 'Choose project folder',
    properties: ['openDirectory', 'createDirectory'],
  };
  if (defaultPath && typeof defaultPath === 'string' && defaultPath.trim()) {
    options.defaultPath = defaultPath.trim();
  }

  const result = browserWindow
    ? await dialog.showOpenDialog(browserWindow, options)
    : await dialog.showOpenDialog(options);

  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

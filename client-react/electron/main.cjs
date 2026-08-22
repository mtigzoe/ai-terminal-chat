/**
 * Electron main process.
 *
 * - Development: loads the Vite dev server at http://localhost:3000.
 * - Production: loads client-react/dist/index.html.
 * - Packaged: starts the bundled TypeScript API server on port 9000 before
 *   loading the production renderer.
 */

const { app, BrowserWindow, shell, ipcMain, dialog, utilityProcess } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {import('electron').UtilityProcess | null} */
let backendProcess = null;

const BACKEND_HOST = '127.0.0.1';
const BACKEND_PORT = 9000;

function getRendererEntry() {
  const production = app.isPackaged || process.argv.includes('--production');
  const development = process.argv.includes('--dev');

  if (!production && development) {
    return { type: 'url', target: 'http://localhost:3000' };
  }

  if (!production && !development) {
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

function bundledBackendPath() {
  return path.join(process.resourcesPath, 'server-typescript');
}

function checkBackend() {
  return new Promise((resolve) => {
    const request = http.get(
      {
        hostname: BACKEND_HOST,
        port: BACKEND_PORT,
        path: '/providers?probe=0',
        timeout: 1000,
      },
      (response) => {
        response.resume();
        resolve(true);
      }
    );

    request.on('error', () => resolve(false));
    request.on('timeout', () => {
      request.destroy();
      resolve(false);
    });
  });
}

async function waitForBackend(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (await checkBackend()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`TypeScript backend did not become ready on port ${BACKEND_PORT}.`);
}

async function startBundledBackend() {
  if (!app.isPackaged) {
    return;
  }

  const backendDir = bundledBackendPath();
  const serverEntry = path.join(backendDir, 'dist', 'server.js');

  if (!fs.existsSync(serverEntry)) {
    throw new Error(`Bundled TypeScript backend not found at ${serverEntry}`);
  }

  if (await checkBackend()) {
    console.log(`TypeScript backend is already running on port ${BACKEND_PORT}.`);
    return;
  }

  console.log('Starting bundled TypeScript backend...');
  backendProcess = utilityProcess.fork(serverEntry, [], {
    cwd: backendDir,
    env: {
      ...process.env,
      HOST: BACKEND_HOST,
      PORT: String(BACKEND_PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    serviceName: 'AI Terminal Chat TypeScript Backend',
  });

  backendProcess.stdout?.on('data', (data) => {
    console.log(`[server-typescript] ${data.toString().trimEnd()}`);
  });

  backendProcess.stderr?.on('data', (data) => {
    console.error(`[server-typescript] ${data.toString().trimEnd()}`);
  });

  backendProcess.on('error', (error) => {
    console.error('TypeScript backend process error:', error);
  });

  backendProcess.on('exit', (code) => {
    console.log(`TypeScript backend exited with code ${code}.`);
    backendProcess = null;
  });

  await waitForBackend();
  console.log(`TypeScript backend is ready on port ${BACKEND_PORT}.`);
}

function stopBundledBackend() {
  if (backendProcess) {
    backendProcess.kill();
    backendProcess = null;
  }
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

app.whenReady().then(async () => {
  try {
    await startBundledBackend();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  } catch (error) {
    console.error('Failed to start AI Terminal Chat:', error);
    dialog.showErrorBox(
      'AI Terminal Chat could not start',
      error instanceof Error ? error.message : String(error)
    );
    stopBundledBackend();
    app.quit();
  }
});

app.on('before-quit', () => {
  stopBundledBackend();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

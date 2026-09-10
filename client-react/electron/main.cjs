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
const { spawn } = require('node:child_process');

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {import('electron').UtilityProcess | null} */
let backendProcess = null;
let backendExit = null;
let backendStderr = '';

const BACKEND_HOST = '127.0.0.1';
const BACKEND_PORT = 9000;

const KNOWN_EDITORS = [
  { id: 'code', name: 'VS Code', bin: process.platform === 'win32' ? 'code.cmd' : 'code' },
  { id: 'cursor', name: 'Cursor', bin: process.platform === 'win32' ? 'cursor.cmd' : 'cursor' },
  { id: 'windsurf', name: 'Windsurf', bin: process.platform === 'win32' ? 'windsurf.cmd' : 'windsurf' },
  { id: 'sublime', name: 'Sublime Text', bin: 'subl' },
];

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

    if (backendExit) {
      const details = backendStderr.trim();
      const exitDetails = `TypeScript backend exited before becoming ready (code ${backendExit.code ?? 'unknown'}, signal ${backendExit.signal ?? 'none'}).`;
      throw new Error(details ? `${exitDetails}\n\nBackend error:\n${details}` : exitDetails);
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const details = backendStderr.trim();
  throw new Error(
    details
      ? `TypeScript backend did not become ready on port ${BACKEND_PORT}.\n\nBackend error:\n${details}`
      : `TypeScript backend did not become ready on port ${BACKEND_PORT}.`
  );
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

  backendExit = null;
  backendStderr = '';

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
    const text = data.toString();
    backendStderr = `${backendStderr}${text}`.slice(-8000);
    console.error(`[server-typescript] ${text.trimEnd()}`);
  });

  backendProcess.on('error', (error) => {
    const message = error instanceof Error ? error.message : String(error);
    backendStderr = `${backendStderr}${message}\n`.slice(-8000);
    console.error('TypeScript backend process error:', error);
  });

  backendProcess.on('exit', (code, signal) => {
    backendExit = { code, signal };
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

ipcMain.handle('editor:open', async (event, { filePath, editorId }) => {
  if (!filePath) return false;
  if (!editorId || editorId === 'system') {
    await shell.openPath(filePath);
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
    await shell.openPath(filePath);
    return false;
  }
});

ipcMain.handle('shell:reveal', async (event, filePath) => {
  if (!filePath) return false;
  shell.showItemInFolder(filePath);
  return true;
});

ipcMain.handle('editor:getAvailable', async () => {
  return [{ id: 'system', name: 'System Default' }, ...KNOWN_EDITORS];
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

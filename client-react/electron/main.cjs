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
const crypto = require('node:crypto');
const { handleEditorOpen, getAvailableEditors } = require('./editor-handler.cjs');

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {import('electron').UtilityProcess | null} */
let backendProcess = null;
let backendExit = null;
let backendStderr = '';
let projectRoot = null; // Store the selected project root for path validation

const BACKEND_HOST = '127.0.0.1';
const BACKEND_PORT = 9000;

// Generate a random health token at startup for backend verification
const HEALTH_TOKEN = crypto.randomUUID();

const KNOWN_EDITORS = [
  { id: 'code', name: 'VS Code', bin: process.platform === 'win32' ? 'code.cmd' : 'code' },
  { id: 'cursor', name: 'Cursor', bin: process.platform === 'win32' ? 'cursor.cmd' : 'cursor' },
  { id: 'windsurf', name: 'Windsurf', bin: process.platform === 'win32' ? 'windsurf.cmd' : 'windsurf' },
  { id: 'sublime', name: 'Sublime Text', bin: 'subl' },
];

/**
 * Validates that a path is within the project root.
 * Resolves symlinks/junctions to prevent bypass via filesystem links.
 * Returns the resolved absolute path if valid, throws if not.
 */
function validateProjectPath(requestedPath, projectRootDir) {
  if (!projectRootDir) {
    throw new Error('No project root configured');
  }

  // Resolve both paths to absolute, normalized forms with symlink resolution
  // This prevents bypass via symlinks/junctions
  const resolvedRoot = fs.realpathSync.native(projectRootDir);
  let resolvedRequested;
  try {
    resolvedRequested = fs.realpathSync.native(requestedPath);
  } catch {
    // Path doesn't exist - still validate the resolved parent directory
    const parentDir = path.dirname(requestedPath);
    try {
      const resolvedParent = fs.realpathSync.native(parentDir);
      // Check if parent is within project root
      const relativeParent = path.relative(resolvedRoot, resolvedParent);
      if (relativeParent.startsWith('..') || path.isAbsolute(relativeParent)) {
        throw new Error(`Path is outside project root: ${requestedPath}`);
      }
      // Parent is valid, but path itself doesn't exist
      throw new Error(`Path does not exist: ${requestedPath}`);
    } catch (e) {
      if (e.message.includes('outside project root') || e.message.includes('does not exist')) {
        throw e;
      }
      // Couldn't resolve parent either
      throw new Error(`Cannot resolve path: ${requestedPath}`);
    }
  }

  // Check if requested path is within project root
  const relative = path.relative(resolvedRoot, resolvedRequested);
  const isWithinRoot = !relative.startsWith('..') && !path.isAbsolute(relative);

  if (!isWithinRoot) {
    throw new Error(`Path is outside project root: ${requestedPath}`);
  }

  return resolvedRequested;
}

/**
 * Timing-safe string comparison to prevent timing attacks.
 */
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still do the comparison to avoid early return timing leak
    crypto.timingSafeEqual(bufA, Buffer.from('x'.repeat(bufA.length)));
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

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
        path: '/health',
        timeout: 1000,
        headers: {
          'Authorization': `Bearer ${HEALTH_TOKEN}`,
        },
      },
      (response) => {
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            // Verify the health check returns the expected app identifier
            if (parsed.status === 'ok' && parsed.app === 'ai-terminal-chat') {
              resolve(true);
            } else {
              resolve(false);
            }
          } catch {
            resolve(false);
          }
        });
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
      AI_TERMINAL_CHAT_HEALTH_TOKEN: HEALTH_TOKEN,
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
  const selectedPath = result.filePaths[0];
  projectRoot = selectedPath; // Store for path validation
  return selectedPath;
});

ipcMain.handle('editor:open', async (event, { filePath, editorId }) => {
  if (!filePath) return false;
  try {
    // Validate path against project root before any editor operation
    const validatedPath = validateProjectPath(filePath, projectRoot);
    return handleEditorOpen({ spawn, openPath: shell.openPath }, validatedPath, editorId);
  } catch (err) {
    console.error('editor:open validation failed:', err instanceof Error ? err.message : String(err));
    return false;
  }
});

ipcMain.handle('shell:reveal', async (event, filePath) => {
  if (!filePath) return false;
  try {
    const validatedPath = validateProjectPath(filePath, projectRoot);
    shell.showItemInFolder(validatedPath);
    return true;
  } catch (err) {
    console.error('shell:reveal validation failed:', err instanceof Error ? err.message : String(err));
    return false;
  }
});

ipcMain.handle('editor:getAvailable', async () => {
  return getAvailableEditors();
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
// Static regression checks for bundled Electron backend startup and shutdown.
// Real screen-reader and OS-process acceptance is tracked separately in issue #252.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8');

assert.match(main, /function bundledBackendPath\(\)[\s\S]*?server-typescript/);
assert.match(main, /function startBundledBackend\(\)/);
assert.match(main, /utilityProcess\.fork\(serverEntry/);
assert.match(main, /AI_TERMINAL_CHAT_HEALTH_TOKEN: HEALTH_TOKEN/);
assert.match(main, /await waitForBackend\(\)/);
assert.match(main, /function stopBundledBackend\(\)[\s\S]*?backendProcess\.kill\(\)/);
assert.match(main, /app\.on\('before-quit',\s*\(\)\s*=>\s*\{\s*stopBundledBackend\(\)/);
assert.match(main, /catch \(error\) \{[\s\S]*?stopBundledBackend\(\);\s*app\.quit\(\)/);
assert.match(main, /contextIsolation:\s*true/);
assert.match(main, /nodeIntegration:\s*false/);
assert.match(main, /sandbox:\s*true/);

// Execute the real main-process startup with Electron/HTTP boundaries replaced.
// No application, network listener, or user configuration is opened by this test.
async function runPackagedStartup(userData, { failStartup = false, failRenderer = false } = {}) {
  const events = new Map();
  const forks = [];
  const errors = [];
  const windows = [];
  let ready;
  let kills = 0;
  let quits = 0;
  const inheritedEnv = {
    AI_TERMINAL_CHAT_CONFIG_DIR: path.resolve('ordinary-config'),
    ai_terminal_chat_config_dir: path.resolve('case-variant-config'),
    USERPROFILE: path.resolve('ordinary-home'),
    HOME: path.resolve('ordinary-home'),
    ACCEPTANCE_SENTINEL: 'inherited',
  };
  const app = {
    isPackaged: true,
    getPath(name) {
      assert.equal(name, 'userData');
      return userData;
    },
    whenReady: () => ({ then(callback) { ready = callback; } }),
    on: (name, callback) => events.set(name, callback),
    quit() { quits++; events.get('before-quit')?.(); },
  };
  class BrowserWindow {
    constructor(options) {
      windows.push(options);
      this.webContents = { on() {}, setWindowOpenHandler() {} };
    }
    loadFile() {}
    once() {}
    on() {}
  }
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { kills++; };
  const electron = {
    app, BrowserWindow, shell: {}, ipcMain: { handle() {} },
    dialog: { showErrorBox: (...args) => errors.push(args) },
    utilityProcess: {
      fork(entry, args, options) {
        forks.push({ entry, args, options });
        if (failStartup) queueMicrotask(() => child.emit('exit', 1, null));
        return child;
      },
    },
  };
  const http = {
    get(options, callback) {
      const request = new EventEmitter();
      request.destroy = () => {};
      queueMicrotask(() => {
        if (!forks.length || failStartup) {
          request.emit('error', new Error('Backend not ready'));
          return;
        }
        const response = new EventEmitter();
        callback(response);
        const token = options.headers.Authorization.slice('Bearer '.length);
        const challenge = options.headers['X-AI-Terminal-Chat-Health-Challenge'];
        response.emit('data', JSON.stringify({
          status: 'ok', app: 'ai-terminal-chat', proof: `${token}:${challenge}`,
        }));
        response.emit('end');
      });
      return request;
    },
  };
  const injected = {
    electron,
    'node:fs': {
      existsSync: (filename) => !failRenderer || !filename.endsWith(path.join('dist', 'index.html')),
    },
    'node:http': http,
    './editor-handler.cjs': {},
    './security-utils.cjs': {},
    './health-check.cjs': {
      createHealthChallenge: () => 'test-challenge',
      verifyHealthProof: (token, challenge, proof) => proof === `${token}:${challenge}`,
    },
    './project-root-store.cjs': {
      loadAuthorizedProjectRoots: (directory) => {
        assert.equal(directory, userData);
        return [];
      },
    },
  };
  vm.runInNewContext(main, {
    require: (name) => Object.hasOwn(injected, name) ? injected[name] : require(name),
    __dirname: path.resolve(__dirname, '..', 'electron'),
    process: {
      env: inheritedEnv, resourcesPath: path.resolve('packaged-resources'),
      argv: ['electron'], platform: process.platform,
    },
    console: { log() {}, error() {}, warn() {} },
    setTimeout,
  }, { filename: 'main.cjs' });
  await ready();
  assert.equal(forks.length, 1);
  const fork = forks[0];
  assert.equal(fork.options.env.AI_TERMINAL_CHAT_CONFIG_DIR, path.join(userData, 'backend'));
  assert.deepEqual(Object.keys(fork.options.env).filter((key) =>
    key.toUpperCase() === 'AI_TERMINAL_CHAT_CONFIG_DIR'), ['AI_TERMINAL_CHAT_CONFIG_DIR']);
  assert.equal(inheritedEnv.AI_TERMINAL_CHAT_CONFIG_DIR, path.resolve('ordinary-config'));
  assert.equal(inheritedEnv.ai_terminal_chat_config_dir, path.resolve('case-variant-config'));
  assert.equal(fork.options.env.HOME, inheritedEnv.HOME);
  assert.equal(fork.options.env.USERPROFILE, inheritedEnv.USERPROFILE);
  assert.equal(fork.options.env.ACCEPTANCE_SENTINEL, 'inherited');
  assert.equal(fork.options.env.AI_TERMINAL_CHAT_HEALTH_TOKEN.length > 0, true);
  if (failStartup) {
    assert.equal(errors.length, 1);
    assert.equal(windows.length, 0);
    assert.equal(quits, 1);
    // The child exited itself, so cleanup must not attempt to kill a stale handle.
    assert.equal(kills, 0);
  } else if (failRenderer) {
    assert.equal(errors.length, 1);
    assert.equal(quits, 1);
    assert.equal(kills, 1, 'startup failure stops the backend that is already running');
  } else {
    assert.equal(errors.length, 0);
    assert.equal(windows.length, 1);
    events.get('before-quit')();
    events.get('before-quit')();
    assert.equal(kills, 1, 'normal quit stops only the owned backend, once');
  }
  return fork.options.env.AI_TERMINAL_CHAT_CONFIG_DIR;
}

(async () => {
  const first = await runPackagedStartup(path.resolve('profiles', 'temporary profile A'));
  const second = await runPackagedStartup(path.resolve('profiles', 'temporary profile B'));
  assert.notEqual(first, second, 'separate profiles receive separate backend configuration');
  await runPackagedStartup(path.resolve('profiles', 'failed startup'), { failStartup: true });
  await runPackagedStartup(path.resolve('profiles', 'missing renderer'), { failRenderer: true });
  console.log('Bundled backend profile isolation, lifecycle and renderer isolation checks passed.');
})().catch((error) => { console.error(error); process.exitCode = 1; });

// Static regression checks for bundled Electron backend startup and shutdown.
// Real screen-reader and OS-process acceptance is tracked separately in issue #252.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
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

console.log('Bundled backend lifecycle and renderer isolation wiring checks passed.');

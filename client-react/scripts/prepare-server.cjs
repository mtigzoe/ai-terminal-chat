const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const clientDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(clientDir, '..');
const serverDir = path.join(repoRoot, 'server-typescript');
const stagingDir = path.join(clientDir, 'build', 'server');

function runNpm(args, cwd) {
  if (process.platform === 'win32') {
    // npm.cmd is a Windows command script. Running it through cmd.exe avoids
    // spawnSync EINVAL on newer Node versions (including Node 25).
    execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm', ...args], {
      cwd,
      stdio: 'inherit',
      windowsHide: true,
    });
    return;
  }

  execFileSync('npm', args, {
    cwd,
    stdio: 'inherit',
  });
}

function copyRequiredFile(name) {
  const source = path.join(serverDir, name);
  const destination = path.join(stagingDir, name);
  if (!fs.existsSync(source)) {
    throw new Error(`Required server file not found: ${source}`);
  }
  fs.copyFileSync(source, destination);
}

console.log('Building TypeScript backend...');
runNpm(['run', 'build'], serverDir);

fs.rmSync(stagingDir, { recursive: true, force: true });
fs.mkdirSync(stagingDir, { recursive: true });

const distDir = path.join(serverDir, 'dist');
if (!fs.existsSync(path.join(distDir, 'server.js'))) {
  throw new Error(`Compiled backend entry point not found: ${path.join(distDir, 'server.js')}`);
}

fs.cpSync(distDir, path.join(stagingDir, 'dist'), { recursive: true });
copyRequiredFile('package.json');
copyRequiredFile('package-lock.json');

console.log('Installing backend production dependencies in the staging directory...');
runNpm(['ci', '--omit=dev'], stagingDir);

console.log(`TypeScript backend prepared at ${stagingDir}`);

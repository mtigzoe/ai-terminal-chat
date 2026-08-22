const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const clientDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(clientDir, '..');
const serverDir = path.join(repoRoot, 'server-typescript');
const stagingDir = path.join(clientDir, 'build', 'server');

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
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
execFileSync(npmCommand(), ['run', 'build'], {
  cwd: serverDir,
  stdio: 'inherit',
});

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
execFileSync(npmCommand(), ['ci', '--omit=dev'], {
  cwd: stagingDir,
  stdio: 'inherit',
});

console.log(`TypeScript backend prepared at ${stagingDir}`);

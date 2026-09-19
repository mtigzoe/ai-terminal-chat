const fs = require('node:fs');
const path = require('node:path');

const STORE_FILENAME = 'authorized-project-roots.json';

function storePath(userDataDir) {
  return path.join(userDataDir, STORE_FILENAME);
}

function loadAuthorizedProjectRoots(userDataDir) {
  try {
    const raw = fs.readFileSync(storePath(userDataDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => typeof item === 'string' && item.trim())
      .map((item) => {
        try {
          return fs.realpathSync.native(item.trim());
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function saveAuthorizedProjectRoots(userDataDir, roots) {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    const values = Array.from(roots || [])
      .filter((item) => typeof item === 'string' && item.trim())
      .map((item) => item.trim());
    const target = storePath(userDataDir);
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(values, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, target);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  STORE_FILENAME,
  loadAuthorizedProjectRoots,
  saveAuthorizedProjectRoots,
};
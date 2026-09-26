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
  let tempDir;
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    const values = Array.from(roots || [])
      .filter((item) => typeof item === 'string' && item.trim())
      .map((item) => item.trim());
    const target = storePath(userDataDir);

    // Use a private temporary directory and exclusive file creation so a
    // pre-created symlink or other attacker-controlled temp path cannot
    // redirect the authorized-root data to an arbitrary file.
    tempDir = fs.mkdtempSync(path.join(userDataDir, '.authorized-project-roots-'));
    const temp = path.join(tempDir, 'store.tmp');
    fs.writeFileSync(
      temp,
      JSON.stringify(values, null, 2) + '\n',
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    );
    fs.renameSync(temp, target);
    return true;
  } catch {
    return false;
  } finally {
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup only; the authorization write result is
        // determined by the guarded write/rename above.
      }
    }
  }
}

module.exports = {
  STORE_FILENAME,
  loadAuthorizedProjectRoots,
  saveAuthorizedProjectRoots,
};

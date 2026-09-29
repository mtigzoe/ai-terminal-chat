/**
 * Pure security helpers for Electron main process.
 * Extracted for testability and defense-in-depth reuse.
 */

const path = require('node:path');
const fs = require('node:fs');
const { fileURLToPath } = require('node:url');

/**
 * Returns true when `relative` escapes its base directory.
 *
 * `relative.startsWith('..')` is the wrong test: a legitimate in-project
 * entry named `..data` or `..config` produces the relative path
 * `..data/notes.txt`, which starts with ".." but is fully inside the root.
 * Only an exact ".." or a ".." followed by a separator actually escapes.
 */
function isOutsideRoot(relative) {
  if (path.isAbsolute(relative)) return true;
  return relative === '..' || relative.startsWith(`..${path.sep}`);
}

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
      if (isOutsideRoot(relativeParent)) {
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
  // Use path.relative + checks; NEVER use simple startsWith(projectRoot)
  const isWithinRoot = !isOutsideRoot(path.relative(resolvedRoot, resolvedRequested));

  if (!isWithinRoot) {
    throw new Error(`Path is outside project root: ${requestedPath}`);
  }

  return resolvedRequested;
}

/**
 * Returns true only for explicitly safe external URL schemes (http/https).
 * Fail closed on parse errors or any other scheme.
 * Uses the standard URL API; never relies on string prefix checks alone.
 */
function isSafeExternalUrl(urlString) {
  if (typeof urlString !== 'string' || !urlString.trim()) {
    return false;
  }
  try {
    const parsed = new URL(urlString);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Returns true only when a navigation URL is the renderer URL selected by the
 * application. External top-level navigation is blocked so an untrusted page
 * cannot inherit the preload bridge exposed to the renderer.
 */
function isAllowedNavigationUrl(urlString, rendererEntry) {
  if (typeof urlString !== 'string' || !urlString.trim() || !rendererEntry) {
    return false;
  }

  try {
    const parsed = new URL(urlString);

    if (rendererEntry.type === 'url') {
      const expected = new URL(rendererEntry.target);
      return (
        (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
        parsed.origin === expected.origin
      );
    }

    if (rendererEntry.type === 'file') {
      if (parsed.protocol !== 'file:') {
        return false;
      }
      const expectedPath = path.resolve(rendererEntry.target);
      const actualPath = path.resolve(fileURLToPath(parsed));
      if (actualPath === expectedPath) {
        return true;
      }
      // The packaged app is a multi-page app: index.html, history.html,
      // project.html, settings.html and instructions.html are all built into
      // the same dist/ directory and linked from the main nav. Requiring an
      // exact match on the entry document blocked every one of them, so
      // navigation worked in dev (same-origin) but silently did nothing in the
      // packaged desktop app. Allow any document that sits directly in the
      // same directory as the configured entry; this still blocks traversal
      // out of the renderer directory and any external origin.
      if (path.dirname(actualPath) !== path.dirname(expectedPath)) {
        return false;
      }
      return path.extname(actualPath).toLowerCase() === '.html';
    }
  } catch {
    return false;
  }

  return false;
}

/**
 * Returns true only when the requested project root was previously approved
 * through the native directory picker.
 */
function isAuthorizedProjectRoot(requestedPath, authorizedRoots) {
  if (typeof requestedPath !== 'string' || !requestedPath.trim() || !authorizedRoots) {
    return false;
  }
  try {
    const resolved = fs.realpathSync.native(requestedPath.trim());
    return authorizedRoots.has(resolved);
  } catch {
    return false;
  }
}

module.exports = {
  validateProjectPath,
  isSafeExternalUrl,
  isAllowedNavigationUrl,
  isAuthorizedProjectRoot,
};

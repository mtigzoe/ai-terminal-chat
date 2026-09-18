    if (exc instanceof SecurityValidationError) {
      return { error: exc.message };
    }
    const code = (exc as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      return { error: `File already exists: ${relPath}` };
    }
    return { error: `Could not create file: ${exc}` };
  }
}

export function write_file(
  relPath: string,
  contents: string,
  confirm = false
): Record<string, unknown> {
  let filePath: string;
  try {
    filePath = safePath(relPath);
  } catch (exc) {
    return { error: String(exc) };
  }

  if (isSensitivePath(filePath)) {
    return { error: `Refusing to write to sensitive file: ${relPath}` };
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    return { error: `Cannot write to a directory: ${relPath}` };
  }

  const existed = fs.existsSync(filePath);

  if (!confirm) {
    let oldText = "";
    if (existed) {
      try {
        // O_NOFOLLOW fd read — do not follow a final-component symlink to
        // an outside file when building the confirmation diff.
        oldText = readFileWithinProject(relPath, PREVIEW_CHAR_LIMIT * 4).contents;
      } catch {
        oldText = "";
      }
    }

    let diffPreview: string | undefined;
    if (existed) {
      diffPreview = generateUnifiedDiff(
        oldText,
        contents,
        `a/${relPath}`,
        `b/${relPath}`
      ).slice(0, PREVIEW_CHAR_LIMIT);
    }

    return {
      requires_confirmation: true,
      path: relativePath(filePath),
      action: existed ? "overwrite" : "create",
      diff: diffPreview,
      message: `'${relPath}' was NOT written. Show the user the diff and ask them to explicitly confirm this change, then call write_file again with confirm=true.`,
    };
  }

  try {
    const { resolvedPath, bytesWritten } = writeFileWithinProject(relPath, contents, export function delete_file(
  relPath: string,
  confirm = false
): Record<string, unknown> {
  const root = getProjectRoot();
  const lexicalPath = path.resolve(root, relPath.trim());

  // Deleting a symlink must remove the directory entry itself, including
  // dangling links; safePath()/existsSync() follow the link and cannot
  // represent that case.
  let lexicalStat: fs.Stats;
  try {
    lexicalStat = fs.lstatSync(lexicalPath);
  } catch {
    return { error: `File does not exist: ${relPath}` };
  }

  let filePath: string;
  try {
    filePath = safePath(relPath);
  } catch (exc) {
    if (!lexicalStat.isSymbolicLink()) return { error: String(exc) };
    // Validate the symlink target without requiring it to exist.
    try {
      const target = fs.readlinkSync(lexicalPath, "utf8");
      const targetPath = path.resolve(path.dirname(lexicalPath), target);
      const resolvedTarget = fs.realpathSync(path.dirname(targetPath));
      if (!isPathWithinRoot(root, resolvedTarget)) {
        return { error: `Refusing to delete a symlink targeting outside the project: ${relPath}` };
      }
      filePath = lexicalPath;
    } catch (targetError) {
      return { error: `Could not validate symlink: ${targetError instanceof Error ? targetError.message : String(targetError)}` };
    }
  }

  if (isSensitivePath(filePath)) {
    return { error: `Refusing to delete sensitive file: ${relPath}` };
  }

  if (filePath === root) {
    return { error: "Refusing to delete the project root." };
  }

  if (!lexicalStat.isSymbolicLink() && lexicalStat.isDirectory()) {
    return {
      error: "delete_file can only delete a single file, not a directory.",
    };
  }

  if (!confirm) {
    return {
      requires_confirmation: true,
      path: path.relative(root, lexicalPath),
      message: `'${relPath}' was NOT deleted. Ask the user to explicitly confirm this deletion in the chat, then call delete_file again with confirm=true.`,
    };
  }

  try {
    const { resolvedPath } = unlinkWithinProject(relPath);
    return { path: path.relative(root, resolvedPath), deleted: true };
  } catch (exc) {
    if (exc instanceof SecurityValidationError) {
      return { error: exc.message };
    }
    return { error: `Could not delete file: ${exc}` };
  }
}
{
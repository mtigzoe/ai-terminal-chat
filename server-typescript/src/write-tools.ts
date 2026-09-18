    }
  }
  if (isSensitivePath(filePath)) return { error: `Refusing to delete sensitive file: ${relPath}` };
  if (filePath === root) return { error: "Refusing to delete the project root." };
  if (!lexicalStat.isSymbolicLink() && lexicalStat.isDirectory()) return { error: "delete_file can only delete a single file, not a directory." };
  if (!confirm) return { requires_confirmation: true, path: path.relative(root, lexicalPath), message: `'${relPath}' was NOT deleted. Ask the user to explicitly confirm this deletion in the chat, then call delete_file again with confirm=true.` };
  try {
    const { resolvedPath } = unlinkWithinProject(relPath);
    return { path: path.relative(root, resolvedPath), deleted: true };
  } catch (exc) {
    if (exc instanceof SecurityValidationError) return { error: exc.message };
    return { error: `Could not delete file: ${exc}` };
  }
}

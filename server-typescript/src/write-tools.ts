  let filePatches: FilePatch[];
  try {
    filePatches = parseUnifiedDiff(patchText);
  } catch (exc) {
    return { files: [], error: exc instanceof Error ? exc.message : String(exc) };
  }
  if (filePatches.length === 0) {
    return { files: [], error: "Could not parse any file hunks from the patch." };
  }
  if (filePatches.some((fp) => fp.hunks.length === 0)) {
    return { files: [], error: "Patch contains a file header without any hunks." };
  }

  // First validate and compute every file operation without mutating anything.
  // This prevents a multi-file patch from partially applying when a later file
  // has a missing target or hunk mismatch.
  const operations: Array<
    | { kind: "delete"; rel: string }
    | { kind: "write"; rel: string; next: string }
  > = [];

  for (const fp of filePatches) {
    const rel = fp.newPath === "/dev/null" ? fp.oldPath : fp.newPath;
    if (!rel || rel === "/dev/null") {
      return { files: [], error: "Patch entry missing a usable path." };
    }
    if (
      fp.oldPath !== fp.newPath &&
      fp.oldPath !== "/dev/null" &&
      fp.newPath !== "/dev/null"
    ) {
      return {
        files: [],
        error: `Patch path changes/renames are not supported: '${fp.oldPath}' -> '${fp.newPath}'.`,
      };
    }

    try {
      safePath(rel);
    } catch (exc) {
      return { files: [], error: `Invalid path in patch: ${rel}: ${exc}` };
    }

    if (fp.newPath === "/dev/null") {
      try {
        readFileWithinProject(rel, MAX_PATCH_SIZE * 2);
      } catch {
        return { files: [], error: `Patch deletes missing file: ${rel}` };
      }
      operations.push({ kind: "delete", rel });
      continue;
    }

    let current = "";
    if (fp.oldPath !== "/dev/null") {
      try {
        const read = readFileWithinProject(rel, MAX_PATCH_SIZE * 2);
        current = read.contents;
      } catch (exc) {
        return {
          files: [],
          error: `Cannot read '${rel}' to apply patch: ${exc instanceof Error ? exc.message : String(exc)}`,
        };
      }
    }

    let next: string;
    try {
      next = applyHunksToText(current, fp.hunks);
    } catch (exc) {
      return {
        files: [],
        error: `Patch does not apply cleanly to '${rel}': ${exc instanceof Error ? exc.message : String(exc)}`,
      };
    }
    operations.push({ kind: "write", rel, next });
  }

  if (dryRun) return { files: resolvedRel };

  // All parsing, path validation, reads, and hunk application succeeded.
  // Only now begin mutations.
  for (const operation of operations) {
    try {
      assertPatchTargetsNotOutsideSymlinks([operation.rel]);
      if (operation.kind === "delete") {
        unlinkWithinProject(operation.rel);
      } else {
        writeFileWithinProject(operation.rel, operation.next, {});
      }
    } catch (exc) {
      return {
        files: [],
        error: `Failed to ${operation.kind === "delete" ? "delete" : "write"} '${operation.rel}': ${exc instanceof Error ? exc.message : String(exc)}`,
      };
    }
  }

  return { files: resolvedRel };
}

type DiffHunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  newTrailingNewline?: boolean;
  lines: string[]; // including leading ' ', '+', '-'
};

type FilePatch = {
  oldPath: string;
  newPath: string;
  hunks: DiffHunk[];
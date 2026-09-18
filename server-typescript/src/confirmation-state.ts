import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getProjectRoot, safePath } from "./security.ts";

export interface ConfirmationFileState {
  kind?: "file" | "git_index";
  path: string;
  status: "present" | "missing" | "unavailable";
  sha256: string | null;
}

export type ConfirmationFileStates = ConfirmationFileState[];

const MAX_FINGERPRINT_BYTES = 50 * 1024 * 1024;
const GIT_INDEX_MARKER = "__git_index__";

function fingerprintFile(relPath: string): ConfirmationFileState {
  const normalized = String(relPath);
  try {
    const resolved = safePath(normalized);
    if (!fs.existsSync(resolved)) {
      return { path: normalized, status: "missing", sha256: null };
    }
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size > MAX_FINGERPRINT_BYTES) {
      return { path: normalized, status: "unavailable", sha256: null };
    }
    const bytes = fs.readFileSync(resolved);
    return {
      path: normalized,
      status: "present",
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    };
  } catch {
    return { path: normalized, status: "unavailable", sha256: null };
  }
}

function fingerprintGitIndex(): ConfirmationFileState {
  try {
    const gitEntry = path.join(getProjectRoot(), ".git");
    let gitDir = gitEntry;
    if (fs.lstatSync(gitEntry).isFile()) {
      const match = fs.readFileSync(gitEntry, "utf8").match(/^gitdir:\s*(.+)\s*$/im);
      if (!match) {
        return { kind: "git_index", path: GIT_INDEX_MARKER, status: "unavailable", sha256: null };
      }
      const target = match[1]!.trim();
      gitDir = path.resolve(getProjectRoot(), target);
    }
    const indexPath = path.join(gitDir, "index");
    if (!fs.existsSync(indexPath)) {
      return { kind: "git_index", path: GIT_INDEX_MARKER, status: "missing", sha256: null };
    }
    const bytes = fs.readFileSync(indexPath);
    return {
      kind: "git_index",
      path: GIT_INDEX_MARKER,
      status: "present",
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    };
  } catch {
    return { kind: "git_index", path: GIT_INDEX_MARKER, status: "unavailable", sha256: null };
  }
}

export function captureConfirmationFileStates(paths: string[]): ConfirmationFileStates {
  const unique = [...new Set(paths.map((value) => String(value)).filter(Boolean))];
  return unique.map((value) =>
    value === GIT_INDEX_MARKER ? fingerprintGitIndex() : fingerprintFile(value),
  );
}

export function confirmationFileStatesMatch(
  expected: ConfirmationFileStates,
): boolean {
  return expected.every((state) => {
    if (state.status === "unavailable") return false;
    const current =
      state.kind === "git_index"
        ? fingerprintGitIndex()
        : fingerprintFile(state.path);
    return current.status === state.status && current.sha256 === state.sha256;
  });
}

function patchTargetPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const line of patch.split(/\n/)) {
    const diffGit = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (diffGit) {
      const oldPath = diffGit[1]?.trim();
      const newPath = diffGit[2]?.trim();
      if (oldPath) paths.push(oldPath);
      if (newPath) paths.push(newPath);
      continue;
    }
    for (const prefix of ["--- a/", "+++ b/"]) {
      if (!line.startsWith(prefix)) continue;
      const candidate = line.slice(prefix.length).split("\t")[0]?.trim();
      if (candidate && candidate !== "/dev/null") paths.push(candidate);
      break;
    }
  }
  return [...new Set(paths)];
}

export function confirmationPathsForPending(
  toolName: string,
  args: Record<string, unknown>,
): string[] {
  if (
    toolName === "create_file" ||
    toolName === "write_file" ||
    toolName === "delete_file" ||
    toolName === "git_add" ||
    toolName === "git_restore"
  ) {
    const target = typeof args.path === "string" ? args.path.trim() : "";
    return target ? [target] : [];
  }
  if (toolName === "git_commit") return [GIT_INDEX_MARKER];
  if (toolName === "apply_patch") {
    return patchTargetPaths(typeof args.patch === "string" ? args.patch : "");
  }
  return [];
}

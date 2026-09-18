import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getProjectRoot, isPathWithinRoot, safePath } from "./security.ts";

export interface ConfirmationFileState {
  kind?: "file" | "git_index" | "git_head" | "git_remote";
  path: string;
  status: "present" | "missing" | "unavailable";
  sha256: string | null;
}

export type ConfirmationFileStates = ConfirmationFileState[];

const MAX_FINGERPRINT_BYTES = 50 * 1024 * 1024;
const GIT_INDEX_MARKER = "__git_index__";
const GIT_HEAD_MARKER = "__git_head__";
const GIT_PUSH_HEAD_PREFIX = "__git_push_head__:";
const GIT_REMOTE_PREFIX = "__git_remote__:";

function fingerprintFile(relPath: string): ConfirmationFileState {
  const normalized = String(relPath);
  try {
    // Confirmation must bind the requested directory entry, not a symlink's
    // target. Otherwise a symlink can be retargeted to a different file with
    // identical contents and the original confirmation would still validate.
    const lexicalPath = path.resolve(getProjectRoot(), normalized);
    const lexicalStat = fs.lstatSync(lexicalPath);
    if (lexicalStat.isSymbolicLink()) {
      // A write through a symlink changes its resolved target. Bind both the
      // link target and the target contents so approval cannot overwrite
      // changes made after the preview was generated.
      const target = fs.readlinkSync(lexicalPath, "utf8");
      let resolvedTarget: string;
      try {
        resolvedTarget = safePath(normalized);
      } catch {
        // Dangling in-project symlinks are valid delete targets. Bind the
        // link itself so a pending deletion remains confirmable without
        // pretending its missing target is writable.
        const payload = Buffer.from("symlink\\0" + target, "utf8");
        return {
          path: normalized,
          status: "present",
          sha256: crypto.createHash("sha256").update(payload).digest("hex"),
        };
      }
      let targetStat: fs.Stats;
      try {
        targetStat = fs.statSync(resolvedTarget);
      } catch {
        const payload = Buffer.from("symlink\\0" + target, "utf8");
        return {
          path: normalized,
          status: "present",
          sha256: crypto.createHash("sha256").update(payload).digest("hex"),
        };
      }
      if (!targetStat.isFile() || targetStat.size > MAX_FINGERPRINT_BYTES) {
        const payload = Buffer.from("symlink\\0" + target, "utf8");
        return {
          path: normalized,
          status: "present",
          sha256: crypto.createHash("sha256").update(payload).digest("hex"),
        };
      }
      const targetBytes = fs.readFileSync(resolvedTarget);
      const payload = Buffer.concat([
        Buffer.from("symlink\\0" + target + "\\0target\\0", "utf8"),
        targetBytes,
      ]);
      return {
        path: normalized,
        status: "present",
        sha256: crypto.createHash("sha256").update(payload).digest("hex"),
      };
    }
    let resolved: string;
    try {
      resolved = safePath(normalized);
    } catch {
      // safePath() requires the final target to exist. For a missing file
      // below an existing in-project symlinked directory, resolve the parent
      // separately so the confirmation still binds to the actual location.
      try {
        // Resolve the existing parent directory through the filesystem. The
        // final component is intentionally kept lexical because it is absent.
        const root = getProjectRoot();
        const parent = fs.realpathSync(path.dirname(lexicalPath));
        if (!isPathWithinRoot(root, parent)) throw new Error("parent outside project");
        resolved = path.join(parent, path.basename(lexicalPath));
      } catch {
        return { path: normalized, status: "unavailable", sha256: null };
      }
    }
    if (!fs.existsSync(resolved)) {
      // A missing target can still be created later. Bind its resolved parent
      // location so retargeting an in-project symlink in the parent directory
      // cannot move the confirmed write to a different location.
      const payload = Buffer.from("missing\\0" + resolved, "utf8");
      return {
        path: normalized,
        status: "missing",
        sha256: crypto.createHash("sha256").update(payload).digest("hex"),
      };
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

function fingerprintGitHead(branch?: string): ConfirmationFileState {
  const marker = branch ? `${GIT_PUSH_HEAD_PREFIX}${branch}` : GIT_HEAD_MARKER;
  try {
    const gitEntry = path.join(getProjectRoot(), ".git");
    let gitDir = gitEntry;
    if (fs.lstatSync(gitEntry).isFile()) {
      const match = fs.readFileSync(gitEntry, "utf8").match(/^gitdir:\s*(.+)\s*$/im);
      if (!match) return { kind: "git_head", path: marker, status: "unavailable", sha256: null };
      const target = match[1]!.trim();
      gitDir = path.resolve(getProjectRoot(), target);
    }

    const headPath = path.join(gitDir, "HEAD");
    const head = fs.readFileSync(headPath, "utf8");
    // Git push accepts the symbolic ref name HEAD as a source. It must
    // bind to the current HEAD contents, not to a hypothetical
    // refs/heads/HEAD file. Otherwise a confirmed `git push ... HEAD`
    // could silently push a different commit after the preview.
    const isSymbolicHead = branch === "HEAD";
    // git push accepts both short branch names and fully qualified refs such as
    // refs/heads/main. Bind the confirmation to the ref Git will actually read.
    const ref = branch && !isSymbolicHead
      ? (branch.startsWith("refs/") ? branch : `refs/heads/${branch}`)
      : /^ref:\s*(.+)\s*$/.exec(head)?.[1]?.trim();

    if (!ref || !/^[A-Za-z0-9._/-]+$/.test(ref)) {
      return {
        kind: "git_head",
        path: marker,
        status: "present",
        sha256: crypto.createHash("sha256").update(head).digest("hex"),
      };
    }

    let refState = "";
    const refPath = path.join(gitDir, ...ref.split("/"));
    try {
      refState = fs.readFileSync(refPath, "utf8");
    } catch {
      try {
        const packed = fs.readFileSync(path.join(gitDir, "packed-refs"), "utf8");
        const packedRef = packed.split(/\r?\n/).find((line) => {
          const match = /^([0-9a-f]{40,64})\s+(\S+)$/.exec(line);
          return match?.[2] === ref;
        });
        refState = packedRef ?? "<missing-ref>";
      } catch {
        refState = "<missing-ref>";
      }
    }

    const state = branch && !isSymbolicHead ? refState : head + "\n" + refState;
    return {
      kind: "git_head",
      path: marker,
      status: "present",
      sha256: crypto.createHash("sha256").update(state).digest("hex"),
    };
  } catch {
    return { kind: "git_head", path: marker, status: "unavailable", sha256: null };
  }
}

function fingerprintGitRemote(remote: string): ConfirmationFileState {
  const marker = GIT_REMOTE_PREFIX + remote;
  try {
    const gitEntry = path.join(getProjectRoot(), ".git");
    let gitDir = gitEntry;
    if (fs.lstatSync(gitEntry).isFile()) {
      const match = fs.readFileSync(gitEntry, "utf8").match(/^gitdir:\s*(.+)\s*$/im);
      if (!match) return { kind: "git_remote", path: marker, status: "unavailable", sha256: null };
      gitDir = path.resolve(getProjectRoot(), match[1]!.trim());
    }
    if (!remote || (remote !== "<default>" && !/^[\w.-]+$/.test(remote))) {
      return { kind: "git_remote", path: marker, status: "unavailable", sha256: null };
    }
    // In linked worktrees, remote definitions normally live in the
    // common repository config rather than the per-worktree gitdir. Bind the
    // confirmation to both so changing a remote URL cannot invalidate neither
    // the preview nor the confirmed push/pull target.
    let commonDir = gitDir;
    const commondirPath = path.join(gitDir, "commondir");
    if (fs.existsSync(commondirPath)) {
      const commonRef = fs.readFileSync(commondirPath, "utf8").trim();
      if (!commonRef) {
        return { kind: "git_remote", path: marker, status: "unavailable", sha256: null };
      }
      commonDir = path.resolve(gitDir, commonRef);
    }
    const configPaths = [
      path.join(commonDir, "config"),
      path.join(gitDir, "config.worktree"),
    ];
    const configParts: string[] = [];
    for (const configPath of configPaths) {
      if (!fs.existsSync(configPath)) continue;
      const stat = fs.lstatSync(configPath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        return { kind: "git_remote", path: marker, status: "unavailable", sha256: null };
      }
      configParts.push(configPath.endsWith("config.worktree") ? "\0worktree\0" : "\0config\0");
      configParts.push(fs.readFileSync(configPath, "utf8"));
    }

    // Git also supports legacy file-based remotes in $GIT_DIR/remotes and
    // $GIT_DIR/branches. Those files can change the destination/refspec
    // without changing .git/config, so bind the confirmation to their full
    // direct-file contents as well.
    for (const directoryName of ["remotes", "branches"]) {
      const directoryPath = path.join(gitDir, directoryName);
      if (!fs.existsSync(directoryPath)) {
        configParts.push(`\\0${directoryName}:missing\\0`);
        continue;
      }
      const directoryStat = fs.lstatSync(directoryPath);
      if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
        return { kind: "git_remote", path: marker, status: "unavailable", sha256: null };
      }
      const entries = fs.readdirSync(directoryPath).sort();
      configParts.push(`\\0${directoryName}:entries\\0`);
      for (const entry of entries) {
        const entryPath = path.join(directoryPath, entry);
        const entryStat = fs.lstatSync(entryPath);
        if (entryStat.isSymbolicLink() || !entryStat.isFile()) {
          return { kind: "git_remote", path: marker, status: "unavailable", sha256: null };
        }
        configParts.push(`\\0${directoryName}/${entry}\\0`);
        configParts.push(fs.readFileSync(entryPath, "utf8"));
      }
    }

    return {
      kind: "git_remote",
      path: marker,
      status: "present",
      sha256: crypto.createHash("sha256").update(configParts.join("")).digest("hex"),
    };
  } catch {
    return { kind: "git_remote", path: marker, status: "unavailable", sha256: null };
  }
}
export function captureConfirmationFileStates(paths: string[]): ConfirmationFileStates {
  const unique = [...new Set(paths.map((value) => String(value)).filter(Boolean))];
  return unique.map((value) =>
    value === GIT_INDEX_MARKER
      ? fingerprintGitIndex()
      : value === GIT_HEAD_MARKER
        ? fingerprintGitHead()
        : value.startsWith(GIT_PUSH_HEAD_PREFIX)
          ? fingerprintGitHead(value.slice(GIT_PUSH_HEAD_PREFIX.length))
          : value.startsWith(GIT_REMOTE_PREFIX)
            ? fingerprintGitRemote(value.slice(GIT_REMOTE_PREFIX.length))
            : fingerprintFile(value),
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
        : state.kind === "git_head"
          ? fingerprintGitHead(state.path.startsWith(GIT_PUSH_HEAD_PREFIX) ? state.path.slice(GIT_PUSH_HEAD_PREFIX.length) : undefined)
          : state.kind === "git_remote"
            ? fingerprintGitRemote(state.path.slice(GIT_REMOTE_PREFIX.length))
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
    if (!target) return [];
    if (toolName === "git_add") {
      return [target, GIT_INDEX_MARKER];
    }
    if (toolName === "git_restore") {
      return args.staged === true
        ? [GIT_HEAD_MARKER, GIT_INDEX_MARKER]
        : [target, GIT_INDEX_MARKER];
    }
    return [target];
  }
  if (toolName === "git_commit") return [GIT_INDEX_MARKER];
  if (toolName === "git_push") {
    const branch = typeof args.branch === "string" ? args.branch.trim() : "";
    const remote = typeof args.remote === "string" ? args.remote.trim() : "";
    return [
      branch && /^[A-Za-z0-9._/-]+$/.test(branch) ? `${GIT_PUSH_HEAD_PREFIX}${branch}` : GIT_HEAD_MARKER,
      remote && /^[\w.-]+$/.test(remote) ? `${GIT_REMOTE_PREFIX}${remote}` : `${GIT_REMOTE_PREFIX}<default>`,
    ];
  }
  if (toolName === "git_pull") {
    const remote = typeof args.remote === "string" ? args.remote.trim() : "";
    return [
      GIT_HEAD_MARKER,
      GIT_INDEX_MARKER,
      remote && /^[\w.-]+$/.test(remote) ? `${GIT_REMOTE_PREFIX}${remote}` : `${GIT_REMOTE_PREFIX}<default>`,
    ];
  }
  if (toolName === "apply_patch") {
    return patchTargetPaths(typeof args.patch === "string" ? args.patch : "");
  }
  return [];
}

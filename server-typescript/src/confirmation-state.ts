import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getProjectRoot, isPathWithinRoot, safePath } from "./security.ts";
import { extractPatchTargetPaths } from "./write-tools.ts";

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

/**
 * Return the git directory for a project root, handling worktree `.git`
 * files and, like the real `git` binary (and like this codebase's own
 * git-tool subprocess calls, which pass the project root as cwd and let
 * git discover the repo from there), a project root that is a
 * *subdirectory* of the actual repository: walk upward until a `.git`
 * entry is found or the filesystem root is reached.
 *
 * Without this, scoping the project to a subfolder of a larger repo
 * made every git-index/HEAD/remote fingerprint read "unavailable" —
 * which pop_pending's TypeScript counterpart treats as untrustworthy
 * and always refuses — so no git_add/git_commit/git_push/etc.
 * confirmation could ever succeed there, even though the underlying git
 * commands themselves work fine from that same directory. Mirrors
 * server-python's pending.py _resolve_git_dir.
 */
function resolveGitDir(root: string): string | null {
  let current = path.resolve(root);
  for (;;) {
    const gitEntry = path.join(current, ".git");
    let entryStat: fs.Stats;
    try {
      entryStat = fs.lstatSync(gitEntry);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
      continue;
    }
    if (entryStat.isFile()) {
      const match = fs.readFileSync(gitEntry, "utf8").match(/^gitdir:\s*(.+)\s*$/im);
      if (!match) return null;
      return path.resolve(current, match[1]!.trim());
    }
    // Not a worktree pointer file: treat as (or a symlink to) the git
    // directory itself, same as the original single-level lookup did.
    return gitEntry;
  }
}

function fingerprintFile(relPath: string): ConfirmationFileState {
  const normalized = String(relPath);
  try {
    // Confirmation must bind the requested directory entry, not a symlink's
    // target. Otherwise a symlink can be retargeted to a different file with
    // identical contents and the original confirmation would still validate.
    const lexicalPath = path.resolve(getProjectRoot(), normalized);
    let lexicalStat: fs.Stats | undefined;
    try {
      lexicalStat = fs.lstatSync(lexicalPath);
    } catch (error) {
      // A missing final component is expected for write confirmations; keep
      // resolving its existing parent instead of treating lstat ENOENT as an
      // unavailable fingerprint.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (lexicalStat?.isSymbolicLink()) {
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
        const payload = Buffer.from("symlink\0" + target, "utf8");
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
        const payload = Buffer.from("symlink\0" + target, "utf8");
        return {
          path: normalized,
          status: "present",
          sha256: crypto.createHash("sha256").update(payload).digest("hex"),
        };
      }
      if (!targetStat.isFile() || targetStat.size > MAX_FINGERPRINT_BYTES) {
        const payload = Buffer.from("symlink\0" + target, "utf8");
        return {
          path: normalized,
          status: "present",
          sha256: crypto.createHash("sha256").update(payload).digest("hex"),
        };
      }
      const targetBytes = fs.readFileSync(resolvedTarget);
      const payload = Buffer.concat([
        Buffer.from("symlink\0" + target + "\0target\0", "utf8"),
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
      const payload = Buffer.from("missing\0" + resolved, "utf8");
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
    const gitDir = resolveGitDir(getProjectRoot());
    if (!gitDir) {
      return { kind: "git_index", path: GIT_INDEX_MARKER, status: "unavailable", sha256: null };
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
    const gitDir = resolveGitDir(getProjectRoot());
    if (!gitDir) return { kind: "git_head", path: marker, status: "unavailable", sha256: null };

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
    const gitDir = resolveGitDir(getProjectRoot());
    if (!gitDir) return { kind: "git_remote", path: marker, status: "unavailable", sha256: null };
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
        configParts.push(`\0${directoryName}:missing\0`);
        continue;
      }
      const directoryStat = fs.lstatSync(directoryPath);
      if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
        return { kind: "git_remote", path: marker, status: "unavailable", sha256: null };
      }
      const entries = fs.readdirSync(directoryPath).sort();
      configParts.push(`\0${directoryName}:entries\0`);
      for (const entry of entries) {
        const entryPath = path.join(directoryPath, entry);
        const entryStat = fs.lstatSync(entryPath);
        if (entryStat.isSymbolicLink() || !entryStat.isFile()) {
          return { kind: "git_remote", path: marker, status: "unavailable", sha256: null };
        }
        configParts.push(`\0${directoryName}/${entry}\0`);
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

export function confirmationPathsForPending(
  toolName: string,
  args: Record<string, unknown>,
): string[] {
  if (toolName === "git_restore") {
    // staged is checked before looking at path (and a missing/blank path
    // still falls back to GIT_INDEX_MARKER) so that a malformed call
    // missing its required "path" doesn't fall through to the shared
    // empty-target check below and end up with *no* binding at all —
    // that would make the pending action unconditionally confirmable
    // regardless of what changed in the meantime. Mirrors
    // server-python's _confirmation_paths_for_pending.
    if (args.staged === true) return [GIT_HEAD_MARKER, GIT_INDEX_MARKER];
    const target = typeof args.path === "string" ? args.path.trim() : "";
    return target ? [target, GIT_INDEX_MARKER] : [GIT_INDEX_MARKER];
  }
  if (
    toolName === "create_file" ||
    toolName === "write_file" ||
    toolName === "delete_file" ||
    toolName === "git_add"
  ) {
    const target = typeof args.path === "string" ? args.path.trim() : "";
    if (!target) return [];
    if (toolName === "git_add") {
      return [target, GIT_INDEX_MARKER];
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
    // Reuses write-tools.ts's own patch-header parser (the one that
    // actually validates/safe-checks each target before applying)
    // rather than maintaining a second, independent copy here: a
    // regex that silently drifts from the authoritative one would mean
    // confirmation fingerprinting protects a different set of files
    // than the ones apply_patch actually validated and is about to
    // touch (server-python mirrors this by fingerprinting apply_patch's
    // own preview["files"], which is the same resolved list it used
    // for validation and eventual git apply).
    return extractPatchTargetPaths(typeof args.patch === "string" ? args.patch : "");
  }
  return [];
}

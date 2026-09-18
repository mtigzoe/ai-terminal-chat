import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getProjectRoot, safePath } from "./security.ts";

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
    const ref = branch
      ? `refs/heads/${branch}`
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

    const state = branch ? refState : head + "\n" + refState;
    return {
      kind: "git_head",
      path: marker,
      status: "present",
      sha256: crypto.createHash("sha256").update(state).digest("hex"),
    };
  } catch {
    return { kind: "git_head", path: marker, status: "unavailable", sha256: null };
  }
}function fingerprintGitRemote(remote: string): ConfirmationFileState {
  const marker = GIT_REMOTE_PREFIX + remote;
  try {
    const gitEntry = path.join(getProjectRoot(), ".git");
    let gitDir = gitEntry;
    if (fs.lstatSync(gitEntry).isFile()) {
      const match = fs.readFileSync(gitEntry, "utf8").match(/^gitdir:\s*(.+)\s*$/im);
      if (!match) return { kind: "git_remote", path: marker, status: "unavailable", sha256: null };
      gitDir = path.resolve(getProjectRoot(), match[1]!.trim());
    }
    const config = fs.readFileSync(path.join(gitDir, "config"), "utf8");
    if (remote === "<default>") {
      return { kind: "git_remote", path: marker, status: "present", sha256: crypto.createHash("sha256").update(config).digest("hex") };
    }
    if (!/^[\w.-]+$/.test(remote) || !remote) {
      return { kind: "git_remote", path: marker, status: "unavailable", sha256: null };
    }
    const lines = config.split(/\r?\n/);
    let inRemote = false;
    const urls: string[] = [];
    const pushUrls: string[] = [];
    let fetch = "";
    for (const line of lines) {
      const section = /^\s*\[remote\s+"([^"]+)"\]\s*$/.exec(line);
      if (section) {
        inRemote = section[1] === remote;
        continue;
      }
      if (/^\s*\[/.test(line)) {
        inRemote = false;
        continue;
      }
      if (!inRemote) continue;
      const url = /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
      if (url) { urls.push(url[1]!.trim()); continue; }
      const pushUrl = /^\s*pushurl\s*=\s*(.+?)\s*$/.exec(line);
      if (pushUrl) { pushUrls.push(pushUrl[1]!.trim()); continue; }
      const fetchValue = /^\s*fetch\s*=\s*(.+?)\s*$/.exec(line);
      if (fetchValue) fetch = fetchValue[1]!.trim();
    }
    const state = JSON.stringify({ urls, pushUrls, fetch });
    return { kind: "git_remote", path: marker, status: "present", sha256: crypto.createHash("sha256").update(state).digest("hex") };
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
        : [target, GIT_HEAD_MARKER];
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

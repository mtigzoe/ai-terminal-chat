// Git inspection and confirmation-required Git operations.
  //
  // Mirrors the Git portion of server-python/tools.py. Read-only operations
  // never mutate repository state. gitAdd() uses an explicit preview/confirm
  // flag and stages exactly one non-sensitive file.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getAllowedReadPaths, getProjectRoot, isReadAllowed, isSensitivePath, safePath, writeFileWithinProject, openWithinProject } from "./security.ts";
import { resolveTrustedExecutable } from "./trusted-exec.ts";

const execFileAsync = promisify(execFile);

export const GIT_CONFIG_OVERRIDES: string[] = [
  "-c", "core.hooksPath=", "-c", "core.fsmonitor=", "-c", "core.fsmonitorHook=",
  "-c", "core.useBuiltinFSMonitor=false", "-c", "core.editor=true", "-c", "sequence.editor=true",
  "-c", "core.askPass=", "-c", "core.gitProxy=none", "-c", "core.sshCommand=",
  "-c", "core.pager=cat", "-c", "pager.status=cat", "-c", "pager.diff=cat", "-c", "pager.log=cat",
  "-c", "pager.show=cat", "-c", "pager.branch=cat", "-c", "pager.tag=cat", "-c", "interactive.diffFilter=",
  "-c", "diff.external=", "-c", "diff.tool=", "-c", "diff.guitool=", "-c", "diff.mnemonicPrefix=false",
  "-c", "merge.tool=", "-c", "merge.guitool=", "-c", "mergetool.prompt=false",
  "-c", "gpg.program=", "-c", "gpg.ssh.program=", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false",
  "-c", "credential.helper=", "-c", "credential.useHttpPath=false", "-c", "sendemail.smtpserver=",
  "-c", "sendemail.smtpencryption=", "-c", "sendemail.smtpuser=", "-c", "sendemail.smtppass=",
  "-c", "sendemail.smtpdomain=", "-c", "sendemail.smtpServer=", "-c", "http.proxy=",
  "-c", "http.https.proxy=", "-c", "http.extraHeader=", "-c", "http.proxyAuthMethod=",
  "-c", "http.version=", "-c", "http.lowSpeedLimit=0", "-c", "http.lowSpeedTime=0", "-c", "remote.helper=",
  "-c", "alias.status=", "-c", "alias.stat=", "-c", "alias.st=", "-c", "alias.diff=", "-c", "alias.log=",
  "-c", "alias.branch=", "-c", "alias.show=", "-c", "alias.remote=", "-c", "alias.fetch=", "-c", "alias.pull=",
  "-c", "alias.push=", "-c", "alias.add=", "-c", "alias.commit=", "-c", "alias.restore=", "-c", "alias.checkout=",
  "-c", "alias.reset=", "-c", "alias.rev-parse=", "-c", "alias.ls-files=", "-c", "alias.ls-tree=",
  "-c", "trace2.normalTarget=", "-c", "trace2.perfTarget=", "-c", "trace2.eventTarget=",
] as const;

export const ISOLATED_GIT_SUBCOMMANDS = [
  "status", "diff", "log", "branch", "show", "remote", "fetch", "pull", "push", "add", "commit", "restore", "rev-parse",
] as const;

function validateGitRemote(remote: string): string {
  if (!remote || !remote.trim()) throw new Error("Remote name is required");
  const trimmed = remote.trim();
  if (trimmed.startsWith("-")) throw new Error("Remote name cannot start with '-' (reserved for Git options)");
  if (!/^[\w.-]+$/.test(trimmed)) throw new Error(`Invalid remote name: '${trimmed}'. Use alphanumeric, dash, underscore, or dot.`);
  return trimmed;
}

function validateGitBranch(branch: string): string {
  if (!branch || !branch.trim()) throw new Error("Branch name is required");
  const trimmed = branch.trim();
  if (trimmed.startsWith("-")) throw new Error("Branch name cannot start with '-' (reserved for Git options)");
  if (/[\s~^:?*[\\]/.test(trimmed)) throw new Error(`Invalid branch name: '${trimmed}'. Contains disallowed characters.`);
  if (trimmed.includes("..") || trimmed.startsWith("/") || trimmed.endsWith("/") || trimmed.endsWith(".lock")) throw new Error(`Invalid branch name: '${trimmed}'.`);
  return trimmed;
}

function safeValidate<T>(validator: (input: string) => T, input: string): { error: string } | { value: T } {
  try { return { value: validator(input) }; }
  catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
}

const GIT_STATUS_TIMEOUT_MS = 10_000;
const GIT_DIFF_TIMEOUT_MS = 10_000;
const GIT_LOG_TIMEOUT_MS = 10_000;
const GIT_BRANCH_TIMEOUT_MS = 10_000;
const GIT_ADD_TIMEOUT_MS = 15_000;
const GIT_FETCH_TIMEOUT_MS = 15_000;
const GIT_PULL_TIMEOUT_MS = 30_000;
const GIT_RESTORE_TIMEOUT_MS = 15_000;
const GIT_COMMIT_TIMEOUT_MS = 15_000;
const GIT_PUSH_TIMEOUT_MS = 30_000;
const GIT_FETCH_MAX_CHARS = 10_000;
const GIT_PULL_MAX_CHARS = 10_000;
const GIT_RESTORE_MAX_CHARS = 10_000;
const GIT_COMMIT_MAX_CHARS = 10_000;
const GIT_PUSH_MAX_CHARS = 10_000;
const GIT_STATUS_MAX_CHARS = 20_000;
const GIT_LOG_MAX_CHARS = 20_000;
const GIT_BRANCH_MAX_CHARS = 20_000;
const GIT_DIFF_MAX_CHARS = 50_000;

function cap(value: string, limit: number): { value: string; truncated: boolean } { return { value: value.slice(0, limit), truncated: value.length > limit }; }
function errorText(error: unknown): string {
  const value = error as NodeJS.ErrnoException & { stderr?: string };
  if (value.code === "ENOENT") return "git is not installed or not on PATH.";
  if (value.stderr) return String(value.stderr).trim();
  return value.message ?? String(error);
}

async function readGitIdentityValue(scope: "--local" | "--global", key: "user.name" | "user.email"): Promise<string | undefined> {
  const env = { ...process.env };
  delete env.GIT_CONFIG; delete env.GIT_CONFIG_GLOBAL; delete env.GIT_CONFIG_SYSTEM; delete env.GIT_CONFIG_NOSYSTEM;
  try {
    const gitExecutable = resolveTrustedExecutable("git", { projectRoot: getProjectRoot() });
    const result = await execFileAsync(gitExecutable, [scope, "--no-includes", "--get", key], {
      cwd: getProjectRoot(), shell: false, timeout: 5_000, windowsHide: true, maxBuffer: 8_192, encoding: "utf8", env,
    });
    const value = String(result.stdout ?? "").trim();
    if (!value || value.length > 256 || /[\u0000\r\n]/.test(value)) return undefined;
    return value;
  } catch { return undefined; }
}

async function getSafeCommitIdentity(): Promise<{ name?: string; email?: string }> {
  const name = process.env.GIT_COMMITTER_NAME ?? process.env.GIT_AUTHOR_NAME ?? await readGitIdentityValue("--local", "user.name") ?? await readGitIdentityValue("--global", "user.name");
  const email = process.env.GIT_COMMITTER_EMAIL ?? process.env.GIT_AUTHOR_EMAIL ?? await readGitIdentityValue("--local", "user.email") ?? await readGitIdentityValue("--global", "user.email");
  return { name, email };
}

export function getGitSshCommand(): string {
  return process.platform === "win32" ? "ssh -F NUL -o ProxyCommand=none -o ProxyJump=none" : "ssh -F /dev/null -o ProxyCommand=none -o ProxyJump=none";
}

export interface IsolatedGitOptions {
  timeout?: number;
  maxBuffer?: number;
  skipDynamicOverrides?: boolean;
  holdLock?: boolean;
  input?: string | Buffer;
}

class GitOperationMutex {
  private chain: Promise<unknown> = Promise.resolve();
  private depth = 0;
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => { this.depth++; try { return await fn(); } finally { this.depth--; } }, async () => { this.depth++; try { return await fn(); } finally { this.depth--; } });
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }
  get isHeld(): boolean { return this.depth > 0; }
}

const gitOperationMutex = new GitOperationMutex();
export function withGitOperationLockForTests<T>(fn: () => Promise<T>): Promise<T> { return gitOperationMutex.runExclusive(fn); }
export function isGitOperationLockHeldForTests(): boolean { return gitOperationMutex.isHeld; }

const DYNAMIC_OVERRIDE_KEY_RE = /^(filter\..+\.(clean|smudge|process|required)|url\..+\.(insteadof|pushinsteadof)|include\.path|includeif\..+\.path|merge\..+\.driver|remote\..+\.(uploadpack|receivepack)|diff\..+\.textconv|submodule\..+\.update)$/i;

function parseGitConfigKeys(content: string): string[] {
  const keys: string[] = [];
  let section = "";
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      const body = sectionMatch[1]!.trim();
      const withSub = body.match(/^(\S+)\s+"(.*)"$/);
      section = withSub ? `${withSub[1]!.toLowerCase()}.${withSub[2]!}` : body.toLowerCase();
      continue;
    }
    const kv = line.match(/^([^=]+)=(.*)$/);
    if (kv && section) keys.push(`${section}.${kv[1]!.trim().toLowerCase()}`);
  }
  return keys;
}

async function dynamicConfigOverrides(): Promise<string[]> {
  const { readFileSync, existsSync } = await import("node:fs");
  const root = getProjectRoot();
  const candidates = [join(root, ".git", "config"), join(root, ".git", "config.worktree")];
  try {
    const gitFile = join(root, ".git");
    if (existsSync(gitFile)) {
      const { statSync } = await import("node:fs");
      if (statSync(gitFile).isFile()) {
        const text = readFileSync(gitFile, "utf8");
        const m = text.match(/gitdir:\s*(.+)/i);
        if (m) {
          const gitdir = m[1]!.trim();
          const abs = gitdir.startsWith("/") || /^[A-Za-z]:[\\/]/.test(gitdir) ? gitdir : join(root, gitdir);
          candidates.push(join(abs, "config"), join(abs, "config.worktree"));
        }
      }
    }
  } catch { }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue;
      for (const key of parseGitConfigKeys(readFileSync(file, "utf8"))) {
        if (!DYNAMIC_OVERRIDE_KEY_RE.test(key) || seen.has(key)) continue;
        seen.add(key); out.push("-c", `${key}=`);
      }
    } catch { }
  }
  return out;
}

export function stripDangerousGitConfig(content: string): string {
  const lines = content.split(/\r?\n/); const out: string[] = []; let skipping = false;
  for (const raw of lines) {
    const trimmed = raw.trim(); const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      const body = sectionMatch[1]!.trim().toLowerCase();
      if (body.startsWith("url ") || body === "url" || body.startsWith("filter ") || body === "filter") { skipping = true; continue; }
      skipping = false; out.push(raw); continue;
    }
    if (skipping) continue;
    if (/^include\.path\s*=/i.test(trimmed) || /^includepath\s*=/i.test(trimmed)) continue;
    out.push(raw);
  }
  const lines2 = out.join("\n").split(/\r?\n/); const out2: string[] = []; skipping = false;
  for (const raw of lines2) {
    const trimmed = raw.trim(); const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      const body = sectionMatch[1]!.trim().toLowerCase();
      if (body === "include" || body.startsWith("includeif ")) { skipping = true; continue; }
      skipping = false; out2.push(raw); continue;
    }
    if (skipping) continue; out2.push(raw);
  }
  return out2.join("\n");
}

async function withSanitizedGitConfig<T>(fn: () => Promise<T>): Promise<T> {
  return gitOperationMutex.runExclusive(async () => {
    const { readFileSync, writeFileSync, existsSync, lstatSync, realpathSync } = await import("node:fs");
    const root = getProjectRoot();
    const gitEntry = join(root, ".git");
    let gitDir: string;
    const gitStat = lstatSync(gitEntry);
    if (gitStat.isDirectory()) {
      gitDir = realpathSync(gitEntry);
    } else if (gitStat.isFile()) {
      const gitFile = readFileSync(gitEntry, "utf8");
      const match = gitFile.match(/^gitdir:\s*(.+)\s*$/im);
      if (!match) throw new Error("Invalid .git gitfile.");
      const target = match[1]!.trim();
      gitDir = realpathSync(/^[A-Za-z]:[\\/]/.test(target) || target.startsWith("/") ? target : join(root, target));
    } else {
      throw new Error(".git must be a directory or gitfile.");
    }

    // Linked worktrees keep their private Git directory under the common
    // repository's .git/worktrees/<name>. Git may load the shared
    // $GIT_COMMON_DIR/config before the worktree-specific config.worktree.
    // Resolve and sanitize both locations so shared config cannot bypass the
    // execution/network isolation boundary.
    let commonDir = gitDir;
    const commondirPath = join(gitDir, "commondir");
    if (existsSync(commondirPath)) {
      const commonRef = readFileSync(commondirPath, "utf8").trim();
      if (!commonRef) throw new Error("Invalid Git commondir file.");
      const commonTarget = /^[A-Za-z]:[\\/]/.test(commonRef) || commonRef.startsWith("/") ? commonRef : join(gitDir, commonRef);
      commonDir = realpathSync(commonTarget);
    }
    const configPaths = [join(commonDir, "config")];
    const worktreeConfig = join(gitDir, "config.worktree");
    if (existsSync(worktreeConfig) && worktreeConfig !== configPaths[0]) configPaths.push(worktreeConfig);

    const originals: Array<{ path: string; content: string; sanitized: string }> = [];
    for (const configPath of configPaths) {
      const stat = lstatSync(configPath);
      if (stat.isSymbolicLink()) throw new Error(`Git config path must not be a symlink: ${configPath}`);
      if (!stat.isFile()) throw new Error(`Git config path must be a regular file: ${configPath}`);
      const resolved = realpathSync(configPath);
      if (resolved !== configPath && resolved.toLowerCase() !== configPath.toLowerCase()) throw new Error(`Git config path must resolve to itself: ${configPath}`);
      const original = readFileSync(configPath, "utf8");
      originals.push({ path: configPath, content: original, sanitized: stripDangerousGitConfig(original) });
    }
    const changed = originals.filter((entry) => entry.sanitized !== entry.content);
    if (changed.length === 0) return fn();
    for (const entry of changed) writeFileSync(entry.path, entry.sanitized, "utf8");
    try { return await fn(); }
    finally { for (const entry of changed) { try { writeFileSync(entry.path, entry.content, "utf8"); } catch { } } }
  });
}

export async function runIsolatedGit(args: string[], options: IsolatedGitOptions = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  if (!options.holdLock) return gitOperationMutex.runExclusive(() => runIsolatedGit(args, { ...options, holdLock: true }));
  const timeout = options.timeout ?? 15_000;
  const maxBuffer = options.maxBuffer ?? Math.max(GIT_DIFF_MAX_CHARS * 2, 100_000);
  const isolationDir = mkdtempSync(join(tmpdir(), "git-isolation-"));
  const emptyConfigPath = join(isolationDir, "config");
  writeFileSync(emptyConfigPath, "", { encoding: "utf8", mode: 0o600 });
  try {
    const dynamic = options.skipDynamicOverrides ? [] : await dynamicConfigOverrides();
    const safeArgs = [...GIT_CONFIG_OVERRIDES, ...dynamic, ...args];
    const gitExecutable = resolveTrustedExecutable("git", { projectRoot: getProjectRoot() });
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.GIT_EXTERNAL_DIFF; delete env.GIT_EXTERNAL_DIFF_TRUST_EXIT_CODE;
    Object.assign(env, { GIT_CONFIG: emptyConfigPath, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "", GIT_SSH_COMMAND: getGitSshCommand(), GIT_PROXY_COMMAND: "none", GIT_PAGER: "cat", PAGER: "cat" });
    if (options.input !== undefined) {
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = spawn(gitExecutable, safeArgs, { cwd: getProjectRoot(), shell: false, windowsHide: true, env, stdio: ["pipe", "pipe", "pipe"] });
        let out = ""; let err = "";
        const timer = setTimeout(() => { child.kill("SIGKILL"); reject(Object.assign(new Error(`Git command timed out after ${timeout / 1000} seconds.`), { code: "ETIMEDOUT" })); }, timeout);
        child.stdout.on("data", (d: Buffer) => { out += d.toString("utf8"); }); child.stderr.on("data", (d: Buffer) => { err += d.toString("utf8"); });
        child.on("error", (e) => { clearTimeout(timer); reject(e); }); child.on("close", (code) => { clearTimeout(timer); if (code === 0) resolve(out); else reject(Object.assign(new Error(err || `git exited ${code}`), { code: code ?? 1, stdout: out, stderr: err })); });
        child.stdin.write(options.input!); child.stdin.end();
      });
      return { code: 0, stdout, stderr: "" };
    }
    const result = await execFileAsync(gitExecutable, safeArgs, { cwd: getProjectRoot(), shell: false, timeout, windowsHide: true, maxBuffer, encoding: "utf8", env });
    return { code: 0, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
  } catch (error) {
    const value = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; status?: number; code?: number | string; killed?: boolean };
    if (value.code === "ENOENT") throw error;
    if (value.code === "ETIMEDOUT" || value.killed) throw Object.assign(new Error(`Git command timed out after ${timeout / 1000} seconds.`), { code: "ETIMEDOUT" });
    return { code: typeof value.code === "number" ? value.code : (value.status ?? 1), stdout: String(value.stdout ?? ""), stderr: String(value.stderr ?? "") };
  } finally { try { rmSync(isolationDir, { recursive: true, force: true }); } catch { } }
}

async function runGit(args: string[], timeout: number, holdLock = false): Promise<{ code: number; stdout: string; stderr: string }> { return runIsolatedGit(args, { timeout, holdLock }); }

export async function gitStatus(): Promise<Record<string, unknown>> {
  try { const result = await runGit(["status", "--short", "--branch"], GIT_STATUS_TIMEOUT_MS); if (result.code !== 0) return { error: result.stderr.trim() || "git status failed." }; const status = cap(result.stdout, GIT_STATUS_MAX_CHARS); return { status: status.value, truncated: status.truncated, ...(status.truncated ? { truncation_note: `Status output was truncated to ${GIT_STATUS_MAX_CHARS} characters.` } : {}) }; }
  catch (error) { return { error: errorText(error) }; }
}

export async function gitCommittedFileCount(): Promise<Record<string, unknown>> {
  try { const result = await runGit(["ls-tree", "-r", "--name-only", "HEAD"], GIT_STATUS_TIMEOUT_MS); if (result.code !== 0) return { error: result.stderr.trim() || "Could not count files in the current commit. The repository may not have a commit yet." }; return { committed_files: result.stdout.split(/\r?\n/).filter(Boolean).length }; }
  catch (error) { return { error: errorText(error) }; }
}

export async function gitDiff(path = "", staged = false): Promise<Record<string, unknown>> {
  const args = ["diff", "--no-ext-diff", "--no-textconv"]; if (staged) args.push("--staged");
  const allowed = getAllowedReadPaths();
  if (allowed !== undefined) {
    if (path) { try { const filePath = safePath(path); if (!isReadAllowed(path)) return { error: `Access denied: '${path}' is not selected for the agent.` }; if (isSensitivePath(filePath)) return { error: `Refusing to inspect sensitive file: ${path}` }; const root = getProjectRoot(); args.push("--", filePath.slice(root.length).replace(/^[/\\]+/, "")); } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; } }
    else { const selected = [...allowed]; if (selected.length === 0) return { diff: "", truncated: false }; args.push("--", ...selected); }
  } else if (path) { let filePath: string; try { filePath = safePath(path); } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; } if (isSensitivePath(filePath)) return { error: `Refusing to inspect sensitive file: ${path}` }; const root = getProjectRoot(); args.push("--", filePath.slice(root.length).replace(/^[/\\]+/, "")); }
  try { const result = await runGit(args, GIT_DIFF_TIMEOUT_MS); if (result.code !== 0) return { error: result.stderr.trim() || "git diff failed." }; const diff = cap(result.stdout, GIT_DIFF_MAX_CHARS); return { diff: diff.value, truncated: diff.truncated, ...(diff.truncated ? { truncation_note: `Diff output was truncated to ${GIT_DIFF_MAX_CHARS} characters. Request a path-scoped diff for a smaller view.` } : {}) }; }
  catch (error) { return { error: errorText(error) }; }
}

export async function gitLog(maxCount = 10): Promise<Record<string, unknown>> { const numeric = Number(maxCount); if (!Number.isInteger(numeric)) return { error: "max_count must be a whole number." }; const count = Math.max(1, Math.min(numeric, 100)); try { const result = await runGit(["log", `-${count}`, "--oneline", "--decorate"], GIT_LOG_TIMEOUT_MS); if (result.code !== 0) return { error: result.stderr.trim() || "git log failed." }; const log = cap(result.stdout, GIT_LOG_MAX_CHARS); return { log: log.value, truncated: log.truncated, ...(log.truncated ? { truncation_note: `Log output was truncated to ${GIT_LOG_MAX_CHARS} characters.` } : {}) }; } catch (error) { return { error: errorText(error) }; } }
export async function gitBranch(): Promise<Record<string, unknown>> { try { const result = await runGit(["branch", "--list"], GIT_BRANCH_TIMEOUT_MS); if (result.code !== 0) return { error: result.stderr.trim() || "git branch failed." }; const branches = cap(result.stdout, GIT_BRANCH_MAX_CHARS); return { branches: branches.value, truncated: branches.truncated, ...(branches.truncated ? { truncation_note: `Branch list was truncated to ${GIT_BRANCH_MAX_CHARS} characters.` } : {}) }; } catch (error) { return { error: errorText(error) }; } }

async function stageFileWithoutFilters(relativePath: string, absolutePath: string): Promise<void> {
  const { fstatSync, readSync, closeSync, constants: fsConstants } = await import("node:fs"); const { fd } = openWithinProject(relativePath, fsConstants.O_RDONLY); let mode = "100644"; let payload: Buffer;
  try { const st = fstatSync(fd); if (!st.isFile()) throw new Error("git_add can only stage a single file, not a directory."); mode = (st.mode & 0o111) !== 0 ? "100755" : "100644"; payload = Buffer.alloc(st.size); let offset = 0; while (offset < st.size) { const n = readSync(fd, payload, offset, st.size - offset, offset); if (n === 0) break; offset += n; } if (offset < st.size) payload = payload.subarray(0, offset); } finally { closeSync(fd); }
  void absolutePath;
  const hashed = await runIsolatedGit(["hash-object", "-w", "--stdin", "--no-filters"], { timeout: GIT_ADD_TIMEOUT_MS, input: payload }); if (hashed.code !== 0) throw new Error(hashed.stderr.trim() || hashed.stdout.trim() || "hash-object failed"); const oid = hashed.stdout.trim(); if (!/^[0-9a-f]{40,64}$/i.test(oid)) throw new Error(`Unexpected hash-object output: ${oid}`); const updated = await runIsolatedGit(["update-index", "--add", "--cacheinfo", `${mode},${oid},${relativePath}`], { timeout: GIT_ADD_TIMEOUT_MS }); if (updated.code !== 0) throw new Error(updated.stderr.trim() || updated.stdout.trim() || "update-index failed");
}

async function restoreWorktreeWithoutFilters(relativePath: string): Promise<void> { const rev = await runGit(["rev-parse", `HEAD:${relativePath.replace(/\\/g, "/")}`], GIT_RESTORE_TIMEOUT_MS); if (rev.code !== 0) throw new Error(rev.stderr.trim() || `Path not in HEAD: ${relativePath}`); const oid = rev.stdout.trim(); const blob = await runGit(["cat-file", "blob", oid], GIT_RESTORE_TIMEOUT_MS); if (blob.code !== 0) throw new Error(blob.stderr.trim() || "cat-file failed"); writeFileWithinProject(relativePath, blob.stdout, {}); }

export async function gitAdd(path: string, confirm = false): Promise<Record<string, unknown>> {
  let filePath: string; try { filePath = safePath(path); } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  if (!isReadAllowed(path)) return { error: `Access denied: '${path}' is not selected for the agent.` }; if (isSensitivePath(filePath)) return { error: `Refusing to stage sensitive file: ${path}` };
  try { const repository = await runGit(["rev-parse", "--show-toplevel"], GIT_ADD_TIMEOUT_MS); if (repository.code !== 0) return { error: "git_add requires the project to be inside a git repository." }; } catch (error) { return { error: errorText(error) }; }
  const { statSync } = await import("node:fs"); try { if (!statSync(filePath).isFile()) return { error: "git_add can only stage a single file, not a directory." }; } catch { return { error: `File does not exist: ${path}` }; }
  const root = getProjectRoot(); const relativePath = filePath.slice(root.length).replace(/^[/\\]+/, "");
  if (!confirm) return { requires_confirmation: true, path: relativePath, message: `'${relativePath}' was NOT staged. Ask the user to explicitly confirm it, then call git_add again with confirm=true.` };
  try { await stageFileWithoutFilters(relativePath, filePath); return { path: relativePath, staged: true }; } catch (error) { return { error: `Could not stage file: ${errorText(error)}` }; }
}

const PREVIEW_CHAR_LIMIT = 2000;
export async function gitFetch(remote = ""): Promise<Record<string, unknown>> { const args = ["fetch", "--no-recurse-submodules", "--upload-pack=git-upload-pack"]; if (remote) { const validation = safeValidate(validateGitRemote, remote); if ("error" in validation) return validation; args.push("--", validation.value); } try { return await withSanitizedGitConfig(async () => { const result = await runGit(args, GIT_FETCH_TIMEOUT_MS, true); if (result.code !== 0) return { error: result.stderr.trim() || "git fetch failed." }; let output = result.stdout.trim(); if (!output && !result.stderr.trim()) output = "Fetch completed successfully."; return { output: output.slice(0, GIT_FETCH_MAX_CHARS), remote: remote || "all remotes" }; }); } catch (exc) { return { error: errorText(exc) }; } }

export async function gitPull(remote = "", branch = "", confirm = false): Promise<Record<string, unknown>> { if (!confirm) return { requires_confirmation: true, remote: remote || "default", branch: branch || "current", message: `This will pull from '${remote || "default remote"}' and merge into the current branch. This changes local files and may create merge conflicts. Confirm to proceed.` }; const args = ["pull", "--no-recurse-submodules", "--upload-pack=git-upload-pack"]; if (remote) { const validation = safeValidate(validateGitRemote, remote); if ("error" in validation) return validation; args.push("--", validation.value); } if (branch) { const validation = safeValidate(validateGitBranch, branch); if ("error" in validation) return validation; args.push(validation.value); } try { return await withSanitizedGitConfig(async () => { const result = await runGit(args, GIT_PULL_TIMEOUT_MS, true); if (result.code !== 0) return { error: result.stderr.trim() || "git pull failed." }; return { output: (result.stdout || "").slice(0, GIT_PULL_MAX_CHARS), remote: remote || "default", branch: branch || "current" }; }); } catch (exc) { return { error: errorText(exc) }; } }

export async function gitRestore(path: string, staged = false, confirm = false): Promise<Record<string, unknown>> { let filePath: string; try { filePath = safePath(path); } catch (exc) { return { error: String(exc) }; } if (isSensitivePath(filePath)) return { error: `Refusing to restore sensitive file: ${path}` }; const { statSync } = await import("node:fs"); try { if (!statSync(filePath).isFile()) return { error: `File does not exist: ${path}` }; } catch { return { error: `File does not exist: ${path}` }; } const root = getProjectRoot(); const relativePath = filePath.slice(root.length).replace(/^[/\\]+/, ""); if (!confirm) { const action = staged ? "unstage" : "restore"; return { requires_confirmation: true, path: relativePath, action, message: `'${relativePath}' will be ${action}d. This discards uncommitted changes. Confirm to proceed.` }; } try { if (staged) { const result = await runGit(["restore", "--staged", "--", relativePath], GIT_RESTORE_TIMEOUT_MS); if (result.code !== 0) return { error: `git restore failed: ${result.stderr.trim() || result.stdout.trim()}` }; return { path: relativePath, restored: false, unstaged: true }; } await restoreWorktreeWithoutFilters(relativePath); return { path: relativePath, restored: true, unstaged: false }; } catch (exc) { return { error: errorText(exc) }; } }

export async function gitCommit(message: string, confirm = false): Promise<Record<string, unknown>> { if (!message || !message.trim()) return { error: "A commit message is required." }; const trimmedMessage = message.trim(); if (!confirm) { const diffResult = await gitDiff("", true); let diffText = ""; if (diffResult && typeof diffResult === "object" && "diff" in diffResult) diffText = String(diffResult.diff ?? ""); if (!diffText) return { error: "No staged changes to commit." }; const preview = diffText.slice(0, PREVIEW_CHAR_LIMIT); const previewTruncated = diffText.length > PREVIEW_CHAR_LIMIT; return { requires_confirmation: true, commit_message: trimmedMessage, preview, preview_truncated: previewTruncated, message: `About to commit with message: '${trimmedMessage}'. This creates a new commit in the repository. Confirm to proceed.` }; } try { const identity = await getSafeCommitIdentity(); const identityArgs: string[] = []; if (identity.name) identityArgs.push("-c", `user.name=${identity.name}`); if (identity.email) identityArgs.push("-c", `user.email=${identity.email}`); const result = await runGit([...identityArgs, "commit", "-m", trimmedMessage], GIT_COMMIT_TIMEOUT_MS); if (result.code !== 0) return { error: result.stderr.trim() || "git commit failed." }; return { output: (result.stdout || "").slice(0, GIT_COMMIT_MAX_CHARS), commit_message: trimmedMessage, committed: true }; } catch (exc) { return { error: errorText(exc) }; } }

export async function gitPush(remote = "", branch = "", confirm = false): Promise<Record<string, unknown>> { if (!confirm) return { requires_confirmation: true, remote: remote || "default", branch: branch || "current", message: `This will push commits to '${remote || "default"}' on branch '${branch || "current branch"}'. This updates the remote repository. Confirm to proceed.` }; const args = ["push", "--no-recurse-submodules", "--receive-pack=git-receive-pack"]; if (remote) { const validation = safeValidate(validateGitRemote, remote); if ("error" in validation) return validation; args.push("--", validation.value); } if (branch) { const validation = safeValidate(validateGitBranch, branch); if ("error" in validation) return validation; args.push(validation.value); } try { return await withSanitizedGitConfig(async () => { const result = await runGit(args, GIT_PUSH_TIMEOUT_MS, true); if (result.code !== 0) return { error: result.stderr.trim() || "git push failed." }; return { output: (result.stdout || "").slice(0, GIT_PUSH_MAX_CHARS), remote: remote || "default", branch: branch || "current", pushed: true }; }); } catch (exc) { return { error: errorText(exc) }; } }

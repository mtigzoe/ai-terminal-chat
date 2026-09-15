// Exclusive `.config.<name>.lock` files used by config persistence.
//
// The lock is the file's existence (`wx` / O_CREAT|O_EXCL). A crash can leave
// that file behind, which would otherwise block every later writer for the
// 5-second timeout. Ownership metadata (pid + process start token) lets a
// waiter reclaim the file only when that owner is demonstrably gone.
// Ambiguous or legacy locks are never deleted.

import { createRequire } from "node:module";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

export const CONFIG_LOCK_TIMEOUT_MS = 5000;
const LOCK_METADATA_VERSION = 1;
const MAX_LOCK_FILE_BYTES = 4096;

export type ConfigLockHandle = {
  lockFd: number;
  lockPath: string;
};

export type ConfigLockOwner = {
  v: number;
  pid: number;
  startToken: string;
  createdAt: number;
};

export type AcquireConfigLockOptions = {
  timeoutMs?: number;
};

type LockSnapshot = {
  raw: string;
  owner: ConfigLockOwner;
};

let cachedOwnStartToken: string | null | undefined;

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const buffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, ms);
}

export function configLockPath(targetFile: string): string {
  const directory = dirname(targetFile);
  const configFileName = basename(targetFile).replace(/\.[^.]+$/, "");
  return join(directory, `.config.${configFileName}.lock`);
}

function configFileNameOf(targetFile: string): string {
  return basename(targetFile).replace(/\.[^.]+$/, "");
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM: the process exists but we cannot signal it.
    if (code === "EPERM") return true;
    return false;
  }
}

function linuxStartToken(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen === -1) return null;
    const fields = stat.slice(closeParen + 2).split(" ");
    // Field 22 (starttime) is index 19 after the comm field.
    const starttime = fields[19];
    if (!starttime) return null;
    let bootId = "";
    try {
      bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    } catch {
      try {
        const procStat = readFileSync("/proc/stat", "utf8");
        const btime = procStat.split("\n").find((line) => line.startsWith("btime "));
        bootId = btime?.slice("btime ".length).trim() ?? "";
      } catch {
        bootId = "";
      }
    }
    return `${bootId}:${starttime}`;
  } catch {
    return null;
  }
}

function posixPsStartToken(pid: number): string | null {
  try {
    const output = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = output.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

type WindowsProcessTimesApi = {
  OpenProcess: (access: number, inherit: number, pid: number) => unknown;
  GetProcessTimes: (
    handle: unknown,
    creation: Buffer,
    exit: Buffer,
    kernel: Buffer,
    user: Buffer,
  ) => number;
  CloseHandle: (handle: unknown) => number;
};

let windowsApi: WindowsProcessTimesApi | null | undefined;

function loadWindowsProcessTimesApi(): WindowsProcessTimesApi | null {
  if (windowsApi !== undefined) return windowsApi;
  if (process.platform !== "win32") {
    windowsApi = null;
    return null;
  }
  try {
    const require = createRequire(import.meta.url);
    const koffi = require("koffi") as typeof import("koffi");
    const kernel32 = koffi.load("kernel32.dll");
    const OpenProcess = kernel32.func("OpenProcess", "void *", ["uint32", "int", "uint32"]);
    const GetProcessTimes = kernel32.func("GetProcessTimes", "int", [
      "void *",
      "void *",
      "void *",
      "void *",
      "void *",
    ]);
    const CloseHandle = kernel32.func("CloseHandle", "int", ["void *"]);
    windowsApi = {
      OpenProcess: OpenProcess as WindowsProcessTimesApi["OpenProcess"],
      GetProcessTimes: GetProcessTimes as WindowsProcessTimesApi["GetProcessTimes"],
      CloseHandle: CloseHandle as WindowsProcessTimesApi["CloseHandle"],
    };
    return windowsApi;
  } catch {
    windowsApi = null;
    return null;
  }
}

function handleIsNull(handle: unknown): boolean {
  if (handle === null || handle === undefined) return true;
  if (handle === 0 || handle === 0n) return true;
  if (typeof handle === "object" && handle !== null && "value" in handle) {
    const value = (handle as { value: unknown }).value;
    return value === 0 || value === 0n || value === null || value === undefined;
  }
  return false;
}

function windowsStartToken(pid: number): string | null {
  const api = loadWindowsProcessTimesApi();
  if (!api) return null;
  const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  let handle: unknown;
  try {
    handle = api.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
  } catch {
    return null;
  }
  if (handleIsNull(handle)) return null;
  try {
    const creation = Buffer.alloc(8);
    const exit = Buffer.alloc(8);
    const kernel = Buffer.alloc(8);
    const user = Buffer.alloc(8);
    const ok = api.GetProcessTimes(handle, creation, exit, kernel, user);
    if (!ok) return null;
    const low = BigInt(creation.readUInt32LE(0));
    const high = BigInt(creation.readUInt32LE(4));
    return `ft:${((high << 32n) | low).toString()}`;
  } catch {
    return null;
  } finally {
    try {
      api.CloseHandle(handle);
    } catch {
      // Ignore CloseHandle failures; the start token is what matters.
    }
  }
}

export function processStartToken(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  if (process.platform === "linux") return linuxStartToken(pid);
  if (process.platform === "win32") return windowsStartToken(pid);
  if (process.platform === "darwin") return posixPsStartToken(pid);
  return posixPsStartToken(pid);
}

function ownStartToken(): string {
  if (cachedOwnStartToken === undefined) {
    cachedOwnStartToken = processStartToken(process.pid);
  }
  return cachedOwnStartToken ?? "";
}

export function parseLockOwner(raw: string): ConfigLockOwner | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const record = data as Record<string, unknown>;
  if (record.v !== LOCK_METADATA_VERSION) return null;
  if (typeof record.pid !== "number" || !Number.isSafeInteger(record.pid)) {
    return null;
  }
  if (typeof record.createdAt !== "number" || !Number.isFinite(record.createdAt)) {
    return null;
  }
  if ("startToken" in record && typeof record.startToken !== "string") {
    return null;
  }
  return {
    v: LOCK_METADATA_VERSION,
    pid: record.pid,
    startToken: typeof record.startToken === "string" ? record.startToken : "",
    createdAt: record.createdAt,
  };
}

function readLockSnapshot(lockPath: string): LockSnapshot | null {
  try {
    const info = statSync(lockPath);
    if (!info.isFile() || info.size <= 0 || info.size > MAX_LOCK_FILE_BYTES) {
      return null;
    }
    const raw = readFileSync(lockPath, "utf8");
    const owner = parseLockOwner(raw);
    if (owner === null) return null;
    return { raw, owner };
  } catch {
    return null;
  }
}

/**
 * True when the recorded owner cannot still be the process holding this lock.
 * Unknown liveness, missing start tokens, and unreadable start tokens fail
 * closed (treated as still held).
 */
export function isLockOwnerDead(owner: ConfigLockOwner): boolean {
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
    return false;
  }
  if (!isProcessAlive(owner.pid)) {
    return true;
  }
  if (!owner.startToken) {
    return false;
  }
  const current = processStartToken(owner.pid);
  if (current === null || current === "") {
    return false;
  }
  return current !== owner.startToken;
}

function tryReclaimStaleLock(lockPath: string): boolean {
  const snapshot = readLockSnapshot(lockPath);
  if (snapshot === null) return false;
  if (!isLockOwnerDead(snapshot.owner)) return false;

  const again = readLockSnapshot(lockPath);
  if (again === null || again.raw !== snapshot.raw) return false;

  try {
    rmSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function writeLockOwner(fd: number, owner: ConfigLockOwner): string {
  const serialized = JSON.stringify(owner);
  writeSync(fd, serialized);
  try {
    fsyncSync(fd);
  } catch {
    // fsync is best-effort; the exclusive create still established ownership.
  }
  return serialized;
}

function lockStillOurs(lockPath: string, serialized: string): boolean {
  try {
    return readFileSync(lockPath, "utf8") === serialized;
  } catch {
    // Could not re-read (Windows sharing, already unlinked). `wx` succeeded,
    // so treat this process as the owner.
    return true;
  }
}

/**
 * Acquire the exclusive config lock for `targetFile`.
 *
 * Reclaims a leftover lock only when its recorded process is dead, or the
 * recorded pid now belongs to a different process (start-token mismatch).
 * Legacy empty files and malformed metadata are left in place.
 */
export function acquireConfigLock(
  targetFile: string,
  options: AcquireConfigLockOptions = {},
): ConfigLockHandle {
  const directory = dirname(targetFile);
  mkdirSync(directory, { recursive: true });

  const lockPath = configLockPath(targetFile);
  const configFileName = configFileNameOf(targetFile);
  const maxLockWaitMs = options.timeoutMs ?? CONFIG_LOCK_TIMEOUT_MS;
  const lockWaitStart = Date.now();
  let lastOpenError: unknown = null;

  while (Date.now() - lockWaitStart < maxLockWaitMs) {
    let lockFd: number | null = null;
    try {
      lockFd = openSync(lockPath, "wx");
      const owner: ConfigLockOwner = {
        v: LOCK_METADATA_VERSION,
        pid: process.pid,
        startToken: ownStartToken(),
        createdAt: Date.now(),
      };
      const serialized = writeLockOwner(lockFd, owner);
      if (!lockStillOurs(lockPath, serialized)) {
        try {
          closeSync(lockFd);
        } catch {
          // Ignore
        }
        lockFd = null;
        continue;
      }
      return { lockFd, lockPath };
    } catch (err) {
      lastOpenError = err;
      if (lockFd !== null) {
        try {
          closeSync(lockFd);
        } catch {
          // Ignore
        }
        try {
          rmSync(lockPath, { force: true });
        } catch {
          // Ignore cleanup of a lock we created but failed to initialize.
        }
        lockFd = null;
      }
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        if (tryReclaimStaleLock(lockPath)) {
          continue;
        }
        const elapsed = Date.now() - lockWaitStart;
        sleepSync(Math.min(10 + elapsed * 0.1, 100));
        continue;
      }
      throw err;
    }
  }

  const suffix = lastOpenError instanceof Error ? ` (${lastOpenError.message})` : "";
  throw new Error(
    `Could not acquire config lock for ${configFileName} after ${maxLockWaitMs}ms${suffix}`,
  );
}

export function releaseConfigLock(lockFd: number, lockPath: string): void {
  try {
    closeSync(lockFd);
  } catch {
    // Ignore
  }
  try {
    rmSync(lockPath, { force: true });
  } catch {
    // Ignore lock cleanup errors
  }
}

export function holdConfigLock<T>(
  targetFile: string,
  operation: () => T,
  options: AcquireConfigLockOptions = {},
): T {
  const { lockFd, lockPath } = acquireConfigLock(targetFile, options);
  try {
    return operation();
  } finally {
    releaseConfigLock(lockFd, lockPath);
  }
}

export function __ownStartTokenForTests(): string {
  return ownStartToken();
}

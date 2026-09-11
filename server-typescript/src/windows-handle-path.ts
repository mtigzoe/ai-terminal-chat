/**
 * Resolve the filesystem path of an open file/directory descriptor on Windows
 * via GetFinalPathNameByHandleW. Used to implement openat-style creates: pin a
 * parent directory handle, then open/create relative to that handle's path so
 * a concurrent junction replacement of the *name* cannot redirect O_CREAT.
 *
 * Linux callers should use /proc/self/fd/<fd>/... instead.
 */

import { createRequire } from "node:module";

export class WindowsHandlePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WindowsHandlePathError";
  }
}

type GetFinalPathNameByHandleW = (
  hFile: number | bigint,
  pathBuffer: Buffer,
  cchFilePath: number,
  dwFlags: number,
) => number;

type GetOsFHandle = (fd: number) => number | bigint;

let resolved = false;
let getFinalPathNameByHandleW: GetFinalPathNameByHandleW | null = null;
let getOsFHandle: GetOsFHandle | null = null;

function loadWin32(): void {
  if (resolved) return;
  resolved = true;
  if (process.platform !== "win32") return;

  try {
    const require = createRequire(import.meta.url);
    // Optional runtime dependency — only required on Windows.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require("koffi") as typeof import("koffi");
    const kernel32 = koffi.load("kernel32.dll");
    getFinalPathNameByHandleW = kernel32.func(
      "GetFinalPathNameByHandleW",
      "uint",
      ["uintptr", "void *", "uint", "uint"],
    ) as unknown as GetFinalPathNameByHandleW;

    // Node CRT maps fds to OS handles.
    let msvcrt;
    try {
      msvcrt = koffi.load("msvcrt.dll");
    } catch {
      msvcrt = koffi.load("ucrtbase.dll");
    }
    getOsFHandle = msvcrt.func("_get_osfhandle", "intptr", [
      "int",
    ]) as unknown as GetOsFHandle;
  } catch (err) {
    getFinalPathNameByHandleW = null;
    getOsFHandle = null;
    throw new WindowsHandlePathError(
      `Windows handle-path resolution unavailable (install koffi for race-resistant writes): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Return the Win32 path for an open fd (typically a directory), suitable for
 * joining with a single path segment and passing to openSync/mkdirSync.
 * Paths are returned without a trailing separator; they may use the \\?\ prefix.
 */
export function windowsPathFromFd(fd: number): string {
  if (process.platform !== "win32") {
    throw new WindowsHandlePathError(
      "windowsPathFromFd is only available on Windows",
    );
  }
  loadWin32();
  if (!getFinalPathNameByHandleW || !getOsFHandle) {
    throw new WindowsHandlePathError(
      "Windows handle-path resolution is not available",
    );
  }

  const handle = getOsFHandle(fd);
  const handleNum = typeof handle === "bigint" ? Number(handle) : handle;
  // INVALID_HANDLE_VALUE is (intptr_t)-1
  if (handleNum === -1 || handleNum === 0xffffffff) {
    throw new WindowsHandlePathError("Invalid OS handle for file descriptor");
  }

  // VOLUME_NAME_DOS (0) returns \\?\C:\... form.
  const FILE_NAME_NORMALIZED = 0;
  const bufChars = 32768;
  const buf = Buffer.alloc(bufChars * 2);
  const len = getFinalPathNameByHandleW(
    handleNum,
    buf,
    bufChars,
    FILE_NAME_NORMALIZED,
  );
  if (len === 0) {
    throw new WindowsHandlePathError(
      "GetFinalPathNameByHandleW failed for directory handle",
    );
  }
  // len is character count not including the null terminator.
  let path = buf.toString("utf16le", 0, len * 2);
  // Strip trailing NULs if any.
  path = path.replace(/\0+$/, "");
  return path;
}

/** True when the Windows handle-path backend loaded successfully. */
export function windowsHandlePathAvailable(): boolean {
  if (process.platform !== "win32") return false;
  try {
    loadWin32();
    return getFinalPathNameByHandleW !== null && getOsFHandle !== null;
  } catch {
    return false;
  }
}

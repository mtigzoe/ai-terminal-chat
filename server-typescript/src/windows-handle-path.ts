/**
 * Windows handle-relative filesystem operations (openat / mkdirat equivalents).
 *
 * Security model
 * --------------
 * We never convert a directory HANDLE back into a pathname and then call
 * open/mkdir/rename on that pathname — that reintroduces TOCTOU via junctions.
 *
 * Instead NtCreateFile is invoked with:
 *   OBJECT_ATTRIBUTES.RootDirectory = parent directory HANDLE
 *   OBJECT_ATTRIBUTES.ObjectName    = single relative path component
 *
 * Lookup is performed against the directory *object* the handle refers to.
 * Concurrent replacement of the parent's name with a junction cannot redirect
 * the operation.
 *
 * Layout notes (Windows x64 and ARM64 — both LLP64)
 * -------------------------------------------------
 * UNICODE_STRING: USHORT Length, USHORT MaximumLength, (pad 4), PWSTR Buffer
 * OBJECT_ATTRIBUTES: ULONG Length, (pad 4), HANDLE RootDirectory,
 *   PUNICODE_STRING ObjectName, ULONG Attributes, (pad 4),
 *   PVOID SecurityDescriptor, PVOID SecurityQualityOfService
 * IO_STATUS_BLOCK: union { NTSTATUS; PVOID } (pointer-sized), ULONG_PTR Information
 *
 * koffi aligns struct fields; we use pointer-sized types for the IO_STATUS_BLOCK
 * Status union so Information is not misaligned on 64-bit.
 *
 * Fail closed if koffi/ntdll cannot be loaded.
 */

import { createRequire } from "node:module";

export class WindowsHandlePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WindowsHandlePathError";
  }
}

// CreateDisposition
const FILE_OPEN = 1;
const FILE_CREATE = 2;
const FILE_OPEN_IF = 3;

// CreateOptions
const FILE_DIRECTORY_FILE = 0x00000001;
const FILE_NON_DIRECTORY_FILE = 0x00000040;
const FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020;
const FILE_OPEN_REPARSE_POINT = 0x00200000;

// Access / share / attributes
const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const SYNCHRONIZE = 0x00100000;
const FILE_LIST_DIRECTORY = 0x00000001;
const FILE_SHARE_READ = 0x00000001;
const FILE_SHARE_WRITE = 0x00000002;
const FILE_SHARE_DELETE = 0x00000004;
const FILE_ATTRIBUTE_NORMAL = 0x00000080;
const FILE_ATTRIBUTE_DIRECTORY = 0x00000010;

const OBJ_CASE_INSENSITIVE = 0x00000040;
// Fail closed if any reparse point is encountered while resolving this name.
// Unlike FILE_OPEN_REPARSE_POINT (which opens the reparse point itself),
// OBJ_DONT_REPARSE prevents the lookup from following it at all.
const OBJ_DONT_REPARSE = 0x00001000;

// CRT flags for _open_osfhandle
const O_RDWR = 2;
const O_BINARY = 0x8000;

// NTSTATUS values of interest (unsigned form)
const NTSTATUS_OBJECT_NAME_COLLISION = 0xc000_0035;
const NTSTATUS_OBJECT_NAME_NOT_FOUND = 0xc000_0034;
const NTSTATUS_OBJECT_PATH_NOT_FOUND = 0xc000_003a;
const NTSTATUS_ACCESS_DENIED = 0xc000_0022;
const NTSTATUS_DELETE_PENDING = 0xc000_0056;
const NTSTATUS_REPARSE_POINT_ENCOUNTERED = 0xc000_050b;

const RESERVED_DOS_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

/** Validate a single relative path component for NtCreateFile ObjectName. */
export function assertSafeRelativeName(relativeName: string): void {
  if (typeof relativeName !== "string" || relativeName.length === 0) {
    throw new WindowsHandlePathError("Relative name is required.");
  }
  if (relativeName.includes("\0")) {
    throw new WindowsHandlePathError("Relative name contains a NUL byte.");
  }
  if (
    relativeName.includes("/") ||
    relativeName.includes("\\") ||
    relativeName === "." ||
    relativeName === ".."
  ) {
    throw new WindowsHandlePathError(
      `Invalid relative name for handle-relative open: ${relativeName}`,
    );
  }
  if (relativeName.includes(":")) {
    throw new WindowsHandlePathError(
      "Relative name must not contain ':' (ADS / device syntax).",
    );
  }
  for (let i = 0; i < relativeName.length; i += 1) {
    if (relativeName.charCodeAt(i) < 0x20) {
      throw new WindowsHandlePathError(
        "Relative name contains a control character.",
      );
    }
  }
  const base = relativeName.split(".")[0]?.toLowerCase() ?? "";
  if (RESERVED_DOS_NAMES.has(base)) {
    throw new WindowsHandlePathError(
      `Relative name uses a reserved Windows device name: ${relativeName}`,
    );
  }
  if (relativeName.length > 255) {
    throw new WindowsHandlePathError("Relative name is too long.");
  }
}

type KoffiModule = typeof import("koffi");

type NativeApi = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  koffi: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  NtCreateFile: (...args: any[]) => number;
  getOsFHandle: (fd: number) => number;
  openOsFHandle: (osfhandle: number, flags: number) => number;
  CloseHandle: (h: number) => number;
  RtlNtStatusToDosError: (status: number) => number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  UnicodeString: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ObjectAttributes: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  IoStatusBlock: any;
};

let api: NativeApi | null = null;
let loadError: string | null = null;

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (value && typeof value === "object" && "value" in value) {
    return Number((value as { value: unknown }).value);
  }
  return Number(value);
}

function ntstatusUnsigned(status: number): number {
  return status >>> 0;
}

function loadNative(): NativeApi {
  if (process.platform !== "win32") {
    throw new WindowsHandlePathError("Windows handle-relative operations are unavailable on this platform.");
  }
  if (api) return api;
  if (loadError) throw new WindowsHandlePathError(loadError);

  try {
    const require = createRequire(import.meta.url);
    const koffi = require("koffi") as KoffiModule;
    const ntdll = koffi.load("ntdll.dll");
    const kernel32 = koffi.load("kernel32.dll");
    let crt;
    try {
      crt = koffi.load("ucrtbase.dll");
    } catch {
      crt = koffi.load("msvcrt.dll");
    }

    const UnicodeString = koffi.struct("UNICODE_STRING", {
      Length: "uint16",
      MaximumLength: "uint16",
      Buffer: "void *",
    });
    const ObjectAttributes = koffi.struct("OBJECT_ATTRIBUTES", {
      Length: "uint32",
      RootDirectory: "void *",
      ObjectName: "void *",
      Attributes: "uint32",
      SecurityDescriptor: "void *",
      SecurityQualityOfService: "void *",
    });
    const IoStatusBlock = koffi.struct("IO_STATUS_BLOCK", {
      Status: "void *",
      Information: "uintptr",
    });

    const NtCreateFile = ntdll.func("NtCreateFile", "long", [
      "void *",
      "uint32",
      "void *",
      "void *",
      "void *",
      "uint32",
      "uint32",
      "uint32",
      "uint32",
      "void *",
      "uint32",
    ]);
    const getOsFHandleRaw = crt.func("_get_osfhandle", "intptr", ["int"]);
    const openOsFHandleRaw = crt.func("_open_osfhandle", "int", ["intptr", "int"]);
    const CloseHandleRaw = kernel32.func("CloseHandle", "int", ["uintptr"]);
    const RtlNtStatusToDosErrorRaw = ntdll.func("RtlNtStatusToDosError", "uint32", ["long"]);

    api = {
      koffi,
      NtCreateFile: NtCreateFile as NativeApi["NtCreateFile"],
      getOsFHandle: (fd: number) => toNumber(getOsFHandleRaw(fd)),
      openOsFHandle: (osfhandle: number, flags: number) => toNumber(openOsFHandleRaw(osfhandle, flags)),
      CloseHandle: (h: number) => toNumber(CloseHandleRaw(h)),
      RtlNtStatusToDosError: (status: number) => toNumber(RtlNtStatusToDosErrorRaw(status)),
      UnicodeString,
      ObjectAttributes,
      IoStatusBlock,
    };
    return api;
  } catch (err) {
    loadError = `Windows NtCreateFile bridge unavailable: ${err instanceof Error ? err.message : String(err)}`;
    throw new WindowsHandlePathError(loadError);
  }
}

function handleFromFd(fd: number): number {
  const native = loadNative();
  const h = native.getOsFHandle(fd);
  if (h === -1 || h === 0xffff_ffff) {
    throw new WindowsHandlePathError("Invalid OS handle for directory fd");
  }
  return h;
}

type NtCreateRelativeOptions = {
  desiredAccess: number;
  fileAttributes: number;
  createDisposition: number;
  createOptions: number;
};

function ntCreateRelative(parentFd: number, relativeName: string, opts: NtCreateRelativeOptions): number {
  assertSafeRelativeName(relativeName);
  const native = loadNative();
  const parentHandle = handleFromFd(parentFd);
  const { koffi, UnicodeString, ObjectAttributes, IoStatusBlock } = native;

  const nameU16 = Buffer.from(relativeName, "utf16le");
  const nameLen = nameU16.length;
  const usPtr = koffi.alloc(UnicodeString, 1);
  koffi.encode(usPtr, UnicodeString, {
    Length: nameLen,
    MaximumLength: nameLen,
    Buffer: nameU16,
  });
  const oaPtr = koffi.alloc(ObjectAttributes, 1);
  koffi.encode(oaPtr, ObjectAttributes, {
    Length: koffi.sizeof(ObjectAttributes),
    RootDirectory: parentHandle,
    ObjectName: usPtr,
    Attributes: OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
    SecurityDescriptor: null,
    SecurityQualityOfService: null,
  });
  const iosb = koffi.alloc(IoStatusBlock, 1);
  koffi.encode(iosb, IoStatusBlock, { Status: null, Information: 0 });
  const handleOut = koffi.alloc("void *", 1);

  const status = native.NtCreateFile(
    handleOut,
    opts.desiredAccess,
    oaPtr,
    iosb,
    null,
    opts.fileAttributes,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    opts.createDisposition,
    opts.createOptions,
    null,
    0,
  ) as number;

  if (nameU16.length < 0) throw new WindowsHandlePathError("unreachable");

  const statusU = ntstatusUnsigned(status);
  if (status !== 0) {
    if (statusU === NTSTATUS_OBJECT_NAME_COLLISION) {
      const err = new Error(`File already exists: ${relativeName}`) as NodeJS.ErrnoException;
      err.code = "EEXIST";
      throw err;
    }
    if (statusU === NTSTATUS_OBJECT_NAME_NOT_FOUND || statusU === NTSTATUS_OBJECT_PATH_NOT_FOUND) {
      const err = new Error(`File not found: ${relativeName}`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    if (statusU === NTSTATUS_REPARSE_POINT_ENCOUNTERED) {
      const err = new Error(`Reparse point encountered: ${relativeName}`) as NodeJS.ErrnoException;
      err.code = "ELOOP";
      throw err;
    }
    if (statusU === NTSTATUS_ACCESS_DENIED || statusU === NTSTATUS_DELETE_PENDING) {
      const err = new Error(`Access denied for: ${relativeName}`) as NodeJS.ErrnoException;
      err.code = "EACCES";
      throw err;
    }
    const dos = native.RtlNtStatusToDosError(status);
    throw new WindowsHandlePathError(
      `NtCreateFile failed for '${relativeName}' (NTSTATUS=0x${statusU.toString(16)}, win32=${dos})`,
    );
  }

  const rawHandle = koffi.decode(handleOut, "void *") as unknown;
  return toNumber(rawHandle);
}

/**
 * Open or create a child relative to an open parent directory fd.
 * `directory: true` requests FILE_DIRECTORY_FILE; otherwise a regular file is required.
 */
export function openRelativeToDirFd(
  parentFd: number,
  relativeName: string,
  options: {
    create?: boolean;
    exclusive?: boolean;
    write?: boolean;
    directory?: boolean;
  } = {},
): number {
  const native = loadNative();
  let disposition: number;
  if (options.create && options.exclusive) {
    disposition = FILE_CREATE;
  } else if (options.create) {
    disposition = FILE_OPEN_IF;
  } else {
    disposition = FILE_OPEN;
  }

  let createOptions =
    (options.directory ? FILE_DIRECTORY_FILE : FILE_NON_DIRECTORY_FILE) |
    FILE_SYNCHRONOUS_IO_NONALERT;
  if (!options.create) {
    createOptions |= FILE_OPEN_REPARSE_POINT;
  }

  const access =
    (options.write || options.create
      ? GENERIC_READ | GENERIC_WRITE
      : options.directory
        ? FILE_LIST_DIRECTORY
        : GENERIC_READ) | SYNCHRONIZE;

  const fileHandle = ntCreateRelative(parentFd, relativeName, {
    desiredAccess: access,
    fileAttributes: options.directory ? FILE_ATTRIBUTE_DIRECTORY : FILE_ATTRIBUTE_NORMAL,
    createDisposition: disposition,
    createOptions,
  });

  const fd = native.openOsFHandle(fileHandle, O_RDWR | O_BINARY);
  if (fd < 0) {
    native.CloseHandle(fileHandle);
    throw new WindowsHandlePathError("_open_osfhandle failed after NtCreateFile");
  }
  return fd;
}

export function mkdirRelativeToDirFd(parentFd: number, relativeName: string): void {
  const native = loadNative();
  let fileHandle: number;
  try {
    fileHandle = ntCreateRelative(parentFd, relativeName, {
      desiredAccess: FILE_LIST_DIRECTORY | SYNCHRONIZE,
      fileAttributes: FILE_ATTRIBUTE_DIRECTORY,
      createDisposition: FILE_CREATE,
      createOptions: FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return;
    throw err;
  }
  native.CloseHandle(fileHandle);
}

export function windowsHandleRelativeAvailable(): boolean {
  if (process.platform !== "win32") return false;
  try {
    loadNative();
    return true;
  } catch {
    return false;
  }
}
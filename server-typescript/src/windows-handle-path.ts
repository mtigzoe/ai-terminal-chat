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

/**
 * Validate a single relative path component for NtCreateFile ObjectName.
 * Must be exactly one component — no separators, no traversal, no ADS, no
 * device names. Exported for unit tests.
 */
export function assertSafeRelativeName(relativeName: string): void {
  if (typeof relativeName !== "string" || relativeName.length === 0) {
    throw new WindowsHandlePathError("Relative name is required.");
  }
  // Reject embedded NULs (would truncate the NT UNICODE_STRING view).
  if (relativeName.includes("\0")) {
    throw new WindowsHandlePathError("Relative name contains a NUL byte.");
  }
  // Exactly one path component.
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
  // Alternate data streams: "file:stream" must not be expressible.
  if (relativeName.includes(":")) {
    throw new WindowsHandlePathError(
      "Relative name must not contain ':' (ADS / device syntax).",
    );
  }
  // Control characters.
  for (let i = 0; i < relativeName.length; i += 1) {
    const code = relativeName.charCodeAt(i);
    if (code < 0x20) {
      throw new WindowsHandlePathError(
        "Relative name contains a control character.",
      );
    }
  }
  // Windows reserved device names (with or without extension).
  const base = relativeName.split(".")[0]?.toLowerCase() ?? "";
  if (RESERVED_DOS_NAMES.has(base)) {
    throw new WindowsHandlePathError(
      `Relative name uses a reserved Windows device name: ${relativeName}`,
    );
  }
  // NT path component practical limit (255 UTF-16 code units is common).
  if (relativeName.length > 255) {
    throw new WindowsHandlePathError("Relative name is too long.");
  }
}

type KoffiModule = typeof import("koffi");

type NativeApi = {
  // koffi struct type handles are opaque; use any for encode/alloc typing.
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
  if (typeof value === "bigint") return Number(value);
  return Number(value);
}

function ntstatusUnsigned(status: number): number {
  // koffi may return signed 32-bit NTSTATUS; normalize to unsigned.
  return status < 0 ? status + 0x1_0000_0000 : status >>> 0;
}

function loadNative(): NativeApi {
  if (api) return api;
  if (process.platform !== "win32") {
    throw new WindowsHandlePathError(
      "Windows handle-relative APIs require win32",
    );
  }
  if (loadError) {
    throw new WindowsHandlePathError(loadError);
  }

  try {
    const require = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require("koffi");

    const ntdll = koffi.load("ntdll.dll");
    const kernel32 = koffi.load("kernel32.dll");
    let crt;
    try {
      crt = koffi.load("ucrtbase.dll");
    } catch {
      crt = koffi.load("msvcrt.dll");
    }

    // Struct layouts — koffi inserts natural alignment padding.
    // IO_STATUS_BLOCK.Status is a union with PVOID → pointer-sized on x64/ARM64.
    const UnicodeString = koffi.struct("ATC_UNICODE_STRING", {
      Length: "uint16",
      MaximumLength: "uint16",
      Buffer: "void *",
    });
    const ObjectAttributes = koffi.struct("ATC_OBJECT_ATTRIBUTES", {
      Length: "uint32",
      RootDirectory: "void *",
      ObjectName: "void *",
      Attributes: "uint32",
      SecurityDescriptor: "void *",
      SecurityQualityOfService: "void *",
    });
    const IoStatusBlock = koffi.struct("ATC_IO_STATUS_BLOCK", {
      Status: "void *", // pointer-sized union { NTSTATUS Status; PVOID Pointer; }
      Information: "uintptr",
    });

    const NtCreateFile = ntdll.func("NtCreateFile", "long", [
      "void *", // PHANDLE FileHandle
      "uint32", // ACCESS_MASK DesiredAccess
      "void *", // POBJECT_ATTRIBUTES ObjectAttributes
      "void *", // PIO_STATUS_BLOCK IoStatusBlock
      "void *", // PLARGE_INTEGER AllocationSize
      "uint32", // ULONG FileAttributes
      "uint32", // ULONG ShareAccess
      "uint32", // ULONG CreateDisposition
      "uint32", // ULONG CreateOptions
      "void *", // PVOID EaBuffer
      "uint32", // ULONG EaLength
    ]);

    const getOsFHandleRaw = crt.func("_get_osfhandle", "intptr", ["int"]);
    const openOsFHandleRaw = crt.func("_open_osfhandle", "int", [
      "intptr",
      "int",
    ]);
    const CloseHandleRaw = kernel32.func("CloseHandle", "int", ["uintptr"]);
    const RtlNtStatusToDosErrorRaw = ntdll.func("RtlNtStatusToDosError", "uint32", [
      "long",
    ]);

    api = {
      koffi,
      NtCreateFile: NtCreateFile as NativeApi["NtCreateFile"],
      getOsFHandle: (fd: number) => toNumber(getOsFHandleRaw(fd)),
      openOsFHandle: (osfhandle: number, flags: number) =>
        toNumber(openOsFHandleRaw(osfhandle, flags)),
      CloseHandle: (h: number) => toNumber(CloseHandleRaw(h)),
      RtlNtStatusToDosError: (status: number) =>
        toNumber(RtlNtStatusToDosErrorRaw(status)),
      UnicodeString,
      ObjectAttributes,
      IoStatusBlock,
    };
    return api;
  } catch (err) {
    loadError = `Windows NtCreateFile bridge unavailable: ${
      err instanceof Error ? err.message : String(err)
    }`;
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

/**
 * Shared NtCreateFile relative to parentFd. Keeps UNICODE_STRING buffer alive
 * for the duration of the call. Returns a raw Windows HANDLE; caller must
 * either CloseHandle or transfer ownership via _open_osfhandle.
 */
function ntCreateRelative(
  parentFd: number,
  relativeName: string,
  opts: NtCreateRelativeOptions,
): number {
  assertSafeRelativeName(relativeName);
  const native = loadNative();
  const parentHandle = handleFromFd(parentFd);
  const { koffi, UnicodeString, ObjectAttributes, IoStatusBlock } = native;

  // UTF-16LE payload without a forced NUL: Length is byte length of the name.
  // NT object-name parsing uses Length; a trailing NUL is not required.
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
  koffi.encode(iosb, IoStatusBlock, {
    Status: null,
    Information: 0,
  });

  const handleOut = koffi.alloc("void *", 1);

  // nameU16, usPtr, oaPtr, iosb must remain reachable through the call.
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

  // Touch nameU16 after the call so optimizers / GC cannot reclaim early.
  if (nameU16.length < 0) {
    throw new WindowsHandlePathError("unreachable");
  }

  const statusU = ntstatusUnsigned(status);
  if (status !== 0) {
    if (statusU === NTSTATUS_OBJECT_NAME_COLLISION) {
      const err = new Error(
        `File already exists: ${relativeName}`,
      ) as NodeJS.ErrnoException;
      err.code = "EEXIST";
      throw err;
    }
    if (
      statusU === NTSTATUS_OBJECT_NAME_NOT_FOUND ||
      statusU === NTSTATUS_OBJECT_PATH_NOT_FOUND
    ) {
      const err = new Error(
        `File not found: ${relativeName}`,
      ) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    if (statusU === NTSTATUS_REPARSE_POINT_ENCOUNTERED) {
      const err = new Error(
        `Reparse point encountered while opening '${relativeName}'.`,
      ) as NodeJS.ErrnoException;
      err.code = "ELOOP";
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
 * Open or create a file relative to an open parent directory fd.
 * Returns a Node CRT file descriptor that owns the underlying HANDLE.
 */
export function openRelativeToDirFd(
  parentFd: number,
  relativeName: string,
  options: {
    create?: boolean;
    exclusive?: boolean;
    write?: boolean;
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

  // OBJ_DONT_REPARSE on OBJECT_ATTRIBUTES is the primary security boundary:
  // it prevents both existing final-component reparses and reparses encountered
  // while resolving the relative name. A reparse is rejected instead of being
  // followed and checked only after the open has already occurred.
  // FILE_OPEN_REPARSE_POINT is retained for existing-name opens as defense in
  // depth, but it is not sufficient for create=true/FILE_OPEN_IF.
  let createOptions =
    FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT;
  if (!options.create) {
    createOptions |= FILE_OPEN_REPARSE_POINT;
  }

  const access =
    (options.write || options.create
      ? GENERIC_READ | GENERIC_WRITE
      : GENERIC_READ) | SYNCHRONIZE;

  const fileHandle = ntCreateRelative(parentFd, relativeName, {
    desiredAccess: access,
    fileAttributes: FILE_ATTRIBUTE_NORMAL,
    createDisposition: disposition,
    createOptions,
  });

  // Transfer HANDLE ownership to the CRT. After success, do not CloseHandle.
  const fd = native.openOsFHandle(fileHandle, O_RDWR | O_BINARY);
  if (fd < 0) {
    native.CloseHandle(fileHandle);
    throw new WindowsHandlePathError(
      "_open_osfhandle failed after NtCreateFile",
    );
  }
  return fd;
}

/**
 * Create a directory relative to an open parent directory fd (mkdirat).
 * Idempotent when the name already exists as a directory (EEXIST ignored).
 */
export function mkdirRelativeToDirFd(
  parentFd: number,
  relativeName: string,
): void {
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
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return;
    }
    throw err;
  }

  // Directory create only — release the handle immediately.
  native.CloseHandle(fileHandle);
}

/** True when the NtCreateFile bridge loaded successfully. */
export function windowsHandleRelativeAvailable(): boolean {
  if (process.platform !== "win32") return false;
  try {
    loadNative();
    return true;
  } catch {
    return false;
  }
}

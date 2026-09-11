/**
 * Windows handle-relative filesystem operations (openat / mkdirat equivalents).
 *
 * GetFinalPathNameByHandleW is NOT used for security-sensitive creates: converting
 * a handle back to a pathname and then calling openSync/mkdirSync is still a
 * pathname operation with a TOCTOU window.
 *
 * Instead we call NtCreateFile with OBJECT_ATTRIBUTES.RootDirectory set to the
 * open parent directory HANDLE and ObjectName set to a single relative component.
 * Path lookup is performed relative to the directory object the handle refers
 * to, so a concurrent junction replacement of the parent's *name* cannot
 * redirect the create/open.
 *
 * Requires koffi + ntdll/kernel32/msvcrt on win32. Fail closed if unavailable.
 */

import { createRequire } from "node:module";

export class WindowsHandlePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WindowsHandlePathError";
  }
}

// NTSTATUS
const STATUS_SUCCESS = 0;
const STATUS_OBJECT_NAME_COLLISION = 0xc0000035 | 0; // as unsigned will be large
const STATUS_OBJECT_NAME_NOT_FOUND = 0xc0000034;

// CreateDisposition
const FILE_OPEN = 1;
const FILE_CREATE = 2;
const FILE_OPEN_IF = 3;
const FILE_OVERWRITE_IF = 5;

// CreateOptions
const FILE_DIRECTORY_FILE = 0x00000001;
const FILE_NON_DIRECTORY_FILE = 0x00000040;
const FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020;
const FILE_OPEN_REPARSE_POINT = 0x00200000;

// Access / share
const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const SYNCHRONIZE = 0x00100000;
const FILE_LIST_DIRECTORY = 0x00000001;
const FILE_SHARE_READ = 0x00000001;
const FILE_SHARE_WRITE = 0x00000002;
const FILE_SHARE_DELETE = 0x00000004;
const FILE_ATTRIBUTE_NORMAL = 0x00000080;
const FILE_ATTRIBUTE_DIRECTORY = 0x00000010;

// CRT open flags for _open_osfhandle
const O_RDWR = 2;
const O_BINARY = 0x8000;

const OBJ_CASE_INSENSITIVE = 0x00000040;

type NativeApi = {
  NtCreateFile: (
    fileHandle: Buffer,
    desiredAccess: number,
    objectAttributes: Buffer,
    ioStatusBlock: Buffer,
    allocationSize: null,
    fileAttributes: number,
    shareAccess: number,
    createDisposition: number,
    createOptions: number,
    eaBuffer: null,
    eaLength: number,
  ) => number;
  getOsFHandle: (fd: number) => number;
  openOsFHandle: (osfhandle: number, flags: number) => number;
  CloseHandle: (h: number) => number;
  RtlNtStatusToDosError: (status: number) => number;
};

let api: NativeApi | null = null;
let loadError: string | null = null;

function loadNative(): NativeApi {
  if (api) return api;
  if (process.platform !== "win32") {
    throw new WindowsHandlePathError("Windows handle-relative APIs require win32");
  }
  if (loadError) {
    throw new WindowsHandlePathError(loadError);
  }
  try {
    const require = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require("koffi") as typeof import("koffi");

    const ntdll = koffi.load("ntdll.dll");
    const kernel32 = koffi.load("kernel32.dll");
    let msvcrt;
    try {
      msvcrt = koffi.load("msvcrt.dll");
    } catch {
      msvcrt = koffi.load("ucrtbase.dll");
    }

    const NtCreateFile = ntdll.func(
      "NtCreateFile",
      "long",
      [
        "void *", // PHANDLE
        "uint32", // ACCESS_MASK
        "void *", // POBJECT_ATTRIBUTES
        "void *", // PIO_STATUS_BLOCK
        "void *", // PLARGE_INTEGER AllocationSize
        "uint32", // FileAttributes
        "uint32", // ShareAccess
        "uint32", // CreateDisposition
        "uint32", // CreateOptions
        "void *", // EaBuffer
        "uint32", // EaLength
      ],
    );

    const getOsFHandle = msvcrt.func("_get_osfhandle", "intptr", ["int"]);
    const openOsFHandle = msvcrt.func("_open_osfhandle", "int", ["intptr", "int"]);
    const CloseHandle = kernel32.func("CloseHandle", "int", ["uintptr"]);
    const RtlNtStatusToDosError = ntdll.func("RtlNtStatusToDosError", "uint32", [
      "long",
    ]);

    api = {
      NtCreateFile: NtCreateFile as unknown as NativeApi["NtCreateFile"],
      getOsFHandle: ((fd: number) => {
        const h = getOsFHandle(fd) as number;
        return typeof h === "bigint" ? Number(h) : Number(h);
      }) as NativeApi["getOsFHandle"],
      openOsFHandle: ((osfhandle: number, flags: number) => {
        const r = openOsFHandle(osfhandle, flags) as number;
        return typeof r === "bigint" ? Number(r) : Number(r);
      }) as NativeApi["openOsFHandle"],
      CloseHandle: ((h: number) => {
        const r = CloseHandle(h) as number;
        return typeof r === "bigint" ? Number(r) : Number(r);
      }) as NativeApi["CloseHandle"],
      RtlNtStatusToDosError: ((status: number) => {
        const r = RtlNtStatusToDosError(status) as number;
        return typeof r === "bigint" ? Number(r) : Number(r);
      }) as NativeApi["RtlNtStatusToDosError"],
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
  if (h === -1 || h === 0xffffffff) {
    throw new WindowsHandlePathError("Invalid OS handle for directory fd");
  }
  return h;
}

/**
 * Open or create a file relative to an open parent directory fd using NtCreateFile.
 * Returns a Node CRT file descriptor that owns the handle (_open_osfhandle).
 */
export function openRelativeToDirFd(
  parentFd: number,
  relativeName: string,
  options: {
    create?: boolean;
    exclusive?: boolean;
    write?: boolean;
    truncate?: boolean;
  } = {},
): number {
  const native = loadNative();
  const parentHandle = handleFromFd(parentFd);

  if (
    !relativeName ||
    relativeName.includes("/") ||
    relativeName.includes("\\") ||
    relativeName === "." ||
    relativeName === ".."
  ) {
    throw new WindowsHandlePathError(
      `Invalid relative name for handle-relative open: ${relativeName}`,
    );
  }

  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const koffi = require("koffi") as typeof import("koffi");

  // Encode name as UTF-16LE
  const nameU16 = Buffer.from(relativeName, "utf16le");
  const nameLen = nameU16.length;

  // UNICODE_STRING
  const UnicodeString = koffi.struct("UNICODE_STRING_ATC", {
    Length: "uint16",
    MaximumLength: "uint16",
    Buffer: "void *",
  });
  const us = {
    Length: nameLen,
    MaximumLength: nameLen,
    Buffer: nameU16,
  };

  const ObjectAttributes = koffi.struct("OBJECT_ATTRIBUTES_ATC", {
    Length: "uint32",
    RootDirectory: "void *",
    ObjectName: "void *",
    Attributes: "uint32",
    SecurityDescriptor: "void *",
    SecurityQualityOfService: "void *",
  });

  // Allocate UNICODE_STRING in a buffer we control with embedded pointer
  // Use koffi's encode for structs
  const usPtr = koffi.alloc(UnicodeString, 1);
  koffi.encode(usPtr, UnicodeString, us);

  const oaPtr = koffi.alloc(ObjectAttributes, 1);
  koffi.encode(oaPtr, ObjectAttributes, {
    Length: koffi.sizeof(ObjectAttributes),
    RootDirectory: parentHandle,
    ObjectName: usPtr,
    Attributes: OBJ_CASE_INSENSITIVE,
    SecurityDescriptor: null,
    SecurityQualityOfService: null,
  });

  const IoStatusBlock = koffi.struct("IO_STATUS_BLOCK_ATC", {
    Status: "long",
    Information: "uintptr",
  });
  const iosb = koffi.alloc(IoStatusBlock, 1);
  koffi.encode(iosb, IoStatusBlock, { Status: 0, Information: 0 });

  const handleOut = koffi.alloc("void *", 1);

  let disposition: number;
  if (options.create && options.exclusive) {
    disposition = FILE_CREATE;
  } else if (options.create && options.truncate) {
    disposition = FILE_OVERWRITE_IF;
  } else if (options.create) {
    disposition = FILE_OPEN_IF;
  } else {
    disposition = FILE_OPEN;
  }

  // Never follow a final-component reparse point into an outside target:
  // FILE_OPEN_REPARSE_POINT opens the reparse point itself when present.
  // For CREATE of a new name there is no reparse point yet.
  let createOptions =
    FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT;
  if (!options.create) {
    createOptions |= FILE_OPEN_REPARSE_POINT;
  }

  const access =
    (options.write || options.create || options.truncate
      ? GENERIC_READ | GENERIC_WRITE
      : GENERIC_READ) | SYNCHRONIZE;

  const status = native.NtCreateFile(
    handleOut as unknown as Buffer,
    access,
    oaPtr as unknown as Buffer,
    iosb as unknown as Buffer,
    null,
    FILE_ATTRIBUTE_NORMAL,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    disposition,
    createOptions,
    null,
    0,
  );

  // status is signed NTSTATUS; success is 0, warnings are positive, errors negative
  const statusU = status < 0 ? status + 0x100000000 : status;
  if (status !== 0 && status !== STATUS_SUCCESS) {
    // OBJECT_NAME_COLLISION for exclusive create
    if ((statusU & 0xffffffff) === 0xc0000035) {
      const err = new Error(`File already exists: ${relativeName}`) as NodeJS.ErrnoException;
      err.code = "EEXIST";
      throw err;
    }
    if ((statusU & 0xffffffff) === 0xc0000034) {
      const err = new Error(`File not found: ${relativeName}`) as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    }
    const dos = native.RtlNtStatusToDosError(status);
    throw new WindowsHandlePathError(
      `NtCreateFile failed for '${relativeName}' (NTSTATUS=0x${(statusU & 0xffffffff).toString(16)}, win32=${dos})`,
    );
  }

  // Read handle pointer from handleOut
  const rawHandle = koffi.decode(handleOut, "void *") as number | bigint;
  const fileHandle =
    typeof rawHandle === "bigint" ? Number(rawHandle) : Number(rawHandle);

  // Transfer ownership to CRT fd. After this, do NOT CloseHandle.
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
 * Create a directory relative to an open parent directory fd (mkdirat equivalent).
 */
export function mkdirRelativeToDirFd(
  parentFd: number,
  relativeName: string,
): void {
  const native = loadNative();
  const parentHandle = handleFromFd(parentFd);

  if (
    !relativeName ||
    relativeName.includes("/") ||
    relativeName.includes("\\") ||
    relativeName === "." ||
    relativeName === ".."
  ) {
    throw new WindowsHandlePathError(
      `Invalid relative name for handle-relative mkdir: ${relativeName}`,
    );
  }

  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const koffi = require("koffi") as typeof import("koffi");

  const nameU16 = Buffer.from(relativeName, "utf16le");
  const nameLen = nameU16.length;

  const UnicodeString = koffi.struct("UNICODE_STRING_ATC_MK", {
    Length: "uint16",
    MaximumLength: "uint16",
    Buffer: "void *",
  });
  const usPtr = koffi.alloc(UnicodeString, 1);
  koffi.encode(usPtr, UnicodeString, {
    Length: nameLen,
    MaximumLength: nameLen,
    Buffer: nameU16,
  });

  const ObjectAttributes = koffi.struct("OBJECT_ATTRIBUTES_ATC_MK", {
    Length: "uint32",
    RootDirectory: "void *",
    ObjectName: "void *",
    Attributes: "uint32",
    SecurityDescriptor: "void *",
    SecurityQualityOfService: "void *",
  });
  const oaPtr = koffi.alloc(ObjectAttributes, 1);
  koffi.encode(oaPtr, ObjectAttributes, {
    Length: koffi.sizeof(ObjectAttributes),
    RootDirectory: parentHandle,
    ObjectName: usPtr,
    Attributes: OBJ_CASE_INSENSITIVE,
    SecurityDescriptor: null,
    SecurityQualityOfService: null,
  });

  const IoStatusBlock = koffi.struct("IO_STATUS_BLOCK_ATC_MK", {
    Status: "long",
    Information: "uintptr",
  });
  const iosb = koffi.alloc(IoStatusBlock, 1);
  koffi.encode(iosb, IoStatusBlock, { Status: 0, Information: 0 });

  const handleOut = koffi.alloc("void *", 1);

  const status = native.NtCreateFile(
    handleOut as unknown as Buffer,
    FILE_LIST_DIRECTORY | SYNCHRONIZE,
    oaPtr as unknown as Buffer,
    iosb as unknown as Buffer,
    null,
    FILE_ATTRIBUTE_DIRECTORY,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    FILE_CREATE,
    FILE_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT,
    null,
    0,
  );

  const statusU = status < 0 ? status + 0x100000000 : status;
  if (status !== 0) {
    if ((statusU & 0xffffffff) === 0xc0000035) {
      // Already exists — OK for mkdir -p style
      return;
    }
    const dos = native.RtlNtStatusToDosError(status);
    throw new WindowsHandlePathError(
      `NtCreateFile(mkdir) failed for '${relativeName}' (NTSTATUS=0x${(statusU & 0xffffffff).toString(16)}, win32=${dos})`,
    );
  }

  // Close the directory handle we just created — we only needed the create.
  const rawHandle = koffi.decode(handleOut, "void *") as number | bigint;
  const dirHandle =
    typeof rawHandle === "bigint" ? Number(rawHandle) : Number(rawHandle);
  native.CloseHandle(dirHandle);
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

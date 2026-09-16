/**
 * Prototype: pure HANDLE-based FFI (no CRT fd bridging).
 * 1. CreateFileW on a temp directory -> parent HANDLE
 * 2. GetFinalPathNameByHandleW -> canonical path
 * 3. NtCreateFile with RootDirectory=parent -> child file handle
 * 4. WriteFile -> content
 * 5. CloseHandle both
 */
import { mkdtempSync, writeSync as fswrite, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

function log(s: string) { fswrite(1, s + "\n"); }

const require = createRequire(process.cwd() + "/src/windows-handle-path.ts");
const koffi = require("koffi");

const ntdll = koffi.load("ntdll.dll");
const kernel32 = koffi.load("kernel32.dll");

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

const CreateFileW = kernel32.func("CreateFileW", "int64", [
  "str16", "uint32", "uint32", "void *", "uint32", "uint32", "void *",
]);
const GetFinalPathNameByHandleW = kernel32.func("GetFinalPathNameByHandleW", "uint32", [
  "uintptr", "void *", "uint32", "uint32",
]);
const WriteFile = kernel32.func("WriteFile", "int", [
  "uintptr", "void *", "uint32", "void *", "void *",
]);
const CloseHandle = kernel32.func("CloseHandle", "int", ["uintptr"]);
const NtCreateFile = ntdll.func("NtCreateFile", "long", [
  "void *", "uint32", "void *", "void *", "void *",
  "uint32", "uint32", "uint32", "uint32", "void *", "uint32",
]);

const FILE_LIST_DIRECTORY = 0x00000001;
const SYNCHRONIZE = 0x00100000;
const FILE_SHARE_ALL = 0x00000007;
const OPEN_EXISTING = 3;
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const FILE_ATTRIBUTE_NORMAL = 0x00000080;
const FILE_SHARE_RWD = 7;
const FILE_OPEN_IF = 3;
const FILE_NON_DIRECTORY_FILE = 0x00000040;
const FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020;
const OBJ_CASE_INSENSITIVE = 0x00000040;
const OBJ_DONT_REPARSE = 0x00001000;

const project = mkdtempSync(join(tmpdir(), "proto-"));
log("project " + project);

// 1. parent handle
const parentHandle = CreateFileW(project, FILE_LIST_DIRECTORY | SYNCHRONIZE, FILE_SHARE_ALL, null, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, null);
log("parentHandle " + parentHandle);
if (parentHandle === -1 || parentHandle <= 0) { log("CreateFileW FAILED"); process.exit(1); }

// 2. final path
const pathBuf = Buffer.alloc(2 * 32768);
const n = GetFinalPathNameByHandleW(parentHandle, pathBuf, 32768, 0);
log("finalPathLen " + n);
const finalPath = pathBuf.subarray(0, n * 2).toString("utf16le");
log("finalPath " + finalPath);

// 3. NtCreateFile child relative to parent handle
const nameU16 = Buffer.from("ok.txt", "utf16le");
const usPtr = koffi.alloc(UnicodeString, 1);
koffi.encode(usPtr, UnicodeString, { Length: nameU16.length, MaximumLength: nameU16.length, Buffer: nameU16 });
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

log("calling NtCreateFile");
const status = NtCreateFile(
  handleOut,
  GENERIC_READ | GENERIC_WRITE | SYNCHRONIZE,
  oaPtr,
  iosb,
  null,
  FILE_ATTRIBUTE_NORMAL,
  FILE_SHARE_RWD,
  FILE_OPEN_IF,
  FILE_NON_DIRECTORY_FILE | FILE_SYNCHRONOUS_IO_NONALERT,
  null,
  0,
);
log("status " + status + " unsigned " + (status >>> 0));
if (status !== 0) { CloseHandle(parentHandle); process.exit(1); }
const childHandle = koffi.decode(handleOut, "void *");
log("childHandle " + childHandle);

// 4. WriteFile
const content = Buffer.from("hello-from-ffi\n", "utf8");
const writtenPtr = koffi.alloc("uint32", 1);
const ok = WriteFile(childHandle, content, content.length, writtenPtr, null);
log("WriteFile ok=" + ok + " written=" + koffi.decode(writtenPtr, "uint32"));

CloseHandle(childHandle);
CloseHandle(parentHandle);

// 5. verify
log("exists " + existsSync(join(project, "ok.txt")));
log("content " + JSON.stringify(readFileSync(join(project, "ok.txt"), "utf8")));
rmSync(project, { recursive: true, force: true });
log("PROTO DONE");

import { mkdtempSync, openSync, writeSync as fswrite } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

function log(s: string) { fswrite(1, s + "\n"); }

const require = createRequire("C:/Users/Miriam/Personal_Coding/terminal_web_app/experiments/version_5/ai-terminal-chat/server-typescript/src/windows-handle-path.ts");
const koffi = require("koffi");
const ntdll = koffi.load("ntdll.dll");
let crt;
try { crt = koffi.load("ucrtbase.dll"); } catch { crt = koffi.load("msvcrt.dll"); }
log("loaded dlls");

const UnicodeString = koffi.struct("UNICODE_STRING", { Length: "uint16", MaximumLength: "uint16", Buffer: "void *" });
const ObjectAttributes = koffi.struct("OBJECT_ATTRIBUTES", { Length: "uint32", RootDirectory: "void *", ObjectName: "void *", Attributes: "uint32", SecurityDescriptor: "void *", SecurityQualityOfService: "void *" });
const IoStatusBlock = koffi.struct("IO_STATUS_BLOCK", { Status: "void *", Information: "uintptr" });
const NtCreateFile = ntdll.func("NtCreateFile", "long", ["void *","uint32","void *","void *","void *","uint32","uint32","uint32","uint32","void *","uint32"]);
const getOsFHandle = crt.func("_get_osfhandle", "intptr", ["int"]);
const openOsFHandle = crt.func("_open_osfhandle", "int", ["intptr", "int"]);
log("structs + funcs ready, sizeof(OA)=" + koffi.sizeof(ObjectAttributes));

const project = mkdtempSync(join(tmpdir(), "repro-"));
const pfd = openSync(project, 0x0000 | 0x10000);
const parentHandle = getOsFHandle(pfd);
log("parentHandle " + parentHandle);

const nameU16 = Buffer.from("ok.txt", "utf16le");
const usPtr = koffi.alloc(UnicodeString, 1);
koffi.encode(usPtr, UnicodeString, { Length: nameU16.length, MaximumLength: nameU16.length, Buffer: nameU16 });
const oaPtr = koffi.alloc(ObjectAttributes, 1);
koffi.encode(oaPtr, ObjectAttributes, { Length: koffi.sizeof(ObjectAttributes), RootDirectory: parentHandle, ObjectName: usPtr, Attributes: 0x1040, SecurityDescriptor: null, SecurityQualityOfService: null });
const iosb = koffi.alloc(IoStatusBlock, 1);
koffi.encode(iosb, IoStatusBlock, { Status: null, Information: 0 });
const handleOut = koffi.alloc("void *", 1);
log("calling NtCreateFile");
const status = NtCreateFile(handleOut, 0x80000000 | 0x40000000 | 0x00100000, oaPtr, iosb, null, 0x80, 7, 3, 0x60, null, 0);
log("status " + status);
const handle = koffi.decode(handleOut, "void *");
log("handle " + handle);
const fd = openOsFHandle(handle, 2 | 0x8000);
log("fd " + fd);

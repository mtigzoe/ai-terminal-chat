import { createRequire } from "node:module";
import { writeSync } from "node:fs";
const log = (s) => { try { writeSync(2, s + "\n"); } catch {} };
const require = createRequire(import.meta.url);
const koffi = require("koffi");
const kernel32 = koffi.load("kernel32.dll");
const crt = koffi.load("ucrtbase.dll");
const CreateFileW = kernel32.func("CreateFileW", "int64", ["str16", "uint32", "uint32", "void *", "uint32", "uint32", "void *"]);
const openOs = crt.func("_open_osfhandle", "int", ["intptr", "int"]);
const { readFileSync, fstatSync, closeSync } = await import("node:fs");
const { join } = await import("node:path");
const { tmpdir } = await import("node:os");
const p = mkdtempSync2();
function mkdtempSync2(){ return require("node:fs").mkdtempSync(join(tmpdir(), "varc-")); }
const target = join(p, "hello.txt");
require("node:fs").writeFileSync(target, "HELLO");
log("C1 file written");
const GENERIC_READ = 0x80000000, OPEN_EXISTING = 3, SYNCHRONIZE = 0x00100000;
const h = CreateFileW(target, GENERIC_READ | SYNCHRONIZE, 7, null, OPEN_EXISTING, 0x80, null);
log("C2 raw handle=" + h);
const fd = openOs(h, 0 | 0x8000);
log("C3 crt fd=" + fd);
if (fd >= 0) {
  const st = fstatSync(fd);
  log("C4 node fstatSync ok size=" + st.size);
  log("C5 node read=" + JSON.stringify(readFileSync(fd, "utf8")));
  closeSync(fd);
  log("C6 node closeSync ok");
}
log("DONE-C");

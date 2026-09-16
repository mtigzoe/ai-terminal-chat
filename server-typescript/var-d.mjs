import { createRequire } from "node:module";
import { writeSync } from "node:fs";
const log = (s) => { try { writeSync(2, s + "\n"); } catch {} };
const require = createRequire(import.meta.url);
const koffi = require("koffi");
let node;
try { node = koffi.load("node.exe"); log("D1 node.exe loaded via koffi"); } catch (e) { log("D1 FAIL " + e.message); process.exit(0); }
let uvGet, uvOpen;
try { uvGet = node.func("uv_get_osfhandle", "void *", ["int"]); log("D2 uv_get_osfhandle bound"); } catch (e) { log("D2 FAIL " + e.message); }
try { uvOpen = node.func("uv_open_osfhandle", "int", ["void *"]); log("D3 uv_open_osfhandle bound"); } catch (e) { log("D3 FAIL " + e.message); }
const { openSync, writeFileSync, mkdtempSync, fstatSync, readFileSync, closeSync } = await import("node:fs");
const { join } = await import("node:path");
const { tmpdir } = await import("node:os");
const p = mkdtempSync(join(tmpdir(), "vard-"));
const target = join(p, "hello.txt");
writeFileSync(target, "HELLO");
const fd = openSync(target, 0);
log("D4 node fd=" + fd);
if (uvGet) {
  const h = uvGet(fd);
  log("D5 uv_get_osfhandle -> " + h);
}
if (uvOpen) {
  const k32 = koffi.load("kernel32.dll");
  const CreateFileW = k32.func("CreateFileW", "int64", ["str16", "uint32", "uint32", "void *", "uint32", "uint32", "void *"]);
  const h2 = CreateFileW(target, 0x80000000 | 0x00100000, 7, null, 3, 0x80, null);
  log("D6 CreateFileW handle=" + h2);
  const fd2 = uvOpen(h2);
  log("D7 uv_open_osfhandle fd=" + fd2);
  if (fd2 >= 0) {
    const st = fstatSync(fd2);
    log("D8 node fstatSync ok size=" + st.size);
    log("D9 node read=" + JSON.stringify(readFileSync(fd2, "utf8")));
    closeSync(fd2);
    log("D10 node closeSync ok");
  }
}
log("DONE-D");

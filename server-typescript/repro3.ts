import { mkdtempSync, openSync, writeSync as fswrite, constants } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
function log(s: string) { fswrite(1, s + "\n"); }
const require = createRequire(process.cwd() + "/src/windows-handle-path.ts");
const koffi = require("koffi");
log("node " + process.version);
const crt = koffi.load("ucrtbase.dll");
const getOsFHandle = crt.func("_get_osfhandle", "intptr", ["int"]);
const project = mkdtempSync(join(tmpdir(), "repro-"));
log("O_DIRECTORY constant = " + constants.O_DIRECTORY);
const pfd = openSync(project, constants.O_RDONLY | constants.O_DIRECTORY);
log("pfd " + pfd);
log("calling _get_osfhandle");
const h = getOsFHandle(pfd);
log("handle " + h);

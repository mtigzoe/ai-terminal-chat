import { mkdtempSync, openSync, closeSync, writeSync, fstatSync, constants, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openRelativeToDirFd } from "./src/windows-handle-path.ts";

const project = mkdtempSync(join(tmpdir(), "repro-"));
const pfd = openSync(project, constants.O_RDONLY | constants.O_DIRECTORY);
console.log("parent fd", pfd);
const fd = openRelativeToDirFd(pfd, "ok.txt", { create: true, exclusive: false, write: true });
console.log("child fd", fd);
closeSync(pfd);
console.log("about to fstat");
const st = fstatSync(fd);
console.log("isFile", st.isFile());
writeSync(fd, Buffer.from("hello\n"));
console.log("wrote");
closeSync(fd);
console.log("closed", JSON.stringify(readFileSync(join(project, "ok.txt"), "utf8")));
console.log("DONE");

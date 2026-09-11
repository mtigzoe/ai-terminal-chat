import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

if (process.env.GITHUB_ACTIONS !== "true") {
  process.exit(0);
}

const securityPath = "src/security.ts";
let security = readFileSync(securityPath, "utf8");
const oldProbe = `const probeFd = openRelativeToDirFd(currentFd, part, {\n            create: false,\n            write: false,\n          });`;
const newProbe = `const probeFd = openRelativeToDirFd(currentFd, part, {\n            create: false,\n            write: false,\n            directory: true,\n          });`;
const oldNext = `nextFd = openRelativeToDirFd(currentFd, part, {\n            create: false,\n            write: false,\n          });`;
const newNext = `nextFd = openRelativeToDirFd(currentFd, part, {\n            create: false,\n            write: false,\n            directory: true,\n          });`;
if ((security.match(newProbe) ?? []).length === 1 && (security.match(newNext) ?? []).length === 1) {
  // Already patched.
} else {
  if ((security.match(oldProbe) ?? []).length !== 1 || (security.match(oldNext) ?? []).length !== 1) {
    throw new Error("Expected Windows directory traversal blocks were not found exactly once.");
  }
  security = security.replace(oldProbe, newProbe).replace(oldNext, newNext);
  writeFileSync(securityPath, security);
}

const gitPath = "src/git.ts";
let git = readFileSync(gitPath, "utf8");
const oldGit = `        GIT_EXTERNAL_DIFF: "",\n        GIT_ASKPASS: "",`;
const newGit = `        // Do not set GIT_EXTERNAL_DIFF. Git treats an empty value as an\n        // external diff command and then attempts to execute it.\n        GIT_ASKPASS: "",`;
if (git.includes(newGit)) {
  // Already patched.
} else {
  if ((git.match(/GIT_EXTERNAL_DIFF: ""/g) ?? []).length !== 1) {
    throw new Error("Expected GIT_EXTERNAL_DIFF environment entry was not found exactly once.");
  }
  git = git.replace(oldGit, newGit);
  writeFileSync(gitPath, git);
}

execFileSync("git", ["restore", "server-typescript/package.json", "server-typescript/scripts/security-maintenance.mjs"]);
execFileSync("git", ["add", "server-typescript/src/security.ts", "server-typescript/src/git.ts"]);
execFileSync("git", ["diff", "--cached", "--check"]);
const status = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" });
if (!status.trim()) {
  process.exit(0);
}
execFileSync("git", ["config", "user.name", "github-actions[bot]"]);
execFileSync("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
execFileSync("git", ["commit", "-m", "fix(security): repair Windows traversal and Git diff environment"], { stdio: "inherit" });
execFileSync("git", ["push", "origin", "HEAD:main"], { stdio: "inherit" });

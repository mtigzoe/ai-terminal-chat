import {
  __setAllowedCommandsForTests,
  isCommandAllowed,
  tokenizeCommand,
} from "./terminal.ts";

__setAllowedCommandsForTests(["git status", "git branch", "npm test"]);

const cmd = "git status && whoami";
const tokens = tokenizeCommand(cmd);
console.log("tokens:", JSON.stringify(tokens));
console.log("joined:", JSON.stringify(tokens.join(" ")));
console.log("isCommandAllowed:", isCommandAllowed(cmd));

// Check what isCommandAllowed returns for the actual test inputs
const tests = [
  "git status && whoami",
  "npm test; rm -rf /",
  "git status | grep secret",
];
for (const t of tests) {
  console.log(`isCommandAllowed(${JSON.stringify(t)}):`, isCommandAllowed(t));
}

// Import before application modules in every backend test entry point. Tests
// may exercise real persistence, but must never use the developer's profile.
import { randomUUID } from "node:crypto";
import {
  lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const temporaryParent = realpathSync(tmpdir());
const prefix = "ai-terminal-chat-test-profile-";
export const testProfileRoot = mkdtempSync(join(temporaryParent, prefix));
const ownershipFile = join(testProfileRoot, ".test-profile-owner");
const ownershipToken = `${process.pid}:${randomUUID()}`;
writeFileSync(ownershipFile, ownershipToken, { flag: "wx", mode: 0o600 });

const home = join(testProfileRoot, "home");
const appData = join(home, "AppData", "Roaming");
const localAppData = join(home, "AppData", "Local");
const configDirectory = join(testProfileRoot, "backend-config");
for (const directory of [home, appData, localAppData, configDirectory]) {
  mkdirSync(directory, { recursive: true });
}

// Remove differently cased inherited keys too: Windows environment names are
// case-insensitive, while a copied environment object may retain their casing.
const profileVariables = new Set([
  "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "AI_TERMINAL_CHAT_CONFIG_DIR",
]);
for (const name of Object.keys(process.env)) {
  if (profileVariables.has(name.toUpperCase())) delete process.env[name];
}
Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  APPDATA: appData,
  LOCALAPPDATA: localAppData,
  AI_TERMINAL_CHAT_CONFIG_DIR: configDirectory,
});

process.once("exit", () => {
  try {
    // Delete only the exact, still-owned directory created above. Never follow
    // a replacement symlink/junction or derive the cleanup target from env.
    const target = resolve(testProfileRoot);
    if (dirname(target) !== temporaryParent || !basename(target).startsWith(prefix) ||
        lstatSync(target).isSymbolicLink() || realpathSync(target) !== target ||
        readFileSync(ownershipFile, "utf8") !== ownershipToken) {
      throw new Error("Disposable test profile ownership could not be verified.");
    }
    rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch (error) {
    console.error("Could not remove disposable backend test profile:", error.message);
    process.exitCode = process.exitCode || 1;
  }
});

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Use the desktop app's selected profile when it supplies a config directory.
 * Standalone servers retain their existing home-directory configuration.
 * A malformed explicit directory must never fall back to the ordinary profile.
 */
export function getConfigDirectory(): string {
  const configured = process.env.AI_TERMINAL_CHAT_CONFIG_DIR;
  if (configured === undefined) {
    return join(homedir(), ".ai-terminal-chat");
  }
  if (!configured.trim() || !isAbsolute(configured)) {
    throw new Error("AI_TERMINAL_CHAT_CONFIG_DIR must be an absolute directory path.");
  }
  return resolve(configured);
}

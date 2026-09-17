import crypto from "node:crypto";
import fs from "node:fs";
import { readFileWithinProject, safePath } from "./security.ts";

export interface ConfirmationFileState {
  path: string;
  exists: boolean;
  sha256: string | null;
}

export type ConfirmationFileStates = ConfirmationFileState[];

const MAX_FINGERPRINT_BYTES = 50 * 1024 * 1024;

function fingerprintFile(relPath: string): ConfirmationFileState {
  const normalized = String(relPath);
  try {
    const resolved = safePath(normalized);
    if (!fs.existsSync(resolved)) {
      return { path: normalized, exists: false, sha256: null };
    }

    const read = readFileWithinProject(normalized, MAX_FINGERPRINT_BYTES);
    return {
      path: normalized,
      exists: true,
      sha256: crypto.createHash("sha256").update(Buffer.from(read.contents, "utf8")).digest("hex"),
    };
  } catch {
    // Treat an unreadable or unsafe target as a state mismatch. A pending
    // confirmation must never become less restrictive because state capture
    // failed.
    return { path: normalized, exists: false, sha256: null };
  }
}

export function captureConfirmationFileStates(paths: string[]): ConfirmationFileStates {
  const unique = [...new Set(paths.map((value) => String(value)).filter(Boolean))];
  return unique.map(fingerprintFile);
}

export function confirmationFileStatesMatch(
  expected: ConfirmationFileStates,
): boolean {
  return expected.every((state) => {
    const current = fingerprintFile(state.path);
    return current.exists === state.exists && current.sha256 === state.sha256;
  });
}

function patchTargetPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const match of patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    const oldPath = match[1]?.trim();
    const newPath = match[2]?.trim();
    if (oldPath) paths.push(oldPath);
    if (newPath) paths.push(newPath);
  }
  return [...new Set(paths)];
}

export function confirmationPathsForPending(
  toolName: string,
  args: Record<string, unknown>,
): string[] {
  if (toolName === "write_file" || toolName === "delete_file") {
    const target = typeof args.path === "string" ? args.path.trim() : "";
    return target ? [target] : [];
  }
  if (toolName === "apply_patch") {
    return patchTargetPaths(typeof args.patch === "string" ? args.patch : "");
  }
  return [];
}

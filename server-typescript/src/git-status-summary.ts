import { gitStatus } from "./git.ts";

export interface GitStatusSummary {
  summary: string;
  details: string[];
  branch: string | null;
  clean: boolean;
  ahead: number;
  behind: number;
  changed: number;
  untracked: number;
  staged: number;
  conflicts: number;
  hasRemote: boolean;
  synchronized: boolean;
}

// The full set of `git status --short` XY codes that represent unresolved
// merge conflicts. Check these before ordinary staged add/delete handling.
const GIT_CONFLICT_STATUS_CODES = new Set([
  "DD",
  "AU",
  "UD",
  "UA",
  "DU",
  "AA",
  "UU",
]);

/**
 * Turn `git status --short --branch` into concise, plain-language information.
 * This is deliberately deterministic so users do not have to decode Git's
 * two-column status codes or guess whether commits have been pushed.
 */
export async function gitStatusSummary(): Promise<GitStatusSummary | { error: string }> {
  const result = await gitStatus();
  if ("error" in result) return result as { error: string };

  return summarizeGitStatus(String(result.status || ""));
}

/** Parse `git status --short --branch` output into user-facing status. */
export function summarizeGitStatus(status: string): GitStatusSummary {
  const lines = status.split(/\r?\n/).filter(Boolean);
  const branchLine = lines.find((line) => line.startsWith("## ")) || "";

  // `git status --short --branch` prefixes a fresh/detached repo with a
  // banner ("## No commits yet on main", "## Initial commit on master",
  // "## HEAD (no branch)") instead of naming the branch directly. Strip those
  // known forms so the banner text is never reported as the branch name.
  const branchMatch = branchLine.match(
    /^##\s+(?:(?:No commits yet on|Initial commit on)\s+)?(.+?)(?:\.\.\.|$)/
  );
  const branch = branchMatch?.[1]?.trim() || null;
  const hasRemote = branchLine.includes("...");

  let ahead = 0;
  let behind = 0;
  const trackingMatch = branchLine.match(/\[([^\]]+)\]/);
  if (trackingMatch) {
    const tracking = trackingMatch[1];
    const aheadMatch = tracking.match(/ahead (\d+)/);
    const behindMatch = tracking.match(/behind (\d+)/);
    ahead = aheadMatch ? Number(aheadMatch[1]) : 0;
    behind = behindMatch ? Number(behindMatch[1]) : 0;
  }

  let changed = 0;
  let untracked = 0;
  let staged = 0;
  let conflicts = 0;
  const details: string[] = [];

  for (const line of lines) {
    if (line.startsWith("## ") || line.length < 3) continue;

    const x = line[0];
    const y = line[1];
    const file = line.slice(3).trim();

    if (x === "?" && y === "?") {
      untracked++;
      details.push(`${file} — new file, not tracked by Git`);
      continue;
    }

    if (GIT_CONFLICT_STATUS_CODES.has(`${x}${y}`)) {
      changed++;
      conflicts++;
      details.push(
        `${file} — unresolved merge conflict, must be resolved before this can be committed`,
      );
      continue;
    }

    changed++;
    if (x !== " ") staged++;

    let description = "changed";
    if (x === "A" || y === "A") description = "added";
    else if (x === "D" || y === "D") description = "deleted";
    else if (x === "R" || y === "R") description = "renamed";
    else if (x === "M" || y === "M") description = "modified";

    const stageNote = x !== " " ? ", staged" : ", not staged";
    details.push(`${file} — ${description}${stageNote}`);
  }

  const clean = changed === 0 && untracked === 0;
  const synchronized = hasRemote && ahead === 0 && behind === 0;
  const totalChanges = changed + untracked;
  const parts: string[] = [];

  if (clean) {
    parts.push("Your working tree is clean.");
  } else {
    parts.push(
      `You have ${totalChanges} uncommitted file${totalChanges === 1 ? "" : "s"}.`
    );
  }

  if (conflicts > 0) {
    parts.push(
      `${conflicts} file${conflicts === 1 ? " has" : "s have"} an unresolved merge conflict and must be resolved before you can commit.`,
    );
  }

  if (staged > 0) {
    parts.push(
      `${staged} file${staged === 1 ? " is" : "s are"} staged for the next commit.`
    );
  }

  if (ahead > 0 && behind > 0) {
    parts.push(
      `Your branch has ${ahead} commit${ahead === 1 ? "" : "s"} not pushed and is ${behind} commit${behind === 1 ? "" : "s"} behind the remote.`
    );
  } else if (ahead > 0) {
    parts.push(
      `Your branch has ${ahead} commit${ahead === 1 ? "" : "s"} not pushed to the remote.`
    );
  } else if (behind > 0) {
    parts.push(
      `Your branch is ${behind} commit${behind === 1 ? "" : "s"} behind the remote.`
    );
  } else if (synchronized) {
    parts.push("Your local branch is synchronized with its remote branch.");
  } else if (!hasRemote && branch) {
    parts.push("This branch is not tracking a remote branch, so Git cannot tell whether it has been pushed.");
  }

  return {
    summary: parts.join(" "),
    details,
    branch,
    clean,
    ahead,
    behind,
    changed,
    untracked,
    staged,
    conflicts,
    hasRemote,
    synchronized,
  };
}

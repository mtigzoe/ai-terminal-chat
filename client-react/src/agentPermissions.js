// How much the agent may do without pausing for an Allow/Decline choice.
// Shared by the Chat page (which applies it) and the Settings page (which sets it).

export const AGENT_PERMISSION_STORAGE_KEY = 'ai-terminal-chat:agent-permission-mode';

export const AGENT_PERMISSION_OPTIONS = [
  {
    value: 'ask',
    label: 'Ask first (recommended)',
    description:
      'The agent stops and asks before it writes a file, deletes a file, reads a file you have not selected, or runs a Git command that changes the repository.',
  },
  {
    value: 'read',
    label: 'Allow file reads',
    description:
      'The agent may read any project file without asking. It still asks before writing or deleting files and before staging, committing, pushing, pulling, or restoring in Git.',
  },
  {
    value: 'always',
    label: 'Always allow',
    description:
      'The agent runs every action immediately with no confirmation, including file writes, file deletions, and Git commits and pushes. Use this only in a repository whose changes you can undo.',
  },
];

export function readAgentPermissionMode() {
  try {
    const raw = localStorage.getItem(AGENT_PERMISSION_STORAGE_KEY);
    return raw === 'read' || raw === 'always' ? raw : 'ask';
  } catch {
    return 'ask';
  }
}

export function shouldAutoApprove(pending) {
  if (!pending) return false;
  const mode = readAgentPermissionMode();
  if (mode === 'always') return true;
  if (mode === 'read') return pending.name === 'read_file_permission';
  return false;
}

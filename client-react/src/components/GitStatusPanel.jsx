import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import './GitStatusPanel.css';

/** Slow background refresh when the agent is idle (not the primary update path). */
const POLL_MS_IDLE = 30000;

/** Tool names whose successful results may change the working tree or index. */
export const REPO_MUTATING_TOOLS = new Set([
  'write_file',
  'create_file',
  'apply_patch',
  'delete_file',
  'git_add',
  'run_command',
]);

/**
 * Build the concise one-line summary shown in the chat UI.
 * Example: "Git status — main — 2 modified, 3 untracked"
 */
export function formatGitStatusLine(status) {
  if (!status || typeof status !== 'object') return 'Git status — unavailable';
  if (status.error) return `Git status — ${status.error}`;

  const parts = [];
  if (status.branch) parts.push(String(status.branch));

  if (status.clean) {
    parts.push('clean');
  } else {
    const changed = Number(status.changed) || 0;
    const staged = Number(status.staged) || 0;
    const untracked = Number(status.untracked) || 0;
    const conflicts = Number(status.conflicts) || 0;
    const modified = Math.max(0, changed - staged);
    const detail = [];
    if (staged) detail.push(`${staged} staged`);
    if (modified) detail.push(`${modified} modified`);
    if (untracked) detail.push(`${untracked} untracked`);
    if (conflicts) detail.push(`${conflicts} conflict${conflicts === 1 ? '' : 's'}`);
    parts.push(detail.length ? detail.join(', ') : 'changes');
  }

  if (status.ahead) parts.push(`↑${status.ahead}`);
  if (status.behind) parts.push(`↓${status.behind}`);

  return `Git status — ${parts.join(' — ')}`;
}

/**
 * Persistent Git status under the message input.
 *
 * Primary updates: parent increments `refreshToken` after repo-mutating
 * tool results and when an agent request starts/finishes.
 * Secondary: infrequent idle poll only (no tight loop while streaming).
 */
export default function GitStatusPanel({ host, waiting, refreshToken = 0 }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [liveText, setLiveText] = useState('');
  const lastLine = useRef('');
  const timerRef = useRef(null);
  const inFlight = useRef(false);

  const fetchStatus = useCallback(async () => {
    if (!host || inFlight.current) return;
    inFlight.current = true;
    try {
      const { data } = await axios.get(`${host}/git-status`, { timeout: 8000 });
      setStatus(data);
      setError('');
      const line = formatGitStatusLine(data);
      if (line !== lastLine.current) {
        lastLine.current = line;
        // Update polite live region only when the summary actually changes.
        setLiveText(line);
      }
    } catch (e) {
      const msg =
        e.response?.data?.error ||
        (e.code === 'ECONNABORTED' ? 'Git status timed out' : 'Git status unavailable');
      setError(msg);
      setStatus(null);
      const line = `Git status — ${msg}`;
      if (line !== lastLine.current) {
        lastLine.current = line;
        setLiveText(line);
      }
    } finally {
      inFlight.current = false;
    }
  }, [host]);

  // Mount + token-driven refresh (tool results / request boundaries).
  useEffect(() => {
    fetchStatus();
  }, [fetchStatus, refreshToken]);

  // Infrequent idle poll only; no fast poll while the agent is working.
  useEffect(() => {
    if (waiting) {
      if (timerRef.current) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return undefined;
    }
    timerRef.current = window.setInterval(fetchStatus, POLL_MS_IDLE);
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, [fetchStatus, waiting]);

  const line = error
    ? `Git status — ${error}`
    : status
      ? formatGitStatusLine(status)
      : 'Git status — loading';

  return (
    <div
      className={`git-status-panel ${status?.clean ? 'clean' : 'dirty'}`}
      id="git-status-region"
    >
      <p className="git-status-summary" aria-label="Repository Git status">
        {line}
      </p>
      {/* Separate live region: only announces when liveText changes. */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {liveText}
      </div>
    </div>
  );
}

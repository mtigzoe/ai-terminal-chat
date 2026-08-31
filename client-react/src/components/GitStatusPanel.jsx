import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import './GitStatusPanel.css';

const POLL_MS_ACTIVE = 2500;
const POLL_MS_IDLE = 15000;

/**
 * Persistent Git status panel shown below the chat message input.
 * Polls /git-status more frequently while the agent is working so
 * file/index changes appear without the user asking for status.
 */
export default function GitStatusPanel({ host, waiting }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const lastSummary = useRef('');
  const timerRef = useRef(null);

  const fetchStatus = useCallback(async () => {
    try {
      const { data } = await axios.get(`${host}/git-status`, { timeout: 8000 });
      setStatus(data);
      setError('');
      if (data?.summary && data.summary !== lastSummary.current) {
        lastSummary.current = data.summary;
      }
    } catch (e) {
      const msg =
        e.response?.data?.error ||
        (e.code === 'ECONNABORTED' ? 'Git status timed out' : 'Git status unavailable');
      setError(msg);
      setStatus(null);
    }
  }, [host]);

  useEffect(() => {
    fetchStatus();
    const interval = waiting ? POLL_MS_ACTIVE : POLL_MS_IDLE;
    timerRef.current = window.setInterval(fetchStatus, interval);
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, [fetchStatus, waiting]);

  if (error) {
    return (
      <div
        className="git-status-panel"
        role="status"
        aria-live="polite"
        aria-label="Repository Git status"
      >
        <span className="git-status-error">{error}</span>
      </div>
    );
  }

  if (!status) {
    return null;
  }

  const parts = [];
  if (status.branch) parts.push(status.branch);
  if (status.clean) {
    parts.push('clean');
  } else {
    const modified = Math.max(0, (status.changed || 0) - (status.staged || 0));
    if (status.staged) parts.push(`${status.staged} staged`);
    if (modified) parts.push(`${modified} modified`);
    if (status.untracked) parts.push(`${status.untracked} untracked`);
    if (status.conflicts) parts.push(`${status.conflicts} conflict`);
  }
  if (status.ahead) parts.push(`↑${status.ahead}`);
  if (status.behind) parts.push(`↓${status.behind}`);

  const summaryText = parts.length ? parts.join(' · ') : status.summary || 'Git status';

  return (
    <div
      className={`git-status-panel ${status.clean ? 'clean' : 'dirty'}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label="Repository Git status"
    >
      <span className="git-status-summary">{summaryText}</span>
    </div>
  );
}

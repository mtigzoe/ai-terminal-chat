import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import './GitStatusPanel.css';

const POLL_MS_ACTIVE = 2500;
const POLL_MS_HIDDEN = 30000;

export function parseGitStatus(stdout = '') {
  const lines = String(stdout).split(/\r?\n/).filter(Boolean);
  const header = lines.find((line) => line.startsWith('## '));
  const branch = header ? header.slice(3).split('...')[0].trim() : '';

  let staged = 0;
  let modified = 0;
  let untracked = 0;
  let conflicts = 0;

  for (const line of lines) {
    if (line.startsWith('## ')) continue;
    if (line.startsWith('?? ')) {
      untracked += 1;
      continue;
    }

    const x = line[0] || ' ';
    const y = line[1] || ' ';
    if (x === 'U' || y === 'U') conflicts += 1;
    if (x !== ' ') staged += 1;
    if (y !== ' ') modified += 1;
  }

  return {
    branch,
    clean: staged === 0 && modified === 0 && untracked === 0 && conflicts === 0,
    staged,
    changed: staged + modified,
    modified,
    untracked,
    conflicts,
  };
}

export function formatGitStatusLine(status) {
  if (!status || typeof status !== 'object') return 'Git status — unavailable';
  if (status.error) return `Git status — ${status.error}`;

  const parts = [];
  if (status.branch) parts.push(String(status.branch));

  if (status.clean) {
    parts.push('clean');
  } else {
    const staged = Number(status.staged) || 0;
    const modified = Number(status.modified) || 0;
    const untracked = Number(status.untracked) || 0;
    const conflicts = Number(status.conflicts) || 0;
    const detail = [];
    if (staged) detail.push(`${staged} staged`);
    if (modified) detail.push(`${modified} modified`);
    if (untracked) detail.push(`${untracked} untracked`);
    if (conflicts) detail.push(`${conflicts} conflict${conflicts === 1 ? '' : 's'}`);
    parts.push(detail.length ? detail.join(', ') : 'changes');
  }

  return `Git status — ${parts.join(' — ')}`;
}

export default function GitStatusPanel() {
  const host = (import.meta.env.VITE_API_URL || 'http://localhost:9000').replace(/\/+$/, '');
  const [status, setStatus] = useState(null);
  const [error, setError] = useState('');
  const [liveText, setLiveText] = useState('');
  const lastLine = useRef('');
  const inFlight = useRef(false);
  const timerRef = useRef(null);

  const fetchStatus = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const response = await axios.post(
        `${host}/terminal/run`,
        { command: 'git status --porcelain=v1 -b' },
        { timeout: 8000 },
      );
      const nextStatus = parseGitStatus(response.data?.stdout || '');
      setStatus(nextStatus);
      setError('');
      const line = formatGitStatusLine(nextStatus);
      if (line !== lastLine.current) {
        lastLine.current = line;
        setLiveText(line);
      }
    } catch (e) {
      const msg = e.response?.data?.error || (e.code === 'ECONNABORTED' ? 'Git status timed out' : 'Git status unavailable');
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

  useEffect(() => {
    const schedule = () => {
      const delay = document.visibilityState === 'hidden' ? POLL_MS_HIDDEN : POLL_MS_ACTIVE;
      timerRef.current = window.setTimeout(async () => {
        await fetchStatus();
        schedule();
      }, delay);
    };

    fetchStatus();
    schedule();
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [fetchStatus]);

  const line = error
    ? `Git status — ${error}`
    : status
      ? formatGitStatusLine(status)
      : 'Git status — loading';

  return (
    <div className={`git-status-panel ${status?.clean ? 'clean' : 'dirty'}`} id="git-status-region">
      <p className="git-status-summary" aria-label="Repository Git status">{line}</p>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">{liveText}</div>
    </div>
  );
}

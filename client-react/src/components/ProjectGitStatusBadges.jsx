import { useEffect, useRef } from 'react';
import axios from 'axios';
import './ProjectGitStatusBadges.css';

export const STATUS_INFO = {
  M: { label: 'modified', className: 'modified' },
  A: { label: 'added', className: 'added' },
  D: { label: 'deleted', className: 'deleted' },
  R: { label: 'renamed', className: 'renamed' },
  C: { label: 'copied', className: 'copied' },
  U: { label: 'conflicted', className: 'conflicted' },
  '?': { label: 'untracked', className: 'untracked' },
};

const getHost = () => import.meta.env.VITE_API_URL || 'http://localhost:9000';

export function parseGitStatus(output) {
  const statuses = new Map();
  for (const line of String(output || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    const rawPath = line.slice(3).trim();
    if (!rawPath) continue;
    const statusCode = code === '??' ? '?' : (code[0] !== ' ' ? code[0] : code[1]);
    if (!STATUS_INFO[statusCode]) continue;
    const path = rawPath.includes(' -> ')
      ? rawPath.slice(rawPath.lastIndexOf(' -> ') + 4).trim()
      : rawPath;
    statuses.set(path.replace(/\\/g, '/'), statusCode);
  }
  return statuses;
}

export function buildDirectoryStatuses(statuses) {
  const result = new Map(statuses);
  for (const [path, status] of statuses) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      const directory = parts.slice(0, index).join('/');
      if (!result.has(directory)) result.set(directory, status);
      else if (result.get(directory) === '?') continue;
      else if (status === 'U') result.set(directory, 'U');
      else if (status === 'M' || status === 'A' || status === 'D') result.set(directory, status);
    }
  }
  return result;
}

const normalizeTreePath = (path) => String(path || '').replace(/^\.\//, '').replace(/\\/g, '/');

function decorateTree(tree, statuses) {
  const directoryStatuses = buildDirectoryStatuses(statuses);
  tree.querySelectorAll('[role="treeitem"][data-tree-path]').forEach((item) => {
    const path = normalizeTreePath(item.getAttribute('data-tree-path'));
    const statusCode = directoryStatuses.get(path);
    const existingBadge = item.querySelector('.project-git-status');
    const baseLabel = (item.getAttribute('data-git-base-label') || item.getAttribute('aria-label') || '')
      .replace(/, (modified|added|deleted|renamed|copied|conflicted|untracked)$/, '');
    item.setAttribute('data-git-base-label', baseLabel);

    if (!statusCode) {
      if (existingBadge) existingBadge.remove();
      if (item.getAttribute('aria-label') !== baseLabel) item.setAttribute('aria-label', baseLabel);
      return;
    }

    const info = STATUS_INFO[statusCode];
    if (!existingBadge) {
      const badge = document.createElement('span');
      badge.className = `project-git-status project-git-status-${info.className}`;
      badge.setAttribute('aria-hidden', 'true');
      badge.title = `Git status: ${info.label}`;
      badge.textContent = `[${statusCode}]`;
      item.appendChild(badge);
    }
    if (item.getAttribute('aria-label') !== `${baseLabel}, ${info.label}`) {
      item.setAttribute('aria-label', `${baseLabel}, ${info.label}`);
    }
  });
}

export default function ProjectGitStatusBadges() {
  const statusesRef = useRef(new Map());

  useEffect(() => {
    let active = true;
    let observer;
    let refreshTimer;
    let treeDiscoveryTimer;

    const refresh = async () => {
      try {
        const response = await axios.post(`${getHost()}/terminal/run`, {
          command: 'git status --porcelain=v1 --untracked-files=all',
        });
        if (!active) return;
        statusesRef.current = parseGitStatus(response.data?.stdout);
        const tree = document.querySelector('[data-focus-target="project-tree"]');
        if (tree) decorateTree(tree, statusesRef.current);
      } catch {
        // Git status is optional UI metadata. Leave the project tree usable
        // when the backend is unavailable or the project is not a Git repo.
      }
    };

    const observeTree = () => {
      const tree = document.querySelector('[data-focus-target="project-tree"]');
      if (!tree) return;
      observer?.disconnect();
      observer = new MutationObserver(() => decorateTree(tree, statusesRef.current));
      observer.observe(tree, { childList: true, subtree: true });
      decorateTree(tree, statusesRef.current);
      window.clearInterval(treeDiscoveryTimer);
    };

    refresh();
    observeTree();
    treeDiscoveryTimer = window.setInterval(observeTree, 500);
    refreshTimer = window.setInterval(refresh, 5000);

    return () => {
      active = false;
      window.clearInterval(refreshTimer);
      window.clearInterval(treeDiscoveryTimer);
      observer?.disconnect();
    };
  }, []);

  return null;
}

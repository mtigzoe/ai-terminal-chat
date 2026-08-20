import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import './GitStatusBadge.css';

const VIRTUALIZATION_THRESHOLD = 200;
const TREE_ROW_HEIGHT = 32;
const TREE_VIEWPORT_HEIGHT = 360;
const VIRTUALIZATION_OVERSCAN = 8;

const GIT_STATUS_INFO = {
  modified: { short: 'M', label: 'modified' },
  staged: { short: 'S', label: 'staged' },
  untracked: { short: 'U', label: 'untracked' },
  added: { short: 'A', label: 'added' },
  deleted: { short: 'D', label: 'deleted' },
  renamed: { short: 'R', label: 'renamed' },
  conflict: { short: 'C', label: 'conflict' },
};

// The full set of `git status --porcelain=v1` XY codes that represent an
// unresolved merge conflict. Most contain the literal character "U", but
// "both added" (AA) and "both deleted" (DD) do not, so they must be
// listed explicitly rather than detected with a substring check.
const CONFLICT_STATUS_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

const gitStatusFromLine = (line) => {
  if (!line || line.length < 3) return null;
  const code = line.slice(0, 2);
  let path = line.slice(3).trim();
  if (!path) return null;
  if (path.includes(' -> ')) path = path.split(' -> ').pop();
  path = path.replace(/\\/g, '/');

  if (code === '??') return ['untracked', path];
  if (CONFLICT_STATUS_CODES.has(code)) return ['conflict', path];
  if (code.includes('R')) return ['renamed', path];
  if (code.includes('D')) return ['deleted', path];
  if (code.includes('A')) return ['added', path];
  if (code.includes('M')) return [code[0] === ' ' ? 'modified' : 'staged', path];
  return null;
};

const statusPriority = ['conflict', 'untracked', 'staged', 'added', 'modified', 'deleted', 'renamed'];

export default function ProjectExplorer({ host, projectRoot = '', onFileOpened, onUseSelectedFiles, onInsertPathIntoTerminal }) {
  const storageKey = `project-explorer:${projectRoot || host || 'default'}`;
  const readStored = (key, fallback) => {
    try {
      const raw = sessionStorage.getItem(`${storageKey}:${key}`);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : fallback;
    } catch { return fallback; }
  };

  const [rootEntries, setRootEntries] = useState([]);
  const [children, setChildren] = useState({});
  const [expanded, setExpanded] = useState(() => new Set(readStored('expanded', [])));
  const [selectedFiles, setSelectedFiles] = useState(() => new Set(readStored('selected', [])));
  const [openedFile, setOpenedFile] = useState(null);
  const [activePath, setActivePath] = useState(null);
  const [status, setStatus] = useState('Loading project.');
  const [error, setError] = useState('');
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [filterQuery, setFilterQuery] = useState('');
  const [lastSelectedPath, setLastSelectedPath] = useState(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [gitStatuses, setGitStatuses] = useState({});
  const [gitStatusError, setGitStatusError] = useState('');
  const gitStatusRefreshing = useRef(false);
  const treeRef = useRef(null);
  const previewCloseRef = useRef(null);
  const filterRef = useRef(null);
  const skipNextPersist = useRef(false);

  const entryName = (entry) => entry?.name || entry?.path || '';
  const isDirectory = (entry) => entry?.type === 'directory' || entry?.is_dir;
  const entryPath = (entry, parentPath = '.') => {
    const name = entryName(entry);
    if (!name) return '';
    if (entry?.path) return entry.path;
    if (!parentPath || parentPath === '.') return name;
    return `${parentPath.replace(/[\\/]$/, '')}/${name}`;
  };

  const refreshGitStatus = useCallback(async () => {
    if (gitStatusRefreshing.current) return;
    gitStatusRefreshing.current = true;
    try {
      const response = await axios.post(`${host}/terminal/run`, {
        command: 'git status --porcelain=v1 --untracked-files=all',
      });
      const stdout = String(response.data?.stdout || '');
      const next = {};
      stdout.split(/\r?\n/).forEach((line) => {
        const parsed = gitStatusFromLine(line);
        if (parsed) next[parsed[1]] = parsed[0];
      });
      setGitStatuses(next);
      setGitStatusError('');
      return next;
    } catch {
      setGitStatusError('Git status unavailable. The project tree remains usable.');
      return {};
    } finally {
      gitStatusRefreshing.current = false;
    }
  }, [host]);

  const getGitStatus = (path, directory) => {
    const normalizedPath = path.replace(/\\/g, '/').replace(/^\.\//, '');
    const matching = Object.entries(gitStatuses)
      .filter(([candidate]) => candidate === normalizedPath || (directory && candidate.startsWith(`${normalizedPath}/`)))
      .map(([, value]) => value);
    if (!matching.length) return null;
    const kind = statusPriority.find((candidate) => matching.includes(candidate)) || matching[0];
    return GIT_STATUS_INFO[kind] ? { kind, ...GIT_STATUS_INFO[kind] } : null;
  };

  const loadDirectory = useCallback(async (path, announce = true) => {
    if (children[path]) return children[path];
    setError('');
    if (announce) setStatus(`Loading ${path}.`);
    try {
      const response = await axios.get(`${host}/project/list`, { params: { path } });
      const nextEntries = Array.isArray(response.data?.entries) ? response.data.entries : [];
      setChildren((current) => ({ ...current, [path]: nextEntries }));
      if (announce) setStatus(`${response.data?.path || path}: ${nextEntries.length} items.`);
      return nextEntries;
    } catch (err) {
      const message = err?.response?.data?.error || err?.message || 'Unable to load project directory.';
      setError(message);
      setStatus('Unable to load project directory.');
      return [];
    }
  }, [children, host]);

  useEffect(() => {
    let active = true;
    setStatus('Loading project.');
    axios.get(`${host}/project/list`, { params: { path: '.' } }).then(async (response) => {
      if (!active) return;
      const nextEntries = Array.isArray(response.data?.entries) ? response.data.entries : [];
      setRootEntries(nextEntries);
      setChildren((current) => ({ ...current, '.': nextEntries }));
      setError('');
      setStatus(`${response.data?.path || '.'}: ${nextEntries.length} items.`);
      void refreshGitStatus();
      const paths = Array.from(expanded).filter((path) => path && path !== '.');
      if (paths.length) {
        const loaded = {};
        for (const path of paths) {
          if (!active) return;
          try {
            const res = await axios.get(`${host}/project/list`, { params: { path } });
            loaded[path] = Array.isArray(res.data?.entries) ? res.data.entries : [];
          } catch { /* user can expand manually */ }
        }
        if (active && Object.keys(loaded).length) setChildren((current) => ({ ...current, ...loaded }));
      }
    }).catch((err) => {
      if (!active) return;
      const message = err?.response?.data?.error || err?.message || 'Unable to load project directory.';
      setRootEntries([]);
      setError(message);
      setStatus('Unable to load project directory.');
    });
    return () => { active = false; };
  // expanded is intentionally read only on mount.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host]);

  useEffect(() => {
    if (!openedFile) return undefined;
    previewCloseRef.current?.focus();
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpenedFile(null);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [openedFile]);

  useEffect(() => {
    const id = window.setInterval(() => {
      void refreshGitStatus();
    }, 5000);
    return () => window.clearInterval(id);
  }, [refreshGitStatus]);

  useEffect(() => {
    if (skipNextPersist.current) {
      skipNextPersist.current = false;
      return;
    }
    try {
      sessionStorage.setItem(`${storageKey}:expanded`, JSON.stringify(Array.from(expanded)));
      sessionStorage.setItem(`${storageKey}:selected`, JSON.stringify(Array.from(selectedFiles)));
    } catch { /* ignore unavailable sessionStorage */ }
  }, [expanded, selectedFiles, storageKey]);

  const toggleDirectory = async (path, name) => {
    if (expanded.has(path)) {
      setExpanded((current) => {
        const next = new Set(current);
        next.delete(path);
        return next;
      });
      setActivePath(path);
      setStatus(`${name} collapsed.`);
      return;
    }
    await loadDirectory(path);
    setExpanded((current) => new Set(current).add(path));
    setActivePath(path);
    setStatus(`${name} expanded.`);
  };

  const collapseAll = () => {
    setExpanded(new Set());
    setActivePath(null);
    setStatus('Project tree collapsed.');
    window.setTimeout(() => treeRef.current?.querySelector('[role="treeitem"]')?.focus?.(), 0);
  };

  const expandAll = () => {
    const next = new Set();
    const collect = (entries, parentPath) => {
      for (const entry of entries) {
        if (!isDirectory(entry)) continue;
        const path = entryPath(entry, parentPath);
        if (children[path]) {
          next.add(path);
          collect(children[path], path);
        }
      }
    };
    collect(rootEntries, '.');
    setExpanded(next);
    setActivePath(null);
    setStatus(next.size ? 'Project tree expanded.' : 'No loaded folders to expand.');
    window.setTimeout(() => treeRef.current?.querySelector('[role="treeitem"]')?.focus?.(), 0);
  };

  const openFile = async (entry, path) => {
    setStatus(`Opening ${entryName(entry)}.`);
    setError('');
    try {
      const response = await axios.get(`${host}/project/read`, { params: { path } });
      const content = response.data?.contents ?? response.data?.content ?? '';
      const file = { path: response.data?.path || path, content };
      setOpenedFile(file);
      onFileOpened?.(file);
      setActivePath(path);
      setStatus(`Opened ${entryName(entry)}. This does not send the file to the agent.`);
    } catch (err) {
      const message = err?.response?.data?.error || err?.message || 'Unable to read file.';
      setError(message);
      setStatus('Unable to open file.');
    }
  };

  const toggleFile = (entry, path, { shiftKey = false } = {}) => {
    setSelectedFiles((current) => {
      const next = new Set(current);
      if (shiftKey && lastSelectedPath) {
        const filePaths = visibleItems.filter((item) => !item.directory).map((item) => item.path);
        const start = filePaths.indexOf(lastSelectedPath);
        const end = filePaths.indexOf(path);
        if (start !== -1 && end !== -1) {
          const [from, to] = start < end ? [start, end] : [end, start];
          for (let i = from; i <= to; i += 1) next.add(filePaths[i]);
          setStatus(`Selected ${to - from + 1} files for the agent.`);
          return next;
        }
      }
      if (next.has(path)) {
        next.delete(path);
        setStatus(`${entryName(entry)} removed from agent selection.`);
      } else {
        next.add(path);
        setStatus(`${entryName(entry)} selected for the agent.`);
      }
      return next;
    });
    setLastSelectedPath(path);
    setActivePath(path);
  };

  const selectAllVisible = () => {
    const filePaths = visibleItems.filter((item) => !item.directory).map((item) => item.path);
    setSelectedFiles((current) => {
      const next = new Set(current);
      filePaths.forEach((p) => next.add(p));
      return next;
    });
    setStatus(filePaths.length ? `Selected ${filePaths.length} visible ${filePaths.length === 1 ? 'file' : 'files'} for the agent.` : 'No visible files to select.');
  };

  const clearSelection = () => {
    setSelectedFiles(new Set());
    setLastSelectedPath(null);
    setStatus('Cleared agent file selection.');
  };

  const useSelectedFiles = async () => {
    const paths = Array.from(selectedFiles);
    if (!paths.length) {
      setStatus('No files are selected for the agent.');
      return;
    }
    setStatus(`Reading ${paths.length} selected ${paths.length === 1 ? 'file' : 'files'} for the agent.`);
    setError('');
    try {
      const files = [];
      for (const path of paths) {
        const response = await axios.get(`${host}/project/read`, { params: { path } });
        files.push({ path: response.data?.path || path, content: response.data?.contents ?? response.data?.content ?? '' });
      }
      onUseSelectedFiles?.(files);
      setStatus(`${files.length} ${files.length === 1 ? 'file' : 'files'} supplied to the agent.`);
    } catch (err) {
      const message = err?.response?.data?.error || err?.message || 'Unable to read selected files.';
      setError(message);
      setStatus('Unable to supply selected files to the agent.');
    }
  };

  const normalizedFilter = filterQuery.trim().toLowerCase();
  const entryMatchesFilter = (entry) => !normalizedFilter || entryName(entry).toLowerCase().includes(normalizedFilter);
  const subtreeHasMatch = (entries, parentPath) => {
    if (!normalizedFilter) return true;
    for (const entry of entries) {
      if (entryMatchesFilter(entry)) return true;
      const path = entryPath(entry, parentPath);
      if (isDirectory(entry) && children[path] && subtreeHasMatch(children[path], path)) return true;
    }
    return false;
  };

  const visibleItems = [];
  const addVisible = (entries, parentPath = '.', level = 1) => {
    for (const entry of entries) {
      const path = entryPath(entry, parentPath);
      const directory = isDirectory(entry);
      const selfMatch = entryMatchesFilter(entry);
      const childMatch = directory && children[path] ? subtreeHasMatch(children[path], path) : false;
      if (normalizedFilter && !selfMatch && !childMatch) continue;
      visibleItems.push({ entry, path, parentPath, level, directory });
      const shouldDescend = directory && children[path] && ((!normalizedFilter && expanded.has(path)) || (normalizedFilter && (selfMatch || childMatch) && (expanded.has(path) || childMatch)));
      if (shouldDescend) addVisible(children[path], path, level + 1);
    }
  };
  addVisible(rootEntries);

  const shouldVirtualize = visibleItems.length > VIRTUALIZATION_THRESHOLD;
  const viewportItemCount = Math.ceil(TREE_VIEWPORT_HEIGHT / TREE_ROW_HEIGHT);
  const firstVirtualIndex = shouldVirtualize ? Math.max(0, Math.floor(scrollTop / TREE_ROW_HEIGHT) - VIRTUALIZATION_OVERSCAN) : 0;
  const lastVirtualIndex = shouldVirtualize ? Math.min(visibleItems.length, firstVirtualIndex + viewportItemCount + VIRTUALIZATION_OVERSCAN * 2) : visibleItems.length;
  const renderedItems = shouldVirtualize ? visibleItems.slice(firstVirtualIndex, lastVirtualIndex) : visibleItems;

  const focusItem = (path) => {
    const index = visibleItems.findIndex((item) => item.path === path);
    if (index < 0) return;
    setActivePath(path);
    if (shouldVirtualize) {
      const top = index * TREE_ROW_HEIGHT;
      const bottom = top + TREE_ROW_HEIGHT;
      const viewportBottom = scrollTop + TREE_VIEWPORT_HEIGHT;
      if (top < scrollTop) setScrollTop(top);
      else if (bottom > viewportBottom) setScrollTop(Math.max(0, bottom - TREE_VIEWPORT_HEIGHT));
    }
  };

  useEffect(() => {
    if (!activePath) return undefined;
    const frame = window.requestAnimationFrame(() => {
      treeRef.current?.querySelector(`[data-tree-path="${CSS.escape(activePath)}"]`)?.focus?.();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activePath, renderedItems]);

  const moveActive = (offset) => {
    if (!visibleItems.length) return;
    const currentIndex = visibleItems.findIndex((item) => item.path === activePath);
    const index = currentIndex < 0 ? 0 : currentIndex;
    const next = Math.max(0, Math.min(index + offset, visibleItems.length - 1));
    focusItem(visibleItems[next].path);
  };

  const handleTreeKeyDown = async (event, item) => {
    const index = visibleItems.findIndex((visible) => visible.path === item.path);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveActive(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      if (visibleItems[0]) focusItem(visibleItems[0].path);
    } else if (event.key === 'End') {
      event.preventDefault();
      const last = visibleItems[visibleItems.length - 1];
      if (last) focusItem(last.path);
    } else if (item.directory && event.key === 'ArrowRight') {
      event.preventDefault();
      if (!expanded.has(item.path)) await toggleDirectory(item.path, entryName(item.entry));
      else if (children[item.path]?.length) {
        const firstChild = visibleItems[index + 1];
        if (firstChild) focusItem(firstChild.path);
      }
    } else if (item.directory && event.key === 'ArrowLeft') {
      event.preventDefault();
      if (expanded.has(item.path)) await toggleDirectory(item.path, entryName(item.entry));
      else if (item.parentPath !== '.') focusItem(item.parentPath);
    } else if (item.directory && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      await toggleDirectory(item.path, entryName(item.entry));
    } else if (!item.directory && event.key === 'Enter') {
      event.preventDefault();
      await openFile(item.entry, item.path);
    } else if (!item.directory && event.key === ' ') {
      event.preventDefault();
      toggleFile(item.entry, item.path);
    }
  };

  useEffect(() => {
    if (!normalizedFilter) return undefined;
    const count = visibleItems.length;
    setStatus(count ? `Filter "${filterQuery.trim()}": ${count} visible ${count === 1 ? 'item' : 'items'}.` : `No entries match "${filterQuery.trim()}".`);
    return undefined;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterQuery, rootEntries, children, expanded]);

  return (
    <section className="project-explorer" role="region" aria-labelledby="project-explorer-heading" data-focus-region="project">
      <h2 id="project-explorer-heading">Project</h2>
      <p className="project-path" aria-label="Current project directory">{projectRoot || '.'}</p>
      <div className="project-actions">
        <button type="button" onClick={collapseAll}>Collapse all</button>
        <button type="button" onClick={expandAll}>Expand all</button>
        <button type="button" onClick={async () => {
          setChildren({}); setExpanded(new Set()); setActivePath(null);
          try { sessionStorage.removeItem(`${storageKey}:expanded`); } catch { /* ignore */ }
          const entries = await loadDirectory('.', true); setRootEntries(entries); void refreshGitStatus();
        }}>Refresh</button>
        <button type="button" onClick={selectAllVisible}>Select all visible</button>
        <button type="button" onClick={clearSelection} disabled={selectedFiles.size === 0}>Clear selection</button>
        <button type="button" onClick={useSelectedFiles} disabled={selectedFiles.size === 0}>Use selected files with agent ({selectedFiles.size})</button>
        {onInsertPathIntoTerminal && <button type="button" onClick={() => {
          const path = activePath || Array.from(selectedFiles)[0] || '.';
          onInsertPathIntoTerminal(path); setStatus(`Sent path ${path} to the terminal command field.`);
        }} disabled={!activePath && selectedFiles.size === 0} title="Insert the focused or selected path into the terminal command field">Insert path into terminal</button>}
      </div>
      <div className="project-filter">
        <label htmlFor="project-filter-input">Filter files and folders</label>
        <input ref={filterRef} id="project-filter-input" type="search" value={filterQuery} onChange={(event) => setFilterQuery(event.target.value)} placeholder="Type to filter..." autoComplete="off" aria-controls="project-tree-list" />
        {filterQuery && <button type="button" onClick={() => { setFilterQuery(''); filterRef.current?.focus(); }}>Clear filter</button>}
      </div>
      <div className="project-help-block">
        <button type="button" className="project-shortcuts-toggle" aria-expanded={showShortcuts} aria-controls="project-shortcuts" onClick={() => setShowShortcuts((value) => !value)}>{showShortcuts ? 'Hide keyboard shortcuts' : 'Show keyboard shortcuts'}</button>
        {showShortcuts && <ul id="project-shortcuts" className="project-shortcuts">
          <li>F6 / Shift+F6 — move between chat, project tree, and terminal</li>
          <li>Arrow keys — move between visible items</li>
          <li>Right Arrow — expand folder; Left Arrow — collapse folder</li>
          <li>Enter or Space — toggle folder; Enter on a file opens a preview</li>
          <li>Home / End — first or last visible item</li>
          <li>Checkboxes — select files to send to the agent</li>
          <li>Insert path into terminal — places the focused or selected path in the terminal command field</li>
        </ul>}
        <p id="project-selection-help" className="project-selection-help">Tree view. Use arrow keys to navigate. Right Arrow expands a folder, Left Arrow collapses it, Enter or Space toggles a folder. Check files to supply their contents to the agent. Use “Insert path into terminal” for a command workflow. Press F6 to move between the chat, project tree, and terminal.</p>
      </div>
      <div ref={treeRef} role="tree" tabIndex="-1" aria-label="Project files and directories" aria-describedby="project-selection-help" className="project-list" data-focus-target="project-tree" id="project-tree-list" onScroll={shouldVirtualize ? (event) => setScrollTop(event.currentTarget.scrollTop) : undefined} style={{ maxHeight: `${TREE_VIEWPORT_HEIGHT}px`, overflowY: 'auto' }}>
        {shouldVirtualize && <div aria-hidden="true" style={{ height: `${visibleItems.length * TREE_ROW_HEIGHT}px`, position: 'relative' }} />}
        {renderedItems.map((item, renderedIndex) => {
          const { entry, path, level, directory } = item;
          const logicalIndex = shouldVirtualize ? firstVirtualIndex + renderedIndex : renderedIndex;
          const name = entryName(entry);
          const selected = selectedFiles.has(path);
          const isActive = activePath === path;
          const gitStatus = getGitStatus(path, directory);
          const statusDescription = gitStatus ? `, ${gitStatus.label}` : '';
          const treeItemLabel = directory ? `${expanded.has(path) ? 'Expanded' : 'Collapsed'} ${name}, directory${statusDescription}` : `${name}, file${selected ? ', selected' : ''}${statusDescription}`;
          return <div key={path} role="treeitem" tabIndex={isActive || (!activePath && logicalIndex === 0) ? 0 : -1} aria-level={level} aria-posinset={logicalIndex + 1} aria-setsize={visibleItems.length} aria-expanded={directory ? expanded.has(path) : undefined} aria-selected={isActive} aria-label={treeItemLabel} data-tree-path={path} onFocus={() => setActivePath(path)} onKeyDown={(event) => handleTreeKeyDown(event, item)} onClick={() => directory ? toggleDirectory(path, name) : openFile(entry, path)} className="project-entry" style={shouldVirtualize ? { position: 'absolute', top: `${logicalIndex * TREE_ROW_HEIGHT}px`, insetInline: 0, height: `${TREE_ROW_HEIGHT}px`, paddingInlineStart: `${Math.max(0, level - 1) * 1.25}rem` } : { paddingInlineStart: `${Math.max(0, level - 1) * 1.25}rem` }}>
            {directory ? <span aria-hidden="true">{expanded.has(path) ? '▾' : '▸'}</span> : <input type="checkbox" checked={selected} onChange={(event) => toggleFile(item.entry, path, { shiftKey: event.nativeEvent?.shiftKey || event.shiftKey })} aria-label={`Select ${name} for the agent`} onClick={(event) => event.stopPropagation()} />}
            {' '}{name}{gitStatus && <span className={`project-git-status project-git-status-${gitStatus.kind}`} aria-hidden="true" title={`Git status: ${gitStatus.label}`}>[{gitStatus.short}]</span>}
          </div>;
        })}
      </div>
      {visibleItems.length === 0 && !error && <div className="project-empty" aria-live="polite">
        <p>{normalizedFilter ? `No entries match "${filterQuery.trim()}".` : 'No entries in this project.'}</p>
        {!normalizedFilter && <p><a href="/settings.html#settings-project-root">Change project</a>{' · '}<button type="button" onClick={async () => { setChildren({}); setExpanded(new Set()); const entries = await loadDirectory('.', true); setRootEntries(entries); void refreshGitStatus(); }}>Retry</button></p>}
      </div>}
      {openedFile && <div className="confirmation-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpenedFile(null); }}>
        <section className="confirmation-dialog file-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="project-file-preview-heading">
          <h3 id="project-file-preview-heading">File: {openedFile.path}</h3>
          <pre aria-label={`Contents of ${openedFile.path}`}>{openedFile.content}</pre>
          <div className="confirmation-dialog-actions"><button ref={previewCloseRef} type="button" onClick={() => setOpenedFile(null)}>Close</button></div>
        </section>
      </div>}
      <div role="status" aria-live="polite" className="project-status">{status}</div>
      {gitStatusError && <div role="status" aria-live="polite" className="project-git-status-error">{gitStatusError}</div>}
      {error && <div role="alert" className="project-error">
        <p>{error}</p>
        <p><a href="/settings.html#settings-project-root">Change project</a>{' · '}<button type="button" onClick={async () => { setError(''); setChildren({}); const entries = await loadDirectory('.', true); setRootEntries(entries); void refreshGitStatus(); }}>Retry</button></p>
      </div>}
    </section>
  );
}

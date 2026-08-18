import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';

/**
 * Keyboard-accessible, expandable project tree backed by Flask's project APIs.
 * It deliberately does not access the filesystem from the renderer.
 * Directories are loaded only when expanded; files can be previewed or
 * explicitly selected for the agent.
 */
export default function ProjectExplorer({ host, projectRoot = '', onFileOpened, onUseSelectedFiles, onInsertPathIntoTerminal }) {
  const storageKey = `project-explorer:${projectRoot || host || 'default'}`;

  const readStored = (key, fallback) => {
    try {
      const raw = sessionStorage.getItem(`${storageKey}:${key}`);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : fallback;
    } catch {
      return fallback;
    }
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

      // Rehydrate children for folders that were expanded in a previous session
      // so the restored expansion actually shows files without another click.
      const paths = Array.from(expanded).filter((path) => path && path !== '.');
      if (paths.length) {
        const loaded = {};
        for (const path of paths) {
          if (!active) return;
          try {
            const res = await axios.get(`${host}/project/list`, { params: { path } });
            loaded[path] = Array.isArray(res.data?.entries) ? res.data.entries : [];
          } catch {
            // Leave missing; user can expand manually.
          }
        }
        if (active && Object.keys(loaded).length) {
          setChildren((current) => ({ ...current, ...loaded }));
        }
      }
    }).catch((err) => {
      if (!active) return;
      const message = err?.response?.data?.error || err?.message || 'Unable to load project directory.';
      setRootEntries([]);
      setError(message);
      setStatus('Unable to load project directory.');
    });
    return () => { active = false; };
  // expanded is intentionally read only on mount (restored from sessionStorage).
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

  // Persist expansion and selection so they survive reload / returning from Settings.
  useEffect(() => {
    if (skipNextPersist.current) {
      skipNextPersist.current = false;
      return;
    }
    try {
      sessionStorage.setItem(`${storageKey}:expanded`, JSON.stringify(Array.from(expanded)));
      sessionStorage.setItem(`${storageKey}:selected`, JSON.stringify(Array.from(selectedFiles)));
    } catch {
      // sessionStorage may be unavailable; ignore.
    }
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
    window.setTimeout(() => {
      const first = treeRef.current?.querySelector('[role="treeitem"]');
      first?.focus?.();
    }, 0);
  };

  const expandAll = () => {
    // Only expand directories whose contents are already loaded (children cache).
    // This preserves lazy-loading and makes files appear immediately.
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
    window.setTimeout(() => {
      const first = treeRef.current?.querySelector('[role="treeitem"]');
      first?.focus?.();
    }, 0);
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
    setStatus(filePaths.length
      ? `Selected ${filePaths.length} visible ${filePaths.length === 1 ? 'file' : 'files'} for the agent.`
      : 'No visible files to select.');
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

  const entryMatchesFilter = (entry) => {
    if (!normalizedFilter) return true;
    return entryName(entry).toLowerCase().includes(normalizedFilter);
  };

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
      const shouldDescend = directory && children[path] && (
        (!normalizedFilter && expanded.has(path))
        || (normalizedFilter && (selfMatch || childMatch) && (expanded.has(path) || childMatch))
      );
      if (shouldDescend) {
        addVisible(children[path], path, level + 1);
      }
    }
  };
  addVisible(rootEntries);

  const focusItem = (path) => {
    setActivePath(path);
    window.setTimeout(() => treeRef.current?.querySelector(`[data-tree-path="${CSS.escape(path)}"]`)?.focus(), 0);
  };

  const moveActive = (offset) => {
    if (!visibleItems.length) return;
    const index = Math.max(0, visibleItems.findIndex((item) => item.path === activePath));
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
      if (expanded.has(item.path)) {
        await toggleDirectory(item.path, entryName(item.entry));
      } else if (item.parentPath !== '.') {
        focusItem(item.parentPath);
      }
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
    setStatus(count
      ? `Filter "${filterQuery.trim()}": ${count} visible ${count === 1 ? 'item' : 'items'}.`
      : `No entries match "${filterQuery.trim()}".`);
    return undefined;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterQuery, rootEntries, children, expanded]);

  return (
    <section
      className="project-explorer"
      role="region"
      aria-labelledby="project-explorer-heading"
      data-focus-region="project"
    >
      <h2 id="project-explorer-heading">Project</h2>
      <p className="project-path" aria-label="Current project directory">
        {projectRoot || '.'}
      </p>
      <div className="project-actions">
        <button type="button" onClick={collapseAll}>Collapse all</button>
        <button type="button" onClick={expandAll}>Expand all</button>
        <button type="button" onClick={async () => {
          setChildren({});
          setExpanded(new Set());
          setActivePath(null);
          try {
            sessionStorage.removeItem(`${storageKey}:expanded`);
          } catch { /* ignore */ }
          const entries = await loadDirectory('.', true);
          setRootEntries(entries);
        }}>Refresh</button>
        <button type="button" onClick={selectAllVisible}>Select all visible</button>
        <button type="button" onClick={clearSelection} disabled={selectedFiles.size === 0}>Clear selection</button>
        <button type="button" onClick={useSelectedFiles} disabled={selectedFiles.size === 0}>
          Use selected files with agent ({selectedFiles.size})
        </button>
        {onInsertPathIntoTerminal && (
          <button
            type="button"
            onClick={() => {
              const path = activePath || Array.from(selectedFiles)[0] || '.';
              onInsertPathIntoTerminal(path);
              setStatus(`Sent path ${path} to the terminal command field.`);
            }}
            disabled={!activePath && selectedFiles.size === 0}
            title="Insert the focused or selected path into the terminal command field"
          >
            Insert path into terminal
          </button>
        )}
      </div>
      <div className="project-filter">
        <label htmlFor="project-filter-input">Filter files and folders</label>
        <input
          ref={filterRef}
          id="project-filter-input"
          type="search"
          value={filterQuery}
          onChange={(event) => setFilterQuery(event.target.value)}
          placeholder="Type to filter..."
          autoComplete="off"
          aria-controls="project-tree-list"
        />
        {filterQuery && (
          <button type="button" onClick={() => { setFilterQuery(''); filterRef.current?.focus(); }}>
            Clear filter
          </button>
        )}
      </div>
      <div className="project-help-block">
        <button
          type="button"
          className="project-shortcuts-toggle"
          aria-expanded={showShortcuts}
          aria-controls="project-shortcuts"
          onClick={() => setShowShortcuts((value) => !value)}
        >
          {showShortcuts ? 'Hide keyboard shortcuts' : 'Show keyboard shortcuts'}
        </button>
        {showShortcuts && (
          <ul id="project-shortcuts" className="project-shortcuts">
            <li>F6 / Shift+F6 — move between chat, project tree, and terminal</li>
            <li>Arrow keys — move between visible items</li>
            <li>Right Arrow — expand folder; Left Arrow — collapse folder</li>
            <li>Enter or Space — toggle folder; Enter on a file opens a preview</li>
            <li>Home / End — first or last visible item</li>
            <li>Checkboxes — select files to send to the agent</li>
            <li>Insert path into terminal — places the focused or selected path in the terminal command field</li>
          </ul>
        )}
        <p id="project-selection-help" className="project-selection-help">
          Tree view. Use arrow keys to navigate. Right Arrow expands a folder, Left Arrow collapses it, Enter or Space toggles a folder. Check files to supply their contents to the agent. Use “Insert path into terminal” for a command workflow. Press F6 to move between the chat, project tree, and terminal.
        </p>
      </div>
      <div
        ref={treeRef}
        role="tree"
        aria-label="Project files and directories"
        aria-describedby="project-selection-help"
        className="project-list"
        data-focus-target="project-tree"
        id="project-tree-list"
      >
        {visibleItems.map((item) => {
          const { entry, path, level, directory } = item;
          const name = entryName(entry);
          const selected = selectedFiles.has(path);
          const isActive = activePath === path;
          const treeItemLabel = directory
            ? `${expanded.has(path) ? 'Expanded' : 'Collapsed'} ${name}, directory`
            : `${name}, file${selected ? ', selected' : ''}`;
          return (
            <div
              key={path}
              role="treeitem"
              tabIndex={isActive || (!activePath && visibleItems[0]?.path === path) ? 0 : -1}
              aria-level={level}
              aria-expanded={directory ? expanded.has(path) : undefined}
              aria-selected={isActive}
              aria-label={treeItemLabel}
              data-tree-path={path}
              onFocus={() => setActivePath(path)}
              onKeyDown={(event) => handleTreeKeyDown(event, item)}
              onClick={() => directory ? toggleDirectory(path, name) : openFile(entry, path)}
              className="project-entry"
              style={{ paddingInlineStart: `${Math.max(0, level - 1) * 1.25}rem` }}
            >
              {directory ? (
                <span aria-hidden="true">{expanded.has(path) ? '▾' : '▸'}</span>
              ) : (
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={(event) => toggleFile(entry, path, { shiftKey: event.nativeEvent?.shiftKey || event.shiftKey })}
                  aria-label={`Select ${name} for the agent`}
                  onClick={(event) => event.stopPropagation()}
                />
              )}
              {' '}{name}
            </div>
          );
        })}
      </div>
      {visibleItems.length === 0 && !error && (
        <div className="project-empty" aria-live="polite">
          <p>{normalizedFilter ? `No entries match "${filterQuery.trim()}".` : 'No entries in this project.'}</p>
          {!normalizedFilter && (
            <p>
              <a href="/settings.html#settings-project-root">Change project</a>
              {' · '}
              <button type="button" onClick={async () => {
                setChildren({});
                setExpanded(new Set());
                const entries = await loadDirectory('.', true);
                setRootEntries(entries);
              }}>Retry</button>
            </p>
          )}
        </div>
      )}
      {openedFile && (
        <div className="confirmation-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpenedFile(null); }}>
          <section className="confirmation-dialog file-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="project-file-preview-heading">
            <h3 id="project-file-preview-heading">File: {openedFile.path}</h3>
            <pre aria-label={`Contents of ${openedFile.path}`}>{openedFile.content}</pre>
            <div className="confirmation-dialog-actions">
              <button ref={previewCloseRef} type="button" onClick={() => setOpenedFile(null)}>Close</button>
            </div>
          </section>
        </div>
      )}
      <div role="status" aria-live="polite" className="project-status">{status}</div>
      {error && (
        <div role="alert" className="project-error">
          <p>{error}</p>
          <p>
            <a href="/settings.html#settings-project-root">Change project</a>
            {' · '}
            <button type="button" onClick={async () => {
              setError('');
              setChildren({});
              const entries = await loadDirectory('.', true);
              setRootEntries(entries);
            }}>Retry</button>
          </p>
        </div>
      )}
    </section>
  );
}

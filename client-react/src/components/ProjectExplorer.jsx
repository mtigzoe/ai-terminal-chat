import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';

/**
 * Keyboard-accessible, expandable project tree backed by Flask's project APIs.
 * It deliberately does not access the filesystem from the renderer.
 * Directories are loaded only when expanded; files can be previewed or
 * explicitly selected for the agent.
 */
export default function ProjectExplorer({ host, onFileOpened, onUseSelectedFiles }) {
  const [rootEntries, setRootEntries] = useState([]);
  const [children, setChildren] = useState({});
  const [expanded, setExpanded] = useState(() => new Set());
  const [selectedFiles, setSelectedFiles] = useState(() => new Set());
  const [openedFile, setOpenedFile] = useState(null);
  const [activePath, setActivePath] = useState(null);
  const [status, setStatus] = useState('Loading project.');
  const [error, setError] = useState('');
  const treeRef = useRef(null);
  const previewCloseRef = useRef(null);

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
    axios.get(`${host}/project/list`, { params: { path: '.' } }).then((response) => {
      if (!active) return;
      const nextEntries = Array.isArray(response.data?.entries) ? response.data.entries : [];
      setRootEntries(nextEntries);
      setChildren((current) => ({ ...current, '.': nextEntries }));
      setError('');
      setStatus(`${response.data?.path || '.'}: ${nextEntries.length} items.`);
    }).catch((err) => {
      if (!active) return;
      const message = err?.response?.data?.error || err?.message || 'Unable to load project directory.';
      setRootEntries([]);
      setError(message);
      setStatus('Unable to load project directory.');
    });
    return () => { active = false; };
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

  const toggleFile = (entry, path) => {
    setSelectedFiles((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
        setStatus(`${entryName(entry)} removed from agent selection.`);
      } else {
        next.add(path);
        setStatus(`${entryName(entry)} selected for the agent.`);
      }
      return next;
    });
    setActivePath(path);
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

  const visibleItems = [];
  const addVisible = (entries, parentPath = '.', level = 1) => {
    for (const entry of entries) {
      const path = entryPath(entry, parentPath);
      visibleItems.push({ entry, path, parentPath, level, directory: isDirectory(entry) });
      if (isDirectory(entry) && expanded.has(path) && children[path]) {
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
    }
  };

  return (
    <section className="project-explorer" aria-labelledby="project-explorer-heading">
      <h2 id="project-explorer-heading">Project</h2>
      <p className="project-path" aria-label="Current project directory">.</p>
      <div className="project-actions">
        <button type="button" onClick={collapseAll}>Collapse all</button>
        <button type="button" onClick={expandAll}>Expand all</button>
        <button type="button" onClick={async () => {
          setChildren({});
          const entries = await loadDirectory('.', true);
          setRootEntries(entries);
          setExpanded(new Set());
          setActivePath(null);
        }}>Refresh</button>
        <button type="button" onClick={useSelectedFiles} disabled={selectedFiles.size === 0}>
          Use selected files with agent ({selectedFiles.size})
        </button>
      </div>
      <p id="project-selection-help">Use arrow keys to navigate. Right Arrow expands a folder, Left Arrow collapses it, and Enter or Space toggles a folder. Check files to supply their contents to the agent.</p>
      <div ref={treeRef} role="tree" aria-label="Project files and directories" aria-describedby="project-selection-help" className="project-list">
        {visibleItems.map((item) => {
          const { entry, path, level, directory } = item;
          const name = entryName(entry);
          const selected = selectedFiles.has(path);
          const isActive = activePath === path;
          return (
            <div
              key={path}
              role="treeitem"
              tabIndex={isActive || (!activePath && visibleItems[0]?.path === path) ? 0 : -1}
              aria-level={level}
              aria-expanded={directory ? expanded.has(path) : undefined}
              aria-selected={isActive}
              data-tree-path={path}
              onFocus={() => setActivePath(path)}
              onKeyDown={(event) => handleTreeKeyDown(event, item)}
              className="project-entry"
              style={{ paddingInlineStart: `${Math.max(0, level - 1) * 1.25}rem` }}
            >
              {directory ? (
                <button type="button" onClick={() => toggleDirectory(path, name)} aria-label={`${expanded.has(path) ? 'Collapse' : 'Expand'} ${name}`}>
                  <span aria-hidden="true">{expanded.has(path) ? '▾' : '▸'}</span>{' '}{name}
                </button>
              ) : (
                <>
                  <input type="checkbox" checked={selected} onChange={() => toggleFile(entry, path)} aria-label={`Select ${name} for the agent`} />{' '}
                  <button type="button" onClick={() => openFile(entry, path)} aria-label={`Open ${name}`}>
                    <span aria-hidden="true">[FILE]</span> {name}
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
      {visibleItems.length === 0 && !error && <p className="project-empty" aria-live="polite">No entries.</p>}
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
      {error && <div role="alert" className="project-error">{error}</div>}
    </section>
  );
}

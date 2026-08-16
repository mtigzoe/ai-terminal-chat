import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';

/**
 * Keyboard-accessible project browser backed by Flask's project APIs.
 * It deliberately does not access the filesystem from the renderer.
 * Opening a file previews it locally; selecting a file and choosing
 * "Use selected files with agent" explicitly supplies its contents to the AI.
 */
export default function ProjectExplorer({ host, onFileOpened, onUseSelectedFiles }) {
  const [currentPath, setCurrentPath] = useState('.');
  const [entries, setEntries] = useState([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [selectedFiles, setSelectedFiles] = useState(() => new Set());
  const [openedFile, setOpenedFile] = useState(null);
  const [status, setStatus] = useState('Loading project.');
  const [error, setError] = useState('');
  const listRef = useRef(null);

  const loadDirectory = useCallback(async (path) => {
    setStatus(`Loading ${path}.`);
    setError('');
    try {
      const response = await axios.get(`${host}/project/list`, { params: { path } });
      const nextEntries = Array.isArray(response.data?.entries) ? response.data.entries : [];
      setEntries(nextEntries);
      setCurrentPath(response.data?.path || path || '.');
      setSelectedIndex(0);
      setStatus(`${response.data?.path || path}: ${nextEntries.length} items.`);
    } catch (err) {
      const message = err?.response?.data?.error || err?.message || 'Unable to load project directory.';
      setError(message);
      setEntries([]);
      setStatus('Unable to load project directory.');
    }
  }, [host]);

  useEffect(() => {
    loadDirectory('.');
  }, [loadDirectory]);

  useEffect(() => {
    const option = listRef.current?.querySelector('[data-project-entry="active"]');
    option?.focus();
  }, [entries, selectedIndex]);

  const entryPath = (entry) => {
    const name = entry?.name || entry?.path || '';
    if (!name) return '';
    if (entry?.path) return entry.path;
    if (!currentPath || currentPath === '.') return name;
    return `${currentPath.replace(/[\\/]$/, '')}/${name}`;
  };

  const isDirectory = (entry) => entry?.type === 'directory' || entry?.is_dir;

  const openFile = async (entry) => {
    if (!entry || isDirectory(entry)) return;
    const path = entryPath(entry);
    if (!path) return;
    setStatus(`Opening ${entry.name || path}.`);
    setError('');
    try {
      const response = await axios.get(`${host}/project/read`, { params: { path } });
      const content = response.data?.contents ?? response.data?.content ?? '';
      const file = { path: response.data?.path || path, content };
      setOpenedFile(file);
      onFileOpened?.(file);
      setStatus(`Opened ${entry.name || path}. This does not send the file to the agent.`);
    } catch (err) {
      const message = err?.response?.data?.error || err?.message || 'Unable to read file.';
      setError(message);
      setStatus('Unable to open file.');
    }
  };

  const toggleFile = (entry) => {
    if (!entry || isDirectory(entry)) return;
    const path = entryPath(entry);
    setSelectedFiles((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
        setStatus(`${entry.name || path} removed from agent selection.`);
      } else {
        next.add(path);
        setStatus(`${entry.name || path} selected for the agent.`);
      }
      return next;
    });
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
        files.push({
          path: response.data?.path || path,
          content: response.data?.contents ?? response.data?.content ?? '',
        });
      }
      onUseSelectedFiles?.(files);
      setStatus(`${files.length} ${files.length === 1 ? 'file' : 'files'} supplied to the agent.`);
    } catch (err) {
      const message = err?.response?.data?.error || err?.message || 'Unable to read selected files.';
      setError(message);
      setStatus('Unable to supply selected files to the agent.');
    }
  };

  const goUp = async () => {
    if (currentPath === '.' || currentPath === '' || currentPath === '/') {
      setStatus('Already at the project root.');
      return;
    }
    const normalized = currentPath.replace(/\\/g, '/').replace(/\/$/, '');
    const parts = normalized.split('/').filter(Boolean);
    parts.pop();
    await loadDirectory(parts.length ? parts.join('/') : '.');
  };

  const handleKeyDown = async (event, index) => {
    if (event.target !== event.currentTarget) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIndex(Math.min(index + 1, entries.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex(Math.max(index - 1, 0));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setSelectedIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setSelectedIndex(Math.max(entries.length - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (isDirectory(entries[index])) await loadDirectory(entryPath(entries[index]));
      else await openFile(entries[index]);
    } else if (event.key === ' ') {
      event.preventDefault();
      if (!isDirectory(entries[index])) toggleFile(entries[index]);
    } else if (event.key === 'Backspace') {
      event.preventDefault();
      await goUp();
    }
  };

  return (
    <section className="project-explorer" aria-labelledby="project-explorer-heading">
      <h2 id="project-explorer-heading">Project</h2>
      <p className="project-path" aria-label="Current project directory">{currentPath || '.'}</p>
      <div className="project-actions">
        <button type="button" onClick={goUp} disabled={currentPath === '.'}>Up</button>
        <button type="button" onClick={() => loadDirectory(currentPath || '.')}>Refresh</button>
        <button type="button" onClick={useSelectedFiles} disabled={selectedFiles.size === 0}>
          Use selected files with agent ({selectedFiles.size})
        </button>
      </div>
      <p id="project-selection-help">Check files to supply their contents to the agent. Opening a file only previews it.</p>
      <div
        ref={listRef}
        role="list"
        aria-label="Project files and directories"
        aria-describedby="project-selection-help"
        className="project-list"
      >
        {entries.map((entry, index) => {
          const directory = isDirectory(entry);
          const path = entryPath(entry);
          const checked = selectedFiles.has(path);
          const label = `${entry.name || entry.path}${directory ? ', directory' : ', file'}`;
          return (
            <div
              key={entry.path || entry.name || index}
              role="listitem"
              tabIndex={index === selectedIndex ? 0 : -1}
              aria-label={label}
              data-project-entry={index === selectedIndex ? 'active' : undefined}
              onKeyDown={(event) => handleKeyDown(event, index)}
              onFocus={() => setSelectedIndex(index)}
              className="project-entry"
            >
              {directory ? (
                <button type="button" onClick={() => loadDirectory(path)} aria-label={`Open directory ${entry.name || path}`}>
                  <span aria-hidden="true">[DIR]</span> {entry.name || path}
                </button>
              ) : (
                <>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleFile(entry)}
                    aria-label={`Select ${entry.name || path} for the agent`}
                  />{' '}
                  <button type="button" onClick={() => openFile(entry)} aria-label={`Open ${entry.name || path}`}>
                    <span aria-hidden="true">[FILE]</span> {entry.name || path}
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>
      {entries.length === 0 && !error && <p className="project-empty" aria-live="polite">No entries.</p>}
      {openedFile && (
        <section className="project-file-preview" aria-labelledby="project-file-preview-heading">
          <h3 id="project-file-preview-heading">File: {openedFile.path}</h3>
          <pre aria-label={`Contents of ${openedFile.path}`}>{openedFile.content}</pre>
        </section>
      )}
      <div role="status" aria-live="polite" className="project-status">{status}</div>
      {error && <div role="alert" className="project-error">{error}</div>}
    </section>
  );
}

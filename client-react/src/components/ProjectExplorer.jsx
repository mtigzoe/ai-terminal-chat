import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';

/**
 * Keyboard-accessible project browser backed by Flask's project APIs.
 * It deliberately does not access the filesystem from the renderer.
 */
export default function ProjectExplorer({ host, onFileOpened }) {
  const [currentPath, setCurrentPath] = useState('.');
  const [entries, setEntries] = useState([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [status, setStatus] = useState('Loading project.');
  const [error, setError] = useState('');
  const listRef = useRef(null);

  const entryPath = (entry) => {
    const name = entry?.name || '';
    if (!name) return currentPath || '.';
    return currentPath === '.' || !currentPath
      ? name
      : `${currentPath.replace(/\\/g, '/').replace(/\/$/, '')}/${name}`;
  };

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
    const option = listRef.current?.querySelector('[aria-selected="true"]');
    option?.focus();
  }, [entries, selectedIndex]);

  const openEntry = async (entry) => {
    if (!entry) return;
    const path = entryPath(entry);
    if (entry.type === 'directory' || entry.is_dir) {
      await loadDirectory(path);
      return;
    }
    setStatus(`Opening ${entry.name || path}.`);
    setError('');
    try {
      const response = await axios.get(`${host}/project/read`, { params: { path } });
      const content = response.data?.contents ?? response.data?.content ?? '';
      onFileOpened?.({ path: response.data?.path || path, content });
      setStatus(`Opened ${entry.name || path}.`);
    } catch (err) {
      const message = err?.response?.data?.error || err?.message || 'Unable to read file.';
      setError(message);
      setStatus('Unable to open file.');
    }
  };

  const goUp = async () => {
    if (currentPath === '.' || currentPath === '' || currentPath === '/') {
      setStatus('Already at the project root.');
      return;
    }
    const parts = currentPath.replace(/\\/g, '/').split('/').filter(Boolean);
    parts.pop();
    await loadDirectory(parts.length ? parts.join('/') : '.');
  };

  const handleKeyDown = async (event, index) => {
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
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      await openEntry(entries[index]);
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
      </div>
      <div
        ref={listRef}
        role="listbox"
        aria-label="Project files and directories"
        aria-activedescendant={entries[selectedIndex] ? `project-entry-${selectedIndex}` : undefined}
        className="project-list"
      >
        {entries.map((entry, index) => {
          const isDirectory = entry.type === 'directory' || entry.is_dir;
          const label = `${entry.name || entryPath(entry)}${isDirectory ? ', directory' : ', file'}`;
          return (
            <div
              key={entry.path || entry.name || index}
              id={`project-entry-${index}`}
              role="option"
              tabIndex={index === selectedIndex ? 0 : -1}
              aria-selected={index === selectedIndex}
              aria-label={label}
              onClick={() => { setSelectedIndex(index); openEntry(entry); }}
              onKeyDown={(event) => handleKeyDown(event, index)}
              onFocus={() => setSelectedIndex(index)}
              className="project-entry"
            >
              <span aria-hidden="true">{isDirectory ? '[DIR]' : '[FILE]'}</span>{' '}
              {entry.name || entryPath(entry)}
            </div>
          );
        })}
        {entries.length === 0 && !error && <p role="status">No entries.</p>}
      </div>
      <div role="status" aria-live="polite" className="project-status">{status}</div>
      {error && <div role="alert" className="project-error">{error}</div>}
    </section>
  );
}

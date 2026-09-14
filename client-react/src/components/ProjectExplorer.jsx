import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import './GitStatusBadge.css';
import './ProjectExplorerColumns.css';

const VIRTUALIZATION_THRESHOLD = 200;
const TREE_ROW_HEIGHT = 32;
const TREE_VIEWPORT_HEIGHT = 360;
const VIRTUALIZATION_OVERSCAN = 8;

const GIT_STATUS_INFO = {
  modified: { short: 'M', label: 'modified' }, staged: { short: 'S', label: 'staged' }, untracked: { short: 'U', label: 'untracked' }, added: { short: 'A', label: 'added' }, deleted: { short: 'D', label: 'deleted' }, renamed: { short: 'R', label: 'renamed' }, conflict: { short: 'C', label: 'conflict' },
};
const FILE_TYPE_LABELS = {
  js: 'JavaScript File', jsx: 'JavaScript File', mjs: 'JavaScript File', cjs: 'JavaScript File', ts: 'TypeScript File', tsx: 'TypeScript File', json: 'JSON File', md: 'Markdown Document', py: 'Python File', css: 'CSS File', html: 'HTML Document', htm: 'HTML Document', yml: 'YAML File', yaml: 'YAML File', txt: 'Text Document', sh: 'Shell Script', svg: 'SVG Image', png: 'PNG Image', jpg: 'JPEG Image', jpeg: 'JPEG Image', gif: 'GIF Image', lock: 'Lock File', toml: 'TOML File', ini: 'INI File', cfg: 'Configuration File', xml: 'XML File', csv: 'CSV File', gitignore: 'Git Ignore File',
};
const SORT_COLUMN_LABELS = { name: 'Name', type: 'Type' };
const CONFLICT_STATUS_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
const gitStatusFromLine = (line) => { if (!line || line.length < 3) return null; const code = line.slice(0, 2); let path = line.slice(3).trim(); if (!path) return null; if (path.includes(' -> ')) path = path.split(' -> ').pop(); path = path.replace(/\\/g, '/'); if (code === '??') return ['untracked', path]; if (CONFLICT_STATUS_CODES.has(code)) return ['conflict', path]; if (code.includes('R')) return ['renamed', path]; if (code.includes('D')) return ['deleted', path]; if (code.includes('A')) return ['added', path]; if (code.includes('M')) return [code[0] === ' ' ? 'modified' : 'staged', path]; return null; };
const statusPriority = ['conflict', 'untracked', 'staged', 'added', 'modified', 'deleted', 'renamed'];

export default function ProjectExplorer({ host, projectRoot = '', onFileOpened, onUseSelectedFiles, onInsertPathIntoTerminal }) {
  const storageKey = `project-explorer:${projectRoot || host || 'default'}`;
  const readStored = (key, fallback) => { try { const raw = localStorage.getItem(`${storageKey}:${key}`) ?? sessionStorage.getItem(`${storageKey}:${key}`); if (!raw) return fallback; const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed : fallback; } catch { return fallback; } };
  const [rootEntries, setRootEntries] = useState([]); const [children, setChildren] = useState({}); const [expanded, setExpanded] = useState(() => new Set(readStored('expanded', []))); const [selectedFiles, setSelectedFiles] = useState(() => new Set(readStored('selected', []))); const [openedFile, setOpenedFile] = useState(null); const [activePath, setActivePath] = useState(null); const [status, setStatus] = useState('Loading project.'); const [error, setError] = useState(''); const [showShortcuts, setShowShortcuts] = useState(false); const [filterQuery, setFilterQuery] = useState(''); const [lastSelectedPath, setLastSelectedPath] = useState(null); const [scrollTop, setScrollTop] = useState(0); const [selectingAllFiles, setSelectingAllFiles] = useState(false); const [sortColumn, setSortColumn] = useState('name'); const [sortDirection, setSortDirection] = useState('asc'); const [gitStatuses, setGitStatuses] = useState({}); const [gitStatusError, setGitStatusError] = useState(''); const gitStatusRefreshing = useRef(false); const treeRef = useRef(null); const previewDialogRef = useRef(null); const previewCloseRef = useRef(null); const previewReturnRef = useRef(null); const filterRef = useRef(null); const skipNextPersist = useRef(false); const treeHasFocusRef = useRef(false); const childrenRef = useRef({}); const loadGens = useRef(new Map()); const explorerEpoch = useRef(0);

  const entryName = (entry) => entry?.name || entry?.path || ''; const isDirectory = (entry) => entry?.type === 'directory' || entry?.is_dir; const entryPath = (entry, parentPath = '.') => { const name = entryName(entry); if (!name) return ''; if (entry?.path) return entry.path; if (!parentPath || parentPath === '.') return name; return `${parentPath.replace(/[\\/]$/, '')}/${name}`; };
  const typeLabel = (entry) => { if (isDirectory(entry)) return 'Folder'; const name = entryName(entry); const lastDot = name.lastIndexOf('.'); let ext = ''; if (lastDot > 0 && lastDot < name.length - 1) ext = name.slice(lastDot + 1).toLowerCase(); else if (lastDot === 0 && name.length > 1) ext = name.slice(1).toLowerCase(); if (!ext) return 'File'; return FILE_TYPE_LABELS[ext] || `${ext.toUpperCase()} File`; };
  const refreshGitStatus = useCallback(async () => { if (gitStatusRefreshing.current) return; gitStatusRefreshing.current = true; try { const response = await axios.post(`${host}/terminal/run`, { command: 'git status --porcelain=v1 --untracked-files=all' }); const stdout = String(response.data?.stdout || ''); const next = {}; stdout.split(/\r?\n/).forEach((line) => { const parsed = gitStatusFromLine(line); if (parsed) next[parsed[1]] = parsed[0]; }); setGitStatuses(next); setGitStatusError(''); return next; } catch { setGitStatusError('Git status unavailable. The project tree remains usable.'); return {}; } finally { gitStatusRefreshing.current = false; } }, [host]);
  const getGitStatus = (path, directory) => { const normalizedPath = path.replace(/\\/g, '/').replace(/^\.\//, ''); const matching = Object.entries(gitStatuses).filter(([candidate]) => candidate === normalizedPath || (directory && candidate.startsWith(`${normalizedPath}/`))).map(([, value]) => value); if (!matching.length) return null; const kind = statusPriority.find((candidate) => matching.includes(candidate)) || matching[0]; return GIT_STATUS_INFO[kind] ? { kind, ...GIT_STATUS_INFO[kind] } : null; };
  useEffect(() => { childrenRef.current = children; }, [children]);
  // Returns the entries array on success, or null on failure / stale response.
  // Callers must not expand a folder when the result is null.
  const loadDirectory = useCallback(async (path, announce = true, force = false) => {
    if (!force && childrenRef.current[path]) return childrenRef.current[path];
    const gen = (loadGens.current.get(path) || 0) + 1;
    loadGens.current.set(path, gen);
    setError('');
    if (announce) setStatus(`Loading ${path}.`);
    try {
      const response = await axios.get(`${host}/project/list`, { params: { path } });
      if (loadGens.current.get(path) !== gen) return null; // stale for this path
      const nextEntries = Array.isArray(response.data?.entries) ? response.data.entries : [];
      setChildren((current) => ({ ...current, [path]: nextEntries }));
      // Drop selected files that were direct children of this path but are gone.
      const childPaths = new Set(nextEntries.map((entry) => {
        const name = entry?.name || entry?.path || '';
        if (!name) return '';
        if (entry?.path) return entry.path;
        if (!path || path === '.') return name;
        return `${String(path).replace(/[\\/]$/, '')}/${name}`;
      }).filter(Boolean));
      setSelectedFiles((current) => {
        let changed = false;
        const next = new Set();
        for (const selected of current) {
          const parent = selected.includes('/') ? selected.slice(0, selected.lastIndexOf('/')) : '.';
          const isDirectChild = parent === path || (path === '.' && !selected.includes('/'));
          if (isDirectChild && !childPaths.has(selected)) {
            changed = true;
            continue;
          }
          next.add(selected);
        }
        return changed ? next : current;
      });
      if (announce) setStatus(`${response.data?.path || path}: ${nextEntries.length} items.`);
      return nextEntries;
    } catch (err) {
      if (loadGens.current.get(path) !== gen) return null;
      const message = err?.response?.data?.error || err?.message || 'Unable to load project directory.';
      setError(message);
      setStatus('Unable to load project directory.');
      return null;
    }
  }, [host]);

  useEffect(() => {
    let cancelled = false;
    const epoch = explorerEpoch.current;
    (async () => {
      setStatus('Loading project.');
      // Route through loadDirectory so the initial '.' request participates in
      // the same per-path generation as Refresh (prevents a late initial
      // response from overwriting a newer Refresh result).
      // explorerEpoch aborts this whole mount sequence if Refresh/Retry runs.
      const entries = await loadDirectory('.', true, true);
      if (cancelled || epoch !== explorerEpoch.current || entries == null) return;
      setRootEntries(entries);
      void refreshGitStatus();
      const paths = Array.from(expanded).filter((path) => path && path !== '.');
      const failed = [];
      for (const path of paths) {
        if (cancelled || epoch !== explorerEpoch.current) return;
        const result = await loadDirectory(path);
        if (result == null) failed.push(path);
      }
      if (cancelled || epoch !== explorerEpoch.current) return;
      if (failed.length) {
        setExpanded((current) => {
          const next = new Set(current);
          failed.forEach((p) => next.delete(p));
          return next;
        });
      }
    })();
    return () => { cancelled = true; };
  }, [host]);

  // A Chat-page permission grant is persisted in the same browser storage
  // used for agent read permissions. Merge newly granted paths into the
  // Project-page selection so the file is visibly selected without manual
  // checkbox work. Persist unions selectedFiles with existing grants so
  // selectedFiles is the source of truth: persist overwrites the global key so
  // individual unchecks can revoke a path. clearSelection also empties the global list.
  useEffect(() => {
    const syncGrantedPaths = () => {
      try {
        const raw = localStorage.getItem('ai-terminal-chat:allowed-paths');
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed) || parsed.length === 0) return;
        const paths = parsed.filter((p) => typeof p === 'string' && p.trim());
        if (!paths.length) return;
        setSelectedFiles((current) => {
          const next = new Set(current);
          let added = 0;
          for (const path of paths) {
            if (!next.has(path)) {
              next.add(path);
              added += 1;
            }
          }
          if (added > 0) setStatus(`${added} file${added === 1 ? '' : 's'} granted to the agent and selected automatically.`);
          return next;
        });
      } catch { /* ignore malformed browser storage */ }
    };
    syncGrantedPaths();
    const onStorage = (event) => { if (event.key === 'ai-terminal-chat:allowed-paths') syncGrantedPaths(); };
    window.addEventListener('storage', onStorage);
    window.addEventListener('ai-terminal-chat:allowed-paths-changed', syncGrantedPaths);
    return () => { window.removeEventListener('storage', onStorage); window.removeEventListener('ai-terminal-chat:allowed-paths-changed', syncGrantedPaths); };
  }, [storageKey]);

const closePreview = useCallback(() => {
    setOpenedFile(null);
    window.setTimeout(() => previewReturnRef.current?.focus?.(), 0);
  }, []);

useEffect(() => {
    if (!openedFile) return undefined;

    previewCloseRef.current?.focus();

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closePreview();
        return;
      }

      if (event.key === 'Tab') {
        const dialog = previewDialogRef.current;
        const focusable = dialog?.querySelectorAll(
          'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])',
        );

        if (!focusable?.length) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (focusable.length === 1) {
          event.preventDefault();
          first.focus();
        } else if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [openedFile, closePreview]);
  useEffect(() => { const id = window.setInterval(() => { void refreshGitStatus(); }, 5000); return () => window.clearInterval(id); }, [refreshGitStatus]);
  useEffect(() => {
    if (skipNextPersist.current) { skipNextPersist.current = false; return; }
    try {
      localStorage.setItem(`${storageKey}:expanded`, JSON.stringify(Array.from(expanded)));
      localStorage.setItem(`${storageKey}:selected`, JSON.stringify(Array.from(selectedFiles)));
      // selectedFiles is the source of truth so individual unchecks can revoke a path.
      localStorage.setItem('ai-terminal-chat:allowed-paths', JSON.stringify(Array.from(selectedFiles)));
    } catch {}
  }, [expanded, selectedFiles, storageKey]);

  const toggleDirectory = async (path, name) => {
    if (expanded.has(path)) {
      setExpanded((current) => { const next = new Set(current); next.delete(path); return next; });
      setActivePath(path);
      setStatus(`${name} collapsed.`);
      return;
    }
    const entries = await loadDirectory(path);
    if (entries == null) return; // failed or stale — do not expand
    setExpanded((current) => new Set(current).add(path));
    setActivePath(path);
    setStatus(`${name} expanded.`);
  };
  const collapseAll = () => { setExpanded(new Set()); setActivePath(null); setStatus('Project tree collapsed.'); window.setTimeout(() => treeRef.current?.querySelector('[role="treeitem"]')?.focus?.(), 0); };
  const expandAll = () => { const next = new Set(); const collect = (entries, parentPath) => { for (const entry of entries) { if (!isDirectory(entry)) continue; const path = entryPath(entry, parentPath); if (children[path]) { next.add(path); collect(children[path], path); } } }; collect(rootEntries, '.'); setExpanded(next); setActivePath(null); setStatus(next.size ? 'Project tree expanded.' : 'No loaded folders to expand.'); window.setTimeout(() => treeRef.current?.querySelector('[role="treeitem"]')?.focus?.(), 0); };
  const openFile = async (entry, path) => { previewReturnRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setStatus(`Opening ${entryName(entry)}.`); setError(''); try { const response = await axios.get(`${host}/project/read`, { params: { path } }); const content = response.data?.contents ?? response.data?.content ?? ''; const file = { path: response.data?.path || path, content }; setOpenedFile(file); onFileOpened?.(file); setActivePath(path); setStatus(`Opened ${entryName(entry)}. This does not send the file to the agent.`); } catch (err) { const message = err?.response?.data?.error || err?.message || 'Unable to open file.'; setError(message); setStatus('Unable to open file.'); } };
  const toggleFile = (entry, path, { shiftKey = false } = {}) => { setSelectedFiles((current) => { const next = new Set(current); if (shiftKey && lastSelectedPath) { const filePaths = visibleItems.filter((item) => !item.directory).map((item) => item.path); const start = filePaths.indexOf(lastSelectedPath); const end = filePaths.indexOf(path); if (start !== -1 && end !== -1) { const [from, to] = start < end ? [start, end] : [end, start]; for (let i = from; i <= to; i += 1) next.add(filePaths[i]); setStatus(`Selected ${to - from + 1} files for the agent.`); return next; } } if (next.has(path)) { next.delete(path); setStatus(`${entryName(entry)} removed from agent selection.`); } else { next.add(path); setStatus(`${entryName(entry)} selected for the agent.`); } return next; }); setLastSelectedPath(path); setActivePath(path); };
  const sortEntries = (entries) => { const factor = sortDirection === 'desc' ? -1 : 1; const compareNames = (a, b) => entryName(a).localeCompare(entryName(b), undefined, { numeric: true, sensitivity: 'base' }); return [...entries].sort((a, b) => { const aDir = isDirectory(a); const bDir = isDirectory(b); if (aDir !== bDir) return aDir ? -1 : 1; let primary = 0; if (sortColumn === 'type') primary = typeLabel(a).localeCompare(typeLabel(b), undefined, { sensitivity: 'base' }); if (primary === 0) primary = compareNames(a, b); return primary * factor; }); };
  const handleSort = (column) => { const nextDirection = sortColumn === column && sortDirection === 'asc' ? 'desc' : 'asc'; setSortColumn(column); setSortDirection(nextDirection); setStatus(`Sorted by ${SORT_COLUMN_LABELS[column]}, ${nextDirection === 'asc' ? 'ascending' : 'descending'}.`); };
  const sortButtonLabel = (column) => { const label = SORT_COLUMN_LABELS[column]; if (sortColumn !== column) return `Sort by ${label}`; const current = sortDirection === 'asc' ? 'ascending' : 'descending'; const next = sortDirection === 'asc' ? 'descending' : 'ascending'; return `${label}, sorted ${current}. Activate to sort ${next}.`; };
  const ariaSortValue = (column) => (sortColumn === column ? (sortDirection === 'asc' ? 'ascending' : 'descending') : undefined);
  const sortGlyph = (column) => (sortColumn === column ? (sortDirection === 'asc' ? '▲' : '▼') : '');
  const selectAllVisible = () => { const filePaths = visibleItems.filter((item) => !item.directory).map((item) => item.path); setSelectedFiles((current) => { const next = new Set(current); filePaths.forEach((p) => next.add(p)); return next; }); setStatus(filePaths.length ? `Selected ${filePaths.length} visible ${filePaths.length === 1 ? 'file' : 'files'} for the agent.` : 'No visible files to select.'); };
  const collectAllFilePaths = useCallback(async () => { const cache = { ...children }; const newlyLoaded = {}; const paths = []; const failedPaths = []; const visit = async (dirPath) => { let entries = cache[dirPath]; if (!entries) { try { const response = await axios.get(`${host}/project/list`, { params: { path: dirPath } }); entries = Array.isArray(response.data?.entries) ? response.data.entries : []; } catch { failedPaths.push(dirPath); return; } cache[dirPath] = entries; newlyLoaded[dirPath] = entries; } for (const entry of entries) { const path = entryPath(entry, dirPath); if (!path) continue; if (isDirectory(entry)) await visit(path); else paths.push(path); } }; await visit('.'); if (Object.keys(newlyLoaded).length) setChildren((current) => ({ ...current, ...newlyLoaded })); return { paths, failedPaths }; }, [children, host]);
  const selectAllFiles = async () => { if (selectingAllFiles) return; setSelectingAllFiles(true); setError(''); setStatus('Scanning the entire project for files.'); try { const { paths, failedPaths } = await collectAllFilePaths(); let finalCount = 0; setSelectedFiles((current) => { const next = new Set(current); paths.forEach((p) => next.add(p)); finalCount = next.size; return next; }); const failureNote = failedPaths.length ? ` ${failedPaths.length} ${failedPaths.length === 1 ? 'folder' : 'folders'} could not be read and ${failedPaths.length === 1 ? 'was' : 'were'} skipped.` : ''; setStatus(`Selected ${finalCount} ${finalCount === 1 ? 'file' : 'files'} across the entire project.${failureNote}`); if (failedPaths.length) setError('Some folders could not be listed while selecting all files. The selection may be incomplete.'); } catch (err) { const message = err?.response?.data?.error || err?.message || 'Unable to select all project files.'; setError(message); setStatus('Unable to select all project files.'); } finally { setSelectingAllFiles(false); } };
  const clearSelection = () => {
    setSelectedFiles(new Set());
    setLastSelectedPath(null);
    try { localStorage.setItem('ai-terminal-chat:allowed-paths', JSON.stringify([])); } catch {}
    setStatus('Cleared agent file selection.');
  };
  const useSelectedFiles = async () => { const paths = Array.from(selectedFiles); if (!paths.length) { setStatus('No files are selected for the agent.'); onUseSelectedFiles?.([]); return; } setStatus(`Reading ${paths.length} selected ${paths.length === 1 ? 'file' : 'files'} for the agent.`); setError(''); try { const files = []; for (const path of paths) { const response = await axios.get(`${host}/project/read`, { params: { path } }); files.push({ path: response.data?.path || path, content: response.data?.contents ?? response.data?.content ?? '' }); } onUseSelectedFiles?.(files); setStatus(`${files.length} ${files.length === 1 ? 'file' : 'files'} supplied to the agent.`); } catch (err) { const message = err?.response?.data?.error || err?.message || 'Unable to read selected files.'; setError(message); setStatus('Unable to supply selected files to the agent.'); } };
  const normalizedFilter = filterQuery.trim().toLowerCase(); const entryMatchesFilter = (entry) => !normalizedFilter || entryName(entry).toLowerCase().includes(normalizedFilter); const subtreeHasMatch = (entries, parentPath) => { if (!normalizedFilter) return true; for (const entry of entries) { if (entryMatchesFilter(entry)) return true; const path = entryPath(entry, parentPath); if (isDirectory(entry) && children[path] && subtreeHasMatch(children[path], path)) return true; } return false; };
  const visibleItems = []; const forcedExpandedPaths = new Set(); const addVisible = (entries, parentPath = '.', level = 1) => { const orderedEntries = sortEntries(entries); const matchingEntries = orderedEntries.filter((entry) => { const path = entryPath(entry, parentPath); const directory = isDirectory(entry); const selfMatch = entryMatchesFilter(entry); const childMatch = directory && children[path] ? subtreeHasMatch(children[path], path) : false; return !normalizedFilter || selfMatch || childMatch; }); matchingEntries.forEach((entry, siblingIndex) => { const path = entryPath(entry, parentPath); const directory = isDirectory(entry); const selfMatch = entryMatchesFilter(entry); const childMatch = directory && children[path] ? subtreeHasMatch(children[path], path) : false; const forcedExpanded = normalizedFilter && directory && childMatch && !expanded.has(path); if (forcedExpanded) forcedExpandedPaths.add(path); visibleItems.push({ entry, path, parentPath, level, directory, posinset: siblingIndex + 1, setsize: matchingEntries.length, forcedExpanded }); const shouldDescend = directory && children[path] && ((!normalizedFilter && expanded.has(path)) || (normalizedFilter && (selfMatch || childMatch) && (expanded.has(path) || childMatch))); if (shouldDescend) addVisible(children[path], path, level + 1); }); }; addVisible(rootEntries);
  const shouldVirtualize = visibleItems.length > VIRTUALIZATION_THRESHOLD; const viewportItemCount = Math.ceil(TREE_VIEWPORT_HEIGHT / TREE_ROW_HEIGHT); const firstVirtualIndex = shouldVirtualize ? Math.max(0, Math.floor(scrollTop / TREE_ROW_HEIGHT) - VIRTUALIZATION_OVERSCAN) : 0; const lastVirtualIndex = shouldVirtualize ? Math.min(visibleItems.length, firstVirtualIndex + viewportItemCount + VIRTUALIZATION_OVERSCAN * 2) : visibleItems.length; const renderedItems = shouldVirtualize ? visibleItems.slice(firstVirtualIndex, lastVirtualIndex) : visibleItems;
  const focusItem = (path) => { const index = visibleItems.findIndex((item) => item.path === path); if (index < 0) return; setActivePath(path); if (shouldVirtualize) { const top = index * TREE_ROW_HEIGHT; const bottom = top + TREE_ROW_HEIGHT; const viewportBottom = scrollTop + TREE_VIEWPORT_HEIGHT; if (top < scrollTop) setScrollTop(top); else if (bottom > viewportBottom) setScrollTop(Math.max(0, bottom - TREE_VIEWPORT_HEIGHT)); } };
  useEffect(() => { if (!activePath) return undefined; if (!treeRef.current || !treeRef.current.contains(document.activeElement)) { return undefined; } const frame = window.requestAnimationFrame(() => { treeRef.current?.querySelector(`[data-tree-path="${CSS.escape(activePath)}"]`)?.focus?.(); }); return () => window.cancelAnimationFrame(frame); }, [activePath]);
  // Track whether the tree has focus using focusin/focusout events
  useEffect(() => {
    const tree = treeRef.current;
    if (!tree) return;
    const onFocusIn = () => { treeHasFocusRef.current = true; };
    const onFocusOut = (e) => { if (!tree.contains(e.relatedTarget)) treeHasFocusRef.current = false; };
    tree.addEventListener('focusin', onFocusIn);
    tree.addEventListener('focusout', onFocusOut);
    return () => {
      tree.removeEventListener('focusin', onFocusIn);
      tree.removeEventListener('focusout', onFocusOut);
    };
  }, []);
  const moveActive = (offset) => { if (!visibleItems.length) return; const currentIndex = visibleItems.findIndex((item) => item.path === activePath); const index = currentIndex < 0 ? 0 : currentIndex; const next = Math.max(0, Math.min(index + offset, visibleItems.length - 1)); focusItem(visibleItems[next].path); };
// Keep activePath valid when filter changes remove the focused item.
// Always update activePath to a visible item (or null).
// Only move DOM focus if the tree currently has focus.
  useEffect(() => {
    if (!activePath) return;
    const stillVisible = visibleItems.some((item) => item.path === activePath);
    if (stillVisible) return;
    const nextItem = visibleItems[0] ?? null;
    setActivePath(nextItem?.path ?? null);
    // Only move DOM focus if tree has focus (not filter, not external controls)
    const treeHasFocus = treeHasFocusRef.current;
    if (treeHasFocus && nextItem) {
      window.setTimeout(() => {
        treeRef.current?.querySelector(`[data-tree-path="${CSS.escape(nextItem.path)}"]`)?.focus?.();
      }, 0);
    }
  }, [visibleItems, filterQuery, activePath]);
  const handleTreeKeyDown = async (event, item) => { const index = visibleItems.findIndex((visible) => visible.path === item.path); if (event.key === 'ArrowDown') { event.preventDefault(); moveActive(1); } else if (event.key === 'ArrowUp') { event.preventDefault(); moveActive(-1); } else if (event.key === 'Home') { event.preventDefault(); if (visibleItems[0]) focusItem(visibleItems[0].path); } else if (event.key === 'End') { event.preventDefault(); const last = visibleItems[visibleItems.length - 1]; if (last) focusItem(last.path); } else if (item.directory && event.key === 'ArrowRight') { event.preventDefault(); if (!expanded.has(item.path)) await toggleDirectory(item.path, entryName(item.entry)); else if (children[item.path]?.length) { const firstChild = visibleItems[index + 1]; if (firstChild) focusItem(firstChild.path); } } else if (item.directory && event.key === 'ArrowLeft') { event.preventDefault(); if (expanded.has(item.path)) await toggleDirectory(item.path, entryName(item.entry)); else if (item.parentPath !== '.') focusItem(item.parentPath); } else if (item.directory && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); await toggleDirectory(item.path, entryName(item.entry)); } else if (!item.directory && event.key === 'Enter') { event.preventDefault(); await openFile(item.entry, item.path); } else if (!item.directory && event.key === ' ') { event.preventDefault(); toggleFile(item.entry, item.path); } };
  useEffect(() => { if (!normalizedFilter) return undefined; const count = visibleItems.length; setStatus(count ? `Filter "${filterQuery.trim()}": ${count} visible ${count === 1 ? 'item' : 'items'}.` : `No entries match "${filterQuery.trim()}".`); return undefined; }, [filterQuery, rootEntries, children, expanded]);

  return (
    <section className="project-explorer" role="region" aria-labelledby="project-explorer-heading" data-focus-region="project">
      <h2 id="project-explorer-heading">Project</h2><p className="project-explorer-path" aria-label="Current project directory">{projectRoot || '.'}</p><p className="project-change-link"><a href="/settings.html#settings-project-root">Change project</a></p>
      <div className="project-actions"><button type="button" onClick={collapseAll}>Collapse all</button><button type="button" onClick={expandAll}>Expand all</button><button type="button" onClick={async () => { explorerEpoch.current += 1; loadGens.current.set('.', (loadGens.current.get('.') || 0) + 1); setChildren({}); setExpanded(new Set()); setActivePath(null); try { localStorage.removeItem(`${storageKey}:expanded`); sessionStorage.removeItem(`${storageKey}:expanded`); } catch {} const entries = await loadDirectory('.', true, true); if (entries != null) setRootEntries(entries); void refreshGitStatus(); }}>Refresh</button><button type="button" onClick={selectAllVisible}>Select all visible</button><button type="button" onClick={selectAllFiles} disabled={selectingAllFiles}>Select all files</button><button type="button" onClick={clearSelection} disabled={selectedFiles.size === 0}>Clear selection</button><button type="button" onClick={useSelectedFiles} disabled={selectedFiles.size === 0}>Use selected files with agent ({selectedFiles.size})</button>{onInsertPathIntoTerminal && <button type="button" onClick={() => { const path = activePath || Array.from(selectedFiles)[0] || '.'; onInsertPathIntoTerminal(path); setStatus(`Sent path ${path} to the terminal command field.`); }} disabled={!activePath && selectedFiles.size === 0} title="Insert the focused or selected path into the terminal command field">Insert path into terminal</button>}</div>
      <div className="project-filter"><label htmlFor="project-filter-input">Filter files and folders</label><input ref={filterRef} id="project-filter-input" type="search" value={filterQuery} onChange={(event) => setFilterQuery(event.target.value)} placeholder="Type to filter..." autoComplete="off" aria-controls="project-tree-list" />{filterQuery && <button type="button" onClick={() => { setFilterQuery(''); filterRef.current?.focus(); }}>Clear filter</button>}</div>
      <div className="project-help-block"><button type="button" className="project-shortcuts-toggle" aria-expanded={showShortcuts} aria-controls="project-shortcuts" onClick={() => setShowShortcuts((value) => !value)}>{showShortcuts ? 'Hide keyboard shortcuts' : 'Show keyboard shortcuts'}</button>{showShortcuts && <ul id="project-shortcuts" className="project-shortcuts"><li>F6 / Shift+F6 — move between chat, project tree, and terminal</li><li>Arrow keys — move between visible items</li><li>Right Arrow — expand folder; Left Arrow — collapse folder</li><li>Enter or Space — toggle folder; Enter on a file opens a preview</li><li>Home / End — first or last visible item</li><li>Checkboxes — select files to supply their contents to the agent</li><li>Insert path into terminal — places the focused or selected path in the terminal command field</li><li>Name / Type column headers — sort the file list; activate again to reverse the order</li></ul>}<p id="project-selection-help" className="project-selection-help">Tree view. Use arrow keys to navigate. Right Arrow expands a folder, Left Arrow collapses it, Enter or Space toggles a folder. Check files to supply their contents to the agent. Use the Name or Type column headers to sort the list. Use “Insert path into terminal” for a command workflow. Press F6 to move between the chat, project tree, and terminal.</p></div>
      <div className="project-tree-header" role="table" aria-label="Sort project files and folders"><div role="row" className="project-tree-header-row"><span role="columnheader" aria-sort={ariaSortValue('name')} className="project-tree-header-cell project-tree-header-cell-name"><button type="button" className="project-sort-button" onClick={() => handleSort('name')} aria-label={sortButtonLabel('name')}>Name<span aria-hidden="true" className="project-sort-glyph">{sortGlyph('name')}</span></button></span><span role="columnheader" aria-sort={ariaSortValue('type')} className="project-tree-header-cell project-tree-header-cell-type"><button type="button" className="project-sort-button" onClick={() => handleSort('type')} aria-label={sortButtonLabel('type')}>Type<span aria-hidden="true" className="project-sort-glyph">{sortGlyph('type')}</span></button></span><span role="columnheader" className="project-tree-header-cell project-tree-header-cell-size" title="Size is not provided by the project server.">Size</span><span role="columnheader" className="project-tree-header-cell project-tree-header-cell-modified" title="Modified date is not provided by the project server.">Modified</span></div></div>
      <div ref={treeRef} role="tree" tabIndex="-1" aria-label="Project files and directories" aria-describedby="project-selection-help" className="project-list" data-focus-target="project-tree" id="project-tree-list" onScroll={shouldVirtualize ? (event) => setScrollTop(event.currentTarget.scrollTop) : undefined} style={{ maxHeight: `${TREE_VIEWPORT_HEIGHT}px`, overflowY: 'auto' }}>
        {shouldVirtualize && <div aria-hidden="true" style={{ height: `${visibleItems.length * TREE_ROW_HEIGHT}px`, position: 'relative' }} />}
        {renderedItems.map((item, renderedIndex) => { const { entry, path, level, directory, forcedExpanded } = item; const logicalIndex = shouldVirtualize ? firstVirtualIndex + renderedIndex : renderedIndex; const name = entryName(entry); const selected = selectedFiles.has(path); const isActive = activePath === path; const gitStatus = getGitStatus(path, directory); const statusDescription = gitStatus ? `, ${gitStatus.label}` : ''; const isExpanded = directory ? (expanded.has(path) || forcedExpanded) : undefined; const treeItemLabel = directory ? `${isExpanded ? 'Expanded' : 'Collapsed'} ${name}, directory${statusDescription}` : `${name}, file${selected ? ', selected' : ''}${statusDescription}`; const ariaExpanded = directory ? String(expanded.has(path) || forcedExpanded) : undefined; return <div key={path} role="treeitem" tabIndex={isActive || ((!activePath || !renderedItems.some((r) => r.path === activePath)) && renderedIndex === 0) ? 0 : -1} aria-level={level} aria-posinset={item.posinset} aria-setsize={item.setsize} aria-expanded={ariaExpanded} aria-label={treeItemLabel} data-tree-path={path} onFocus={() => setActivePath(path)} onKeyDown={(event) => handleTreeKeyDown(event, item)} onClick={() => directory ? toggleDirectory(path, name) : openFile(entry, path)} className="project-entry" style={shouldVirtualize ? { position: 'absolute', top: `${logicalIndex * TREE_ROW_HEIGHT}px`, insetInline: 0, height: `${TREE_ROW_HEIGHT}px`, paddingInlineStart: `${Math.max(0, level - 1) * 1.25}rem` } : { paddingInlineStart: `${Math.max(0, level - 1) * 1.25}rem` }}><span className="project-entry-columns"><span className="project-entry-cell project-entry-cell-name">{directory ? <span aria-hidden="true">{isExpanded ? '▾' : '▸'}</span> : <input type="checkbox" checked={selected} onChange={(event) => toggleFile(item.entry, path, { shiftKey: event.nativeEvent?.shiftKey || event.shiftKey })} aria-label={`Select ${name} for the agent`} onClick={(event) => event.stopPropagation()} />}{' '}{name}{gitStatus && <span className={`project-git-status project-git-status-${gitStatus.kind}`} aria-hidden="true" title={`Git status: ${gitStatus.label}`}>[{gitStatus.short}]</span>}</span><span className="project-entry-cell project-entry-cell-type" aria-hidden="true">{typeLabel(entry)}</span><span className="project-entry-cell project-entry-cell-size" aria-hidden="true">—</span><span className="project-entry-cell project-entry-cell-modified" aria-hidden="true">—</span></span></div>; })}
      </div>
      {visibleItems.length === 0 && !error && <div className="project-empty" aria-live="polite"><p>{normalizedFilter ? `No entries match "${filterQuery.trim()}".` : 'No entries in this project.'}</p>{!normalizedFilter && <p><a href="/settings.html#settings-project-root">Change project</a>{' · '}<button type="button" onClick={async () => { explorerEpoch.current += 1; loadGens.current.set('.', (loadGens.current.get('.') || 0) + 1); setChildren({}); setExpanded(new Set()); const entries = await loadDirectory('.', true, true); if (entries != null) setRootEntries(entries); void refreshGitStatus(); }}>Retry</button></p>}</div>}
      {openedFile && <div className="confirmation-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closePreview(); }}><section ref={previewDialogRef} className="confirmation-dialog file-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="project-file-preview-heading"><h3 id="project-file-preview-heading">File: {openedFile.path}</h3><pre aria-label={`Contents of ${openedFile.path}`}>{openedFile.content}</pre><div className="confirmation-dialog-actions"><button ref={previewCloseRef} type="button" onClick={closePreview}>Close</button></div></section></div>}
      <div role="status" aria-live="polite" className="project-status">{status}</div>{gitStatusError && <div role="status" aria-live="polite" className="project-git-status-error">{gitStatusError}</div>}{error && <div role="alert" className="project-error"><p>{error}</p><p><a href="/settings.html#settings-project-root">Change project</a>{' · '}<button type="button" onClick={async () => { explorerEpoch.current += 1; loadGens.current.set('.', (loadGens.current.get('.') || 0) + 1); setError(''); setChildren({}); const entries = await loadDirectory('.', true, true); if (entries != null) setRootEntries(entries); void refreshGitStatus(); }}>Retry</button></p></div>}
    </section>
  );
}

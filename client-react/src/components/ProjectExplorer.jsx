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
      <p className="project-explorer-path" aria-label="Current project directory">{projectRoot || '.'}</p>
      <p className="project-change-link">
        <a href="./settings.html#settings-project-root">Change project</a>
      </p>
      <div className="project-actions">
        <button type="button" onClick={collapseAll}>Collapse all</button>
        <button type="button" onClick={expandAll}>Expand all</button>
        <button type="button" onClick={async () => {
          setChildren({}); setExpanded(new Set()); setActivePath(null);
          try { sessionStorage.removeItem(`${storageKey}:expanded`); } catch { /* ignore */ }
          const entries = await loadDirectory('.', true); setRootEntries(entries); void refreshGitStatus();
        }}>Refresh</button>
        <button type="button" onClick={selectAllVisible}>Select all visible</button>
        <button type="button" onClick={selectAllFiles} disabled={selectingAllFiles}>Select all files</button>
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
          <li>Name / Type column headers — sort the file list; activate again to reverse the order</li>
        </ul>}
        <p id="project-selection-help" className="project-selection-help">Tree view. Use arrow keys to navigate. Right Arrow expands a folder, Left Arrow collapses it, Enter or Space toggles a folder. Check files to supply their contents to the agent. Use the Name or Type column headers to sort the list. Use “Insert path into terminal” for a command workflow. Press F6 to move between the chat, project tree, and terminal.</p>
      </div>
      <div className="project-tree-header" role="table" aria-label="Sort project files and folders">
        <div role="row" className="project-tree-header-row">
          <span role="columnheader" aria-sort={ariaSortValue('name')} className="project-tree-header-cell project-tree-header-cell-name">
            <button type="button" className="project-sort-button" onClick={() => handleSort('name')} aria-label={sortButtonLabel('name')}>
              Name<span aria-hidden="true" className="project-sort-glyph">{sortGlyph('name')}</span>
            </button>
          </span>
          <span role="columnheader" aria-sort={ariaSortValue('type')} className="project-tree-header-cell project-tree-header-cell-type">
            <button type="button" className="project-sort-button" onClick={() => handleSort('type')} aria-label={sortButtonLabel('type')}>
              Type<span aria-hidden="true" className="project-sort-glyph">{sortGlyph('type')}</span>
            </button>
          </span>
          <span role="columnheader" className="project-tree-header-cell project-tree-header-cell-size" title="Size is not provided by the project server.">Size</span>
          <span role="columnheader" className="project-tree-header-cell project-tree-header-cell-modified" title="Modified date is not provided by the project server.">Modified</span>
        </div>
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
            <span className="project-entry-columns">
              <span className="project-entry-cell project-entry-cell-name">
                {directory ? <span aria-hidden="true">{expanded.has(path) ? '▾' : '▸'}</span> : <input type="checkbox" checked={selected} onChange={(event) => toggleFile(item.entry, path, { shiftKey: event.nativeEvent?.shiftKey || event.shiftKey })} aria-label={`Select ${name} for the agent`} onClick={(event) => event.stopPropagation()} />}
                {' '}{name}{gitStatus && <span className={`project-git-status project-git-status-${gitStatus.kind}`} aria-hidden="true" title={`Git status: ${gitStatus.label}`}>[{gitStatus.short}]</span>}
              </span>
              <span className="project-entry-cell project-entry-cell-type" aria-hidden="true">{typeLabel(entry)}</span>
              <span className="project-entry-cell project-entry-cell-size" aria-hidden="true">—</span>
              <span className="project-entry-cell project-entry-cell-modified" aria-hidden="true">—</span>
            </span>
          </div>;
        })}
      </div>
      {visibleItems.length === 0 && !error && <div className="project-empty" aria-live="polite">
        <p>{normalizedFilter ? `No entries match "${filterQuery.trim()}".` : 'No entries in this project.'}</p>
        {!normalizedFilter && <p><a href="./settings.html#settings-project-root">Change project</a>{' · '}<button type="button" onClick={async () => { setChildren({}); setExpanded(new Set()); const entries = await loadDirectory('.', true); setRootEntries(entries); void refreshGitStatus(); }}>Retry</button></p>}
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
        <p><a href="./settings.html#settings-project-root">Change project</a>{' · '}<button type="button" onClick={async () => { setError(''); setChildren({}); const entries = await loadDirectory('.', true); setRootEntries(entries); void refreshGitStatus(); }}>Retry</button></p>
      </div>}
    </section>
  );
}
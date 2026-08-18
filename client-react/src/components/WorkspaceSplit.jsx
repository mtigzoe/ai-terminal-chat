import React, { useRef, useState } from 'react';

/**
 * Integrated workspace that keeps Project and Terminal simultaneously visible
 * while preserving an accessible tablist for focus management and F6 cycling.
 *
 * Both panels stay mounted so project-tree expansion and terminal history are
 * preserved. The tablist marks the active region for assistive technology and
 * scrolls/focuses that panel; it does not hide the other panel.
 */
export default function WorkspaceSplit({
  panels,
  ariaLabel = 'Project and terminal',
  activePanelId,
  onActivePanelChange,
}) {
  const [internalActiveId, setInternalActiveId] = useState(panels[0]?.id);
  const activeId = activePanelId ?? internalActiveId;
  const tabRefs = useRef({});
  const panelRefs = useRef({});

  const activate = (id, { focusTab = true, focusPanel = true } = {}) => {
    if (onActivePanelChange) onActivePanelChange(id);
    else setInternalActiveId(id);

    if (focusTab) {
      window.setTimeout(() => tabRefs.current[id]?.focus(), 0);
    }

    if (focusPanel) {
      window.setTimeout(() => {
        const panel = panelRefs.current[id];
        panel?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
      }, 0);
    }
  };

  const handleKeyDown = (event, index) => {
    let nextIndex = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (index + 1) % panels.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (index - 1 + panels.length) % panels.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = panels.length - 1;
    }
    if (nextIndex !== null) {
      event.preventDefault();
      activate(panels[nextIndex].id);
    }
  };

  return (
    <div className="workspace-split">
      <div role="tablist" aria-label={ariaLabel} className="workspace-tablist workspace-split-tablist">
        {panels.map((panel, index) => {
          const selected = activeId === panel.id;
          return (
            <button
              key={panel.id}
              ref={(el) => {
                tabRefs.current[panel.id] = el;
              }}
              type="button"
              role="tab"
              id={`tab-${panel.id}`}
              aria-selected={selected}
              aria-controls={`tabpanel-${panel.id}`}
              tabIndex={selected ? 0 : -1}
              className={`workspace-tab${selected ? ' active' : ''}`}
              onClick={() => activate(panel.id, { focusTab: true, focusPanel: true })}
              onKeyDown={(event) => handleKeyDown(event, index)}
            >
              {panel.label}
            </button>
          );
        })}
      </div>

      <div className="workspace-split-panels" aria-label={`${ariaLabel} panels`}>
        {panels.map((panel) => {
          const selected = activeId === panel.id;
          return (
            <div
              key={panel.id}
              ref={(el) => {
                panelRefs.current[panel.id] = el;
              }}
              id={`tabpanel-${panel.id}`}
              role="tabpanel"
              aria-labelledby={`tab-${panel.id}`}
              className={`workspace-tabpanel workspace-split-panel${selected ? ' is-active' : ''}`}
              // Both panels remain visible; tabIndex keeps the inactive panel
              // out of the sequential tab order while still reachable via F6
              // and the tablist.
              tabIndex={-1}
              data-workspace-panel={panel.id}
              data-active={selected ? 'true' : 'false'}
            >
              {panel.content}
            </div>
          );
        })}
      </div>
    </div>
  );
}

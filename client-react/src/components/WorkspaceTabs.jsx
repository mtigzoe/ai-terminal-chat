import React, { useRef, useState } from 'react';

/**
 * Accessible tabs (WAI-ARIA "automatic activation" pattern) for switching
 * between workspace panels (Project, Terminal, ...). All panels stay
 * mounted — only visibility toggles via the `hidden` attribute — so panel
 * state (file browser position, terminal history) survives tab switches.
 */
export default function WorkspaceTabs({ panels, ariaLabel }) {
  const [activeId, setActiveId] = useState(panels[0]?.id);
  const tabRefs = useRef({});

  const activate = (id) => {
    setActiveId(id);
    tabRefs.current[id]?.focus();
  };

  const handleKeyDown = (event, index) => {
    let nextIndex = null;
    if (event.key === 'ArrowRight') nextIndex = (index + 1) % panels.length;
    else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + panels.length) % panels.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = panels.length - 1;
    if (nextIndex !== null) {
      event.preventDefault();
      activate(panels[nextIndex].id);
    }
  };

  return (
    <div className="workspace-tabs">
      <div role="tablist" aria-label={ariaLabel} className="workspace-tablist">
        {panels.map((panel, index) => {
          const selected = activeId === panel.id;
          return (
            <button
              key={panel.id}
              ref={(el) => { tabRefs.current[panel.id] = el; }}
              type="button"
              role="tab"
              id={`tab-${panel.id}`}
              aria-selected={selected}
              aria-controls={`tabpanel-${panel.id}`}
              tabIndex={selected ? 0 : -1}
              className={`workspace-tab${selected ? ' active' : ''}`}
              onClick={() => activate(panel.id)}
              onKeyDown={(event) => handleKeyDown(event, index)}
            >
              {panel.label}
            </button>
          );
        })}
      </div>
      {panels.map((panel) => (
        <div
          key={panel.id}
          id={`tabpanel-${panel.id}`}
          role="tabpanel"
          aria-labelledby={`tab-${panel.id}`}
          hidden={activeId !== panel.id}
          className="workspace-tabpanel"
        >
          {panel.content}
        </div>
      ))}
    </div>
  );
}

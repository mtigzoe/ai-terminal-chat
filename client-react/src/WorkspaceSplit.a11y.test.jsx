import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import React, { useState } from 'react';
import WorkspaceSplit from './components/WorkspaceSplit';

const panels = [
  { id: 'project', label: 'Project', content: <div>Project content</div> },
  { id: 'terminal', label: 'Terminal', content: <div>Terminal content</div> },
];

function Wrapper({ initialActive = 'project' }) {
  const [activeId, setActiveId] = useState(initialActive);
  return (
    <WorkspaceSplit
      panels={panels}
      ariaLabel="Workspace"
      activePanelId={activeId}
      onActivePanelChange={setActiveId}
    />
  );
}

describe('WorkspaceSplit accessibility', () => {
  test('renders tabs with role=tab and labelled tabpanels that remain visible', () => {
    render(<Wrapper />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toHaveTextContent('Project');
    expect(tabs[1]).toHaveTextContent('Terminal');

    const projectTabpanel = screen.getByRole('tabpanel', { name: /project/i });
    const terminalTabpanel = screen.getByRole('tabpanel', { name: /terminal/i });
    expect(projectTabpanel).toBeInTheDocument();
    expect(terminalTabpanel).toBeInTheDocument();
    // Both panels stay in the document and are not hidden — integration goal.
    expect(projectTabpanel).not.toHaveAttribute('hidden');
    expect(terminalTabpanel).not.toHaveAttribute('hidden');
    expect(projectTabpanel).toHaveAttribute('aria-labelledby', 'tab-project');
  });

  test('marks the active tab with aria-selected=true and the inactive tab with aria-selected=false', () => {
    render(<Wrapper />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false');
  });

  test('only the active tab participates in the tab sequence', () => {
    render(<Wrapper />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs[0]).toHaveAttribute('tabindex', '0');
    expect(tabs[1]).toHaveAttribute('tabindex', '-1');
  });

  test('ArrowRight moves focus and selection to the next tab', () => {
    render(<Wrapper />);

    const tabs = screen.getAllByRole('tab');
    fireEvent.keyDown(tabs[0], { key: 'ArrowRight' });

    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[1]).toHaveAttribute('tabindex', '0');
    expect(tabs[0]).toHaveAttribute('tabindex', '-1');
  });

  test('ArrowLeft moves focus and selection to the previous tab', () => {
    render(<Wrapper initialActive="terminal" />);

    const tabs = screen.getAllByRole('tab');
    fireEvent.keyDown(tabs[1], { key: 'ArrowLeft' });

    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[0]).toHaveAttribute('tabindex', '0');
    expect(tabs[1]).toHaveAttribute('tabindex', '-1');
  });

  test('Home and End move to first and last tabs', () => {
    render(<Wrapper />);

    const tabs = screen.getAllByRole('tab');
    fireEvent.keyDown(tabs[0], { key: 'End' });
    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(tabs[1], { key: 'Home' });
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
  });

  test('active panel is marked with data-active=true for styling and AT cues', () => {
    render(<Wrapper />);

    const projectPanel = document.getElementById('tabpanel-project');
    const terminalPanel = document.getElementById('tabpanel-terminal');
    expect(projectPanel).toHaveAttribute('data-active', 'true');
    expect(terminalPanel).toHaveAttribute('data-active', 'false');

    fireEvent.click(screen.getByRole('tab', { name: /terminal/i }));
    expect(projectPanel).toHaveAttribute('data-active', 'false');
    expect(terminalPanel).toHaveAttribute('data-active', 'true');
  });
});

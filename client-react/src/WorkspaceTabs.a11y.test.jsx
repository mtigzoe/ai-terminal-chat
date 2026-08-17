import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test } from 'vitest';
import React, { useState } from 'react';
import WorkspaceTabs from './components/WorkspaceTabs';

const panels = [
  { id: 'project', label: 'Project', content: <div>Project content</div> },
  { id: 'terminal', label: 'Terminal', content: <div>Terminal content</div> },
];

function Wrapper({ initialActive = 'project' }) {
  const [activeId, setActiveId] = useState(initialActive);
  return (
    <WorkspaceTabs
      panels={panels}
      ariaLabel="Workspace"
      activePanelId={activeId}
      onActivePanelChange={setActiveId}
    />
  );
}

describe('WorkspaceTabs accessibility', () => {
  test('renders tabs with role=tab and labelled tabpanels', () => {
    render(<Wrapper />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    expect(tabs[0]).toHaveTextContent('Project');
    expect(tabs[1]).toHaveTextContent('Terminal');

    const projectTabpanel = screen.getByRole('tabpanel', { name: /project/i });
    expect(projectTabpanel).toBeInTheDocument();
    const projectPanel = document.getElementById('tabpanel-project');
    expect(projectPanel).toHaveAttribute('aria-labelledby', 'tab-project');
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

  test('Home moves focus and selection to the first tab', () => {
    render(<Wrapper initialActive="terminal" />);

    const tabs = screen.getAllByRole('tab');
    fireEvent.keyDown(tabs[1], { key: 'Home' });

    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[0]).toHaveAttribute('tabindex', '0');
  });

  test('End moves focus and selection to the last tab', () => {
    render(<Wrapper initialActive="project" />);

    const tabs = screen.getAllByRole('tab');
    fireEvent.keyDown(tabs[0], { key: 'End' });

    expect(tabs[1]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[1]).toHaveAttribute('tabindex', '0');
  });

  test('each tab controls its panel via aria-controls', () => {
    render(<Wrapper />);

    const tabs = screen.getAllByRole('tab');
    expect(tabs[0]).toHaveAttribute('aria-controls', 'tabpanel-project');
    expect(tabs[1]).toHaveAttribute('aria-controls', 'tabpanel-terminal');
  });
});

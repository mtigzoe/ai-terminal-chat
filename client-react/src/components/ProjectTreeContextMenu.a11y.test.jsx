import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import ProjectTreeContextMenu from './ProjectTreeContextMenu';

function TreeFixture({ directory = false }) {
  return (
    <>
      <div role="tree">
        <div
          role="treeitem"
          tabIndex="0"
          aria-label={directory ? 'Collapsed src, directory' : 'App.jsx, file'}
          aria-expanded={directory ? 'false' : undefined}
          data-tree-path={directory ? 'src' : 'App.jsx'}
        >
          {directory ? 'src' : (
            <>
              <input type="checkbox" aria-label="Select App.jsx for the agent" />
              App.jsx
            </>
          )}
        </div>
      </div>
      <div className="project-actions">
        <button type="button">Insert path into terminal</button>
      </div>
    </>
  );
}

describe('ProjectTreeContextMenu accessibility', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  test('opens from the context-menu keyboard key and exposes menuitems', () => {
    render(<><TreeFixture /><ProjectTreeContextMenu /></>);
    const treeItem = screen.getByRole('treeitem');

    fireEvent.keyDown(treeItem, { key: 'ContextMenu' });

    expect(screen.getByRole('menu', { name: /actions for app\.jsx/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /open file/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /select for agent/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /copy path/i })).toBeInTheDocument();
    expect(document.activeElement).toHaveAttribute('role', 'menuitem');
  });

  test('opens with Shift+F10 and provides folder-specific actions', () => {
    render(<><TreeFixture directory /><ProjectTreeContextMenu /></>);
    const treeItem = screen.getByRole('treeitem');

    fireEvent.keyDown(treeItem, { key: 'F10', shiftKey: true });

    expect(screen.getByRole('menu', { name: /actions for collapsed src/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /expand folder/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /open file/i })).not.toBeInTheDocument();
  });

  test('Escape closes the menu and restores focus to the tree item', () => {
    render(<><TreeFixture /><ProjectTreeContextMenu /></>);
    const treeItem = screen.getByRole('treeitem');
    treeItem.focus();

    fireEvent.contextMenu(treeItem, { clientX: 40, clientY: 50 });
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(treeItem);
  });

  test('ArrowDown and ArrowUp move through menuitems', () => {
    render(<><TreeFixture /><ProjectTreeContextMenu /></>);
    const treeItem = screen.getByRole('treeitem');
    fireEvent.contextMenu(treeItem, { clientX: 40, clientY: 50 });

    const items = screen.getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[0]);
  });
});

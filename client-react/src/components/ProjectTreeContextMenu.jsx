import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import './ProjectTreeContextMenu.css';

const getTreeItem = (target) => {
  if (!(target instanceof Element)) return null;
  return target.closest('[role="treeitem"][data-tree-path]');
};

const getMenuPosition = (treeItem, event) => {
  if (event?.clientX || event?.clientY) {
    return { left: Math.max(8, event.clientX), top: Math.max(8, event.clientY) };
  }
  const rect = treeItem?.getBoundingClientRect();
  return {
    left: Math.max(8, rect ? rect.left : 8),
    top: Math.max(8, rect ? rect.bottom : 8),
  };
};

export default function ProjectTreeContextMenu() {
  const [target, setTarget] = useState(null);
  const [position, setPosition] = useState({ left: 8, top: 8 });
  const menuRef = useRef(null);
  const returnFocusRef = useRef(null);

  const closeMenu = useCallback((restoreFocus = true) => {
    const previous = returnFocusRef.current;
    setTarget(null);
    returnFocusRef.current = null;
    if (restoreFocus) {
      window.setTimeout(() => previous?.focus?.(), 0);
    }
  }, []);

  useEffect(() => {
    const onContextMenu = (event) => {
      const treeItem = getTreeItem(event.target);
      if (!treeItem) return;
      event.preventDefault();
      returnFocusRef.current = treeItem;
      treeItem.focus();
      setPosition(getMenuPosition(treeItem, event));
      setTarget(treeItem);
    };

    const onKeyDown = (event) => {
      if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
      const treeItem = getTreeItem(event.target);
      if (!treeItem) return;
      event.preventDefault();
      event.stopPropagation();
      returnFocusRef.current = treeItem;
      treeItem.focus();
      setPosition(getMenuPosition(treeItem));
      setTarget(treeItem);
    };

    document.addEventListener('contextmenu', onContextMenu);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, []);

  useLayoutEffect(() => {
    if (!target) return undefined;
    const onPointerDown = (event) => {
      if (!menuRef.current?.contains(event.target)) closeMenu();
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu();
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    menuRef.current?.querySelector('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [target, closeMenu]);

  if (!target) return null;

  const path = target.getAttribute('data-tree-path') || '';
  const label = target.getAttribute('aria-label') || target.textContent?.trim() || path;
  const isDirectory = target.getAttribute('aria-expanded') !== null;
  const isExpanded = target.getAttribute('aria-expanded') === 'true';
  const checkbox = target.querySelector('input[type="checkbox"]');
  const isSelected = checkbox?.checked === true;

  const runAndClose = (action) => {
    action();
    closeMenu();
  };

  const clickTreeItem = () => target.click();
  const toggleSelection = () => checkbox?.click();
  const insertPath = () => {
    target.focus();
    const button = Array.from(document.querySelectorAll('.project-actions button'))
      .find((item) => item.textContent?.includes('Insert path into terminal'));
    button?.click();
  };
  const copyPath = async () => {
    try {
      await navigator.clipboard?.writeText(path);
    } catch {
      // Clipboard permissions can be unavailable; leave the tree usable.
    }
  };

  const menuItems = [];
  if (isDirectory) {
    menuItems.push({
      label: isExpanded ? 'Collapse folder' : 'Expand folder',
      action: clickTreeItem,
    });
  } else {
    menuItems.push({ label: 'Open file', action: clickTreeItem });
    menuItems.push({
      label: isSelected ? 'Remove from agent selection' : 'Select for agent',
      action: toggleSelection,
      disabled: !checkbox,
    });
  }
  menuItems.push({ label: 'Copy path', action: copyPath });
  menuItems.push({
    label: 'Insert path into terminal',
    action: insertPath,
    disabled: !Array.from(document.querySelectorAll('.project-actions button'))
      .some((button) => button.textContent?.includes('Insert path into terminal')),
  });

  return (
    <div
      ref={menuRef}
      className="project-tree-context-menu"
      role="menu"
      aria-label={`Actions for ${label}`}
      style={{
        position: 'fixed',
        left: position.left,
        top: position.top,
        zIndex: 1000,
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const items = Array.from(menuRef.current?.querySelectorAll('[role="menuitem"]') || []);
          const current = items.indexOf(document.activeElement);
          const delta = event.key === 'ArrowDown' ? 1 : -1;
          const next = items[(current + delta + items.length) % items.length];
          next?.focus();
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault();
          const items = Array.from(menuRef.current?.querySelectorAll('[role="menuitem"]') || []);
          (event.key === 'Home' ? items[0] : items[items.length - 1])?.focus();
        }
      }}
    >
      {menuItems.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={() => runAndClose(item.action)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

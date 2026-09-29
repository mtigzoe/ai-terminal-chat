import React from 'react';

const PAGES = [
  { href: './index.html', label: 'Chat', file: 'index.html' },
  { href: './instructions.html', label: 'Instructions', file: 'instructions.html' },
  { href: './history.html', label: 'History', file: 'history.html' },
  { href: './project.html', label: 'Project', file: 'project.html' },
  { href: './settings.html', label: 'Settings', file: 'settings.html' },
];

/**
 * Shared main navigation used on Chat, Instructions, History, Project, and Settings pages.
 * Order: Chat → Instructions → History → Project → Settings.
 */
function MainNav() {
  const path = typeof window !== 'undefined' ? window.location.pathname : '/';
  // Match on the document name, not the whole pathname. In the packaged
  // Electron app the pathname is the full install path, so a directory named
  // "project-notes" or "settings-backup" made several entries light up at once
  // and announced more than one "current page". The trailing slash is stripped
  // first so a route like "/chat/" yields "chat" rather than an empty segment
  // that would fall through to the index.html default.
  const trimmedPath = path.replace(/\/+$/, '');
  const currentFile = (trimmedPath.split('/').pop() || 'index.html').toLowerCase();

  return (
    <nav className="main-nav" aria-label="Main">
      <ul className="main-nav-list">
        {PAGES.map(({ href, label, file }) => {
          const isCurrent = currentFile === file;
          return (
            <li key={href}>
              <a
                href={href}
                aria-current={isCurrent ? 'page' : undefined}
                className={isCurrent ? 'main-nav-link is-current' : 'main-nav-link'}
              >
                {label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export default MainNav;

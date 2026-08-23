import React from 'react';

const PAGES = [
  { href: '/', label: 'Chat', match: (path) => path === '/' || path === '/index.html' || path.endsWith('/index.html') },
  { href: '/project.html', label: 'Project', match: (path) => path.includes('project') },
  { href: '/settings.html', label: 'Settings', match: (path) => path.includes('settings') },
];

/**
 * Shared main navigation used on Chat, Project, and Settings pages.
 * Order: Chat → Project → Settings.
 */
function MainNav() {
  const path = typeof window !== 'undefined' ? window.location.pathname : '/';

  return (
    <nav className="main-nav" aria-label="Main">
      <ul className="main-nav-list">
        {PAGES.map(({ href, label, match }) => {
          const isCurrent = match(path);
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

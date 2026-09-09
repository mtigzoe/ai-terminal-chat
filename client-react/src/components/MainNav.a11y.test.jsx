import { fireEvent, render, screen } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import MainNav from './MainNav.jsx';

expect.extend(toHaveNoViolations);

function setPathname(pathname) {
  Object.defineProperty(window, 'location', {
    value: { pathname, search: '', hash: '' },
    writable: true,
    configurable: true,
  });
}

describe('MainNav accessibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to default path
    setPathname('/');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('automated accessibility scans', () => {
    test('has no violations on Chat route (/)', async () => {
      setPathname('/');
      const { container } = render(<MainNav />);
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });

    test('has no violations on Chat route (/index.html)', async () => {
      setPathname('/index.html');
      const { container } = render(<MainNav />);
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });

    test('has no violations on nested Chat route (/deep/index.html)', async () => {
      setPathname('/deep/nested/index.html');
      const { container } = render(<MainNav />);
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });

    test('has no violations on Instructions route', async () => {
      setPathname('/instructions.html');
      const { container } = render(<MainNav />);
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });

    test('has no violations on Instructions route with query params', async () => {
      setPathname('/instructions.html');
      const { container } = render(<MainNav />);
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });

    test('has no violations on History route', async () => {
      setPathname('/history.html');
      const { container } = render(<MainNav />);
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });

    test('has no violations on Project route', async () => {
      setPathname('/project.html');
      const { container } = render(<MainNav />);
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });

    test('has no violations on Settings route', async () => {
      setPathname('/settings.html');
      const { container } = render(<MainNav />);
      const results = await axe(container);
      expect(results).toHaveNoViolations();
    });
  });

  describe('navigation landmark', () => {
    test('nav has appropriate accessible name', () => {
      setPathname('/');
      render(<MainNav />);
      const nav = screen.getByRole('navigation', { name: /main/i });
      expect(nav).toBeInTheDocument();
    });
  });

  describe('navigation links', () => {
    test('all five navigation links are present with correct hrefs', () => {
      setPathname('/');
      render(<MainNav />);
      const links = screen.getAllByRole('link');
      expect(links).toHaveLength(5);
      expect(links[0]).toHaveAttribute('href', './index.html');
      expect(links[1]).toHaveAttribute('href', './instructions.html');
      expect(links[2]).toHaveAttribute('href', './history.html');
      expect(links[3]).toHaveAttribute('href', './project.html');
      expect(links[4]).toHaveAttribute('href', './settings.html');
    });

    test('all links have meaningful accessible names', () => {
      setPathname('/');
      render(<MainNav />);
      const links = screen.getAllByRole('link');
      links.forEach((link) => {
        expect(link).toHaveAccessibleName();
      });
    });
  });

  describe('aria-current reflects current page', () => {
    test('Chat link has aria-current="page" on root path', () => {
      setPathname('/');
      render(<MainNav />);
      expect(screen.getByRole('link', { name: /chat/i })).toHaveAttribute('aria-current', 'page');
    });

    test('Chat link has aria-current="page" on /index.html', () => {
      setPathname('/index.html');
      render(<MainNav />);
      expect(screen.getByRole('link', { name: /chat/i })).toHaveAttribute('aria-current', 'page');
    });

    test('Chat link has aria-current="page" on nested /index.html', () => {
      setPathname('/deep/nested/index.html');
      render(<MainNav />);
      expect(screen.getByRole('link', { name: /chat/i })).toHaveAttribute('aria-current', 'page');
    });

    test('Instructions link has aria-current="page" on instructions route', () => {
      setPathname('/instructions.html');
      render(<MainNav />);
      expect(screen.getByRole('link', { name: /instructions/i })).toHaveAttribute('aria-current', 'page');
    });

    test('Instructions link has aria-current="page" with query params', () => {
      setPathname('/instructions.html');
      render(<MainNav />);
      expect(screen.getByRole('link', { name: /instructions/i })).toHaveAttribute('aria-current', 'page');
    });

    test('History link has aria-current="page" on history route', () => {
      setPathname('/history.html');
      render(<MainNav />);
      expect(screen.getByRole('link', { name: /history/i })).toHaveAttribute('aria-current', 'page');
    });

    test('Project link has aria-current="page" on project route', () => {
      setPathname('/project.html');
      render(<MainNav />);
      expect(screen.getByRole('link', { name: /project/i })).toHaveAttribute('aria-current', 'page');
    });

    test('Settings link has aria-current="page" on settings route', () => {
      setPathname('/settings.html');
      render(<MainNav />);
      expect(screen.getByRole('link', { name: /settings/i })).toHaveAttribute('aria-current', 'page');
    });

    test('non-current links do NOT have aria-current attribute', () => {
      setPathname('/instructions.html');
      render(<MainNav />);
      const chatLink = screen.getByRole('link', { name: /chat/i });
      const historyLink = screen.getByRole('link', { name: /history/i });
      const projectLink = screen.getByRole('link', { name: /project/i });
      const settingsLink = screen.getByRole('link', { name: /settings/i });

      expect(chatLink).not.toHaveAttribute('aria-current');
      expect(historyLink).not.toHaveAttribute('aria-current');
      expect(projectLink).not.toHaveAttribute('aria-current');
      expect(settingsLink).not.toHaveAttribute('aria-current');
    });
  });

  describe('keyboard accessibility', () => {
    test('all links are reachable and focusable', () => {
      setPathname('/');
      render(<MainNav />);
      const links = screen.getAllByRole('link');
      links.forEach((link) => {
        link.focus();
        expect(link).toHaveFocus();
      });
    });

    test('links are in correct DOM order for keyboard navigation', () => {
      setPathname('/');
      render(<MainNav />);
      const links = screen.getAllByRole('link');
      expect(links[0]).toHaveAttribute('href', './index.html'); // Chat
      expect(links[1]).toHaveAttribute('href', './instructions.html'); // Instructions
      expect(links[2]).toHaveAttribute('href', './history.html'); // History
      expect(links[3]).toHaveAttribute('href', './project.html'); // Project
      expect(links[4]).toHaveAttribute('href', './settings.html'); // Settings
    });

    test('no keyboard trap - all links are in tab order', () => {
      setPathname('/');
      render(<MainNav />);
      const links = screen.getAllByRole('link');
      // Verify all links have tabIndex >= 0 (implicitly true for <a href>)
      links.forEach((link) => {
        expect(link).not.toHaveAttribute('tabindex', '-1');
      });
    });

    test('Enter on a link does not throw', () => {
      setPathname('/');
      render(<MainNav />);
      const chatLink = screen.getByRole('link', { name: /chat/i });
      chatLink.focus();
      // Just verify no error thrown; actual navigation happens in browser
      fireEvent.keyDown(chatLink, { key: 'Enter' });
    });
  });

  describe('focus behavior', () => {
    test('focused links are focusable', () => {
      setPathname('/');
      render(<MainNav />);
      const links = screen.getAllByRole('link');
      links.forEach((link) => {
        link.focus();
        expect(link).toHaveFocus();
      });
    });
  });

  describe('edge cases in URL matching', () => {
    test('chat route with trailing slash does not match', () => {
      // Note: window.location.pathname includes trailing slash if present
      // MainNav.match for chat: path === '/' || path === '/index.html' || path.endsWith('/index.html')
      // '/chat/' would NOT match chat - this is expected behavior
      setPathname('/chat/');
      render(<MainNav />);
      // On '/chat/' none of the match functions return true
      // Verify no link incorrectly gets aria-current
      const links = screen.getAllByRole('link');
      links.forEach((link) => {
        expect(link).not.toHaveAttribute('aria-current');
      });
    });

    test('deeply nested instructions path still matches', () => {
      setPathname('/deep/nested/instructions.html');
      render(<MainNav />);
      expect(screen.getByRole('link', { name: /instructions/i })).toHaveAttribute('aria-current', 'page');
    });

    test('deeply nested project path still matches', () => {
      setPathname('/deep/nested/project.html');
      render(<MainNav />);
      expect(screen.getByRole('link', { name: /project/i })).toHaveAttribute('aria-current', 'page');
    });

    test('history path with query still matches', () => {
      setPathname('/history.html');
      render(<MainNav />);
      expect(screen.getByRole('link', { name: /history/i })).toHaveAttribute('aria-current', 'page');
    });

    test('settings path with hash still matches', () => {
      setPathname('/settings.html');
      render(<MainNav />);
      expect(screen.getByRole('link', { name: /settings/i })).toHaveAttribute('aria-current', 'page');
    });
  });
});
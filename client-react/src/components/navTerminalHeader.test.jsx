import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import MainNav from './MainNav.jsx';
import TerminalPanel from './TerminalPanel.jsx';
import Header from './Header.jsx';
import axios from 'axios';

vi.mock('axios', () => ({ default: { post: vi.fn() } }));

const LINKS = ['Chat', 'Instructions', 'History', 'Project', 'Settings'];

function currentLabels() {
  return screen
    .getAllByRole('link')
    .filter((a) => a.getAttribute('aria-current') === 'page')
    .map((a) => a.textContent.trim());
}

function setPath(pathname) {
  delete window.location;
  window.location = { pathname, href: `https://app.test${pathname}` };
}

describe('MainNav current-page detection', () => {
  beforeEach(() => {
    setPath('/index.html');
  });

  // Regression: each entry substring-matched the whole location.pathname, so
  // in the packaged Electron app (where the pathname is the full install
  // path) a directory named "project-notes" or "settings-backup" lit up
  // several entries at once and announced more than one current page.
  it.each([
    ['/index.html', ['Chat']],
    ['/history.html', ['History']],
    ['/project.html', ['Project']],
    ['/settings.html', ['Settings']],
    ['/instructions.html', ['Instructions']],
  ])('marks exactly one entry current for %s', (pathname, expected) => {
    setPath(pathname);
    render(<MainNav />);
    expect(currentLabels()).toEqual(expected);
  });

  it.each([
    '/C:/Users/me/project-notes/app/dist/index.html',
    '/opt/project/history/settings/app/dist/index.html',
    '/home/user/settings-backup/app/dist/index.html',
  ])('is unaffected by directory names in the install path (%s)', (pathname) => {
    setPath(pathname);
    render(<MainNav />);
    expect(currentLabels()).toEqual(['Chat']);
  });

  it('never marks two entries current at once', () => {
    for (const pathname of [
      '/a/project/b/history/c/index.html',
      '/settings/project/instructions/index.html',
    ]) {
      setPath(pathname);
      const { unmount } = render(<MainNav />);
      expect(currentLabels()).toHaveLength(1);
      unmount();
    }
  });

  it('links to every page', () => {
    render(<MainNav />);
    for (const label of LINKS) {
      expect(screen.getByRole('link', { name: label })).toBeInTheDocument();
    }
  });

  it('does not treat a trailing slash as the index document', () => {
    // "/chat/" must yield "chat", not an empty segment that falls back to
    // index.html and lights up the Chat entry.
    for (const pathname of ['/chat/', '/project/', '/some/route/']) {
      setPath(pathname);
      const { unmount } = render(<MainNav />);
      expect(currentLabels()).toEqual([]);
      unmount();
    }
  });

  it('treats a bare root as the chat page', () => {
    setPath('/');
    render(<MainNav />);
    expect(currentLabels()).toEqual(['Chat']);
  });
});

describe('TerminalPanel path insertion', () => {
  const host = 'http://localhost:9000';

  beforeEach(() => {
    axios.post.mockReset();
  });

  const input = () => screen.getByLabelText(/^command$/i);

  // Regression: the de-duplication used a raw endsWith() on the whole command,
  // so inserting "src/App.jsx" into a command already holding
  // "test/src/App.jsx" was silently dropped while the status line still
  // reported a successful insert.
  it('appends rather than dropping a suffix-sharing path', () => {
    const { rerender } = render(
      <TerminalPanel host={host} pathToInsert="" onPathInserted={() => {}} />
    );
    fireEvent.change(screen.getAllByLabelText(/^command$/i)[0], {
      target: { value: 'test/src/App.jsx' },
    });
    rerender(
      <TerminalPanel host={host} pathToInsert="src/App.jsx" onPathInserted={() => {}} />
    );
    expect(screen.getAllByLabelText(/^command$/i)[0].value).toBe(
      'test/src/App.jsx src/App.jsx',
    );
  });

  it('appends to a non-empty command that has no suffix collision', () => {
    const { rerender } = render(
      <TerminalPanel host={host} pathToInsert="" onPathInserted={() => {}} />
    );
    fireEvent.change(screen.getAllByLabelText(/^command$/i)[0], {
      target: { value: 'cat' },
    });
    rerender(
      <TerminalPanel host={host} pathToInsert="notes.txt" onPathInserted={() => {}} />
    );
    expect(screen.getAllByLabelText(/^command$/i)[0].value).toBe('cat notes.txt');
  });

  it('does not duplicate a path that is already the last token', () => {
    const { rerender } = render(
      <TerminalPanel host={host} pathToInsert="" onPathInserted={() => {}} />
    );
    fireEvent.change(screen.getAllByLabelText(/^command$/i)[0], {
      target: { value: 'cat notes.txt' },
    });
    rerender(
      <TerminalPanel host={host} pathToInsert="notes.txt" onPathInserted={() => {}} />
    );
    expect(screen.getAllByLabelText(/^command$/i)[0].value).toBe('cat notes.txt');
  });

  it('inserts into an empty command field', () => {
    render(<TerminalPanel host={host} pathToInsert="notes.txt" onPathInserted={() => {}} />);
    expect(input().value).toBe('notes.txt');
  });

  it('notifies the parent exactly once per inserted path', async () => {
    const onPathInserted = vi.fn();
    const { rerender } = render(
      <TerminalPanel host={host} pathToInsert="" onPathInserted={onPathInserted} />
    );
    rerender(
      <TerminalPanel host={host} pathToInsert="a.txt" onPathInserted={onPathInserted} />,
    );
    await waitFor(() => expect(onPathInserted).toHaveBeenCalledTimes(1));
  });
});

describe('Header waiting announcement', () => {
  // Regression: two effects both implemented the same 2-second announcement.
  // The second had no cleanup, so its timer survived unmount and could clear
  // the live region of a *later* waiting period, dropping the announcement.
  it('clears every timer it schedules on unmount', () => {
    const clearSpy = vi.spyOn(window, 'clearTimeout');
    const setSpy = vi.spyOn(window, 'setTimeout');
    const { rerender, unmount } = render(
      <Header toggled={false} setToggled={() => {}} waiting={false} />,
    );
    setSpy.mockClear();
    clearSpy.mockClear();

    rerender(<Header toggled={false} setToggled={() => {}} waiting={true} />);
    const scheduled = setSpy.mock.calls.length;
    unmount();
    const cleared = clearSpy.mock.calls.length;

    // One timer scheduled per waiting period, and every one is cleaned up.
    expect(scheduled).toBeGreaterThan(0);
    expect(cleared).toBe(scheduled);
    setSpy.mockRestore();
    clearSpy.mockRestore();
  });

  it('schedules a single timer per waiting transition', () => {
    const setSpy = vi.spyOn(window, 'setTimeout');
    const { rerender } = render(
      <Header toggled={false} setToggled={() => {}} waiting={false} />,
    );
    setSpy.mockClear();
    rerender(<Header toggled={false} setToggled={() => {}} waiting={true} />);
    // The duplicate effect would have scheduled a second identical timer.
    expect(setSpy.mock.calls.length).toBe(1);
    setSpy.mockRestore();
  });

  it('announces while waiting and clears when the response finishes', async () => {
    const { rerender } = render(
      <Header toggled={false} setToggled={() => {}} waiting={false} />,
    );
    rerender(<Header toggled={false} setToggled={() => {}} waiting={true} />);
    await waitFor(() =>
      expect(screen.getByText(/response in progress/i)).toBeInTheDocument(),
    );

    rerender(<Header toggled={false} setToggled={() => {}} waiting={false} />);
    await waitFor(() =>
      expect(screen.queryByText(/response in progress/i)).toBeNull(),
    );
  });
});

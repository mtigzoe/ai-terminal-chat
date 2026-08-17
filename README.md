# AI Terminal Chat

## Table of Contents

- [Project Status](#project-status)
  - [Completed](#completed)
  - [Future Work](#future-work)
- [Testing](#testing)
  - [Frontend tests](#frontend-tests)
  - [Backend tests](#backend-tests)
  - [Accessibility regression tests](#accessibility-regression-tests)
  - [Manual screen-reader testing](#manual-screen-reader-testing)
  - [Accessibility testing limitations](#accessibility-testing-limitations)

## Project Status

### Completed

- [x] Provider ecosystem
- [x] Agent capabilities
- [x] Security and permissions
- [x] Terminal and Git integration
- [x] Local and offline AI
- [x] Initial Electron integration
- [x] Configurable allowed commands
- [x] Accessible expandable/collapsible project tree
- [x] Keyboard navigation and screen-reader support for the project tree
- [x] Project tree expand/collapse controls and focus management
- [x] Project tree filtering and multi-file selection
- [x] Project tree state persistence and workspace-tab persistence
- [x] Project path display and project-tree recovery states
- [x] Automated accessibility regression tests

### Future work

- [ ] Advanced screen-reader support beyond the current project-tree workflows
- [ ] Better integrated project and terminal views
- [ ] Native local-project selection/configuration
- [ ] Accessible desktop workflows that don't depend on browser navigation
- [ ] TypeScript backend
- [ ] Virtualized project tree for very large directories
- [ ] Accessible project-tree context menu
- [ ] Git status badges in the project tree
- [ ] Drag-and-drop file workflows with keyboard alternatives

## Testing

### Frontend tests

The React frontend uses **Vitest** with **@testing-library/react** and **jest-dom**.

```bash
cd client-react
npm test
```

Or run in watch mode:

```bash
cd client-react
npm run test:watch
```

### Backend tests

The Python/Flask backend uses **pytest**.

```bash
cd server-python
uv run pytest tests/ -v
```

### Accessibility regression tests

The frontend test suite includes automated accessibility regression tests covering three layers:

1. **Automated DOM/axe tests** — catch common WCAG/HTML accessibility regressions.
   - `App.a11y.test.jsx` runs `jest-axe` against the full chat app.
2. **Keyboard and focus tests** — verify that key workflows are operable without a mouse.
   - `App.keyboard.a11y.test.jsx` — Enter sends, Shift+Enter inserts a newline, Escape closes dialogs, focus returns to the input after a response.
   - `MessageInput.a11y.test.jsx` — label association, `aria-describedby` help text, Enter/Shift+Enter behavior.
   - `WorkspaceTabs.a11y.test.jsx` — ArrowLeft/ArrowRight, Home, End keyboard navigation; `aria-selected`; tab sequence management.
   - `TerminalPanel.a11y.test.jsx` — `aria-live` output region, `role="status"` for status updates, Enter submission, focus return.
   - `Header.a11y.test.jsx` — `aria-pressed` on the stream toggle, clear-conversation dialog semantics, Escape dismissal.
   - `ConversationDisplayArea.a11y.test.jsx` — message `aria-label`, `aria-busy`, streaming `aria-live="off"`, decorative images.
3. **Live-region and ARIA tests** — verify status announcements.
   - `App.test.jsx` and `App.chat.test.jsx` — agent status region (`aria-live`, `aria-atomic`), error announcements, dialog semantics.

Run only the accessibility tests:

```bash
cd client-react
npx vitest run --reporter=verbose src/*.a11y.test.jsx src/*.a11y.test.jsx
```

### Manual screen-reader testing

Automated tests can verify DOM structure, accessible names, focus, keyboard behavior, and ARIA states, but they cannot fully reproduce how JAWS, NVDA, or Orca interact with the application.

The following behaviors should still be verified manually with a screen reader:

- **Chat messages**: JAWS/NVDA/Orca correctly announces new messages and streaming updates.
- **Agent status**: polite and assertive live-region announcements are heard at the right time.
- **Terminal output**: terminal output is announced as it appears; command results are accessible.
- **Project tree**: treeitem roles are navigable with screen-reader arrow keys; expand/collapse state is announced.
- **Workspace tabs**: tab and tabpanel roles are announced correctly when switching panels.
- **Dialogs**: confirmation dialogs receive focus and are announced; Escape closes them.
- **Settings form**: all form fields are labelled and errors are announced.

### Accessibility testing limitations

- Automated tests use **jsdom**, which does not implement all browser behaviors (for example, default textarea handling of Shift+Enter, native focus behavior inside `setTimeout`, or xterm.js terminal emulation).
- **JAWS/NVDA/Orca-specific behaviors** (virtual cursor, forms mode, browse/read mode) cannot be tested with these tools.
- **xterm.js terminal accessibility** depends on the xterm.js accessibility renderer and cannot be fully tested in jsdom. Terminal keyboard tests verify the surrounding React UI, not xterm.js internals.
- Tests verify that the correct ARIA attributes are present in the DOM; they do not verify that every screen reader interprets them identically.
- Tests do not cover **visual** accessibility (color contrast, font sizing, motion preferences beyond the CSS media query).

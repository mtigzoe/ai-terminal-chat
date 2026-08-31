import React, { useEffect, useState } from 'react';

const STORAGE_KEY = 'ai-terminal-chat:user-instructions';

/**
 * Special instructions the agent should follow on every chat request.
 * Stored in localStorage and sent with /chat and /stream payloads.
 */
export default function InstructionsPage() {
  const [text, setText] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw != null) setText(raw);
    } catch {
      /* ignore */
    }
  }, []);

  const handleSave = (event) => {
    event.preventDefault();
    try {
      localStorage.setItem(STORAGE_KEY, text);
      setStatus('Instructions saved. They will be sent with the next chat messages.');
    } catch {
      setStatus('Could not save instructions in this browser.');
    }
  };

  const handleClear = () => {
    setText('');
    try {
      localStorage.removeItem(STORAGE_KEY);
      setStatus('Instructions cleared.');
    } catch {
      setStatus('Could not clear instructions.');
    }
  };

  return (
    <main className="settings-page" aria-labelledby="instructions-heading">
      <h1 id="instructions-heading">Instructions</h1>
      <p className="settings-help">
        Optional special instructions for the agent (coding style, constraints,
        project conventions). They are stored in this browser and included with
        each chat request.
      </p>
      <form className="settings-form" onSubmit={handleSave}>
        <div className="settings-field">
          <label htmlFor="user-instructions">Instructions text</label>
          <textarea
            id="user-instructions"
            rows={12}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Example: Prefer TypeScript. Never commit secrets. Explain changes briefly."
            spellCheck="true"
            aria-describedby="user-instructions-help"
            style={{ width: '100%', fontFamily: 'inherit' }}
          />
          <p id="user-instructions-help" className="settings-help">
            Leave empty to send no extra instructions.
          </p>
        </div>
        <div className="settings-actions" style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button type="submit">Save instructions</button>
          <button type="button" onClick={handleClear}>
            Clear
          </button>
        </div>
      </form>
      {status ? (
        <p role="status" aria-live="polite" className="settings-help">
          {status}
        </p>
      ) : null}
    </main>
  );
}

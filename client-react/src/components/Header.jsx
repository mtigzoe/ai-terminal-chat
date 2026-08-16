import React, { useEffect, useRef, useState } from 'react';

const Header = ({ toggled, setToggled, waiting }) => {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const cancelRef = useRef(null);

  useEffect(() => {
    if (!confirmOpen) return undefined;
    cancelRef.current?.focus();
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setConfirmOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [confirmOpen]);

  const clearConversation = () => {
    setConfirmOpen(false);
    window.location.assign('/');
  };

  return (
    <header className="chat-header">
      <a className="settings-link" href="/settings.html">
        Settings
      </a>
      <h1>Chat</h1>
      <div className="stream-response-control">
        <span className="toggle-text" id="stream-response-label">
          Stream response
        </span>
        <button
          type="button"
          className={`toggle-btn ${toggled ? "toggled" : ""}`}
          onClick={() => setToggled(!toggled)}
          aria-label={`Stream response ${toggled ? "on" : "off"}`}
          aria-pressed={toggled}
        >
          <span className="toggle-hover" aria-hidden="true">
            <span className="thumb"></span>
            <span className="toggle-hover-text">
              {toggled ? "Streaming response on" : "Streaming response off"}
            </span>
          </span>
        </button>
        <button
          type="button"
          className="clear-conversation-btn"
          onClick={() => setConfirmOpen(true)}
          disabled={waiting}
          aria-label="Clear conversation"
        >
          Clear conversation
        </button>
      </div>

      {confirmOpen && (
        <div
          className="confirmation-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setConfirmOpen(false);
          }}
        >
          <div
            className="confirmation-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="clear-conversation-title"
            aria-describedby="clear-conversation-description"
          >
            <h2 id="clear-conversation-title">Clear conversation?</h2>
            <p id="clear-conversation-description">
              This will remove the current conversation from the chat view.
            </p>
            <div className="confirmation-actions">
              <button type="button" ref={cancelRef} onClick={() => setConfirmOpen(false)}>
                Cancel
              </button>
              <button type="button" onClick={clearConversation}>
                Clear conversation
              </button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
};

export default Header;

import React from 'react';

const Header = ({ toggled, setToggled }) => {
  return (
    <header className="chat-header">
      <h1>Example chat app</h1>
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
      </div>
    </header>
  );
};

export default Header;

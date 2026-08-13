import React from 'react';

const Header = ({ toggled, setToggled }) => {
  const label = toggled ? 'Streaming response On' : 'Streaming response Off';

  return (
    <div className="chat-header">
      <h1>Example chat app</h1>
      <span className="toggle-text" id="stream-response-label">
        Stream Response
      </span>
      <button
        type="button"
        className={`toggle-btn ${toggled ? "toggled" : ""}`}
        onClick={() => setToggled(!toggled)}
        aria-label={label}
        aria-pressed={toggled}
        aria-labelledby="stream-response-label"
      >
        <span className="toggle-hover" aria-hidden="true">
          <span className="thumb"></span>
          <span className="toggle-hover-text">{label}</span>
        </span>
      </button>
    </div>
  );
};

export default Header;

import React from 'react';
import Markdown from 'react-markdown';
import userIcon from '../assets/user-icon.png';
// TODO: Consider replacing chatbotIcon with its own distinct icon.
import chatbotIcon from '../assets/user-icon.png';
import { phaseLabel } from '../agentStatus.js';

/**
 * Visible agent status + ARIA live region for screen readers.
 * One region only; polite by default, assertive for confirm/error.
 * Does not take keyboard focus.
 */
function AgentStatusRegion({ status }) {
  // Single live region: visible status text is what screen readers announce.
  // Avoid nested live regions that can cause duplicate speech.
  if (!status) {
    return (
      <div
        id="agent-status-live"
        className="agent-status-live sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      />
    );
  }

  const live = status.assertive ? 'assertive' : 'polite';
  const label = phaseLabel(status.phase);

  return (
    <div
      id="agent-status-live"
      className={`agent-status agent-status--${status.phase || 'plan'}`}
      role="status"
      aria-live={live}
      aria-atomic="true"
    >
      <span className="agent-status-phase">{label}</span>
      <span className="agent-status-message">{status.message}</span>
    </div>
  );
}

function formatActivityItem(item) {
  if (item.type === 'progress') {
    const label = phaseLabel(item.phase);
    return {
      kind: 'progress',
      text: `${label}: ${item.message || ''}`,
    };
  }

  if (item.type === 'pending_confirmation') {
    const path =
      item.args?.path ||
      item.preview?.path ||
      (Array.isArray(item.preview?.files) ? item.preview.files.join(', ') : null);
    const target = path ? ` (${path})` : '';
    return {
      kind: 'confirm',
      text: `Confirmation required: ${item.name || 'write'}${target}`,
    };
  }

  if (item.type === 'tool_call') {
    const args = item.args ? ` ${JSON.stringify(item.args)}` : '';
    return { kind: 'call', text: `→ ${item.name || 'tool'}${args}` };
  }

  if (item.type === 'tool_result') {
    const resultError = item.result?.error;
    if (resultError) {
      return {
        kind: 'result',
        text: `← ${item.name || 'tool'} — Error: ${resultError}`,
      };
    }
    const truncated = item.result?.truncated === true;
    return {
      kind: 'result',
      text: truncated
        ? `← ${item.name || 'tool'} — Output truncated`
        : `← ${item.name || 'tool'}`,
    };
  }

  return null;
}

function ToolActivity({ activity = [] }) {
  if (!activity.length) return null;

  const items = activity
    .map((item, index) => {
      const formatted = formatActivityItem(item);
      if (!formatted) return null;
      return { ...formatted, key: `${formatted.kind}-${index}` };
    })
    .filter(Boolean);

  if (!items.length) return null;

  return (
    <details className="tool-activity">
      <summary>Agent activity ({items.length})</summary>
      <ul>
        {items.map((item) => (
          <li key={item.key} className={`activity-item activity-item--${item.kind}`}>
            <code>{item.text}</code>
          </li>
        ))}
      </ul>
    </details>
  );
}

const ChatArea = ({
  data,
  streamdiv,
  answer,
  streamToolActivity = [],
  agentStatus = null,
}) => {
  return (
    <div className="chat-area">
      <AgentStatusRegion status={agentStatus} />

      {data?.length <= 0 ? (
        <div className="welcome-area">
          <p className="welcome-1">Hi,</p>
          <p className="welcome-2">How can I help you today?</p>
        </div>
      ) : (
        <div className="welcome-area" style={{ display: 'none' }}></div>
      )}

      {data.map((element, index) => (
        <div key={index} className={element.role}>
          <img
            src={element.role === 'user' ? userIcon : chatbotIcon}
            alt=""
            aria-hidden="true"
          />
          <div>
            {element.role === 'model' && (
              <ToolActivity activity={element.toolActivity} />
            )}
            <p>
              <Markdown>{element.parts[0].text}</Markdown>
            </p>
          </div>
        </div>
      ))}

      {streamdiv && (
        <div className="tempResponse">
          <img src={chatbotIcon} alt="" aria-hidden="true" />
          <div>
            <ToolActivity activity={streamToolActivity} />
            {answer && (
              <p>
                <Markdown>{answer}</Markdown>
              </p>
            )}
          </div>
        </div>
      )}

      <span id="checkpoint"></span>
    </div>
  );
};

export default ChatArea;
export { AgentStatusRegion, ToolActivity };

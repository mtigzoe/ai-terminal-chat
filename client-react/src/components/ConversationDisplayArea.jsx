import React from 'react';
import Markdown from 'react-markdown';
import userIcon from '../assets/user-icon.png';
// TODO: Consider replacing chatbotIcon with its own distinct icon.
import chatbotIcon from '../assets/user-icon.png';
import { phaseLabel } from '../agentStatus.js';

function AgentStatusRegion({ status }) {
  if (!status) {
    return (
      <div id="agent-status-live" className="agent-status-live sr-only" role="status" aria-live="polite" aria-atomic="true" />
    );
  }
  const live = status.assertive ? 'assertive' : 'polite';
  return (
    <div id="agent-status-live" className={`agent-status agent-status--${status.phase || 'plan'}`} role="status" aria-live={live} aria-atomic="true">
      <span className="agent-status-phase">{phaseLabel(status.phase)}</span>
      <span className="agent-status-message">{status.message}</span>
    </div>
  );
}

function formatActivityItem(item) {
  if (item.type === 'progress') return { kind: 'progress', text: `${phaseLabel(item.phase)}: ${item.message || ''}` };
  if (item.type === 'pending_confirmation') {
    const path = item.args?.path || item.preview?.path || (Array.isArray(item.preview?.files) ? item.preview.files.join(', ') : null);
    return { kind: 'confirm', text: `Confirmation required: ${item.name || 'write'}${path ? ` (${path})` : ''}` };
  }
  if (item.type === 'tool_call') return { kind: 'call', text: `${item.name || 'tool'} — running` };
  if (item.type === 'tool_result') {
    const resultError = item.result?.error;
    if (resultError) return { kind: 'result', text: `${item.name || 'tool'} — failed: ${resultError}` };
    return { kind: 'result', text: `${item.name || 'tool'} — completed${item.result?.truncated === true ? ' (output truncated)' : ''}` };
  }
  return null;
}

function ToolActivity({ activity = [] }) {
  const items = activity.map((item, index) => {
    const formatted = formatActivityItem(item);
    return formatted ? { ...formatted, key: `${formatted.kind}-${index}`, details: item } : null;
  }).filter(Boolean);
  if (!items.length) return null;

  return (
    <section className="tool-activity" aria-labelledby="agent-activity-heading">
      <h3 id="agent-activity-heading">Agent activity</h3>
      <ol aria-label="Agent activity items">
        {items.map((item) => (
          <li key={item.key} className={`activity-item activity-item--${item.kind}`}>
            <details>
              <summary>{item.text}</summary>
              {(item.details.args || item.details.result) && (
                <pre aria-label={`${item.details.name || 'Tool'} details`}>
                  {JSON.stringify({ args: item.details.args, result: item.details.result }, null, 2)}
                </pre>
              )}
            </details>
          </li>
        ))}
      </ol>
    </section>
  );
}

const ChatArea = ({ data, streamdiv, answer, streamToolActivity = [], agentStatus = null, waiting = false }) => (
  <main className="chat-area" aria-label="Conversation" aria-busy={waiting}>
    <AgentStatusRegion status={agentStatus} />
    {data?.length <= 0 ? (
      <div className="welcome-area"><p className="welcome-1">Hi,</p><p className="welcome-2">How can I help you today?</p></div>
    ) : null}
    {data.map((element, index) => {
      const isUser = element.role === 'user';
      const messageLabel = isUser ? 'Your message' : 'Assistant message';
      return (
        <article key={index} className={element.role} aria-label={`${messageLabel}, message ${index + 1}`}>
          <img src={isUser ? userIcon : chatbotIcon} alt="" aria-hidden="true" />
          <div>
            {!isUser && <ToolActivity activity={element.toolActivity} />}
            <div className="message-content"><Markdown>{element.parts[0].text}</Markdown></div>
          </div>
        </article>
      );
    })}
    {streamdiv && (
      <article className="tempResponse" aria-label="Assistant response in progress" aria-live="off">
        <img src={chatbotIcon} alt="" aria-hidden="true" />
        <div>
          <ToolActivity activity={streamToolActivity} />
          {answer && <div className="message-content"><Markdown>{answer}</Markdown></div>}
        </div>
      </article>
    )}
    <span id="checkpoint" aria-hidden="true" />
  </main>
);

export default ChatArea;
export { AgentStatusRegion, ToolActivity };

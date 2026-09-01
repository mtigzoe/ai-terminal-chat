import React, { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import userIcon from '../assets/user-icon.png';
// TODO: Consider replacing chatbotIcon with its own distinct icon.
import chatbotIcon from '../assets/user-icon.png';
import { phaseLabel } from '../agentStatus.js';

/**
 * Agent status live region.
 * When status is null the region remains in the DOM (empty) so that subsequent
 * announcements can be forced by clearing then setting content.
 */
function AgentStatusRegion({ status }) {
  const regionRef = useRef(null);
  const lastMessageRef = useRef('');

  useEffect(() => {
    if (!status) {
      lastMessageRef.current = '';
      if (regionRef.current) regionRef.current.textContent = '';
      return;
    }
    const live = status.assertive ? 'assertive' : 'polite';
    const message = `${phaseLabel(status.phase)}. ${status.message || ''}`.trim();
    if (message === lastMessageRef.current) return;
    lastMessageRef.current = message;
    const el = regionRef.current;
    if (!el) return;
    el.setAttribute('aria-live', live);
    // Clear briefly so screen readers re-announce even when the text is similar.
    el.textContent = '';
    const id = window.setTimeout(() => {
      el.textContent = message;
    }, 40);
    return () => window.clearTimeout(id);
  }, [status]);

  if (!status) {
    return (
      <div
        id="agent-status-live"
        ref={regionRef}
        className="agent-status-live sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      />
    );
  }

  const live = status.assertive ? 'assertive' : 'polite';
  return (
    <div
      id="agent-status-live"
      ref={regionRef}
      className={`agent-status agent-status--${status.phase || 'plan'}`}
      role="status"
      aria-live={live}
      aria-atomic="true"
    >
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

/**
 * Legacy activity formatter retained for compatibility with existing imports/tests.
 * The chat UI no longer renders the detailed activity list.
 */
function ToolActivity({ activity = [], announceNew = false }) {
  void activity;
  void announceNew;
  return null;
}

function WorkingStatus({ waiting }) {
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const startedAtRef = useRef(null);

  useEffect(() => {
    if (!waiting) {
      startedAtRef.current = null;
      setElapsedSeconds(0);
      return undefined;
    }

    startedAtRef.current = Date.now();
    setElapsedSeconds(0);
    const timer = window.setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - startedAtRef.current) / 1000));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [waiting]);

  if (!waiting) return null;

  const minutes = Math.floor(elapsedSeconds / 60);
  return (
    <div className="agent-status" role="status" aria-live="polite" aria-atomic="true">
      Working for {minutes} {minutes === 1 ? 'minute' : 'minutes'}
    </div>
  );
}

function CopyResponseButton({ text }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const resetTimerRef = useRef(null);

  useEffect(() => () => {
    if (resetTimerRef.current) window.clearTimeout(resetTimerRef.current);
  }, []);

  const handleCopy = async () => {
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (resetTimerRef.current) window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
      setCopyError(true);
    }
  };

  return (
    <div className="response-actions">
      <button
        type="button"
        className="copy-response-button"
        onClick={handleCopy}
        aria-label={copied ? 'Response copied' : 'Copy response'}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      {copyError && (
        <span className="copy-response-status" role="status" aria-live="polite">
          Unable to copy response.
        </span>
      )}
    </div>
  );
}

const ChatArea = ({ data, streamdiv, answer, streamToolActivity = [], agentStatus = null, waiting = false }) => (
  <main className="chat-area" id="main-conversation" aria-label="Conversation" aria-busy={waiting} tabIndex={-1}>
    <AgentStatusRegion status={agentStatus} />
    <WorkingStatus waiting={waiting} />
    {data?.length <= 0 ? (
      <div className="welcome-area">
        <p className="welcome-1">Hi,</p>
        <p className="welcome-2">How can I help you today?</p>
      </div>
    ) : null}
    {data.map((element, index) => {
      const isUser = element.role === 'user';
      const messageLabel = isUser ? 'Your message' : 'Assistant message';
      const responseText = element.parts?.[0]?.text || '';
      return (
        <article key={index} className={element.role} aria-label={`${messageLabel}, message ${index + 1}`}>
          <img src={isUser ? userIcon : chatbotIcon} alt="" aria-hidden="true" />
          <div>
            {!isUser && <ToolActivity activity={element.toolActivity} />}
            <div className="message-content"><Markdown>{responseText}</Markdown></div>
            {!isUser && responseText && <CopyResponseButton text={responseText} />}
          </div>
        </article>
      );
    })}
    {streamdiv && (
      <article className="tempResponse" aria-label="Assistant response in progress" aria-live="off">
        <img src={chatbotIcon} alt="" aria-hidden="true" />
        <div>
          <ToolActivity activity={streamToolActivity} announceNew />
          {answer && <div className="message-content"><Markdown>{answer}</Markdown></div>}
        </div>
      </article>
    )}
    <span id="checkpoint" aria-hidden="true" />
  </main>
);

export default ChatArea;
export { AgentStatusRegion, ToolActivity, CopyResponseButton, WorkingStatus };

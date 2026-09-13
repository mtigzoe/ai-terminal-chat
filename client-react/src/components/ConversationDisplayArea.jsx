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
  if (!item || typeof item !== 'object') return null;
  if (item.type === 'progress') return { kind: 'progress', text: `${phaseLabel(item.phase)}: ${item.message || ''}` };
  if (item.type === 'pending_confirmation') {
    const path = item.args?.path || item.preview?.path || (Array.isArray(item.preview?.files) ? item.preview.files.join(', ') : null);
    return { kind: 'confirm', text: `Waiting for you to Allow or Decline: ${item.name || 'write'}${path ? ` (${path})` : ''}` };
  }
  if (item.type === 'tool_call') return { kind: 'call', text: `${item.name || 'tool'} — running` };
  if (item.type === 'tool_result') {
    const result = item.result || {};
    if (result.cancelled) {
      return { kind: 'declined', text: `${item.name || 'tool'} — declined: ${result.message || 'Action declined by user.'}` };
    }
    if (result.error) {
      return { kind: 'error', text: `${item.name || 'tool'} — failed: ${result.error}` };
    }
    return { kind: 'result', text: `${item.name || 'tool'} — completed${result.truncated === true ? ' (output truncated)' : ''}` };
  }
  return null;
}

function formatTimestamp(isoString) {
  if (!isoString) return '';
  try {
    const date = new Date(isoString);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

/**
 * Agent activity section: renders a labelled region for each assistant message
 * that has tool activity. The most recent item is summarized using its actual
 * type (in progress, waiting on confirmation, completed, declined, or failed)
 * so the status shown always matches what really happened — it does not get
 * stuck announcing "running" after an action has already been resolved.
 * When showAll is true, renders a list of all activities for screen reader navigation.
 */
function ToolActivity({ activity = [], announceNew = false, showAll = false }) {
  if (!activity || activity.length === 0) return null;
  const latest = activity[activity.length - 1];
  const formatted = formatActivityItem(latest);
  const summary = formatted ? formatted.text : 'Working…';
  const kind = formatted?.kind || 'progress';

  if (!showAll) {
    return (
      <div
        className={`agent-activity agent-activity--${kind}`}
        role="group"
        aria-label="Agent activity"
        data-testid="agent-activity"
      >
        <span className="agent-activity-label">Agent activity:</span>
        <span
          className="agent-activity-summary"
          role="status"
          aria-live={announceNew ? 'polite' : 'off'}
          aria-atomic="true"
        >
          {summary}
        </span>
      </div>
    );
  }

  return (
    <div className="agent-activity agent-activity--complete" role="group" aria-label="Agent activity" data-testid="agent-activity">
      <span className="agent-activity-label">Agent activity:</span>
      <ul className="agent-activity-list" role="list" aria-label="Tool activity history">
        {activity.map((item, idx) => {
          const formatted = formatActivityItem(item);
          const text = formatted ? formatted.text : 'Working…';
          const itemKind = formatted?.kind || 'progress';
          return (
            <li key={idx} className={`agent-activity-item agent-activity-item--${itemKind}`} role="status" aria-live="off" aria-atomic="true">
              {text}
            </li>
          );
        })}
      </ul>
    </div>
  );
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

const ChatArea = ({ data, streamdiv, answer, streamToolActivity = [], agentStatus = null, waiting = false }) => {
  const announcerRef = useRef(null);
  const prevDataLengthRef = useRef(data?.length || 0);
  const prevStreamdivRef = useRef(streamdiv);
  const latestMessageIdRef = useRef(null);

  useEffect(() => {
    const currentDataLength = data?.length || 0;
    const wasStreaming = prevStreamdivRef.current;
    const isStreaming = streamdiv;

    if (currentDataLength > prevDataLengthRef.current) {
      const newMessages = data.slice(prevDataLengthRef.current);
      newMessages.forEach((element, idx) => {
        const isUser = element.role === 'user';
        const messageLabel = isUser ? 'Your message' : 'Assistant message';
        const responseText = element.parts?.[0]?.text || '';
        const truncated = responseText.slice(0, 100) + (responseText.length > 100 ? '…' : '');
        if (announcerRef.current) {
          announcerRef.current.textContent = `${messageLabel}: ${truncated}`;
        }
      });
      latestMessageIdRef.current = currentDataLength - 1;
    } else if (wasStreaming && !isStreaming) {
      const lastMessage = data[data.length - 1];
      if (lastMessage && lastMessage.role === 'model') {
        const responseText = lastMessage.parts?.[0]?.text || '';
        const truncated = responseText.slice(0, 100) + (responseText.length > 100 ? '…' : '');
        if (announcerRef.current) {
          announcerRef.current.textContent = `Assistant response complete: ${truncated}`;
        }
      }
      latestMessageIdRef.current = data.length - 1;
    }

    prevDataLengthRef.current = currentDataLength;
    prevStreamdivRef.current = isStreaming;
  }, [data, streamdiv]);

  const handleSkipToLatest = () => {
    const latestId = latestMessageIdRef.current;
    if (latestId !== null) {
      const el = document.getElementById(`message-${latestId}`);
      el?.focus();
    }
  };

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.altKey && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        handleSkipToLatest();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <main className="chat-area" id="main-conversation" aria-label="Conversation" aria-busy={waiting} tabIndex={-1}>
      <div
        id="conversation-announcer"
        ref={announcerRef}
        className="sr-only"
        aria-live="polite"
        aria-atomic="true"
      />
      <button
        type="button"
        className="skip-link skip-to-latest"
        onClick={handleSkipToLatest}
        aria-label="Jump to latest message (Alt+L)"
      >
        Jump to latest message
      </button>
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
        const timestamp = formatTimestamp(element.timestamp);
        const isLatest = index === data.length - 1;
        return (
          <article
            key={index}
            id={isLatest ? `message-${index}` : undefined}
            className={element.role}
            aria-label={`${messageLabel}, message ${index + 1}${timestamp ? `, sent at ${timestamp}` : ''}`}
            tabIndex={isLatest ? 0 : -1}
          >
            <img src={isUser ? userIcon : chatbotIcon} alt="" aria-hidden="true" />
            <div>
              <h2 className="sr-only">{messageLabel}, message {index + 1}{timestamp ? `, sent at ${timestamp}` : ''}</h2>
              {timestamp && (
                <time className="message-timestamp" dateTime={element.timestamp} aria-label={`Sent at ${timestamp}`}>
                  {timestamp}
                </time>
              )}
              {!isUser && <ToolActivity activity={element.toolActivity} showAll={!streamdiv} />}
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
            <h2 className="sr-only">Assistant response in progress</h2>
            <ToolActivity activity={streamToolActivity} announceNew />
            {answer && <div className="message-content"><Markdown>{answer}</Markdown></div>}
          </div>
        </article>
      )}
      <span id="checkpoint" aria-hidden="true" />
    </main>
  );
};

export default ChatArea;
export { AgentStatusRegion, ToolActivity, CopyResponseButton, WorkingStatus };

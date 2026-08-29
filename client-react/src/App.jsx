import React, { useEffect, useState, useRef } from 'react';
import axios from 'axios';
import { flushSync } from 'react-dom';
import './App.css';

import ConversationDisplayArea from './components/ConversationDisplayArea.jsx';
import Header from './components/Header.jsx';
import MessageInput from './components/MessageInput.jsx';
import ProviderSelector from './components/ProviderSelector.jsx';
import TerminalPanel from './components/TerminalPanel.jsx';
import {
  statusFromProgressEvent,
  statusFromPendingConfirmation,
  statusFromErrorEvent,
  statusFromToolActivity,
  statusFromStreamLine,
  isAgentStatusStreamLine,
} from './agentStatus.js';

function generateRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function ConfirmationDialog({ pending, onResolve, resolving }) {
  const dialogRef = useRef(null);
  const denyRef = useRef(null);
  const allowRef = useRef(null);

  useEffect(() => {
    if (!pending) return undefined;
    denyRef.current?.focus();

    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && !resolving) {
        event.preventDefault();
        onResolve(false);
        return;
      }
      if (event.key === 'Tab') {
        const focusables = [denyRef.current, allowRef.current].filter(Boolean);
        if (focusables.length < 2) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        } else if (!event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [pending, resolving, onResolve]);

  if (!pending) return null;
  const path = pending.args?.path || pending.preview?.path || '';
  const action = pending.name || 'tool operation';
  const previewText = pending.preview?.message || pending.preview?.description || '';
  const descriptionIds = [
    'confirmation-dialog-description',
    previewText ? 'confirmation-dialog-preview' : null,
    'confirmation-dialog-safety',
  ].filter(Boolean).join(' ');

  return (
    <div className="confirmation-backdrop" role="presentation">
      <section
        ref={dialogRef}
        className="confirmation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirmation-dialog-title"
        aria-describedby={descriptionIds}
      >
        <h2 id="confirmation-dialog-title">Confirmation required</h2>
        <p id="confirmation-dialog-description">
          The assistant wants to perform <strong>{action}</strong>
          {path ? <> on <code>{path}</code></> : ''}.
        </p>
        {previewText && <p id="confirmation-dialog-preview">{previewText}</p>}
        <p id="confirmation-dialog-safety">Nothing will be changed unless you choose Allow.</p>
        <div className="confirmation-dialog-actions">
          <button ref={denyRef} type="button" onClick={() => onResolve(false)} disabled={resolving}>
            Deny
          </button>
          <button ref={allowRef} type="button" onClick={() => onResolve(true)} disabled={resolving}>
            {resolving ? 'Processing…' : 'Allow'}
          </button>
        </div>
      </section>
    </div>
  );
}

function App() {
  const inputRef = useRef();
  const abortControllerRef = useRef(null);
  const requestIdRef = useRef(null);
  const host = (import.meta.env.VITE_API_URL || "http://localhost:9000").replace(/\/+$/, "");
  const url = host + "/chat";
  const streamUrl = host + "/stream";
  const [data, setData] = useState([]);
  const [answer, setAnswer] = useState("");
  const [streamdiv, showStreamdiv] = useState(false);
  const [streamToolActivity, setStreamToolActivity] = useState([]);
  const [toggled, setToggled] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [agentStatus, setAgentStatus] = useState(null);
  const [pendingConfirmation, setPendingConfirmation] = useState(null);
  const [confirmationResolving, setConfirmationResolving] = useState(false);
  const [pathForTerminal, setPathForTerminal] = useState(null);
  const [allowedPaths, setAllowedPaths] = useState(() => {
    try {
      const raw = sessionStorage.getItem('ai-terminal-chat:allowed-paths');
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  const is_stream = toggled;

  // Always read the current Project-page selection immediately before sending
  // a request. The Project page persists its selection in sessionStorage, but
  // React state in App can be stale when the user navigates between pages in
  // the same SPA without a window focus/visibility event.
  const resolveAllowedPaths = () => {
    try {
      const raw = sessionStorage.getItem('ai-terminal-chat:allowed-paths');
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  // Re-read allowed paths when the chat page becomes visible again (user may
  // have changed selection on the Project page in another tab/window).
  useEffect(() => {
    const sync = () => {
      try {
        const raw = sessionStorage.getItem('ai-terminal-chat:allowed-paths');
        if (!raw) {
          setAllowedPaths([]);
          return;
        }
        const parsed = JSON.parse(raw);
        setAllowedPaths(Array.isArray(parsed) ? parsed : []);
      } catch {
        setAllowedPaths([]);
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') sync();
    };
    window.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', sync);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  useEffect(() => {
    const regions = ['chat', 'terminal'];

    const focusRegion = (id) => {
      if (id === 'chat') {
        inputRef.current?.focus();
        return;
      }
      if (id === 'terminal') {
        window.setTimeout(() => {
          document.querySelector('[data-focus-target="terminal-input"]')?.focus?.();
        }, 0);
      }
    };

    const onKeyDown = (event) => {
      if (event.key !== 'F6') return;
      event.preventDefault();
      const active = document.activeElement;
      let current = 'chat';
      if (active?.closest?.('[data-focus-region="terminal"]') || active?.getAttribute?.('data-focus-target') === 'terminal-input') {
        current = 'terminal';
      } else if (active === inputRef.current || active?.closest?.('.chat-app')) {
        current = 'chat';
      }
      const index = regions.indexOf(current);
      const nextIndex = event.shiftKey
        ? (index - 1 + regions.length) % regions.length
        : (index + 1) % regions.length;
      focusRegion(regions[nextIndex]);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  function executeScroll() {
    const element = document.getElementById('checkpoint');
    if (element) element.scrollIntoView({ behavior: 'smooth' });
  }
  function validationCheck(str) { return str === null || str.match(/^\s*$/) !== null; }
  function getErrorMessage(error, fallback = "Request failed.") {
    const serverMessage = error?.response?.data?.error;
    if (serverMessage) return serverMessage;
    if (error?.response == null && (error?.message === "Network Error" || error?.code === "ERR_NETWORK" || error?.code === "ECONNABORTED")) {
      const base = (import.meta.env.VITE_API_URL || "http://localhost:9000").replace(/\/$/, "");
      const code = error?.code ? ` (${error.code})` : "";
      const detail = error?.message && error.message !== "Network Error" ? ` ${error.message}` : "";
      return (`Cannot reach the backend at ${base}${code}.${detail} Confirm the backend server is running (for example: npm run dev in server-typescript) and that VITE_API_URL matches its address if you changed the default.`).replace(/\s+/g, " ").trim();
    }
    if (error?.message) return error.message;
    return fallback;
  }
  const cancelBackendRequest = () => {
    const requestId = requestIdRef.current;
    if (!requestId) return;
    fetch(`${host}/cancel/${requestId}`, { method: "POST" }).catch(() => {});
  };
  const stopCurrentRequest = () => {
    cancelBackendRequest();
    abortControllerRef.current?.abort();
    setAgentStatus({ phase: 'cancelled', message: 'Cancelling response.', assertive: false });
  };
  const resolveConfirmation = async (confirmed) => {
    if (!pendingConfirmation || confirmationResolving) return;
    const action = pendingConfirmation;
    setConfirmationResolving(true);
    try {
      const response = await axios.post(`${host}/confirm`, { action_id: action.action_id, confirmed });
      const resultEvent = { type: 'tool_result', name: action.name, result: confirmed ? response.data.result : { cancelled: true, message: 'Action denied by user.' } };
      setStreamToolActivity((current) => [...current, resultEvent]);
      setData((current) => {
        const lastModelIndex = current.map((message) => message.role).lastIndexOf('model');
        if (lastModelIndex === -1) return current;
        return current.map((message, index) => index !== lastModelIndex ? message : { ...message, toolActivity: [...(message.toolActivity || []), resultEvent] });
      });
      setAgentStatus({ phase: confirmed ? 'complete' : 'cancelled', message: confirmed ? 'Action approved and completed.' : 'Action denied by user.', assertive: false });
      setPendingConfirmation(null);
    } catch (error) {
      setAgentStatus({ phase: 'error', message: getErrorMessage(error, 'Could not resolve confirmation.'), assertive: true });
    } finally {
      setConfirmationResolving(false);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  };
  const handleClick = (message) => {
    if (validationCheck(message)) return;
    if (!is_stream) handleNonStreamingChat(message);
    else handleStreamingChat(message);
  };
  const handleNonStreamingChat = async (message) => {
    const requestId = generateRequestId();
    requestIdRef.current = requestId;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const resolvedAllowedPaths = resolveAllowedPaths();
    const chatData = { chat: message, history: data, request_id: requestId, allowed_paths: resolvedAllowedPaths };
    const ndata = [...data, { role: "user", parts: [{ text: message }] }];
    flushSync(() => { setData(ndata); setWaiting(true); setAgentStatus({ phase: 'plan', message: 'Planning next step', assertive: false }); });
    executeScroll();
    const headerConfig = { headers: { 'Content-Type': 'application/json;charset=UTF-8' }, signal: controller.signal };
    const fetchData = async () => {
      let modelResponse = ""; let toolActivity = []; let cancelled = false;
      try {
        const response = await axios.post(url, chatData, headerConfig);
        modelResponse = response.data.text || ""; toolActivity = response.data.tool_activity || []; cancelled = Boolean(response.data.cancelled);
        const pending = toolActivity.find((item) => item.type === 'pending_confirmation');
        if (pending) { setPendingConfirmation(pending); setAgentStatus(statusFromPendingConfirmation(pending) || { phase: 'confirm', message: 'Confirmation required.', assertive: false }); }
        else if (cancelled) { if (!modelResponse.trim()) modelResponse = "[Response stopped by user.]"; setAgentStatus({ phase: 'cancelled', message: 'Response stopped by user.', assertive: false }); }
        else { const status = statusFromToolActivity(toolActivity); if (status) setAgentStatus(status); else if (modelResponse) setAgentStatus({ phase: 'complete', message: 'Response complete.', assertive: false }); }
      } catch (error) {
        if (axios.isCancel(error) || error?.code === "ERR_CANCELED" || error?.name === "CanceledError") { cancelled = true; modelResponse = "[Response stopped by user.]"; setAgentStatus({ phase: 'cancelled', message: 'Response cancelled.', assertive: false }); }
        else { modelResponse = `Error: ${getErrorMessage(error)}`; setAgentStatus({ phase: 'error', message: getErrorMessage(error), assertive: true }); }
      } finally {
        if (abortControllerRef.current === controller) abortControllerRef.current = null;
        requestIdRef.current = null;
        const updatedData = [...ndata, { role: "model", parts: [{ text: modelResponse }], toolActivity }];
        flushSync(() => { setData(updatedData); setWaiting(false); });
        executeScroll();
        window.setTimeout(() => inputRef.current?.focus(), 0);
      }
    };
    fetchData();
  };
  const handleStreamingChat = async (message) => {
    const resolvedAllowedPaths = resolveAllowedPaths();
    const chatData = { chat: message, history: data, allowed_paths: resolvedAllowedPaths };
    const ndata = [...data, { role: "user", parts: [{ text: message }] }];
    flushSync(() => { setData(ndata); setWaiting(true); setAgentStatus({ phase: 'plan', message: 'Planning next step', assertive: false }); });
    executeScroll();
    const headerConfig = { Accept: "application/x-ndjson, text/plain", "Content-Type": "application/json" };
    const fetchStreamData = async () => {
      let modelResponse = ""; let toolActivity = []; let cancelled = false;
      const requestId = generateRequestId(); requestIdRef.current = requestId; chatData.request_id = requestId;
      const controller = new AbortController(); abortControllerRef.current = controller;
      const handleEvent = (event) => { if (!event || typeof event !== "object") return; if (event.type === "progress") { const status = statusFromProgressEvent(event); if (status) setAgentStatus(status); toolActivity.push({ type: "progress", phase: event.phase, message: event.message }); setStreamToolActivity([...toolActivity]); return; } if (event.type === "pending_confirmation") { const status = statusFromPendingConfirmation(event); if (status) setAgentStatus(status); toolActivity.push(event); setStreamToolActivity([...toolActivity]); setPendingConfirmation(event); return; } if (event.type === "text" || event.type === "final") { const text = event.text || ""; modelResponse += text; setAnswer((currentAnswer) => currentAnswer + text); if (event.type === "final") setAgentStatus({ phase: 'complete', message: 'Response complete.', assertive: false }); } else if (event.type === "tool_call" || event.type === "tool_result") { const activity = { type: event.type, name: event.name }; if (event.type === "tool_call") activity.args = event.args || {}; else activity.result = event.result || {}; toolActivity.push(activity); setStreamToolActivity([...toolActivity]); } else if (event.type === "error") { const status = statusFromErrorEvent(event); if (status) setAgentStatus(status); const message = event.message || "Streaming request failed."; modelResponse += `\n[Error: ${message}]`; setAnswer((currentAnswer) => currentAnswer + `\n[Error: ${message}]`); } else if (event.type === "cancelled") { cancelled = true; setAgentStatus({ phase: 'cancelled', message: 'Response cancelled.', assertive: false }); } };
      const handlePlainLine = (line) => { if (isAgentStatusStreamLine(line)) { const status = statusFromStreamLine(line); if (status) setAgentStatus(status); return; } if (line) { modelResponse += line; setAnswer((currentAnswer) => currentAnswer + line); } };
      try {
        const response = await fetch(streamUrl, { method: "POST", headers: headerConfig, body: JSON.stringify(chatData), signal: controller.signal });
        if (!response.ok) { let detail = `HTTP ${response.status}`; try { const payload = await response.json(); if (payload?.error) detail = payload.error; } catch {} throw new Error(detail); }
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Streaming is unavailable in this browser.");
        const decoder = new TextDecoder(); let buffer = "";
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/); buffer = lines.pop() || "";
          for (const line of lines) {
            if (!line) continue;
            try { handleEvent(JSON.parse(line)); } catch { handlePlainLine(line); }
          }
        }
        if (buffer) { try { handleEvent(JSON.parse(buffer)); } catch { handlePlainLine(buffer); } }
        if (cancelled && !modelResponse.trim()) modelResponse = "[Response stopped by user.]";
      } catch (error) {
        if (error?.name === "AbortError") { cancelled = true; if (!modelResponse.trim()) modelResponse = "[Response stopped by user.]"; }
        else { modelResponse += `\nError: ${getErrorMessage(error, 'Streaming request failed.')}`; setAgentStatus({ phase: 'error', message: getErrorMessage(error, 'Streaming request failed.'), assertive: true }); }
      } finally {
        if (abortControllerRef.current === controller) abortControllerRef.current = null;
        requestIdRef.current = null;
        setData((current) => [...current, { role: "model", parts: [{ text: modelResponse }], toolActivity }]);
        setWaiting(false); setAnswer(""); setStreamToolActivity([]); executeScroll(); window.setTimeout(() => inputRef.current?.focus(), 0);
      }
    };
    fetchStreamData();
  };
  return (
    <div className="chat-app">
      <Header />
      <main className="chat-main">
        <ConversationDisplayArea data={data} />
        <MessageInput
          ref={inputRef}
          onSend={handleClick}
          onStop={stopCurrentRequest}
          disabled={waiting}
        />
        <ProviderSelector />
        <TerminalPanel onPathSelected={setPathForTerminal} />
        {streamdiv && <pre className="stream-debug">{answer}</pre>}
        <ConfirmationDialog pending={pendingConfirmation} onResolve={resolveConfirmation} resolving={confirmationResolving} />
      </main>
    </div>
  );
}

export default App;

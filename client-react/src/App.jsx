import React, { useEffect, useState, useRef } from 'react';
import axios from 'axios';
import { flushSync } from 'react-dom';
import './App.css';

import ConversationDisplayArea from './components/ConversationDisplayArea.jsx';
import Header from './components/Header.jsx';
import MessageInput from './components/MessageInput.jsx';
import ProviderSelector from './components/ProviderSelector.jsx';
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
  const cancelRef = useRef(null);

  useEffect(() => {
    if (!pending) return undefined;
    cancelRef.current?.focus();
    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && !resolving) {
        event.preventDefault();
        onResolve(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [pending, resolving, onResolve]);

  if (!pending) return null;

  const path = pending.args?.path || pending.preview?.path || '';
  const action = pending.name || 'tool operation';
  const previewText = pending.preview?.message || pending.preview?.description || '';

  return (
    <div className="confirmation-backdrop" role="presentation">
      <section
        className="confirmation-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirmation-dialog-title"
        aria-describedby="confirmation-dialog-description"
      >
        <h2 id="confirmation-dialog-title">Confirmation required</h2>
        <p id="confirmation-dialog-description">
          The assistant wants to perform <strong>{action}</strong>{path ? <> on <code>{path}</code></> : ''}.
        </p>
        {previewText && <p>{previewText}</p>}
        <p>Nothing will be changed unless you choose Allow.</p>
        <div className="confirmation-dialog-actions">
          <button ref={cancelRef} type="button" onClick={() => onResolve(false)} disabled={resolving}>
            Deny
          </button>
          <button type="button" onClick={() => onResolve(true)} disabled={resolving}>
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
  const host = import.meta.env.VITE_API_URL || "http://localhost:9000";
  const url = host + "/chat";
  const streamUrl = host + "/stream";
  const [data, setData] = useState([]);
  const [answer, setAnswer] = useState("");
  const [streamdiv, showStreamdiv] = useState(false);
  const [streamToolActivity, setStreamToolActivity] = useState([]);
  const [toggled, setToggled] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [agentStatus, setAgentStatus] = useState(null);
  const [projectRoot, setProjectRoot] = useState('');
  const [projectRootError, setProjectRootError] = useState(false);
  const [pendingConfirmation, setPendingConfirmation] = useState(null);
  const [confirmationResolving, setConfirmationResolving] = useState(false);
  const is_stream = toggled;

  useEffect(() => {
    let active = true;
    axios.get(`${host}/project-root`)
      .then((response) => {
        if (!active) return;
        setProjectRoot(response.data.path || '');
        setProjectRootError(false);
      })
      .catch(() => {
        if (!active) return;
        setProjectRoot('');
        setProjectRootError(true);
      });
    return () => { active = false; };
  }, [host]);

  function executeScroll() {
    const element = document.getElementById('checkpoint');
    if (element) element.scrollIntoView({ behavior: 'smooth' });
  }

  function validationCheck(str) { return str === null || str.match(/^\s*$/) !== null; }
  function getErrorMessage(error, fallback = "Request failed.") {
    const serverMessage = error?.response?.data?.error;
    if (serverMessage) return serverMessage;

    // Axios network failures (no HTTP response) are otherwise just "Network Error".
    if (error?.response == null && (error?.message === "Network Error" || error?.code === "ERR_NETWORK" || error?.code === "ECONNABORTED")) {
      const base = (import.meta.env.VITE_API_URL || "http://localhost:9000").replace(/\/$/, "");
      const code = error?.code ? ` (${error.code})` : "";
      const detail = error?.message && error.message !== "Network Error" ? ` ${error.message}` : "";
      return (
        `Cannot reach the backend at ${base}${code}.${detail} ` +
        `Confirm the Flask server is running (for example: python app.py in server-python) ` +
        `and that VITE_API_URL matches its address if you changed the default.`
      ).replace(/\s+/g, " ").trim();
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
      const response = await axios.post(`${host}/confirm`, {
        action_id: action.action_id,
        confirmed,
      });
      const resultEvent = {
        type: 'tool_result',
        name: action.name,
        result: confirmed ? response.data.result : { cancelled: true, message: 'Action denied by user.' },
      };
      setStreamToolActivity((current) => [...current, resultEvent]);
      setData((current) => current.map((message) => {
        if (message.role !== 'model') return message;
        return { ...message, toolActivity: [...(message.toolActivity || []), resultEvent] };
      }));
      setAgentStatus({
        phase: confirmed ? 'complete' : 'cancelled',
        message: confirmed ? 'Action approved and completed.' : 'Action denied by user.',
        assertive: false,
      });
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
    const chatData = { chat: message, history: data, request_id: requestId };
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
        if (pending) {
          setPendingConfirmation(pending);
          setAgentStatus(statusFromPendingConfirmation(pending) || { phase: 'confirm', message: 'Confirmation required.', assertive: false });
        } else if (cancelled) {
          if (!modelResponse.trim()) modelResponse = "[Response stopped by user.]";
          setAgentStatus({ phase: 'cancelled', message: 'Response stopped by user.', assertive: false });
        } else {
          const status = statusFromToolActivity(toolActivity);
          if (status) setAgentStatus(status);
          else if (modelResponse) setAgentStatus({ phase: 'complete', message: 'Response complete.', assertive: false });
        }
      } catch (error) {
        if (axios.isCancel(error) || error?.code === "ERR_CANCELED" || error?.name === "CanceledError") {
          cancelled = true; modelResponse = "[Response stopped by user.]"; setAgentStatus({ phase: 'cancelled', message: 'Response cancelled.', assertive: false });
        } else { modelResponse = `Error: ${getErrorMessage(error)}`; setAgentStatus({ phase: 'error', message: getErrorMessage(error), assertive: true }); }
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
    const chatData = { chat: message, history: data };
    const ndata = [...data, { role: "user", parts: [{ text: message }] }];
    flushSync(() => { setData(ndata); setWaiting(true); setAgentStatus({ phase: 'plan', message: 'Planning next step', assertive: false }); });
    executeScroll();
    const headerConfig = { Accept: "application/x-ndjson, text/plain", "Content-Type": "application/json" };
    const fetchStreamData = async () => {
      let modelResponse = ""; let toolActivity = []; let cancelled = false;
      const requestId = generateRequestId(); requestIdRef.current = requestId; chatData.request_id = requestId;
      const controller = new AbortController(); abortControllerRef.current = controller;
      const handleEvent = (event) => {
        if (!event || typeof event !== "object") return;
        if (event.type === "progress") { const status = statusFromProgressEvent(event); if (status) setAgentStatus(status); toolActivity.push({ type: "progress", phase: event.phase, message: event.message }); setStreamToolActivity([...toolActivity]); return; }
        if (event.type === "pending_confirmation") { const status = statusFromPendingConfirmation(event); if (status) setAgentStatus(status); toolActivity.push(event); setStreamToolActivity([...toolActivity]); setPendingConfirmation(event); return; }
        if (event.type === "text" || event.type === "final") { const text = event.text || ""; modelResponse += text; setAnswer((currentAnswer) => currentAnswer + text); if (event.type === "final") setAgentStatus({ phase: 'complete', message: 'Response complete.', assertive: false }); }
        else if (event.type === "tool_call" || event.type === "tool_result") { const activity = { type: event.type, name: event.name }; if (event.type === "tool_call") activity.args = event.args || {}; else activity.result = event.result || {}; toolActivity.push(activity); setStreamToolActivity([...toolActivity]); }
        else if (event.type === "error") { const status = statusFromErrorEvent(event); if (status) setAgentStatus(status); const message = event.message || "Streaming request failed."; modelResponse += `\n[Error: ${message}]`; setAnswer((currentAnswer) => currentAnswer + `\n[Error: ${message}]`); }
        else if (event.type === "cancelled") { cancelled = true; setAgentStatus({ phase: 'cancelled', message: 'Response cancelled.', assertive: false }); }
      };
      const handlePlainLine = (line) => { if (isAgentStatusStreamLine(line)) { const status = statusFromStreamLine(line); if (status) { setAgentStatus(status); if (status.phase === 'cancelled') cancelled = true; toolActivity.push({ type: 'progress', phase: status.phase, message: status.message }); setStreamToolActivity([...toolActivity]); } return; } modelResponse += line; setAnswer((currentAnswer) => currentAnswer + line); };
      try {
        setAnswer(""); setStreamToolActivity([]); showStreamdiv(true);
        const response = await fetch(streamUrl, { method: "POST", headers: headerConfig, body: JSON.stringify(chatData), signal: controller.signal });
        if (!response.ok || !response.body) { let message = response.statusText || `HTTP ${response.status}`; try { const errorData = await response.json(); message = errorData.error || message; } catch {} throw new Error(message); }
        const reader = response.body.getReader(); const txtdecoder = new TextDecoder(); let buffer = "";
        while (true) { const { value, done } = await reader.read(); if (done) break; buffer += txtdecoder.decode(value, { stream: true }); const lines = buffer.split(/\r?\n/); buffer = lines.pop() || ""; for (const line of lines) { const trimmed = line.trim(); if (!trimmed) continue; try { handleEvent(JSON.parse(trimmed)); } catch { handlePlainLine(line); } } executeScroll(); }
        buffer += txtdecoder.decode(); if (buffer.trim()) { try { handleEvent(JSON.parse(buffer.trim())); } catch { handlePlainLine(buffer); } }
      } catch (err) {
        if (err?.name === "AbortError") { cancelled = true; modelResponse += modelResponse.trim() ? "\n[Streaming stopped by user.]" : "[Streaming stopped by user.]"; setAgentStatus({ phase: 'cancelled', message: 'Response cancelled.', assertive: false }); }
        else { const errorMessage = getErrorMessage(err, "Streaming request failed."); modelResponse = modelResponse ? `${modelResponse}\n[Error: ${errorMessage}]` : `Error: ${errorMessage}`; setAgentStatus({ phase: 'error', message: errorMessage, assertive: true }); }
      } finally {
        if (abortControllerRef.current === controller) abortControllerRef.current = null;
        if (requestIdRef.current === requestId) requestIdRef.current = null;
        setAnswer(""); const updatedData = [...ndata, { role: "model", parts: [{ text: modelResponse || (cancelled ? "[Streaming stopped by user.]" : "") }], toolActivity }];
        flushSync(() => { setData(updatedData); setWaiting(false); }); showStreamdiv(false); setStreamToolActivity([]); executeScroll();
        window.setTimeout(() => inputRef.current?.focus(), 0);
      }
    };
    fetchStreamData();
  };

  return (
    <center>
      <div className="chat-app">
        <Header toggled={toggled} setToggled={setToggled} waiting={waiting} />
        <ProviderSelector host={host} waiting={waiting} />
        <section className="current-project" aria-labelledby="current-project-heading">
          <div>
            <h2 id="current-project-heading">Current project</h2>
            {projectRootError ? (
              <p role="status" aria-live="polite">Unable to determine current project.</p>
            ) : (
              <p>{projectRoot || 'Loading current project…'}</p>
            )}
          </div>
          <a href="/settings.html#settings-project-root">Change project</a>
        </section>
        <ConversationDisplayArea data={data} streamdiv={streamdiv} answer={answer} streamToolActivity={streamToolActivity} agentStatus={agentStatus} waiting={waiting} />
        {waiting && <button type="button" onClick={stopCurrentRequest} aria-label="Cancel response">Cancel response</button>}
        <MessageInput inputRef={inputRef} waiting={waiting} handleClick={handleClick} />
        <ConfirmationDialog pending={pendingConfirmation} onResolve={resolveConfirmation} resolving={confirmationResolving} />
      </div>
    </center>
  );
}

export default App;

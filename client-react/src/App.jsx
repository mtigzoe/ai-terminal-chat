import React, { useCallback, useEffect, useState, useRef } from 'react';
import axios from 'axios';
import { flushSync } from 'react-dom';
import './App.css';

import ConversationDisplayArea from './components/ConversationDisplayArea.jsx';
import Header from './components/Header.jsx';
import MessageInput from './components/MessageInput.jsx';
import ProviderSelector from './components/ProviderSelector.jsx';
import ProjectExplorer from './components/ProjectExplorer.jsx';
import TerminalPanel from './components/TerminalPanel.jsx';
import WorkspaceTabs from './components/WorkspaceTabs.jsx';
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
    // Safer default: focus Deny first so accidental Enter does not approve.
    denyRef.current?.focus();

    const handleKeyDown = (event) => {
      if (event.key === 'Escape' && !resolving) {
        event.preventDefault();
        onResolve(false);
        return;
      }
      // Simple focus trap between the two action buttons.
      if (event.key === 'Tab') {
        const focusables = [denyRef.current, allowRef.current].filter(Boolean);
        if (focusables.length < 2) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) {
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
          <button
            ref={denyRef}
            type="button"
            onClick={() => onResolve(false)}
            disabled={resolving}
          >
            Deny
          </button>
          <button
            ref={allowRef}
            type="button"
            onClick={() => onResolve(true)}
            disabled={resolving}
          >
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

  const refreshProjectRoot = useCallback(() => {
    axios.get(`${host}/project-root`).then((response) => {
      setProjectRoot(response.data.path || '');
      setProjectRootError(false);
    }).catch(() => {
      setProjectRoot('');
      setProjectRootError(true);
    });
  }, [host]);

  useEffect(() => {
    refreshProjectRoot();
  }, [refreshProjectRoot]);

  // Re-read the project root when the window becomes visible again
  // (for example after returning from the Settings page).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') refreshProjectRoot();
    };
    const onFocus = () => refreshProjectRoot();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
    };
  }, [refreshProjectRoot]);

  // F6 / Shift+F6 cycles focus between major regions (desktop-style).
  // Order: message input → project tree → terminal input → …
  const [workspacePanel, setWorkspacePanel] = useState(() => {
    try {
      const stored = localStorage.getItem('workspace-panel');
      return stored === 'terminal' || stored === 'project' ? stored : 'project';
    } catch {
      return 'project';
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('workspace-panel', workspacePanel);
    } catch {
      // ignore
    }
  }, [workspacePanel]);

  useEffect(() => {
    const regions = ['chat', 'project', 'terminal'];

    const focusRegion = (id) => {
      if (id === 'chat') {
        inputRef.current?.focus();
        return;
      }
      if (id === 'project') {
        setWorkspacePanel('project');
        window.setTimeout(() => {
          const tree = document.querySelector('[data-focus-target="project-tree"]');
          const firstItem = tree?.querySelector('[role="treeitem"]');
          (firstItem || tree)?.focus?.();
        }, 0);
        return;
      }
      if (id === 'terminal') {
        setWorkspacePanel('terminal');
        window.setTimeout(() => {
          const input = document.querySelector('[data-focus-target="terminal-input"]');
          input?.focus?.();
        }, 0);
      }
    };

    const onKeyDown = (event) => {
      if (event.key !== 'F6') return;
      event.preventDefault();
      const active = document.activeElement;
      let current = 'chat';
      if (active?.closest?.('[data-focus-region="project"]') || active?.getAttribute?.('data-focus-target') === 'project-tree') {
        current = 'project';
      } else if (active?.closest?.('[data-focus-region="terminal"]') || active?.getAttribute?.('data-focus-target') === 'terminal-input') {
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
      return (`Cannot reach the backend at ${base}${code}.${detail} Confirm the Flask server is running (for example: python app.py in server-python) and that VITE_API_URL matches its address if you changed the default.`).replace(/\s+/g, " ").trim();
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
      setData((current) => current.map((message) => message.role !== 'model' ? message : { ...message, toolActivity: [...(message.toolActivity || []), resultEvent] }));
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
  const handleSelectedFiles = (files) => {
    if (!Array.isArray(files) || files.length === 0) return;
    const fileContext = files.map(({ path, content }) => `\n--- ${path} ---\n${content}\n--- end ${path} ---`).join('\n');
    const message = `I explicitly selected these project files for you to inspect. Use the supplied contents as context for your next response.\n${fileContext}`;
    handleClick(message);
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
    <div style={{ textAlign: 'center' }}>
      {/* Skip links for keyboard and screen-reader navigation */}
      <nav className="skip-links" aria-label="Skip links">
        <a className="skip-link" href="#main-conversation">Skip to conversation</a>
        <a className="skip-link" href="#message-input-region">Skip to message input</a>
        <a className="skip-link" href="#workspace-panels">Skip to project and terminal</a>
      </nav>
      <div className="app-shell">
        <div className="chat-app">
          <Header toggled={toggled} setToggled={setToggled} waiting={waiting} />
          <ProviderSelector host={host} waiting={waiting} />
          <ConversationDisplayArea data={data} streamdiv={streamdiv} answer={answer} streamToolActivity={streamToolActivity} agentStatus={agentStatus} waiting={waiting} />
          {waiting && <button type="button" onClick={stopCurrentRequest}>Cancel response</button>}
          <div id="message-input-region">
            <MessageInput inputRef={inputRef} waiting={waiting} handleClick={handleClick} />
          </div>
          <ConfirmationDialog pending={pendingConfirmation} onResolve={resolveConfirmation} resolving={confirmationResolving} />
        </div>
        <aside id="workspace-panels" className="workspace-panels" aria-label="Project and terminal">
          <section className="current-project" aria-labelledby="current-project-heading">
            <div><h2 id="current-project-heading">Current project</h2>{projectRootError ? <p role="status" aria-live="polite">Unable to determine current project.</p> : <p>{projectRoot || 'Loading current project…'}</p>}</div>
            <a href="/settings.html#settings-project-root">Change project</a>
          </section>
          <WorkspaceTabs
            ariaLabel="Project and terminal"
            activePanelId={workspacePanel}
            onActivePanelChange={setWorkspacePanel}
            panels={[
              { id: 'project', label: 'Project', content: <ProjectExplorer key={projectRoot || 'default'} host={host} projectRoot={projectRoot} onUseSelectedFiles={handleSelectedFiles} /> },
              { id: 'terminal', label: 'Terminal', content: <TerminalPanel host={host} onSendToChat={handleClick} /> },
            ]}
          />
        </aside>
      </div>
    </div>
  );
}

export default App;

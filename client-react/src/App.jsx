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
    allowRef.current?.focus();

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
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        else if (!event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [pending, resolving, onResolve]);

  if (!pending) return null;
  const readPermission = pending.name === 'read_file_permission';
  const path = pending.args?.path || pending.preview?.path || '';
  const action = readPermission ? 'read this file' : (pending.name || 'tool operation');
  const previewText = pending.preview?.message || pending.preview?.description || '';
  const descriptionIds = ['confirmation-dialog-description', previewText ? 'confirmation-dialog-preview' : null, 'confirmation-dialog-safety'].filter(Boolean).join(' ');

  return (
    <div className="confirmation-backdrop" role="presentation">
      <section ref={dialogRef} className="confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="confirmation-dialog-title" aria-describedby={descriptionIds}>
        <h2 id="confirmation-dialog-title">{readPermission ? 'File access requested' : 'Confirmation required'}</h2>
        <p id="confirmation-dialog-description">
          The assistant wants to <strong>{action}</strong>{path ? <>: <code>{path}</code></> : ''}.
        </p>
        {previewText && <p id="confirmation-dialog-preview">{previewText}</p>}
        <p id="confirmation-dialog-safety">
          {readPermission ? 'Allow will add this file to the agent selection on the Project page. Nothing else will be changed.' : 'Nothing will be changed unless you choose Allow.'}
        </p>
        <div className="confirmation-dialog-actions">
          <button ref={denyRef} type="button" onClick={() => onResolve(false)} disabled={resolving}>Decline</button>
          <button ref={allowRef} type="button" onClick={() => onResolve(true)} disabled={resolving}>{resolving ? 'Processing…' : 'Allow'}</button>
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
  const STREAMING_STORAGE_KEY = 'ai-terminal-chat:streaming-enabled';
  const [data, setData] = useState([]);
  const [answer, setAnswer] = useState("");
  const [streamdiv, showStreamdiv] = useState(false);
  const [streamToolActivity, setStreamToolActivity] = useState([]);
  const [toggled, setToggled] = useState(() => {
    try {
      return localStorage.getItem(STREAMING_STORAGE_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const [waiting, setWaiting] = useState(false);
  const [agentStatus, setAgentStatus] = useState(null);
  const [pendingConfirmation, setPendingConfirmation] = useState(null);
  const [confirmationResolving, setConfirmationResolving] = useState(false);
  const confirmingRef = useRef(false);
  const [pathForTerminal, setPathForTerminal] = useState(null);
  const [chatId, setChatId] = useState(() => {
    try { const saved = localStorage.getItem('ai-terminal-chat:current-chat-id'); if (saved) return saved; } catch { /* ignore */ }
    return `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  });
  const [newChatAvailable, setNewChatAvailable] = useState(false);
  const [allowedPaths, setAllowedPaths] = useState(() => {
    try { const raw = localStorage.getItem('ai-terminal-chat:allowed-paths') ?? sessionStorage.getItem('ai-terminal-chat:allowed-paths'); if (!raw) return []; const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  });
  const is_stream = toggled;

  useEffect(() => {
    try {
      localStorage.setItem(STREAMING_STORAGE_KEY, String(toggled));
    } catch {
      // Ignore storage errors; streaming still works for the current page.
    }
  }, [toggled]);

  const resolveAllowedPaths = () => {
    try { const raw = localStorage.getItem('ai-terminal-chat:allowed-paths') ?? sessionStorage.getItem('ai-terminal-chat:allowed-paths'); if (!raw) return []; const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed.filter((p) => typeof p === 'string' && p.trim()) : []; } catch { return []; }
  };
  const CHAT_STORAGE_KEY = 'ai-terminal-chat:chats';
  const isMemoryEnabled = () => { try { const raw = localStorage.getItem('ai-terminal-chat:memory-enabled'); return raw ? raw !== 'false' : true; } catch { return true; } };
  const loadChats = () => { if (!isMemoryEnabled()) return []; try { const raw = localStorage.getItem(CHAT_STORAGE_KEY); if (!raw) return []; const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed : []; } catch { return []; } };
  const saveChats = (chats) => { if (!isMemoryEnabled()) return; try { localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(chats)); } catch {} };
  const saveCurrentChat = (currentData) => { if (!isMemoryEnabled() || !Array.isArray(currentData) || currentData.length === 0) return; const chats = loadChats(); const existingIndex = chats.findIndex((c) => c.id === chatId); const firstUserMessage = currentData.find((m) => m.role === 'user'); const title = firstUserMessage?.parts?.[0]?.text || firstUserMessage?.text || 'Untitled chat'; const trimmedTitle = String(title).trim().slice(0, 80); const chatEntry = { id: chatId, title: trimmedTitle || 'Untitled chat', date: new Date().toISOString(), messages: currentData }; if (existingIndex >= 0) chats[existingIndex] = chatEntry; else chats.unshift(chatEntry); saveChats(chats); setNewChatAvailable(true); };
  const handleNewChat = () => { const newId = `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`; setChatId(newId); try { localStorage.setItem('ai-terminal-chat:current-chat-id', newId); } catch {} setData([]); setAnswer(''); showStreamdiv(false); setStreamToolActivity([]); setAgentStatus(null); setPendingConfirmation(null); setConfirmationResolving(false); setPathForTerminal(null); setWaiting(false); setNewChatAvailable(false); window.setTimeout(() => inputRef.current?.focus(), 0); };
  useEffect(() => { if (data.length === 0) { setNewChatAvailable(false); return; } const timer = window.setTimeout(() => saveCurrentChat(data), 300); return () => window.clearTimeout(timer); }, [data, chatId]);
  useEffect(() => { const sync = () => { try { const raw = localStorage.getItem('ai-terminal-chat:allowed-paths') ?? sessionStorage.getItem('ai-terminal-chat:allowed-paths'); if (!raw) { setAllowedPaths([]); return; } const parsed = JSON.parse(raw); setAllowedPaths(Array.isArray(parsed) ? parsed : []); } catch { setAllowedPaths([]); } }; const onVisible = () => { if (document.visibilityState === 'visible') sync(); }; window.addEventListener('focus', sync); document.addEventListener('visibilitychange', onVisible); const onStorage = (event) => { if (event.key === 'ai-terminal-chat:allowed-paths') sync(); }; window.addEventListener('storage', onStorage); return () => { window.removeEventListener('focus', sync); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('storage', onStorage); }; }, []);
  useEffect(() => { const regions = ['chat', 'terminal']; const focusRegion = (id) => { if (id === 'chat') { inputRef.current?.focus(); return; } if (id === 'terminal') window.setTimeout(() => document.querySelector('[data-focus-target="terminal-input"]')?.focus?.(), 0); }; const onKeyDown = (event) => { if (event.key !== 'F6') return; event.preventDefault(); const active = document.activeElement; let current = 'chat'; if (active?.closest?.('[data-focus-region="terminal"]') || active?.getAttribute?.('data-focus-target') === 'terminal-input') current = 'terminal'; else if (active === inputRef.current || active?.closest?.('.chat-app')) current = 'chat'; const index = regions.indexOf(current); const nextIndex = event.shiftKey ? (index - 1 + regions.length) % regions.length : (index + 1) % regions.length; focusRegion(regions[nextIndex]); }; window.addEventListener('keydown', onKeyDown); return () => window.removeEventListener('keydown', onKeyDown); }, []);

  function executeScroll() { const element = document.getElementById('checkpoint'); if (element) element.scrollIntoView({ behavior: 'smooth' }); }
  function validationCheck(str) { return str === null || str.match(/^\s*$/) !== null; }
  function getErrorMessage(error, fallback = "Request failed.") { const serverMessage = error?.response?.data?.error; if (serverMessage) return serverMessage; if (error?.response == null && (error?.message === "Network Error" || error?.code === "ERR_NETWORK" || error?.code === "ECONNABORTED")) { const base = (import.meta.env.VITE_API_URL || "http://localhost:9000").replace(/\/$/, ""); const code = error?.code ? ` (${error.code})` : ""; const detail = error?.message && error.message !== "Network Error" ? ` ${error.message}` : ""; return (`Cannot reach the backend at ${base}${code}.${detail} Confirm the backend server is running (for example: npm run dev in server-typescript) and that VITE_API_URL matches its address if you changed the default.`).replace(/\s+/g, " ").trim(); } if (error?.message) return error.message; return fallback; }
  const cancelBackendRequest = () => { const requestId = requestIdRef.current; if (!requestId) return; fetch(`${host}/cancel/${requestId}`, { method: "POST" }).catch(() => {}); };
  const stopCurrentRequest = () => { cancelBackendRequest(); abortControllerRef.current?.abort(); setAgentStatus({ phase: 'cancelled', message: 'Cancelling response.', assertive: false }); };

  const resolveConfirmation = async (confirmed) => {
    if (!pendingConfirmation || confirmingRef.current) return;
    const action = pendingConfirmation;
    confirmingRef.current = true;
    setConfirmationResolving(true);
    try {
      const response = await axios.post(`${host}/confirm`, { action_id: action.action_id, confirmed });
      const permissionGranted = action.name === 'read_file_permission' && confirmed === true && response.data?.permission_granted === true;
      if (permissionGranted) {
        const path = action.args?.path;
        if (typeof path === 'string' && path.trim()) {
          const paths = Array.from(new Set([...resolveAllowedPaths(), path.trim()]));
          setAllowedPaths(paths);
          try { localStorage.setItem('ai-terminal-chat:allowed-paths', JSON.stringify(paths)); } catch {}
          window.dispatchEvent(new CustomEvent('ai-terminal-chat:allowed-paths-changed', { detail: { paths } }));
        }
      }

      const resumed = Array.isArray(response.data?.tool_activity);
      const newActivityItems = resumed
        ? response.data.tool_activity
        : [{ type: 'tool_result', name: action.name, result: confirmed ? response.data.result : { cancelled: true, message: 'Action declined by user.' } }];
      const nextPending = resumed ? response.data.pending_confirmation || null : null;
      const finalText = resumed ? (response.data.text || '') : '';

      setStreamToolActivity((current) => [...current, ...newActivityItems]);
      setData((current) => {
        const lastModelIndex = current.map((message) => message.role).lastIndexOf('model');
        if (lastModelIndex === -1) return current;
        return current.map((message, index) => {
          if (index !== lastModelIndex) return message;
          const updated = { ...message, toolActivity: [...(message.toolActivity || []), ...newActivityItems] };
          if (finalText) {
            const priorText = message.parts?.[0]?.text || '';
            updated.parts = [{ text: priorText ? `${priorText}\n\n${finalText}` : finalText }];
          }
          return updated;
        });
      });

      if (nextPending) {
        setPendingConfirmation(nextPending);
        setAgentStatus(statusFromPendingConfirmation(nextPending) || { phase: 'confirm', message: 'Confirmation required.', assertive: false });
      } else {
        setPendingConfirmation(null);
        if (resumed && response.data?.cancelled && !confirmed) {
          setAgentStatus({ phase: 'cancelled', message: 'Action declined by user.', assertive: false });
        } else if (resumed && response.data?.error && !finalText) {
          setAgentStatus({ phase: 'error', message: response.data.error, assertive: true });
        } else {
          setAgentStatus({
            phase: confirmed ? 'complete' : 'cancelled',
            message: permissionGranted
              ? `Read access granted for ${action.args?.path || 'the file'}. It is now selected on the Project page.`
              : (confirmed ? 'Action approved and completed.' : 'Action declined by user.'),
            assertive: false,
          });
        }
      }
    } catch (error) {
      setAgentStatus({ phase: 'error', message: getErrorMessage(error, 'Could not resolve confirmation.'), assertive: true });
    } finally {
      confirmingRef.current = false;
      setConfirmationResolving(false);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  };

  const handleClick = (message) => { if (validationCheck(message)) return; if (!is_stream) handleNonStreamingChat(message); else handleStreamingChat(message); };
  const handleNonStreamingChat = async (message) => { const requestId = generateRequestId(); requestIdRef.current = requestId; const controller = new AbortController(); abortControllerRef.current = controller; const resolvedAllowedPaths = resolveAllowedPaths(); const chatData = { chat: message, history: data, request_id: requestId, allowed_paths: resolvedAllowedPaths ?? [] }; const ndata = [...data, { role: "user", parts: [{ text: message }] }]; flushSync(() => { setData(ndata); setWaiting(true); setAgentStatus({ phase: 'plan', message: 'Planning next step', assertive: false }); }); executeScroll(); const headerConfig = { headers: { 'Content-Type': 'application/json;charset=UTF-8' }, signal: controller.signal }; const fetchData = async () => { let modelResponse = ""; let toolActivity = []; let cancelled = false; try { const response = await axios.post(url, chatData, headerConfig); modelResponse = response.data.text || ""; toolActivity = response.data.tool_activity || []; cancelled = Boolean(response.data.cancelled); const pending = toolActivity.find((item) => item.type === 'pending_confirmation'); if (pending) { setPendingConfirmation(pending); setAgentStatus(statusFromPendingConfirmation(pending) || { phase: 'confirm', message: 'Confirmation required.', assertive: false }); } else if (cancelled) { if (!modelResponse.trim()) modelResponse = "[Response stopped by user.]"; setAgentStatus({ phase: 'cancelled', message: 'Response stopped by user.', assertive: false }); } else { const status = statusFromToolActivity(toolActivity); if (status) setAgentStatus(status); else if (modelResponse) setAgentStatus({ phase: 'complete', message: 'Response complete.', assertive: false }); } } catch (error) { if (axios.isCancel(error) || error?.code === "ERR_CANCELED" || error?.name === "CanceledError") { cancelled = true; modelResponse = "[Response stopped by user.]"; setAgentStatus({ phase: 'cancelled', message: 'Response cancelled.', assertive: false }); } else { modelResponse = `Error: ${getErrorMessage(error)}`; setAgentStatus({ phase: 'error', message: getErrorMessage(error), assertive: true }); } } finally { if (abortControllerRef.current === controller) abortControllerRef.current = null; requestIdRef.current = null; const updatedData = [...ndata, { role: "model", parts: [{ text: modelResponse }], toolActivity }]; flushSync(() => { setData(updatedData); setWaiting(false); }); executeScroll(); window.setTimeout(() => inputRef.current?.focus(), 0); } }; fetchData(); };
  const handleStreamingChat = async (message) => { const resolvedAllowedPaths = resolveAllowedPaths(); const chatData = { chat: message, history: data, allowed_paths: resolvedAllowedPaths ?? [] }; const ndata = [...data, { role: "user", parts: [{ text: message }] }]; flushSync(() => { setData(ndata); setWaiting(true); setAgentStatus({ phase: 'plan', message: 'Planning next step', assertive: false }); }); executeScroll(); const headerConfig = { Accept: "application/x-ndjson, text/plain", "Content-Type": "application/json" }; const fetchStreamData = async () => { let modelResponse = ""; let toolActivity = []; let cancelled = false; const requestId = generateRequestId(); requestIdRef.current = requestId; chatData.request_id = requestId; const controller = new AbortController(); abortControllerRef.current = controller; const handleEvent = (event) => { if (!event || typeof event !== "object") return; if (event.type === "progress") { const status = statusFromProgressEvent(event); if (status) setAgentStatus(status); toolActivity.push({ type: "progress", phase: event.phase, message: event.message }); setStreamToolActivity([...toolActivity]); return; } if (event.type === "pending_confirmation") { const status = statusFromPendingConfirmation(event); if (status) setAgentStatus(status); toolActivity.push(event); setStreamToolActivity([...toolActivity]); setPendingConfirmation(event); return; } if (event.type === "text" || event.type === "final") { const text = event.text || ""; modelResponse += text; setAnswer((currentAnswer) => currentAnswer + text); if (event.type === "final") setAgentStatus({ phase: 'complete', message: 'Response complete.', assertive: false }); } else if (event.type === "tool_call" || event.type === "tool_result") { const activity = { type: event.type, name: event.name }; if (event.type === "tool_call") activity.args = event.args || {}; else activity.result = event.result || {}; toolActivity.push(activity); setStreamToolActivity([...toolActivity]); } else if (event.type === "error") { const status = statusFromErrorEvent(event); if (status) setAgentStatus(status); const message = event.message || "Streaming request failed."; modelResponse += `\n[Error: ${message}]`; setAnswer((currentAnswer) => currentAnswer + `\n[Error: ${message}]`); } else if (event.type === "cancelled") { cancelled = true; setAgentStatus({ phase: 'cancelled', message: 'Response cancelled.', assertive: false }); } }; const handlePlainLine = (line) => { if (isAgentStatusStreamLine(line)) { const status = statusFromStreamLine(line); if (status) { setAgentStatus(status); if (status.phase === 'cancelled') cancelled = true; toolActivity.push({ type: "progress", phase: status.phase, message: status.message }); setStreamToolActivity([...toolActivity]); } return; } modelResponse += line; setAnswer((currentAnswer) => currentAnswer + line); }; try { setAnswer(""); setStreamToolActivity([]); showStreamdiv(true); const response = await fetch(streamUrl, { method: "POST", headers: headerConfig, body: JSON.stringify(chatData), signal: controller.signal }); if (!response.ok || !response.body) { let message = response.statusText || `HTTP ${response.status}`; try { const errorData = await response.json(); message = errorData.error || message; } catch {} throw new Error(message); } const reader = response.body.getReader(); const txtdecoder = new TextDecoder(); let buffer = ""; while (true) { const { value, done } = await reader.read(); if (done) break; buffer += txtdecoder.decode(value, { stream: true }); const lines = buffer.split(/\r?\n/); buffer = lines.pop() || ""; for (const line of lines) { const trimmed = line.trim(); if (!trimmed) continue; try { handleEvent(JSON.parse(trimmed)); } catch { handlePlainLine(line); } } executeScroll(); } buffer += txtdecoder.decode(); if (buffer.trim()) { try { handleEvent(JSON.parse(buffer.trim())); } catch { handlePlainLine(buffer); } } } catch (err) { if (err?.name === "AbortError") { cancelled = true; modelResponse += modelResponse.trim() ? "\n[Streaming stopped by user.]" : "[Streaming stopped by user.]"; setAgentStatus({ phase: 'cancelled', message: 'Response cancelled.', assertive: false }); } else { const errorMessage = getErrorMessage(err, "Streaming request failed."); modelResponse = modelResponse ? `${modelResponse}\n[Error: ${errorMessage}]` : `Error: ${errorMessage}`; setAgentStatus({ phase: 'error', message: errorMessage, assertive: true }); } } finally { if (abortControllerRef.current === controller) abortControllerRef.current = null; if (requestIdRef.current === requestId) requestIdRef.current = null; setAnswer(""); const updatedData = [...ndata, { role: "model", parts: [{ text: modelResponse || (cancelled ? "[Streaming stopped by user.]" : "") }], toolActivity }]; flushSync(() => { setData(updatedData); setWaiting(false); }); showStreamdiv(false); setStreamToolActivity([]); executeScroll(); window.setTimeout(() => inputRef.current?.focus(), 0); } }; fetchStreamData(); };

  useEffect(() => { let pendingFiles = null; let pendingPath = null; let restoreChatId = null; try { const rawFiles = localStorage.getItem('ai-terminal-chat:pending-files'); if (rawFiles) { pendingFiles = JSON.parse(rawFiles); localStorage.removeItem('ai-terminal-chat:pending-files'); } const rawPath = localStorage.getItem('ai-terminal-chat:pending-terminal-path'); if (rawPath) { pendingPath = rawPath; localStorage.removeItem('ai-terminal-chat:pending-terminal-path'); } const rawRestore = localStorage.getItem('ai-terminal-chat:restore-chat-id'); if (rawRestore) { restoreChatId = rawRestore; localStorage.removeItem('ai-terminal-chat:restore-chat-id'); } } catch {} if (restoreChatId) { try { const rawChats = localStorage.getItem(CHAT_STORAGE_KEY); const chats = rawChats ? JSON.parse(rawChats) : []; const chat = Array.isArray(chats) ? chats.find((c) => c.id === restoreChatId) : null; if (chat && Array.isArray(chat.messages)) { setChatId(chat.id); try { localStorage.setItem('ai-terminal-chat:current-chat-id', chat.id); } catch {} setData(chat.messages); setNewChatAvailable(true); } } catch {} } if (Array.isArray(pendingFiles)) { const paths = pendingFiles.map(({ path }) => path).filter(Boolean); setAllowedPaths(paths); try { localStorage.setItem('ai-terminal-chat:allowed-paths', JSON.stringify(paths)); } catch {} if (pendingFiles.length > 0) { const fileContext = pendingFiles.map(({ path, content }) => `\n--- ${path} ---\n${content}\n--- end ${path} ---`).join('\n'); const message = `I explicitly selected these project files for you to inspect. Use the supplied contents as context for your next response.\n${fileContext}`; window.setTimeout(() => handleClick(message), 0); } } if (pendingPath) setPathForTerminal(pendingPath); }, []);

  return (<div style={{ textAlign: 'center' }}><nav className="skip-links" aria-label="Skip links"><a className="skip-link" href="#main-conversation">Skip to conversation</a><a className="skip-link" href="#message-input-region">Skip to message input</a><a className="skip-link" href="#terminal-region">Skip to terminal</a></nav><div className="app-shell"><div className="chat-app" data-focus-region="chat"><Header toggled={toggled} setToggled={setToggled} waiting={waiting} /><ProviderSelector host={host} waiting={waiting} />{newChatAvailable && <div className="new-chat-link-wrapper"><a href="./index.html" className="new-chat-link" onClick={(event) => { event.preventDefault(); handleNewChat(); }}>New chat</a></div>}<ConversationDisplayArea data={data} streamdiv={streamdiv} answer={answer} streamToolActivity={streamToolActivity} agentStatus={agentStatus} waiting={waiting} />{waiting && <button type="button" onClick={stopCurrentRequest}>Cancel response</button>}<div id="message-input-region"><MessageInput inputRef={inputRef} waiting={waiting} pendingConfirmation={Boolean(pendingConfirmation)} handleClick={handleClick} /></div><ConfirmationDialog pending={pendingConfirmation} onResolve={resolveConfirmation} resolving={confirmationResolving} /></div><aside id="workspace-panels" className="workspace-panels" aria-label="Terminal"><div id="terminal-region" className="workspace-region" data-focus-region="terminal" aria-labelledby="terminal-panel-heading"><TerminalPanel host={host} onSendToChat={handleClick} pathToInsert={pathForTerminal} onPathInserted={() => setPathForTerminal(null)} /></div></aside></div></div>);
}

export default App;

/**
 * @license
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import React, { useState, useRef } from 'react';
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
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
  /** Current agent lifecycle status for UI + screen-reader live region. */
  const [agentStatus, setAgentStatus] = useState(null);
  const is_stream = toggled;

  function executeScroll() {
    const element = document.getElementById('checkpoint');
    if (element) {
      element.scrollIntoView({ behavior: 'smooth' });
    }
  }

  function validationCheck(str) {
    return str === null || str.match(/^\s*$/) !== null;
  }

  function getErrorMessage(error, fallback = "Request failed.") {
    const serverMessage = error?.response?.data?.error;
    if (serverMessage) return serverMessage;
    if (error?.message) return error.message;
    return fallback;
  }

  /**
   * Best-effort backend cancellation. Aborting the fetch/axios request
   * only stops this browser tab from reading the response — the Flask
   * process keeps running the agent loop unless it's told to stop.
   * This tells run_agent_loop (via cancellation.py) to check its
   * cancel_event and stop between rounds/tool calls instead.
   */
  const cancelBackendRequest = () => {
    const requestId = requestIdRef.current;
    if (!requestId) return;
    fetch(`${host}/cancel/${requestId}`, { method: "POST" }).catch(() => {
      // Best-effort: the client-side abort below still applies either way.
    });
  };

  const stopCurrentRequest = () => {
    cancelBackendRequest();
    abortControllerRef.current?.abort();
  };

  const handleClick = () => {
    if (validationCheck(inputRef.current.value)) {
      console.log("Empty or invalid entry");
    } else if (!is_stream) {
      handleNonStreamingChat();
    } else {
      handleStreamingChat();
    }
  };

  const handleNonStreamingChat = async () => {
    const requestId = generateRequestId();
    requestIdRef.current = requestId;
    const controller = new AbortController();
    abortControllerRef.current = controller;

    const chatData = {
      chat: inputRef.current.value,
      history: data,
      request_id: requestId,
    };

    const ndata = [...data,
      { role: "user", parts: [{ text: inputRef.current.value }] }];

    flushSync(() => {
      setData(ndata);
      inputRef.current.value = "";
      inputRef.current.placeholder = "Waiting for model's response";
      setWaiting(true);
      setAgentStatus({
        phase: 'plan',
        message: 'Planning next step',
        assertive: false,
      });
    });

    executeScroll();

    const headerConfig = {
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
      },
      signal: controller.signal,
    };

    const fetchData = async () => {
      let modelResponse = "";
      let toolActivity = [];
      let cancelled = false;

      try {
        const response = await axios.post(url, chatData, headerConfig);
        modelResponse = response.data.text || "";
        toolActivity = response.data.tool_activity || [];
        cancelled = Boolean(response.data.cancelled);

        if (cancelled) {
          if (!modelResponse.trim()) {
            modelResponse = "[Response stopped by user.]";
          }
          setAgentStatus({
            phase: 'complete',
            message: 'Stopped by user',
            assertive: false,
          });
        } else {
          const status = statusFromToolActivity(toolActivity);
          if (status) {
            setAgentStatus(status);
          } else if (modelResponse) {
            setAgentStatus({
              phase: 'complete',
              message: 'Task completed',
              assertive: false,
            });
          }
        }
      } catch (error) {
        if (axios.isCancel(error) || error?.code === "ERR_CANCELED" || error?.name === "CanceledError") {
          cancelled = true;
          modelResponse = "[Response stopped by user.]";
          setAgentStatus({
            phase: 'complete',
            message: 'Stopped by user',
            assertive: false,
          });
        } else {
          modelResponse = `Error: ${getErrorMessage(error)}`;
          setAgentStatus({
            phase: 'error',
            message: getErrorMessage(error),
            assertive: true,
          });
        }
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
        requestIdRef.current = null;

        const updatedData = [...ndata, {
          role: "model",
          parts: [{ text: modelResponse }],
          toolActivity
        }];

        flushSync(() => {
          setData(updatedData);
          inputRef.current.placeholder = "Enter a message.";
          setWaiting(false);
        });
        executeScroll();
      }
    };

    fetchData();
  };

  const handleStreamingChat = async () => {
    const chatData = {
      chat: inputRef.current.value,
      history: data
    };

    const ndata = [...data,
      { role: "user", parts: [{ text: inputRef.current.value }] }];

    flushSync(() => {
      setData(ndata);
      inputRef.current.value = "";
      inputRef.current.placeholder = "Waiting for model's response";
      setWaiting(true);
      setAgentStatus({
        phase: 'plan',
        message: 'Planning next step',
        assertive: false,
      });
    });

    executeScroll();

    const headerConfig = {
      Accept: "application/x-ndjson, text/plain",
      "Content-Type": "application/json",
    };

    const fetchStreamData = async () => {
      let modelResponse = "";
      let toolActivity = [];
      let cancelled = false;
      const requestId = generateRequestId();
      requestIdRef.current = requestId;
      chatData.request_id = requestId;
      const controller = new AbortController();
      abortControllerRef.current = controller;

      const handleEvent = (event) => {
        if (!event || typeof event !== "object") return;

        if (event.type === "progress") {
          const status = statusFromProgressEvent(event);
          if (status) setAgentStatus(status);
          toolActivity.push({
            type: "progress",
            phase: event.phase,
            message: event.message,
          });
          setStreamToolActivity([...toolActivity]);
          return;
        }

        if (event.type === "pending_confirmation") {
          const status = statusFromPendingConfirmation(event);
          if (status) setAgentStatus(status);
          toolActivity.push(event);
          setStreamToolActivity([...toolActivity]);
          return;
        }

        if (event.type === "text" || event.type === "final") {
          const text = event.text || "";
          modelResponse += text;
          setAnswer((currentAnswer) => currentAnswer + text);
          if (event.type === "final") {
            setAgentStatus({
              phase: 'complete',
              message: 'Task completed',
              assertive: false,
            });
          }
        } else if (event.type === "tool_call" || event.type === "tool_result") {
          const activity = {
            type: event.type,
            name: event.name,
          };
          if (event.type === "tool_call") {
            activity.args = event.args || {};
          } else {
            activity.result = event.result || {};
          }
          toolActivity.push(activity);
          setStreamToolActivity([...toolActivity]);
        } else if (event.type === "error") {
          const status = statusFromErrorEvent(event);
          if (status) setAgentStatus(status);
          const message = event.message || "Streaming request failed.";
          modelResponse += `\n[Error: ${message}]`;
          setAnswer((currentAnswer) => currentAnswer + `\n[Error: ${message}]`);
        } else if (event.type === "cancelled") {
          cancelled = true;
          setAgentStatus({
            phase: 'cancelled',
            message: 'Cancelled by user request.',
            assertive: false,
          });
        }
      };

      /**
       * Handle a plain-text stream line from the current backend.
       * Agent status lines update the live region; chat text goes to the answer.
       */
      const handlePlainLine = (line) => {
        if (isAgentStatusStreamLine(line)) {
          const status = statusFromStreamLine(line);
          if (status) {
            setAgentStatus(status);
            if (status.phase === 'cancelled') {
              cancelled = true;
            }
            toolActivity.push({
              type: 'progress',
              phase: status.phase,
              message: status.message,
            });
            setStreamToolActivity([...toolActivity]);
          }
          return;
        }

        modelResponse += line;
        setAnswer((currentAnswer) => currentAnswer + line);
      };

      try {
        setAnswer("");
        setStreamToolActivity([]);
        showStreamdiv(true);

        const response = await fetch(streamUrl, {
          method: "POST",
          headers: headerConfig,
          body: JSON.stringify(chatData),
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          let message = response.statusText || `HTTP ${response.status}`;
          try {
            const errorData = await response.json();
            message = errorData.error || message;
          } catch {
            // The server may have returned plain text instead of JSON.
          }
          throw new Error(message);
        }

        const reader = response.body.getReader();
        const txtdecoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += txtdecoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            // Prefer structured NDJSON when present; otherwise plain text.
            try {
              handleEvent(JSON.parse(trimmed));
            } catch {
              handlePlainLine(line);
            }
          }

          executeScroll();
        }

        buffer += txtdecoder.decode();
        if (buffer.trim()) {
          try {
            handleEvent(JSON.parse(buffer.trim()));
          } catch {
            handlePlainLine(buffer);
          }
        }

      } catch (err) {
        if (err?.name === "AbortError") {
          cancelled = true;
          if (!modelResponse.trim()) {
            modelResponse = "[Streaming stopped by user.]";
          } else {
            modelResponse += "\n[Streaming stopped by user.]";
          }
          setAgentStatus({
            phase: 'complete',
            message: 'Streaming stopped by user',
            assertive: false,
          });
        } else {
          const message = err?.message || "Streaming request failed.";
          modelResponse = modelResponse
            ? `${modelResponse}\n[Error: ${message}]`
            : `Error: ${message}`;
          setAgentStatus({
            phase: 'error',
            message,
            assertive: true,
          });
        }
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
        if (requestIdRef.current === requestId) {
          requestIdRef.current = null;
        }

        setAnswer("");
        const updatedData = [...ndata, {
          role: "model",
          parts: [{ text: modelResponse || (cancelled ? "[Streaming stopped by user.]" : "") }],
          toolActivity
        }];

        flushSync(() => {
          setData(updatedData);
          inputRef.current.placeholder = "Enter a message.";
          setWaiting(false);
        });
        showStreamdiv(false);
        setStreamToolActivity([]);
        executeScroll();
      }
    };

    fetchStreamData();
  };

  return (
    <center>
      <div className="chat-app">
        <Header toggled={toggled} setToggled={setToggled} />
        <ProviderSelector host={host} waiting={waiting} />
        <ConversationDisplayArea
          data={data}
          streamdiv={streamdiv}
          answer={answer}
          streamToolActivity={streamToolActivity}
          agentStatus={agentStatus}
          waiting={waiting}
        />
        {waiting && (
          <button
            type="button"
            onClick={stopCurrentRequest}
            aria-label="Cancel response"
          >
            Cancel response
          </button>
        )}
        <MessageInput inputRef={inputRef} waiting={waiting} handleClick={handleClick} />
      </div>
    </center>
  );
}

export default App;

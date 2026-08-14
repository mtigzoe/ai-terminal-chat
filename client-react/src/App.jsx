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

function App() {
  const inputRef = useRef();
  const abortControllerRef = useRef(null);
  const host = import.meta.env.VITE_API_URL || "http://localhost:9000";
  const url = host + "/chat";
  const streamUrl = host + "/stream";
  const [data, setData] = useState([]);
  const [answer, setAnswer] = useState("");
  const [streamdiv, showStreamdiv] = useState(false);
  const [streamToolActivity, setStreamToolActivity] = useState([]);
  const [toggled, setToggled] = useState(false);
  const [waiting, setWaiting] = useState(false);
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
    });

    executeScroll();

    const headerConfig = {
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
      }
    };

    const fetchData = async () => {
      let modelResponse = "";
      let toolActivity = [];

      try {
        const response = await axios.post(url, chatData, headerConfig);
        modelResponse = response.data.text || "";
        toolActivity = response.data.tool_activity || [];
      } catch (error) {
        modelResponse = `Error: ${getErrorMessage(error)}`;
      } finally {
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

  const stopStreaming = () => {
    abortControllerRef.current?.abort();
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
      const controller = new AbortController();
      abortControllerRef.current = controller;

      const handleEvent = (event) => {
        if (!event || typeof event !== "object") return;

        if (event.type === "text" || event.type === "final") {
          const text = event.text || "";
          modelResponse += text;
          setAnswer((currentAnswer) => currentAnswer + text);
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
          const message = event.message || "Streaming request failed.";
          modelResponse += `\n[Error: ${message}]`;
          setAnswer((currentAnswer) => currentAnswer + `\n[Error: ${message}]`);
        } else if (event.type === "cancelled") {
          cancelled = true;
        }
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

            // Version 3 accepts structured NDJSON, while remaining
            // backward-compatible with the current plain-text backend.
            try {
              handleEvent(JSON.parse(trimmed));
            } catch {
              modelResponse += line;
              setAnswer((currentAnswer) => currentAnswer + line);
            }
          }

          executeScroll();
        }

        buffer += txtdecoder.decode();
        if (buffer.trim()) {
          try {
            handleEvent(JSON.parse(buffer.trim()));
          } catch {
            modelResponse += buffer;
            setAnswer((currentAnswer) => currentAnswer + buffer);
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
        } else {
          modelResponse = modelResponse
            ? `${modelResponse}\n[Error: ${err?.message || "Streaming request failed."}]`
            : `Error: ${err?.message || "Streaming request failed."}`;
        }
      } finally {
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
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
        <ConversationDisplayArea
          data={data}
          streamdiv={streamdiv}
          answer={answer}
          streamToolActivity={streamToolActivity}
        />
        {waiting && is_stream && (
          <button
            type="button"
            onClick={stopStreaming}
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

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
  const host = import.meta.env.VITE_API_URL || "http://localhost:9000";
  const url = host + "/chat";
  const streamUrl = host + "/stream";
  const [data, setData] = useState([]);
  const [answer, setAnswer] = useState("");
  const [streamdiv, showStreamdiv] = useState(false);
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
      Accept: "text/plain",
      "Content-Type": "application/json",
    };

    const fetchStreamData = async () => {
      let modelResponse = "";

      try {
        setAnswer("");
        const response = await fetch(streamUrl, {
          method: "POST",
          headers: headerConfig,
          body: JSON.stringify(chatData),
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
        showStreamdiv(true);

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          const decodedTxt = txtdecoder.decode(value, { stream: true });
          setAnswer((currentAnswer) => currentAnswer + decodedTxt);
          modelResponse += decodedTxt;
          executeScroll();
        }
      } catch (err) {
        modelResponse = `Error: ${err?.message || "Streaming request failed."}`;
      } finally {
        setAnswer("");
        const updatedData = [...ndata, {
          role: "model",
          parts: [{ text: modelResponse }],
          toolActivity: []
        }];

        flushSync(() => {
          setData(updatedData);
          inputRef.current.placeholder = "Enter a message.";
          setWaiting(false);
        });
        showStreamdiv(false);
        executeScroll();
      }
    };

    fetchStreamData();
  };

  return (
    <center>
      <div className="chat-app">
        <Header toggled={toggled} setToggled={setToggled} />
        <ConversationDisplayArea data={data} streamdiv={streamdiv} answer={answer} />
        <MessageInput inputRef={inputRef} waiting={waiting} handleClick={handleClick} />
      </div>
    </center>
  );
}

export default App;

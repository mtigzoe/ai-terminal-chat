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

import React, { useEffect } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPaperPlane } from '@fortawesome/free-solid-svg-icons';

/** Submission using Enter or the Send button. Shift+Enter inserts a new line. */
const MessageInput = ({ inputRef, waiting, handleClick }) => {
  useEffect(() => {
    if (!waiting) {
      inputRef.current?.focus();
    }
  }, [waiting, inputRef]);

  return (
    <div className="message-input">
      <label htmlFor="chat-message-input" className="sr-only">
        message
      </label>
      <textarea
        id="chat-message-input"
        className="chat_msg_input"
        name="chat"
        rows={3}
        placeholder="Enter a message."
        ref={inputRef}
        disabled={waiting}
        aria-disabled={waiting}
        aria-describedby="message-input-help"
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !waiting) {
            e.preventDefault();
            handleClick();
          }
        }}
      />
      <p id="message-input-help" className="sr-only">
        Press Enter to send. Press Shift plus Enter to add a new line.
      </p>
      <button
        type="button"
        className="chat_msg_btn"
        onClick={handleClick}
        aria-label="Send message"
        disabled={waiting}
      >
        <span className="fa-span-send" aria-hidden="true">
          <FontAwesomeIcon icon={faPaperPlane} />
        </span>
      </button>
    </div>
  );
};

export default MessageInput;

import React, { useEffect, useState } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPaperPlane } from '@fortawesome/free-solid-svg-icons';
import GitStatusPanel from './GitStatusPanel.jsx';

/** Submission using Enter or the Send button. Shift+Enter inserts a new line. */
const MessageInput = ({ inputRef, waiting, pendingConfirmation, handleClick }) => {
  const [message, setMessage] = useState('');
  const blocked = waiting || pendingConfirmation;

  useEffect(() => {
    if (!blocked) {
      inputRef.current?.focus();
    }
  }, [blocked, inputRef]);

  const submitMessage = () => {
    if (blocked || !message.trim()) return;

    const submittedMessage = message;
    setMessage('');
    handleClick(submittedMessage);
  };

  let placeholder = 'Enter a message.';
  if (pendingConfirmation) placeholder = 'Respond to the pending confirmation above before sending another message.';
  else if (waiting) placeholder = "Waiting for model's response";

  return (
    <>
      <div className="message-input">
        <label htmlFor="chat-message-input" className="sr-only">
          message
        </label>
        <textarea
          id="chat-message-input"
          className="chat_msg_input"
          name="chat"
          rows={3}
          placeholder={placeholder}
          ref={inputRef}
          value={message}
          aria-describedby="message-input-help"
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submitMessage();
            }
          }}
        />
        <p id="message-input-help" className="sr-only">
          Press Enter to send. Press Shift plus Enter to add a new line.
          While a response is in progress, you can prepare your next message;
          cancel the current response before sending it.
          {pendingConfirmation ? ' A confirmation is waiting for your Allow or Decline choice; sending is disabled until you respond to it.' : ''}
        </p>
        <button
          type="button"
          className="chat_msg_btn"
          onClick={submitMessage}
          aria-label="Send message"
          disabled={blocked || !message.trim()}
        >
          <span className="fa-span-send" aria-hidden="true">
            <FontAwesomeIcon icon={faPaperPlane} />
          </span>
        </button>
      </div>
      <GitStatusPanel />
    </>
  );
};

export default MessageInput;

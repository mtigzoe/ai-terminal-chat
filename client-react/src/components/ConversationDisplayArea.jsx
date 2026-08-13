import React from 'react';
import Markdown from 'react-markdown';
import userIcon from '../assets/user-icon.png';
// TODO: Consider replacing chatbotIcon with its own distinct icon.
import chatbotIcon from '../assets/user-icon.png';

function ToolActivity({ activity = [] }) {
  if (!activity.length) return null;

  return (
    <details className="tool-activity">
      <summary>Tool activity ({activity.length})</summary>
      <ul>
        {activity.map((item, index) => {
          const args = item.args
            ? ` ${JSON.stringify(item.args)}`
            : '';
          const resultError = item.result?.error;
          return (
            <li key={`${item.name}-${index}`}>
              <code>{item.type === 'tool_call' ? '→' : '←'} {item.name}{args}</code>
              {resultError && <span> — Error: {resultError}</span>}
            </li>
          );
        })}
      </ul>
    </details>
  );
}

const ChatArea = ({ data, streamdiv, answer, streamToolActivity = [] }) => {
  return (
    <div className="chat-area">
      {data?.length <= 0 ? (
        <div className="welcome-area">
          <p className="welcome-1">Hi,</p>
          <p className="welcome-2">How can I help you today?</p>
        </div>
      ) : (
        <div className="welcome-area" style={{ display: "none" }}></div>
      )}

      {data.map((element, index) => (
        <div key={index} className={element.role}>
          <img
            src={element.role === "user" ? userIcon : chatbotIcon}
            alt="Icon"
          />
          <div>
            {element.role === "model" && (
              <ToolActivity activity={element.toolActivity} />
            )}
            <p><Markdown>{element.parts[0].text}</Markdown></p>
          </div>
        </div>
      ))}

      {streamdiv && (
        <div className="tempResponse">
          <img src={chatbotIcon} alt="Icon" />
          <div>
            <ToolActivity activity={streamToolActivity} />
            {answer && <p><Markdown>{answer}</Markdown></p>}
          </div>
        </div>
      )}

      <span id="checkpoint"></span>
    </div>
  );
};

export default ChatArea;

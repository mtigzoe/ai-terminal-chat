import React, { useRef, useState } from 'react';
import axios from 'axios';

/**
 * Accessible command panel backed by Flask's terminal API.
 * Commands are still subject to the backend command allowlist and timeout.
 */
export default function TerminalPanel({ host, onSendToChat }) {
  const [command, setCommand] = useState('');
  const [output, setOutput] = useState([]);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState('Terminal ready.');
  const inputRef = useRef(null);

  const runCommand = async (event) => {
    event.preventDefault();
    const value = command.trim();
    if (!value || running) return;

    setRunning(true);
    setStatus(`Running ${value}.`);
    try {
      const response = await axios.post(`${host}/terminal/run`, { command: value });
      const result = response.data || {};
      const exitCode = result.returncode ?? result.exit_code ?? 0;
      const stdout = result.stdout || '';
      const stderr = result.stderr || '';
      setOutput((current) => [
        ...current,
        { command: value, stdout, stderr, exitCode },
      ]);
      setStatus(`Command completed with exit code ${exitCode}.`);
      setCommand('');
    } catch (err) {
      const message = err?.response?.data?.error || err?.message || 'Unable to run command.';
      setOutput((current) => [...current, { command: value, stdout: '', stderr: message, exitCode: null }]);
      setStatus('Command failed.');
    } finally {
      setRunning(false);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  };

  const sendResultToChat = (item) => {
    const outputText = [
      item.stdout ? `stdout:\n${item.stdout}` : '',
      item.stderr ? `stderr:\n${item.stderr}` : '',
      `exit code: ${item.exitCode == null ? 'failed' : item.exitCode}`,
    ].filter(Boolean).join('\n\n');
    const message = `Terminal command: ${item.command}\n\n${outputText}`;
    onSendToChat?.(message);
    setStatus(`Sent the result of ${item.command} to chat.`);
  };

  return (
    <section className="terminal-panel" aria-labelledby="terminal-panel-heading">
      <h2 id="terminal-panel-heading">Terminal</h2>
      <div
        className="terminal-output"
        role="log"
        aria-label="Terminal output"
        aria-live="polite"
        aria-relevant="additions"
      >
        {output.length === 0 ? (
          <p>No terminal commands have been run.</p>
        ) : (
          output.map((item, index) => (
            <article key={`${item.command}-${index}`} className="terminal-command-result">
              <h3>Command: <code>{item.command}</code></h3>
              {item.stdout && <pre>{item.stdout}</pre>}
              {item.stderr && <pre role="alert">{item.stderr}</pre>}
              <p>Exit code: {item.exitCode == null ? 'failed' : item.exitCode}</p>
              {onSendToChat && (
                <button type="button" onClick={() => sendResultToChat(item)}>
                  Send result to chat
                </button>
              )}
            </article>
          ))
        )}
      </div>
      <form onSubmit={runCommand} className="terminal-form">
        <label htmlFor="terminal-command">Command</label>
        <input
          ref={inputRef}
          id="terminal-command"
          type="text"
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          disabled={running}
          autoComplete="off"
          spellCheck="false"
        />
        <button type="submit" disabled={running || !command.trim()}>
          {running ? 'Running…' : 'Run command'}
        </button>
      </form>
      <div role="status" aria-live="polite" className="terminal-status">{status}</div>
    </section>
  );
}

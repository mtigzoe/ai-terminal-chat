import React, { useRef, useState } from 'react';
import axios from 'axios';
import { summarizeTerminalResult } from '../liveAnnounce.js';

/**
 * Accessible command panel backed by Flask's terminal API.
 * Commands are still subject to the backend command allowlist and timeout.
 *
 * Advanced screen-reader support:
 * - Concise status announcements that include exit code and line counts
 *   (avoids dumping long stdout/stderr into the live region).
 * - role="log" for the output history with aria-relevant="additions".
 * - Explicit labels on each result so users can navigate by heading or
 *   landmark without relying on visual layout.
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

    // Flask executes commands with shell=False. On Windows, `ls` is a
    // PowerShell alias rather than an executable, so map the simple
    // cross-platform `ls` command to the allowlisted `dir` executable.
    const commandForBackend = value.toLowerCase() === 'ls' && /Win/i.test(navigator.platform)
      ? 'dir'
      : value;

    setRunning(true);
    setStatus(`Running ${value}.`);
    try {
      const response = await axios.post(`${host}/terminal/run`, { command: commandForBackend });
      const result = response.data || {};
      const exitCode = result.returncode ?? result.exit_code ?? 0;
      const stdout = result.stdout || '';
      const stderr = result.stderr || '';
      const item = { command: value, stdout, stderr, exitCode };
      setOutput((current) => [...current, item]);
      // Prefer a line-count summary over the raw exit-code string so that
      // long output remains usable with a screen reader.
      setStatus(summarizeTerminalResult(item));
      setCommand('');
    } catch (err) {
      const message = err?.response?.data?.error || err?.message || 'Unable to run command.';
      const item = { command: value, stdout: '', stderr: message, exitCode: null };
      setOutput((current) => [...current, item]);
      setStatus(summarizeTerminalResult(item));
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
    <section
      className="terminal-panel"
      role="region"
      aria-labelledby="terminal-panel-heading"
      data-focus-region="terminal"
    >
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
          output.map((item, index) => {
            const stdoutLines = item.stdout ? item.stdout.split(/\r?\n/).filter(Boolean).length : 0;
            const stderrLines = item.stderr ? item.stderr.split(/\r?\n/).filter(Boolean).length : 0;
            return (
              <article
                key={`${item.command}-${index}`}
                className="terminal-command-result"
                aria-labelledby={`terminal-result-${index}-heading`}
              >
                <h3 id={`terminal-result-${index}-heading`}>
                  Command: <code>{item.command}</code>
                </h3>
                {item.stdout && (
                  <div>
                    <p className="sr-only">
                      Standard output, {stdoutLines} line{stdoutLines === 1 ? '' : 's'}.
                    </p>
                    <pre aria-label={`Standard output of ${item.command}`}>{item.stdout}</pre>
                  </div>
                )}
                {item.stderr && (
                  <div>
                    <p className="sr-only">
                      Standard error, {stderrLines} line{stderrLines === 1 ? '' : 's'}.
                    </p>
                    <pre role="alert" aria-label={`Standard error of ${item.command}`}>{item.stderr}</pre>
                  </div>
                )}
                <p>Exit code: {item.exitCode == null ? 'failed' : item.exitCode}</p>
                {onSendToChat && (
                  <button type="button" onClick={() => sendResultToChat(item)}>
                    Send result to chat
                  </button>
                )}
              </article>
            );
          })
        )}
      </div>
      <form onSubmit={runCommand} className="terminal-form">
        <label htmlFor="terminal-command">Command</label>
        <input
          ref={inputRef}
          data-focus-target="terminal-input"
          id="terminal-command"
          type="text"
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          disabled={running}
          autoComplete="off"
          spellCheck="false"
        />
        <button type="submit" disabled={running || !command.trim()}>
          {running ? 'Running…' : 'Run'}
        </button>
      </form>
      <div role="status" aria-live="polite" aria-atomic="true" className="terminal-status">
        {status}
      </div>
    </section>
  );
}

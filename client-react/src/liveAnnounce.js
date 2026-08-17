/**
 * Helpers for reliable screen-reader announcements via ARIA live regions.
 *
 * Many screen readers (NVDA, JAWS, VoiceOver) suppress re-announcement of
 * identical text. Clearing the region briefly and then setting the new
 * message forces a fresh announcement. Prefer polite for routine status;
 * assertive only for confirmations and errors.
 */

/**
 * Announce a message into a live region element.
 * @param {HTMLElement | null} regionEl
 * @param {string} message
 * @param {{ assertive?: boolean, clearDelayMs?: number }} [options]
 */
export function announce(regionEl, message, options = {}) {
  if (!regionEl || typeof message !== 'string') return;
  const text = message.trim();
  if (!text) return;

  const assertive = Boolean(options.assertive);
  const clearDelayMs = options.clearDelayMs ?? 50;

  regionEl.setAttribute('aria-live', assertive ? 'assertive' : 'polite');
  regionEl.setAttribute('aria-atomic', 'true');
  if (!regionEl.getAttribute('role')) {
    regionEl.setAttribute('role', 'status');
  }

  // Clear first so identical consecutive messages still announce.
  regionEl.textContent = '';
  window.setTimeout(() => {
    regionEl.textContent = text;
  }, clearDelayMs);
}

/**
 * Build a concise summary of terminal command output for announcements.
 * Avoids reading multi-kilobyte stdout/stderr verbatim.
 * @param {{ command: string, stdout?: string, stderr?: string, exitCode: number | null }} item
 * @returns {string}
 */
export function summarizeTerminalResult(item) {
  const exit = item.exitCode == null ? 'failed' : `exit code ${item.exitCode}`;
  const stdoutLines = item.stdout ? item.stdout.split(/\r?\n/).filter(Boolean).length : 0;
  const stderrLines = item.stderr ? item.stderr.split(/\r?\n/).filter(Boolean).length : 0;
  const parts = [`Command ${item.command} finished with ${exit}.`];
  if (stdoutLines) parts.push(`${stdoutLines} line${stdoutLines === 1 ? '' : 's'} of standard output.`);
  if (stderrLines) parts.push(`${stderrLines} line${stderrLines === 1 ? '' : 's'} of standard error.`);
  if (!stdoutLines && !stderrLines) parts.push('No output.');
  return parts.join(' ');
}

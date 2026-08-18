import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';

/**
 * Small, keyboard-accessible desktop project switcher.
 *
 * Unlike the full Settings form, choosing a folder here applies the project
 * root immediately. Electron supplies the real filesystem path; browsers use
 * the existing manual-path workflow because the File System Access API does
 * not reliably expose an absolute path.
 */
export default function ProjectRootManager({ host }) {
  const [projectRoot, setProjectRoot] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Loading active project.');
  const [error, setError] = useState(false);

  const loadProjectRoot = useCallback(async () => {
    setLoading(true);
    try {
      const response = await axios.get(`${host}/project-root`);
      const path = response.data?.path || '';
      setProjectRoot(path);
      setError(false);
      setStatus(path ? `Active project: ${path}` : 'No active project is configured.');
    } catch (requestError) {
      setError(true);
      setStatus(
        requestError?.response?.data?.error ||
          requestError?.message ||
          'Could not load the active project.'
      );
    } finally {
      setLoading(false);
    }
  }, [host]);

  useEffect(() => {
    loadProjectRoot();
  }, [loadProjectRoot]);

  const chooseAndApply = async () => {
    setBusy(true);
    setError(false);
    setStatus('Opening the folder picker.');

    try {
      if (!window.electronAPI?.chooseFolder) {
        setError(true);
        setStatus(
          'Native project selection is available in the Electron desktop app. Use the project path field below in a browser.'
        );
        return;
      }

      const chosen = await window.electronAPI.chooseFolder(projectRoot || undefined);
      if (!chosen) {
        setStatus('Folder selection cancelled.');
        return;
      }

      setStatus(`Saving project: ${chosen}`);
      const response = await axios.post(`${host}/project-root`, { path: chosen });
      const savedPath = response.data?.path || chosen;
      setProjectRoot(savedPath);
      setError(false);
      setStatus(`Active project changed to ${savedPath}.`);

      // The chat page is a separate route/document. Notify any same-window
      // listeners when this component is embedded in another desktop view.
      window.dispatchEvent(
        new CustomEvent('project-root-changed', { detail: { path: savedPath } })
      );
    } catch (requestError) {
      if (requestError?.name === 'AbortError') {
        setStatus('Folder selection cancelled.');
        return;
      }
      setError(true);
      setStatus(
        requestError?.response?.data?.error ||
          requestError?.message ||
          'Could not change the active project.'
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-allowed-commands" aria-labelledby="active-project-heading">
      <h2 id="active-project-heading">Active Project</h2>
      <p className="settings-help">
        Choose a local folder and apply it immediately as the project root used by file,
        search, terminal, and Git tools. This desktop shortcut does not change your AI
        provider or model settings.
      </p>

      <div className="settings-field">
        <span className="settings-help" id="active-project-path-label">Current project</span>
        <output
          className="project-path"
          aria-labelledby="active-project-path-label"
          aria-live="polite"
        >
          {loading ? 'Loading…' : projectRoot || 'No project selected'}
        </output>
      </div>

      <div className="settings-allowed-commands-buttons">
        <button
          type="button"
          className="settings-folder-button"
          onClick={chooseAndApply}
          disabled={busy || loading}
          aria-describedby="active-project-help"
        >
          {busy ? 'Choosing project…' : 'Choose and use project folder'}
        </button>
        <button
          type="button"
          className="settings-folder-button"
          onClick={loadProjectRoot}
          disabled={busy || loading}
        >
          Refresh project
        </button>
      </div>

      <p id="active-project-help" className="settings-help">
        The selected folder is persisted in the local configuration file. Canceling the
        native picker leaves the current project unchanged.
      </p>

      <div
        className={`settings-status${error ? ' settings-status--error' : ''}`}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {status}
      </div>
    </section>
  );
}

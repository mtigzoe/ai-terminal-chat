import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';

/**
 * Keyboard-accessible project root manager.
 *
 * Choosing a folder in Electron applies the project root immediately. In a
 * browser, enter the full path and use Apply path. This is the single place
 * on Settings to change the project root (no duplicate field on the provider form).
 */
export default function ProjectRootManager({ host }) {
  const [projectRoot, setProjectRoot] = useState('');
  const [pathDraft, setPathDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('Loading active project.');
  const [error, setError] = useState(false);
  const chooseFolderButtonRef = useRef(null);
  const applyPathButtonRef = useRef(null);

  const restoreChooseFolderFocus = () => {
    window.setTimeout(() => {
      chooseFolderButtonRef.current?.focus();
    }, 0);
  };

  const loadProjectRoot = useCallback(async () => {
    setLoading(true);
    try {
      const response = await axios.get(`${host}/project-root`);
      const path = response.data?.path || '';
      setProjectRoot(path);
      setPathDraft(path);
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

  const applyPath = async (pathValue, { focusTarget } = {}) => {
    const trimmed = (pathValue || '').trim();
    if (!trimmed) {
      setError(true);
      setStatus('Enter a full project path before applying.');
      return;
    }

    setBusy(true);
    setError(false);
    setStatus(`Saving project: ${trimmed}`);

    try {
      const response = await axios.post(`${host}/project-root`, { path: trimmed });
      const savedPath = response.data?.path || trimmed;
      setProjectRoot(savedPath);
      setPathDraft(savedPath);
      setError(false);
      setStatus(`Active project changed to ${savedPath}.`);
      window.dispatchEvent(
        new CustomEvent('project-root-changed', { detail: { path: savedPath } })
      );
    } catch (requestError) {
      setError(true);
      setStatus(
        requestError?.response?.data?.error ||
          requestError?.message ||
          'Could not change the active project.'
      );
    } finally {
      setBusy(false);
      window.setTimeout(() => {
        if (focusTarget === 'apply') {
          applyPathButtonRef.current?.focus();
        } else {
          chooseFolderButtonRef.current?.focus();
        }
      }, 0);
    }
  };

  const chooseAndApply = async () => {
    setBusy(true);
    setError(false);
    setStatus('Opening the folder picker.');

    try {
      if (!window.electronAPI?.chooseFolder) {
        setError(true);
        setStatus(
          'Native project selection is available in the Electron desktop app. Enter the full path below and choose Apply path.'
        );
        return;
      }

      const chosen = await window.electronAPI.chooseFolder(projectRoot || undefined);
      if (!chosen) {
        setStatus('Folder selection cancelled.');
        return;
      }

      await applyPath(chosen, { focusTarget: 'choose' });
      return;
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
      restoreChooseFolderFocus();
    }
  };

  const handleApplyPath = (event) => {
    event.preventDefault();
    applyPath(pathDraft, { focusTarget: 'apply' });
  };

  return (
    <section className="settings-allowed-commands" aria-labelledby="active-project-heading">
      <h2 id="active-project-heading">Active Project</h2>
      <p className="settings-help">
        Set the local folder used as the project root for file, search, terminal, and Git
        tools. Changes apply immediately and do not alter AI provider or model settings.
      </p>

      <div className="settings-field">
        <span className="settings-help" id="active-project-path-label">Current project</span>
        <output
          className="project-path"
          aria-labelledby="active-project-path-label"
        >
          {loading ? 'Loading…' : projectRoot || 'No project selected'}
        </output>
      </div>

      <div className="settings-field">
        <label htmlFor="active-project-path-input">Project path</label>
        <input
          id="active-project-path-input"
          type="text"
          value={pathDraft}
          onChange={(event) => setPathDraft(event.target.value)}
          disabled={busy || loading}
          placeholder="C:\\Projects\\my-project"
          autoComplete="off"
          spellCheck="false"
          aria-describedby="active-project-help"
        />
      </div>

      <div className="settings-allowed-commands-buttons">
        <button
          type="button"
          ref={chooseFolderButtonRef}
          className="settings-folder-button"
          onClick={chooseAndApply}
          disabled={busy || loading}
          aria-describedby="active-project-help"
        >
          {busy ? 'Choosing project…' : 'Choose and use project folder'}
        </button>
        <button
          type="button"
          ref={applyPathButtonRef}
          className="settings-folder-button"
          onClick={handleApplyPath}
          disabled={busy || loading || !pathDraft.trim()}
        >
          Apply path
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
        In the desktop app, choose a folder with the native picker. In a browser, type the
        full filesystem path and select Apply path. Canceling the native picker leaves the
        current project unchanged.
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

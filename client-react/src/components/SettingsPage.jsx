import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';

const SettingsPage = ({ host }) => {
  const [providerNames, setProviderNames] = useState([]);
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState([]);
  const [modelsSupported, setModelsSupported] = useState(false);
  const [projectRoot, setProjectRoot] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingModels, setLoadingModels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [statusIsError, setStatusIsError] = useState(false);
  const [allowedCommands, setAllowedCommands] = useState([]);
  const [newCommandPrefix, setNewCommandPrefix] = useState('');
  const [selectedCommand, setSelectedCommand] = useState('');
  const [allowedCommandsStatus, setAllowedCommandsStatus] = useState('');
  const [allowedCommandsError, setAllowedCommandsError] = useState(false);
  const [allowedCommandsBusy, setAllowedCommandsBusy] = useState(false);
  const chooseFolderButtonRef = useRef(null);

  /**
   * Restore keyboard focus to the Choose a folder button after the native
   * OS dialog closes. Disabled buttons cannot hold focus, so we defer until
   * React has re-enabled the control.
   */
  const restoreChooseFolderFocus = () => {
    window.setTimeout(() => {
      chooseFolderButtonRef.current?.focus();
    }, 0);
  };

  const loadModels = async (providerName, preserveModel = '') => {
    if (!providerName) return;
    setLoadingModels(true);
    try {
      const response = await axios.get(`${host}/providers/${providerName}/models`);
      const availableModels = response.data.models || [];
      setModels(availableModels);
      setModelsSupported(Boolean(response.data.supports_listing));
      if (preserveModel) {
        setModel(preserveModel);
      } else if (availableModels.length > 0) {
        setModel(availableModels[0].id || '');
      }
    } catch {
      setModels([]);
      setModelsSupported(false);
    } finally {
      setLoadingModels(false);
    }
  };

  useEffect(() => {
    let active = true;

    const loadSettings = async () => {
      try {
        const [providerResponse, projectRootResponse, allowedCommandsResponse] =
          await Promise.all([
            axios.get(`${host}/providers?probe=0`),
            axios.get(`${host}/project-root`),
            axios.get(`${host}/allowed-commands`),
          ]);
        if (!active) return;
        setProviderNames(providerResponse.data.providers || []);
        setProvider(providerResponse.data.name || '');
        setModel(providerResponse.data.model || '');
        setProjectRoot(projectRootResponse.data.path || '');
        setAllowedCommands(allowedCommandsResponse.data.commands || []);
        setStatusMessage('');
        await loadModels(providerResponse.data.name, providerResponse.data.model || '');
      } catch {
        if (active) {
          setStatusIsError(true);
          setStatusMessage('Could not load settings from the backend.');
        }
      } finally {
        if (active) setLoading(false);
      }
    };

    loadSettings();
    return () => {
      active = false;
    };
  }, [host]);

  const handleProviderChange = async (event) => {
    const nextProvider = event.target.value;
    setProvider(nextProvider);
    setModel('');
    await loadModels(nextProvider);
  };

  const handleChooseFolder = async () => {
    setChoosingFolder(true);
    setStatusMessage('Opening the folder picker.');
    setStatusIsError(false);

    try {
      let selectedPath = '';

      // Prefer the native Electron directory dialog when available.
      if (window.electronAPI?.chooseFolder) {
        const chosen = await window.electronAPI.chooseFolder(projectRoot || undefined);
        if (!chosen) {
          setStatusMessage('Folder selection cancelled.');
          return;
        }
        selectedPath = chosen;
      } else if (typeof window.showDirectoryPicker === 'function') {
        // Browser File System Access API (Chrome/Edge). Path is often not
        // a real filesystem path, so we still prefer Electron for desktop.
        const handle = await window.showDirectoryPicker({ mode: 'read' });
        selectedPath = handle?.name || '';
        if (!selectedPath) {
          throw new Error('The folder picker did not return a path.');
        }
        setStatusIsError(true);
        setStatusMessage(
          `Browser selected folder name "${selectedPath}". ` +
          `For a full filesystem path, run the desktop (Electron) app or type the path manually.`
        );
        // Do not overwrite projectRoot with a bare folder name only.
        return;
      } else {
        throw new Error(
          'No folder picker is available in this environment. ' +
          'Type the full project path in the field, or use the Electron desktop app.'
        );
      }

      setProjectRoot(selectedPath);
      setStatusMessage(`Folder selected: ${selectedPath}`);
    } catch (error) {
      if (error?.name === 'AbortError') {
        setStatusMessage('Folder selection cancelled.');
        return;
      }
      setStatusIsError(true);
      setStatusMessage(
        error?.response?.data?.error || error?.message || 'Could not choose a folder.'
      );
    } finally {
      setChoosingFolder(false);
      restoreChooseFolderFocus();
    }
  };

  const handleSave = async (event) => {
    event.preventDefault();
    if (!provider || !projectRoot.trim()) return;

    setSaving(true);
    setStatusMessage('');
    setStatusIsError(false);

    try {
      const payload = {
        provider,
        model: model || undefined,
        project_path: projectRoot.trim(),
      };
      if (apiKey.trim()) {
        payload.api_key = apiKey.trim();
      }

      const providerResponse = await axios.post(`${host}/providers/select`, payload);
      const projectRootResponse = await axios.post(`${host}/project-root`, {
        path: projectRoot.trim(),
      });

      setProvider(providerResponse.data.name || provider);
      setModel(providerResponse.data.model || model);
      setProjectRoot(projectRootResponse.data.path || projectRoot.trim());
      setApiKey('');
      setStatusMessage(
        `Settings saved for ${providerResponse.data.name || provider}. Project path saved.`
      );
    } catch (error) {
      setStatusIsError(true);
      setStatusMessage(
        error?.response?.data?.error || error?.message || 'Could not save settings.'
      );
    } finally {
      setSaving(false);
    }
  };

  const handleAddAllowedCommand = async (event) => {
    event.preventDefault();
    const prefix = newCommandPrefix.trim();
    if (!prefix) {
      setAllowedCommandsError(true);
      setAllowedCommandsStatus('Enter a command prefix to add.');
      return;
    }

    setAllowedCommandsBusy(true);
    setAllowedCommandsError(false);
    setAllowedCommandsStatus('');

    try {
      const response = await axios.post(`${host}/allowed-commands`, {
        command: prefix,
      });
      setAllowedCommands(response.data.commands || []);
      setNewCommandPrefix('');
      setSelectedCommand('');
      setAllowedCommandsStatus(`Added allowed command: ${prefix}`);
    } catch (error) {
      setAllowedCommandsError(true);
      setAllowedCommandsStatus(
        error?.response?.data?.error || error?.message || 'Could not add command.'
      );
    } finally {
      setAllowedCommandsBusy(false);
    }
  };

  const handleRemoveAllowedCommand = async (event) => {
    event.preventDefault();
    const prefix = selectedCommand.trim();
    if (!prefix) {
      setAllowedCommandsError(true);
      setAllowedCommandsStatus('Select a command prefix to remove.');
      return;
    }

    setAllowedCommandsBusy(true);
    setAllowedCommandsError(false);
    setAllowedCommandsStatus('');

    try {
      const response = await axios.delete(
        `${host}/allowed-commands/${encodeURIComponent(prefix)}`
      );
      setAllowedCommands(response.data.commands || []);
      setSelectedCommand('');
      setAllowedCommandsStatus(`Removed allowed command: ${prefix}`);
    } catch (error) {
      setAllowedCommandsError(true);
      setAllowedCommandsStatus(
        error?.response?.data?.error || error?.message || 'Could not remove command.'
      );
    } finally {
      setAllowedCommandsBusy(false);
    }
  };

  if (loading) {
    return (
      <main className="settings-page" aria-labelledby="settings-heading">
        <a className="back-link" href="/">Back to chat</a>
        <h1 id="settings-heading">Settings</h1>
        <p role="status" aria-live="polite">Loading settings…</p>
      </main>
    );
  }

  return (
    <main className="settings-page" aria-labelledby="settings-heading">
      <a className="back-link" href="/">Back to chat</a>
      <h1 id="settings-heading">Settings</h1>

      <form className="settings-form" onSubmit={handleSave}>
        <div className="settings-field">
          <label htmlFor="settings-project-root">Default project path</label>
          <input
            id="settings-project-root"
            type="text"
            value={projectRoot}
            onChange={(event) => setProjectRoot(event.target.value)}
            disabled={saving || choosingFolder}
            placeholder="C:\\Projects\\my-project"
            autoComplete="off"
            spellCheck="false"
            aria-describedby="settings-project-root-help"
          />
          <button
            type="button"
            ref={chooseFolderButtonRef}
            className="settings-folder-button"
            onClick={handleChooseFolder}
            disabled={saving || choosingFolder}
            aria-describedby="settings-project-root-help"
          >
            {choosingFolder ? 'Choosing folder…' : 'Choose a folder'}
          </button>
          <p id="settings-project-root-help" className="settings-help">
            The backend uses this directory as the root for file, search, terminal, and Git tools. Choose a folder to open the native operating-system folder picker, or enter the full path manually. The selected path is shown here before you save it.
          </p>
        </div>

        <div className="settings-field">
          <label htmlFor="settings-provider">AI Provider</label>
          <select
            id="settings-provider"
            value={provider}
            onChange={handleProviderChange}
            disabled={saving || choosingFolder}
          >
            <option value="" disabled>Select a provider</option>
            {providerNames.map((name) => (
              <option key={name} value={name}>{name}</option>
            ))}
          </select>
        </div>

        <div className="settings-field">
          <label htmlFor="settings-model">Model</label>
          {models.length > 0 && modelsSupported ? (
            <select
              id="settings-model"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              disabled={saving || choosingFolder || loadingModels}
            >
              {models.map((item) => (
                <option key={item.id} value={item.id}>{item.id}</option>
              ))}
            </select>
          ) : (
            <input
              id="settings-model"
              type="text"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              disabled={saving || choosingFolder}
              placeholder={loadingModels ? 'Loading models…' : 'Enter model name'}
            />
          )}
        </div>

        <div className="settings-field">
          <label htmlFor="settings-api-key">API key</label>
          <input
            id="settings-api-key"
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            disabled={saving || choosingFolder}
            autoComplete="new-password"
            placeholder="Enter API key (optional for Ollama)"
            aria-describedby="settings-api-key-help"
          />
          <p id="settings-api-key-help" className="settings-help">
            The key is sent to the local backend only and is not displayed after saving. Leave it blank to keep the existing server-side key.
          </p>
        </div>

        <button type="submit" className="settings-save" disabled={saving || choosingFolder || !provider || !projectRoot.trim()}>
          {saving ? 'Saving…' : 'Save'}
        </button>

        <div
          className={`settings-status${statusIsError ? ' settings-status--error' : ''}`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {statusMessage}
        </div>
      </form>

      <section
        className="settings-allowed-commands"
        aria-labelledby="allowed-commands-heading"
      >
        <h2 id="allowed-commands-heading">Allowed Commands</h2>
        <p id="allowed-commands-help" className="settings-help">
          These prefixes control which terminal commands the agent may run.
          Changes are saved immediately and apply to the same allowlist used by
          the terminal tool. Dangerous commands cannot be added.
        </p>

        <div className="settings-field">
          <label htmlFor="allowed-commands-list">Current allowed command prefixes</label>
          <select
            id="allowed-commands-list"
            size={Math.min(12, Math.max(6, allowedCommands.length || 6))}
            value={selectedCommand}
            onChange={(event) => setSelectedCommand(event.target.value)}
            disabled={allowedCommandsBusy}
            aria-describedby="allowed-commands-help"
          >
            {allowedCommands.length === 0 ? (
              <option value="" disabled>No allowed commands configured</option>
            ) : (
              allowedCommands.map((cmd) => (
                <option key={cmd} value={cmd}>{cmd}</option>
              ))
            )}
          </select>
        </div>

        <div className="settings-field settings-allowed-commands-actions">
          <label htmlFor="allowed-commands-new">Add command prefix</label>
          <input
            id="allowed-commands-new"
            type="text"
            value={newCommandPrefix}
            onChange={(event) => setNewCommandPrefix(event.target.value)}
            disabled={allowedCommandsBusy}
            placeholder="e.g. wsl or cargo test"
            autoComplete="off"
            spellCheck="false"
            aria-describedby="allowed-commands-help"
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                handleAddAllowedCommand(event);
              }
            }}
          />
          <div className="settings-allowed-commands-buttons">
            <button
              type="button"
              className="settings-folder-button"
              onClick={handleAddAllowedCommand}
              disabled={allowedCommandsBusy || !newCommandPrefix.trim()}
            >
              {allowedCommandsBusy ? 'Working…' : 'Add'}
            </button>
            <button
              type="button"
              className="settings-folder-button"
              onClick={handleRemoveAllowedCommand}
              disabled={allowedCommandsBusy || !selectedCommand}
            >
              Remove
            </button>
          </div>
        </div>

        <div
          className={`settings-status${allowedCommandsError ? ' settings-status--error' : ''}`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          {allowedCommandsStatus}
        </div>
      </section>

      <section className="keyboard-shortcuts" aria-labelledby="keyboard-shortcuts-heading">
        <h2 id="keyboard-shortcuts-heading">Keyboard Shortcuts</h2>
        <table>
          <caption className="sr-only">Keyboard shortcuts</caption>
          <thead>
            <tr>
              <th scope="col">Shortcut</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Enter</td>
              <td>Send message</td>
            </tr>
            <tr>
              <td>Shift + Enter</td>
              <td>Insert a new line in the message</td>
            </tr>
          </tbody>
        </table>
      </section>
    </main>
  );
};

export default SettingsPage;

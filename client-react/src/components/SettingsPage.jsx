import React, { useEffect, useState } from 'react';
import axios from 'axios';
import MainNav from './MainNav.jsx';
import ProjectRootManager from './ProjectRootManager.jsx';

const formatOllamaHostname = (baseUrl) => {
  const value = String(baseUrl || '').trim();
  if (!value) return 'localhost:11434';
  try {
    const url = new URL(value.includes('://') ? value : `http://${value}`);
    return `${url.hostname}${url.port ? `:${url.port}` : ''}`;
  } catch {
    return value.replace(/^https?:\/\//i, '').replace(/\/v1\/?$/i, '');
  }
};

const SettingsPage = ({ host }) => {
  const [providerNames, setProviderNames] = useState([]);
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState([]);
  const [modelsSupported, setModelsSupported] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingModels, setLoadingModels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [ollamaHostname, setOllamaHostname] = useState('localhost:11434');
  const [statusMessage, setStatusMessage] = useState('');
  const [statusIsError, setStatusIsError] = useState(false);
  const [allowedCommands, setAllowedCommands] = useState([]);
  const [newCommandPrefix, setNewCommandPrefix] = useState('');
  const [selectedCommand, setSelectedCommand] = useState('');
  const [allowedCommandsStatus, setAllowedCommandsStatus] = useState('');
  const [allowedCommandsError, setAllowedCommandsError] = useState(false);
  const [allowedCommandsBusy, setAllowedCommandsBusy] = useState(false);

  const loadModels = async (providerName, preserveModel = '') => {
    if (!providerName) return;
    setLoadingModels(true);
    setModelsError('');
    try {
      const response = await axios.get(`${host}/providers/${providerName}/models`);
      const availableModels = response.data.models || [];
      setModels(availableModels);
      setModelsSupported(Boolean(response.data.supports_listing));
      if (response.data.error) {
        setModelsError(String(response.data.error));
      }
      if (preserveModel) {
        setModel(preserveModel);
      } else if (availableModels.length > 0) {
        setModel(availableModels[0].id || '');
      }
    } catch (error) {
      setModels([]);
      setModelsSupported(false);
      setModelsError(
        error?.response?.data?.error ||
          error?.message ||
          'Could not load models for this provider.'
      );
    } finally {
      setLoadingModels(false);
    }
  };

  useEffect(() => {
    let active = true;

    const loadSettings = async () => {
      try {
        const [providerResponse, allowedCommandsResponse] = await Promise.all([
          axios.get(`${host}/providers?probe=0`),
          axios.get(`${host}/allowed-commands`),
        ]);
        if (!active) return;
        setProviderNames(providerResponse.data.providers || []);
        setProvider(providerResponse.data.name || '');
        setModel(providerResponse.data.model || '');
        if ((providerResponse.data.name || '').toLowerCase() === 'ollama') {
          setOllamaHostname(formatOllamaHostname(providerResponse.data.base_url));
        }
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
    setModelsError('');
    if (nextProvider.toLowerCase() === 'ollama' && !ollamaHostname.trim()) {
      setOllamaHostname('localhost:11434');
    }
    await loadModels(nextProvider);
  };

  const handleSave = async (event) => {
    event.preventDefault();
    if (!provider) return;

    setSaving(true);
    setStatusMessage('');
    setStatusIsError(false);

    try {
      const payload = {
        provider,
        model: model || undefined,
      };
      if (provider.toLowerCase() === 'ollama') {
        const hostname = ollamaHostname.trim();
        if (!hostname) {
          setStatusIsError(true);
          setStatusMessage('Enter the Ollama hostname and port.');
          setSaving(false);
          return;
        }
        payload.ollama_base_url = hostname;
      }
      if (apiKey.trim()) {
        payload.api_key = apiKey.trim();
      }

      const providerResponse = await axios.post(`${host}/providers/select`, payload);

      setProvider(providerResponse.data.name || provider);
      setModel(providerResponse.data.model || model);
      if ((providerResponse.data.name || provider).toLowerCase() === 'ollama') {
        setOllamaHostname(formatOllamaHostname(providerResponse.data.base_url));
      }
      setApiKey('');

      const notes = providerResponse.data.capabilities?.notes;
      const available = providerResponse.data.available;
      if (available === false || notes) {
        setStatusIsError(true);
        setStatusMessage(
          notes ||
            providerResponse.data.error ||
            `Settings saved for ${providerResponse.data.name || provider}, but the provider is not fully available.`
        );
      } else {
        setStatusMessage(
          `Settings saved for ${providerResponse.data.name || provider}.`
        );
      }
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
        <MainNav />
        <h1 id="settings-heading">Settings</h1>
        <p role="status" aria-live="polite">Loading settings…</p>
      </main>
    );
  }

  return (
    <main className="settings-page" aria-labelledby="settings-heading">
      <MainNav />
      <h1 id="settings-heading">Settings</h1>

      <ProjectRootManager host={host} />

      <section className="settings-ai-providers" aria-labelledby="ai-providers-heading">
        <h2 id="ai-providers-heading">Provider settings</h2>
        <p className="settings-help">
          Choose the active AI provider, model, and optional API key. These settings are
          independent of the active project path above.
        </p>

        <form className="settings-form" onSubmit={handleSave}>
          <div className="settings-field">
            <label htmlFor="settings-provider">AI Provider</label>
            <select
              id="settings-provider"
              value={provider}
              onChange={handleProviderChange}
              disabled={saving}
            >
              <option value="" disabled>Select a provider</option>
              {providerNames.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </div>

          {provider.toLowerCase() === 'ollama' ? (
            <div className="settings-field">
              <label htmlFor="settings-ollama-hostname">Ollama hostname</label>
              <input
                id="settings-ollama-hostname"
                type="text"
                value={ollamaHostname}
                onChange={(event) => setOllamaHostname(event.target.value)}
                disabled={saving}
                placeholder="localhost:11434"
                autoComplete="url"
                spellCheck="false"
                aria-describedby="settings-ollama-hostname-help"
              />
              <p id="settings-ollama-hostname-help" className="settings-help">
                Enter the hostname and port where Ollama is running, such as localhost:11434 or cyber.local:11434. You do not need to edit the .env file.
              </p>
            </div>
          ) : null}

          <div className="settings-field">
            <label htmlFor="settings-model">Model</label>
            {models.length > 0 && modelsSupported ? (
              <select
                id="settings-model"
                value={model}
                onChange={(event) => setModel(event.target.value)}
                disabled={saving || loadingModels}
                aria-describedby="settings-model-help"
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
                disabled={saving}
                placeholder={loadingModels ? 'Loading models…' : 'Enter model name'}
                aria-describedby="settings-model-help"
              />
            )}
            <p id="settings-model-help" className="settings-help">
              {provider === 'ollama'
                ? 'For Ollama, choose a model from the list of installed models, or type a model name and pull it with `ollama pull <name>` if it is missing.'
                : 'Select a model when the provider supports listing, or type a model identifier.'}
            </p>
            {modelsError ? (
              <p className="settings-status settings-status--error" role="status" aria-live="polite">
                {modelsError}
              </p>
            ) : null}
          </div>

          <div className="settings-field">
            <label htmlFor="settings-api-key">API key</label>
            <input
              id="settings-api-key"
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              disabled={saving}
              autoComplete="new-password"
              placeholder="Enter API key (optional for Ollama)"
              aria-describedby="settings-api-key-help"
            />
            <p id="settings-api-key-help" className="settings-help">
              The key is sent to the local backend only and is not displayed after saving. Leave it blank to keep the existing server-side key. Ollama does not require an API key.
            </p>
          </div>

          <button type="submit" className="settings-save" disabled={saving || !provider}>
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
      </section>

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

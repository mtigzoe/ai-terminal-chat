import React, { useEffect, useState } from 'react';
import axios from 'axios';

const PROJECT_PATH_STORAGE_KEY = 'ai-terminal-chat.projectPath';

const SettingsPage = ({ host }) => {
  const [providerNames, setProviderNames] = useState([]);
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState([]);
  const [modelsSupported, setModelsSupported] = useState(false);
  const [projectPath, setProjectPath] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingModels, setLoadingModels] = useState(false);
  const [saving, setSaving] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [statusIsError, setStatusIsError] = useState(false);

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
        const response = await axios.get(`${host}/providers?probe=0`);
        if (!active) return;
        setProviderNames(response.data.providers || []);
        setProvider(response.data.name || '');
        setModel(response.data.model || '');
        setProjectPath(localStorage.getItem(PROJECT_PATH_STORAGE_KEY) || '');
        setStatusMessage('');
        await loadModels(response.data.name, response.data.model || '');
      } catch {
        if (active) {
          setStatusIsError(true);
          setStatusMessage('Could not load provider settings from the backend.');
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
        project_path: projectPath.trim(),
      };
      if (apiKey.trim()) {
        payload.api_key = apiKey.trim();
      }

      const response = await axios.post(`${host}/providers/select`, payload);
      setProvider(response.data.name || provider);
      setModel(response.data.model || model);
      localStorage.setItem(PROJECT_PATH_STORAGE_KEY, projectPath.trim());
      setApiKey('');
      setStatusMessage(`Settings saved for ${response.data.name || provider}.`);
    } catch (error) {
      setStatusIsError(true);
      setStatusMessage(
        error?.response?.data?.error || error?.message || 'Could not save settings.'
      );
    } finally {
      setSaving(false);
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
          <label htmlFor="settings-project-path">Default project path</label>
          <input
            id="settings-project-path"
            type="text"
            value={projectPath}
            onChange={(event) => setProjectPath(event.target.value)}
            disabled={saving}
            placeholder="C:\\Projects\\my-project"
            autoComplete="off"
            aria-describedby="settings-project-path-help"
          />
          <p id="settings-project-path-help" className="settings-help">
            This directory becomes the project root for file, search, terminal, and Git tools. The directory must already exist.
          </p>
        </div>

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

        <div className="settings-field">
          <label htmlFor="settings-model">Model</label>
          {models.length > 0 && modelsSupported ? (
            <select
              id="settings-model"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              disabled={saving || loadingModels}
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
            disabled={saving}
            autoComplete="new-password"
            placeholder="Enter API key (optional for Ollama)"
            aria-describedby="settings-api-key-help"
          />
          <p id="settings-api-key-help" className="settings-help">
            The key is sent to the local backend only and is not displayed after saving. Leave it blank to keep the existing server-side key.
          </p>
        </div>

        <button type="submit" className="settings-save" disabled={saving || !provider || !projectPath.trim()}>
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
    </main>
  );
};

export default SettingsPage;

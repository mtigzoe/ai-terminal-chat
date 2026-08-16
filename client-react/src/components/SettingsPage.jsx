import React, { useEffect, useState } from 'react';
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
        const [providerResponse, projectRootResponse] = await Promise.all([
          axios.get(`${host}/providers?probe=0`),
          axios.get(`${host}/project-root`),
        ]);
        if (!active) return;
        setProviderNames(providerResponse.data.providers || []);
        setProvider(providerResponse.data.name || '');
        setModel(providerResponse.data.model || '');
        setProjectRoot(projectRootResponse.data.path || '');
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
      const response = await axios.post(`${host}/project-root`, {
        path: '__CHOOSE_PROJECT_ROOT__',
      });
      const selectedPath = response.data.path || '';
      if (!selectedPath) {
        throw new Error('The folder picker did not return a path.');
      }
      setProjectRoot(selectedPath);
      setStatusMessage(`Folder selected: ${selectedPath}`);
    } catch (error) {
      setStatusIsError(true);
      setStatusMessage(
        error?.response?.data?.error || error?.message || 'Could not choose a folder.'
      );
    } finally {
      setChoosingFolder(false);
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
            autoComplete="off"
            spellCheck="false"
            aria-describedby="settings-project-root-help"
          />
          <button
            type="button"
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

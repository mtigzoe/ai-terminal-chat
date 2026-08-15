import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';

/**
 * Provider + model selector.
 *
 * Selection is always backend-controlled: choosing a provider or
 * model here sends a request to POST /providers/select, and the
 * Flask backend is what actually constructs (and can reject) the
 * provider — see "Don't expose API keys to React" in the README.
 * Nothing here assumes a choice succeeded until the backend confirms
 * it; a rejected switch leaves the previous provider active and
 * reports why.
 */
const ProviderSelector = ({ host, waiting }) => {
  const [providerNames, setProviderNames] = useState([]);
  const [current, setCurrent] = useState(null); // last known /providers response
  const [models, setModels] = useState([]);
  const [modelsSupported, setModelsSupported] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [statusIsError, setStatusIsError] = useState(false);

  const loadProviders = useCallback(async () => {
    try {
      const response = await axios.get(`${host}/providers`);
      setCurrent(response.data);
      setProviderNames(response.data.providers || []);
    } catch {
      setStatusIsError(true);
      setStatusMessage('Could not load provider status from the backend.');
    }
  }, [host]);

  const loadModels = useCallback(
    async (providerName) => {
      setLoadingModels(true);
      try {
        const response = await axios.get(`${host}/providers/${providerName}/models`);
        setModels(response.data.models || []);
        setModelsSupported(Boolean(response.data.supports_listing));
      } catch {
        setModels([]);
        setModelsSupported(false);
      } finally {
        setLoadingModels(false);
      }
    },
    [host]
  );

  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  useEffect(() => {
    if (current?.name) {
      loadModels(current.name);
    }
    // Only re-run when the active provider actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.name]);

  const selectProvider = async (providerName, model) => {
    setSwitching(true);
    setStatusMessage('');
    setStatusIsError(false);
    try {
      const response = await axios.post(`${host}/providers/select`, {
        provider: providerName,
        model: model || undefined,
      });
      setCurrent(response.data);
      const modelSuffix = response.data.model ? ` (${response.data.model})` : '';
      setStatusMessage(`Switched to ${response.data.name}${modelSuffix}.`);
    } catch (error) {
      const message =
        error?.response?.data?.error || error?.message || 'Could not switch provider.';
      setStatusMessage(message);
      setStatusIsError(true);
      // The switch failed server-side; re-sync with whichever provider
      // is actually still active rather than trusting the dropdown.
      loadProviders();
    } finally {
      setSwitching(false);
    }
  };

  const handleProviderChange = (event) => {
    selectProvider(event.target.value);
  };

  const handleModelSelectChange = (event) => {
    if (current?.name) {
      selectProvider(current.name, event.target.value);
    }
  };

  const handleModelInputBlur = (event) => {
    const value = event.target.value.trim();
    if (current?.name && value && value !== current.model) {
      selectProvider(current.name, value);
    }
  };

  if (!current) {
    return null;
  }

  const disabled = waiting || switching;
  const availabilityKnown = typeof current.available === 'boolean';
  const modelIsKnown = models.some((m) => m.id === current.model);

  return (
    <div className="provider-selector">
      <div className="provider-selector-row">
        <label htmlFor="provider-select" className="provider-selector-label">
          AI Provider
        </label>
        <select
          id="provider-select"
          value={current.name || ''}
          onChange={handleProviderChange}
          disabled={disabled}
        >
          {providerNames.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>

        {modelsSupported && (
          <>
            <label htmlFor="model-select" className="provider-selector-label">
              Model
            </label>
            {models.length > 0 ? (
              <select
                id="model-select"
                value={current.model || ''}
                onChange={handleModelSelectChange}
                disabled={disabled || loadingModels}
              >
                {!modelIsKnown && current.model && (
                  <option value={current.model}>{current.model}</option>
                )}
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="model-select"
                type="text"
                defaultValue={current.model || ''}
                disabled={disabled}
                onBlur={handleModelInputBlur}
                aria-label="Model name"
                placeholder={loadingModels ? 'Loading models…' : 'Model name'}
              />
            )}
          </>
        )}

        {availabilityKnown && (
          <span
            className={`provider-availability provider-availability--${
              current.available ? 'ok' : 'down'
            }`}
          >
            {current.available ? 'Available' : 'Unavailable'}
          </span>
        )}
      </div>

      <div
        className={`provider-selector-status${statusIsError ? ' provider-selector-status--error' : ''}`}
        role="status"
        aria-live="polite"
      >
        {statusMessage}
      </div>

      {current.available === false && current.diagnostics && (
        <div className="provider-diagnostics" role="status" aria-live="polite">
          <p>
            {current.diagnostics.provider} is unavailable
            {current.diagnostics.server ? ` at ${current.diagnostics.server}` : ''}
            {current.model ? ` (model: ${current.model})` : ''}.
          </p>
          {Array.isArray(current.diagnostics.possible_causes) &&
            current.diagnostics.possible_causes.length > 0 && (
              <ul>
                {current.diagnostics.possible_causes.map((cause) => (
                  <li key={cause}>{cause}</li>
                ))}
              </ul>
            )}
        </div>
      )}
    </div>
  );
};

export default ProviderSelector;

import '@testing-library/jest-dom/vitest';

// jsdom does not implement scrollIntoView. App.jsx calls it after
// every chat turn to keep the conversation scrolled to the latest
// message; without a stub, any test that submits a chat message
// throws an unhandled TypeError from inside that (unrelated) call.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {}
}

// Reliable localStorage/sessionStorage shim for Vitest/jsdom.
// Some jsdom/vitest combinations expose an incomplete or missing
// localStorage object, which breaks tests and components that call
// getItem/setItem/removeItem/clear.
if (typeof window !== 'undefined') {
  const createStorage = () => {
    let store = {};
    return {
      getItem(key) {
        return store[key] ?? null;
      },
      setItem(key, value) {
        store[key] = String(value);
      },
      removeItem(key) {
        delete store[key];
      },
      clear() {
        store = {};
      },
      get length() {
        return Object.keys(store).length;
      },
      key(index) {
        const keys = Object.keys(store);
        return keys[index] ?? null;
      },
    };
  };

  if (!window.localStorage || typeof window.localStorage.getItem !== 'function') {
    window.localStorage = createStorage();
  }
  if (!window.sessionStorage || typeof window.sessionStorage.getItem !== 'function') {
    window.sessionStorage = createStorage();
  }
}

// React 18 warns when state updates from useEffect / promise callbacks
// happen outside of act(). @testing-library/react already wraps fireEvent
// and render in act(), but async useEffect updates still leak through.
// These are false positives for our tests; filter them so test output
// stays readable while we keep the existing application behavior.
const originalConsoleError = console.error;
console.error = (...args) => {
  const message = args.join(' ');
  if (/An update to .+ inside a test was not wrapped in act\(\.\.\.\)/.test(message)) {
    return;
  }
  originalConsoleError.apply(console, args);
};

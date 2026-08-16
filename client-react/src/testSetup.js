import '@testing-library/jest-dom/vitest';

// jsdom does not implement scrollIntoView. App.jsx calls it after
// every chat turn to keep the conversation scrolled to the latest
// message; without a stub, any test that submits a chat message
// throws an unhandled TypeError from inside that (unrelated) call.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

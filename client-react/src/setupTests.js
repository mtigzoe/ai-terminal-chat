// jest-dom adds custom jest matchers for asserting on DOM nodes.
// allows you to do things like:
// expect(element).toHaveTextContent(/react/i)
// learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom';

import { beforeEach } from 'vitest';

beforeEach(() => {
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    // ignore unavailable browser storage
  }
});

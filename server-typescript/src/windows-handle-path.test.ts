/**
 * Unit tests for Windows relative-name validation (runs on all platforms).
 * Native NtCreateFile paths are exercised only on win32.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertSafeRelativeName,
  WindowsHandlePathError,
  windowsHandleRelativeAvailable,
} from "./windows-handle-path.ts";

test("assertSafeRelativeName accepts a simple file name", () => {
  assert.doesNotThrow(() => assertSafeRelativeName("file.txt"));
  assert.doesNotThrow(() => assertSafeRelativeName("README"));
});

test("assertSafeRelativeName rejects separators and traversal", () => {
  for (const name of ["a/b", "a\\b", ".", "..", "x/../y"]) {
    assert.throws(
      () => assertSafeRelativeName(name),
      (e: unknown) => e instanceof WindowsHandlePathError,
    );
  }
});

test("assertSafeRelativeName rejects ADS and NUL", () => {
  assert.throws(
    () => assertSafeRelativeName("file:stream"),
    (e: unknown) => e instanceof WindowsHandlePathError,
  );
  assert.throws(
    () => assertSafeRelativeName("file\0txt"),
    (e: unknown) => e instanceof WindowsHandlePathError,
  );
});

test("assertSafeRelativeName rejects reserved device names", () => {
  for (const name of ["NUL", "nul.txt", "CON", "COM1", "LPT1.out"]) {
    assert.throws(
      () => assertSafeRelativeName(name),
      (e: unknown) => e instanceof WindowsHandlePathError,
    );
  }
});

test("assertSafeRelativeName rejects control characters and empty", () => {
  assert.throws(
    () => assertSafeRelativeName(""),
    (e: unknown) => e instanceof WindowsHandlePathError,
  );
  assert.throws(
    () => assertSafeRelativeName("a\tb"),
    (e: unknown) => e instanceof WindowsHandlePathError,
  );
});

test("windowsHandleRelativeAvailable is false on non-Windows", () => {
  if (process.platform !== "win32") {
    assert.equal(windowsHandleRelativeAvailable(), false);
  }
});

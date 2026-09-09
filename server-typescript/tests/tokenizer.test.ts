import { describe, it, expect } from "vitest";
import { tokenizeShellCommand } from "../src/agent.ts";

describe("tokenizeShellCommand (matches Python shlex.split posix=False)", () => {
  it("splits on whitespace", () => {
    expect(tokenizeShellCommand("git add file.txt")).toEqual(["git", "add", "file.txt"]);
  });

  it("handles multiple spaces and tabs", () => {
    expect(tokenizeShellCommand("git  add\tfile.txt")).toEqual(["git", "add", "file.txt"]);
  });

  it("handles leading and trailing whitespace", () => {
    expect(tokenizeShellCommand("  git add file.txt  ")).toEqual(["git", "add", "file.txt"]);
  });

  it("handles empty input", () => {
    expect(tokenizeShellCommand("")).toEqual([]);
  });

  it("handles whitespace-only input", () => {
    expect(tokenizeShellCommand("   \t  ")).toEqual([]);
  });

  it("handles double-quoted strings", () => {
    expect(tokenizeShellCommand('git add "file with spaces.txt"')).toEqual(["git", "add", "file with spaces.txt"]);
  });

  it("handles single-quoted strings", () => {
    expect(tokenizeShellCommand("git add 'file with spaces.txt'")).toEqual(["git", "add", "file with spaces.txt"]);
  });

  it("handles quoted path with Windows backslashes", () => {
    expect(tokenizeShellCommand('"C:\\Users\\file.txt"')).toEqual(["C:\\Users\\file.txt"]);
  });

  it("handles unquoted Windows path (backslashes are literal)", () => {
    expect(tokenizeShellCommand("C:\\Users\\file.txt")).toEqual(["C:\\Users\\file.txt"]);
  });

  it("handles escaped double quotes inside double quotes", () => {
    expect(tokenizeShellCommand('"path with \\"quotes\\""')).toEqual(['path with "quotes"']);
  });

  it("handles escaped backslash inside double quotes", () => {
    expect(tokenizeShellCommand('"path with \\\\backslash"')).toEqual(["path with \\backslash"]);
  });

  it("does not treat backslash as escape outside quotes", () => {
    // In posix=False, backslash outside quotes is literal
    expect(tokenizeShellCommand("echo hello\\world")).toEqual(["echo", "hello\\world"]);
  });

  it("handles mixed quotes", () => {
    expect(tokenizeShellCommand("echo 'single' \"double\"")).toEqual(["echo", "single", "double"]);
  });

  it("handles single quotes inside double quotes", () => {
    expect(tokenizeShellCommand('"it\'s working"')).toEqual(["it's working"]);
  });

  it("handles double quotes inside single quotes", () => {
    expect(tokenizeShellCommand("'he said \"hello\"'")).toEqual(['he said "hello"']);
  });

  it("throws on unterminated double quote", () => {
    expect(() => tokenizeShellCommand('"unterminated')).toThrow("Unterminated double quote");
  });

  it("throws on unterminated single quote", () => {
    expect(() => tokenizeShellCommand("'unterminated")).toThrow("Unterminated single quote");
  });

  it("throws on unterminated double quote at end", () => {
    expect(() => tokenizeShellCommand('git add "file.txt')).toThrow("Unterminated double quote");
  });

  it("throws on unterminated single quote at end", () => {
    expect(() => tokenizeShellCommand("git add 'file.txt")).toThrow("Unterminated single quote");
  });

  it("handles escaped backslash followed by quote inside double quotes", () => {
    // \\" -> literal backslash then quote (but quote ends string)
    // Actually: \\ is escaped backslash, " is escaped quote
    expect(tokenizeShellCommand('"path\\\\\\"end"')).toEqual(['path\\"end']);
  });

  it("preserves backslashes in single quotes (no escaping)", () => {
    expect(tokenizeShellCommand("'C:\\Users\\file.txt'")).toEqual(["C:\\Users\\file.txt"]);
  });

  it("handles quoted empty string", () => {
    expect(tokenizeShellCommand('""')).toEqual([""]);
    expect(tokenizeShellCommand("''")).toEqual([""]);
  });

  it("handles command with only quoted argument", () => {
    expect(tokenizeShellCommand('"hello world"')).toEqual(["hello world"]);
  });

  it("handles nested-looking quotes", () => {
    expect(tokenizeShellCommand('"outer \'inner\' end"')).toEqual(["outer 'inner' end"]);
    expect(tokenizeShellCommand("'outer \"inner\" end'")).toEqual(['outer "inner" end']);
  });
});
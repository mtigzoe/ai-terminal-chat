import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("isOllamaCliInstalled", () => {
  const originalPath = process.env.PATH;
  let fakeBinDir: string;

  beforeEach(() => {
    fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "ollama-cli-path-"));
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("returns false when ollama is not on PATH", async () => {
    process.env.PATH = fakeBinDir;
    const { isOllamaCliInstalled } = await import("../src/ollama-cli.ts");
    expect(isOllamaCliInstalled()).toBe(false);
  });

  it("returns true once an ollama executable appears on PATH", async () => {
    fs.writeFileSync(path.join(fakeBinDir, "ollama"), "#!/bin/sh\necho stub\n", { mode: 0o755 });
    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;
    const { isOllamaCliInstalled } = await import("../src/ollama-cli.ts");
    expect(isOllamaCliInstalled()).toBe(true);
  });
});

describe("isOllamaCliInstalled on Windows: default-install-directory fallback", () => {
  // Regression coverage: Ollama's Windows installer adds
  // %LOCALAPPDATA%\Programs\Ollama to the *user* PATH in the registry, but
  // a long-running server only sees the PATH it inherited at startup - so
  // installing Ollama after the server is already running (a very
  // plausible sequence) would otherwise never be detected without a
  // server restart, even though the binary is genuinely there.
  const originalPlatform = process.platform;
  const originalPath = process.env.PATH;
  const originalLocalAppData = process.env.LOCALAPPDATA;
  let fakeLocalAppData: string;

  beforeEach(() => {
    fakeLocalAppData = fs.mkdtempSync(path.join(os.tmpdir(), "ollama-cli-localappdata-"));
    Object.defineProperty(process, "platform", { value: "win32" });
    // Deliberately empty/unrelated PATH: this is the "installed but the
    // running process's PATH hasn't caught up yet" scenario.
    process.env.PATH = fs.mkdtempSync(path.join(os.tmpdir(), "ollama-cli-empty-path-"));
    process.env.LOCALAPPDATA = fakeLocalAppData;
  });

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    process.env.PATH = originalPath;
    process.env.LOCALAPPDATA = originalLocalAppData;
    fs.rmSync(fakeLocalAppData, { recursive: true, force: true });
    vi.resetModules();
  });

  it("falls back to %LOCALAPPDATA%\\Programs\\Ollama\\ollama.exe when not on PATH", async () => {
    const ollamaDir = path.join(fakeLocalAppData, "Programs", "Ollama");
    fs.mkdirSync(ollamaDir, { recursive: true });
    fs.writeFileSync(path.join(ollamaDir, "ollama.exe"), "stub");

    const { isOllamaCliInstalled } = await import("../src/ollama-cli.ts");
    expect(isOllamaCliInstalled()).toBe(true);
  });

  it("still returns false when the default directory has no ollama.exe either", async () => {
    const { isOllamaCliInstalled } = await import("../src/ollama-cli.ts");
    expect(isOllamaCliInstalled()).toBe(false);
  });
});

describe("launchOllamaRun validation", () => {
  const originalPath = process.env.PATH;

  afterEach(() => {
    process.env.PATH = originalPath;
    vi.resetModules();
  });

  it("rejects an empty model name", async () => {
    const { launchOllamaRun } = await import("../src/ollama-cli.ts");
    const result = await launchOllamaRun("  ");
    expect(result.error).toBe("A model name is required.");
  });

  it("rejects a model name that looks like a CLI flag", async () => {
    const { launchOllamaRun } = await import("../src/ollama-cli.ts");
    const result = await launchOllamaRun("--help");
    expect(result.error).toContain("not a valid Ollama model name");
  });

  it("accepts a cloud model name with multiple colon segments", async () => {
    // Regression coverage for the same multi-colon-segment model name bug
    // fixed on the ollama-install branch (e.g. gpt-oss:20b:cloud);
    // launchOllamaRun's own validation must not re-reject those names.
    const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "ollama-cli-path-"));
    fs.writeFileSync(path.join(fakeBinDir, "ollama"), "#!/bin/sh\nsleep 5\n", { mode: 0o755 });
    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;
    try {
      const { launchOllamaRun } = await import("../src/ollama-cli.ts");
      const result = await launchOllamaRun("gpt-oss:20b:cloud");
      expect(result.error).toBeUndefined();
      expect(result.started).toBe(true);
      if (result.pid) process.kill(result.pid, "SIGKILL");
    } finally {
      fs.rmSync(fakeBinDir, { recursive: true, force: true });
    }
  });

  it("reports ollama not found on PATH", async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "ollama-cli-empty-"));
    process.env.PATH = emptyDir;
    try {
      const { launchOllamaRun } = await import("../src/ollama-cli.ts");
      const result = await launchOllamaRun("llama3.1");
      expect(result.error).toContain("was not found on PATH");
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe("launchOllamaRun on POSIX", () => {
  const originalPath = process.env.PATH;
  let fakeBinDir: string;
  let markerFile: string;

  beforeEach(() => {
    fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "ollama-cli-posix-"));
    markerFile = path.join(fakeBinDir, "ran-with-args.txt");
    // A real (fake) executable: writes its argv out so the test can check
    // exactly what launchOllamaRun invoked it with, then sleeps so the
    // test can observe it as a genuinely running detached process.
    fs.writeFileSync(
      path.join(fakeBinDir, "ollama"),
      `#!/bin/sh\necho "$@" > "${markerFile}"\nsleep 5\n`,
      { mode: 0o755 }
    );
    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("spawns `ollama run <model>` detached and returns a real pid", async () => {
    const { launchOllamaRun } = await import("../src/ollama-cli.ts");
    const result = await launchOllamaRun("llama3.1:8b");

    expect(result.error).toBeUndefined();
    expect(result.started).toBe(true);
    expect(result.model).toBe("llama3.1:8b");
    expect(typeof result.pid).toBe("number");

    // The process is genuinely running (not just a fabricated pid).
    expect(() => process.kill(result.pid!, 0)).not.toThrow();

    // Give the fake binary a moment to write its marker file, then check
    // it was invoked with exactly ["run", "llama3.1:8b"].
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(fs.readFileSync(markerFile, "utf-8").trim()).toBe("run llama3.1:8b");

    process.kill(result.pid!, "SIGKILL");
  });
});

describe("launchOllamaRun on Windows", () => {
  const originalPlatform = process.platform;
  const originalPath = process.env.PATH;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform });
    process.env.PATH = originalPath;
    vi.doUnmock("node:child_process");
    vi.resetModules();
  });

  it("launches via PowerShell Start-Process -PassThru and parses the real pid from stdout", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });

    const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "ollama-cli-win-"));
    fs.writeFileSync(path.join(fakeBinDir, "ollama.exe"), "stub");
    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;
    process.env.PATHEXT = ".exe;.cmd;.bat";

    let capturedCommand: string[] | undefined;
    vi.doMock("node:child_process", () => ({
      spawn: (command: string, args: string[]) => {
        capturedCommand = [command, ...args];
        const { EventEmitter } = require("node:events");
        const child = new EventEmitter() as any;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        setImmediate(() => {
          child.stdout.emit("data", "4242\n");
          child.emit("exit", 0);
        });
        return child;
      },
    }));

    const { launchOllamaRun } = await import("../src/ollama-cli.ts");
    const result = await launchOllamaRun("llama3.1");

    expect(result).toEqual({ started: true, model: "llama3.1", pid: 4242 });
    expect(capturedCommand?.[0]).toBe("powershell.exe");
    expect(capturedCommand).toContain("-NoProfile");
    expect(capturedCommand?.some((arg) => arg.includes("Start-Process"))).toBe(true);
    // The actual bug this guards against: launching used to re-resolve the
    // bare "ollama" name a second time at spawn time (via whatever PATH
    // the spawned process inherited), instead of the exact path already
    // found during detection. Asserting the resolved absolute path shows
    // up in -FilePath (not a bare "ollama") proves that's fixed.
    expect(
      capturedCommand?.some((arg) => arg.includes(path.join(fakeBinDir, "ollama.exe")))
    ).toBe(true);
    expect(capturedCommand?.some((arg) => arg.includes("llama3.1"))).toBe(true);

    fs.rmSync(fakeBinDir, { recursive: true, force: true });
  });

  it("launches successfully when ollama is found only via the LOCALAPPDATA fallback, not on PATH", async () => {
    // Regression test for the two-part PATH bug together: status detection
    // finding ollama only through the default-install-directory fallback
    // must still translate into a launch that actually works, rather than
    // handing a bare "ollama" to PowerShell and having it fail to resolve
    // on the same stale PATH that made the fallback necessary in the
    // first place.
    Object.defineProperty(process, "platform", { value: "win32" });

    const fakeLocalAppData = fs.mkdtempSync(path.join(os.tmpdir(), "ollama-cli-win-lad-"));
    const ollamaDir = path.join(fakeLocalAppData, "Programs", "Ollama");
    fs.mkdirSync(ollamaDir, { recursive: true });
    fs.writeFileSync(path.join(ollamaDir, "ollama.exe"), "stub");

    const emptyPathDir = fs.mkdtempSync(path.join(os.tmpdir(), "ollama-cli-win-emptypath-"));
    process.env.PATH = emptyPathDir;
    process.env.LOCALAPPDATA = fakeLocalAppData;

    let capturedCommand: string[] | undefined;
    vi.doMock("node:child_process", () => ({
      spawn: (command: string, args: string[]) => {
        capturedCommand = [command, ...args];
        const { EventEmitter } = require("node:events");
        const child = new EventEmitter() as any;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        setImmediate(() => {
          child.stdout.emit("data", "9999\n");
          child.emit("exit", 0);
        });
        return child;
      },
    }));

    const { launchOllamaRun } = await import("../src/ollama-cli.ts");
    const result = await launchOllamaRun("llama3.1");

    expect(result).toEqual({ started: true, model: "llama3.1", pid: 9999 });
    expect(
      capturedCommand?.some((arg) => arg.includes(path.join(ollamaDir, "ollama.exe")))
    ).toBe(true);

    fs.rmSync(fakeLocalAppData, { recursive: true, force: true });
    fs.rmSync(emptyPathDir, { recursive: true, force: true });
    delete process.env.LOCALAPPDATA;
  });

  it("surfaces a PowerShell failure as an error instead of a false positive", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });

    const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), "ollama-cli-win-"));
    fs.writeFileSync(path.join(fakeBinDir, "ollama.exe"), "stub");
    process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath}`;
    process.env.PATHEXT = ".exe;.cmd;.bat";

    vi.doMock("node:child_process", () => ({
      spawn: () => {
        const { EventEmitter } = require("node:events");
        const child = new EventEmitter() as any;
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        setImmediate(() => {
          child.stderr.emit("data", "Start-Process : Access is denied.\n");
          child.emit("exit", 1);
        });
        return child;
      },
    }));

    const { launchOllamaRun } = await import("../src/ollama-cli.ts");
    const result = await launchOllamaRun("llama3.1");

    expect(result.started).toBeUndefined();
    expect(result.error).toContain("Access is denied");

    fs.rmSync(fakeBinDir, { recursive: true, force: true });
  });
});

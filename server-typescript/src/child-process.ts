import { spawn } from "node:child_process";

export interface ChildProcessOptions {
  cwd: string;
  timeout: number;
  signal?: AbortSignal;
  maxBuffer: number;
  env: NodeJS.ProcessEnv;
}

interface ChildProcessFailure extends Error {
  code?: string | number;
  killed?: boolean;
  signal?: string | null;
  stdout?: string;
  stderr?: string;
}

function terminateProcessTree(pid: number | undefined): void {
  if (!pid) return;

  if (process.platform === "win32") {
    // Windows' child_process.kill() only terminates the immediate process.
    // npm, pytest, and similar commands commonly create descendants, so use
    // taskkill's process-tree mode when the terminal operation is cancelled.
    try {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        shell: false,
        windowsHide: true,
        stdio: "ignore",
      }).on("error", () => {
        // The process may already have exited. There is nothing else to do.
      });
    } catch {
      // Best-effort tree termination; the direct child is still killed below.
    }
    return;
  }

  // Detached POSIX children become the leader of their own process group.
  // A negative PID targets that entire group, covering npm/pytest descendants.
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The process group may already have exited.
  }
}

export function runChildProcess(
  file: string,
  args: string[],
  options: ChildProcessOptions,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      const error = new Error("The operation was aborted.") as ChildProcessFailure;
      error.name = "AbortError";
      reject(error);
      return;
    }

    const child = spawn(file, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let outputLimitExceeded = false;
    let timer: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    const rejectFailure = (message: string, code?: string | number) => {
      const error = new Error(message) as ChildProcessFailure;
      error.code = code;
      error.killed = true;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    };

    const terminate = () => {
      // The process group/tree is terminated first. On Windows this is
      // asynchronous, so also kill the direct child immediately.
      terminateProcessTree(child.pid);
      try {
        child.kill();
      } catch {
        // The child may have exited between the check and kill().
      }
    };

    const onAbort = () => {
      if (settled) return;
      cancelled = true;
      terminate();
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });
    // The signal can abort between the initial check and listener
    // registration. Re-check it after the listener is installed so that
    // this race cannot leave a newly spawned process running.
    if (options.signal?.aborted) {
      onAbort();
    }

    const appendOutput = (stream: "stdout" | "stderr", chunk: Buffer | string) => {
      if (settled || outputLimitExceeded) return;

      const text = String(chunk);
      if (stream === "stdout") stdout += text;
      else stderr += text;

      if (stdout.length > options.maxBuffer || stderr.length > options.maxBuffer) {
        outputLimitExceeded = true;
        terminate();
      }
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => appendOutput("stdout", chunk));
    child.stderr?.on("data", (chunk) => appendOutput("stderr", chunk));

    child.on("error", (error) => {
      if (settled) return;
      const failure = error as ChildProcessFailure;
      failure.stdout = stdout;
      failure.stderr = stderr;
      if (failure.code === "ENOENT") {
        settled = true;
        cleanup();
        reject(failure);
      }
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();

      if (cancelled || options.signal?.aborted) {
        rejectFailure("The operation was aborted.", "ABORT_ERR");
        return;
      }

      if (timedOut) {
        const error = new Error("The operation timed out.") as ChildProcessFailure;
        error.code = "ETIMEDOUT";
        error.killed = true;
        error.signal = signal;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }

      if (outputLimitExceeded) {
        const error = new Error("stdout maxBuffer length exceeded.") as ChildProcessFailure;
        error.code = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }

      if (signal) {
        const error = new Error("The process terminated with signal " + signal + ".") as ChildProcessFailure;
        error.signal = signal;
        error.code = signal;
        error.killed = true;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }

      resolve({ stdout, stderr, code: typeof code === "number" ? code : 0 });
    });

    timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      terminate();
    }, options.timeout);
  });
}
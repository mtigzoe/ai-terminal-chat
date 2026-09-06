// Ollama CLI detection and launching.
//
// Reference: server-python/ollama.py's `is_ollama_cli_installed()` and
// `launch_ollama_run()`. These back the Settings page's "Install Ollama" /
// "Run Ollama" buttons and are distinct from OllamaProvider's HTTP probe
// (providers/openai-compatible.ts) — this checks the `ollama` executable
// itself, which can be installed even while the background server
// (`ollama serve`) is not yet running.

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { spawn } from "node:child_process";

/**
 * Find `command` on PATH and return its absolute path, or null. Node has
 * no built-in equivalent of Python's `shutil.which`, so this scans PATH
 * directories directly, checking each PATHEXT extension on Windows (where
 * executables need one) and the bare name elsewhere.
 */
function findOnPath(command: string): string | null {
  const pathEnv = process.env.PATH || process.env.Path || "";
  const dirs = pathEnv.split(delimiter).filter(Boolean);

  if (process.platform === "win32") {
    const pathext = (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
    for (const dir of dirs) {
      for (const ext of pathext) {
        const candidate = join(dir, command + ext);
        if (existsSync(candidate)) return candidate;
      }
      // Some installs place an extensionless shim on PATH too.
      const bare = join(dir, command);
      if (existsSync(bare)) return bare;
    }
    return null;
  }

  for (const dir of dirs) {
    const candidate = join(dir, command);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve the `ollama` executable's absolute path: first via PATH, then
 * (on Windows) via Ollama's documented default install location.
 *
 * The fallback matters in practice, not just in theory: Ollama's Windows
 * installer places the binaries in `%LOCALAPPDATA%\Programs\Ollama` and
 * adds that directory to the user's PATH in the registry [1], but a
 * long-running server process only sees the PATH it inherited when it
 * started. Installing Ollama (or logging back in so a PATH change takes
 * effect) *after* the server is already running won't update
 * `process.env.PATH` until the server itself is restarted - PATH edits
 * never propagate to already-running processes on Windows. Checking the
 * known default location directly catches that common ordering (install
 * Ollama, then check status without restarting the dev server) without
 * requiring one. This doesn't cover a custom `/DIR=` install location
 * chosen at install time, which genuinely does need a server restart to
 * pick up - same limitation Python's shutil.which()-based check has.
 *
 * [1] https://docs.ollama.com/windows - "explorer %LOCALAPPDATA%\Programs\Ollama
 *     contains the binaries (The installer adds this to your user PATH)"
 */
function resolveOllamaExecutable(): string | null {
  const onPath = findOnPath("ollama");
  if (onPath) return onPath;

  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const defaultInstallPath = join(process.env.LOCALAPPDATA, "Programs", "Ollama", "ollama.exe");
    if (existsSync(defaultInstallPath)) return defaultInstallPath;
  }

  return null;
}

/** True if the `ollama` executable is recognized on this machine. */
export function isOllamaCliInstalled(): boolean {
  return resolveOllamaExecutable() !== null;
}

// Ollama model names look like `llama3.1`, `llama3.1:8b`, or
// `myuser/mymodel:tag`. Cloud models can chain more than one colon segment
// (e.g. `gpt-oss:20b:cloud`, `gpt-oss:20b-cloud`), so this allows any number
// of `:segment` parts rather than just one. What it guards against is a
// leading `-` (so a typed value can never be read as a CLI flag) and
// characters outside the set Ollama itself uses.
const SAFE_MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

export interface LaunchOllamaRunResult {
  error?: string;
  started?: true;
  model?: string;
  pid?: number;
}

/**
 * Start `ollama run <model>` in the background, without blocking. This is
 * what the Settings page's "Run Ollama" button calls so a user never has
 * to type `ollama run <model>` into a terminal themselves. `ollama run`
 * pulls the model if needed, starts the server if it isn't already
 * running, and then drops into an interactive chat — it does not exit on
 * its own — so this launches it as a detached process rather than waiting
 * for it to finish.
 *
 * On Windows this goes through PowerShell's `Start-Process -PassThru` so
 * pull/startup progress stays visible in its own console window (mirroring
 * what the user would see running the command themselves) while still
 * getting back the real `ollama.exe` pid — spawning via `cmd /c start`
 * would only report the launcher's pid, not the process it opens.
 * Elsewhere it runs fully detached in the background, since there is no
 * single cross-platform way to open a new terminal window.
 */
export async function launchOllamaRun(model: string): Promise<LaunchOllamaRunResult> {
  const trimmedModel = (model || "").trim();
  if (!trimmedModel) {
    return { error: "A model name is required." };
  }
  if (!SAFE_MODEL_NAME.test(trimmedModel)) {
    return { error: `'${trimmedModel}' is not a valid Ollama model name.` };
  }

  const resolvedExecutable = resolveOllamaExecutable();
  if (!resolvedExecutable) {
    return {
      error: "The `ollama` command was not found on PATH. Install Ollama first, then try again.",
    };
  }

  if (process.platform === "win32") {
    // SAFE_MODEL_NAME already rules out spaces, quotes, `$`, backticks,
    // and semicolons, so trimmedModel is safe to place directly inside a
    // single-quoted PowerShell string. resolvedExecutable is a real
    // filesystem path we found via existsSync just above rather than
    // user input, but a username containing a literal `'` (rare, though
    // possible) would otherwise break out of the quoted string, so it
    // gets the standard PowerShell single-quote escape (doubling it) too.
    const psPath = resolvedExecutable.replace(/'/g, "''");
    const psCommand =
      `$p = Start-Process -FilePath '${psPath}' -ArgumentList 'run','${trimmedModel}' ` +
      `-PassThru; Write-Output $p.Id`;

    return new Promise<LaunchOllamaRunResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      const ps = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", psCommand],
        { windowsHide: true }
      );
      ps.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
      ps.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
      ps.on("error", (exc) => {
        const message = exc instanceof Error ? exc.message : String(exc);
        resolve(
          message.includes("ENOENT")
            ? { error: "PowerShell was not found on PATH; cannot start Ollama on Windows." }
            : { error: `Could not start \`ollama run ${trimmedModel}\`: ${message}` }
        );
      });
      ps.on("exit", (code) => {
        const pid = Number.parseInt(stdout.trim(), 10);
        if (code === 0 && Number.isFinite(pid)) {
          resolve({ started: true, model: trimmedModel, pid });
        } else {
          resolve({
            error: `Could not start \`ollama run ${trimmedModel}\`: ${stderr.trim() || `powershell exited with code ${code}`}`,
          });
        }
      });
    });
  }

  try {
    const child = spawn(resolvedExecutable, ["run", trimmedModel], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    if (child.pid === undefined) {
      return { error: `Could not start \`ollama run ${trimmedModel}\`.` };
    }
    return { started: true, model: trimmedModel, pid: child.pid };
  } catch (exc) {
    const message = exc instanceof Error ? exc.message : String(exc);
    return message.includes("ENOENT")
      ? { error: "The `ollama` command was not found on PATH. Install Ollama first, then try again." }
      : { error: `Could not start \`ollama run ${trimmedModel}\`: ${message}` };
  }
}

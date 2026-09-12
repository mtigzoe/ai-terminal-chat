// Ollama CLI detection and launching.
//
// Reference: server-python/ollama.py's `is_ollama_cli_installed()` and
// `launch_ollama_run()`. These back the Settings page's "Install Ollama" /
// "Run Ollama" buttons and are distinct from OllamaProvider's HTTP probe
// (providers/openai-compatible.ts) — this checks the `ollama` executable
// itself, which can be installed even while the background server
// (`ollama serve`) is not yet running.

import { existsSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { getProjectRoot, isPathWithinRoot } from "./security.ts";
import { resolveTrustedExecutable, TrustedExecutableError } from "./trusted-exec.ts";

/**
 * Resolve `ollama` through the same trusted executable boundary used by the
 * terminal. This prevents a repository-local `ollama.exe`/`ollama.cmd` from
 * winning executable resolution merely because the project is the current
 * working directory.
 */
function resolveTrustedAbsoluteExecutable(candidate: string): string | null {
  try {
    if (!existsSync(candidate) || !statSync(candidate).isFile()) return null;
    const resolved = realpathSync(candidate);
    const projectRoot = realpathSync(getProjectRoot());
    if (isPathWithinRoot(projectRoot, resolved)) return null;
    return resolved;
  } catch {
    return null;
  }
}

function resolvePowerShellExecutable(): string | null {
  try {
    return resolveTrustedExecutable("powershell", { projectRoot: getProjectRoot() });
  } catch {
    const pathEnv = process.env.Path || process.env.PATH || "";
    for (const dir of pathEnv.split(";")) {
      if (!dir.trim()) continue;
      const resolved = resolveTrustedAbsoluteExecutable(join(dir.trim(), "powershell.exe"));
      if (resolved) return resolved;
    }
    return null;
  }
}

function resolveOllamaExecutable(): string | null {
  try {
    return resolveTrustedExecutable("ollama", { projectRoot: getProjectRoot() });
  } catch (exc) {
    if (!(exc instanceof TrustedExecutableError)) {
      throw exc;
    }
  }

  // On Windows, Ollama's installer can place the executable in its documented
  // default location after this server process inherited its PATH. Preserve
  // that useful fallback, but reject it if it resolves inside the project.
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const candidate = join(
      process.env.LOCALAPPDATA,
      "Programs",
      "Ollama",
      "ollama.exe",
    );
    if (existsSync(candidate)) {
      try {
        return resolveTrustedAbsoluteExecutable(candidate);
      } catch (exc) {
        if (!(exc instanceof TrustedExecutableError)) {
          throw exc;
        }
      }
    }
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
    const psPath = resolvedExecutable.replace(/'/g, "''");
    const psCommand =
      `$p = Start-Process -FilePath '${psPath}' -ArgumentList 'run','${trimmedModel}' ` +
      `-PassThru; Write-Output $p.Id`;

    let powershell: string;
    try {
      powershell = resolvePowerShellExecutable() || "";
      if (!powershell) throw new TrustedExecutableError("powershell is not installed or not on PATH outside the project root.");
    } catch (exc) {
      const message = exc instanceof Error ? exc.message : String(exc);
      return { error: `Could not resolve trusted PowerShell: ${message}` };
    }

    return new Promise<LaunchOllamaRunResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      const ps = spawn(
        powershell,
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

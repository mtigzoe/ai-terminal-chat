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
 * True if the `ollama` executable is recognized on this machine's PATH.
 * Node has no built-in equivalent of Python's `shutil.which`, so this
 * scans PATH directories directly, checking each PATHEXT extension on
 * Windows (where executables need one) and the bare name elsewhere.
 */
export function isOllamaCliInstalled(): boolean {
  return commandExistsOnPath("ollama");
}

function commandExistsOnPath(command: string): boolean {
  const pathEnv = process.env.PATH || process.env.Path || "";
  const dirs = pathEnv.split(delimiter).filter(Boolean);

  if (process.platform === "win32") {
    const pathext = (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
    for (const dir of dirs) {
      for (const ext of pathext) {
        if (existsSync(join(dir, command + ext))) return true;
      }
      // Some installs place an extensionless shim on PATH too.
      if (existsSync(join(dir, command))) return true;
    }
    return false;
  }

  for (const dir of dirs) {
    if (existsSync(join(dir, command))) return true;
  }
  return false;
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
  if (!isOllamaCliInstalled()) {
    return {
      error: "The `ollama` command was not found on PATH. Install Ollama first, then try again.",
    };
  }

  const notFoundResult: LaunchOllamaRunResult = {
    error: "The `ollama` command was not found on PATH. Install Ollama first, then try again.",
  };

  if (process.platform === "win32") {
    // SAFE_MODEL_NAME already rules out spaces, quotes, `$`, backticks,
    // and semicolons, so trimmedModel is safe to place directly inside a
    // single-quoted PowerShell string.
    const psCommand =
      `$p = Start-Process -FilePath 'ollama' -ArgumentList 'run','${trimmedModel}' ` +
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
    const child = spawn("ollama", ["run", trimmedModel], {
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
      ? notFoundResult
      : { error: `Could not start \`ollama run ${trimmedModel}\`: ${message}` };
  }
}

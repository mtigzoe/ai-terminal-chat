import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const tsxLoader = pathToFileURL(require.resolve("tsx/esm")).href;

// Run the real persistence modules in fresh processes, without test-only path
// overrides. A fake home makes a regression safe while reproducing the actual
// boundary between a normal backend configuration and an Electron profile.
const childProgram = `
  import assert from "node:assert/strict";
  import { homedir } from "node:os";
  import { realpathSync } from "node:fs";
  assert.equal(realpathSync(homedir()), realpathSync(process.env.PROFILE_TEST_HOME));
  let networkRequests = 0;
  globalThis.fetch = async () => {
    networkRequests++;
    throw new Error("Profile isolation tests must not use the network");
  };
  const config = await import(${JSON.stringify(new URL("../src/config.ts", import.meta.url).href)});
  const security = await import(${JSON.stringify(new URL("../src/security.ts", import.meta.url).href)});
  const terminal = await import(${JSON.stringify(new URL("../src/terminal.ts", import.meta.url).href)});
  const { app } = await import(${JSON.stringify(new URL("../src/routes.ts", import.meta.url).href)});
  if (process.env.PROFILE_TEST_ACTION === "save") {
    security.persistProviderSelection("ollama", "isolated-profile-model");
    security.setProjectRoot(process.env.PROFILE_TEST_PROJECT);
    terminal.persistAllowedCommands(["git status --short"]);
    config.persistAppConfig({ profile_marker: "isolated-profile" });
  }
  const response = await app.request("http://localhost/providers?probe=0");
  assert.equal(response.status, 200);
  const providerStatus = await response.json();
  assert.equal(networkRequests, 0);
  console.log(JSON.stringify({
    configFile: security.getConfigFile(),
    config: config.loadAppConfig(),
    selection: security.loadProviderSelection(),
    projectRoot: security.getProjectRoot(),
    allowedCommands: terminal.reloadAllowedCommands(),
    defaultAllowedCommands: [...terminal.DEFAULT_ALLOWED_COMMAND_PREFIXES].sort(),
    providerStatus,
  }));
`;

interface Snapshot {
  configFile: string;
  config: Record<string, unknown>;
  selection: Record<string, unknown>;
  projectRoot: string;
  allowedCommands: string[];
  defaultAllowedCommands: string[];
  providerStatus: { current: string; model: string };
}

it("isolates backend settings across profiles and preserves the standalone home configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "ai-terminal-profile-isolation-"));
  const home = join(root, "normal home");
  const normalConfigDir = join(home, ".ai-terminal-chat");
  const normalConfigFile = join(normalConfigDir, "config.json");
  const cwd = join(root, "backend working directory");
  const normalProject = join(root, "normal project");
  const isolatedProject = join(root, "isolated project");
  const firstProfile = join(root, "first disposable profile", "backend");
  const secondProfile = join(root, "second disposable profile", "backend");

  try {
    for (const directory of [normalConfigDir, cwd, normalProject, isolatedProject]) {
      mkdirSync(directory, { recursive: true });
    }
    const normalConfig = {
      provider: "openai",
      model: "normal-home-model",
      project_root: realpathSync(normalProject),
      allowed_commands: ["git branch --show-current"],
      normal_profile_marker: "must-not-be-imported",
    };
    const originalBytes = `${JSON.stringify(normalConfig, null, 2)}\n`;
    writeFileSync(normalConfigFile, originalBytes, "utf8");

    const runPhase = (configDir?: string, action = "inspect"): Snapshot => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        APPDATA: join(home, "AppData", "Roaming"),
        LOCALAPPDATA: join(home, "AppData", "Local"),
        PROVIDER: "ollama",
        OLLAMA_MODEL: "environment-default-model",
        OLLAMA_BASE_URL: "http://localhost:4433/v1",
        OPENAI_BASE_URL: "https://api.openai.com/v1",
        PROFILE_TEST_HOME: home,
        PROFILE_TEST_PROJECT: isolatedProject,
        PROFILE_TEST_ACTION: action,
      };
      delete env.AI_TERMINAL_PROJECT_ROOT;
      if (configDir === undefined) delete env.AI_TERMINAL_CHAT_CONFIG_DIR;
      else env.AI_TERMINAL_CHAT_CONFIG_DIR = configDir;

      const child = spawnSync(process.execPath, [
        "--import", tsxLoader, "--input-type=module", "--eval", childProgram,
      ], { cwd, env, encoding: "utf8", timeout: 15000, windowsHide: true });
      expect(child.error, child.stderr).toBeUndefined();
      expect(child.status, child.stderr || child.stdout).toBe(0);
      expect(readFileSync(normalConfigFile, "utf8")).toBe(originalBytes);
      expect(readdirSync(normalConfigDir)).toEqual(["config.json"]);
      return JSON.parse(child.stdout.trim()) as Snapshot;
    };

    const assertEmptyProfile = (snapshot: Snapshot, configDir: string): void => {
      expect(snapshot.configFile).toBe(join(configDir, "config.json"));
      expect(snapshot.config).toEqual({});
      expect(snapshot.selection).toEqual({});
      expect(snapshot.projectRoot).toBe(realpathSync(cwd));
      expect(snapshot.allowedCommands).toEqual(snapshot.defaultAllowedCommands);
      expect(snapshot.providerStatus).toMatchObject({
        current: "ollama", model: "environment-default-model",
      });
    };

    assertEmptyProfile(runPhase(firstProfile), firstProfile);
    const saved = runPhase(firstProfile, "save");
    const expectedIsolatedConfig = {
      provider: "ollama",
      model: "isolated-profile-model",
      project_root: realpathSync(isolatedProject),
      allowed_commands: ["git status --short"],
      profile_marker: "isolated-profile",
    };
    expect(saved.config).toEqual(expectedIsolatedConfig);
    expect(JSON.parse(readFileSync(join(firstProfile, "config.json"), "utf8")))
      .toEqual(expectedIsolatedConfig);

    // A second process must restore this profile, while a different selected
    // profile remains empty even though both the first profile and home exist.
    const restarted = runPhase(firstProfile);
    expect(restarted.config).toEqual(expectedIsolatedConfig);
    expect(restarted.selection).toEqual({ provider: "ollama", model: "isolated-profile-model" });
    expect(restarted.projectRoot).toBe(realpathSync(isolatedProject));
    expect(restarted.allowedCommands).toEqual(["git status --short"]);
    expect(restarted.providerStatus).toMatchObject({ current: "ollama", model: "isolated-profile-model" });
    assertEmptyProfile(runPhase(secondProfile), secondProfile);

    const standalone = runPhase();
    expect(standalone.configFile).toBe(normalConfigFile);
    expect(standalone.config).toEqual(normalConfig);
    expect(standalone.projectRoot).toBe(realpathSync(normalProject));
    expect(standalone.allowedCommands).toEqual(normalConfig.allowed_commands);
    expect(standalone.providerStatus).toMatchObject({ current: "openai", model: "normal-home-model" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

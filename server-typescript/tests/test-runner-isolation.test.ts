import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const require = createRequire(import.meta.url);
const serverDirectory = fileURLToPath(new URL("..", import.meta.url));
const preloadUrl = new URL("../scripts/test-profile.mjs", import.meta.url).href;
const tsxLoaderUrl = pathToFileURL(require.resolve("tsx/esm")).href;

function withNormalHomeFixture(run: (home: string, configFile: string, sentinel: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "test-runner-normal-home-"));
  const home = join(root, "ordinary home");
  const configFile = join(home, ".ai-terminal-chat", "config.json");
  const sentinel = '{"provider":"ordinary-provider","model":"preserve-this-model","allowed_commands":["ordinary-command"]}\n';
  mkdirSync(dirname(configFile), { recursive: true });
  writeFileSync(configFile, sentinel);
  try {
    run(home, configFile, sentinel);
    expect(readFileSync(configFile, "utf8")).toBe(sentinel);
    expect(readdirSync(dirname(configFile))).toEqual(["config.json"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runIsolatedNode(home: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", preloadUrl, "--import", tsxLoaderUrl, ...args], {
    cwd: serverDirectory,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"),
      LOCALAPPDATA: join(home, "AppData", "Local"),
      AI_TERMINAL_CHAT_CONFIG_DIR: join(home, ".ai-terminal-chat"),
    },
    encoding: "utf8",
    timeout: 25000,
    windowsHide: true,
  });
}

it("the Vitest runner isolates its own home and configuration before loading test modules", () => {
  const configDirectory = process.env.AI_TERMINAL_CHAT_CONFIG_DIR;
  expect(configDirectory).toBeTruthy();
  const profileRoot = dirname(configDirectory!);
  expect(basename(profileRoot)).toMatch(/^ai-terminal-chat-test-profile-/);
  expect(configDirectory).toBe(join(profileRoot, "backend-config"));
  expect(process.env.HOME).toBe(join(profileRoot, "home"));
  expect(process.env.USERPROFILE).toBe(process.env.HOME);
  expect(process.env.APPDATA).toBe(join(profileRoot, "home", "AppData", "Roaming"));
  expect(process.env.LOCALAPPDATA).toBe(join(profileRoot, "home", "AppData", "Local"));
  expect(existsSync(configDirectory!)).toBe(true);
});

it("preloads disposable home and configuration paths before persistence, then removes them", () => {
  withNormalHomeFixture((home) => {
    const program = `
      import { testProfileRoot } from ${JSON.stringify(preloadUrl)};
      const { persistAppConfig } = await import(${JSON.stringify(new URL("../src/config.ts", import.meta.url).href)});
      persistAppConfig({ test_marker: "disposable-profile" });
      console.log(JSON.stringify({
        root: testProfileRoot,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        APPDATA: process.env.APPDATA,
        LOCALAPPDATA: process.env.LOCALAPPDATA,
        AI_TERMINAL_CHAT_CONFIG_DIR: process.env.AI_TERMINAL_CHAT_CONFIG_DIR,
      }));
    `;
    const child = runIsolatedNode(home, ["--input-type=module", "--eval", program]);
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stderr || child.stdout).toBe(0);
    const profile = JSON.parse(child.stdout.trim()) as Record<string, string>;
    expect(profile.HOME).toBe(join(profile.root, "home"));
    expect(profile.USERPROFILE).toBe(profile.HOME);
    expect(profile.APPDATA).toBe(join(profile.HOME, "AppData", "Roaming"));
    expect(profile.LOCALAPPDATA).toBe(join(profile.HOME, "AppData", "Local"));
    expect(profile.AI_TERMINAL_CHAT_CONFIG_DIR).toBe(join(profile.root, "backend-config"));
    expect(profile.HOME).not.toBe(home);
    expect(existsSync(profile.root)).toBe(false);
  });
}, 30000);

it("an existing persistence-writing unit suite leaves the ordinary home configuration unchanged", () => {
  withNormalHomeFixture((home) => {
    // This suite's afterEach persists command defaults. Exercise it unchanged
    // through the same preload order as npm run test:unit.
    const child = runIsolatedNode(home, [
      "--test", fileURLToPath(new URL("../src/trusted-exec.test.ts", import.meta.url)),
    ]);
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.status, child.stderr || child.stdout).toBe(0);
    expect(child.stdout).toMatch(/(?:pass\s+[1-9]|"passed":\s*[1-9])/);
  });
}, 30000);

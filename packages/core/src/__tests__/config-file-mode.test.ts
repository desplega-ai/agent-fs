import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { chmodSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getConfig, getConfigPath, setConfig, setConfigValue } from "../config.js";

const mode = (path: string) => statSync(path).mode & 0o777;

describe.skipIf(process.platform === "win32")("config file permissions", () => {
  let root: string;
  let home: string;
  let savedHome: string | undefined;
  let savedUmask: number;

  beforeEach(() => {
    savedHome = process.env.AGENT_FS_HOME;
    savedUmask = process.umask(0o022);
    root = join(tmpdir(), `agent-fs-mode-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(root, { recursive: true });
    home = join(root, "home");
    process.env.AGENT_FS_HOME = home;
  });

  afterEach(() => {
    process.umask(savedUmask);
    if (savedHome !== undefined) process.env.AGENT_FS_HOME = savedHome;
    else delete process.env.AGENT_FS_HOME;
    rmSync(root, { recursive: true, force: true });
  });

  test("control: a stored key round-trips through the config file", () => {
    setConfigValue("auth.apiKey", "af_dummy_key");
    expect(getConfig().auth.apiKey).toBe("af_dummy_key");
  });

  test("a fresh home dir is 0700 and config.json is 0600", () => {
    setConfigValue("auth.apiKey", "af_dummy_key");
    expect(mode(getConfigPath())).toBe(0o600);
    expect(mode(home)).toBe(0o700);
  });

  test("an existing 0755 home and 0644 config.json are tightened on the next write", () => {
    mkdirSync(home, { recursive: true });
    chmodSync(home, 0o755);
    writeFileSync(getConfigPath(), "{}");
    chmodSync(getConfigPath(), 0o644);

    setConfig("apiKey", "af_dummy_remote_key");

    expect(mode(getConfigPath())).toBe(0o600);
    expect(mode(home)).toBe(0o700);
  });
});

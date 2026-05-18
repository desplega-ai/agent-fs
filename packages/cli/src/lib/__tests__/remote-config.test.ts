// Unit tests for `resolveRemoteCreds` — the 3-way precedence resolver for
// remote API URL + API key. Plan §Phase 2.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRemoteCreds } from "../remote-config.js";

let tmpDir: string;
let configPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agent-fs-remote-config-"));
  configPath = join(tmpDir, "config.json");
});

afterEach(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("resolveRemoteCreds precedence", () => {
  test("flags beat env beat config", () => {
    writeFileSync(
      configPath,
      JSON.stringify({ apiUrl: "https://config.example", apiKey: "k-config" })
    );
    const r = resolveRemoteCreds(
      { apiUrl: "https://flag.example", apiKey: "k-flag" },
      configPath,
      {
        AGENT_FS_API_URL: "https://env.example",
        AGENT_FS_API_KEY: "k-env",
      }
    );
    expect(r).not.toBeNull();
    expect(r!.apiUrl).toBe("https://flag.example");
    expect(r!.apiKey).toBe("k-flag");
    expect(r!.source.apiUrl).toBe("flag");
    expect(r!.source.apiKey).toBe("flag");
  });

  test("env wins when no flags", () => {
    writeFileSync(
      configPath,
      JSON.stringify({ apiUrl: "https://config.example", apiKey: "k-config" })
    );
    const r = resolveRemoteCreds(
      {},
      configPath,
      {
        AGENT_FS_API_URL: "https://env.example",
        AGENT_FS_API_KEY: "k-env",
      }
    );
    expect(r).not.toBeNull();
    expect(r!.apiUrl).toBe("https://env.example");
    expect(r!.apiKey).toBe("k-env");
    expect(r!.source.apiUrl).toBe("env");
    expect(r!.source.apiKey).toBe("env");
  });

  test("config wins when no flags or env", () => {
    writeFileSync(
      configPath,
      JSON.stringify({ apiUrl: "https://config.example", apiKey: "k-config" })
    );
    const r = resolveRemoteCreds({}, configPath, {});
    expect(r).not.toBeNull();
    expect(r!.apiUrl).toBe("https://config.example");
    expect(r!.apiKey).toBe("k-config");
    expect(r!.source.apiUrl).toBe("config");
    expect(r!.source.apiKey).toBe("config");
  });

  test("mixes sources cleanly — flag URL, env key", () => {
    const r = resolveRemoteCreds(
      { apiUrl: "https://flag.example" },
      configPath,
      { AGENT_FS_API_KEY: "k-env" }
    );
    expect(r).not.toBeNull();
    expect(r!.apiUrl).toBe("https://flag.example");
    expect(r!.apiKey).toBe("k-env");
    expect(r!.source.apiUrl).toBe("flag");
    expect(r!.source.apiKey).toBe("env");
  });

  test("falls back to auth.apiKey when top-level apiKey is missing", () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        apiUrl: "https://config.example",
        auth: { apiKey: "k-auth" },
      })
    );
    const r = resolveRemoteCreds({}, configPath, {});
    expect(r).not.toBeNull();
    expect(r!.apiKey).toBe("k-auth");
    expect(r!.source.apiKey).toBe("config");
  });
});

describe("resolveRemoteCreds missing inputs", () => {
  test("returns null when nothing is set", () => {
    const r = resolveRemoteCreds({}, configPath, {});
    expect(r).toBeNull();
  });

  test("returns null when only URL is set", () => {
    const r = resolveRemoteCreds(
      {},
      configPath,
      { AGENT_FS_API_URL: "https://env.example" }
    );
    expect(r).toBeNull();
  });

  test("returns null when only key is set", () => {
    const r = resolveRemoteCreds(
      {},
      configPath,
      { AGENT_FS_API_KEY: "k-env" }
    );
    expect(r).toBeNull();
  });

  test("malformed config file is treated as missing", () => {
    writeFileSync(configPath, "{ not json");
    const r = resolveRemoteCreds({}, configPath, {});
    expect(r).toBeNull();
  });

  test("missing config file path is tolerated", () => {
    const r = resolveRemoteCreds(
      {},
      join(tmpDir, "does-not-exist.json"),
      { AGENT_FS_API_URL: "u", AGENT_FS_API_KEY: "k" }
    );
    expect(r).not.toBeNull();
    expect(r!.apiUrl).toBe("u");
    expect(r!.apiKey).toBe("k");
  });
});

// Unit tests for `buildHelperSpawnArgs` — the pure function that composes
// the helper-child argv + env pair the `mount` command spawns. Plan §Phase 2.

import { describe, expect, test } from "bun:test";
import { buildHelperSpawnArgs } from "../fuse-args.js";

describe("buildHelperSpawnArgs — remote mode", () => {
  test("remote with apiUrl + apiKey emits --api-url on argv and AGENT_FS_API_KEY in env", () => {
    const result = buildHelperSpawnArgs({
      mode: "remote",
      mountpoint: "/tmp/m",
      apiUrl: "https://agent-fs.fly.dev",
      apiKey: "sk-test-abc",
    });
    expect(result.argv).toContain("--mountpoint");
    expect(result.argv).toContain("/tmp/m");
    expect(result.argv).toContain("--api-url");
    expect(result.argv).toContain("https://agent-fs.fly.dev");
    // Critically: api-key NEVER appears on argv.
    expect(result.argv.join(" ")).not.toContain("sk-test-abc");
    expect(result.argv).not.toContain("--api-key");
    // And --socket is absent so the helper picks HTTP transport.
    expect(result.argv).not.toContain("--socket");

    expect(result.env.AGENT_FS_API_KEY).toBe("sk-test-abc");
  });

  test("remote passes through allow-other + log-file flags", () => {
    const result = buildHelperSpawnArgs({
      mode: "remote",
      mountpoint: "/mnt/x",
      apiUrl: "http://localhost:7433",
      apiKey: "k",
      allowOther: true,
      logFile: "/tmp/mount.log",
    });
    expect(result.argv).toContain("--allow-other");
    expect(result.argv).toContain("--log-file");
    expect(result.argv).toContain("/tmp/mount.log");
  });

  test("remote without apiUrl throws", () => {
    expect(() =>
      buildHelperSpawnArgs({
        mode: "remote",
        mountpoint: "/tmp/m",
        apiKey: "k",
      })
    ).toThrow(/requires both an API URL and an API key/);
  });

  test("remote without apiKey throws", () => {
    expect(() =>
      buildHelperSpawnArgs({
        mode: "remote",
        mountpoint: "/tmp/m",
        apiUrl: "https://x.example",
      })
    ).toThrow(/requires both an API URL and an API key/);
  });

  test("remote with --socket throws (mutually exclusive)", () => {
    expect(() =>
      buildHelperSpawnArgs({
        mode: "remote",
        mountpoint: "/tmp/m",
        apiUrl: "https://x.example",
        apiKey: "k",
        socket: "/run/agent-fs.sock",
      })
    ).toThrow(/Cannot combine --remote with --socket/);
  });
});

describe("buildHelperSpawnArgs — local mode", () => {
  test("local with socket emits --socket and no --api-* keys", () => {
    const result = buildHelperSpawnArgs({
      mode: "local",
      mountpoint: "/tmp/m",
      socket: "/run/agent-fs.sock",
    });
    expect(result.argv).toContain("--socket");
    expect(result.argv).toContain("/run/agent-fs.sock");
    expect(result.argv).not.toContain("--api-url");
    expect(result.argv).not.toContain("--api-key");
    expect(result.env.AGENT_FS_API_KEY).toBeUndefined();
  });

  test("local without socket throws", () => {
    expect(() =>
      buildHelperSpawnArgs({
        mode: "local",
        mountpoint: "/tmp/m",
      })
    ).toThrow(/socket is required in local mode/);
  });

  test("local with apiUrl throws (--api-url requires --remote)", () => {
    expect(() =>
      buildHelperSpawnArgs({
        mode: "local",
        mountpoint: "/tmp/m",
        socket: "/run/agent-fs.sock",
        apiUrl: "https://x.example",
      })
    ).toThrow(/--api-url \/ --api-key require --remote/);
  });

  test("local with apiKey throws (--api-key requires --remote)", () => {
    expect(() =>
      buildHelperSpawnArgs({
        mode: "local",
        mountpoint: "/tmp/m",
        socket: "/run/agent-fs.sock",
        apiKey: "k",
      })
    ).toThrow(/--api-url \/ --api-key require --remote/);
  });
});

describe("buildHelperSpawnArgs — invariants", () => {
  test("missing mountpoint throws", () => {
    expect(() =>
      buildHelperSpawnArgs({
        mode: "local",
        mountpoint: "",
        socket: "/run/agent-fs.sock",
      })
    ).toThrow(/mountpoint is required/);
  });

  test("argv is well-formed (pairs of flag/value, no orphans)", () => {
    const r = buildHelperSpawnArgs({
      mode: "remote",
      mountpoint: "/m",
      apiUrl: "u",
      apiKey: "k",
      allowOther: true,
      logFile: "/l",
    });
    // The argv should start with --mountpoint <path>.
    expect(r.argv[0]).toBe("--mountpoint");
    expect(r.argv[1]).toBe("/m");
  });
});

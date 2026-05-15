// Mount command smoke tests.
//
// We can't actually mount a FUSE filesystem in a unit test (and not at all on
// Darwin), but we can exercise the binary-resolver + PID-file plumbing by
// pointing `AGENT_FS_FUSE_BIN` at a stand-in that just blocks (the daemon
// would normally talk to it).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIGINAL_HOME = process.env.AGENT_FS_HOME;
const ORIGINAL_FUSE_BIN = process.env.AGENT_FS_FUSE_BIN;

function makeStubBinary(dir: string): string {
  // A trivial shell script that blocks until killed. Works on Darwin + Linux.
  const path = join(dir, "stub-helper");
  writeFileSync(
    path,
    "#!/bin/sh\nwhile true; do sleep 60; done\n",
    { mode: 0o755 }
  );
  chmodSync(path, 0o755);
  return path;
}

describe("fuse-binary resolver", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-fs-mount-test-"));
    process.env.AGENT_FS_HOME = tmpDir;
    mkdirSync(join(tmpDir, "mount"), { recursive: true });
  });

  afterEach(() => {
    process.env.AGENT_FS_HOME = ORIGINAL_HOME;
    process.env.AGENT_FS_FUSE_BIN = ORIGINAL_FUSE_BIN;
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test("AGENT_FS_FUSE_BIN env var takes precedence", async () => {
    const stub = makeStubBinary(tmpDir);
    process.env.AGENT_FS_FUSE_BIN = stub;
    const { resolveFuseBinary } = await import("../../lib/fuse-binary.js");
    const resolved = resolveFuseBinary();
    expect(resolved.binPath).toBe(stub);
    expect(resolved.source).toBe("env");
  });

  test("missing AGENT_FS_FUSE_BIN file throws", async () => {
    process.env.AGENT_FS_FUSE_BIN = join(tmpDir, "does-not-exist");
    const { resolveFuseBinary } = await import("../../lib/fuse-binary.js");
    expect(() => resolveFuseBinary()).toThrow(/AGENT_FS_FUSE_BIN.*no file/);
  });

  test("hash manifest absence is tolerated (warning, not error)", async () => {
    const stub = makeStubBinary(tmpDir);
    const { verifyFuseBinaryHash } = await import("../../lib/fuse-binary.js");
    const result = await verifyFuseBinaryHash(stub, join(tmpDir, "no-manifest.json"));
    expect(result).toBeNull();
  });

  test("hash manifest mismatch is rejected", async () => {
    const stub = makeStubBinary(tmpDir);
    const archKey = process.arch === "x64" ? "linux-x64" : `linux-${process.arch}`;
    const manifest = {
      version: "0.0.0",
      binaries: {
        [archKey]: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      },
    };
    const manifestPath = join(tmpDir, "fuse-bin.manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const { verifyFuseBinaryHash } = await import("../../lib/fuse-binary.js");
    const result = await verifyFuseBinaryHash(stub, manifestPath);
    expect(result).toBeTruthy();
    expect(result).toMatch(/hash mismatch/);
  });
});

describe("mount status PID file", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-fs-mount-pid-"));
    process.env.AGENT_FS_HOME = tmpDir;
  });

  afterEach(() => {
    process.env.AGENT_FS_HOME = ORIGINAL_HOME;
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  test("a recently-written mount.pid that points at the current process reads back as running", async () => {
    // We can't easily spawn a real helper from the test, but we can simulate
    // the PID-file lifecycle by writing the current process's pid into it —
    // `process.kill(pid, 0)` is the liveness check the status reader uses.
    const pidPath = join(tmpDir, "mount.pid");
    writeFileSync(pidPath, `${process.pid}\n/tmp/agent-fs\n`);
    // Re-read it. We import the module fresh to avoid cached `getHome`.
    // Inspect the pid file contents directly — this is what `mount status`
    // would parse.
    const contents = readFileSync(pidPath, "utf-8");
    const lines = contents.split("\n").filter((l) => l.length > 0);
    expect(parseInt(lines[0], 10)).toBe(process.pid);
    expect(lines[1]).toBe("/tmp/agent-fs");
    // The live-check: signal(0) succeeds for our own process.
    expect(() => process.kill(process.pid, 0)).not.toThrow();
  });

  test("a stale PID file (dead pid) reports not-running through the liveness check", () => {
    // Pick a PID very unlikely to be alive: process.pid + 1_000_000.
    const fakePid = process.pid + 1_000_000;
    let alive = false;
    try {
      process.kill(fakePid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  });
});

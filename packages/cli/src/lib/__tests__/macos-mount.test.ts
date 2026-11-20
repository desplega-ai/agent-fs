import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deadNfsMount, runNfsUnmount } from "../../commands/nfs-mount.js";
import {
  launchAgentPlist,
  mountNfsArgv,
  readDeadNfsState,
  readNfsState,
  writeNfsState,
  quickActionScript,
  quickActionWflow,
  webUrlFor,
} from "../macos-mount.js";

const state = {
  mountpoint: "/Users/t/agent-fs",
  orgId: "org-1",
  driveId: "drive-1",
  appUrl: "https://live.agent-fs.dev/",
};

describe("webUrlFor", () => {
  test("maps a mounted path to its live.agent-fs.dev deep link", () => {
    expect(webUrlFor(state, "/Users/t/agent-fs/notes/plan.md")).toBe(
      "https://live.agent-fs.dev/file/~/org-1/drive-1/notes/plan.md"
    );
  });

  test("percent-encodes each segment (spaces, #, ?)", () => {
    expect(webUrlFor(state, "/Users/t/agent-fs/My Notes/a#1?.md")).toBe(
      "https://live.agent-fs.dev/file/~/org-1/drive-1/My%20Notes/a%231%3F.md"
    );
  });

  test("the mount root opens the drive root", () => {
    expect(webUrlFor(state, "/Users/t/agent-fs")).toBe("https://live.agent-fs.dev/file/~/org-1/drive-1/");
  });

  test("paths outside the mount, including a sibling prefix, are refused", () => {
    expect(webUrlFor(state, "/Users/t/Documents/a.md")).toBeNull();
    expect(webUrlFor(state, "/Users/t/agent-fs-other/a.md")).toBeNull();
    expect(webUrlFor({ ...state, mountpoint: null }, "/Users/t/agent-fs/a.md")).toBeNull();
  });
});

describe("mountNfsArgv", () => {
  test("uses the built-in mount_nfs on loopback with the server port for both programs", () => {
    const argv = mountNfsArgv(20490, "/Users/t/agent-fs");
    expect(argv[0]).toBe("/sbin/mount_nfs");
    expect(argv[2]).toContain("vers=3,tcp,port=20490,mountport=20490");
    expect(argv.slice(3)).toEqual(["127.0.0.1:/", "/Users/t/agent-fs"]);
  });
});

describe("LaunchAgent and Quick Action", () => {
  test("plist runs the mount in the foreground with pinned org and drive, XML-escaped", () => {
    const plist = launchAgentPlist({
      cli: ["/Users/t/.bun/bin/bun", "/Users/t/a&b/cli.js"],
      orgId: "org-1",
      driveId: "drive-1",
      mountpoint: "/Users/t/agent-fs",
      logPath: "/Users/t/.agent-fs/mount.log",
      env: { AGENT_FS_API_KEY: "k<1>" },
    });
    expect(plist).toContain("<string>/Users/t/a&amp;b/cli.js</string>");
    expect(plist).toMatch(/<string>--org<\/string>\s*<string>org-1<\/string>\s*<string>--drive<\/string>\s*<string>drive-1<\/string>\s*<string>mount<\/string>\s*<string>\/Users\/t\/agent-fs<\/string>\s*<string>--foreground<\/string>/);
    expect(plist).toContain("<string>k&lt;1&gt;</string>");
    expect(plist).toContain("<key>RunAtLoad</key>");
  });

  test("Quick Action script shell-quotes the CLI and opens every selected file", () => {
    const script = quickActionScript(["/Users/t/.bun/bin/bun", "/Users/t/it's/cli.js"], { AGENT_FS_HOME: "/Users/t/.agent-fs" });
    expect(script).toBe(
      "export AGENT_FS_HOME='/Users/t/.agent-fs'\n" +
        `for f in "$@"; do '/Users/t/.bun/bin/bun' '/Users/t/it'\\''s/cli.js' open "$f"; done\n`
    );
    expect(quickActionWflow(script)).toContain("for f in &quot;$@&quot;");
  });
});

describe("mount state file", () => {
  let home: string;
  let saved: string | undefined;
  const mount = { mountpoint: "/Users/t/agent-fs", port: 20490, orgId: "org-1", driveId: "drive-1", appUrl: "https://live.agent-fs.dev" };

  beforeEach(() => {
    saved = process.env.AGENT_FS_HOME;
    home = mkdtempSync(join(tmpdir(), "agent-fs-state-"));
    process.env.AGENT_FS_HOME = home;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.AGENT_FS_HOME;
    else process.env.AGENT_FS_HOME = saved;
    rmSync(home, { recursive: true, force: true });
  });

  test("no state file: neither a running nor a dead mount", () => {
    expect(readNfsState()).toBeNull();
    expect(readDeadNfsState()).toBeNull();
  });

  test("a running server is the live mount", () => {
    writeNfsState({ pid: process.pid, ...mount });
    expect(readNfsState()?.mountpoint).toBe(mount.mountpoint);
    expect(readDeadNfsState()).toBeNull();
  });

  test("a server killed before it cleaned up leaves a dead mount that unmount can still find", async () => {
    const gone = Bun.spawn(["/usr/bin/true"]);
    await gone.exited;
    writeNfsState({ pid: gone.pid, ...mount });
    expect(readNfsState()).toBeNull();
    expect(readDeadNfsState()).toEqual({ pid: gone.pid, ...mount });
  });

  // Reads the macOS mount table. "/" stands in for a dead mount: it is always mounted, and unmount is never called on it.
  test.skipIf(process.platform !== "darwin")("unmount of a different path keeps the record of a dead mount that is still mounted", async () => {
    const gone = Bun.spawn(["/usr/bin/true"]);
    await gone.exited;
    writeNfsState({ pid: gone.pid, ...mount, mountpoint: "/" });
    expect((await deadNfsMount())?.mountpoint).toBe("/");
    await runNfsUnmount(join(home, "not-a-mount"));
    expect((await deadNfsMount())?.mountpoint).toBe("/");
  });
});

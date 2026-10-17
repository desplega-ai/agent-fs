import { describe, expect, test } from "bun:test";
import { Bash, type IFileSystem, InMemoryFs, MountableFs } from "just-bash";
import { AgentFsFileSystem, type AgentFsFileSystemOptions } from "../index.js";
import { createMockFetch } from "./mock-agent-fs.js";

// The session an agent-swarm script runs: the drive mounted at /afs over an
// in-memory base, file calls through the mount, and shell commands over it.
async function runSession(options: Partial<AgentFsFileSystemOptions> = {}) {
  const { fetch, files, requests } = createMockFetch();
  files.set("/notes/seed.md", {
    bytes: new TextEncoder().encode("hello from the drive\nsecond line\n"),
    modifiedAt: new Date("2026-10-16T00:00:00.000Z"),
    version: 1,
  });
  // Typed as just-bash's interface: the adapter mounts without a cast.
  const drive: IFileSystem = new AgentFsFileSystem({
    baseUrl: "http://agent.test",
    orgId: "org",
    driveId: "drive",
    fetch,
    ...options,
  });
  const fs = new MountableFs({ base: new InMemoryFs() });
  fs.mount("/afs", drive);
  const bash = new Bash({ fs, cwd: "/afs" });

  await fs.mkdir("/afs/reports", { recursive: true });
  await fs.writeFile("/afs/reports/today.md", "hello report\nline two\nhello again\n");
  await fs.appendFile("/afs/reports/today.md", "appended\n");
  const grep = await bash.exec("grep -rn hello . | sort");
  const count = await bash.exec("wc -l < today.md", { cwd: "/afs/reports" });
  const glob = await bash.exec("ls notes/*.md");
  const missing = await bash.exec("cat /afs/missing.txt");
  await bash.exec("echo from-bash > /afs/reports/bash.txt");

  return {
    requests,
    files,
    output: {
      grep: grep.stdout,
      count: count.stdout.trim(),
      glob: glob.stdout.trim(),
      missingExit: missing.exitCode,
      readBack: await fs.readFile("/afs/reports/bash.txt"),
      listing: await fs.readdir("/afs/reports"),
      size: (await fs.stat("/afs/reports/today.md")).size,
    },
  };
}

const EXPECTED_OUTPUT = {
  grep: "notes/seed.md:1:hello from the drive\nreports/today.md:1:hello report\nreports/today.md:3:hello again\n",
  count: "4",
  glob: "notes/seed.md",
  missingExit: 1,
  readBack: "from-bash\n",
  listing: ["bash.txt", "today.md"],
  size: 43,
};

describe("AgentFsFileSystem under just-bash", () => {
  test("runs a mixed file and shell session over a mounted drive", async () => {
    const { output, files, requests } = await runSession();

    expect(output).toEqual(EXPECTED_OUTPUT);
    expect(new TextDecoder().decode(files.get("/reports/today.md")?.bytes)).toBe(
      "hello report\nline two\nhello again\nappended\n",
    );
    // 42 without the stat/ls cache (next test). The rest are the reads and
    // writes themselves, plus one listing per folder.
    expect(requests).toHaveLength(17);
    expect(requests.filter((request) => request.startsWith("stat "))).toEqual([
      "stat /reports",
    ]);
  });

  test("gives the same result with the cache off", async () => {
    const { output, requests } = await runSession({ cacheTtlMs: 0 });

    expect(output).toEqual(EXPECTED_OUTPUT);
    expect(requests).toHaveLength(42);
  });
});

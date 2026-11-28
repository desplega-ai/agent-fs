import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A command that needs no org or drive must not call the API to resolve
// --org or --drive: it has to work while the daemon is down.
test.each([
  [["config", "get", "server.port"], /^\d+$/],
  [["mount", "status"], /./],
])("a local command ignores --org and --drive with the API offline: %p", async (command, expected) => {
  const home = mkdtempSync(join(tmpdir(), "agent-fs-offline-"));
  try {
    const proc = Bun.spawn(
      [process.execPath, "run", join(import.meta.dir, "../index.ts"), "--org", "acme", "--drive", "notes", ...command],
      {
        env: { ...process.env, AGENT_FS_HOME: home, AGENT_FS_API_URL: "http://127.0.0.1:9", AGENT_FS_API_KEY: "unused" },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(expected);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

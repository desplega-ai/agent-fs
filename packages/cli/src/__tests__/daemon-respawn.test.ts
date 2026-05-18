import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Regression test for the `agent-fs daemon start` ENOENT bug fixed in Phase 1
// of the 2026-05-18 FUSE remote-mount plan.
//
// Before the fix, daemon.ts used an `isCompiled` heuristic that only
// recognized Bun's single-file executable layout (`/$bunfs/...`). On an
// npm-installed CLI, `import.meta.dir` is an ordinary absolute path
// (`/usr/lib/node_modules/@desplega.ai/agent-fs/dist`) so the daemon would
// try to `bun run .../dist/index.ts` — a file that doesn't ship in the
// published tarball — producing a `Module not found` error in
// `~/.agent-fs/agent-fs.log`.
//
// This test synthesizes the npm-install layout in a tmp dir, points the CLI
// at an isolated AGENT_FS_HOME, runs `daemon start`, and asserts the log
// does not contain `Module not found`.

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../../..");
const builtCli = resolve(repoRoot, "packages/cli/dist/cli.js");

let tmpRoot: string;
let installDir: string;
let agentFsHome: string;
let cliPath: string;

beforeAll(() => {
  // Require the CLI bundle to exist. Run `bun run build` first.
  if (!existsSync(builtCli)) {
    throw new Error(
      `dist/cli.js not found at ${builtCli}. Run \`bun run build\` first.`,
    );
  }

  tmpRoot = join(
    tmpdir(),
    `agent-fs-daemon-respawn-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`,
  );
  installDir = join(tmpRoot, "node_modules", "@desplega.ai", "agent-fs", "dist");
  agentFsHome = join(tmpRoot, "home");

  mkdirSync(installDir, { recursive: true });
  mkdirSync(agentFsHome, { recursive: true });

  cliPath = join(installDir, "cli.js");
  copyFileSync(builtCli, cliPath);
});

afterAll(() => {
  // Best-effort: stop any daemon that may still be running, then clean up.
  if (tmpRoot && existsSync(tmpRoot)) {
    const pidFile = join(agentFsHome, "agent-fs.pid");
    if (existsSync(pidFile)) {
      try {
        const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
        if (Number.isFinite(pid)) {
          try {
            process.kill(pid, "SIGTERM");
          } catch {
            /* ignore — already gone */
          }
        }
      } catch {
        /* ignore */
      }
    }
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("daemon start respawn", () => {
  test(
    "spawned daemon in synthesized npm-install layout does not hit 'Module not found'",
    async () => {
      // Run `bun <cliPath> daemon start` with an isolated home.
      const env = {
        ...process.env,
        AGENT_FS_HOME: agentFsHome,
      };

      const result = spawnSync(process.execPath, [cliPath, "daemon", "start"], {
        env,
        encoding: "utf-8",
        timeout: 10_000,
      });

      // `daemon start` itself returns quickly (it just spawns the child).
      // The actual respawned daemon writes to ~/.agent-fs/agent-fs.log.
      // Even a clean respawn may fail to *fully* start (no S3 creds in tmp),
      // but it must not fail with "Module not found" — that's the bug.
      expect(result.error).toBeUndefined();

      const logPath = join(agentFsHome, "agent-fs.log");

      // Wait up to 5s for the daemon child to emit something — either it
      // started its server or it crashed with an error in the log.
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if (existsSync(logPath)) {
          const contents = readFileSync(logPath, "utf-8");
          // Bail early once we see *any* meaningful output.
          if (contents.length > 0) break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      const log = existsSync(logPath) ? readFileSync(logPath, "utf-8") : "";

      // The critical regression assertion: the old `isCompiled` heuristic
      // would spawn `bun run .../dist/index.ts` (a file that doesn't exist
      // in the npm tarball) and bun would emit a `Module not found` error.
      expect(log).not.toContain("Module not found");
      // Belt-and-suspenders: also reject the legacy code path's specific
      // failure mode in case error wording shifts.
      expect(log).not.toContain("dist/index.ts");

      // Reap the spawned child if it's still alive — we don't care about
      // long-term daemon health in this test, only the respawn path.
      const pidFile = join(agentFsHome, "agent-fs.pid");
      if (existsSync(pidFile)) {
        try {
          const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
          if (Number.isFinite(pid)) {
            try {
              process.kill(pid, "SIGTERM");
            } catch {
              /* ignore */
            }
          }
        } catch {
          /* ignore */
        }
      }
    },
    15_000,
  );
});

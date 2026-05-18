import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync, openSync } from "node:fs";
import { join } from "node:path";
import { getHome } from "@/core";

function getPidPath(): string {
  return join(getHome(), "agent-fs.pid");
}

function getLogPath(): string {
  return join(getHome(), "agent-fs.log");
}

function getSocketPath(): string {
  return join(getHome(), "agent-fs.sock");
}

export function startDaemon(): void {
  const pidPath = getPidPath();
  if (existsSync(pidPath)) {
    const pid = parseInt(readFileSync(pidPath, "utf-8").trim());
    try {
      process.kill(pid, 0); // Check if process exists
      console.log(`Daemon already running (PID: ${pid})`);
      return;
    } catch {
      // Stale PID file — clean up
      unlinkSync(pidPath);
      // Also unlink a stale socket if no PID owns it anymore. Bun.listen
      // refuses to bind to an existing socket file, so leftover artifacts
      // from a hard-killed daemon must be cleaned out here.
      const sockPath = getSocketPath();
      if (existsSync(sockPath)) {
        try {
          unlinkSync(sockPath);
        } catch {
          /* ignore */
        }
      }
    }
  }

  const logPath = getLogPath();
  const logFd = openSync(logPath, "a");

  // Respawn `<runtime> <entry-script> server`. The entry script is whatever
  // the user launched (process.argv[1]) — works for:
  //   - npm install: entry is `.../dist/cli.js`
  //   - dev (bun run): entry is `packages/cli/src/index.ts`
  //   - bun --compile single-file: entry resolves to `/$bunfs/...`
  // process.execPath is the Bun runtime in all three cases.
  const entryScript = process.argv[1];
  if (!entryScript) {
    throw new Error(
      "Cannot determine entry script (process.argv[1] is empty). Daemon start aborted.",
    );
  }
  const child = spawn(process.execPath, [entryScript, "server"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });

  child.unref();

  if (child.pid) {
    writeFileSync(pidPath, String(child.pid));
    console.log(`Daemon started (PID: ${child.pid})`);
    console.log(`Logs: ${logPath}`);
  }
}

export function stopDaemon(): void {
  const pidPath = getPidPath();
  if (!existsSync(pidPath)) {
    console.log("Daemon is not running");
    return;
  }

  const pid = parseInt(readFileSync(pidPath, "utf-8").trim());
  try {
    process.kill(pid, "SIGTERM");
    console.log(`Daemon stopped (PID: ${pid})`);
  } catch {
    console.log(`Process ${pid} not found (already stopped)`);
  }
  unlinkSync(pidPath);
  // Best-effort socket cleanup in case the daemon didn't get a chance to
  // unlink it on its way out.
  const sockPath = getSocketPath();
  if (existsSync(sockPath)) {
    try {
      unlinkSync(sockPath);
    } catch {
      /* ignore */
    }
  }
}

export function daemonStatus(): { running: boolean; pid?: number } {
  const pidPath = getPidPath();
  if (!existsSync(pidPath)) return { running: false };

  const pid = parseInt(readFileSync(pidPath, "utf-8").trim());
  try {
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    return { running: false };
  }
}

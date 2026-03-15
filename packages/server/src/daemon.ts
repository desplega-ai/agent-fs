import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync, openSync } from "node:fs";
import { join } from "node:path";
import { getAgentFSHome } from "@agentfs/core";

function getPidPath(): string {
  return join(getAgentFSHome(), "agentfs.pid");
}

function getLogPath(): string {
  return join(getAgentFSHome(), "agentfs.log");
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
    }
  }

  const logPath = getLogPath();
  const logFd = openSync(logPath, "a");

  const serverPath = join(import.meta.dir, "index.ts");
  const child = spawn("bun", ["run", serverPath], {
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

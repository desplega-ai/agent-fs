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

  // In compiled binary, spawn self with "server" command.
  // In dev mode (bun run), spawn bun on the source file.
  const isCompiled = !import.meta.dir.startsWith("/") || import.meta.dir.startsWith("/$bunfs");
  const cmd = isCompiled ? process.execPath : "bun";
  const args = isCompiled ? ["server"] : ["run", join(import.meta.dir, "index.ts")];
  const child = spawn(cmd, args, {
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

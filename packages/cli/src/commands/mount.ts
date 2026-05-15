// `agent-fs mount` / `agent-fs umount` / `agent-fs mount status`.
//
// Spawns the Rust FUSE helper as a detached child process and tracks its PID
// in `~/.agent-fs/mount.pid`. The helper auto-unmounts on SIGTERM (we set
// `MountOption::AutoUnmount`), so `umount` is normally just a `kill -TERM`.
// `fusermount3 -u <path>` is the belt-and-suspenders fallback.

import { Command } from "commander";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  statSync,
  readdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { getHome } from "@/core";
import { resolveFuseBinary, verifyFuseBinaryHash } from "../lib/fuse-binary.js";

function getMountPidPath(): string {
  return join(getHome(), "mount.pid");
}

function getMountLogPath(): string {
  return join(getHome(), "mount.log");
}

function getSocketPath(): string {
  return join(getHome(), "agent-fs.sock");
}

/**
 * Locate `fuse-bin.manifest.json`.
 *
 * Resolution order:
 *   1. The manifest bundled next to the CLI entrypoint at publish time —
 *      `packages/cli/dist/fuse-bin.manifest.json`. This is the canonical path
 *      for the published artifact; `scripts/build-fuse-manifest.ts` writes it
 *      during the release workflow.
 *   2. `~/.agent-fs/fuse-bin.manifest.json` — escape hatch for users who
 *      drop a manifest into their home dir manually (or for legacy install
 *      layouts). Present for local dev.
 *
 * Returns the first path that exists, or the bundled path if neither exists
 * (so the warning message points users at the canonical location).
 */
function getManifestPath(): string {
  const bundled = (() => {
    try {
      // import.meta.url -> .../packages/cli/src/commands/mount.ts in source,
      // .../packages/cli/dist/cli.js when bundled. The manifest lives in dist/.
      const here = fileURLToPath(import.meta.url);
      const dir = dirname(here);
      // From dist/cli.js -> dist/fuse-bin.manifest.json
      // From src/commands/mount.ts -> ../../dist/fuse-bin.manifest.json
      const candidates = [
        join(dir, "fuse-bin.manifest.json"),
        join(dir, "..", "fuse-bin.manifest.json"),
        join(dir, "..", "..", "dist", "fuse-bin.manifest.json"),
      ];
      for (const c of candidates) {
        if (existsSync(c)) return c;
      }
      return candidates[0];
    } catch {
      return "";
    }
  })();

  const homeManifest = join(getHome(), "fuse-bin.manifest.json");
  if (bundled && existsSync(bundled)) return bundled;
  if (existsSync(homeManifest)) return homeManifest;
  // Fall through to bundled path so the error / warning surfaces the canonical location.
  return bundled || homeManifest;
}

interface MountStatus {
  running: boolean;
  pid?: number;
  mountpoint?: string;
}

function readMountStatus(): MountStatus {
  const pidPath = getMountPidPath();
  if (!existsSync(pidPath)) return { running: false };
  const raw = readFileSync(pidPath, "utf-8").trim();
  const [pidStr, ...rest] = raw.split("\n");
  const pid = parseInt(pidStr, 10);
  if (!Number.isFinite(pid)) return { running: false };
  try {
    process.kill(pid, 0);
  } catch {
    return { running: false };
  }
  const mountpoint = rest.join("\n").trim() || undefined;
  return { running: true, pid, mountpoint };
}

function writeMountPid(pid: number, mountpoint: string): void {
  writeFileSync(getMountPidPath(), `${pid}\n${mountpoint}\n`);
}

function clearMountPid(): void {
  const p = getMountPidPath();
  if (existsSync(p)) {
    try {
      unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}

export function mountCommand() {
  const cmd = new Command("mount")
    .description("FUSE mount commands for agent-fs (Linux only).")
    .argument("[path]", "Directory to mount the agent-fs filesystem at")
    .option("--socket <path>", "Path to the daemon's Unix socket")
    .option("--allow-other", "Allow other users to access the mount")
    .option("--foreground", "Run the helper in the foreground (logs to stdout)")
    .action(async (path: string | undefined, opts) => {
      if (!path) {
        cmd.help();
        return;
      }
      await runMount(path, opts);
    });

  cmd
    .command("status")
    .description("Show the current mount's PID and mountpoint")
    .action(async () => {
      const s = readMountStatus();
      if (!s.running) {
        console.log("Mount is not running");
        return;
      }
      console.log(`Mount PID: ${s.pid}`);
      if (s.mountpoint) console.log(`Mountpoint: ${s.mountpoint}`);
      const statusFile = s.mountpoint
        ? join(s.mountpoint, ".agent-fs", "status")
        : null;
      if (statusFile && existsSync(statusFile)) {
        try {
          console.log(`Status: ${readFileSync(statusFile, "utf-8").trim()}`);
        } catch {
          /* ignore */
        }
      }
    });

  return cmd;
}

export function umountCommand() {
  return new Command("umount")
    .description("Unmount a previously-mounted agent-fs FUSE filesystem")
    .argument("<path>", "Directory the filesystem is mounted at")
    .action(async (path: string) => {
      await runUmount(path);
    });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function runMount(
  pathArg: string,
  opts: { socket?: string; allowOther?: boolean; foreground?: boolean }
): Promise<void> {
  const mountpoint = pathArg;

  // Linux-only feature check. The `--help` path doesn't hit this — that's
  // handled by commander before our `.action` runs.
  if (process.platform !== "linux") {
    console.error(
      "FUSE mount is Linux-only.\n" +
        "For macOS dev: see `packages/fuse-helper/README.md` for the Docker harness."
    );
    process.exit(1);
  }

  // Mountpoint must exist + be an empty directory.
  if (!existsSync(mountpoint)) {
    console.error(`Mountpoint does not exist: ${mountpoint}`);
    process.exit(1);
  }
  try {
    const st = statSync(mountpoint);
    if (!st.isDirectory()) {
      console.error(`Mountpoint is not a directory: ${mountpoint}`);
      process.exit(1);
    }
  } catch (err: any) {
    console.error(`Cannot stat mountpoint: ${err.message}`);
    process.exit(1);
  }
  try {
    const entries = readdirSync(mountpoint);
    if (entries.length > 0) {
      console.error(`Mountpoint is not empty: ${mountpoint}`);
      process.exit(1);
    }
  } catch (err: any) {
    console.error(`Cannot read mountpoint: ${err.message}`);
    process.exit(1);
  }

  // Bail early if a mount is already running.
  const existing = readMountStatus();
  if (existing.running) {
    console.error(
      `A mount is already running (PID ${existing.pid}` +
        (existing.mountpoint ? `, ${existing.mountpoint}` : "") +
        ")."
    );
    console.error("Run `agent-fs umount <path>` to tear it down first.");
    process.exit(1);
  }

  // Ensure the daemon's Unix socket exists. We don't auto-start the daemon
  // here — the user explicitly opted into the mount; if their daemon's down
  // they need to know. (Auto-start would silently take over the user's env.)
  const socketPath = opts.socket ?? getSocketPath();
  if (!existsSync(socketPath)) {
    console.error(`Daemon socket not found at ${socketPath}.`);
    console.error("Start the daemon first: agent-fs daemon start");
    process.exit(1);
  }

  // Resolve the helper binary.
  let resolved;
  try {
    resolved = resolveFuseBinary();
  } catch (err: any) {
    console.error(err.message);
    process.exit(1);
  }
  const manifestErr = await verifyFuseBinaryHash(resolved.binPath, getManifestPath());
  if (manifestErr) {
    console.error(`Refusing to spawn helper: ${manifestErr}`);
    process.exit(1);
  }
  // Phase 4 ships the manifest; warn (but proceed) when missing in v1.
  if (!existsSync(getManifestPath())) {
    console.error(
      "Warning: no fuse-bin.manifest.json found — skipping hash verification."
    );
  }

  // Spawn the helper.
  const args: string[] = [
    "--mountpoint",
    mountpoint,
    "--socket",
    socketPath,
    "--log-file",
    getMountLogPath(),
  ];
  if (opts.allowOther) args.push("--allow-other");

  if (opts.foreground) {
    const child = spawn(resolved.binPath, args, { stdio: "inherit" });
    child.on("exit", (code) => {
      clearMountPid();
      process.exit(code ?? 0);
    });
    if (child.pid) writeMountPid(child.pid, mountpoint);
    return;
  }

  const child = spawn(resolved.binPath, args, {
    detached: true,
    stdio: "ignore",
  });
  if (child.pid === undefined) {
    console.error("Failed to spawn FUSE helper.");
    process.exit(1);
  }
  writeMountPid(child.pid, mountpoint);
  child.unref();
  console.log(`Mount started (PID: ${child.pid}, ${resolved.source})`);
  console.log(`Mountpoint: ${mountpoint}`);
  console.log(`Logs: ${getMountLogPath()}`);
}

async function runUmount(mountpoint: string): Promise<void> {
  if (process.platform !== "linux") {
    console.error("FUSE umount is Linux-only.");
    process.exit(1);
  }

  // Best-effort: SIGTERM the helper PID, then fusermount3 -u as fallback.
  const status = readMountStatus();
  if (status.running && status.pid !== undefined) {
    try {
      process.kill(status.pid, "SIGTERM");
      console.log(`Sent SIGTERM to mount helper (PID: ${status.pid})`);
    } catch (err: any) {
      console.error(`Failed to signal helper: ${err.message}`);
    }
  } else {
    console.log("No running mount PID recorded.");
  }

  // Run fusermount3 -u (or fusermount -u) for good measure.
  for (const cmd of ["fusermount3", "fusermount"]) {
    try {
      const proc = Bun.spawnSync({ cmd: [cmd, "-u", mountpoint] });
      if (proc.exitCode === 0) {
        console.log(`Unmounted ${mountpoint} (via ${cmd})`);
        break;
      }
    } catch {
      /* try the next */
    }
  }

  clearMountPid();
}

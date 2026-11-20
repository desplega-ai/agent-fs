// macOS mount: a local NFSv3 server on 127.0.0.1 backed by the agent-fs API,
// mounted with the built-in /sbin/mount_nfs. No kext, no macFUSE, and no file
// contents on local disk (see ../nfs/vfs.ts).

import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { getConfig, getHome } from "@/core";
import type { ApiClient } from "../api-client.js";
import { agentFsDriveApi } from "../nfs/drive-api.js";
import { NfsServer } from "../nfs/server.js";
import { Vfs } from "../nfs/vfs.js";
import {
  DEFAULT_APP_URL,
  LAUNCH_AGENT_LABEL,
  QUICK_ACTION_NAME,
  clearNfsState,
  launchAgentPlist,
  mountNfsArgv,
  quickActionInfoPlist,
  quickActionScript,
  quickActionWflow,
  readDeadNfsState,
  readNfsState,
  webUrlFor,
  writeNfsState,
  type NfsMountState,
} from "../lib/macos-mount.js";

export interface NfsMountOpts {
  foreground?: boolean;
  serveOnly?: boolean;
  port?: string;
  install?: boolean;
  uninstall?: boolean;
}

type Resolve = () => Promise<string>;

const START_TIMEOUT_MS = 20_000;

function logPath(): string {
  return join(getHome(), "mount.log");
}

function launchAgentPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCH_AGENT_LABEL}.plist`);
}

function quickActionPath(): string {
  return join(homedir(), "Library", "Services", `${QUICK_ACTION_NAME}.workflow`);
}

/** How to re-run this same CLI: [bun, cli.js]. */
function cliArgv(): string[] {
  return [process.execPath, realpathSync(process.argv[1])];
}

async function run(argv: string[]): Promise<{ code: number; out: string }> {
  // Async on purpose: mount_nfs and umount call back into this process's NFS server.
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, out: (out + err).trim() };
}

async function isMounted(mountpoint: string): Promise<boolean> {
  const { out } = await run(["/sbin/mount"]);
  return out.split("\n").some((line) => line.includes(` on ${mountpoint} (`));
}

async function unmountPath(mountpoint: string): Promise<boolean> {
  if ((await run(["/sbin/umount", mountpoint])).code === 0) return true;
  return (await run(["/usr/sbin/diskutil", "unmount", "force", mountpoint])).code === 0;
}

function defaultMountpoint(): string {
  return join(homedir(), "agent-fs");
}

function requireDarwin(what: string): void {
  if (process.platform !== "darwin") {
    console.error(`${what} is macOS-only. On Linux use the FUSE mount (agent-fs mount <path>) or --serve-only.`);
    process.exit(1);
  }
}

export async function runNfsMount(
  pathArg: string | undefined,
  opts: NfsMountOpts,
  client: ApiClient,
  getOrgId: Resolve,
  getDriveId: (orgId?: string) => Promise<string>
): Promise<void> {
  if (opts.uninstall) return uninstall();

  const existing = readNfsState();
  if (existing && !opts.install) {
    console.error(
      `agent-fs is already mounted${existing.mountpoint ? ` at ${existing.mountpoint}` : ` (serve-only, port ${existing.port})`} (PID ${existing.pid}).`
    );
    console.error("Run `agent-fs unmount` first.");
    process.exit(1);
  }

  const orgId = await getOrgId();
  const driveId = await getDriveId(orgId);
  const port = opts.port ? Number(opts.port) : 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`Invalid --port: ${opts.port}`);
    process.exit(1);
  }

  if (opts.serveOnly) return serve(client, orgId, driveId, null, port);

  requireDarwin("Mounting with NFS");
  const mountpoint = resolve(pathArg ?? defaultMountpoint());
  if (opts.install) return install(mountpoint, orgId, driveId);
  if (opts.foreground) return serve(client, orgId, driveId, mountpoint, port);

  // Background: re-run ourselves in the foreground, detached, and wait for the mount.
  const fd = openSync(logPath(), "a");
  const cli = cliArgv();
  const child = spawn(
    cli[0],
    [...cli.slice(1), "--org", orgId, "--drive", driveId, "mount", mountpoint, "--foreground", ...(opts.port ? ["--port", opts.port] : [])],
    { detached: true, stdio: ["ignore", fd, fd], env: process.env }
  );
  child.unref();
  let exited = false;
  child.on("exit", () => (exited = true));
  if (!(await waitForState(child.pid!, () => exited))) {
    console.error(`Mount failed. Last lines of ${logPath()}:`);
    console.error(tail(logPath(), 15));
    process.exit(1);
  }
  console.log(`Mounted drive ${driveId} at ${mountpoint} (PID ${child.pid})`);
  console.log(`Logs: ${logPath()}`);
  console.log("Unmount with: agent-fs unmount");
  process.exit(0);
}

async function waitForState(pid: number, exited: () => boolean): Promise<boolean> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline && !exited()) {
    if (readNfsState()?.pid === pid) return true;
    await Bun.sleep(200);
  }
  return false;
}

function tail(path: string, lines: number): string {
  try {
    return readFileSync(path, "utf-8").trimEnd().split("\n").slice(-lines).join("\n");
  } catch {
    return "(no log)";
  }
}

async function serve(
  client: ApiClient,
  orgId: string,
  driveId: string,
  mountpointArg: string | null,
  port: number
): Promise<void> {
  const vfs = new Vfs(agentFsDriveApi(client, orgId, driveId));
  const server = new NfsServer(vfs);
  const appUrl = getConfig().appUrl ?? DEFAULT_APP_URL;
  let mountpoint = mountpointArg;

  if (mountpoint) {
    // A server that died leaves a dead mount behind, and mkdir, realpath or readdir on it
    // fail or hang. Clear it by name first: the mount table needs no file access.
    for (const stale of new Set([readDeadNfsState()?.mountpoint, mountpoint])) {
      if (stale && (await isMounted(stale))) {
        console.error(`Clearing a stale mount at ${stale}`);
        await unmountPath(stale);
      }
    }
    mkdirSync(mountpoint, { recursive: true });
    mountpoint = realpathSync(mountpoint);
    // The same check on the real path, for a mountpoint given through a symlink.
    if (await isMounted(mountpoint)) {
      console.error(`Clearing a stale mount at ${mountpoint}`);
      await unmountPath(mountpoint);
    }
    if (readdirSync(mountpoint).length > 0) {
      console.error(`Mountpoint is not empty: ${mountpoint}`);
      process.exit(1);
    }
  }

  const actualPort = await server.listen(port);
  let stopping = false;
  const stop = async (code: number) => {
    if (stopping) return;
    stopping = true;
    try {
      await Promise.race([vfs.flushAll(), Bun.sleep(30_000)]);
    } catch (err: any) {
      console.error(`agent-fs nfs: final upload failed: ${err.message}`);
    }
    const lost = vfs.pending();
    if (lost.length) console.error(`agent-fs nfs: not uploaded: ${lost.join(", ")}`);
    if (mountpoint && (await isMounted(mountpoint))) await unmountPath(mountpoint);
    await server.close();
    clearNfsState(process.pid);
    process.exit(code);
  };
  process.on("SIGINT", () => void stop(0));
  process.on("SIGTERM", () => void stop(0));

  if (!mountpoint) {
    writeNfsState({ pid: process.pid, mountpoint: null, port: actualPort, orgId, driveId, appUrl });
    console.log(`agent-fs NFS server for drive ${driveId} on 127.0.0.1:${actualPort} (Ctrl-C to stop)`);
    console.log(`macOS: sudo ${mountNfsArgv(actualPort, "<dir>").join(" ")}`);
    console.log(`Linux: sudo mount -t nfs -o vers=3,tcp,port=${actualPort},mountport=${actualPort},nolock 127.0.0.1:/ <dir>`);
    return;
  }

  const argv = mountNfsArgv(actualPort, mountpoint);
  const res = await run(argv);
  if (res.code !== 0) {
    console.error(`mount_nfs failed (exit ${res.code}): ${res.out}`);
    console.error("If macOS refused a user mount, run the server and mount it with sudo instead:");
    console.error(`  agent-fs mount --serve-only --port 20490 &`);
    console.error(`  sudo ${mountNfsArgv(20490, mountpoint).join(" ")}`);
    await server.close();
    process.exit(1);
  }
  writeNfsState({ pid: process.pid, mountpoint, port: actualPort, orgId, driveId, appUrl });
  console.log(`Mounted drive ${driveId} at ${mountpoint} (NFS on 127.0.0.1:${actualPort})`);

  // Ejected from Finder: nothing left to serve, so exit cleanly (no LaunchAgent restart).
  setInterval(async () => {
    if (!stopping && !(await isMounted(mountpoint!))) {
      console.error(`${mountpoint} was unmounted; stopping`);
      void stop(0);
    }
  }, 15_000);
}

export async function runNfsUnmount(pathArg?: string): Promise<void> {
  const state = readNfsState();
  if (state) {
    if (pathArg && state.mountpoint && realpathOr(pathArg) !== state.mountpoint) {
      console.error(`agent-fs is mounted at ${state.mountpoint}, not ${pathArg}.`);
      process.exit(1);
    }
    process.kill(state.pid, "SIGTERM");
    const deadline = Date.now() + 35_000;
    while (Date.now() < deadline && readNfsState()) await Bun.sleep(200);
  }
  // A server killed hard leaves its mount in the mount table and its state file behind.
  const dead = state ? null : readDeadNfsState();
  const mountpoint = state?.mountpoint ?? (pathArg ? realpathOr(pathArg) : (dead?.mountpoint ?? null));
  const mounted = !!mountpoint && process.platform === "darwin" && (await isMounted(mountpoint));
  if (mounted && !(await unmountPath(mountpoint!))) {
    console.error(`Could not unmount ${mountpoint}. Close files open there and retry, or: sudo umount -f ${mountpoint}`);
    process.exit(1);
  }
  if (dead) clearNfsState(dead.pid);
  if (!state && !mounted) {
    console.log("No agent-fs NFS mount is running.");
    return;
  }
  console.log(`Unmounted ${mountpoint ?? `NFS server (port ${state?.port})`}${state ? "" : " (its server was gone)"}`);
}

/** A mount whose server died: still in the mount table, so every read of it waits and then fails. */
export async function deadNfsMount(): Promise<NfsMountState | null> {
  const dead = readDeadNfsState();
  return dead?.mountpoint && process.platform === "darwin" && (await isMounted(dead.mountpoint)) ? dead : null;
}

function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** Env the LaunchAgent and Quick Action need, since launchd starts with an empty one. */
function carriedEnv(): Record<string, string> {
  const env: Record<string, string> = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
  for (const k of ["AGENT_FS_HOME", "AGENT_FS_API_URL", "AGENT_FS_API_KEY", "AGENT_FS_APP_URL"]) {
    if (process.env[k]) env[k] = process.env[k]!;
  }
  return env;
}

async function install(mountpoint: string, orgId: string, driveId: string): Promise<void> {
  if (readNfsState()) await runNfsUnmount();
  const cli = cliArgv();
  const plist = launchAgentPath();
  mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  // 0600: the plist can carry AGENT_FS_API_KEY.
  writeFileSync(plist, launchAgentPlist({ cli, orgId, driveId, mountpoint, logPath: logPath(), env: carriedEnv() }), { mode: 0o600 });
  chmodSync(plist, 0o600);

  const wf = quickActionPath();
  mkdirSync(join(wf, "Contents"), { recursive: true });
  const home: Record<string, string> = process.env.AGENT_FS_HOME ? { AGENT_FS_HOME: process.env.AGENT_FS_HOME } : {};
  writeFileSync(join(wf, "Contents", "Info.plist"), quickActionInfoPlist());
  writeFileSync(join(wf, "Contents", "document.wflow"), quickActionWflow(quickActionScript(cli, home)));
  await run(["/System/Library/CoreServices/pbs", "-update"]);

  const domain = `gui/${process.getuid!()}`;
  await run(["/bin/launchctl", "bootout", `${domain}/${LAUNCH_AGENT_LABEL}`]);
  const boot = await run(["/bin/launchctl", "bootstrap", domain, plist]);
  if (boot.code !== 0) {
    console.error(`launchctl bootstrap failed: ${boot.out}`);
    process.exit(1);
  }
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline && !readNfsState()) await Bun.sleep(200);
  const state = readNfsState();
  console.log(`Installed LaunchAgent ${plist} (mounts ${mountpoint} at login)`);
  console.log(`Installed Finder Quick Action "${QUICK_ACTION_NAME}" (right-click a file > Quick Actions)`);
  if (state) {
    console.log(`Mounted drive ${driveId} at ${state.mountpoint}`);
  } else {
    console.error(`The mount did not come up within ${START_TIMEOUT_MS / 1000}s. Last lines of ${logPath()}:`);
    console.error(tail(logPath(), 15));
    process.exit(1);
  }
}

async function uninstall(): Promise<void> {
  requireDarwin("--uninstall");
  await run(["/bin/launchctl", "bootout", `gui/${process.getuid!()}/${LAUNCH_AGENT_LABEL}`]);
  if (readNfsState()) await runNfsUnmount();
  for (const p of [launchAgentPath(), quickActionPath()]) {
    if (existsSync(p)) {
      rmSync(p, { recursive: true, force: true });
      console.log(`Removed ${p}`);
    }
  }
  await run(["/System/Library/CoreServices/pbs", "-update"]);
  console.log("agent-fs will no longer mount at login.");
}

export async function runOpen(path: string, opts: { print?: boolean }): Promise<void> {
  const state = readNfsState();
  if (!state?.mountpoint) {
    console.error("No agent-fs mount is running. Mount one with: agent-fs mount");
    process.exit(1);
  }
  // resolve(), not realpath: no need to touch the mount just to build a URL.
  const url = webUrlFor(state, resolve(path));
  if (!url) {
    console.error(`${path} is not inside the agent-fs mount at ${state.mountpoint}`);
    process.exit(1);
  }
  if (opts.print) {
    console.log(url);
    return;
  }
  const opener = process.platform === "darwin" ? "/usr/bin/open" : "xdg-open";
  const res = await run([opener, url]);
  if (res.code !== 0) {
    console.error(`${opener} failed: ${res.out}`);
    console.log(url);
    process.exit(1);
  }
}

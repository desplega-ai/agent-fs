// Pure helpers for the macOS NFS mount: mount_nfs options, the mount state
// file, the LaunchAgent plist, the Finder Quick Action and the web URL map.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { getHome } from "@/core";
import { buildAppUrl } from "@/core/ops/urls.js";

export const LAUNCH_AGENT_LABEL = "dev.agent-fs.mount";
export const QUICK_ACTION_NAME = "Open in agent-fs";
export const DEFAULT_APP_URL = "https://live.agent-fs.dev";

export interface NfsMountState {
  pid: number;
  /** Absolute mountpoint; null for `--serve-only`. */
  mountpoint: string | null;
  port: number;
  orgId: string;
  driveId: string;
  appUrl: string;
}

export function nfsStatePath(): string {
  return join(getHome(), "nfs-mount.json");
}

/** The state file, and whether the server that wrote it still runs. */
function loadNfsState(): { state: NfsMountState; alive: boolean } | null {
  const p = nfsStatePath();
  if (!existsSync(p)) return null;
  let state: NfsMountState;
  try {
    state = JSON.parse(readFileSync(p, "utf-8")) as NfsMountState;
  } catch {
    return null;
  }
  try {
    process.kill(state.pid, 0);
    return { state, alive: true };
  } catch {
    return { state, alive: false };
  }
}

export function readNfsState(): NfsMountState | null {
  const loaded = loadNfsState();
  return loaded?.alive ? loaded.state : null;
}

/**
 * State left by a server that died before it could clean up (kill -9, crash, power loss).
 * Its mount can still be in the mount table, where Finder waits on it and then times out.
 */
export function readDeadNfsState(): NfsMountState | null {
  const loaded = loadNfsState();
  return loaded && !loaded.alive ? loaded.state : null;
}

export function writeNfsState(state: NfsMountState): void {
  writeFileSync(nfsStatePath(), JSON.stringify(state, null, 2) + "\n");
}

export function clearNfsState(pid: number): void {
  const p = nfsStatePath();
  try {
    const state = JSON.parse(readFileSync(p, "utf-8")) as NfsMountState;
    if (state.pid === pid) unlinkSync(p);
  } catch {
    /* already gone */
  }
}

/**
 * mount_nfs options, after the ones FlashDrive ships for the same loopback
 * setup. `actimeo=3` keeps agent edits visible within seconds; `soft,intr`
 * turns a dead server into errors instead of a hung Finder.
 */
export function mountNfsOptions(port: number): string {
  return [
    "vers=3",
    "tcp",
    `port=${port}`,
    `mountport=${port}`,
    "locallocks",
    "nfc",
    "soft",
    "intr",
    "timeo=600",
    "retrans=2",
    "actimeo=3",
    "rsize=1048576",
    "wsize=1048576",
  ].join(",");
}

export function mountNfsArgv(port: number, mountpoint: string): string[] {
  return ["/sbin/mount_nfs", "-o", mountNfsOptions(port), "127.0.0.1:/", mountpoint];
}

/** live.agent-fs.dev URL for a path inside the mount, or null when outside it. */
export function webUrlFor(state: Pick<NfsMountState, "mountpoint" | "orgId" | "driveId" | "appUrl">, localPath: string): string | null {
  if (!state.mountpoint) return null;
  const rel = relative(state.mountpoint, resolve(localPath));
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  const encoded = rel === "" ? "" : rel.split(sep).map(encodeURIComponent).join("/");
  return buildAppUrl(state.appUrl.replace(/\/+$/, ""), state.orgId, state.driveId, encoded);
}

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function sh(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export interface LaunchAgentSpec {
  /** Full argv of the CLI: [bun, cli.js]. */
  cli: string[];
  orgId: string;
  driveId: string;
  mountpoint: string;
  logPath: string;
  env: Record<string, string>;
}

export function launchAgentPlist(spec: LaunchAgentSpec): string {
  const args = [...spec.cli, "--org", spec.orgId, "--drive", spec.driveId, "mount", spec.mountpoint, "--foreground"];
  const env = Object.entries(spec.env)
    .map(([k, v]) => `\t\t<key>${xml(k)}</key>\n\t\t<string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${LAUNCH_AGENT_LABEL}</string>
\t<key>ProgramArguments</key>
\t<array>
${args.map((a) => `\t\t<string>${xml(a)}</string>`).join("\n")}
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
${env}
\t</dict>
\t<key>RunAtLoad</key>
\t<true/>
\t<key>KeepAlive</key>
\t<dict>
\t\t<key>SuccessfulExit</key>
\t\t<false/>
\t</dict>
\t<key>ThrottleInterval</key>
\t<integer>30</integer>
\t<key>StandardOutPath</key>
\t<string>${xml(spec.logPath)}</string>
\t<key>StandardErrorPath</key>
\t<string>${xml(spec.logPath)}</string>
</dict>
</plist>
`;
}

/** Shell body of the Finder Quick Action: open every selected item in the web UI. */
export function quickActionScript(cli: string[], env: Record<string, string>): string {
  const exports = Object.entries(env).map(([k, v]) => `export ${k}=${sh(v)}\n`).join("");
  return `${exports}for f in "$@"; do ${cli.map(sh).join(" ")} open "$f"; done\n`;
}

export function quickActionInfoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>NSServices</key>
\t<array>
\t\t<dict>
\t\t\t<key>NSMenuItem</key>
\t\t\t<dict>
\t\t\t\t<key>default</key>
\t\t\t\t<string>${QUICK_ACTION_NAME}</string>
\t\t\t</dict>
\t\t\t<key>NSMessage</key>
\t\t\t<string>runWorkflowAsService</string>
\t\t\t<key>NSRequiredContext</key>
\t\t\t<dict>
\t\t\t\t<key>NSApplicationIdentifier</key>
\t\t\t\t<string>com.apple.finder</string>
\t\t\t</dict>
\t\t\t<key>NSSendFileTypes</key>
\t\t\t<array>
\t\t\t\t<string>public.item</string>
\t\t\t</array>
\t\t</dict>
\t</array>
</dict>
</plist>
`;
}

/** Automator document for a Finder service that runs one shell script with the selection as arguments. */
export function quickActionWflow(script: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>AMApplicationBuild</key>
\t<string>523</string>
\t<key>AMApplicationVersion</key>
\t<string>2.10</string>
\t<key>AMDocumentVersion</key>
\t<string>2</string>
\t<key>actions</key>
\t<array>
\t\t<dict>
\t\t\t<key>action</key>
\t\t\t<dict>
\t\t\t\t<key>AMAccepts</key>
\t\t\t\t<dict>
\t\t\t\t\t<key>Container</key>
\t\t\t\t\t<string>List</string>
\t\t\t\t\t<key>Optional</key>
\t\t\t\t\t<true/>
\t\t\t\t\t<key>Types</key>
\t\t\t\t\t<array>
\t\t\t\t\t\t<string>com.apple.cocoa.path</string>
\t\t\t\t\t</array>
\t\t\t\t</dict>
\t\t\t\t<key>AMActionVersion</key>
\t\t\t\t<string>2.0.3</string>
\t\t\t\t<key>AMApplication</key>
\t\t\t\t<array>
\t\t\t\t\t<string>Automator</string>
\t\t\t\t</array>
\t\t\t\t<key>AMParameterProperties</key>
\t\t\t\t<dict>
\t\t\t\t\t<key>COMMAND_STRING</key>
\t\t\t\t\t<dict/>
\t\t\t\t\t<key>CheckedForUserDefaultShell</key>
\t\t\t\t\t<dict/>
\t\t\t\t\t<key>inputMethod</key>
\t\t\t\t\t<dict/>
\t\t\t\t\t<key>shell</key>
\t\t\t\t\t<dict/>
\t\t\t\t\t<key>source</key>
\t\t\t\t\t<dict/>
\t\t\t\t</dict>
\t\t\t\t<key>AMProvides</key>
\t\t\t\t<dict>
\t\t\t\t\t<key>Container</key>
\t\t\t\t\t<string>List</string>
\t\t\t\t\t<key>Types</key>
\t\t\t\t\t<array>
\t\t\t\t\t\t<string>com.apple.cocoa.string</string>
\t\t\t\t\t</array>
\t\t\t\t</dict>
\t\t\t\t<key>ActionBundlePath</key>
\t\t\t\t<string>/System/Library/Automator/Run Shell Script.action</string>
\t\t\t\t<key>ActionName</key>
\t\t\t\t<string>Run Shell Script</string>
\t\t\t\t<key>ActionParameters</key>
\t\t\t\t<dict>
\t\t\t\t\t<key>COMMAND_STRING</key>
\t\t\t\t\t<string>${xml(script)}</string>
\t\t\t\t\t<key>CheckedForUserDefaultShell</key>
\t\t\t\t\t<true/>
\t\t\t\t\t<key>inputMethod</key>
\t\t\t\t\t<integer>1</integer>
\t\t\t\t\t<key>shell</key>
\t\t\t\t\t<string>/bin/bash</string>
\t\t\t\t\t<key>source</key>
\t\t\t\t\t<string></string>
\t\t\t\t</dict>
\t\t\t\t<key>BundleIdentifier</key>
\t\t\t\t<string>com.apple.RunShellScript</string>
\t\t\t\t<key>CFBundleVersion</key>
\t\t\t\t<string>2.0.3</string>
\t\t\t\t<key>CanShowSelectedItemsWhenRun</key>
\t\t\t\t<false/>
\t\t\t\t<key>CanShowWhenRun</key>
\t\t\t\t<true/>
\t\t\t\t<key>Category</key>
\t\t\t\t<array>
\t\t\t\t\t<string>AMCategoryUtilities</string>
\t\t\t\t</array>
\t\t\t\t<key>Class Name</key>
\t\t\t\t<string>RunShellScriptAction</string>
\t\t\t\t<key>InputUUID</key>
\t\t\t\t<string>6E0B2A0C-4D1A-4E7E-9C3B-1F6A2D9E0A01</string>
\t\t\t\t<key>OutputUUID</key>
\t\t\t\t<string>6E0B2A0C-4D1A-4E7E-9C3B-1F6A2D9E0A02</string>
\t\t\t\t<key>UUID</key>
\t\t\t\t<string>6E0B2A0C-4D1A-4E7E-9C3B-1F6A2D9E0A03</string>
\t\t\t\t<key>UnlocalizedApplications</key>
\t\t\t\t<array>
\t\t\t\t\t<string>Automator</string>
\t\t\t\t</array>
\t\t\t\t<key>isViewVisible</key>
\t\t\t\t<integer>1</integer>
\t\t\t</dict>
\t\t\t<key>isViewVisible</key>
\t\t\t<integer>1</integer>
\t\t</dict>
\t</array>
\t<key>connectors</key>
\t<dict/>
\t<key>workflowMetaData</key>
\t<dict>
\t\t<key>serviceApplicationBundleID</key>
\t\t<string>com.apple.finder</string>
\t\t<key>serviceApplicationPath</key>
\t\t<string>/System/Library/CoreServices/Finder.app</string>
\t\t<key>serviceInputTypeIdentifier</key>
\t\t<string>com.apple.Automator.fileSystemObject</string>
\t\t<key>serviceOutputTypeIdentifier</key>
\t\t<string>com.apple.Automator.nothing</string>
\t\t<key>serviceProcessesInput</key>
\t\t<integer>0</integer>
\t\t<key>workflowTypeIdentifier</key>
\t\t<string>com.apple.Automator.servicesMenu</string>
\t</dict>
</dict>
</plist>
`;
}

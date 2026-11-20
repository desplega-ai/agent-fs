// `agent-fs update`: upgrade the installed CLI to the latest npm release,
// using the same package manager that installed it.

import { Command } from "commander";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "@/core";

const PKG = "@desplega.ai/agent-fs";
const REGISTRY_URL = `https://registry.npmjs.org/${PKG}/latest`;

export type InstallMethod = "bun" | "npm" | "pnpm" | "npx" | "source";

/** Infer the installer from where the running CLI file lives on disk. */
export function detectInstallMethod(cliPath: string): InstallMethod {
  const p = cliPath.replace(/\\/g, "/");
  if (p.includes("/_npx/")) return "npx";
  if (!p.includes("/node_modules/")) return "source";
  // bun keeps globals in $BUN_INSTALL/install/global (default ~/.bun).
  if (p.includes("/install/global/node_modules/")) return "bun";
  if (/\/pnpm\/|\/\.pnpm\//.test(p)) return "pnpm";
  return "npm";
}

export function updateCommandFor(method: InstallMethod, version: string): string[] | null {
  const spec = `${PKG}@${version}`;
  switch (method) {
    case "bun":
      return ["bun", "add", "-g", spec];
    case "npm":
      return ["npm", "install", "-g", spec];
    case "pnpm":
      return ["pnpm", "add", "-g", spec];
    default:
      return null;
  }
}

/** -1, 0 or 1. Numeric x.y.z compare; a pre-release suffix is ignored. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split("-")[0].split(".").map(Number);
  const pb = b.split("-")[0].split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Run a command; `why` says what went wrong when it cannot start or does not exit 0. */
function run(cmd: string[], stdout: "inherit" | "pipe"): { out: string; why?: string } {
  try {
    const r = Bun.spawnSync(cmd, { stdout, stderr: stdout });
    const out = r.stdout?.toString() ?? "";
    if (r.exitCode === 0) return { out };
    const err = r.stderr?.toString().trim();
    const how = r.signalCode ? `was killed by ${r.signalCode}` : `exited with ${r.exitCode}`;
    return { out, why: `${cmd[0]} ${how}${err ? `: ${err}` : ""}` };
  } catch (e: any) {
    return { out: "", why: `cannot run ${cmd[0]}: ${e.message}` };
  }
}

/**
 * The CLI entry to run after the install. Bun realpaths argv[1], so a pnpm
 * install resolves into a version-specific .pnpm/<pkg>@OLD directory that the
 * upgrade leaves behind or prunes; ask pnpm for its stable global link instead.
 */
function installedEntry(method: InstallMethod, cliPath: string): string {
  const marker = `/node_modules/${PKG}/`;
  const p = cliPath.replace(/\\/g, "/");
  if (method !== "pnpm" || !p.includes(marker)) return cliPath;
  const root = run(["pnpm", "root", "-g"], "pipe");
  if (root.why || !root.out.trim()) return process.argv[1]; // no answer: keep the path we were started from
  return join(root.out.trim(), PKG, p.slice(p.lastIndexOf(marker) + marker.length));
}

async function fetchLatestVersion(): Promise<string> {
  const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`npm registry answered ${res.status} for ${PKG}`);
  const body = (await res.json()) as { version?: string };
  if (!body.version) throw new Error(`npm registry returned no version for ${PKG}`);
  return body.version;
}

export function updateCommand() {
  return new Command("update")
    .description("Update the agent-fs CLI to the latest release")
    .option("--check", "Only report whether an update is available")
    .action(async (opts: { check?: boolean }) => {
      const cliPath = realpathSync(process.argv[1]);
      const method = detectInstallMethod(cliPath);

      let latest: string;
      try {
        latest = await fetchLatestVersion();
      } catch (err: any) {
        console.error(`Cannot check for updates: ${err.message}`);
        process.exit(1);
      }

      if (compareVersions(VERSION, latest) >= 0) {
        console.log(`agent-fs ${VERSION} is up to date (latest: ${latest})`);
        return;
      }
      if (opts.check) {
        console.log(`Update available: ${VERSION} -> ${latest}`);
        return;
      }

      const cmd = updateCommandFor(method, latest);
      if (!cmd) {
        console.error(
          method === "npx"
            ? `Running through npx, which fetches the latest version on each run. Use: npx ${PKG}@latest`
            : `agent-fs runs from a source checkout (${cliPath}). Update it with: git pull && bun run install-local`
        );
        process.exit(1);
      }

      console.log(`Updating agent-fs ${VERSION} -> ${latest} (${cmd.join(" ")})`);
      const install = run(cmd, "inherit");
      if (install.why) {
        console.error(`Update failed: ${install.why}`);
        process.exit(1);
      }

      // Re-run the reinstalled CLI to confirm what is on disk now.
      const check = run([process.execPath, installedEntry(method, cliPath), "--version"], "pipe");
      if (check.why) console.error(`Cannot run the updated CLI: ${check.why}`);
      const now = (!check.why && check.out.trim()) || "unknown";
      console.log(`agent-fs ${VERSION} -> ${now}`);
      if (now !== latest) {
        console.error(`Warning: expected ${latest} after the update, found ${now}.`);
        process.exit(1);
      }
    });
}

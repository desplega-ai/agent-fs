// `agent-fs update`: upgrade the installed CLI to the latest npm release,
// using the same package manager that installed it.

import { Command } from "commander";
import { realpathSync } from "node:fs";
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
      const run = Bun.spawnSync(cmd, { stdout: "inherit", stderr: "inherit" });
      if (run.exitCode !== 0) {
        console.error(`Update failed: ${cmd[0]} exited with ${run.exitCode}`);
        process.exit(1);
      }

      // Re-run the reinstalled CLI to confirm what is on disk now.
      const check = Bun.spawnSync([process.execPath, cliPath, "--version"]);
      const now = check.stdout.toString().trim() || "unknown";
      console.log(`agent-fs ${VERSION} -> ${now}`);
      if (now !== latest) {
        console.error(`Warning: expected ${latest} after the update, found ${now}.`);
        process.exit(1);
      }
    });
}

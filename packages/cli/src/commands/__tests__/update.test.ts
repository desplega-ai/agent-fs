import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "@/core";
import { compareVersions, detectInstallMethod, updateCommandFor } from "../update.js";

describe("detectInstallMethod", () => {
  test.each([
    ["/Users/t/.bun/install/global/node_modules/@desplega.ai/agent-fs/dist/cli.js", "bun"],
    ["/opt/bun/install/global/node_modules/@desplega.ai/agent-fs/dist/cli.js", "bun"],
    ["/opt/homebrew/lib/node_modules/@desplega.ai/agent-fs/dist/cli.js", "npm"],
    ["/usr/local/lib/node_modules/@desplega.ai/agent-fs/dist/cli.js", "npm"],
    ["/Users/t/Library/pnpm/global/5/node_modules/@desplega.ai/agent-fs/dist/cli.js", "pnpm"],
    ["/home/t/.local/share/pnpm/global/5/.pnpm/@desplega.ai+agent-fs@0.18.35/node_modules/@desplega.ai/agent-fs/dist/cli.js", "pnpm"],
    ["/Users/t/.npm/_npx/abc123/node_modules/@desplega.ai/agent-fs/dist/cli.js", "npx"],
    ["/Users/t/code/agent-fs/packages/cli/dist/cli.js", "source"],
    ["C:\\Users\\t\\AppData\\Roaming\\npm\\node_modules\\@desplega.ai\\agent-fs\\dist\\cli.js", "npm"],
  ] as const)("%s -> %s", (path, method) => {
    expect(detectInstallMethod(path)).toBe(method);
  });
});

describe("updateCommandFor", () => {
  test("uses the installing package manager", () => {
    expect(updateCommandFor("bun", "1.2.3")).toEqual(["bun", "add", "-g", "@desplega.ai/agent-fs@1.2.3"]);
    expect(updateCommandFor("npm", "1.2.3")).toEqual(["npm", "install", "-g", "@desplega.ai/agent-fs@1.2.3"]);
    expect(updateCommandFor("pnpm", "1.2.3")).toEqual(["pnpm", "add", "-g", "@desplega.ai/agent-fs@1.2.3"]);
  });

  test("has no command for npx or a source checkout", () => {
    expect(updateCommandFor("npx", "1.2.3")).toBeNull();
    expect(updateCommandFor("source", "1.2.3")).toBeNull();
  });
});

describe("compareVersions", () => {
  test("compares numerically, not as strings", () => {
    expect(compareVersions("0.18.9", "0.18.35")).toBe(-1);
    expect(compareVersions("0.18.35", "0.18.35")).toBe(0);
    expect(compareVersions("0.19.0", "0.18.35")).toBe(1);
    expect(compareVersions("1.0.0-beta.1", "1.0.0")).toBe(0);
  });
});

// Runs the whole `update` action in a child bun (spawn reads PATH at startup)
// against a sandboxed pnpm global dir and a fake pnpm that retargets the link.
describe("update action with pnpm", () => {
  const PKG = "@desplega.ai/agent-fs";
  const latest = VERSION.replace(/\d+$/, (n) => String(Number(n) + 1));
  const dirs: string[] = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  function runUpdate(opts: { prune?: boolean; noPnpm?: boolean }) {
    const root = mkdtempSync(join(tmpdir(), "agent-fs-update-"));
    dirs.push(root);
    const globalRoot = join(root, "pnpm/global/5/node_modules");
    const pkgDir = (v: string) => join(globalRoot, `.pnpm/@desplega.ai+agent-fs@${v}/node_modules`, PKG);
    for (const v of [VERSION, latest]) {
      mkdirSync(join(pkgDir(v), "dist"), { recursive: true });
      writeFileSync(join(pkgDir(v), "dist/cli.js"), `console.log(${JSON.stringify(v)});\n`);
    }
    const link = join(globalRoot, PKG);
    mkdirSync(join(link, ".."), { recursive: true });
    symlinkSync(pkgDir(VERSION), link);
    const bin = join(root, "bin");
    mkdirSync(bin);
    if (!opts.noPnpm) {
      const prune = opts.prune ? `/bin/rm -rf '${pkgDir(VERSION)}'\n` : "";
      writeFileSync(
        join(bin, "pnpm"),
        `#!/bin/sh\nif [ "$1" = root ]; then echo '${globalRoot}'; exit 0; fi\n` +
          `/bin/rm '${link}'\n/bin/ln -s '${pkgDir(latest)}' '${link}'\n${prune}exit 0\n`
      );
      chmodSync(join(bin, "pnpm"), 0o755);
    }
    // argv[1] is what bun hands the CLI: the realpath into the OLD version dir.
    const driver = join(root, "driver.ts");
    writeFileSync(
      driver,
      `const { updateCommand } = await import(${JSON.stringify(join(import.meta.dir, "../update.ts"))});\n` +
        `process.argv[1] = ${JSON.stringify(join(pkgDir(VERSION), "dist/cli.js"))};\n` +
        `globalThis.fetch = (async () => Response.json({ version: ${JSON.stringify(latest)} })) as any;\n` +
        `await updateCommand().parseAsync([], { from: "user" });\n`
    );
    const r = Bun.spawnSync([process.execPath, driver], {
      cwd: join(import.meta.dir, "../../.."),
      env: { ...process.env, PATH: bin },
    });
    return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
  }

  test("verifies the retargeted link when the old version dir is kept", () => {
    const r = runUpdate({});
    expect(r.out).toContain(`agent-fs ${VERSION} -> ${latest}`);
    expect(r.code).toBe(0);
  });

  test("verifies the retargeted link when the old version dir is pruned", () => {
    const r = runUpdate({ prune: true });
    expect(r.out).toContain(`agent-fs ${VERSION} -> ${latest}`);
    expect(r.code).toBe(0);
  });

  test("reports a missing installer instead of crashing", () => {
    const r = runUpdate({ noPnpm: true });
    expect(r.out).toContain("Update failed: cannot run pnpm");
    expect(r.code).toBe(1);
  });
});

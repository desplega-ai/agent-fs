#!/usr/bin/env bun
// Compute SHA-256 of each per-platform FUSE helper binary and emit a manifest
// that the main package bundles. The CLI's resolveFuseBinary verifies the
// resolved binary against this manifest at mount time.
//
// Input  (relative to repo root):
//   packages/fuse-helper-linux-x64/bin/agent-fs-fuse
//   packages/fuse-helper-linux-arm64/bin/agent-fs-fuse
//
// Output (relative to repo root):
//   packages/cli/dist/fuse-bin.manifest.json
//
// Behaviour:
//   - If a binary is missing (dev box that didn't cross-compile) we warn and
//     skip it rather than failing — the manifest just won't include that arch.
//     The CLI's verifyFuseBinaryHash treats a missing arch entry as "no check"
//     for that arch, which is the same as not having a manifest at all.
//   - In CI (after `cross build`), both binaries are present and the manifest
//     ends up with two entries.

import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/cli/scripts -> repo root is two levels up.
const repoRoot = resolve(__dirname, "..", "..", "..");

const rootPkg = JSON.parse(
  readFileSync(resolve(repoRoot, "package.json"), "utf-8")
) as { version: string };

interface Target {
  arch: "linux-x64" | "linux-arm64";
  binPath: string;
}

const targets: Target[] = [
  {
    arch: "linux-x64",
    binPath: resolve(
      repoRoot,
      "packages/fuse-helper-linux-x64/bin/agent-fs-fuse"
    ),
  },
  {
    arch: "linux-arm64",
    binPath: resolve(
      repoRoot,
      "packages/fuse-helper-linux-arm64/bin/agent-fs-fuse"
    ),
  },
];

const binaries: Record<string, string> = {};
for (const t of targets) {
  if (!existsSync(t.binPath)) {
    console.warn(`[skip] ${t.arch} — no binary at ${t.binPath}`);
    continue;
  }
  const bytes = readFileSync(t.binPath);
  const hash = createHash("sha256").update(bytes).digest("hex");
  binaries[t.arch] = `sha256:${hash}`;
  console.log(`[ok]   ${t.arch} — sha256:${hash}`);
}

const outDir = resolve(repoRoot, "packages/cli/dist");
mkdirSync(outDir, { recursive: true });
const outPath = resolve(outDir, "fuse-bin.manifest.json");

const manifest = {
  version: rootPkg.version,
  binaries,
};

writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(`\nWrote ${outPath}`);
console.log(`  version  ${manifest.version}`);
console.log(`  binaries ${Object.keys(binaries).length}`);

if (Object.keys(binaries).length === 0) {
  console.warn(
    "\nNo binaries were found — the manifest is empty. This is normal on dev hosts that haven't cross-compiled."
  );
}

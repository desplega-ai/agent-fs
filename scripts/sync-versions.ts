#!/usr/bin/env bun
// Sync the version across all package.json files, the Cargo.toml of the FUSE helper,
// and the .claude-plugin/plugin.json metadata.
//
// Usage:
//   bun run scripts/sync-versions.ts <new-version> [--dry-run]
//
// What it touches:
//   - root package.json
//   - packages/cli/package.json
//   - packages/core/package.json
//   - packages/server/package.json
//   - packages/mcp/package.json
//   - packages/just-bash/package.json
//   - packages/fuse-helper-linux-x64/package.json
//   - packages/fuse-helper-linux-arm64/package.json
//   - optionalDependencies entries in packages/cli/package.json that match
//     @desplega.ai/agent-fs-fuse-linux-* — pinned to the new version
//   - packages/fuse-helper/Cargo.toml — `version = "..."` on the [package] line
//   - .claude-plugin/plugin.json
//
// --dry-run prints the would-be changes without writing.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const positional = args.filter((a) => !a.startsWith("--"));
const newVersion = positional[0];

if (!newVersion) {
  console.error(
    "Usage: bun run scripts/sync-versions.ts <new-version> [--dry-run]"
  );
  process.exit(1);
}

// Light validation — accepts semver core + optional pre-release/build (e.g. 0.6.0-rc.1, 0.6.0+build.2).
if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(newVersion)) {
  console.error(
    `Refusing to write a non-semver-looking version: ${newVersion}`
  );
  process.exit(1);
}

interface Change {
  file: string;
  before: string;
  after: string;
}

const changes: Change[] = [];

function recordIfDifferent(
  file: string,
  before: string,
  after: string
): boolean {
  if (before === after) return false;
  changes.push({ file, before, after });
  return true;
}

function rewriteJson(
  relPath: string,
  mutate: (pkg: Record<string, unknown>) => void
): void {
  const abs = resolve(repoRoot, relPath);
  if (!existsSync(abs)) {
    console.warn(`[skip] ${relPath} — not found`);
    return;
  }
  const raw = readFileSync(abs, "utf-8");
  const pkg = JSON.parse(raw) as Record<string, unknown>;
  const beforeJson = JSON.stringify(pkg, null, 2);
  mutate(pkg);
  const afterJson = JSON.stringify(pkg, null, 2) + "\n";
  if (recordIfDifferent(relPath, beforeJson + "\n", afterJson)) {
    if (!dryRun) writeFileSync(abs, afterJson);
  }
}

function rewriteCargoToml(relPath: string): void {
  const abs = resolve(repoRoot, relPath);
  if (!existsSync(abs)) {
    console.warn(`[skip] ${relPath} — not found`);
    return;
  }
  const raw = readFileSync(abs, "utf-8");
  // Only replace the version field inside the first [package] section.
  // We assume the first version = "..." line within [package] is the crate version.
  const lines = raw.split("\n");
  let inPackage = false;
  let replaced = false;
  const next = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inPackage = trimmed === "[package]";
      return line;
    }
    if (inPackage && !replaced) {
      const m = /^(\s*version\s*=\s*)"[^"]*"(.*)$/.exec(line);
      if (m) {
        replaced = true;
        return `${m[1]}"${newVersion}"${m[2]}`;
      }
    }
    return line;
  });
  if (!replaced) {
    console.warn(
      `[warn] ${relPath} — no version field found under [package]`
    );
    return;
  }
  const after = next.join("\n");
  if (recordIfDifferent(relPath, raw, after)) {
    if (!dryRun) writeFileSync(abs, after);
  }
}

// JSON files ------------------------------------------------------------
rewriteJson("package.json", (pkg) => {
  pkg.version = newVersion;
});

const subpackages = [
  "packages/cli/package.json",
  "packages/core/package.json",
  "packages/server/package.json",
  "packages/mcp/package.json",
  "packages/just-bash/package.json",
  "packages/fuse-helper-linux-x64/package.json",
  "packages/fuse-helper-linux-arm64/package.json",
];
for (const sub of subpackages) {
  rewriteJson(sub, (pkg) => {
    pkg.version = newVersion;
  });
}

// optionalDependencies in cli must track the new version. Use a caret range
// so npm's optional-resolution stays lenient on first global install
// (exact pins are flakier — see npm/cli#4828 family). Sub-packages are
// published in lockstep so the range will only ever match the matching
// minor.
rewriteJson("packages/cli/package.json", (pkg) => {
  const optDeps = pkg.optionalDependencies as
    | Record<string, string>
    | undefined;
  if (!optDeps) return;
  for (const name of Object.keys(optDeps)) {
    if (name.startsWith("@desplega.ai/agent-fs-fuse-")) {
      optDeps[name] = `^${newVersion}`;
    }
  }
});

// Cargo.toml ------------------------------------------------------------
rewriteCargoToml("packages/fuse-helper/Cargo.toml");

// Plugin metadata -------------------------------------------------------
rewriteJson(".claude-plugin/plugin.json", (plugin) => {
  plugin.version = newVersion;
});

// Summary ---------------------------------------------------------------
if (changes.length === 0) {
  console.log(`No changes — every file already at ${newVersion}.`);
  process.exit(0);
}

console.log(
  `${dryRun ? "[dry-run] " : ""}Synced ${changes.length} file(s) to version ${newVersion}:`
);
for (const c of changes) {
  console.log(`  - ${c.file}`);
}

if (dryRun) {
  console.log("\nRun without --dry-run to apply.");
}

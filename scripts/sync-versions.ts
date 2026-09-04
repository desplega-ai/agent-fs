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
//   - bun.lock: the "version" of every workspace entry plus the FUSE
//     optionalDependencies pins. bun 1.4.1 refuses --frozen-lockfile when
//     these lag package.json; only these fields are rewritten, resolutions
//     are never touched.
//
// --dry-run prints the would-be changes without writing.
//
// --check takes no <new-version>. It verifies every target above already
// matches the root package.json version and exits non-zero on drift. CI runs
// this on every PR so a partial bump (root only, sub-packages forgotten) fails
// before it reaches main, and the auto-release workflow runs it as a gate
// before tagging.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const check = args.includes("--check");
const positional = args.filter((a) => !a.startsWith("--"));

// Every package.json that must carry the release version. The root is the
// source of truth; these follow it.
const subpackages = [
  "packages/cli/package.json",
  "packages/core/package.json",
  "packages/server/package.json",
  "packages/mcp/package.json",
  "packages/just-bash/package.json",
  "packages/fuse-helper-linux-x64/package.json",
  "packages/fuse-helper-linux-arm64/package.json",
];

// optionalDependencies on the CLI that are published in lockstep and pinned to
// a caret range of the release version.
const FUSE_OPT_DEP_PREFIX = "@desplega.ai/agent-fs-fuse-";

function readJson(relPath: string): Record<string, unknown> | null {
  const abs = resolve(repoRoot, relPath);
  if (!existsSync(abs)) return null;
  return JSON.parse(readFileSync(abs, "utf-8")) as Record<string, unknown>;
}

function readCargoPackageVersion(relPath: string): string | null {
  const abs = resolve(repoRoot, relPath);
  if (!existsSync(abs)) return null;
  let inPackage = false;
  for (const line of readFileSync(abs, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      inPackage = trimmed === "[package]";
      continue;
    }
    if (inPackage) {
      const m = /^\s*version\s*=\s*"([^"]*)"/.exec(line);
      if (m) return m[1] as string;
    }
  }
  return null;
}

// Cargo.lock carries the workspace member's version too. cargo would rewrite it
// on the next build, but a committed lockfile disagreeing with Cargo.toml is
// drift like any other — it sat at 0.8.0 through four releases before --check
// existed to catch it.
//
// Pass `replacement: null` to read the current value without rewriting.
function mapCargoLockVersion(
  raw: string,
  crate: string,
  replacement: string | null
): { version: string | null; text: string } {
  const lines = raw.split("\n");
  let inTarget = false;
  let found: string | null = null;
  const out = lines.map((line) => {
    const trimmed = line.trim();
    if (trimmed === "[[package]]") {
      inTarget = false;
      return line;
    }
    if (trimmed === `name = "${crate}"`) {
      inTarget = true;
      return line;
    }
    if (inTarget && found === null) {
      const m = /^(\s*version\s*=\s*)"([^"]*)"(.*)$/.exec(line);
      if (m) {
        found = m[2] as string;
        if (replacement !== null) return `${m[1]}"${replacement}"${m[3]}`;
      }
    }
    return line;
  });
  return { version: found, text: out.join("\n") };
}

const FUSE_CRATE = "agent-fs-fuse";
const CARGO_LOCK = "Cargo.lock";

function readCargoLockVersion(relPath: string): string | null {
  const abs = resolve(repoRoot, relPath);
  if (!existsSync(abs)) return null;
  return mapCargoLockVersion(readFileSync(abs, "utf-8"), FUSE_CRATE, null).version;
}

// bun.lock records every workspace's version and the FUSE optionalDependencies
// pins. bun 1.4.0 tolerated a lagging lockfile under --frozen-lockfile; bun
// 1.4.1 refuses it. That is how v0.13.4 reached npm but failed the Docker and
// Fly builds: CI ran the pinned 1.4.0, the image ran the floating 1.4.1. Only
// the version fields are rewritten here, so a release never pulls a new
// dependency resolution on the side.
//
// Pass `replacement: null` to read the current values without rewriting.
const BUN_LOCK = "bun.lock";

function mapBunLockVersions(
  raw: string,
  replacement: string | null
): { versions: string[]; fusePins: string[]; text: string } {
  const lines = raw.split("\n");
  let inWorkspaces = false;
  const versions: string[] = [];
  const fusePins: string[] = [];
  const out = lines.map((line) => {
    if (line === '  "workspaces": {') {
      inWorkspaces = true;
      return line;
    }
    // The next two-space-indented section ("packages", "overrides", ...)
    // closes the workspaces block.
    if (inWorkspaces && /^  "[^"]*": \{$/.test(line)) {
      inWorkspaces = false;
      return line;
    }
    if (!inWorkspaces) return line;
    const v = /^(\s{6}"version": ")([^"]*)(",?)$/.exec(line);
    if (v) {
      versions.push(v[2] as string);
      return replacement === null ? line : `${v[1]}${replacement}${v[3]}`;
    }
    if (line.trimStart().startsWith(`"${FUSE_OPT_DEP_PREFIX}`)) {
      const f = /^(\s{8}"[^"]*": ")([^"]*)(",?)$/.exec(line);
      if (f) {
        fusePins.push(f[2] as string);
        return replacement === null ? line : `${f[1]}^${replacement}${f[3]}`;
      }
    }
    return line;
  });
  return { versions, fusePins, text: out.join("\n") };
}

// The Docker build, CI, and the packageManager field must run the same exact
// bun. A floating `oven/bun:1.4` tag is what let CI (pinned 1.4.0) stay green
// while the image build (resolved to 1.4.1) failed --frozen-lockfile on the
// same commit. Checked only; nothing here is rewritten by a version bump.
function checkBunPinParity(): string[] {
  const problems: string[] = [];
  const rootPkg = readJson("package.json");
  const pm = String(rootPkg?.packageManager ?? "");
  const m = /^bun@(\d+\.\d+\.\d+)$/.exec(pm);
  if (!m) {
    return [`package.json packageManager: "${pm}" (expected bun@<exact version>)`];
  }
  const expected = m[1] as string;

  const dockerfile = readFileSync(resolve(repoRoot, "Dockerfile"), "utf-8");
  for (const match of dockerfile.matchAll(/^FROM oven\/bun:(\S+)/gm)) {
    const tag = match[1] as string;
    if (tag.replace(/-slim$/, "") !== expected) {
      problems.push(`Dockerfile FROM oven/bun:${tag}: expected ${expected} (no floating tags)`);
    }
  }

  const wfDir = resolve(repoRoot, ".github/workflows");
  for (const name of readdirSync(wfDir).sort()) {
    if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
    const text = readFileSync(resolve(wfDir, name), "utf-8");
    for (const match of text.matchAll(/bun-version:\s*"?([^"\s]+)"?/g)) {
      const found = match[1] as string;
      if (found !== expected) {
        problems.push(`.github/workflows/${name} bun-version ${found}: expected ${expected}`);
      }
    }
  }
  return problems;
}

// --check ---------------------------------------------------------------
// Compares the version *fields* rather than whole-file bytes, so reformatting
// a package.json can never trip the gate — only a real version mismatch does.
if (check) {
  const rootPkg = readJson("package.json");
  if (!rootPkg) {
    console.error("Cannot read root package.json");
    process.exit(1);
  }
  const expected = String(rootPkg.version);
  const problems: string[] = [];

  for (const rel of subpackages) {
    const pkg = readJson(rel);
    if (!pkg) {
      problems.push(`${rel} — file not found`);
      continue;
    }
    const found = pkg.version as string | undefined;
    if (found !== expected) problems.push(`${rel} — ${found} (expected ${expected})`);
  }

  const cli = readJson("packages/cli/package.json");
  const optDeps = (cli?.optionalDependencies ?? {}) as Record<string, string>;
  for (const [name, range] of Object.entries(optDeps)) {
    if (!name.startsWith(FUSE_OPT_DEP_PREFIX)) continue;
    if (range !== `^${expected}`) {
      problems.push(
        `packages/cli/package.json optionalDependencies["${name}"] — ${range} (expected ^${expected})`
      );
    }
  }

  const cargoVersion = readCargoPackageVersion("packages/fuse-helper/Cargo.toml");
  if (cargoVersion === null) {
    problems.push("packages/fuse-helper/Cargo.toml — no [package] version found");
  } else if (cargoVersion !== expected) {
    problems.push(
      `packages/fuse-helper/Cargo.toml — ${cargoVersion} (expected ${expected})`
    );
  }

  const lockVersion = readCargoLockVersion(CARGO_LOCK);
  if (lockVersion === null) {
    problems.push(`${CARGO_LOCK} — no ${FUSE_CRATE} package entry found`);
  } else if (lockVersion !== expected) {
    problems.push(`${CARGO_LOCK} — ${lockVersion} (expected ${expected})`);
  }

  const bunLockAbs = resolve(repoRoot, BUN_LOCK);
  if (!existsSync(bunLockAbs)) {
    problems.push(`${BUN_LOCK}: file not found`);
  } else {
    const { versions, fusePins } = mapBunLockVersions(readFileSync(bunLockAbs, "utf-8"), null);
    if (versions.length === 0) {
      problems.push(`${BUN_LOCK}: no workspace version entries found`);
    }
    for (const found of new Set(versions.filter((v) => v !== expected))) {
      problems.push(`${BUN_LOCK} workspace version ${found}: expected ${expected}`);
    }
    for (const found of new Set(fusePins.filter((p) => p !== `^${expected}`))) {
      problems.push(`${BUN_LOCK} FUSE optionalDependencies pin ${found}: expected ^${expected}`);
    }
  }

  const pinProblems = checkBunPinParity();

  const plugin = readJson(".claude-plugin/plugin.json");
  if (!plugin) {
    problems.push(".claude-plugin/plugin.json — file not found");
  } else if (plugin.version !== expected) {
    problems.push(
      `.claude-plugin/plugin.json — ${plugin.version} (expected ${expected})`
    );
  }

  if (problems.length > 0) {
    console.error(`Version drift — root package.json is ${expected}, but:\n`);
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error(
      `\nFix with:  bun run scripts/sync-versions.ts ${expected}\nthen commit the result.`
    );
  }

  if (pinProblems.length > 0) {
    if (problems.length > 0) console.error("");
    console.error("bun pin drift (packageManager, Dockerfile, and workflows must agree):\n");
    for (const p of pinProblems) console.error(`  ✗ ${p}`);
    console.error(
      "\nFix by hand: set the same exact bun version in package.json packageManager,\n" +
        "both Dockerfile FROM oven/bun: tags, and every workflow bun-version:, then\n" +
        "run bun install --frozen-lockfile and commit."
    );
  }

  if (problems.length > 0 || pinProblems.length > 0) process.exit(1);

  console.log(`✓ every version target is at ${expected}.`);
  process.exit(0);
}

const newVersion = positional[0];

if (!newVersion) {
  console.error(
    "Usage: bun run scripts/sync-versions.ts <new-version> [--dry-run]\n" +
      "       bun run scripts/sync-versions.ts --check"
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
    if (name.startsWith(FUSE_OPT_DEP_PREFIX)) {
      optDeps[name] = `^${newVersion}`;
    }
  }
});

// Cargo.toml ------------------------------------------------------------
rewriteCargoToml("packages/fuse-helper/Cargo.toml");

// Cargo.lock ------------------------------------------------------------
{
  const abs = resolve(repoRoot, CARGO_LOCK);
  if (!existsSync(abs)) {
    console.warn(`[skip] ${CARGO_LOCK} — not found`);
  } else {
    const raw = readFileSync(abs, "utf-8");
    const { version, text } = mapCargoLockVersion(raw, FUSE_CRATE, newVersion);
    if (version === null) {
      console.warn(`[warn] ${CARGO_LOCK} — no ${FUSE_CRATE} package entry found`);
    } else if (recordIfDifferent(CARGO_LOCK, raw, text)) {
      if (!dryRun) writeFileSync(abs, text);
    }
  }
}

// bun.lock --------------------------------------------------------------
{
  const abs = resolve(repoRoot, BUN_LOCK);
  if (!existsSync(abs)) {
    console.warn(`[skip] ${BUN_LOCK}: not found`);
  } else {
    const raw = readFileSync(abs, "utf-8");
    const { versions, text } = mapBunLockVersions(raw, newVersion);
    if (versions.length === 0) {
      console.warn(`[warn] ${BUN_LOCK}: no workspace version entries found`);
    } else if (recordIfDifferent(BUN_LOCK, raw, text)) {
      if (!dryRun) writeFileSync(abs, text);
    }
  }
}

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

---
date: 2026-03-16
researcher: claude
topic: "Migrating agent-fs from compiled binary to npm-only distribution (qmd model)"
git_root: /Users/taras/Documents/code/agent-fs
branch: main
tags: [distribution, npm, sqlite-vec, bun-compile, migration]
status: complete
related:
  - thoughts/taras/research/2026-03-16-sqlite-vec-bundling-comparison.md
  - thoughts/taras/research/2026-03-16-native-extensions-bun-compile.md
---

# Research: Migrating agent-fs to npm-Only Distribution

## Research Question

How should agent-fs adapt its distribution model to work like qmd — npm package only, no compiled binary — eliminating the sqlite-vec bundling complexity?

## Summary

The core problem is that `bun build --compile` breaks `sqlite-vec`'s `import.meta.url`-based resolution, forcing a 4-layer sidecar system. qmd solves this by distributing as a standard npm package where `node_modules` exists on disk and `sqlite-vec`'s `getLoadablePath()` works natively. agent-fs already has an npm publish path (`@desplega.ai/agent-fs`), but it has bugs (the `bin` field points to `src/index.ts` which isn't in the published tarball) and the compiled binary is the primary distribution. The migration involves: dropping the compiled binary pipeline, fixing the npm package to be the sole distribution, and simplifying sqlite-vec loading to just `sqliteVec.load(db)`.

## Detailed Findings

### 1. How qmd Does It (the target model)

qmd (`@tobilu/qmd`) is distributed as an npm package with these key patterns:

#### Build: `tsc` → `dist/`

- `tsc -p tsconfig.build.json` compiles all `src/**/*.ts` → `dist/` (ESM, `.js` + `.d.ts`)
- A shebang (`#!/usr/bin/env node`) is prepended to the CLI entry `dist/cli/qmd.js`
- No bundling — each source file maps 1:1 to a dist file
- All npm dependencies remain external (resolved from `node_modules` at runtime)

#### Shell Wrapper (`bin/qmd`)

qmd supports both Node.js and Bun runtimes. A shell wrapper detects which runtime installed the package by checking for lockfiles (`package-lock.json` → Node, `bun.lock` → Bun) and execs the correct one. This prevents ABI mismatches with native addons like `better-sqlite3`.

**agent-fs doesn't need this** — it's Bun-only (`engines: { bun: ">=1.2.0" }`). A `#!/usr/bin/env bun` shebang on the compiled JS entry point is sufficient.

#### package.json Distribution Fields

```json
{
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "bin": { "qmd": "bin/qmd" },
  "files": ["bin/", "dist/", "LICENSE", "CHANGELOG.md"],
  "publishConfig": { "access": "public" }
}
```

Key: `bin` points to a file that IS in the published tarball. `files` includes everything `bin` references.

#### sqlite-vec as Optional

```json
{
  "dependencies": {
    "sqlite-vec": "^0.1.7-alpha.2"
  },
  "optionalDependencies": {
    "sqlite-vec-darwin-arm64": "^0.1.7-alpha.2",
    "sqlite-vec-darwin-x64": "^0.1.7-alpha.2",
    "sqlite-vec-linux-arm64": "^0.1.7-alpha.2",
    "sqlite-vec-linux-x64": "^0.1.7-alpha.2",
    "sqlite-vec-windows-x64": "^0.1.7-alpha.2"
  }
}
```

The `sqlite-vec` JS wrapper is a regular dep. The platform-specific native binaries are `optionalDependencies` — npm/bun installs only the matching platform, and failure is non-fatal.

#### sqlite-vec Loading (Bun path in `db.ts`)

```ts
// On macOS, swap in Homebrew's SQLite (Apple's disables loadExtension)
if (process.platform === "darwin") {
  for (const path of [
    "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
    "/usr/local/opt/sqlite/lib/libsqlite3.dylib"
  ]) {
    try { BunDatabase.setCustomSQLite(path); break; } catch {}
  }
}

// Load sqlite-vec — works because node_modules is on disk
const { getLoadablePath } = await import("sqlite-vec");
const vecPath = getLoadablePath();
db.loadExtension(vecPath);
```

No try/catch fallback to binary-adjacent files. No sidecar copying. `getLoadablePath()` resolves `vec0.dylib` from `node_modules` because `import.meta.url` works correctly when running from source (not a compiled binary).

#### Graceful Degradation

If sqlite-vec fails to load, qmd sets a module-level flag (`_sqliteVecAvailable = false`) and falls back to BM25 full-text search only. Vector operations return empty results.

### 2. agent-fs Current State (what needs to change)

#### Current npm Publish Path (has bugs)

agent-fs already publishes to npm as `@desplega.ai/agent-fs` via CI (`release.yml` job `publish-npm`). But it has issues:

**Bug: `bin` points outside `files`**
```json
{
  "bin": { "agent-fs": "src/index.ts" },
  "files": ["dist"]
}
```
`bin` points to `src/index.ts` but `files` only includes `dist/`. The source file is NOT in the published tarball. This means `bun add -g @desplega.ai/agent-fs` creates a broken shim.

**Build produces a single bundle:**
```
bun build src/index.ts --outfile dist/cli.js --target bun --packages external --minify
```
This bundles all workspace packages (core, server, mcp) into one `dist/cli.js`, keeping npm deps external. This is fine — it resolves the `@/core`, `@/server`, `@/mcp` path aliases at build time.

#### What agent-fs Has That qmd Doesn't Need

| Component | Purpose | Needed after migration? |
|-----------|---------|------------------------|
| `scripts/build.sh` | Compiled binary + native extension copying | **Remove** |
| `install.sh` | curl-pipe binary installer | **Remove** |
| `setup-sqlite.ts` path 1 (binary-adjacent) | `join(execDir, "libsqlite3.dylib")` | **Remove** (no compiled binary) |
| `setup-sqlite.ts` paths 2-3 (Homebrew) | macOS `setCustomSQLite()` | **Keep** (still needed for Bun on macOS) |
| `loadSqliteVec()` try/catch fallback | Binary-adjacent `vec0` loading | **Simplify** to just `sqliteVec.load(db)` |
| CI `build` job (matrix) | Cross-platform binary builds | **Remove** |
| CI `release` job | GitHub Release with binary artifacts | **Remove** (or repurpose for release notes only) |
| CI `publish-npm` job | npm publish | **Keep** (becomes the only publish path) |
| CI `brew install sqlite` | Homebrew SQLite for binary builds | **Remove from CI** (users install it locally) |
| CI `bun add sqlite-vec-linux-arm64` | Cross-compilation workaround | **Remove** |

### 3. Migration Plan: What Changes

#### A. Fix `packages/cli/package.json`

**Current (broken):**
```json
"bin": { "agent-fs": "src/index.ts" },
"files": ["dist"]
```

**Target:**
```json
"bin": { "agent-fs": "dist/cli.js" },
"files": ["dist"]
```

The `build:npm` script already produces `dist/cli.js`. The `bin` field should point there. The build script should prepend `#!/usr/bin/env bun` to `dist/cli.js` (like qmd prepends `#!/usr/bin/env node`).

Additionally, `main` and `types` currently point to `src/index.ts` — since this is a CLI (not a library), these can be removed or pointed to `dist/cli.js`. Not critical but keeps the package.json consistent.

#### B. Add sqlite-vec platform packages to optionalDependencies

**Current:** sqlite-vec platform packages are only declared inside the `sqlite-vec` npm package itself (as its own optionalDeps). This usually works, but explicitly declaring them at the top level (like qmd does) ensures they're installed even if the package manager's optional dep resolution behaves differently.

```json
"optionalDependencies": {
  "sqlite-vec-darwin-arm64": "^0.1.6",
  "sqlite-vec-darwin-x64": "^0.1.6",
  "sqlite-vec-linux-arm64": "^0.1.6",
  "sqlite-vec-linux-x64": "^0.1.6",
  "sqlite-vec-windows-x64": "^0.1.6"
}
```

#### C. Simplify `setup-sqlite.ts`

**Current:** Searches 3 paths (binary-adjacent, Apple Silicon Homebrew, Intel Homebrew).

**Target:** Remove binary-adjacent path. Keep only Homebrew paths:

```ts
export function ensureCustomSQLite(): void {
  if (initialized) return;
  initialized = true;
  if (platform() !== "darwin") return;

  const paths = [
    "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
    "/usr/local/opt/sqlite3/lib/libsqlite3.dylib",
  ];

  for (const p of paths) {
    if (existsSync(p)) {
      try { Database.setCustomSQLite(p); } catch {}
      return;
    }
  }

  console.warn(
    "Warning: Could not find Homebrew SQLite. Vector search requires: brew install sqlite"
  );
}
```

#### D. Simplify `loadSqliteVec()` in `db/index.ts`

**Current:** Try/catch with binary-adjacent fallback.

**Target:** Direct call only:

```ts
function loadSqliteVec(sqlite: Database): void {
  sqliteVec.load(sqlite);
}
```

No try/catch fallback needed — `node_modules` is on disk, `import.meta.url` resolves correctly.

**Optional:** Add graceful degradation like qmd (catch the error, set a flag, let the app work without vector search).

#### E. Remove Compiled Binary Infrastructure

Delete or simplify:
- `scripts/build.sh` — **delete entirely**
- `install.sh` — **delete entirely**
- `scripts/release.sh` — **keep** (it creates git tags that trigger the CI release; still needed)
- Root `package.json` `"build"` script — **change** from `./scripts/build.sh` to the npm build
- `.github/workflows/release.yml` — **delete entirely** (compiled binary infrastructure)
- `.github/workflows/npm-publish.yml` — **keep** (already correctly configured, optionally enhance)
- `.github/workflows/ci.yml` — **update**: currently runs `bun run build` which invokes `scripts/build.sh` (compiled binary). After migration, `bun run build` will run the npm build instead (single JS bundle), so CI automatically picks up the change via the root script update. Verify this works.
- `DEPLOYMENT.md` — **update** to remove binary install instructions

#### F. Simplify CI Workflows

**Current state:** Two workflows both trigger on `v*` tags:
- `release.yml` — compiled binary build matrix (3 targets) + GitHub Release with binary artifacts
- `npm-publish.yml` — standalone npm publish (already properly configured)

`npm-publish.yml` is already clean and correct:
```yaml
name: Publish to npm
on:
  push:
    tags: ['v*']
permissions:
  contents: read
  id-token: write
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          registry-url: 'https://registry.npmjs.org'
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: cd packages/cli && bun run build:npm
      - run: cp README.md packages/cli/README.md
      - run: cd packages/cli && bun pm pack
      - run: npm publish packages/cli/*.tgz --access public --provenance
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

**Migration:**
- `release.yml` — **delete entirely** (all compiled binary infrastructure)
- `npm-publish.yml` — **keep and enhance** with:
  - Version verification step (from current `release.yml:41-48`)
  - `bun run typecheck` and `bun run test` before publish
  - A GitHub Release creation step **after** npm publish (for release notes, no binary artifacts)
  - Needs `contents: write` permission added (currently only `contents: read`) for `gh release create`

#### G. Update Root package.json Scripts

**Current:**
```json
"build": "./scripts/build.sh",
"build:npm": "cd packages/cli && bun run build:npm"
```

**Target:**
```json
"build": "cd packages/cli && bun run build:npm"
```

Single build path. No more `build` vs `build:npm` distinction.

#### H. Update `CLAUDE.md`

Remove references to `bun run build` producing compiled binaries. Update the "Releasing & Deployment" section.

### 4. What Stays the Same

These things work identically in npm distribution:

- **sqlite-vec loading** — `sqliteVec.load(db)` resolves `vec0.dylib` from `node_modules` (this is the normal path that already works in dev mode)
- **macOS `setCustomSQLite()`** — still needed because Bun's built-in SQLite disables `loadExtension()` (qmd has this exact same hack)
- **`vec0` virtual table, KNN queries, Float32Array bindings** — all application-level sqlite-vec usage is unchanged
- **Monorepo structure** — workspaces, path aliases, `tsc --build` typechecking all stay
- **`bun build --packages external`** — the npm bundle strategy (single JS file, external npm deps) works well
- **`bun publish` / workspace resolution** — `workspace:*` deps get resolved to real versions at publish time
- **`node-llama-cpp`** — another native dep in the dependency tree. It handles its own native binaries (downloads/compiles via postinstall), so it works fine with npm distribution. No changes needed.
- **Test utilities** — `test-utils.ts` already uses `sqliteVec.load(sqlite)` directly (no try/catch), which is the post-migration pattern. Tests won't need changes.

### 5. Comparison: Before and After

| Aspect | Before (compiled binary) | After (npm-only) |
|--------|-------------------------|-------------------|
| Install | `curl ... \| sh` or `bun add -g` | `bun add -g @desplega.ai/agent-fs` |
| Runtime requirement | None (self-contained) | Bun >= 1.2.0 |
| sqlite-vec loading | 4-layer sidecar system | `sqliteVec.load(db)` (standard npm) |
| macOS SQLite hack | Yes (3 paths) | Yes (2 Homebrew paths only) |
| Native files to ship | `vec0.dylib` + `libsqlite3.dylib` | None (npm handles it) |
| Build complexity | `bun build --compile` + shell script + native file copy | `bun build --packages external` |
| CI complexity | `release.yml` (3-job binary matrix) + `npm-publish.yml` | `npm-publish.yml` only (already exists) |
| Cross-platform | Must build per platform | npm handles per-platform optional deps |
| File count in release | 3 files per platform (binary + dylibs) | 1 npm package |
| Offline install | Yes (self-contained binary) | No (needs npm registry) |

### 6. Tradeoffs

**What we lose:**
- **Offline/curl install** — users need Bun + npm registry access. No more `curl | sh`.
- **Zero-dep runtime** — users must have Bun installed. The compiled binary was self-contained.
- **Homebrew SQLite requirement on macOS** — users on macOS must `brew install sqlite` for vector search. The compiled binary shipped its own `libsqlite3.dylib`.

**What we gain:**
- **Dramatically simpler build/release** — one `bun build` command, one CI job
- **No native file sidecar management** — npm handles platform-specific binaries
- **sqlite-vec loading just works** — no try/catch, no binary-adjacent fallback
- **Easier development** — `bun run packages/cli/src/index.ts` works identically to installed version
- **Standard npm distribution** — users get updates via `bun update`, version management via npm

### 7. Open Questions

1. **Graceful degradation for vector search?** If sqlite-vec fails to load (e.g., macOS without Homebrew SQLite), should agent-fs crash or degrade to FTS5-only search like qmd does?

2. **Should we keep `install.sh` as a convenience wrapper?** It could become a thin script that installs Bun (if needed) and then runs `bun add -g @desplega.ai/agent-fs`.

3. **MCP server distribution** — The MCP package (`packages/mcp`) is currently bundled into the CLI. Does it need separate npm distribution for MCP client integration?

## Code References

### qmd (reference implementation)
- `/tmp/qmd/package.json` — distribution fields, optional deps for sqlite-vec platforms
- `/tmp/qmd/bin/qmd` — shell wrapper (cross-runtime, not needed for Bun-only)
- `/tmp/qmd/src/db.ts:19-51` — Bun SQLite init with `setCustomSQLite()` + `getLoadablePath()`
- `/tmp/qmd/src/db.ts:87-96` — `loadSqliteVec()` public API
- `/tmp/qmd/src/store.ts:641-650` — graceful degradation on vec load failure
- `/tmp/qmd/tsconfig.build.json` — tsc build config
- `/tmp/qmd/.github/workflows/publish.yml` — npm publish CI
- `/tmp/qmd/CLAUDE.md:151` — explicit prohibition of `bun build --compile`

### agent-fs (files to modify)
- `packages/cli/package.json` — fix `bin` field, add sqlite-vec optionalDeps, update `main`/`types`
- `packages/cli/src/index.ts` — no changes (entry point stays the same)
- `packages/core/src/db/setup-sqlite.ts` — remove binary-adjacent path
- `packages/core/src/db/index.ts` — simplify `loadSqliteVec()`
- `packages/core/src/test-utils.ts` — no changes needed (already uses direct `sqliteVec.load()`)
- `scripts/build.sh` — delete
- `scripts/release.sh` — keep (creates git tags)
- `install.sh` — delete or repurpose
- `package.json` (root) — update `build` script
- `.github/workflows/release.yml` — delete (compiled binary infrastructure)
- `.github/workflows/npm-publish.yml` — keep (already correct), optionally enhance
- `.github/workflows/ci.yml` — verify `bun run build` works after root script change
- `DEPLOYMENT.md` — update
- `CLAUDE.md` — update build/release docs

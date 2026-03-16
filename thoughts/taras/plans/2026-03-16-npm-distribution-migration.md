---
date: 2026-03-16
author: claude
topic: "Migrate agent-fs from compiled binary to npm-only distribution"
status: completed
autonomy: autopilot
research: thoughts/taras/research/2026-03-16-npm-distribution-migration.md
tags: [distribution, npm, sqlite-vec, bun-compile, migration]
---

# npm-Only Distribution Migration Plan

## Overview

Migrate agent-fs from a compiled Bun binary distribution (with native extension sidecar files) to an npm-only distribution model. This eliminates the 4-layer sqlite-vec bundling complexity by relying on `node_modules` for native extension resolution — the same approach used by qmd.

## Current State Analysis

**Distribution:** Two parallel paths — compiled binary via GitHub Releases (`release.yml`) and a broken npm package (`npm-publish.yml`).

**The npm package is broken:** `packages/cli/package.json:17-18` has `"bin": { "agent-fs": "src/index.ts" }` but `"files": ["dist", "README.md"]` at line 20. The `src/` directory is not included in the published tarball, so `bun add -g @desplega.ai/agent-fs` creates a broken shim.

**sqlite-vec loading has unnecessary complexity:**
- `packages/core/src/db/setup-sqlite.ts:18-23` — searches 3 paths including binary-adjacent `libsqlite3.dylib`
- `packages/core/src/db/index.ts:15-24` — `loadSqliteVec()` has a try/catch fallback to binary-adjacent `vec0`

**CI has redundant workflows:**
- `release.yml` — 3-target build matrix for compiled binaries + GitHub Release with binary artifacts
- `npm-publish.yml` — npm publish (already works, just needs enhancements)
- `ci.yml:24` — runs `bun run build` which invokes `scripts/build.sh` (compiled binary build)

### Key Discoveries:
- `packages/cli/package.json:22` already has a working `build:npm` script producing `dist/cli.js`
- `packages/core/src/test-utils.ts` already uses `sqliteVec.load(sqlite)` directly (the post-migration pattern)
- `scripts/release.sh` only creates git tags — it's decoupled from the binary build and stays as-is
- The npm-publish workflow already uses `npm publish` with provenance (not `bun publish`)

## Desired End State

- `bun add -g @desplega.ai/agent-fs` installs a working CLI
- `agent-fs` command works via `#!/usr/bin/env bun` shebang on `dist/cli.js`
- sqlite-vec loads via standard `sqliteVec.load(db)` — no binary-adjacent fallbacks
- Single CI workflow handles npm publish + GitHub Release (release notes only, no binaries)
- `bun run build` produces the npm bundle (not a compiled binary)
- No dead code referencing compiled binary paths

## Quick Verification Reference

Common commands:
- `bun run typecheck` — TypeScript type checking
- `bun run test` — run tests
- `bun run build` — bundle for npm (post-migration)

Key files:
- `packages/cli/package.json` — npm distribution config
- `packages/core/src/db/setup-sqlite.ts` — macOS SQLite setup
- `packages/core/src/db/index.ts` — sqlite-vec loading
- `.github/workflows/npm-publish.yml` — release workflow

## What We're NOT Doing

- **Graceful degradation** — if sqlite-vec fails to load, the app crashes (current behavior). Degrading to FTS5-only can be a follow-up.
- **Convenience install.sh wrapper** — no thin `curl | sh` script that installs Bun + runs `bun add -g`. Users install Bun themselves.
- **Separate MCP package distribution** — `packages/mcp` stays bundled into the CLI.
- **Node.js support** — remains Bun-only.
- **Monorepo restructuring** — workspaces, path aliases, tsconfig all stay.

## Implementation Approach

Seven phases, ordered so each is independently testable:

1. **Fix npm package** — make `bun add -g` actually work
2. **Simplify sqlite-vec** — remove binary-adjacent code paths
3. **Remove binary infrastructure** — delete `scripts/build.sh`, `install.sh`, update root scripts
4. **Update Dockerfile** — rewrite for npm-based distribution
5. **Consolidate CI** — delete `release.yml`, enhance `npm-publish.yml`, verify `ci.yml`
6. **Update documentation** — `DEPLOYMENT.md`, `CLAUDE.md`, `README.md`, `CONTRIBUTING.md`, `docs/deployment.md`
7. **Manual E2E** — verify the full flow locally

---

## Phase 1: Fix npm Package Configuration

### Overview
Make `bun add -g @desplega.ai/agent-fs` produce a working `agent-fs` command by fixing the `bin` field, adding a shebang to the build output, and declaring sqlite-vec platform packages as `optionalDependencies`.

### Changes Required:

#### 1. Fix bin field and add shebang
**File**: `packages/cli/package.json`
**Changes**:
- Change `"bin": { "agent-fs": "src/index.ts" }` → `"bin": { "agent-fs": "dist/cli.js" }`
- Remove `"main": "src/index.ts"` and `"types": "src/index.ts"` (this is a CLI, not a library)
- Update `build:npm` script to prepend `#!/usr/bin/env bun` shebang to `dist/cli.js` after bundling

The build:npm script becomes:
```json
"build:npm": "bun build src/index.ts --outfile dist/cli.js --target bun --packages external --minify && { echo '#!/usr/bin/env bun'; cat dist/cli.js; } > dist/cli.tmp && mv dist/cli.tmp dist/cli.js"
```

#### 2. Add sqlite-vec platform optionalDependencies
**File**: `packages/cli/package.json`
**Changes**: Add `optionalDependencies` section with platform-specific sqlite-vec packages (matches the version of `sqlite-vec` in `dependencies`):
```json
"optionalDependencies": {
  "sqlite-vec-darwin-arm64": "^0.1.6",
  "sqlite-vec-darwin-x64": "^0.1.6",
  "sqlite-vec-linux-arm64": "^0.1.6",
  "sqlite-vec-linux-x64": "^0.1.6",
  "sqlite-vec-windows-x64": "^0.1.6"
}
```

### Success Criteria:

#### Automated Verification:
- [ ] Build succeeds: `bun run build:npm` (from `packages/cli/`)
- [ ] Shebang present: `head -1 packages/cli/dist/cli.js | grep '#!/usr/bin/env bun'`
- [ ] Typecheck passes: `bun run typecheck`
- [ ] Tests pass: `bun run test`

#### Manual Verification:
- [ ] Inspect `packages/cli/dist/cli.js` — first line is `#!/usr/bin/env bun`
- [ ] Run `cd packages/cli && bun pm pack` and inspect tarball contents — `dist/cli.js` is present, `src/` is NOT present
- [ ] `bin` field in tarball's `package.json` points to `dist/cli.js`

**Implementation Note**: After completing this phase, pause for manual confirmation before proceeding.

---

## Phase 2: Simplify sqlite-vec Loading

### Overview
Remove the binary-adjacent fallback paths from sqlite-vec loading. With npm distribution, `node_modules` is on disk and `sqliteVec.load(db)` resolves natively.

### Changes Required:

#### 1. Remove binary-adjacent path from setup-sqlite.ts
**File**: `packages/core/src/db/setup-sqlite.ts`
**Changes**: Remove the `join(execDir, "libsqlite3.dylib")` path (line 20). Keep only the two Homebrew paths. Remove the `dirname`/`join` imports if no longer needed. Remove the unused `process.execPath` reference.

After:
```ts
import { Database } from "bun:sqlite";
import { platform } from "node:os";
import { existsSync } from "node:fs";

let initialized = false;

export function ensureCustomSQLite(): void {
  if (initialized) return;
  initialized = true;

  if (platform() !== "darwin") return;

  const paths = [
    "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib", // Apple Silicon Homebrew
    "/usr/local/opt/sqlite3/lib/libsqlite3.dylib",   // Intel Mac Homebrew
  ];

  for (const p of paths) {
    if (existsSync(p)) {
      try {
        Database.setCustomSQLite(p);
      } catch {
        // Already set — fine
      }
      return;
    }
  }

  console.warn(
    "Warning: Could not find Homebrew SQLite. Extension loading may fail on macOS.\n" +
      "Install with: brew install sqlite"
  );
}

// Auto-run on import
ensureCustomSQLite();
```

#### 2. Simplify loadSqliteVec in db/index.ts
**File**: `packages/core/src/db/index.ts`
**Changes**: Remove the try/catch fallback. Replace with a direct call. Remove the unused `join` import from `node:path` — **keep `dirname`** (still used at line 30: `const dir = dirname(resolvedPath)`).

After (imports):
```ts
import { dirname } from "node:path";
```

After (function):
```ts
function loadSqliteVec(sqlite: Database): void {
  sqliteVec.load(sqlite);
}
```

### Success Criteria:

#### Automated Verification:
- [ ] Typecheck passes: `bun run typecheck`
- [ ] Tests pass: `bun run test`
- [ ] No references to `process.execPath` in db files: `grep -r "process.execPath" packages/core/src/db/`

#### Manual Verification:
- [ ] Run `bun run packages/cli/src/index.ts -- --help` — CLI works from source
- [ ] Run `bun run packages/cli/src/index.ts -- cat test.txt` (or any command that triggers DB init) — sqlite-vec loads correctly

**Implementation Note**: After completing this phase, pause for manual confirmation. The compiled binary build (`scripts/build.sh`) will now produce a binary that cannot fall back to sidecar files — but we're deleting it in Phase 3 anyway.

---

## Phase 3: Remove Compiled Binary Infrastructure

### Overview
Delete the compiled binary build script and curl installer. Update root `package.json` so `bun run build` runs the npm build.

### Changes Required:

#### 1. Delete build script
**File**: `scripts/build.sh`
**Action**: Delete entirely.

#### 2. Delete install script
**File**: `install.sh`
**Action**: Delete entirely.

#### 3. Update root package.json scripts
**File**: `package.json` (root)
**Changes**:
- Change `"build": "./scripts/build.sh"` → `"build": "cd packages/cli && bun run build:npm"`
- Remove `"build:npm": "cd packages/cli && bun run build:npm"` (now redundant — `build` does the same thing)

After:
```json
"scripts": {
  "typecheck": "tsc --build",
  "test": "bun test packages/*/src/",
  "test:coverage": "bun test --coverage packages/*/src/",
  "build": "cd packages/cli && bun run build:npm"
}
```

### Success Criteria:

#### Automated Verification:
- [ ] Build works: `bun run build`
- [ ] Shebang present: `head -1 packages/cli/dist/cli.js | grep '#!/usr/bin/env bun'`
- [ ] Typecheck passes: `bun run typecheck`
- [ ] Tests pass: `bun run test`
- [ ] Deleted files are gone: `test ! -f scripts/build.sh && test ! -f install.sh`

#### Manual Verification:
- [ ] `scripts/` directory still contains `release.sh` and `sync-openapi.ts`
- [ ] `bun run build` produces `packages/cli/dist/cli.js` (not `dist/agent-fs` binary)

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Phase 4: Update Dockerfile

### Overview
Rewrite the Dockerfile for npm-based distribution. The current Dockerfile copies the compiled binary (`dist/agent-fs`) into a slim image. After migration, the CLI is a JS bundle that needs Bun + `node_modules` at runtime.

### Changes Required:

#### 1. Rewrite Dockerfile
**File**: `Dockerfile`
**Changes**: The runtime image needs the full `node_modules/` (for sqlite-vec native extensions and other deps) and the built JS bundle. Use `bun install --production` in the runtime stage to get only production deps.

After:
```dockerfile
FROM oven/bun:1 AS builder

WORKDIR /app
COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
COPY packages/mcp/package.json packages/mcp/
COPY packages/server/package.json packages/server/
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build

FROM oven/bun:1-slim

WORKDIR /app
COPY --from=builder /app/package.json /app/bun.lock ./
COPY --from=builder /app/packages/core/package.json packages/core/
COPY --from=builder /app/packages/cli/package.json packages/cli/
COPY --from=builder /app/packages/mcp/package.json packages/mcp/
COPY --from=builder /app/packages/server/package.json packages/server/
RUN bun install --frozen-lockfile --production
COPY --from=builder /app/packages/cli/dist/ packages/cli/dist/

ENV AGENT_FS_HOME=/data
EXPOSE 7433

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:7433/health || exit 1

CMD ["bun", "run", "packages/cli/dist/cli.js", "server", "--host", "0.0.0.0"]
```

Key changes:
- Runtime stage installs production `node_modules` (needed for sqlite-vec native extensions)
- Copies only the built `dist/cli.js` from builder
- Entrypoint uses `bun run` instead of a compiled binary

### Success Criteria:

#### Automated Verification:
- [ ] Docker build succeeds: `docker build -t agent-fs-test .`
- [ ] No references to `dist/agent-fs` binary: `! grep "dist/agent-fs" Dockerfile`

#### Manual Verification:
- [ ] `docker run --rm agent-fs-test agent-fs --help` shows help output
- [ ] `docker run --rm agent-fs-test agent-fs --version` shows correct version

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Phase 5: Consolidate CI Workflows

### Overview
Delete the compiled binary release workflow. Enhance the npm-publish workflow with version verification, pre-publish checks, and GitHub Release creation. Verify CI workflow works with the new build script.

### Changes Required:

#### 1. Delete binary release workflow
**File**: `.github/workflows/release.yml`
**Action**: Delete entirely.

#### 2. Enhance npm-publish workflow
**File**: `.github/workflows/npm-publish.yml`
**Changes**: Add version verification, typecheck + test before publish, and GitHub Release creation after publish. Update permissions to `contents: write` (needed for `gh release create`).

After:
```yaml
name: Release & Publish

on:
  push:
    tags: ['v*']

permissions:
  contents: write
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

      - name: Verify tag matches package.json version
        run: |
          PKG_VERSION="v$(jq -r .version package.json)"
          if [ "$PKG_VERSION" != "${{ github.ref_name }}" ]; then
            echo "::error::Tag ${{ github.ref_name }} doesn't match package.json version ${PKG_VERSION}"
            exit 1
          fi

      - run: bun install --frozen-lockfile
      - run: bun run typecheck
      - run: bun run test
      - run: bun run build
      - run: cp README.md packages/cli/README.md
      - run: cd packages/cli && bun pm pack

      - name: Publish to npm
        run: npm publish packages/cli/*.tgz --access public --provenance
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}

      - name: Create GitHub Release
        run: |
          VERSION="${{ github.ref_name }}"
          gh release create "$VERSION" --generate-notes --notes "$(cat <<'NOTES'

          ## Install

          ```bash
          # bun
          bun add -g @desplega.ai/agent-fs@${VERSION#v}

          # npm
          npm install -g @desplega.ai/agent-fs@${VERSION#v}

          # pnpm
          pnpm add -g @desplega.ai/agent-fs@${VERSION#v}
          ```

          ## Update

          ```bash
          bun update -g @desplega.ai/agent-fs
          ```
          NOTES
          )"
        env:
          GH_TOKEN: ${{ github.token }}
```

#### 3. Verify ci.yml compatibility
**File**: `.github/workflows/ci.yml`
**Changes**: No changes needed. The `bun run build` step (line 24) will now run the npm build instead of the compiled binary build, which works on `ubuntu-latest` without Homebrew SQLite (it's just JS bundling, no native extensions involved at build time).

**Verification**: Review that the CI job runs `bun run build` → `cd packages/cli && bun run build:npm` → produces `dist/cli.js`. No platform-specific dependencies needed.

### Success Criteria:

#### Automated Verification:
- [ ] release.yml is gone: `test ! -f .github/workflows/release.yml`
- [ ] npm-publish.yml has version check: `grep "Verify tag matches" .github/workflows/npm-publish.yml`
- [ ] npm-publish.yml has typecheck: `grep "bun run typecheck" .github/workflows/npm-publish.yml`
- [ ] npm-publish.yml has GitHub Release: `grep "gh release create" .github/workflows/npm-publish.yml`
- [ ] npm-publish.yml has write permissions: `grep "contents: write" .github/workflows/npm-publish.yml`

#### Manual Verification:
- [ ] Review `.github/workflows/npm-publish.yml` — steps are in correct order (verify → install → check → build → pack → publish → release)
- [ ] Review `.github/workflows/ci.yml` — no references to compiled binaries or platform-specific native extensions
- [ ] Confirm `ci.yml` doesn't need changes (the `bun run build` step auto-adapts via root script change)

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Phase 6: Update Documentation

### Overview
Update all documentation files that reference compiled binaries, `install.sh`, or curl install to reflect the npm-only distribution model.

### Changes Required:

#### 1. Update DEPLOYMENT.md
**File**: `DEPLOYMENT.md`
**Changes**:
- Remove "Builds binaries" from the release process description
- Remove the "Install via curl" section
- Remove the `bun run build` → "Compile native binary" row from the build commands table
- Update to show a single build command
- Remove or update any references to compiled binaries

#### 2. Update CLAUDE.md
**File**: `CLAUDE.md`
**Changes**:
- Update the "Commands" section: `bun run build` now bundles for npm, not compiles binary
- Remove the `install.sh` / curl install section
- Update "Key Decisions" if any reference the compiled binary
- Ensure "Release Steps" still make sense (they should — `scripts/release.sh` is unchanged)

#### 3. Update README.md
**File**: `README.md`
**Changes**:
- Replace the `curl -fsSL ... | sh` install command (line 32) with `bun add -g @desplega.ai/agent-fs`
- Add note that Bun >= 1.2.0 is required

#### 4. Update CONTRIBUTING.md
**File**: `CONTRIBUTING.md`
**Changes**:
- Update "Build CLI binary" references (line 46) to reflect npm bundle build
- Update directory tree (line 72-76) — remove `install.sh` entry, update `cli/` description

#### 5. Update docs/deployment.md
**File**: `docs/deployment.md`
**Changes**:
- Replace the `curl -fsSL ... | sh` install command (line 18) with npm install instructions

### Success Criteria:

#### Automated Verification:
- [ ] No "compile" references in DEPLOYMENT.md: `! grep -i "compile" DEPLOYMENT.md`
- [ ] No "curl" install references in DEPLOYMENT.md: `! grep "curl" DEPLOYMENT.md`
- [ ] No "install.sh" references in CLAUDE.md: `! grep "install.sh" CLAUDE.md`
- [ ] No "install.sh" references in README.md: `! grep "install.sh" README.md`
- [ ] No "install.sh" references in CONTRIBUTING.md: `! grep "install.sh" CONTRIBUTING.md`
- [ ] No curl install in docs/deployment.md: `! grep "curl" docs/deployment.md`

#### Manual Verification:
- [ ] Read `DEPLOYMENT.md` end-to-end — all instructions are accurate for npm-only distribution
- [ ] Read `CLAUDE.md` end-to-end — no stale references to compiled binary infrastructure
- [ ] Read `README.md` install section — shows npm install, not curl
- [ ] Read `CONTRIBUTING.md` — no references to deleted files or compiled binary build

**Implementation Note**: After completing this phase, pause for manual confirmation.

---

## Phase 7: Manual E2E Verification

### Overview
Verify the entire distribution pipeline works locally, end-to-end.

### Changes Required:
No code changes. This phase is verification only.

### Test Sequence:

1. **Build locally:**
   ```bash
   bun run build
   ```

2. **Inspect the tarball:**
   ```bash
   cd packages/cli && bun pm pack
   tar tzf desplega.ai-agent-fs-*.tgz
   ```
   Verify: `dist/cli.js` is present, `src/` is absent, `package.json` `bin` points to `dist/cli.js`.

3. **Test global install from tarball:**
   ```bash
   bun add -g ./desplega.ai-agent-fs-*.tgz
   ```

4. **Test the CLI:**
   ```bash
   agent-fs --help
   agent-fs --version
   ```

5. **Test a command that triggers DB + sqlite-vec init:**
   ```bash
   agent-fs cat some-test-file.txt
   ```
   (or whichever command initializes the database)

6. **Clean up:**
   ```bash
   bun remove -g @desplega.ai/agent-fs
   ```

### Success Criteria:

#### Automated Verification:
- [ ] Build succeeds: `bun run build`
- [ ] Pack succeeds: `cd packages/cli && bun pm pack`
- [ ] Typecheck passes: `bun run typecheck`
- [ ] Tests pass: `bun run test`

#### Manual Verification:
- [ ] `agent-fs --help` shows help output after global install from tarball
- [ ] `agent-fs --version` shows correct version
- [ ] A DB-initializing command works (sqlite-vec loads successfully)
- [ ] No errors or warnings about missing native extensions

**Implementation Note**: This phase validates the full migration. If any step fails, debug and fix before considering the migration complete.

---

## Testing Strategy

- **Unit/integration tests**: Existing tests (`bun run test`) already use `sqliteVec.load(sqlite)` directly in `test-utils.ts` — they validate the post-migration code path.
- **Type checking**: `bun run typecheck` catches any import/type issues from removed code.
- **Build verification**: Each phase verifies `bun run build` still works.
- **Local E2E**: Phase 6 does a full tarball → global install → CLI execution cycle.
- **CI verification**: After merge, the next `v*` tag push validates the CI pipeline end-to-end.

## References

- Research: `thoughts/taras/research/2026-03-16-npm-distribution-migration.md`
- qmd reference: `@tobilu/qmd` npm package (target distribution model)
- Related research: `thoughts/taras/research/2026-03-16-sqlite-vec-bundling-comparison.md`
- Related research: `thoughts/taras/research/2026-03-16-native-extensions-bun-compile.md`

---

## Review Errata

_Reviewed: 2026-03-16 by Claude_

### Resolved

- [x] **Phase 2 `dirname` fix** — corrected plan to only remove `join` import, keeping `dirname` (still used at line 30)
- [x] **Dockerfile** — added Phase 4 to rewrite Dockerfile for npm-based distribution
- [x] **Missing docs** — expanded Phase 6 to include `README.md`, `CONTRIBUTING.md`, `docs/deployment.md`
- [x] **GitHub Release install instructions** — added static install/update instructions to the `gh release create` step in Phase 5
- [x] **`prepublishOnly` double-build** — keeping it for manual `bun publish` convenience; CI double-build is harmless (idempotent)
- [x] Verified `test-utils.ts:39` uses `sqliteVec.load(sqlite)` directly (no try/catch)
- [x] Verified `scripts/release.sh` only creates git tags
- [x] `docker-compose.yml` and `docker-compose.hosted.yml` do NOT reference `build.sh` — no changes needed

### Implementation Errata (2026-03-16)

- [x] **Workspace packages not on npm** — `--packages external` externalizes workspace deps (`@desplega.ai/agent-fs-core`, etc.) which aren't published. Fixed by replacing `--packages external` with individual `--external` flags for each npm dependency. Workspace code is now bundled into `cli.js` (124KB vs 37KB). Removed workspace deps from `dependencies`.
- [x] **Double shebang** — `bun build --target bun` already adds `#!/usr/bin/env bun`. The manual prepend in `build:npm` created a double shebang causing `Syntax Error` at runtime. Removed the manual shebang prepend.
- [x] **`.gitignore` tarballs** — added `*.tgz` to `.gitignore`

### E2E Results

- [x] `bun run build` — passes (124.64KB bundle)
- [x] `bun run typecheck` — passes
- [x] `bun run test` — 269 pass, 0 fail
- [x] `bun pm pack` — produces 63.76KB tarball, no `src/` in contents
- [x] `bun add -g <tarball>` — installs successfully with `agent-fs` binary
- [x] `agent-fs --help` — shows full help output
- [x] `agent-fs --version` — outputs `0.1.5`
- [x] `agent-fs ls /` — DB + sqlite-vec init works, lists files correctly

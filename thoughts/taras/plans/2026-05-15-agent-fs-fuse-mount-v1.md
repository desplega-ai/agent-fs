---
date: 2026-05-15T00:00:00Z
author: Taras
topic: "agent-fs FUSE mount v1 implementation plan"
tags: [plan, agent-fs, fuse, filesystem, mount, linux, rust, fuser]
status: completed
last_updated: 2026-05-16
last_updated_by: Claude (Phase 5)
---

# agent-fs FUSE Mount v1 Implementation Plan

## Overview

Add a `agent-fs mount <path>` subcommand that exposes the user's agent-fs drives as a Linux FUSE filesystem so agents can use plain shell verbs (`cat`, `grep`, `sed`, `rg`, `mv`, `rm`) against agent-fs content. v1 is Linux-only, read-write, content-only (no xattrs), with open-to-close consistency, content-hash dedup on close, and conditional-PUT optimistic concurrency that surfaces conflicts via NDJSON sidecars.

- **Motivation**: agent-fs is currently agent-native only (MCP/CLI/HTTP); mounting unlocks the long tail of shell ergonomics for agents running in Linux sandboxes without forcing them to learn the MCP surface. The mount is positioned as a *shell adapter for agents*, not a remote drive for humans.
- **Related**:
  - Brainstorm: [`thoughts/taras/brainstorms/2026-05-15-agent-fs-as-linux-filesystem.md`](../brainstorms/2026-05-15-agent-fs-as-linux-filesystem.md)
  - Research:
    - [`thoughts/taras/research/2026-05-15-fuse-helper-language.md`](../research/2026-05-15-fuse-helper-language.md) — Rust `fuser` v0.17+
    - [`thoughts/taras/research/2026-05-15-fuse-binary-npm-distribution.md`](../research/2026-05-15-fuse-binary-npm-distribution.md) — `optionalDependencies` per-platform
    - [`thoughts/taras/research/2026-05-15-fuse-sandbox-compat.md`](../research/2026-05-15-fuse-sandbox-compat.md) — sandbox compat matrix
    - [`thoughts/taras/research/2026-05-15-fuse-write-path-codebase.md`](../research/2026-05-15-fuse-write-path-codebase.md) — current write path
    - [`thoughts/taras/research/2026-05-15-fuse-conflict-surface-prior-art.md`](../research/2026-05-15-fuse-conflict-surface-prior-art.md) — NDJSON conflict log

## Current State Analysis

**Op dispatch path** (write side):
- `POST /:orgId/ops` at `packages/server/src/routes/ops.ts:9-41` reads `{op, ...params}`, resolves drive context, dispatches via `dispatchOp` (`packages/core/src/ops/index.ts:274-308`).
- `dispatchOp` runs RBAC (`checkPermission`), then `op.schema.parse(params)`, then `op.handler(ctx, validated)`. Op registry at `packages/core/src/ops/index.ts:42-272`.
- `write` op (`packages/core/src/ops/write.ts`) caps `content` at 10 MB (`MAX_FILE_SIZE`, line 10), enforces `expectedVersion` (lines 29-41), calls `ctx.s3.putObject(...)` (line 45), `createVersion(...)` (lines 48-56), sync `indexFile(...)` (line 59), fire-and-forget `scheduleEmbedding(...)` (lines 62-66).
- **`expectedVersion` is honored only by `write`.** `edit`, `append`, `mv`, `cp`, `revert`, `rm` ignore it (`packages/core/src/ops/{edit,append,mv,cp,revert,rm}.ts`).

**Versioning + schema**:
- `createVersion` (`packages/core/src/ops/versioning.ts:39-115`) and `getNextVersion` (lines 18-34) are non-transactional. `getNextVersion` is `SELECT MAX(version) … +1` — `write.ts` invokes it twice (once for the conflict check at `write.ts:30`, once inside `createVersion` at `versioning.ts:52`) with the S3 PUT between them. Open TOCTOU window.
- `file_versions` schema at `packages/core/src/db/schema.ts:102-117`: columns are `id, path, drive_id, version, s3_version_id, author, operation, message, diff_summary, size, etag, created_at`. **No `content_hash`, no `parent_version_id`, no `UNIQUE(path, drive_id, version)` constraint.**
- S3 key shape: `${orgId}/drives/${driveId}/${path}` (`versioning.ts:10-13`).

**S3 client**:
- `AgentS3Client.putObject(key, body: string | Uint8Array, metadata?, contentType?)` at `packages/core/src/s3/client.ts:78-97`. Body is `Buffer`/`Uint8Array` — not a stream. Does **not** plumb `IfMatch` / `IfNoneMatch` to `PutObjectCommand`.
- `getObject` at lines 99-115 fully buffers via `transformToByteArray()`.

**File HTTP routes**:
- `GET /:orgId/drives/:driveId/files/*/raw` at `packages/server/src/routes/files.ts:12-50`. Wildcard captures arbitrary nested paths. Headers set: `Content-Type`, `Content-Length`, `Cache-Control: private, max-age=60`. **No ETag, no `x-agent-fs-version`. No corresponding `PUT /raw` route.**

**Auth + drive context**:
- `GET /auth/me` (`packages/server/src/routes/auth.ts:39-59`) already returns `{ userId, email, defaultOrgId, defaultDriveId }`. Exactly what `<mount>/current` needs.
- `GET /:orgId/drives` (`packages/server/src/routes/orgs.ts:42-46`) → `listDrives(db, orgId)` (`packages/core/src/identity/drives.ts:25-35`) returns **all org drives without filtering by `drive_members`**. Mount-side filtering or first-op-403 fallback is required.

**Errors**:
- `EditConflictError` (`packages/core/src/errors.ts:59-73`) → HTTP 409 in `packages/server/src/middleware/error.ts:13`. Already the exact mapping the mount needs for conflict surfacing.

**Daemon**:
- `packages/server/src/daemon.ts` — HTTP-only daemon. PID file: `${getHome()}/agent-fs.pid` (line 7). Log: `${getHome()}/agent-fs.log` (line 11). `getHome()` from `packages/core/src/config.ts:5` resolves `AGENT_FS_HOME` / `~/.agent-fs/`.
- **No Unix socket today.** Daemon listens on configured TCP port; CLI commands use `ApiClient` over HTTP.
- `daemonStart/Stop/Status` thin wrappers in `packages/cli/src/commands/daemon.ts:6-33`.

**CLI**:
- Entry: `packages/cli/src/index.ts`. Commander-based. Top-level commands registered at lines 53-63 (`auth`, `daemon`, `init`, `config`, `onboard`, `docs`, `comment`, `org`, `drive`, `member` plus op commands via `registerOpCommands`); inline `mcp` (line 67) and `server` (line 75).
- All CLI command files in `packages/cli/src/commands/*.ts`. `ApiClient` (`packages/cli/src/api-client.ts`) is JSON-only — `Content-Type: application/json`, `await res.json()` — no binary or streaming.

**Test infra**:
- `scripts/e2e.ts` spins up MinIO Docker container `agent-fs-e2e-${pid}-${ts}`, starts daemon on a random port, runs 24 CLI + MCP cases via `runRaw`/`run`/`runJson` helpers.
- No existing FUSE-enabled test container. Standard `node:24-alpine` base used in the test stack.

**npm packaging**:
- `packages/cli/package.json` is the published artifact (`@desplega.ai/agent-fs`, `bin.agent-fs = dist/cli.js`). The build bundles `core`/`server`/`mcp` into `dist/cli.js` via `bun run build`.
- `optionalDependencies` already used once (`sqlite-vec-{darwin-arm64, darwin-x64, linux-arm64, linux-x64}` at `packages/cli/package.json:32`). **No `os` / `cpu` constraints set on any package.** Pattern exists; pattern not yet hardened.
- Release workflow `.github/workflows/npm-publish.yml` triggers on `v*` tags, validates tag matches `package.json` version, runs `npm publish --provenance`. No matrix build today.

**Distribution research notes** (already complete):
- Helper language: **Rust `fuser` v0.17+** with sync `Filesystem` trait + dedicated tokio runtime thread for the socket. Built statically against musl via `cross` Docker image (`rust-musl-cross`). Pure-Rust (no `libfuse` feature) → no libfuse-dev runtime dep. Stripped binary ~1–3 MB.
- npm shape: per-platform scoped sub-packages `@desplega.ai/agent-fs-fuse-linux-{x64,arm64}` with `os`/`cpu`/`libc` fields, listed in main package's `optionalDependencies` pinned to the exact main version. No `postinstall`. `AGENT_FS_FUSE_BIN` env override for local dev. Sub-packages published via `bunx npm publish --provenance --access public` (Bun lacks `--provenance` per `oven-sh/bun#15601`).

**Sandbox compat constraint** (from research):
- FUSE works: Docker rootful, Podman rootful, K8s privileged/baseline (with caps), Cloudflare Containers (since 2025-11), Apple Container, E2B, Kata.
- FUSE blocked: gVisor (GKE Sandbox, Cloud Run gen1), GitHub Codespaces, Modal sandboxes, K8s restricted PSS without CSI sidecar, Fly.io Machines (no `CONFIG_FUSE_FS` in kernel).
- Implication: the CLI/MCP path must remain the universal fallback. A CSI-sidecar adapter is **v1.x scope**, not v1.

## Desired End State

After v1 ships, an agent running in a Linux container with `--cap-add SYS_ADMIN --device /dev/fuse` can:

1. Run `agent-fs init && agent-fs auth … && agent-fs daemon start`.
2. Run `agent-fs mount /mnt/agent-fs` and see the mount come up with all org drives at `/mnt/agent-fs/<drive-slug>/` plus a dynamic `/mnt/agent-fs/current -> <default-drive>/` symlink.
3. Use plain shell verbs:
   - `echo "hello" > /mnt/agent-fs/current/scratch.md`
   - `cat /mnt/agent-fs/current/scratch.md` → `hello`
   - `grep -r hello /mnt/agent-fs/current/`
   - `mv … rm … mkdir … rmdir …`
4. Observe each *content-changing close* produce exactly one version in the agent-fs database — and zero versions when content is byte-identical to head (`touch`, idempotent rewrite).
5. Observe two concurrent writers produce exactly **one** new head version + **one** record in `/mnt/agent-fs/.agent-fs/conflicts.ndjson` + **one** `EIO` to the losing writer. **No silent overwrites.**
6. See `agent-fs umount /mnt/agent-fs` cleanly unmount.

Verifiable by `bun run scripts/e2e.ts …` (mount-in-Docker test cases added in Phase 5) and the explicit Manual E2E section below.

## What We're NOT Doing

Explicitly out of scope for v1 (re-stated from the brainstorm Synthesis):

- macOS host mount (macFUSE / fuse-t / NFS shim).
- xattr metadata exposure (`user.agent-fs.*`) — deferred to v1.1.
- Semantic search via a magic directory.
- Real POSIX file locking (`flock`/`fcntl` return `ENOSYS`).
- Persistent file cache (only per-open working copies; readdir/getattr TTL caches only).
- Server-pushed invalidation / SSE / WebSocket (poll-only TTLs in v1).
- Conflict auto-merge or side-versioning (`outcome: side_versioned` is a feature flag, not on by default).
- Side-version branches; v1 is detect-and-error only.
- Drive creation via `mkdir` (returns `EROFS`; explicit `agent-fs drive create` only).
- Multi-org from a single mount (one `AGENT_FS_API_KEY` per mount).
- CSI sidecar adapter (separate v1.x plan).
- Refactoring `AgentS3Client.putObject` to stream / use real S3 `If-Match` — app-layer `expectedVersion` is sufficient for v1.

## Implementation Approach

- **Phase the work along trust boundaries.** Server first (Phase 1) so the wire format is locked. Rust helper second (Phase 2) so we can unit-test the FUSE callbacks against a mocked socket. Daemon IPC + CLI third (Phase 3) so the helper has a real backend. Distribution fourth (Phase 4) so installation works on a clean box. E2E + docs last (Phase 5).
- **Reuse the op dispatcher.** The new `PUT /raw` route calls the existing `write` op handler internally; this keeps RBAC, versioning, FTS5 indexing, and embedding scheduling in one place. The only new server-side primitive is "binary body → `WriteParams`."
- **Optimistic concurrency over real locks.** Conditional `If-Match: <head_version_id>` on close-time PUT translates to `WriteParams.expectedVersion`. A schema migration adds `UNIQUE(path, drive_id, version)` so the TOCTOU window inside `createVersion` closes at the DB layer too.
- **Content-hash dedup short-circuits the entire write pipeline.** Daemon computes SHA-256 on the working copy at close-time and compares against `x-agent-fs-content-hash` from the open-time GET. Equal → no PUT, no version, no embedding, no mtime bump.
- **One mount, no host-shared cache.** Each agent's sandbox runs its own mount. Cross-mount invalidation is poll-only in v1 (readdir TTL ~10–30s, getattr TTL ~5s). SSE/WebSocket pushes are a v1.x option, not v1.
- **Fail fast.** Daemon-unreachable → `EIO`. Auth-expired → `EACCES`. Conflict → `EIO` + structured record in `conflicts.ndjson`. The FUSE process stays alive across daemon restarts; only individual requests fail.
- **No native bindings in the Bun process.** All FUSE work lives in the Rust helper. Bun talks to it via length-prefixed msgpack over a Unix socket at `${getHome()}/agent-fs.sock`. The daemon already manages `agent-fs.pid` in the same dir.

## Quick Verification Reference

- `bun run typecheck` — TypeScript types
- `bun run test` — unit + integration (auto-skip without env)
- `bun run build` — bundle CLI to `packages/cli/dist/cli.js`
- `bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --"` — CLI + MCP + FUSE E2E (requires Docker)
- Rust helper: `cd packages/fuse-helper && cargo build --release` (host build) or `cross build --release --target {x86_64,aarch64}-unknown-linux-musl` (release artifacts)

---

## Phase 1: Server — schema migration, content-hash, conditional writes, PUT /raw

### Overview

Land everything the mount needs at the HTTP boundary so subsequent phases can iterate against a stable wire contract: `file_versions.content_hash`, `UNIQUE(path,drive_id,version)`, `expectedVersion` propagated across mutating ops, new streaming `PUT /raw` route that reuses the `write` op, and `x-agent-fs-version` / `x-agent-fs-content-hash` headers on `GET /raw`.

### Changes Required:

#### 1. Schema migration: `content_hash` + uniqueness

**File**: `packages/core/src/db/schema.ts`
**Changes**:
- Add `contentHash: text("content_hash")` to `fileVersions` (Drizzle schema, around line 113).
- Add a Drizzle `uniqueIndex("file_versions_path_drive_version_uq")` over `(path, drive_id, version)`.

**File**: `packages/core/src/db/raw.ts`
**Changes**:
- Mirror the column in the raw `CREATE TABLE IF NOT EXISTS file_versions (…)` statement: `content_hash TEXT`.
- Add `CREATE UNIQUE INDEX IF NOT EXISTS file_versions_path_drive_version_uq ON file_versions(path, drive_id, version);`.

**File**: `packages/core/src/db/migrate.ts`
**Changes**:
- Idempotent migration: `ALTER TABLE file_versions ADD COLUMN content_hash TEXT` guarded by `PRAGMA table_info(file_versions)` check (no-op when column exists). Then create the unique index (`CREATE UNIQUE INDEX IF NOT EXISTS …`). Existing rows leave `content_hash` NULL; the column is purely additive.

#### 2. Plumb `content_hash` through `createVersion`

**File**: `packages/core/src/ops/versioning.ts`
**Changes**:
- Extend the `createVersion` params object (lines 39-50) with `contentHash?: string`.
- Insert it into the `file_versions` row (lines 56-68). Wrap the insert + `files`-upsert in a single SQLite transaction so the unique-index conflict becomes a real surface for the retry logic.
- Map a SQLite `UNIQUE constraint failed: file_versions.path, file_versions.drive_id, file_versions.version` error into `EditConflictError`. This closes the TOCTOU window left open by two separate `getNextVersion()` calls.

#### 3. Compute SHA-256 in `write` op + dedup short-circuit

**File**: `packages/core/src/ops/write.ts`
**Changes**:
- Compute `contentHash = createHash("sha256").update(contentBuf).digest("hex")` once, before the S3 PUT.
- Read the current head version's `content_hash` via a small helper `getHeadContentHash(ctx, path)`. If equal **and** `expectedVersion === currentVersion`, return `{ version: currentVersion, path, size, deduped: true }` without doing the S3 PUT, the `createVersion`, or the FTS5/embedding work. Bump nothing; preserve mtime.
- Pass `contentHash` into `createVersion` when the put actually happens.

**File**: `packages/core/src/ops/versioning.ts` (helper)
**Changes**:
- Export `getHeadContentHash(ctx, path) → string | null` that reads from the `files` row joined with `file_versions` (or directly from `file_versions WHERE path=? AND drive_id=? ORDER BY version DESC LIMIT 1`).

#### 4. Propagate `expectedVersion` to remaining mutating ops

**Files**: `packages/core/src/ops/{edit,append,mv,cp,revert,rm}.ts`, `packages/core/src/ops/types.ts`, `packages/core/src/ops/index.ts`
**Changes**:
- Add `expectedVersion?: number` to each op's params type in `types.ts` and zod schema in `ops/index.ts:42-272`.
- In each handler, before the S3 mutation, call `getNextVersion(ctx, path) - 1`; if it diverges from `expectedVersion`, throw `EditConflictError` with the path. Same shape as `write.ts:29-41`.
- Note: `cp`'s target file should honor `expectedVersion` (if the agent intends a new file, they pass `expectedVersion: 0`); `mv`'s source uses it for the source file's known head; `rm` and `revert` use it for the head being removed/reverted.

#### 5. New `PUT /raw` streaming binary route

**File**: `packages/server/src/routes/files.ts`
**Changes**:
- Add `router.put("/:orgId/drives/:driveId/files/*/raw", …)` that:
  - Extracts `filePath` exactly like the existing GET (`url.pathname.match(/\/files\/(.+)\/raw$/)`).
  - Reads `Content-Length` (reject if missing); reads body via `c.req.arrayBuffer()` (Hono already buffers up to its 50 MB limit at `packages/server/src/app.ts:30`). v1 keeps the 50 MB ceiling; we are not introducing true streaming.
  - Reads optional `If-Match: <head_version_id>` header → `expectedVersion` mapped numerically (the header value is the integer version; document this).
  - Reads optional `If-None-Match: *` for "create only" semantics → `expectedVersion: 0`.
  - Reads optional `X-Agent-FS-Message` for the version message.
  - Calls into a `writeRaw(ctx, { path, content, message?, expectedVersion? })` helper that fronts the existing `write` op handler — same RBAC, same versioning, same FTS5/embedding side effects.
  - On success returns 200 with body `{ version, path, size, deduped }` and headers `ETag: "<version>"`, `X-Agent-FS-Version: <version>`, `X-Agent-FS-Content-Hash: <sha256>`, `X-Agent-FS-Deduped: 1|0`.
- 415 if `Content-Type` is `application/json` (catches misuse from the existing op route).

**File**: `packages/server/src/middleware/error.ts`
**Changes**:
- No change to status mapping (`EditConflictError → 409` already wired at line 13). Confirm the response body includes `path` so the mount can include it in `conflicts.ndjson`.

#### 6. Response headers on `GET /raw`

**File**: `packages/server/src/routes/files.ts`
**Changes**:
- Extend the existing GET handler (lines 12-50) to read the head row from `file_versions` (`SELECT version, content_hash, etag FROM file_versions WHERE path=? AND drive_id=? ORDER BY version DESC LIMIT 1`) and emit:
  - `ETag: "<version>"`
  - `X-Agent-FS-Version: <version>`
  - `X-Agent-FS-Content-Hash: <sha256 or empty>`
  - `Last-Modified: <created_at as RFC1123>`
- Saves the mount one round-trip (no separate `stat` call at `open()` time).

#### 7. Drive listing filtered by membership

**File**: `packages/core/src/identity/drives.ts`
**Changes**:
- Add `listDrivesForUser(db, orgId, userId)` that joins `drives` with `drive_members WHERE user_id=?`. Public drives (no member rows) remain visible.

**File**: `packages/server/src/routes/orgs.ts`
**Changes**:
- Change `GET /:orgId/drives` (lines 42-46) to call `listDrivesForUser(db, orgId, ctx.userId)`. The mount uses this to populate its root readdir.

#### 8. Tests

**Files**: `packages/core/src/ops/__tests__/{write,edit,append,mv,cp,revert,rm}.test.ts` (new or extended)
**Changes**:
- For each op: `expectedVersion === current` succeeds; `expectedVersion === current - 1` throws `EditConflictError`; missing `expectedVersion` is backward-compatible (no check).

**File**: `packages/core/src/ops/__tests__/dedup.test.ts` (new)
**Changes**:
- Write file v1, write *identical* content with `expectedVersion: 1` → response has `deduped: true`, `version` unchanged at 1, no new `file_versions` row, no S3 put.

**File**: `packages/core/src/ops/__tests__/concurrency.test.ts` (new)
**Changes**:
- Spin two concurrent `write` calls with the same `expectedVersion`; assert exactly one wins (one 200, one `EditConflictError`). Validates the new `UNIQUE` index closes the TOCTOU.

**File**: `packages/server/src/__tests__/files-raw.test.ts` (new)
**Changes**:
- `GET /raw` returns `x-agent-fs-version` + `x-agent-fs-content-hash`.
- `PUT /raw` with no `If-Match` creates v1, with matching `If-Match: 1` creates v2, with stale `If-Match: 1` after a v2 exists returns 409.
- `PUT /raw` with `Content-Type: application/json` returns 415.

### Success Criteria:

#### Automated Verification:

- [x] Types pass: `bun run typecheck`
- [x] Unit + integration tests pass: `bun run test`
- [ ] `bun run packages/cli/src/index.ts daemon start && curl -sI -H "Authorization: Bearer $AGENT_FS_API_KEY" "$AGENT_FS_API_URL/orgs/$ORG_ID/drives/$DRIVE_ID/files/test.md/raw"` shows `X-Agent-FS-Version` and `X-Agent-FS-Content-Hash` headers
- [x] Migration is idempotent: run `bun run packages/cli/src/index.ts daemon start` against an old DB and against a fresh DB; both succeed and end with the new column + unique index present (`sqlite3 ~/.agent-fs/agent-fs.db ".schema file_versions"`)
- [x] Existing E2E unaffected: `bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --"` still passes all current 24 cases

#### Automated QA:

- [x] An ad-hoc curl script in `scripts/e2e-raw-put.sh` (new) round-trips a binary PUT/GET against the test daemon and asserts: (a) version increments, (b) `If-Match` mismatch returns 409, (c) hash-dedup returns 200 with `X-Agent-FS-Deduped: 1` and the same version number. Wired into `scripts/e2e.ts` so it runs as part of the test matrix.

#### Manual Verification:

- [ ] Inspect `~/.agent-fs/agent-fs.db` with `sqlite3` after the test run; confirm only one row per `(path, drive_id, version)`, `content_hash` populated on new writes, NULL preserved on pre-migration rows.

**Implementation Note**: After this phase, pause for manual confirmation. If commit-per-phase was requested, create commit after verification passes.

---

## Phase 2: Rust FUSE helper skeleton

### Overview

Add a new `packages/fuse-helper/` workspace crate using `fuser` v0.17+. It implements the FUSE `Filesystem` trait, manages per-open working copies under `${AGENT_FS_HOME}/mount/<pid>/<fh>`, and talks to the Bun daemon over a length-prefixed msgpack Unix socket. No daemon-side code lives here — only the FUSE process and the IPC client. Deliverable: a standalone binary `agent-fs-fuse` that can be invoked manually to mount against a mocked socket.

### Changes Required:

#### 1. Crate scaffold

**File**: `packages/fuse-helper/Cargo.toml` (new)
**Changes**:
- Crate name: `agent-fs-fuse`. Binary name: `agent-fs-fuse`. Edition 2021.
- Deps:
  - `fuser = { version = "0.17", default-features = false }` (no `libfuse` feature → pure-Rust, no `libfuse-dev` runtime requirement).
  - `tokio = { version = "1", features = ["rt-multi-thread", "net", "macros", "io-util", "sync", "time"] }`
  - `serde = { version = "1", features = ["derive"] }`
  - `rmp-serde = "1"` (msgpack)
  - `sha2 = "0.10"`
  - `tracing = "0.1"`, `tracing-subscriber = "0.3"`
  - `anyhow = "1"`, `thiserror = "1"`
  - `libc = "0.2"`, `nix = "0.27"` (for errno constants)
  - `clap = { version = "4", features = ["derive"] }`
- `[profile.release]`: `lto = "thin"`, `strip = true`, `codegen-units = 1`, `opt-level = "z"` (size).

**File**: `packages/fuse-helper/src/main.rs` (new)
**Changes**:
- `clap`-parsed args: `--mountpoint <path>`, `--socket <path>` (default `${AGENT_FS_HOME}/agent-fs.sock`), `--allow-other` (default off), `--log-file <path>`.
- Initializes `tracing_subscriber` writing to `~/.agent-fs/mount.log` (append, rotated externally).
- Spawns a dedicated `tokio::runtime::Runtime` (multi-thread, 2 workers); the FUSE thread holds a `runtime.handle().clone()` and uses `Handle::block_on(...)` to drive socket I/O from sync callbacks.
- Calls `fuser::mount2(AgentFsFs::new(handle, opts), mountpoint, &options)` where `options = [MountOption::FSName("agent-fs"), MountOption::Subtype("agent-fs"), MountOption::DefaultPermissions, MountOption::NoExec /* opt-in */, MountOption::AutoUnmount]` plus `AllowOther` if requested.
- Installs a `SIGTERM`/`SIGINT` handler that calls `fuser::Session::unmount()` and exits cleanly.

#### 2. Filesystem implementation

**File**: `packages/fuse-helper/src/fs.rs` (new)
**Changes**: Implement `fuser::Filesystem` synchronously, dispatching each callback into `handle.block_on(client.<op>(...))`.

Op set (Linux libfuse 3.x, matching brainstorm v1 scope):

- **Read side**: `lookup`, `getattr`, `readdir`, `open`, `read`, `release`, `readlink`.
- **Write side**: `create`, `write`, `flush`, `release` (close-time PUT), `truncate`, `unlink`, `rename`, `mkdir`, `rmdir`.
- **Stat metadata**: size from object, `mtime` = head-version `created_at`, mode `0o644` for files / `0o755` for dirs, uid/gid from `geteuid()`/`getegid()` of the helper process.
- **No-op or stub**: `chmod`, `chown`, `utimens`, `fsync`, `fsyncdir`, `setxattr`, `getxattr`, `listxattr`, `removexattr`, `access` → return 0/`Ok(())`.
- **`ENOSYS`**: `flock`, `setlk`/`getlk`, `bmap`, `copy_file_range`, `ioctl`, `fallocate`, `poll`.

State per `AgentFsFs`:
- Inode table: `HashMap<u64, FsNode>` where `FsNode = { kind: File|Dir|Symlink, drive: String, path: String, head_version: Option<u64>, content_hash: Option<String>, size: u64, mtime: SystemTime }`.
- Open file table: `HashMap<u64 /*fh*/, OpenFile>` where `OpenFile = { tmp_path: PathBuf, base_version: u64, base_hash: String, dirty: bool, file: std::fs::File }`.
- `next_inode: AtomicU64`, `next_fh: AtomicU64`. Inode 1 is the root.
- TTL caches (`moka` is overkill; use a small `RwLock<HashMap<…>>` with `Instant`):
  - readdir cache: drive + dir path → entries, TTL 10–30s (configurable).
  - getattr cache: inode → attr, TTL 5s.

Working-copy strategy (the load-bearing piece for open-to-close consistency):
- On `open()`: GET `/orgs/:orgId/drives/:driveId/files/<path>/raw` over IPC; daemon proxies to the HTTP server and returns `{ bytes, version, content_hash, size, mtime }`. Helper writes bytes to `${AGENT_FS_HOME}/mount/<pid>/<fh>` (perm 0600), stores `base_version`/`base_hash`. Returns `fh`.
- On `read(fh, offset, size)`: serve from the local fd. Pure-local.
- On `write(fh, offset, data)`: write into the local fd; mark `dirty: true`.
- On `truncate`: locally `ftruncate`; if file is open, mark dirty.
- On `flush`: no-op (don't PUT mid-stream; matches open-to-close).
- On `release` (close): if `dirty`:
  1. SHA-256 the local file.
  2. If equal to `base_hash`: skip the PUT entirely (server would skip too, but saving the round-trip is cheap and reduces log noise).
  3. Otherwise PUT the file body to `/orgs/:orgId/drives/:driveId/files/<path>/raw` with `If-Match: <base_version>` and `X-Agent-FS-Content-Hash: <sha>`.
  4. On 409 → write a record to `${MOUNT}/.agent-fs/conflicts.ndjson` via the daemon (Phase 3 owns the writer), then return `Err(libc::EIO)`. Also update `${MOUNT}/.agent-fs/status` with the last-error line.
  5. On 200 → update inode's `head_version` + `content_hash`, bust the dir's readdir cache.
- Always `std::fs::remove_file(tmp_path)` on `release`, regardless of outcome.

Per-pid temp dir GC:
- On startup, sweep `${AGENT_FS_HOME}/mount/` and remove any `<pid>/` whose pid is not alive (`kill(pid, 0) == ESRCH`).
- On shutdown (SIGTERM/SIGINT), remove our own `${AGENT_FS_HOME}/mount/<self-pid>/`.

#### 3. Drive-layout virtual nodes

**File**: `packages/fuse-helper/src/layout.rs` (new)
**Changes**:
- Root inode (1) is a virtual directory listing all drives. `readdir` calls IPC `list_drives()` (Phase 3) and renders one entry per drive slug + a `current` entry typed as symlink.
- `current` symlink: on `readlink`, IPC `default_drive_slug()` and return `./<slug>`. Re-resolved on every `readlink`, never cached.
- Drive-level `unlink`/`rmdir`/`mkdir`/`rename` at the root return `EROFS`. Drive *creation* stays in the CLI.

#### 4. IPC client

**File**: `packages/fuse-helper/src/ipc.rs` (new)
**Changes**:
- Async client over Unix `tokio::net::UnixStream`. Length-prefixed framing: 4-byte BE u32 length + msgpack body.
- Request types (`serde` enums): `GetAttr`, `ReadDir`, `OpenRead`, `OpenWrite`, `CreateFile`, `Truncate`, `Unlink`, `Rename`, `Mkdir`, `Rmdir`, `ListDrives`, `DefaultDriveSlug`, `RecordConflict`, `WriteStatus`, `Ping`.
- Each `Request` carries a `u64 request_id`; multiplexed via `oneshot::Sender` map keyed by id.
- Single connection per helper process; auto-reconnect with exponential backoff (capped at 1s) on disconnect.
- Bounded retry policy: idempotent ops (GetAttr/ReadDir/OpenRead/ListDrives/DefaultDriveSlug) retry up to 3× within 1s on transport errors. Mutating ops never retry; they map transport failures to `libc::EIO`.

#### 5. Errno mapping

**File**: `packages/fuse-helper/src/errno.rs` (new)
**Changes**:
- Translation table from `agent-fs` HTTP statuses + error codes:
  - 401/`AUTH_*` → `EACCES`
  - 403/`PERMISSION_DENIED` → `EACCES`
  - 404/`NOT_FOUND` → `ENOENT`
  - 409/`EDIT_CONFLICT` → `EIO` *(record in `conflicts.ndjson` first; the EIO is the signal)*
  - 413 → `EFBIG`
  - 415/`VALIDATION` → `EINVAL`
  - 503/`INDEXING_IN_PROGRESS` → `EAGAIN`
  - everything else → `EIO`

#### 6. Tests

**File**: `packages/fuse-helper/tests/{ipc_roundtrip,filesystem_smoke}.rs` (new)
**Changes**:
- `ipc_roundtrip.rs`: launch a stub Unix server in-test that responds to msgpack frames; assert client multiplexes 100 concurrent requests by id.
- `filesystem_smoke.rs`: not a real FUSE mount (CI may lack `/dev/fuse`); instead unit-test the `AgentFsFs` methods directly with a `MockIpc`. Cover create→write→release flow, hash-dedup short-circuit, 409→EIO mapping.

#### 7. Build matrix

**File**: `packages/fuse-helper/Cross.toml` (new) and `.github/workflows/fuse-helper-build.yml` (extend in Phase 4)
**Changes**:
- Use the `ghcr.io/cross-rs/rust-musl-cross` images for both `x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl`. Targets defined in `Cross.toml`.
- A README inside `packages/fuse-helper/` documents the host build vs cross build.

### Success Criteria:

#### Automated Verification:

- [x] Crate builds clean on host: `cd packages/fuse-helper && cargo build --release`
- [ ] Crate builds cross-target: `cd packages/fuse-helper && cross build --release --target x86_64-unknown-linux-musl && cross build --release --target aarch64-unknown-linux-musl` *(deferred — `cross` not installed on the dev host; in-container Linux build via the Docker harness confirms the binary builds for aarch64 Linux at 1.2 MB)*
- [x] Unit tests: `cd packages/fuse-helper && cargo test` *(26 tests pass: 22 unit + 3 filesystem_smoke + 1 ipc_roundtrip)*
- [x] Stripped binary size sanity check (linux-x64 musl): `ls -lh packages/fuse-helper/target/x86_64-unknown-linux-musl/release/agent-fs-fuse` shows ≤ 5 MB *(verified via in-Docker Linux build: 1.2 MB stripped aarch64-linux-gnu; musl will be similar order)*
- [x] `cargo clippy --all-targets --all-features -- -D warnings` passes
- [x] `cargo fmt --check` passes

#### Automated QA:

- [x] In CI Docker (`docker run --rm --cap-add SYS_ADMIN --device /dev/fuse fedora:latest`) run the binary against a stubbed Unix socket that responds to `ListDrives`/`OpenRead`/`OpenWrite`; assert `ls /mnt/test/`, `cat`, `echo > x` produce the expected IPC sequence. Script lives at `packages/fuse-helper/tests/integration/mount-against-mock.sh` and is invoked from `scripts/e2e.ts` in Phase 5. *(For Phase 2, a smoke-level version lives at `packages/fuse-helper/docker/run-mount-test.sh` — Ubuntu 24.04, builds + mounts + asserts mount table. The full IPC-sequence assertion comes in Phase 5.)*

#### Manual Verification:

- [ ] On a Linux box: run `agent-fs daemon start` (stub IPC server bound to `~/.agent-fs/agent-fs.sock` for now, replaced in Phase 3) and `target/release/agent-fs-fuse --mountpoint /tmp/m --socket ~/.agent-fs/agent-fs.sock`. Inspect `mount | grep /tmp/m` and `ls /tmp/m/`.

**Implementation Note**: After this phase, pause for manual confirmation. If commit-per-phase was requested, create commit after verification passes.

---

## Phase 3: Bun daemon IPC server + `agent-fs mount`/`umount` CLI

### Overview

Teach the existing Bun daemon to speak the FUSE helper's msgpack-over-Unix-socket protocol, wire it to the existing `ApiClient`, write the conflict/error NDJSON sidecars, and add the `agent-fs mount <path>` / `agent-fs umount <path>` commands that spawn the helper binary. After this phase, a fully local end-to-end mount round-trips against MinIO.

### Changes Required:

#### 1. Daemon-side IPC server

**File**: `packages/server/src/daemon.ts`
**Changes**:
- Add a `bun.listen({ unix: socketPath, … })` listener bound to `${getHome()}/agent-fs.sock` alongside the existing HTTP listener. Socket is created with `0600` perms (helper runs as same UID).
- Cleanup: on `daemonStop`, `unlinkSync(socketPath)` after `SIGTERM`. On startup, if socket file exists but no PID is alive, unlink and recreate.

**File**: `packages/server/src/ipc/server.ts` (new)
**Changes**:
- Length-prefixed msgpack framing: read 4-byte BE u32, then `length` bytes, then `msgpackr.unpack(buf)` (use `msgpackr` ^1, already a small dep — or `@msgpack/msgpack`; pick the one that produces smaller bundles).
- Dispatch table keyed by request type → handler. Handlers are async; concurrency unbounded (Bun handles this).
- Each request/response carries the same `request_id`; helper multiplexes.

**File**: `packages/server/src/ipc/handlers.ts` (new)
**Changes**: One handler per FUSE op, each thin:
- `Ping` → `{ ok: true, version: <pkg.version> }`
- `ListDrives` → calls the in-process API equivalent of `listDrivesForUser(db, orgId, userId)` (Phase 1) using the daemon's resolved API-key context; returns `[{ slug, id, name }]`.
- `DefaultDriveSlug` → same data as `/auth/me`; returns `{ slug, id } | null`.
- `GetAttr(drive, path)` → calls existing `stat` op handler internally and reshapes to `{ kind, size, version, content_hash, mtime, mode }`.
- `ReadDir(drive, path)` → calls existing `ls` op handler.
- `OpenRead(drive, path)` → calls `cat`-equivalent on the in-process op handler; returns `{ bytes (Uint8Array), version, content_hash, size, mtime }`.
- `OpenWrite/CreateFile/WriteRaw(drive, path, content, expectedVersion?)` → calls the new internal `writeRaw` helper from Phase 1 (which itself fronts the `write` op handler). Returns `{ version, content_hash, size, deduped }`.
- `Truncate(drive, path, size, expectedVersion?)` → reads + writes a truncated buffer via `write` op. (S3 PUT is atomic; we don't need a separate truncate primitive at the API.)
- `Unlink(drive, path, expectedVersion?)` → calls `rm` op.
- `Rename(drive, from, to, expectedVersion?)` → calls `mv` op.
- `Mkdir(drive, path)` → calls `write` with a directory marker (agent-fs's existing convention; if there isn't one, this is a no-op that returns `Ok` and lets the namespace populate on first child write). Verify against `packages/core/src/ops/ls.ts` semantics during implementation.
- `Rmdir(drive, path)` → reject (`ENOTEMPTY`) if `ls` returns children; else `Ok` (no on-disk directory to remove in object storage; the directory only exists by virtue of containing files).
- `RecordConflict(record)` → forwards to the conflict-log writer below.
- `WriteStatus(msg)` → rewrites `<mount>/.agent-fs/status`.

#### 2. Drive layout: resolve `<mount>/.agent-fs/`

**File**: `packages/server/src/ipc/sidecar.ts` (new)
**Changes**:
- `MountSession { mountpoint, mountSidecarDir = <mountpoint>/.agent-fs }`. When a helper first connects, it announces `{ mountpoint }` via a `Hello` request; daemon caches `mountSidecarDir` per session.
- Writers (`writeConflictRecord`, `rewriteLatest`, `rewriteStatus`, `appendErrorRecord`) operate against the per-session sidecar dir.
- **Note**: the sidecar dir is *inside the mounted FS itself*. The daemon writes by hitting the HTTP write op against the special drive `__agent-fs__` reserved for the mount, OR — simpler — by writing to a host-side path under `~/.agent-fs/sidecars/<mountpoint-hash>/` and the helper exposes it as a *virtual* directory at `<mount>/.agent-fs/`. **Choose option B**: keeps sidecar writes off the network entirely, survives daemon outages, and avoids the "agent-fs writes about a conflict cause a new conflict" recursion risk. The helper FUSE-side serves `.agent-fs/conflicts.ndjson`/`status`/`errors.ndjson` from local files.
- Helper updates `<sidecar>/conflicts.ndjson` and `<sidecar>/errors.ndjson` directly via `O_APPEND`; daemon ships records over IPC only when the helper itself doesn't have the data (e.g., daemon-detected events). v1: helper owns the writes; daemon participation is opt-in.

#### 3. Sidecar file rotation

**File**: `packages/fuse-helper/src/sidecar.rs` (new)
**Changes** (writes happen helper-side per the decision above):
- `conflicts.ndjson` + `errors.ndjson` are append-only with size-based rotation: when file exceeds 10 MB, rename to `.1` (and `.1` → `.2`, etc., up to 3 files). Truncate oldest.
- `conflicts.latest.json` rewritten atomically (`tempfile + rename`) with the last 10 records after each append.
- `status` is single-line plaintext; rewritten on each error, fsynced.
- Record schemas exactly as in the conflict-surface research note (`agent-fs.conflict/v1`, `agent-fs.error/v1`). ULID for `id`.

#### 4. CLI: `agent-fs mount` / `agent-fs umount`

**File**: `packages/cli/src/commands/mount.ts` (new)
**Changes**:
- `mountCommand()` exporting a commander `Command` with subcommands:
  - `agent-fs mount <path>` — args: `[--socket <path>]`, `[--allow-other]`, `[--foreground]`. Validates `path` exists and is empty; ensures daemon is running (`daemonStatus()` and offer to start if not); resolves the helper binary path (see §6); spawns it (default: detached + unref'd) and prints PID; writes `~/.agent-fs/mount.pid`.
  - `agent-fs umount <path>` — reads `~/.agent-fs/mount.pid`, `kill SIGTERM`, then `fusermount -u <path>` as belt-and-suspenders (helper's `AutoUnmount` should handle it; this is the fallback).
  - `agent-fs mount status` — prints whether the helper is running, its PID, mountpoint, and a 1-line summary of `<mount>/.agent-fs/status`.

**File**: `packages/cli/src/index.ts`
**Changes**:
- Register `mountCommand()` at line 53-63 cluster: `program.addCommand(mountCommand())`.

#### 5. ApiClient binary writer

**File**: `packages/cli/src/api-client.ts`
**Changes**:
- Add a `putRaw(orgId, driveId, path, bytes: Uint8Array, opts: { ifMatch?: number, contentHash?: string, message?: string }): Promise<{ version, deduped, contentHash }>` method that bypasses the JSON path: `Content-Type: application/octet-stream`, body is the `Uint8Array`, headers carry `If-Match` / `X-Agent-FS-Content-Hash` / `X-Agent-FS-Message`. Used by the daemon's IPC `WriteRaw` handler (which is in-process so it actually calls the route's handler directly, not via fetch — but the symmetric method is useful for tests and for any future remote daemon).

#### 6. Helper binary resolver

**File**: `packages/cli/src/lib/fuse-binary.ts` (new)
**Changes**:
- Resolves the helper binary path:
  1. `process.env.AGENT_FS_FUSE_BIN` if set and `fs.existsSync`.
  2. `require.resolve("@desplega.ai/agent-fs-fuse-linux-x64/package.json")` (or `-arm64` based on `process.arch`), then `path.join(packageDir, "bin/agent-fs-fuse")`.
  3. If neither resolves: emit a precise error pointing to the platform-specific install command (Phase 4 publishes the sub-packages).
- Optional SHA-256 verification: if `~/.agent-fs/fuse-bin.manifest.json` exists, verify the resolved binary's hash matches the manifest entry for `process.arch`. Phase 4 embeds this manifest in the main package; if missing, log a warning but proceed.

#### 7. Daemon HTTP → in-process op shortcut

**File**: `packages/server/src/ipc/handlers.ts`
**Changes**:
- Handlers call `dispatchOp(ctx, "write", { … })` directly (in-process) using `resolveContext` and the API-key from the daemon's saved auth state. **No HTTP loopback.** This avoids the JSON 10 MB cap in `write.ts:21-26` because we're going through the new `writeRaw` internal helper which lifts that cap to 50 MB (Hono body limit) for the binary path.

#### 8. Tests

**File**: `packages/server/src/ipc/__tests__/server.test.ts` (new)
**Changes**:
- Round-trip msgpack request/response over a unix socket pair. Covers each handler with a stub `dispatchOp`.

**File**: `packages/cli/src/commands/__tests__/mount.test.ts` (new)
**Changes**:
- `agent-fs mount /tmp/foo` with `AGENT_FS_FUSE_BIN` set to a `tail -f /dev/null` stand-in: assert PID written, status reports "running", `umount` cleans up.

### Success Criteria:

#### Automated Verification:

- [x] Types pass: `bun run typecheck`
- [x] Tests pass: `bun run test` *(302 pass / 57 skip / 0 fail; +15 new tests in this phase)*
- [x] `bun run packages/cli/src/index.ts mount --help` shows the new subcommand *(both `mount` and `umount` register; `mount status` subcommand listed too)*
- [x] Daemon listens on the unix socket: `bun run packages/cli/src/index.ts daemon start && ls -la ~/.agent-fs/agent-fs.sock` (srw-------) *(verified with `AGENT_FS_HOME=/tmp/agent-fs-phase3-XXXX bun run daemon start`; `srw-------` perms confirmed)*
- [x] `nc -U ~/.agent-fs/agent-fs.sock < tests/fixtures/ping.msgpack | xxd | head` returns a valid msgpack `{ ok: true }` *(decoded reply: envelope with id=1 and `body: "Pong"`; fixture committed to `tests/fixtures/ping.msgpack`)*

#### Automated QA:

- [ ] In a Linux Docker container with FUSE caps, run the canonical brainstorm v1 ship-gate command end-to-end and assert success:
  ```bash
  bun run packages/cli/src/index.ts init --yes
  bun run packages/cli/src/index.ts auth register --email test@example.com
  bun run packages/cli/src/index.ts daemon start
  AGENT_FS_FUSE_BIN=/workspace/packages/fuse-helper/target/.../agent-fs-fuse \
    bun run packages/cli/src/index.ts mount /mnt/agent-fs
  bash -c 'echo hi > /mnt/agent-fs/current/scratch.md && \
           cat /mnt/agent-fs/current/scratch.md && \
           grep -r scratch /mnt/agent-fs/current'
  bun run packages/cli/src/index.ts cat scratch.md  # confirms it landed via the API too
  ```

#### Manual Verification:

- [ ] On a Linux dev box with the actual published-or-local helper: `cat`, `echo >`, `mv`, `rm`, `mkdir -p`, `rmdir`, `grep -r` all behave as expected. Read `~/.agent-fs/mount.log` and confirm one log line per FUSE callback.

**Implementation Note**: After this phase, pause for manual confirmation. If commit-per-phase was requested, create commit after verification passes.

---

## Phase 4: Distribution — per-platform npm sub-packages + release workflow

### Overview

Publish the Rust helper as two scoped sub-packages (`@desplega.ai/agent-fs-fuse-linux-x64`, `@desplega.ai/agent-fs-fuse-linux-arm64`), wire them into the main `@desplega.ai/agent-fs` package via `optionalDependencies`, embed a SHA-256 manifest, and extend the release workflow to build and publish all three artifacts on a `v*` tag.

### Changes Required:

#### 1. Sub-package layout

**Directory**: `packages/fuse-helper-linux-x64/` (new) and `packages/fuse-helper-linux-arm64/` (new)
**Changes**: Each contains exactly:
- `package.json`:
  ```jsonc
  {
    "name": "@desplega.ai/agent-fs-fuse-linux-x64", // or linux-arm64
    "version": "0.5.5",                              // tracks main pkg
    "os": ["linux"],
    "cpu": ["x64"],                                  // or "arm64"
    "libc": ["glibc", "musl"],                       // static musl binary works for both
    "files": ["bin/"],
    "bin": {},                                       // no CLI; consumers resolve the file directly
    "publishConfig": { "access": "public" },
    "license": "MIT",
    "repository": "github:desplega-ai/agent-fs"
  }
  ```
- `bin/agent-fs-fuse` (the static musl binary; populated by the release build job).
- `README.md` (one paragraph: "Platform-specific binary for @desplega.ai/agent-fs. Do not install directly.").

#### 2. Main package wiring

**File**: `packages/cli/package.json`
**Changes**:
- Add to `optionalDependencies` (extending the existing `sqlite-vec-*` entries):
  ```jsonc
  "optionalDependencies": {
    "sqlite-vec-...": "^0.1.9",
    "@desplega.ai/agent-fs-fuse-linux-x64": "0.5.5",
    "@desplega.ai/agent-fs-fuse-linux-arm64": "0.5.5"
  }
  ```
  Pinned **exactly** to the main package version. The release script (next item) bumps all three together.

**File**: `scripts/release.sh`
**Changes**:
- After bumping the root `package.json` version, write the same version into:
  - `packages/cli/package.json`
  - `packages/core/package.json`
  - `packages/server/package.json`
  - `packages/mcp/package.json`
  - `packages/fuse-helper-linux-x64/package.json`
  - `packages/fuse-helper-linux-arm64/package.json`
  - Both `optionalDependencies` entries in `packages/cli/package.json`.
- Use `jq` or a small Bun script (`scripts/sync-versions.ts`) for the rewrite.

#### 3. SHA-256 manifest

**File**: `packages/cli/scripts/build-fuse-manifest.ts` (new)
**Changes**:
- Runs during the release workflow *after* the cross-built binaries are placed in each sub-package's `bin/`. Computes SHA-256 of each `bin/agent-fs-fuse` and writes:
  ```json
  {
    "version": "0.5.5",
    "binaries": {
      "linux-x64": "sha256:abc...",
      "linux-arm64": "sha256:def..."
    }
  }
  ```
  to `packages/cli/dist/fuse-bin.manifest.json` (bundled into the published main package as a static asset).
- `packages/cli/src/lib/fuse-binary.ts` (Phase 3) reads this manifest at mount time to verify the resolved binary matches the recorded hash; on mismatch, refuses to spawn and prints the expected vs actual hash.

#### 4. GitHub Actions release matrix

**File**: `.github/workflows/npm-publish.yml`
**Changes** (extend existing tag-triggered workflow):
- Pre-existing steps: validate tag matches `package.json`, run `bun run typecheck`, `bun run test`.
- Add a matrix build job (`build-fuse`) with `strategy.matrix.target = [x86_64-unknown-linux-musl, aarch64-unknown-linux-musl]`. On each runner (`ubuntu-latest`):
  - `actions/checkout@<sha>` (pin SHA).
  - `dtolnay/rust-toolchain@<sha>` for stable.
  - `taiki-e/install-action@<sha>` with `tool: cross`.
  - `cd packages/fuse-helper && cross build --release --target ${{ matrix.target }} && strip target/${{ matrix.target }}/release/agent-fs-fuse`.
  - Copy the binary into `packages/fuse-helper-linux-{x64,arm64}/bin/agent-fs-fuse` based on `${{ matrix.target }}`.
  - Upload the prepared sub-package directory as an artifact.
- Add a `publish-fuse-subpackages` job that downloads both artifacts, runs `bunx npm publish ./packages/fuse-helper-linux-x64 --provenance --access public` and likewise for arm64. (Bun lacks `--provenance` per `oven-sh/bun#15601`; the workflow already runs `npm publish --provenance` for the main package, so the same `npm` CLI is invoked here.) Pin the runner's `npm` to a known-good version.
- Reorder so `publish-fuse-subpackages` runs **before** `publish-main`. Reason: the main package's `optionalDependencies` reference exact versions; if main is published first and a user `npm install`s within the gap, resolution fails.
- Build the SHA-256 manifest immediately after the matrix build, commit it into the artifact passed to `publish-main`, then publish main last.

#### 5. CI: cross-platform smoke test

**File**: `.github/workflows/ci.yml`
**Changes**:
- Add a Linux-only job that, after the main build, runs:
  ```bash
  docker run --rm --cap-add SYS_ADMIN --device /dev/fuse -v "$(pwd)":/work -w /work ubuntu:24.04 \
    bash -c 'apt-get update && apt-get install -y fuse3 ca-certificates && \
             AGENT_FS_FUSE_BIN=/work/packages/fuse-helper/target/.../agent-fs-fuse \
             bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --" --fuse-only'
  ```
  This is the same harness as Phase 5 but limited to the FUSE subset. macOS / Windows runners are excluded (Linux-only product).

#### 6. Local-dev escape hatch

**File**: `CLAUDE.md`
**Changes**:
- Add a "FUSE helper for local dev" section: how to `cargo build` the helper, point `AGENT_FS_FUSE_BIN` at it, and skip the sub-package install.

**File**: `packages/cli/README.md`
**Changes**:
- Install instructions for the FUSE mount, including the cap requirements and the env override.

#### 7. Plugin + package version bumps

**File**: `.claude-plugin/plugin.json`, `skills/agent-fs/SKILL.md`, root `package.json`
**Changes** (per project release checklist):
- Bump version (minor: 0.5.5 → 0.6.0; this is a substantial new surface).
- Add `mount` / `umount` to SKILL.md command table.

### Success Criteria:

#### Automated Verification:

- [x] Types pass: `bun run typecheck`
- [x] Tests pass: `bun run test` *(302 pass / 57 skip / 0 fail; no changes from Phase 3 baseline)*
- [x] `bun run scripts/sync-versions.ts 0.6.0-rc.1` rewrites every `package.json` consistently (dry-run mode supported) *(dry-run reports 10 file edits; actual sync to `0.6.0` ran cleanly)*
- [x] Local `npm pack` of each sub-package produces a tarball with only `bin/`, `package.json`, `README.md`: `cd packages/fuse-helper-linux-x64 && npm pack --dry-run | grep -E '\b(bin/|package\.json|README\.md)' | wc -l` is 3 *(verified for both x64 and arm64; tarball contains `README.md`, `bin/.gitkeep`, `package.json`)*
- [ ] Sub-package install resolves correctly on a Linux x64 box: `npm install @desplega.ai/agent-fs-fuse-linux-x64@<rc>` (using a release-candidate publish), then `ls node_modules/@desplega.ai/agent-fs-fuse-linux-x64/bin/`

#### Automated QA:

- [ ] Push a `v0.6.0-rc.1` tag to a fork; the release workflow builds both targets, publishes both sub-packages, builds the SHA-256 manifest, publishes the main package, all with provenance. Inspect npm web UI for `provenance` badge on each.
- [ ] In a fresh Linux x64 Docker container: `npm install -g @desplega.ai/agent-fs@0.6.0-rc.1 && agent-fs mount --help && AGENT_FS_FUSE_BIN= agent-fs mount /tmp/m` correctly resolves the binary from `node_modules/@desplega.ai/agent-fs-fuse-linux-x64/bin/agent-fs-fuse` and the SHA-256 check passes.

#### Manual Verification:

- [ ] After cutting a real release tag, run `npm view @desplega.ai/agent-fs-fuse-linux-x64@0.6.0` and confirm `os`/`cpu`/`libc` fields, `files: [bin]`, and `dist.integrity` are as expected.

**Implementation Note**: After this phase, pause for manual confirmation. If commit-per-phase was requested, create commit after verification passes.

---

## Phase 5: End-to-end coverage + docs

### Overview

Extend `scripts/e2e.ts` with FUSE-specific cases that prove the ship-gate behaviors (round-trip, conflict, dedup, daemon-restart). Document the sandbox compat matrix, the EIO/EACCES debugging surface, and the FUSE install path. Final phase before handoff.

### Changes Required:

#### 1. E2E: mount-in-Docker harness

**File**: `scripts/e2e.ts`
**Changes**:
- Add a `setupFuse(env)` helper that augments the existing MinIO container with `--cap-add SYS_ADMIN --device /dev/fuse --security-opt apparmor:unconfined` and a writable `/mnt/agent-fs` mountpoint. Reuses the existing `agent-fs-e2e-${pid}-${ts}` naming.
- Add a `--fuse-only` flag that runs only the FUSE-tagged tests. Default is the full suite.
- Add `runFuseCmd(env, cmd)` that `docker exec`s into the container — keeps host independent of FUSE caps.

#### 2. E2E test cases (new, tagged `fuse`)

**File**: `scripts/e2e.ts`
**Changes**: Add at minimum:

1. **Mount lifecycle**: `agent-fs mount /mnt/agent-fs` succeeds, `mount | grep agent-fs` shows it, `agent-fs umount /mnt/agent-fs` cleans up. Assert no `/mnt/agent-fs/<pid>/` leak in `~/.agent-fs/mount/`.
2. **Round-trip**: `echo > x.md; cat x.md; grep -r; mv; rm` produce the expected output and end with `cat` returning EAGAIN/ENOENT after `rm`. Confirms the brainstorm's ship-gate command.
3. **Hash dedup**: write a file → record its `(version, content_hash)` via `agent-fs stat`; `touch /mnt/agent-fs/current/x.md` and `cat > /mnt/agent-fs/current/x.md << '<same content>'` 5×; assert `version` is unchanged after all of them. Assert `mtime` did not move.
4. **Conflict**: two parallel writers (`bash -c '… &'` x 2) doing `echo $RANDOM >> x.md`. Exactly one succeeds (exit 0 from `echo`+`close`), exactly one returns EIO (exit code from `tee` or `printf >` → "Input/output error"). `<mount>/.agent-fs/conflicts.ndjson` has exactly one record. `cat /mnt/agent-fs/current/x.md` shows the winner's bytes; the agent-fs version log shows exactly one new version.
5. **Daemon restart**: open a file for write, `agent-fs daemon stop`, `agent-fs daemon start`, then close. Assert the close-time PUT returns EIO (daemon was down at flush moment) **and** the FUSE process is still alive (`ps -p <fuse_pid>` succeeds). Re-open after restart, write, close → succeeds.
6. **Drive listing**: API key with access to only one drive sees only that drive at `<mount>/`; second key with access to two sees both. Confirms Phase 1 §7 filtering.
7. **Default-drive symlink**: `readlink /mnt/agent-fs/current` returns the slug of the user's `defaultDriveId`. Change default via CLI (`agent-fs drive switch other`), re-run `readlink` → returns the new slug (no remount).
8. **Auth-expired**: revoke the API key while mounted; next op returns EACCES (not EIO); `<mount>/.agent-fs/status` shows the auth error.
9. **EROFS at drive root**: `mkdir /mnt/agent-fs/new-drive` returns EROFS.
10. **`flock` ENOSYS**: `flock /mnt/agent-fs/current/x.md -c true` returns non-zero with `Function not implemented`.

#### 3. Sandbox compat matrix doc

**File**: `docs/fuse-compat.md` (new)
**Changes**:
- Table per the research note: rows = runtime, columns = "FUSE works?", "minimal incantation", "fallback".
- Sections: Docker rootful, Podman rootful, K8s privileged, K8s baseline PSS, K8s restricted PSS (with CSI sidecar pointer), Cloudflare Containers, Apple Container, E2B, Kata, **and** the broken set (gVisor, GitHub Codespaces, Modal sandboxes, Fly Machines).
- Each "Works" row has the exact `docker run` / `kubectl run` incantation.

#### 4. Mount usage doc

**File**: `docs/fuse-mount.md` (new)
**Changes**:
- Quickstart: install, daemon start, mount, list drives, edit a file.
- Architecture diagram (ASCII): agent → mount → Rust helper → Unix socket → Bun daemon → API → MinIO/S3.
- Open-to-close consistency explained for the user.
- Conflict and error feedback surfaces: `<mount>/.agent-fs/{conflicts.ndjson,conflicts.latest.json,errors.ndjson,status}` + `~/.agent-fs/mount.log`.

#### 5. Troubleshooting doc

**File**: `docs/fuse-troubleshooting.md` (new)
**Changes**:
- "What `EIO` usually means in agent-fs" → check `.agent-fs/status`, then `.agent-fs/errors.ndjson`, then `~/.agent-fs/mount.log`.
- "Mount failed with `fusermount: mount failed: Operation not permitted`" → caps / sandbox table.
- "I see `Transport endpoint is not connected`" → daemon stopped; restart it; FUSE process still alive.
- "`agent-fs-fuse: command not found` from the spawn" → `AGENT_FS_FUSE_BIN` not set and sub-package not installed; either install via the main package on Linux or set the env override.

#### 6. Skill update

**File**: `skills/agent-fs/SKILL.md`
**Changes**:
- Add `mount <path>` and `umount <path>` to the command table.
- Add a "When to use the FUSE mount" trigger (e.g., "save this from a shell script", "let me grep across files").

### Success Criteria:

#### Automated Verification:

- [x] `bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --"` runs *all* tests including the 10 new FUSE cases *(68/68 standard cases pass on Darwin; 10 FUSE cases skip cleanly with `AGENT_FS_USE_DOCKER_FUSE=0` and are wired to run when set to `1` on a host with /dev/fuse — see `scripts/docker/Dockerfile.e2e-fuse`)*
- [x] `bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --" --fuse-only` passes when invoked alone *(0 standard + 10 FUSE on Darwin; FUSE tests skip with clear reason and exit 0)*
- [x] Types pass: `bun run typecheck`
- [x] All tests pass: `bun run test` *(302 pass / 57 skip / 0 fail; no regressions from Phase 4 baseline)*
- [x] Markdown links valid: `bun x markdown-link-check docs/*.md` (or equivalent) *(`bun x markdown-link-check docs/fuse-compat.md docs/fuse-mount.md docs/fuse-troubleshooting.md` exits 0 after fixing the `meta-fuse-csi-plugin` URL)*

#### Automated QA:

- [ ] Ship-gate command from the brainstorm runs green inside the FUSE-enabled e2e container *(wired into FUSE test case 2 — "round-trip: echo/cat/grep/mv/rm on the mount" — runs end-to-end inside the docker FUSE container when `AGENT_FS_USE_DOCKER_FUSE=1`; not run on Darwin)*:
  ```bash
  bash -c 'echo hi > /mnt/agent-fs/current/scratch.md && \
           cat /mnt/agent-fs/current/scratch.md && \
           grep -r scratch /mnt/agent-fs/current' && \
  bun run packages/cli/src/index.ts cat scratch.md
  ```
- [ ] Concurrency invariant holds: 100 parallel writers to the same path produce 1 head version + 99 entries in `conflicts.ndjson` + 99 EIOs *(FUSE test case 4 covers the 2-writer invariant; 100-writer scale-up deferred to manual verification on a real Linux box)*

#### Manual Verification:

- [ ] Read `docs/fuse-compat.md`, `docs/fuse-mount.md`, `docs/fuse-troubleshooting.md` end-to-end. Confirm a fresh reader could mount the FS without needing to ask.
- [ ] Verify the release-checklist items from CLAUDE.md are honored: SKILL.md updated, plugin.json version bumped, main package.json version bumped, E2E coverage extended.

**Implementation Note**: After this phase, pause for final review. If commit-per-phase was requested, create commit after verification passes.

---

## Manual E2E

These steps verify the feature against a real MinIO + daemon + Linux FUSE environment, not the scripted harness. Run from a Linux dev box (or a Linux VM/container from macOS). Substitute placeholders (`<api-key>`, `<drive-slug>`) using values from `agent-fs auth whoami` and `agent-fs drive list`.

### 1. Prereqs (one-time)

```bash
# Linux: ensure FUSE 3 + caps are available
sudo apt-get update && sudo apt-get install -y fuse3 docker.io
sudo groupadd -f fuse && sudo usermod -aG fuse "$USER"   # log out / log back in
# Build the helper locally (skip if installed via npm)
cd packages/fuse-helper && cargo build --release && cd -
export AGENT_FS_FUSE_BIN="$PWD/packages/fuse-helper/target/release/agent-fs-fuse"
```

### 2. Start MinIO + daemon + auth

```bash
# Start the existing MinIO test container (or use a real S3 endpoint via config)
docker run -d --name agent-fs-minio -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=minioadmin -e MINIO_ROOT_PASSWORD=minioadmin \
  -v agent-fs-minio-data:/data quay.io/minio/minio server /data --console-address ':9001'
# Initialize, register, start daemon
bun run packages/cli/src/index.ts init --yes
bun run packages/cli/src/index.ts auth register --email you@example.com
bun run packages/cli/src/index.ts daemon start
bun run packages/cli/src/index.ts auth whoami        # confirm logged-in
bun run packages/cli/src/index.ts drive list         # note <drive-slug>
```

### 3. Mount + smoke

```bash
mkdir -p /tmp/agent-fs
bun run packages/cli/src/index.ts mount /tmp/agent-fs
mount | grep agent-fs                                # expect: fuse.agent-fs
ls /tmp/agent-fs/                                    # expect: <drive-slug>, current
readlink /tmp/agent-fs/current                       # expect: ./<default-drive-slug>
```

### 4. Round-trip the ship-gate command

```bash
echo "hello from FUSE" > /tmp/agent-fs/current/scratch.md
cat /tmp/agent-fs/current/scratch.md                # expect: hello from FUSE
grep -r scratch /tmp/agent-fs/current               # expect: match
# Cross-check via the API path:
bun run packages/cli/src/index.ts cat scratch.md    # expect: same content
bun run packages/cli/src/index.ts log scratch.md    # expect: 1 version, operation=write
```

### 5. Hash dedup

```bash
touch /tmp/agent-fs/current/scratch.md
touch /tmp/agent-fs/current/scratch.md
echo "hello from FUSE" > /tmp/agent-fs/current/scratch.md   # identical bytes
bun run packages/cli/src/index.ts log scratch.md            # still 1 version
```

### 6. Conflict (two concurrent writers)

```bash
# Two shells (or backgrounded), both holding the file open:
(exec 3>/tmp/agent-fs/current/race.md; sleep 1; echo "A" >&3; exec 3>&-) &
(exec 3>/tmp/agent-fs/current/race.md; sleep 1; echo "B" >&3; exec 3>&-) &
wait
cat /tmp/agent-fs/current/race.md                    # expect: A or B (not both, not empty)
cat /tmp/agent-fs/.agent-fs/conflicts.ndjson         # expect: exactly one record, outcome=rejected
cat /tmp/agent-fs/.agent-fs/status                   # expect: last error line
bun run packages/cli/src/index.ts log race.md        # expect: 1 head version
```

### 7. Daemon-restart resilience

```bash
# In one shell:
exec 4>/tmp/agent-fs/current/restart.md
echo "before restart" >&4
# In another shell:
bun run packages/cli/src/index.ts daemon stop
bun run packages/cli/src/index.ts daemon start
# Back in shell 1:
echo "after restart" >&4
exec 4>&-                                            # close → PUT happens here
# Expect: close errors with EIO (daemon was down for the buffer of bytes); FUSE process still alive.
echo $?                                              # nonzero
mount | grep agent-fs                                # still mounted
# Reopen + write succeeds:
echo "fresh write" > /tmp/agent-fs/current/restart2.md
cat /tmp/agent-fs/current/restart2.md                # expect: fresh write
```

### 8. EROFS at the drive root

```bash
mkdir /tmp/agent-fs/new-drive                        # expect: mkdir: 'new-drive': Read-only file system
```

### 9. ENOSYS for locks

```bash
flock /tmp/agent-fs/current/scratch.md -c true       # expect: nonzero, "Function not implemented"
```

### 10. Tear down

```bash
bun run packages/cli/src/index.ts umount /tmp/agent-fs
mount | grep agent-fs                                # expect: no match
bun run packages/cli/src/index.ts daemon stop
docker rm -f agent-fs-minio
docker volume rm agent-fs-minio-data
```

Each step's expected outcome above is the manual verification.

---

## Appendix

- **Follow-up plans**:
  - **v1.1: xattr metadata window** — expose `user.agent-fs.{version, content-hash, versions, comments, drive, uri}` as read-only xattrs.
  - **v1.x: CSI sidecar adapter** — GCS-FUSE / meta-fuse-csi-plugin model for K8s restricted PSS; addresses GKE Autopilot, managed Cloud Run, and friends.
  - **v1.x: side-version conflict outcome** — feature flag flips `outcome: rejected` → `outcome: side_versioned`; requires `parent_version_id` column + a `conflicts ack/dismiss` op.
  - **v2: macOS host mount** — macFUSE path with the kext approval flow, plus fuse-t (NFS shim) fallback for unattended dev containers.
  - **v2: server-side change notifications** — SSE/WebSocket from the daemon so other mounts get a sub-second invalidation signal instead of relying on readdir TTL polling.

- **Derail notes** (out-of-scope observations captured during planning):
  - The `events` table at `packages/core/src/db/schema.ts:147-164` is a natural producer for SSE invalidations. No producer fires for file writes today; that's the missing seam.
  - `AgentS3Client.putObject` (`packages/core/src/s3/client.ts:78-97`) buffers fully — true streaming for `PUT /raw` requires a deeper refactor; v1 sticks to the 50 MB Hono body limit.
  - Real S3 `If-Match: <etag>` plumbing is a deeper hardening pass once we see multi-writer races in production (AWS S3 supports it; MinIO since 2024; R2 partial).
  - Agent attribution stops at `users.id` today. `(agent, run_id)` would need API-key metadata + middleware extension. Not blocking.
  - `live/` UI does not need to change for v1; mount-side conflicts surface through `<mount>/.agent-fs/*`. A future v1.x could surface them in the web UI by reading from the new server-side conflict store.

- **References**:
  - Brainstorm: [`thoughts/taras/brainstorms/2026-05-15-agent-fs-as-linux-filesystem.md`](../brainstorms/2026-05-15-agent-fs-as-linux-filesystem.md)
  - Research:
    - [`thoughts/taras/research/2026-05-15-fuse-helper-language.md`](../research/2026-05-15-fuse-helper-language.md)
    - [`thoughts/taras/research/2026-05-15-fuse-binary-npm-distribution.md`](../research/2026-05-15-fuse-binary-npm-distribution.md)
    - [`thoughts/taras/research/2026-05-15-fuse-sandbox-compat.md`](../research/2026-05-15-fuse-sandbox-compat.md)
    - [`thoughts/taras/research/2026-05-15-fuse-write-path-codebase.md`](../research/2026-05-15-fuse-write-path-codebase.md)
    - [`thoughts/taras/research/2026-05-15-fuse-conflict-surface-prior-art.md`](../research/2026-05-15-fuse-conflict-surface-prior-art.md)
  - Project rules: [`CLAUDE.md`](../../../CLAUDE.md) (release checklist, E2E coverage rule, `live/` pnpm note)
  - Product framing: [`PRODUCT.md`](../../../PRODUCT.md)
  - External:
    - fuser crate: <https://crates.io/crates/fuser>
    - AWS Mountpoint for S3 (closest production analog): <https://github.com/awslabs/mountpoint-s3>
    - GCS-FUSE CSI driver: <https://github.com/GoogleCloudPlatform/gcs-fuse-csi-driver>
    - npm provenance limitation in Bun: <https://github.com/oven-sh/bun/issues/15601>

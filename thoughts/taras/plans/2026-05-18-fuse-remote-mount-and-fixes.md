---
date: 2026-05-18T18:30:00Z
author: Taras & Claude
topic: "FUSE Remote-Mount Mode + Daemon/Install Fixes Implementation Plan"
tags: [plan, agent-fs, fuse, mount, sprite, e2b, hetzner, npm-install]
status: in-progress
autonomy: autopilot
last_updated: 2026-05-18T22:15:00Z
last_updated_by: Claude (phase-running, Phase 3)
---

# FUSE Remote-Mount Mode + Daemon/Install Fixes Implementation Plan

## Overview

Make `agent-fs mount` work in any Linux sandbox that can reach a hosted `agent-fs` HTTP API (Sprite, E2B, Hetzner VM, GitHub Actions runner, etc.) without requiring a local daemon. Fix two install-time bugs uncovered during the sprite test on 2026-05-18, and scaffold a `docs/mounting/` directory with general + per-env guides.

- **Motivation**: 2026-05-18 sprite test against `agent-fs-taras.fly.dev` proved FUSE plumbing works in a Linux sandbox, but the helper can only talk to a local Unix-socket daemon — so an agent running in a sandbox cannot mount a fly-hosted drive directly. Two install-time papercuts (`daemon start` path bug, optional FUSE subpackage not auto-installed) also surfaced. Taras wants "API runs outside where it's mounted" to be a first-class supported topology.
- **Related**:
  - `packages/fuse-helper/` — Rust FUSE helper crate
  - `packages/cli/src/` — Node/Bun CLI that spawns daemon + helper
  - `packages/server/` — HTTP API + IPC server
  - Dashboard test: file `/sprite-mount-test/hello-from-sprite.txt` written from sprite via HTTP, indexed end-to-end (2026-05-18, cleaned up)
  - Today's release: `v0.6.1` (msgpackr fix shipped to fly + npm)

## Current State Analysis

### FUSE helper architecture (already well-factored)

- Entry: `packages/fuse-helper/src/main.rs:37-61` — `clap`-parsed `Args { mountpoint, socket, allow_other, log_file }`. **No `--api-url` / `--api-key` exists today.**
- IPC trait abstraction already in place: `IpcTrait` at `packages/fuse-helper/src/ipc.rs:307-329`. Two impls today: `UnixIpcClient` (`ipc.rs:189-355`) + `MockIpc` (`ipc.rs:376-403`). **A third impl `HttpIpcClient` is the clean seam for remote mode.**
- 15 IPC request variants defined (`ipc.rs:68-136`); only ~12 are actually sent by FUSE callbacks (`Hello`, `CreateFile`, `Truncate`, `WriteStatus` are declared but unused today).
- Auth model: trust-the-socket. **No `Authorization` / `api_key` on the IPC wire at all.** The Rust crate has no `reqwest`/`hyper` dep (`Cargo.toml:17-50`).
- Retry policy already encoded: `is_idempotent` (`ipc.rs:357-368`) — `Ping`, `Hello`, `ListDrives`, `DefaultDriveSlug`, `GetAttr`, `ReadDir`, `OpenRead` retry 3× with 50→1000 ms backoff. Mutating ops never retry. Same policy should apply to HTTP.

### Server HTTP API (every IPC op has an equivalent — with caveats)

- HTTP routes in `packages/server/src/app.ts:18-77`. All non-CRUD ops go through `POST /orgs/:orgId/ops` (JSON dispatcher, `routes/ops.ts:9-41`) plus binary `GET|PUT /orgs/:orgId/drives/:driveId/files/*/raw` for FUSE-shaped reads/writes.
- Auth middleware: `Authorization: Bearer <api_key>` at `packages/server/src/middleware/auth.ts:8-45`, mounted globally at `app.ts:31`. `/auth/register`, `/health` are public.
- IPC → HTTP mapping table:

  | IPC op | HTTP equivalent | Notes |
  |---|---|---|
  | `ping` | `GET /health` | Cheap |
  | `hello` | none / `GET /auth/me` | IPC-only handshake; remote can validate creds against `/auth/me` |
  | `list_drives` | `GET /orgs` then per-org `GET /orgs/:orgId/drives` | IPC flattens across orgs |
  | `default_drive_slug` | `GET /auth/me` returns `defaultDriveId` | IPC returns slug; HTTP returns id — need slug lookup from drive list |
  | `get_attr` | `POST /orgs/:orgId/ops {op:"stat"}` | Chatty; called per `getattr` syscall |
  | `read_dir` | `POST .../ops {op:"ls"}` | Cached 15 s in helper (`fs.rs:92`) |
  | `open_read` | `GET .../files/*/raw` | **Binary streaming endpoint** (`routes/files.ts:24-84`). 50 MB Hono cap (`app.ts:30`) |
  | `open_write` | `PUT .../files/*/raw` with `If-Match` | 50 MB cap |
  | `create_file` | `PUT .../files/*/raw` with `If-None-Match: *` | `expectedVersion: 0` (`files.ts:138-139`) |
  | `truncate` | `POST .../ops {op:"write"}` RMW | No direct HTTP truncate |
  | `unlink` | `POST .../ops {op:"rm"}` | |
  | `rename` | `POST .../ops {op:"mv"}` | Single-drive only — `to_drive` field unused in IPC handler too (`handlers.ts:385-393`) |
  | `mkdir` | none — local no-op | Daemon also no-ops (`handlers.ts:395-401`) |
  | `rmdir` | empty-`ls` check then local no-op | Daemon does same (`handlers.ts:403-413`) |
  | `record_conflict` | none — log locally | Daemon `console.warn`s only |
  | `write_status` | none — log locally | Daemon `console.warn`s only |

- **Performance note**: `open_read` returns the entire file body inline. Reusing the binary `/files/*/raw` endpoint avoids the JSON-base64 path; helper streams to a local temp file.

### Bug 1: `agent-fs daemon start` ENOENT on npm-installed CLI

Root cause: `packages/server/src/daemon.ts:46-54` —

```ts
const isCompiled = !import.meta.dir.startsWith("/") || import.meta.dir.startsWith("/$bunfs");
const cmd = isCompiled ? process.execPath : "bun";
const args = isCompiled ? ["server"] : ["run", join(import.meta.dir, "index.ts")];
```

The `isCompiled` heuristic only recognizes Bun's single-file executable (`/$bunfs`). When installed via npm, `import.meta.dir` is `/usr/lib/node_modules/@desplega.ai/agent-fs/dist` — absolute, not `/$bunfs` — so it falls into the dev branch and spawns `bun run .../dist/index.ts`, which doesn't ship (`packages/cli/package.json:24-27` only ships `dist/cli.js`).

Workaround used in sprite test today: spawn `agent-fs server` directly with nohup. That works because `packages/cli/src/index.ts:77-82` uses `await import("@/server/index.js")` — in-process dynamic import of the bundled server, no child process, no filesystem path construction. Docker's `CMD ["bun", "run", "packages/cli/dist/cli.js", "server"]` works for the same reason.

### Bug 2: optional FUSE subpackage silently skipped on first `npm install -g`

Root cause: `packages/fuse-helper-linux-x64/package.json:11-14` declares `"libc": ["glibc", "musl"]`. npm's `libc` filter (added v10) only accepts a single string. Array → undocumented behaviour; on several npm/Node versions it evaluates as unsatisfied and silently skips the optional dep. (Esbuild/swc/rollup-style binary packages omit `libc` entirely and rely on `os`+`cpu` alone.)

Secondary contributor: `optionalDependencies` pin in `packages/cli/package.json:38-39` is exact (`"0.6.1"`) rather than range (`^0.6.1`), which makes npm's optional-resolution flakier on first global install (npm/cli#4828 family). All other optionals in that file use `^`.

Publish ordering is correct — `.github/workflows/npm-publish.yml:106-203` publishes sub-packages before main (`publish-main` depends on `publish-fuse-subpackages`).

### Sprite environment prereqs (discovered 2026-05-18)

Ubuntu 25.10 sprite needed all four of these before the mount succeeded:
1. `sudo apt-get install fuse3` (not preinstalled)
2. `sudo chmod 666 /dev/fuse` (default perms `c-w--wx-wT`, unreadable for non-root sprite user)
3. `sudo ln -sf /proc/mounts /etc/mtab` (mtab missing → fusermount3 errors)
4. `echo user_allow_other | sudo tee -a /etc/fuse.conf` (helper passes `allow_other`)

After these, mount table showed `agent-fs on /home/sprite/agent-fs-mnt type fuse.agent-fs`, log showed `ipc ping ok` + `fuse init`. Writes through the mount returned `EACCES` only because the sprite-local daemon had no S3 backend — the FUSE plumbing itself was healthy.

## Desired End State

After this plan ships:

1. `agent-fs daemon start` on an npm-installed CLI starts the daemon cleanly. No more `dist/index.ts` ENOENT.
2. `npm install -g @desplega.ai/agent-fs` on Linux x64/arm64 (both glibc and musl) auto-installs the matching FUSE subpackage without manual intervention.
3. New flag `agent-fs mount <path> --remote` (or auto-detected from config when `apiUrl` + `apiKey` are set) starts a FUSE mount whose ops route directly to a remote `agent-fs` HTTP API. No local daemon required.
4. The FUSE helper carries `--api-url` + `--api-key` (or reads `AGENT_FS_API_URL` / `AGENT_FS_API_KEY` from env) and uses a new `HttpIpcClient` Rust impl.
5. `scripts/e2e.ts` gains a remote-mount Docker test that spins up the daemon, mounts via HTTP, exercises read/write/ls/rm.
6. `docs/mounting/` exists with: `README.md` (general architecture + prereqs), `sprite.md`, `e2b.md`, `hetzner.md`.
7. Release notes + skill + plugin + package versions all bumped to `0.7.0` and shipped end-to-end (npm + Docker + fly).

Verifiable via the Manual E2E section at the bottom of this plan.

## What We're NOT Doing

- **Streaming reads/writes >50 MB.** The HTTP body cap (`app.ts:30`) and IPC frame cap (64 MB, `server.ts:18`) stay as-is. Large-file streaming is a separate plan.
- **Per-request authentication on local IPC.** Local socket-based trust is preserved. New `HttpIpcClient` carries its own bearer token; `UnixIpcClient` is unchanged.
- **Removing the local daemon.** This adds a remote topology; the existing local topology (daemon + S3 + SQLite) keeps working unchanged.
- **macOS FUSE.** Mount remains Linux-only. Darwin builds the helper for testing but `agent-fs mount` still errors out.
- **MCP-over-HTTP changes.** This plan touches only the FUSE mount path, not MCP transport.
- **Org/drive multi-tenancy in the helper.** Helper continues to assume a single default drive resolved via `default_drive_slug`. Cross-drive `rename` already EXDEVs (`fs.rs:582`) and stays that way.

## Implementation Approach

- **Bug fixes first** (Phase 1) so the next published version is npm-installable cleanly — this is also the version that will carry the remote-mount feature, so install-correctness is a prerequisite for E2E testing.
- **Add `HttpIpcClient` as a third `IpcTrait` impl** in the Rust helper. The trait already abstracts the transport (`ipc.rs:307-329`); `MockIpc` is precedent for a non-Unix impl. No FUSE-callback code in `fs.rs` should need to change — all the mapping is inside the new client.
- **Reuse the binary `/files/*/raw` endpoints** for `OpenRead` / `OpenWrite` / `CreateFile`. Cheaper than round-tripping bytes through msgpack-over-JSON.
- **Map other ops to `POST /orgs/:orgId/ops`** dispatcher. The IPC handler in `handlers.ts:194-440` already routes through `dispatchOp`; the HTTP equivalent calls the same core ops, so semantics line up.
- **Read-only first** (Phase 3), then write ops (Phase 4). Read-only is enough to prove the design, lower risk, and easier to test against the live fly instance.
- **Helper-level retry policy unchanged** — `is_idempotent` already lists the right ops, and the HTTP impl honors the same retry shape (3× backoff for safe ops, none for mutators).
- **Auth via env, not CLI flags.** `AGENT_FS_API_KEY` is read by the helper from env so it never appears in `ps` output. CLI accepts `--api-key` as a fallback but always forwards via env to the spawned helper.
- **Bump to `0.7.0`** for the release. This is a new user-visible feature (`mount --remote`), not a patch. Bug fixes ride along.

## Quick Verification Reference

- Typecheck: `bun run typecheck`
- Tests: `bun run test`
- CLI build: `bun run build`
- E2E suite: `bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --"`
- Rust helper unit + integration: `cd packages/fuse-helper && cargo test`
- Rust lint: `cd packages/fuse-helper && cargo clippy --all-targets -- -D warnings && cargo fmt --check`
- Rust mount harness (Docker): `packages/fuse-helper/docker/run-mount-test.sh`
- Sprite/Hetzner manual E2E: see `Manual E2E` at the end of this plan.

---

## Phase 1: Daemon-start fix + Optional FUSE subpackage fix

### Overview

Two install-time bug fixes shipped together so the next published artifact is cleanly npm-installable on a fresh Linux sandbox. Concrete deliverable: a clean `npm install -g @desplega.ai/agent-fs@<next>` on a vanilla Linux x64 Ubuntu/Alpine container installs both the main package and the matching FUSE subpackage, and `agent-fs daemon start` succeeds with no `dist/index.ts` ENOENT.

### Changes Required:

#### 1. `daemon start` respawn path

**File**: `packages/server/src/daemon.ts:46-54`
**Changes**: Replace the `isCompiled` heuristic with a robust check that detects whether the calling entry script is the bundled `dist/cli.js` (npm-installed *or* dev `bun run dist/cli.js`) vs. development source (`bun run packages/cli/src/index.ts`). Two safe options:
- **Option A (preferred)**: Use `Bun.argv[1]` (or `process.argv[1]`) as the entry script and spawn `[process.execPath, entryScript, "server"]`. Works in npm-install (entry is `dist/cli.js`), in `bun run` (entry is `src/index.ts`), and in the `bun build --compile` single-file case (entry resolves to the embedded `/$bunfs/...` path).
- **Option B**: Detect `dist/cli.js` adjacent to `import.meta.dir` at runtime; if present, spawn it; otherwise fall back to source.

Go with Option A — fewer moving parts.

#### 2. Optional FUSE subpackage manifests

**Files**:
- `packages/fuse-helper-linux-x64/package.json:11-14`
- `packages/fuse-helper-linux-arm64/package.json:11-14`

**Changes**: Remove the `"libc"` field entirely from both manifests. Binaries are already musl-static (per `CLAUDE.md` "stripped static musl binaries") so `os`+`cpu` alone is the correct constraint and matches the convention used by esbuild/swc/rollup binary sub-packages.

#### 3. CLI optionalDependencies pin

**File**: `packages/cli/package.json:38-39`
**Changes**: Relax exact pins to caret ranges to match the rest of the file:
```diff
- "@desplega.ai/agent-fs-fuse-linux-x64": "0.6.1",
- "@desplega.ai/agent-fs-fuse-linux-arm64": "0.6.1"
+ "@desplega.ai/agent-fs-fuse-linux-x64": "^0.7.0",
+ "@desplega.ai/agent-fs-fuse-linux-arm64": "^0.7.0"
```
`scripts/sync-versions.ts` already rewrites these pins on every release; the script will need a one-line tweak to emit `^` instead of exact. Update `scripts/sync-versions.ts` so it preserves the caret.

#### 4. Regression test for `daemon start` respawn

**File**: `packages/cli/src/__tests__/daemon-respawn.test.ts` (new)
**Changes**: Synthesize the npm-install layout in a tmp dir (`tmp/node_modules/@desplega.ai/agent-fs/dist/cli.js` containing the built bundle), spawn `bun tmp/.../cli.js daemon start`, then probe for the daemon socket within 5s. Assert the daemon log does NOT contain `Module not found`.

### Success Criteria:

#### Automated Verification:
- [x] Typecheck passes: `bun run typecheck`
- [x] CLI bundle builds: `bun run build`
- [x] Daemon respawn test passes: `bun test packages/cli/src/__tests__/daemon-respawn.test.ts`
- [x] Sync-versions emits caret pins: `bun run scripts/sync-versions.ts 0.7.0 --dry-run | grep '\^0\.7\.0'` (verified via tmp-worktree run — dry-run summary lists files, not content; actual write on a tmp copy produces `"^0.7.0"` pins)

#### Automated QA:
- [ ] Agent runs a Docker container (`oven/bun:1-slim` or `ubuntu:25.10`), does `npm install -g @desplega.ai/agent-fs@<next-version>` after a local `bun publish --dry-run` proves the tarball shape, verifies `/usr/lib/node_modules/@desplega.ai/agent-fs-fuse-linux-x64/bin/agent-fs-fuse` exists, then runs `agent-fs daemon start` and reads the daemon log to confirm no `Module not found` error.

#### Manual Verification:
- [ ] Taras eyeballs `packages/server/src/daemon.ts` diff and confirms the respawn semantics match his intent for both dev + compiled paths.

**Implementation Note**: After this phase, pause for manual confirmation. The fix needs to be on disk (committed) but does not need to be published yet — Phase 7 handles the actual `bun publish`.

---

## Phase 2: CLI plumbing — `mount --remote` flag + helper arg passing

### Overview

Wire the CLI so `agent-fs mount <path> --remote` (and the auto-detect-from-config path) constructs the right argv + env for the FUSE helper child process. The helper itself doesn't need to know about HTTP yet (Phase 3 adds that) — this phase ships argument plumbing only, with the helper still failing fast if `--api-url` is passed (so the contract is tested before the implementation lands).

### Changes Required:

#### 1. `agent-fs mount` command — new flags

**File**: `packages/cli/src/commands/mount.ts` (find existing impl; rename if needed)
**Changes**: Add Commander flags:
- `--remote` — boolean. If set without `--api-url`/`--api-key`, derive from `~/.agent-fs/config.json` (`apiUrl`, `apiKey`) or env vars (`AGENT_FS_API_URL`, `AGENT_FS_API_KEY`). Error clearly if neither source has both fields.
- `--api-url <url>` — override remote URL.
- `--api-key <key>` — override API key (deprecated — emit warning, prefer env).

When `--remote` is active:
- Skip the local-daemon socket check entirely.
- Pass `--api-url <url>` as a helper argv flag.
- Pass `AGENT_FS_API_KEY=<key>` as helper child-process env (never on argv).
- Do NOT pass `--socket` (the helper will detect from absence and choose HTTP transport).

#### 2. Helper-arg-builder pure function

**File**: `packages/cli/src/lib/fuse-args.ts` (new)
**Changes**: Extract argv + env construction into a pure function `buildHelperSpawnArgs({ mode, mountpoint, socket?, apiUrl?, apiKey?, allowOther, foreground })` returning `{ argv: string[], env: Record<string, string> }`. Makes unit testing trivial.

#### 3. Config-resolution helper

**File**: `packages/cli/src/lib/remote-config.ts` (new)
**Changes**: Function `resolveRemoteCreds(flags, configPath, env)` that merges CLI flags, env vars, and `~/.agent-fs/config.json` in that precedence and returns `{ apiUrl, apiKey } | null`. Unit-test all three precedence cases.

#### 4. Unit tests

**File**: `packages/cli/src/lib/__tests__/fuse-args.test.ts` (new)
**File**: `packages/cli/src/lib/__tests__/remote-config.test.ts` (new)
**Changes**: Test cases —
- `--remote` with config-only creds → builds argv with `--api-url`, env with `AGENT_FS_API_KEY`.
- `--remote` with env creds → same shape.
- `--remote` with no creds → throws clear error.
- `--remote` + `--socket` → throws (mutually exclusive).
- No `--remote` (default) → builds argv with `--socket`, no `--api-*` keys.

### Success Criteria:

#### Automated Verification:
- [x] Typecheck passes: `bun run typecheck`
- [x] Unit tests pass: `bun test packages/cli/src/lib/__tests__/`
- [x] Build still works: `bun run build`

#### Automated QA:
- [ ] Agent runs `agent-fs mount /tmp/m --remote --api-url https://example.invalid --api-key dummy` against a local CLI build and verifies the spawned helper command line ( via a strace-style or by intercepting via a stubbed helper binary) carries `--api-url https://example.invalid` and `AGENT_FS_API_KEY=dummy` in env but NOT in argv.
- [ ] Agent runs the same without flags and confirms `AGENT_FS_API_KEY` is NOT in the child env.

#### Manual Verification:
- [ ] Taras reviews the `--remote` flag UX (help text, error messages, deprecation warnings) for clarity.

**Implementation Note**: After this phase, the CLI knows how to ask the helper for remote mode, but the helper will fail-fast with "unknown flag `--api-url`". That's intentional — Phase 3 lands the helper-side support.

---

## Phase 3: Rust HttpIpcClient — read-only ops + new CLI args

### Overview

Land the Rust-side support for HTTP transport with read-only ops only. After this phase, `agent-fs mount /tmp/m --remote` against a fly drive will successfully `ls`, `stat`, `cat` files, and `readdir` directories. Writes still fail with EROFS (intentional — Phase 4 enables them). Concrete deliverable: a new `HttpIpcClient` struct in `packages/fuse-helper/src/ipc.rs` implementing `IpcTrait` for 6 ops, plus updated `main.rs` CLI args and a transport-selection branch.

### Changes Required:

#### 1. Rust deps

**File**: `packages/fuse-helper/Cargo.toml`
**Changes**: Add to `[dependencies]`:
- `reqwest = { version = "0.12", default-features = false, features = ["rustls-tls", "json", "stream", "blocking"] }` — pick `rustls-tls` for static-musl compatibility, blocking client to keep parity with the existing sync helper code. (If async fits better given tokio is already in-tree, drop `blocking` and use async client.)
- `bytes = "1"` — for streaming responses.
- `tokio = { version = "1", features = ["rt-multi-thread", "macros", "io-util"] }` (already present — confirm features include `rt-multi-thread`).

Verify cross-compilation: `cross build --release --target x86_64-unknown-linux-musl` must still succeed under the new deps.

#### 2. New CLI args

**File**: `packages/fuse-helper/src/main.rs:43-61`
**Changes**: Add to `Args`:
```rust
#[arg(long, env = "AGENT_FS_API_URL")]
api_url: Option<String>,

#[arg(long, env = "AGENT_FS_API_KEY", hide_env_values = true)]
api_key: Option<String>,
```
Branch in `main`:
- If `args.api_url.is_some() && args.api_key.is_some()` → construct `HttpIpcClient::new(url, key)`.
- Else if `args.socket.is_some()` (default falls back to `~/.agent-fs/agent-fs.sock`) → construct `UnixIpcClient::new(socket)`.
- Pass either as `Arc<dyn IpcTrait>` (or via `Box<dyn>`) into `FuserAdapter::new`.

Make `IpcTrait` object-safe if it isn't already (it should be — methods are `Pin<Box<dyn Future>>` which is object-safe).

#### 3. `HttpIpcClient` impl — read-only ops

**File**: `packages/fuse-helper/src/ipc.rs` (extend)
**Changes**: New `pub struct HttpIpcClient { base_url: String, api_key: String, http: reqwest::Client, default_org: OnceCell<String> }`. Implement `IpcTrait::send` matching on `Request::*`:

| IPC op | HTTP call |
|---|---|
| `Ping` | `GET {base}/health` → `Response::Pong` |
| `Hello` | `GET {base}/auth/me` (validates creds, caches `defaultOrgId`); `Response::Ok` |
| `ListDrives` | `GET {base}/orgs` then per-org `GET {base}/orgs/:orgId/drives`; build `Vec<DriveInfo>` |
| `DefaultDriveSlug` | `GET {base}/auth/me` → resolve `defaultDriveId` → look up slug in cached drives list |
| `GetAttr` | `POST {base}/orgs/:orgId/ops` body `{"op":"stat","args":{"path":...}}` → `Response::Attr` |
| `ReadDir` | `POST {base}/orgs/:orgId/ops` body `{"op":"ls","args":{"path":...}}` → `Response::DirEntries` |
| `OpenRead` | `GET {base}/orgs/:orgId/drives/:driveId/files/{path}/raw` → stream body to `Vec<u8>` (bounded by 50 MB cap, same as IPC). Pull version + content-hash from response headers (`ETag`, `X-Agent-Fs-Version`). |
| All other variants | `unreachable!()` with a clear panic message for now (Phase 4 fills them in). |

Auth: every request carries `Authorization: Bearer {api_key}`. Use `reqwest`'s default headers on the client.

Retry: lift the existing retry shape from `UnixIpcClient::send_inner` (`ipc.rs:336-355`) into a free helper `with_retry(req, idempotent)` shared by both clients.

#### 4. Mock-style HTTP integration test

**File**: `packages/fuse-helper/tests/http_ipc_roundtrip.rs` (new)
**Changes**: Use `wiremock` (Rust) or hand-roll a `hyper` stub server to assert that:
- `Request::Ping` → `GET /health` is called with `Authorization: Bearer ...`.
- `Request::ListDrives` → `GET /orgs` then `GET /orgs/<id>/drives` are both called.
- `Request::GetAttr { drive: "brain", path: "/x.txt" }` → `POST /orgs/<id>/ops` with the expected JSON body.
- `Request::OpenRead` → `GET .../files/x.txt/raw` returns 100 bytes + ETag → helper returns the bytes plus version.
- Non-2xx responses produce `Response::Error` with the right `http_status`.

#### 5. Update existing tests for the trait-objectification

**File**: `packages/fuse-helper/tests/filesystem_smoke.rs`
**Changes**: If trait-object changes ripple, update construction sites — likely just `Arc::new(MockIpc::default())` to satisfy the new `Arc<dyn IpcTrait>` shape.

### Success Criteria:

#### Automated Verification:
- [x] Rust unit + integration tests pass: `cd packages/fuse-helper && cargo test` (44 tests across 4 binaries — 31 lib + 12 filesystem_smoke + 1 ipc_roundtrip + 10 http_ipc_roundtrip)
- [x] Clippy clean: `cd packages/fuse-helper && cargo clippy --all-targets -- -D warnings`
- [x] Formatting: `cd packages/fuse-helper && cargo fmt --check`
- [ ] Cross-compile still works: `cd packages/fuse-helper && cross build --release --target x86_64-unknown-linux-musl` (size budget: stripped binary ≤ 6 MB; current is ~1.5 MB — flag any >3× growth) — Darwin host: not run; the Docker mount harness already proves a Linux-native build succeeds. Release artifact build size on Darwin host = 2.5 MB (1.7× growth, well under 3×).
- [x] Old Docker mount harness still passes: `packages/fuse-helper/docker/run-mount-test.sh` (required bumping the Docker test image's Rust toolchain to 1.86 since `reqwest`/`icu_*` now pull `rustc 1.86` MSRV — see Dockerfile.test diff)

#### Automated QA:
- [ ] Agent runs `packages/fuse-helper/docker/run-mount-test.sh` in `--remote` mode against a local mock HTTP server (script will need a new `--http` variant) and asserts `ls`, `stat`, `cat` work; `touch` and `rm` fail with EROFS.

#### Manual Verification:
- [ ] Taras runs `agent-fs mount /tmp/m --remote` against the fly drive on a Hetzner VM or sprite (with fuse3 prereqs in place), then `ls /tmp/m`, `cat /tmp/m/current/sprite-mount-test/hello-from-sprite.txt` (or any existing file), confirms output matches what the host CLI returns.

**Implementation Note**: After this phase, pause for manual confirmation. Read-only remote mount works end-to-end — that's enough to validate the design before tackling writes.

---

## Phase 4: Rust HttpIpcClient — write ops + conflict handling

### Overview

Fill in the remaining `HttpIpcClient` ops: writes, creates, deletes, renames, truncate. Wire 409 EDIT_CONFLICT handling to match the existing IPC contract. Concrete deliverable: through-mount `echo "x" > /mnt/file`, `rm /mnt/file`, `mv /mnt/a /mnt/b` all work against a remote agent-fs HTTP API.

### Changes Required:

#### 1. Write ops in `HttpIpcClient`

**File**: `packages/fuse-helper/src/ipc.rs`
**Changes**: Implement the remaining `IpcTrait::send` arms:

| IPC op | HTTP call | Notes |
|---|---|---|
| `OpenWrite { drive, path, base_version, content_hash, bytes }` | `PUT .../files/{path}/raw` with body=`bytes`, headers `If-Match: <base_version>` (or omit if `base_version` is None), `Content-SHA256: <content_hash>` if server supports | On 409 → `Response::Error { http_status: 409, code: Some("EDIT_CONFLICT"), .. }` |
| `CreateFile { drive, path }` | `PUT .../files/{path}/raw` with empty body, header `If-None-Match: *` | On 409 → conflict error |
| `Truncate { drive, path, size }` | RMW: `GET .../files/{path}/raw` → slice to `size` bytes → `PUT` back with `If-Match`. (Match what IPC `handlers.ts:355-374` does.) | Race-prone — note in code comment |
| `Unlink { drive, path }` | `POST .../ops {op:"rm","args":{"path":...}}` | |
| `Rename { drive, from_path, to_drive, to_path }` | If `drive != to_drive` → `Response::Error { http_status: 0, code: Some("EXDEV"), .. }` (helper translates to `EXDEV`). Else → `POST .../ops {op:"mv","args":{"from":...,"to":...}}` | |
| `Mkdir { drive, path }` | Local no-op → `Response::Ok` (match daemon behaviour) | Just log at debug level |
| `Rmdir { drive, path }` | `POST .../ops {op:"ls"}` to check empty (or call dedicated endpoint if one exists). Server `handlers.ts:403-413` does same check; consider exposing a real HTTP rmdir to avoid the double RTT — out of scope here, just match current behaviour. | |
| `RecordConflict { .. }` | Log via `tracing::warn!`, return `Response::Ok` | No HTTP equivalent; matches daemon's `console.warn` |
| `WriteStatus { line }` | Log via `tracing::info!`, return `Response::Ok` | Same |

#### 2. Header parsing helpers

**File**: `packages/fuse-helper/src/ipc.rs` (add internal helpers)
**Changes**: `parse_version_headers(headers: &HeaderMap) -> (u64, String)` extracting `ETag` (version) + `X-Agent-Fs-Content-Hash`. Add a default `X-Agent-Fs-Version` fallback. Verify these header names match `packages/server/src/routes/files.ts:97-195` (if mismatch, treat as a server-side gap and file follow-up).

#### 3. Conflict-flow integration test

**File**: `packages/fuse-helper/tests/http_ipc_roundtrip.rs` (extend)
**Changes**:
- `OpenWrite` happy path → server returns 200 + new version → `Response::OpenWrite { version, content_hash, deduped: false }`.
- `OpenWrite` with mismatched `If-Match` → server returns 409 + JSON `{code:"EDIT_CONFLICT"}` → `Response::Error { http_status: 409, code: Some("EDIT_CONFLICT"), .. }`.
- `CreateFile` for an existing path → 409 → conflict error.
- `Rename` across drives → server NOT called (helper short-circuits to EXDEV).

### Success Criteria:

#### Automated Verification:
- [ ] Rust tests pass: `cd packages/fuse-helper && cargo test`
- [ ] Clippy clean: `cd packages/fuse-helper && cargo clippy --all-targets -- -D warnings`
- [ ] Docker harness with full read+write: `packages/fuse-helper/docker/run-mount-test.sh --http` (or whatever the Phase 3 script becomes) writes, reads back, asserts roundtrip.
- [ ] Existing IPC tests still pass: `cd packages/fuse-helper && cargo test --test ipc_roundtrip --test filesystem_smoke`

#### Automated QA:
- [ ] Agent script in a Docker container: `agent-fs mount /mnt --remote`, then `echo "hello $(date)" > /mnt/current/.../qa-test-$(date +%s).txt`, read it back, `rm` it, `ls` and assert it's gone. Uses the fly instance with a dedicated test API key (if one exists) or a local-daemon's HTTP API.
- [ ] Agent verifies conflict path: open same file from host CLI and through mount, both write at v1, second writer gets EIO (helper translates 409→EIO matching `errno.rs`).

#### Manual Verification:
- [ ] Taras runs an end-to-end edit session through the mount on a real sprite, including a vim-style "save then re-open" cycle, and confirms version history in the dashboard reflects the writes correctly.

**Implementation Note**: After this phase, pause for manual confirmation. Phase 5 wires E2E coverage to the existing harness so this doesn't regress.

---

## Phase 5: E2E coverage for remote mount

### Overview

Extend `scripts/e2e.ts` (or add a sibling script) with a remote-mount path so a regression on either side (daemon HTTP API or Rust helper) breaks the build locally. Concrete deliverable: `bun run scripts/e2e.ts --remote` (or `bun run scripts/e2e-remote-mount.ts`) spins up a daemon, mounts via HTTP, exercises read/write/ls/rm/mv, and tears down — all in a Docker container that has fuse3 + /dev/fuse.

### Changes Required:

#### 1. E2E script extension

**File**: `scripts/e2e-remote-mount.ts` (new — separate file to keep `e2e.ts` focused on the IPC path; or add a `--remote` mode flag to `e2e.ts` — pick whichever has lower diff churn).
**Changes**: Build a Docker image (reuse `scripts/docker/Dockerfile.e2e-fuse` if it works for this purpose) that:
1. Starts a local daemon listening on a random HTTP port.
2. Issues an `agent-fs auth register` against that daemon to mint a test API key.
3. Runs `agent-fs mount /mnt --remote --api-url http://daemon:<port> --api-key <key>` in the container.
4. Walks through ~8 ops: `ls`, `mkdir`, `touch`, `echo > file`, `cat file`, `mv`, `rm`, unmount.
5. Asserts via host CLI that the same daemon sees the same state (so HTTP + helper agree).

#### 2. Reuse `Dockerfile.e2e-fuse` or add a sibling

**File**: `scripts/docker/Dockerfile.e2e-fuse` (existing) — confirm it has fuse3 + /dev/fuse access. If not, add a `Dockerfile.e2e-remote-mount` that ships fuse3 + the locally-built helper binary + the npm tarball.

#### 3. Document the harness in the main README

**File**: `README.md` (or `CLAUDE.md` if it's agent-only)
**Changes**: Add a short paragraph linking to `scripts/e2e-remote-mount.ts` and noting how to run it locally.

### Success Criteria:

#### Automated Verification:
- [ ] New E2E script runs green locally: `bun run scripts/e2e-remote-mount.ts`
- [ ] Old E2E suite still passes: `bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --"`
- [ ] Typecheck on the new script: `bun run typecheck`

#### Automated QA:
- [ ] CI step (if E2E is wired to CI) runs the new harness on every PR touching `packages/fuse-helper/` or `packages/cli/src/commands/mount.ts`. If not in CI, document as a `bun run` step in the release checklist.

#### Manual Verification:
- [ ] Taras runs `bun run scripts/e2e-remote-mount.ts` locally on his Mac (via Docker Desktop / OrbStack) once, confirms it completes < 5 min, captures the output.

**Implementation Note**: After this phase, the feature has CI-friendly regression coverage. Docs come next.

---

## Phase 6: Docs — `docs/mounting/` with general + sprite + e2b + hetzner

### Overview

Scaffold a `docs/mounting/` directory with one general overview and one guide per supported sandbox env (sprite, e2b, hetzner). Concrete deliverable: four new markdown files, all linked from the main `README.md` "Mounting" section, each with a 5-minute happy-path checklist and a known-issues subsection.

### Changes Required:

#### 1. General overview

**File**: `docs/mounting/README.md` (new)
**Sections**:
- Architecture diagram (ASCII) showing two topologies: (a) helper + local daemon + local S3, (b) helper + remote agent-fs HTTP API (no local daemon).
- Prerequisites checklist common to all envs: Linux x86_64 or arm64, fuse3 package, `/dev/fuse` access, `user_allow_other` in `/etc/fuse.conf` (only if `--allow-other`), `/etc/mtab` symlink.
- Mount command: `agent-fs mount <mountpoint> [--remote]`.
- Auth: env vars `AGENT_FS_API_URL`, `AGENT_FS_API_KEY`, or config file `~/.agent-fs/config.json`.
- Troubleshooting: top-N errors observed during sprite test (mountpoint not a directory, fusermount3 not found, /dev/fuse permission denied, etc.) with one-line fixes.
- Cross-reference: per-env docs.

#### 2. Sprite-specific

**File**: `docs/mounting/sprite.md` (new)
**Sections**: Document the exact four prereqs from the 2026-05-18 test:
1. `sudo apt-get install -y fuse3`
2. `sudo chmod 666 /dev/fuse`
3. `sudo ln -sf /proc/mounts /etc/mtab`
4. `echo user_allow_other | sudo tee -a /etc/fuse.conf`

Then `npm install -g @desplega.ai/agent-fs` + `agent-fs mount ~/mnt --remote`. Note that sprite envs may need these every time a fresh sprite is created — link to or include a one-liner script that idempotently applies all four.

#### 3. E2B-specific

**File**: `docs/mounting/e2b.md` (new)
**Sections**: Research what E2B's sandbox base image provides — fuse3 is likely not preinstalled. Document an "E2B-friendly Dockerfile snippet" that adds fuse3 and the right `/dev/fuse` permissions if E2B's runtime exposes the device. If E2B sandboxes don't expose `/dev/fuse` at all, document that and offer a fallback (e.g. agent-fs HTTP CLI in lieu of mount).

(If research turns up that E2B sandboxes can't mount FUSE today, this file becomes a "Status: not supported, why, and what to do instead" doc.)

#### 4. Hetzner-specific

**File**: `docs/mounting/hetzner.md` (new)
**Sections**: Minimal happy path — Hetzner Cloud Ubuntu/Debian VMs give root, /dev/fuse, sudo. Just:
1. `apt install fuse3`
2. `npm install -g @desplega.ai/agent-fs`
3. Set `AGENT_FS_API_URL` + `AGENT_FS_API_KEY` env or config.
4. `agent-fs mount /mnt --remote`

Add a systemd unit example for auto-mount on boot.

#### 5. README link

**File**: `README.md`
**Changes**: Add a "Mounting" section near the install instructions linking to `docs/mounting/README.md`.

### Success Criteria:

#### Automated Verification:
- [ ] Lint markdown: `npx markdownlint-cli2 'docs/mounting/**/*.md'` (or whatever linter the repo uses)
- [ ] No dead links in mounting docs: `npx markdown-link-check docs/mounting/**/*.md` (or equivalent)
- [ ] OpenAPI/site freshness check: re-run any docs-site build (`live/` if mounting docs feed into the landing)

#### Automated QA:
- [ ] Agent follows the sprite doc step-by-step against the actual code-health-scan sprite (or a fresh sprite) and confirms each step works as documented. Captures the session log.
- [ ] Agent follows the hetzner doc on a fresh Hetzner Cloud VM (via the `hcloud` skill) and confirms the full mount flow.

#### Manual Verification:
- [ ] Taras reads `docs/mounting/README.md` cold and confirms the architecture diagram + troubleshooting section match his mental model.

**Implementation Note**: After this phase, the feature has user-facing docs that match reality on at least two of three target envs. E2B may stay as "researched & documented, not validated" if the runtime doesn't allow it.

---

## Phase 7: Release — version, sync, SKILL.md, plugin, release.sh

### Overview

Tag and ship `v0.7.0` with all of the above. This is a feature release (new `mount --remote` mode), not a patch. Concrete deliverable: `v0.7.0` published on npm with the FUSE subpackages auto-installing correctly, Docker image pushed, fly app deployed, and the skill / plugin / package versions all in lockstep.

### Changes Required:

#### 1. Version sync

**Files** (all rewritten by `scripts/sync-versions.ts 0.7.0`):
- `package.json`
- `packages/{cli,core,server,mcp}/package.json`
- `packages/fuse-helper-linux-{x64,arm64}/package.json`
- `packages/fuse-helper/Cargo.toml`
- `.claude-plugin/plugin.json`

#### 2. Skill update

**File**: `skills/agent-fs/SKILL.md`
**Changes**: Add `agent-fs mount [--remote]` to the command table. Add a "Remote mode" subsection in the workflow examples. Update the trigger description to include "mount", "fuse", "remote mount", "sandbox mount".

#### 3. Plugin manifest version bump

**File**: `.claude-plugin/plugin.json`
**Changes**: Already done by sync-versions; verify the file in the diff.

#### 4. CHANGELOG / release notes

**File**: `CHANGELOG.md` (if it exists) or `thoughts/taras/notes/2026-05-18-v0.7.0-release-notes.md` (new)
**Changes**: One paragraph per phase summarizing the change. Note breaking-change status (none — additive feature + bug fixes).

#### 5. OpenAPI spec version sync

**File**: `docs/openapi.json`
**Changes**: Already done by sync-versions / pre-push hook.

#### 6. Tag + push

**Command sequence** (after manual verification on a sample install):
1. `bun install` (refresh lockfile).
2. `git add -A && git commit -m "v0.7.0: FUSE remote-mount + daemon-start + optional-dep fixes"`
3. `git push origin main`
4. `./scripts/release.sh` (tags v0.7.0, pushes tag, GH Actions handles npm + Docker)
5. `bun run deploy:fly` (or rely on the auto-deploy workflow that fired on the push to main).

### Success Criteria:

#### Automated Verification:
- [ ] Sync-versions clean: `bun run scripts/sync-versions.ts 0.7.0` exits 0 and rewrites the expected files (verified via `git diff`).
- [ ] Typecheck + tests + E2E all green pre-release: `bun run typecheck && bun run test && bun run scripts/e2e.ts ... && bun run scripts/e2e-remote-mount.ts`
- [ ] Rust tests + clippy + fmt: `cd packages/fuse-helper && cargo test && cargo clippy --all-targets -- -D warnings && cargo fmt --check`
- [ ] After tag push: GH Actions `Release & Publish` workflow finishes green.
- [ ] After tag push: GH Actions `Publish Docker Image` finishes green.
- [ ] Post-release `npm view @desplega.ai/agent-fs@0.7.0` returns the new version with `optionalDependencies` showing `^0.7.0` pins.
- [ ] Post-release `npm view @desplega.ai/agent-fs-fuse-linux-x64@0.7.0 libc` returns `undefined` (field removed).

#### Automated QA:
- [ ] Agent installs `@desplega.ai/agent-fs@0.7.0` in a fresh `ubuntu:25.10` Docker container and confirms the FUSE subpackage was installed alongside.
- [ ] Agent runs `agent-fs mount /mnt --remote` against the freshly-deployed fly drive and exercises the same QA scenarios from Phases 3-4.

#### Manual Verification:
- [ ] Taras checks the dashboard for files created during the QA run, confirms version history is sensible, confirms the deployed fly app health endpoint reports `{"ok":true,"version":"0.7.0"}`.

**Implementation Note**: This is the last phase. After verification, the plan is closed.

### QA Spec (optional):

End-to-end QA evidence (especially Phases 3, 4, 6 cross-env validation) is worth capturing in a dedicated doc.

**QA Doc**: `thoughts/taras/qa/2026-05-18-fuse-remote-mount.md` (generate via `desplega:qa` after Phase 7 completes; scenarios live in the QA doc, not the plan).

---

## Manual E2E

After all phases complete, verify end-to-end from a fresh sprite (and ideally also a Hetzner VM and an E2B sandbox if research showed it's possible). Treat this as the final acceptance test.

### Fresh sprite E2E

```bash
# Host
sprite create agent-fs-mount-e2e
sprite use agent-fs-mount-e2e

# Inside the sprite
sudo apt-get update -qq && sudo apt-get install -y fuse3
sudo chmod 666 /dev/fuse
sudo ln -sf /proc/mounts /etc/mtab
echo user_allow_other | sudo tee -a /etc/fuse.conf

npm install -g @desplega.ai/agent-fs@0.7.0
agent-fs --version  # → 0.7.0

# Auth — copy from host config or paste an API key
mkdir -p ~/.agent-fs
cat > ~/.agent-fs/config.json <<EOF
{ "apiUrl": "https://agent-fs-taras.fly.dev", "apiKey": "<API_KEY>" }
EOF

agent-fs auth whoami  # confirms remote auth works

# Mount
mkdir -p ~/mnt
agent-fs mount ~/mnt --remote

# Verify
ls ~/mnt
ls ~/mnt/current
cat ~/mnt/current/<some-existing-file>
echo "fuse e2e $(date)" > ~/mnt/current/fuse-e2e-test.txt
cat ~/mnt/current/fuse-e2e-test.txt
rm ~/mnt/current/fuse-e2e-test.txt

# Cleanup
fusermount3 -u ~/mnt
```

### Hetzner VM E2E

```bash
# Host
hcloud server create --name agent-fs-mount-e2e --image ubuntu-24.04 --type cx22 --ssh-key <key>
SERVER_IP=$(hcloud server ip agent-fs-mount-e2e)

# Over SSH
ssh root@$SERVER_IP <<'EOF'
apt-get update -qq && apt-get install -y fuse3 curl
curl -fsSL https://bun.sh/install | bash
~/.bun/bin/bun install -g @desplega.ai/agent-fs@0.7.0

mkdir -p ~/.agent-fs
cat > ~/.agent-fs/config.json <<JSON
{ "apiUrl": "https://agent-fs-taras.fly.dev", "apiKey": "$AGENT_FS_API_KEY" }
JSON

mkdir -p /mnt/agent-fs
agent-fs mount /mnt/agent-fs --remote

ls /mnt/agent-fs
echo "hetzner e2e $(date)" > /mnt/agent-fs/current/hetzner-e2e.txt
cat /mnt/agent-fs/current/hetzner-e2e.txt
rm /mnt/agent-fs/current/hetzner-e2e.txt
fusermount3 -u /mnt/agent-fs
EOF

# Cleanup
hcloud server delete agent-fs-mount-e2e
```

### Dashboard check

After each E2E run, open the agent-fs dashboard and confirm:
- Files created during the run appear with the right size + author.
- Files deleted during the run no longer appear.
- Version history reflects writes correctly (v1 only, no spurious versions).

### Acceptance criteria

- [ ] Sprite E2E completes with no manual intervention beyond the 4 prereq commands.
- [ ] Hetzner E2E completes with zero prereqs beyond `apt install fuse3`.
- [ ] E2B E2E either completes or is documented as "not supported, here's why" in `docs/mounting/e2b.md`.
- [ ] Dashboard reflects every file op from every E2E run.

---

## Appendix

- **Follow-up plans**:
  - Streaming reads/writes for files >50 MB (separate plan; touches HTTP body cap, IPC frame cap, and the FUSE `read`/`write` callbacks).
  - First-class HTTP rmdir endpoint (currently fakes via empty-`ls` check — adds RTT).
  - Per-user / per-org write quotas surfaced through mount-time errors.
  - macOS FUSE (`macfuse`) support — separate Rust-helper variant, separate sub-package.
- **Derail notes**:
  - The `Hello`, `CreateFile`, `Truncate`, `WriteStatus` IPC ops are declared in `ipc.rs:71-135` but never sent today. Consider deleting the dead variants or wiring them. Not in scope.
  - Helper has a 15 s `readdir` cache (`fs.rs:92`). HTTP mode might want a shorter cache to react faster to dashboard-side edits — leave at 15 s for v1, revisit if users complain.
  - `default_drive_slug` returning slug-not-id is an IPC<>HTTP impedance mismatch. HTTP impl pays an extra round-trip to translate. Consider returning the slug from `/auth/me` server-side. Out of scope here.
  - Long-lived API keys carry full account access. A scoped, read-only key type would be ideal for mount-in-CI scenarios. Out of scope.
- **References**:
  - Research lives inline in `Current State Analysis` (filled by sub-agents on 2026-05-18). Sub-agent transcripts cleaned from the agent session output dir.
  - 2026-05-18 v0.6.1 fix (msgpackr externalize): commit e9b246a + PR #14.
  - 2026-05-18 sprite mount test session: this conversation.
  - Today's release: `v0.6.1` already shipped to npm + Docker + fly before this plan starts.

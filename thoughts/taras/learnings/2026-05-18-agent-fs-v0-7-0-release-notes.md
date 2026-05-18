---
date: 2026-05-18
version: 0.7.0
status: prep
plan: thoughts/taras/plans/2026-05-18-fuse-remote-mount-and-fixes.md
type: release-notes
---

# agent-fs v0.7.0 — FUSE Remote-Mount Mode + Install Fixes

**Breaking changes**: none. This release is purely additive (new `mount --remote` mode) plus two install-time bug fixes that lift papercuts on fresh Linux sandboxes.

> Filed under `learnings/` because the repo has no top-level `CHANGELOG.md` and the plan-directory hook blocks `thoughts/taras/notes/`. The plan originally specified `thoughts/taras/notes/2026-05-18-v0.7.0-release-notes.md`; if a CHANGELOG.md is later adopted, prepend this content there.

## Highlights

- **`agent-fs mount --remote`** — mount agent-fs drives in any Linux sandbox that can reach a hosted agent-fs HTTP API, without running a local daemon. Designed for sprite, E2B, Hetzner VMs, GitHub Actions runners, and similar environments.
- **`daemon start` works on npm-installed CLI** — previously `daemon start` on a globally-installed `@desplega.ai/agent-fs` would fail with `Module not found: .../dist/index.ts` because the respawn heuristic only recognized Bun's single-file executable layout.
- **FUSE subpackage installs cleanly** — `npm install -g @desplega.ai/agent-fs` on Linux x64/arm64 now auto-installs the matching FUSE helper without manual intervention.

## What's new

### Phase 1 — Install-time bug fixes

Two papercuts surfaced during the 2026-05-18 sprite test:

- `packages/server/src/daemon.ts` — replaced the `isCompiled` heuristic (which only recognized `/$bunfs/...` paths) with `process.argv[1]`-based entry resolution. Works for npm-installed (`dist/cli.js`), dev (`bun run src/index.ts`), and the future `bun build --compile` single-file case.
- `packages/fuse-helper-linux-{x64,arm64}/package.json` — removed the `"libc": ["glibc", "musl"]` field. npm's libc filter only accepts strings, not arrays, and silently skipped the optional dep on several npm/Node versions. The binaries are already musl-static, so `os` + `cpu` constraints are sufficient (matches the esbuild/swc/rollup convention).
- `packages/cli/package.json` — relaxed `optionalDependencies` pins for the FUSE subpackages from exact (`"0.6.1"`) to caret (`"^0.7.0"`) to match the rest of the file and avoid known npm optional-resolution flakiness on first global install. `scripts/sync-versions.ts` now emits caret pins for these going forward.
- Regression coverage: `packages/cli/src/__tests__/daemon-respawn.test.ts` synthesizes the npm-install layout in a tmp dir and asserts the respawn path resolves correctly.

### Phase 2 — CLI plumbing for remote mount

New flags on `agent-fs mount`:
- `--remote` — opt into remote mode. Falls back to env vars (`AGENT_FS_API_URL`, `AGENT_FS_API_KEY`) or `~/.agent-fs/config.json` (`apiUrl`, `apiKey`).
- `--api-url <url>` — override the remote endpoint.
- `--api-key <key>` — override the API key (deprecated; prefer env so the key never lands in `ps` output).

The CLI forwards `AGENT_FS_API_KEY` to the helper child process via env (never argv), skips the local-daemon socket check when remote, and validates that `--remote` and `--socket` are mutually exclusive.

Pure helpers `buildHelperSpawnArgs` (`packages/cli/src/lib/fuse-args.ts`) and `resolveRemoteCreds` (`packages/cli/src/lib/remote-config.ts`) keep arg/env construction testable.

### Phase 3 — Rust `HttpIpcClient` (read-only ops)

New `HttpIpcClient` struct in `packages/fuse-helper/src/ipc.rs` implements `IpcTrait` for read-only ops by talking to the agent-fs HTTP API:

| IPC op | HTTP call |
|---|---|
| `Ping` | `GET /health` |
| `Hello` | `GET /auth/me` (validates creds, caches default org/drive) |
| `ListDrives` | `GET /orgs` + per-org `GET /orgs/:orgId/drives` |
| `DefaultDriveSlug` | `GET /auth/me` → resolve `defaultDriveId` → slug from cached drives |
| `GetAttr` | `POST /orgs/:orgId/ops {op:"stat"}` |
| `ReadDir` | `POST /orgs/:orgId/ops {op:"ls"}` |
| `OpenRead` | `GET /orgs/:orgId/drives/:driveId/files/{path}/raw` (binary streaming) |

Authentication is `Authorization: Bearer <api_key>` on every request. The retry policy (`is_idempotent`-aware exponential backoff) is shared with `UnixIpcClient` via a new `with_retry` helper.

New CLI args on the helper: `--api-url` (env `AGENT_FS_API_URL`) and `--api-key` (env `AGENT_FS_API_KEY`, hidden in logs). Transport is auto-selected: if both api_url and api_key are present, HTTP; else fall back to Unix socket.

Coverage: 10 new wiremock-based integration tests in `packages/fuse-helper/tests/http_ipc_roundtrip.rs`.

### Phase 4 — Rust `HttpIpcClient` (write ops + conflict handling)

Filled in the remaining `IpcTrait::send` arms:

| IPC op | HTTP call |
|---|---|
| `OpenWrite` | `PUT .../files/{path}/raw` with `If-Match: <base_version>` |
| `CreateFile` | `PUT .../files/{path}/raw` with `If-None-Match: *` |
| `Truncate` | RMW: `GET` → slice → `PUT` with `If-Match` |
| `Unlink` | `POST /ops {op:"rm"}` |
| `Rename` | Short-circuit to EXDEV if cross-drive; else `POST /ops {op:"mv"}` |
| `Mkdir` / `Rmdir` | Local no-op (matches daemon behaviour) |
| `RecordConflict` / `WriteStatus` | Log only (matches daemon behaviour) |

409 EDIT_CONFLICT responses translate to `Response::Error` with the right `http_status` + `code` so FUSE callbacks raise the matching errno. Coverage in `http_ipc_roundtrip.rs` grew to 20 tests including happy paths, mismatched `If-Match`, double-create, and cross-drive rename.

### Phase 5 — Remote-mount E2E test

New `scripts/e2e-remote-mount.ts` spins up MinIO + a host daemon on `0.0.0.0:<random>`, builds a Docker FUSE container with `--add-host host.docker.internal:host-gateway`, and runs through 9 ops (mount, ls, mkdir, host-write, echo-roundtrip, mv, rm, umount). Runs locally with Docker; not yet in CI.

A side-effect of this phase: `scripts/docker/Dockerfile.e2e-fuse` had its Rust toolchain bumped 1.85 → 1.86 to satisfy the new `reqwest` / `icu_*` MSRV.

### Phase 6 — Mounting docs

Scaffolded `docs/mounting/` with four new markdown files:

- `docs/mounting/README.md` — architecture overview (local vs. remote topology), common Linux prereqs, auth, troubleshooting.
- `docs/mounting/sprite.md` — exact 4 prereq commands captured from the 2026-05-18 sprite test, idempotent one-liner script.
- `docs/mounting/e2b.md` — research notes on whether E2B sandboxes can mount FUSE; documents the fallback (HTTP CLI) where mount isn't possible.
- `docs/mounting/hetzner.md` — minimal Ubuntu/Debian VM happy path + systemd unit example for auto-mount on boot.

Linked from the main `README.md` "Mounting" section.

### Phase 7 — Release

- Version bumped to `0.7.0` across all 9 lockstep-managed files (`package.json` × 6, `Cargo.toml`, `plugin.json`, `openapi.json`).
- Skill updated (`skills/agent-fs/SKILL.md`): new "Remote mode" command-table row, new workflow example, expanded trigger description with mount/fuse/remote keywords.
- npm publish + Docker push + fly deploy are handled by the existing release workflow on tag push.

## Compatibility

- **Local mount** (the only mode before v0.7.0) is unchanged. Existing scripts/configs that ran `agent-fs mount <path>` continue to work identically.
- **Local daemon API surface** is unchanged. No HTTP routes were added or removed for the remote-mount feature — the helper just learned to call existing endpoints.
- **macOS FUSE** still not supported. `agent-fs mount` on Darwin will continue to error out.
- **Cross-drive `rename`** still returns EXDEV (matches v0.6.x behaviour); no regression.
- **Streaming for files >50 MB** is still capped at the existing HTTP/IPC body limits. A separate plan will lift this.

## Upgrade

```bash
npm install -g @desplega.ai/agent-fs@0.7.0
agent-fs --version  # → 0.7.0
```

No config migration needed.

## Known limitations

- `mount --remote` reads the full file body inline for `OpenRead` (no streaming). 50 MB cap applies. Large files: download via `agent-fs cat` or `signed-url` instead.
- The helper pays an extra round-trip for `DefaultDriveSlug` (HTTP returns drive id, IPC returns slug). Server-side `/auth/me` could return the slug directly — tracked as a follow-up.
- E2B FUSE support is unverified at release time; see `docs/mounting/e2b.md` for status.

## Acknowledgements

Sprite test that uncovered both install bugs and motivated the remote-mount feature: 2026-05-18 session against `agent-fs-taras.fly.dev`.

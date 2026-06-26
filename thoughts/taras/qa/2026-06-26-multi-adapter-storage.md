---
date: 2026-06-26T16:25:00-00:00
author: Claude (for Taras)
topic: "Multi-adapter storage (files-sdk local-FS + S3) — PR refactor/files-sdk"
tags: [qa, storage-adapter, files-sdk, local-fs, e2e, minio, autopilot]
status: pass
source_plan: thoughts/taras/plans/2026-06-25-multi-adapter-storage/root.md
related_pr: refactor/files-sdk (vs main)
environment: local
last_updated: 2026-06-26
last_updated_by: Claude (for Taras)
---

# Multi-Adapter Storage — QA Report

## Context

QA of the `refactor/files-sdk` branch (PR vs `main`), which introduces a thin internal
`StorageAdapter` interface so agent-fs storage supports multiple backends:

- `AgentS3Client implements StorageAdapter` (S3/MinIO behavior unchanged)
- A new `files-sdk`-backed **local-filesystem** adapter with app-level (content-addressed
  blob) versioning, so `revert` / historical `diff` work on local without object versioning
- Typed `UnsupportedOperation` error + per-adapter `capabilities` gating, surfaced cleanly
  core → CLI → MCP
- Tagged-union `AgentFSConfig.s3` (keyed by `provider`) + startup adapter selection +
  local-FS onboarding
- Cross-backend E2E (S3 **and** local) + release checklist (v0.10.0)

Executed in **Autopilot** mode (full auto), per `/desplega:qa`. Backend: **local MinIO via
Docker** (Docker 29.2.0, UP). Runtime: **Bun 1.3.11** on Darwin.

This QA reproduces the plan's claimed verification numbers against a real backend rather than
trusting the recorded checkmarks.

## Scope

### In Scope
- Whole-repo typecheck
- Full unit/integration test suite (`bun test`)
- Cross-backend CLI + MCP E2E against a real MinIO container and a real local-FS drive
  (`scripts/e2e.ts`), incl. revert/diff on each backend, capability-gating of an unsupported
  op, and the signed-url presigned-vs-app-fallback matrix
- Release-version consistency (lockstep bump across all manifests)

### Out of Scope
- FUSE mount tests — skipped on Darwin (require `AGENT_FS_USE_DOCKER_FUSE=1`; 10 cases). Not a
  regression of this PR; FUSE is exercised separately via the Docker harness.
- Live S3 (AWS) / consumer providers (Dropbox/GDrive) — explicitly deferred to a follow-up plan.
- Local blob GC / cross-store atomicity — consciously deferred (see Issues Found, non-blocking).

## Test Cases

### TC-1: Whole-repo typecheck
**Steps:** `bun run typecheck` (`tsc --build`)
**Expected:** Exit 0, no type errors (interface retype lands across core → server → CLI → MCP).
**Actual:** Exit 0, clean.
**Status:** pass

### TC-2: Full unit/integration suite
**Steps:** `bun test` (manual/integration tests auto-skip without env)
**Expected:** Matches plan's recorded 898 pass / 114 skip / 0 fail.
**Actual:** **898 pass / 114 skip / 0 fail**, 2956 expect() calls, 1012 tests across 103 files (13.37s). Exact match.
**Status:** pass

### TC-3: Cross-backend E2E against MinIO + local-FS
**Steps:** `bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --"` (spins up an isolated
`agent-fs-minio` container + a daemon on a random port; runs CLI + MCP end-to-end).
**Expected:** Matches plan's recorded 127/127 (10 FUSE skipped on Darwin), exit 0.
**Actual:** **127/127 passed (10 skipped), exit 0.** 0 failures. Section breakdown:
- `core ops [minio]` — full S3/MinIO matrix
- `core ops [local]` — full local-FS matrix (write/cat/append/edit/stat/cp/mv/glob/recent/log/diff/revert/rm)
- `capability gating: unsupported op (local, versioning forced off)`
- `signed-url backend matrix (presigned vs app fallback)`
- `FUSE mount tests` — 10 skipped (Darwin)
**Status:** pass

### TC-4: Local-FS full-tier versioning (revert + diff)
**Steps:** Within the `[local]` E2E section: write v1 → edit v2 → `log` → `diff v1 v2` → `revert`.
**Expected:** `diff` returns real content changes (not a degraded stored summary); `revert`
restores prior content as a **new** version — i.e. local gets the full S3-equivalent tier via
content-addressed blobs.
**Actual:** `[local] diff (v1 vs v2) returns real content changes` ✓; `[local] revert restores
prior content as a new version` ✓.
**Status:** pass

### TC-5: `_afs-blobs` reserved prefix never leaks into listings
**Steps:** `[local] ls shows dirs and never lists _afs-blobs`.
**Expected:** The content-addressed blob store (`_afs-blobs/sha256/<hash>`) is invisible to `ls`.
**Actual:** ✓ passed.
**Status:** pass

### TC-6: Capability gating — unsupported op surfaces cleanly (CLI + API)
**Steps:** On a local drive with versioning capability forced off: seed a file, attempt `revert`
via CLI and via API.
**Expected:** Write still works (no versioning needed); `revert` exits non-zero with a clean
message + suggestion (no stack trace); API returns HTTP 422 `UNSUPPORTED_OPERATION`.
**Actual:**
- `[capped] seed file (write works without versioning capability)` ✓
- `[capped] revert exits non-zero with a clean message (no stack trace)` ✓ — emits
  `Operation 'revert' is not supported by the current storage backend` + suggestion
- `[capped] revert via API → HTTP 422 UNSUPPORTED_OPERATION` ✓
**Status:** pass

### TC-7: signed-url backend matrix
**Steps:** Request a signed URL on MinIO and on local.
**Expected:** MinIO returns a real presigned URL; local falls back to a daemon app `/raw` URL
(reports `presignedUrls:false`) rather than hard-failing.
**Actual:** `[minio] signed-url returns a real presigned URL` ✓; `[local] signed-url falls back
to an app URL (not an error)` ✓.
**Status:** pass

### TC-8: S3/MinIO behavior unchanged (no regression)
**Steps:** Full `core ops [minio]` E2E section + S3-backed unit tests.
**Expected:** The S3 path stays green; `AgentS3Client` only gains an `implements` declaration.
**Actual:** All `[minio]` cases pass; no S3 regressions in unit suite.
**Status:** pass

### TC-9: Release-version lockstep
**Steps:** Compare versions across all manifests vs last published (`npm view`).
**Expected:** All packages bumped together; no straggler at 0.9.0.
**Actual:** Last published/tagged = **v0.9.0**. PR bumps to **0.10.0** in lockstep across:
8× `package.json`, `packages/fuse-helper/Cargo.toml`, `.claude-plugin/plugin.json`,
`docs/openapi.json`. `grep` for `0.9.0` stragglers → none.
**Status:** pass

## Edge Cases & Exploratory Testing
- Every `Error:` line in the E2E log was verified to be an **intentional negative-path
  assertion** (each immediately followed by ✓): `signed-url nonexistent file fails`, `sql via
  API — syntax error is a 400`, `member remove last admin fails`, plus the capability-gating
  revert errors. No unexpected errors.
- MinIO container (`agent-fs-minio`) is torn down by the harness — no leftover containers/volumes
  after the run (verified via `docker ps -a`).

## Evidence

### Logs & Output
Typecheck:
```
$ tsc --build
TYPECHECK_EXIT=0
```

Unit suite:
```
 898 pass
 114 skip
 0 fail
 2956 expect() calls
Ran 1012 tests across 103 files. [13.37s]
```

E2E (cross-backend, MinIO + local):
```
Results: 127/127 passed (10 skipped)
E2E_EXIT=0
PASS(✓): 127   SKIP(⊘): 10   FAIL(✗): 0
Sections: [minio] core ops | [local] core ops | capability gating | signed-url matrix | FUSE (skipped, Darwin)
```
Full E2E log saved to scratchpad: `e2e-162027.log`.

### External Links
- Plan: `thoughts/taras/plans/2026-06-25-multi-adapter-storage/root.md`
- Research: `thoughts/taras/research/2026-06-25-files-sdk-storage-adapters.md`

## Issues Found
- [ ] **Local blob GC / cross-store atomicity** — severity: minor (consciously deferred). The
  object-then-commit write path (`putObject` then `createVersion`) leaves a narrow partial-failure
  window, and local content-addressed blobs under `_afs-blobs/sha256/` are never garbage-collected,
  so local version history grows unbounded. Harmless today (orphans are dedup-shared); track a
  GC/retention story before local sees heavy churn. Already noted in the plan's Review Errata.
- [ ] **`--local` vs `--filesystem` naming** — severity: minor (UX). `--local` means *local MinIO
  Docker* while `--filesystem` / `--storage local` mean *local filesystem*; a user could reasonably
  expect `--local` to mean the filesystem. Consider an alias/rename in a future onboarding pass.
  Already noted in the plan's Review Errata.

No critical or major issues.

## Verdict
**Status**: PASS
**Summary**: Multi-adapter storage passes QA across the board — typecheck clean, 898/0 unit
pass/fail, and 127/127 cross-backend E2E (MinIO + local-FS) against a real MinIO container,
including local revert/diff, clean capability-gating of unsupported ops (CLI exit + HTTP 422),
and the signed-url presigned-vs-app-fallback matrix. S3/MinIO behavior is unchanged. Versions are
already bumped to 0.10.0 in lockstep (last published 0.9.0); no further bump is warranted. Only two
non-blocking minor items remain, both already tracked in the plan's Review Errata.

## Appendix
- **Plan**: `thoughts/taras/plans/2026-06-25-multi-adapter-storage/root.md`
- **Research**: `thoughts/taras/research/2026-06-25-files-sdk-storage-adapters.md`
- **Notes**: FUSE mount tests skipped on Darwin (set `AGENT_FS_USE_DOCKER_FUSE=1` to run via
  Docker). Run on `refactor/files-sdk` @ working tree clean.

---
id: step-5
name: Cross-backend E2E + release checklist
depends_on: [step-1, step-2, step-3, step-4]
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-5: Cross-backend E2E + release checklist

## Overview
The terminal integration node. Extend `scripts/e2e.ts` to run the backend-agnostic op suite against **both** MinIO (S3) and a local-FS drive — including `revert`/historical `diff` under each tier and a clean **unsupported-op** assertion — and complete the project release checklist (SKILL.md, `.claude-plugin/plugin.json` + root `package.json` version bumps). This is the only step that touches `package.json`/`plugin.json`/`SKILL.md`, so the parallel steps never collide on them.

## Changes Required:

#### 1. Parameterize the E2E harness for two backends
**File**: `scripts/e2e.ts`
**Changes**:
- Factor the **backend-agnostic** op tests (`write`/`cat`/`ls`/`stat`/`edit`/`append`/`rm`/`mv`/`cp`/`log`/`diff`/`revert`/`glob`/`recent`) out of the current inline flow into a reusable block, e.g. `async function coreOpsSuite(label: string)`, that uses the existing `run`/`runJson`/`assert`/`test` helpers.
- Add a **local-FS backend** path alongside the MinIO one: a second `AGENT_FS_HOME` + daemon started with env `AGENT_FS_STORAGE_PROVIDER=local` (and `AGENT_FS_LOCAL_ROOT=<temp>`), **no MinIO container**. The current `testEnv()` (`:79-95`) hardcodes `S3_PROVIDER: "minio"` + MinIO endpoint — generalize it (or add `localEnv()`) so the daemon/CLI target the chosen backend. Reuse `findFreePort` + the daemon start/stop logic from `setup()` (`:253`).
- Run `coreOpsSuite("minio")` and `coreOpsSuite("local")`. Keep FUSE/MinIO-specific tests under the MinIO backend only.
- **Tier assertions**: on **both** backends, assert `revert` restores prior content as a new version and `diff(v1,v2)` returns real content changes (S3 via object versioning, local via content-addressed blobs). Assert `ls` shows directories and **never** lists `_afs-blobs`.

#### 2. Unsupported-op + fallback assertions
**File**: `scripts/e2e.ts`
**Changes**:
- **Unsupported path**: start a local daemon with the test-only `AGENT_FS_CAPABILITY_OVERRIDE='{"versioning":false}'` (from step-2) and assert `agent-fs revert …` exits non-zero with a clean message containing `UNSUPPORTED_OPERATION` (no stack trace) — proving the gating surfaces through the real CLI→daemon path.
- **Fallback path**: on a normal local drive assert `agent-fs signed-url <path>` succeeds and returns the app-URL fallback (labeled as an app/non-presigned link), **not** an error. On MinIO assert `signed-url` still returns a real presigned URL (regression).

#### 3. Release checklist — SKILL.md
**File**: `skills/agent-fs/SKILL.md`
**Changes**: Document (a) the new **local-filesystem backend** and its onboarding flag (`onboard --filesystem`); (b) the **per-backend capability tiers** (S3/MinIO + local = full versioning; future backends = basic), so agents know `revert`/historical `diff` availability depends on the backend; (c) the **`signed-url` fallback** on local (returns an authenticated app link, requires sign-in, not a public presigned URL). Update command/description triggers and any workflow examples if they assume S3-only.

#### 4. Release checklist — version bumps (lockstep)
**Files**: root `package.json`, `.claude-plugin/plugin.json`, and everything `scripts/sync-versions.ts` rewrites
**Changes**: Bump the root `package.json` `version` (**minor** — new backend/feature, non-breaking) and run `bun run scripts/sync-versions.ts <version>` so every sub-package `package.json`, the FUSE `Cargo.toml`, and `.claude-plugin/plugin.json` move together. (Per project `CLAUDE.md` release checklist + the FUSE sub-package note.)

#### 5. E2E coverage note (project CLAUDE.md requirement)
**File**: `scripts/e2e.ts` (covered by #1–#2)
**Changes**: Confirms the "new op/backend ⇒ extend `scripts/e2e.ts`" rule — the local backend + revert/diff + unsupported-op assertions satisfy it.

### Success Criteria:

#### Automated Verification:
- [ ] Whole-repo typecheck: `bun run typecheck`
- [ ] Full test suite: `bun test`
- [ ] E2E passes for **both** backends: `bun run scripts/e2e.ts "bun run packages/cli/src/index.ts --"` (Docker available for the MinIO leg) — output shows a `minio` section and a `local` section, both green, including revert/diff and the unsupported-op assertion.
- [ ] Version lockstep: `git grep -n '"version"' package.json .claude-plugin/plugin.json packages/*/package.json` all match the new version after `sync-versions.ts`.

#### Automated QA:
- [ ] E2E run log demonstrates: identical core-ops results on MinIO and local; `revert`/`diff` real-content on both; `UNSUPPORTED_OPERATION` clean error on the capability-overridden local daemon; `signed-url` returns presigned (MinIO) vs app-URL fallback (local).

#### Manual Verification:
- [ ] Read the `skills/agent-fs/SKILL.md` diff for accuracy (capability tiers + onboarding flag + signed-url semantics described correctly).
- [ ] Confirm the version bump + `sync-versions.ts` followed the release checklist (no orphaned/mismatched versions), and the S3/MinIO behavior is unchanged versus `main` (existing MinIO E2E still green).

**Implementation Note**: Vertical slice + integration gate — the whole DAG is proven on two backends and the repo is release-ready. After completing this step, pause for manual confirmation. Commit-per-step is enabled: commit as `[step-5] Cross-backend E2E (S3 + local) + release checklist` after verification passes.

### QA Spec (optional):
Not required — the dual-backend matrix is fully covered by the parameterized `scripts/e2e.ts` above; no separate `desplega:qa` evidence doc is warranted.

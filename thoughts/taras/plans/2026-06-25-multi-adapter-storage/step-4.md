---
id: step-4
name: Config tagged-union + adapter selection + onboarding
depends_on: [step-1, step-3]
status: done
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-4: Config tagged-union + adapter selection + onboarding

## Overview
Make the local-FS backend reachable end-to-end by users. Evolve `AgentFSConfig.s3` into a discriminated union keyed by `provider`, add a `createStorageAdapter` factory that selects `LocalStorageAdapter` vs `AgentS3Client` at the single construction site, retype the server-side `s3: AgentS3Client` annotations to `StorageAdapter`, and add an onboarding path for a local-FS drive. End state: a fresh `onboard` for a filesystem backend produces a daemon that serves a working local drive with full versioning.

## Changes Required:

#### 1. Config as a tagged union
**File**: `packages/core/src/config.ts`
**Changes**:
- Change `AgentFSConfig.s3` (`:14-23`) into a discriminated union on `provider`:
  - S3 variant (existing fields): `{ provider: "minio" | "s3" | "r2" | "tigris" | string; bucket; region; endpoint; publicEndpoint?; accessKeyId; secretAccessKey; versioningEnabled? }`.
  - Local variant: `{ provider: "local"; root: string }`.
- **Keep the field name `s3`** (the union lives under `config.s3`, discriminated by `config.s3.provider`) to minimize churn across all `config.s3` consumers; add a comment noting the legacy name. (Alternative — rename to `config.storage` — is a larger refactor; recorded as a derail in `root.md`, not done here.)
- **Fix `deepMergeConfig` (`:109-126`)** so a `provider: "local"` override does **not** get the S3-shaped `DEFAULT_CONFIG.s3` fields merged under it (the 2-level merge would otherwise leave stale `bucket`/`endpoint`/etc.). When `overrides.s3?.provider` differs from the default provider, **replace** `s3` instead of shallow-merging.
- **Guard `applyEnvOverrides` (`:132-147`)**: wrap the `S3_*`/`AWS_*` block in `if (config.s3.provider !== "local")`. Add `AGENT_FS_STORAGE_PROVIDER` and `AGENT_FS_LOCAL_ROOT` env overrides for the local variant. (The test-only `AGENT_FS_CAPABILITY_OVERRIDE` from step-2 is handled at adapter construction, not here.)

#### 2. Adapter selection factory
**File**: `packages/core/src/storage/factory.ts` (new)
**Changes**: `export function createStorageAdapter(cfg: AgentFSConfig["s3"]): StorageAdapter` — switch on `cfg.provider`: `"local"` → `new LocalStorageAdapter({ root: cfg.root })`; default → `new AgentS3Client(cfg)`. Apply the step-2 `AGENT_FS_CAPABILITY_OVERRIDE` overlay here (fold in the temporary `server/index.ts` placement from step-2). Export from `@/core`.

#### 3. Use the factory at the single construction site
**File**: `packages/server/src/index.ts`
**Changes**: Replace `const s3 = new AgentS3Client(config.s3)` (`:13`) with `const s3 = createStorageAdapter(config.s3)`. Update the import.

#### 4. Retype the server-wide storage seam
**Files**: `packages/server/src/app.ts`, `packages/server/src/routes/files.ts` (`:8`, `:14`), `packages/server/src/routes/ops.ts`, `packages/server/src/ipc/handlers.ts`, `packages/mcp/src/server.ts` (context type). _(Post-impl correction: the seam retype landed in `ipc/handlers.ts`, not `ipc/server.ts` — `ipc/server.ts` only references the `IpcContext` type and needed no change; `routes/ops.ts` was also retyped.)_
**Changes**: Change `s3: AgentS3Client` parameter/field annotations to `s3: StorageAdapter` (import from `@/core`). Mostly type-only — `AgentS3Client` already satisfies it (step-1). This is the step where a non-S3 adapter actually flows through these call sites.

#### 5. `config validate` handles local
**File**: `packages/cli/src/commands/config-cmd.ts` (`:85-87`)
**Changes**: The connectivity check currently does `new AgentS3Client(config.s3)`. Route it through `createStorageAdapter`; for the local provider, "validate" = ensure `root` exists or is creatable and writable (a probe write/delete under `root`), reporting a clear pass/fail.

#### 6. Onboarding for a filesystem backend
**File**: `packages/cli/src/commands/onboard.ts`
**Changes**: Add a filesystem onboarding path. **Naming care:** the existing `onboard --local` already means "local **MinIO** container" (`:207-228`) — do **not** overload it. Add a distinct flag, recommended **`--filesystem`** (alias `--storage local`), that writes `config.s3 = { provider: "local", root: <default ~/.agent-fs/storage or a chosen dir> }`, skips MinIO/Docker setup, and prints next steps. Ensure the chosen `root` is created. Update `--help` text.

### Success Criteria:

#### Automated Verification:
- [x] Typecheck + tests: `bun run typecheck` && `bun test`
- [x] Config unit tests (actual path `packages/core/src/config.test.ts`): a `{ provider: "local", root }` config round-trips through `getConfig`/`deepMergeConfig` **without** stale S3 fields; `applyEnvOverrides` skips `S3_*` for local and honors `AGENT_FS_LOCAL_ROOT`; an S3 config still merges/overrides exactly as before (regression).
- [x] `createStorageAdapter` unit test: `provider: "local"` → `LocalStorageAdapter`; `provider: "minio"` → `AgentS3Client`.
- [x] `bun run packages/cli/src/index.ts -- onboard --help` shows the new `--filesystem` flag; `… config --help` still works.

#### Automated QA:
- [x] Daemon round-trip on local: start the daemon with a temp-root local config (env or written config.json), then via the CLI run `write → cat → ls → log → diff → revert` against it — all succeed, revert/diff return real content (full local tier through the real server, not just unit tests).
- [x] `agent-fs config validate` passes for a writable local `root` and fails with a clear message for an unwritable/bad `root`.

#### Manual Verification:
- [ ] Run `onboard --filesystem` from a clean `AGENT_FS_HOME`; confirm the flow wording, flag naming, and that the resulting daemon serves a local drive with no Docker involved.

**Implementation Note**: Vertical slice — users can now configure/onboard and run a local-FS backend end-to-end through the real daemon. SKILL.md + version bumps are intentionally deferred to step-5 (the terminal node) to avoid parallel merge conflicts on `package.json`/`plugin.json`. After completing this step, pause for manual confirmation. Commit-per-step is enabled: commit as `[step-4] Tagged-union storage config + adapter selection + filesystem onboarding` after verification passes.

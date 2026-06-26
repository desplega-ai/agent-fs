---
id: step-2
name: Capability gating + clean surfacing (core→CLI→MCP)
depends_on: [step-1]
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-2: Capability gating + clean surfacing (core→CLI→MCP)

## Overview
Wire capability checks into the version-critical ops so a backend that lacks a capability throws the step-1 `UnsupportedOperation` (instead of a raw/confusing S3/FS error), and prove it surfaces cleanly all the way out through the daemon's HTTP error layer → CLI and → MCP. This slice is independent of the local adapter (step-3): it is QA-able today by pointing an `OpContext` (and the in-process Hono app + the MCP server) at a `MockS3Client` whose `capabilities` are forced off. **File-disjoint from step-3** — they touch different ops (`revert`/`diff` here, `signed-url` there) and can run in parallel.

## Changes Required:

#### 1. Capability assertion helper
**File**: `packages/core/src/storage/capabilities.ts` (new)
**Changes**: `export function assertCapability(adapter: StorageAdapter, cap: keyof StorageCapabilities, operation: string): void` — throws `new UnsupportedOperation(operation, /* backend label */, …)` when `!adapter.capabilities[cap]`. (Optionally accept a backend label; otherwise derive a generic one.)

#### 2. Gate the version-critical ops
**File**: `packages/core/src/ops/revert.ts`
**Changes**: At the top of `revert` (before the existing `VERSIONING_REQUIRED` throw at `:45`), call `assertCapability(ctx.s3, "versioning", "revert")`. Keep the existing `VERSIONING_REQUIRED` `AgentFSError` for the narrower "versioning-capable backend but this row has no version handle" case. Net: no-versioning backend → `UnsupportedOperation`; versioning backend w/ missing handle → `VERSIONING_REQUIRED` (unchanged).

**File**: `packages/core/src/ops/diff.ts`
**Changes**: Confirm/keep the existing graceful degradation (`:81-91`) — historical-content `diff` on a no-versioning backend must **fall back to the stored `diffSummary`, never throw** `UnsupportedOperation`. Add a guard so that when `!ctx.s3.capabilities.versioning` it goes straight to the summary path (no version-id fetch attempt). Document that `diff` degrades, `revert` hard-throws — this asymmetry matches research §3.

#### 3. Refine the daemon error→HTTP mapping
**File**: `packages/server/src/middleware/error.ts`
**Changes**: Add `if (err instanceof UnsupportedOperation) return 422;` to `errorToStatus` (alongside the existing `NotFoundError`→404 etc. at `:11-16`). The base `"code" in err → 400` branch (`:16`) already catches it, so this is a status refinement; the body already serializes via `err.toJSON()` (`:24-25`). (Pick 422 Unprocessable; 501 Not Implemented is also defensible — 422 avoids clients treating it as a server bug.)

#### 4. MockS3Client: allow forcing capabilities (test affordance)
**File**: `packages/core/src/test-utils.ts`
**Changes**: Extend the `MockS3Client` constructor opts with `capabilities?: Partial<StorageCapabilities>` so tests can construct a no-versioning / no-presign backend. The `capabilities` getter merges the override over the defaults from step-1. Thread an optional `capabilities` through `createTestContext` opts.

#### 5. Test-only capability override at startup (for the step-5 CLI e2e)
**File**: `packages/core/src/config.ts` (env handling) + `packages/core/src/storage/factory.ts` (created in step-4 — see note) **or** `packages/server/src/index.ts`
**Changes**: Honor a **test-only** env var `AGENT_FS_CAPABILITY_OVERRIDE` (JSON, e.g. `{"versioning":false}`) that, when set, overlays the constructed adapter's `capabilities`. This lets step-5's e2e drive a real CLI→daemon `UNSUPPORTED_OPERATION` path against a backend that otherwise has the capability. Gate it behind an obvious "test-only" comment. (Adapter construction currently lives at `server/index.ts:13`; if step-4 lands the `createStorageAdapter` factory first, apply the override there. To keep this step independent, apply it at `server/index.ts` against the constructed adapter and let step-4 fold it into the factory.)

#### 6. CLI + MCP surfacing (verify; minimal/no code change)
**Files**: `packages/cli/src/commands/ops.ts` (`:182-192`), `packages/cli/src/api-client.ts` (`:46-50`), `packages/mcp/src/tools.ts`, `packages/mcp/src/server.ts`
**Changes**: The CLI api-client already surfaces `body.message` + `body.suggestion` (`api-client.ts:47-49`) and `commands/ops.ts:191` prints `Error: ${err.message}` + exit 1 — confirm `UnsupportedOperation` flows through as a clean line (no stack). For MCP, confirm the ops tool path returns `{ isError: true, content: [{ text: <message> }] }` for a daemon error (member tools already do this — `server.ts:176-179`); if the ops proxy swallows or rethrows raw, add the same `isError` mapping. Prefer assertions over code where it already works.

### Success Criteria:

#### Automated Verification:
- [ ] Typecheck + tests: `bun run typecheck` && `bun test`
- [ ] Unit: `revert` against `new MockS3Client({ capabilities: { versioning: false } })`-backed ctx throws `UnsupportedOperation` with `code === "UNSUPPORTED_OPERATION"` (`packages/core/src/ops/__tests__/revert.test.ts`).
- [ ] Unit: `diff` against the same backend returns the `diffSummary` fallback and does **not** throw.

#### Automated QA:
- [ ] In-process daemon test (Hono `app.fetch`, `createApp(db, forcedMock, …)`): `POST /…/ops` op=`revert` → HTTP **422** with body `{ error: "UNSUPPORTED_OPERATION", message, suggestion }`.
- [ ] MCP server test: invoking the `revert` tool against the no-versioning backend returns `isError: true` with the message text (not a raw throw).
- [ ] CLI surfacing test: simulate the api-client receiving the 422 JSON and assert the thrown `Error.message` is the clean `message` + `Suggestion:` line (no stack trace).

#### Manual Verification:
- [ ] Read the rendered CLI error string for an unsupported `revert` — confirm the wording + suggestion are friendly and actionable.

**Implementation Note**: Vertical slice — an unsupported op now fails with one clean, typed message from core through CLI and MCP, proven against a forced-capability mock without needing the local adapter. After completing this step, pause for manual confirmation. Commit-per-step is enabled: commit as `[step-2] Capability gating + clean UnsupportedOperation surfacing` after verification passes.

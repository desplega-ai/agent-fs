---
id: step-1
name: StorageAdapter interface + capabilities + UnsupportedOperation
depends_on: []
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-1: StorageAdapter interface + capabilities + UnsupportedOperation

## Overview
Extract the storage contract that every other step builds on. Define a `StorageAdapter` interface (the existing 10-method surface + `versioningEnabled` + a new `capabilities` field), a `StorageCapabilities` metadata type, and a typed `UnsupportedOperation` error. Make `AgentS3Client implements StorageAdapter` (behavior 100% unchanged — it only gains the declaration + a `capabilities` getter) and `MockS3Client implements StorageAdapter`, which forces us to add the **missing `getPresignedUrl`** to the mock and **remove the `as any` cast** at `test-utils.ts:225`. Re-type `OpContext.s3` to the interface. No op behavior changes; the proof of this slice is that everything still typechecks and all existing tests pass with the cast gone.

## Changes Required:

#### 1. Storage contract (new file)
**File**: `packages/core/src/storage/adapter.ts` (new `storage/` directory)
**Changes**:
- Define `export interface StorageCapabilities { versioning: boolean; presignedUrls: boolean }`.
- Define `export interface StorageAdapter` with the exact signatures from `packages/core/src/s3/client.ts` (`:78-238`): `putObject`, `getObject(key, versionId?, opts?: { abortSignal?: AbortSignal })`, `deleteObject`, `copyObject`, `listObjects(prefix, opts?: { delimiter?: string })`, `headObject`, `listObjectVersions`, `checkVersioningEnabled`, `enableVersioning`, `getPresignedUrl(key, expiresIn?, responseContentType?)`, plus `versioningEnabled: boolean` and `readonly capabilities: StorageCapabilities`.
- **Move** the shared result/value types currently in `s3/client.ts:16-49` (`S3Object`, `S3ObjectVersion`, `PutObjectResult`, `GetObjectResult`, `HeadObjectResult`) into this file (canonical home) to avoid a circular import (`client.ts` will import the interface from here). Re-export them from `s3/client.ts` for back-compat if any external import path relies on them.
- Add a doc comment stating the **not-found error-shape contract**: adapters MUST surface "object not found" as an error matching what ops already branch on — `err.name ∈ {"NoSuchKey","NotFound"}` or `err.$metadata?.httpStatusCode === 404` (see `cat.ts:45`, `stat.ts:18`, `signed-url.ts:31`, `routes/files.ts:77`). This keeps the ~6 op error branches unchanged.

#### 2. Typed unsupported-operation error
**File**: `packages/core/src/errors.ts`
**Changes**: Add `export class UnsupportedOperation extends AgentFSError` mirroring the existing class pattern (`:1-35`): `constructor(operation: string, backend?: string, opts?: { suggestion?: string })` → `super("UNSUPPORTED_OPERATION", message, suggestion)`. Store `readonly operation` / `readonly backend`; override `toJSON()` to include them. Default message e.g. ``\`Operation '${operation}' is not supported by the '${backend}' storage backend\``` with a suggestion pointing at the capable tiers.

#### 3. AgentS3Client conforms (no behavior change)
**File**: `packages/core/src/s3/client.ts`
**Changes**: `export class AgentS3Client implements StorageAdapter`. Import the moved shared types from `../storage/adapter.js`. Add `get capabilities(): StorageCapabilities { return { versioning: this.versioningEnabled, presignedUrls: true }; }` (a getter so it tracks `enableVersioning()` mutating `versioningEnabled`). **Do not change any method body.**

#### 4. MockS3Client conforms (close the drift the cast hid)
**File**: `packages/core/src/test-utils.ts`
**Changes**: `export class MockS3Client implements StorageAdapter`. Add the currently-missing `async getPresignedUrl(key, expiresIn = 86400, responseContentType?): Promise<string>` returning a deterministic fake (e.g. ``\`https://mock.local/${key}?e=${expiresIn}\``). Add `get capabilities(): StorageCapabilities { return { versioning: this.versioningEnabled, presignedUrls: true }; }`. Remove the `as any` cast at `:225` — change `s3: s3 as any` to `s3,`. (If typecheck reveals any other signature drift between mock and interface, reconcile it here — surfacing that drift is the point.)

#### 5. Re-type the injection seam
**File**: `packages/core/src/ops/types.ts`
**Changes**: Change `s3: AgentS3Client` (`:7`) to `s3: StorageAdapter`; replace the `import type { AgentS3Client }` (`:1`) with `import type { StorageAdapter } from "../storage/adapter.js"`. **Keep the field name `s3`** to avoid churn across the ~16 ops (research §7; field rename is explicitly out of scope).

#### 6. Barrel exports
**File**: `packages/core/src/index.ts`
**Changes**: Export `StorageAdapter`, `StorageCapabilities`, `UnsupportedOperation`, and ensure the moved shared storage types remain exported (server/CLI import `AgentS3Client` + types from `@/core`). Do **not** change server-side `s3: AgentS3Client` annotations yet — `AgentS3Client` still satisfies them; the server-wide retype to `StorageAdapter` happens in step-4 when a non-S3 adapter actually flows through.

### Success Criteria:

#### Automated Verification:
- [ ] Whole-repo typecheck passes — this is the core proof; removing `as any` must compile cleanly: `bun run typecheck`
- [ ] Full test suite still green (zero behavior change): `bun test`
- [ ] The cast is gone: `! grep -n "s3 as any" packages/core/src/test-utils.ts`
- [ ] No op imports `AgentS3Client` as a value (interface-only seam): `! grep -rn "new AgentS3Client" packages/core/src/ops`

#### Automated QA:
- [ ] A unit test (`packages/core/src/storage/__tests__/adapter.test.ts`) instantiates `MockS3Client`, asserts `.capabilities` returns `{ versioning, presignedUrls: true }` and `.getPresignedUrl("k")` returns a string — proving the mock fully implements the surface (no longer needs the cast).
- [ ] A type-level assignability check (e.g. `const _a: StorageAdapter = new MockS3Client()` and `= new AgentS3Client(cfg)`) compiles.
- [ ] A unit test constructs `new UnsupportedOperation("revert", "local")` and asserts `.code === "UNSUPPORTED_OPERATION"` and `.toJSON()` carries `operation`/`backend`/`message`.

#### Manual Verification:
- [ ] Skim the diff to confirm `AgentS3Client` method bodies are byte-for-byte unchanged (only the `implements` clause + `capabilities` getter + import path added).

**Implementation Note**: Vertical slice — the storage contract exists and compiles, the mock-vs-real drift is closed, and the whole suite is green. After completing this step, pause for manual confirmation. Commit-per-step is enabled: commit as `[step-1] StorageAdapter interface + capabilities + UnsupportedOperation` after verification passes.

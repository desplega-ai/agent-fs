---
id: step-3
name: files-sdk local-FS adapter + app-level versioning
depends_on: [step-1]
status: ready
---

<!-- During /v-implement, `desplega:step-running` adds `assignee` and `claimed_at` while
working, then transitions `status` to `done` (success) or back to `ready` (retry-able failure). -->

# step-3: files-sdk local-FS adapter + app-level versioning

## Overview
Implement `LocalStorageAdapter` — a `StorageAdapter` backed by the `files-sdk` filesystem adapter (`files-sdk/fs`) — that gives local storage the **full** versioning tier via **content-addressed app-level blobs**, so `revert` and historical `diff` work without object versioning. Capabilities are `{ versioning: true, presignedUrls: false }`; the `signed-url` op falls back to the daemon app URL. QA-able on its own by driving the adapter and the version-critical ops against a temp directory — no server wiring needed (that's step-4). **File-disjoint from step-2** (touches `signed-url.ts`, not `revert.ts`/`diff.ts`), so the two run in parallel after step-1.

## Changes Required:

#### 1. Add the dependency
**File**: `packages/core/package.json` (+ lockfile)
**Changes**: `cd packages/core && bun add files-sdk` (v2.0.0). The `files-sdk/fs` adapter needs only `node:fs` (no extra peer); the `@aws-sdk/*` peers for the s3 adapter are already present. Bun compatibility is confirmed (root uses `bun test`, `packageManager: bun@1.3.14`).

#### 2. The local adapter
**File**: `packages/core/src/storage/local-adapter.ts` (new)
**Changes**: `export class LocalStorageAdapter implements StorageAdapter`.
- Construct: `import { Files } from "files-sdk"; import { fs } from "files-sdk/fs";` → `this.files = new Files({ adapter: fs({ root: opts.root }) })`. Keys map to nested paths under `root` (verified); `mkdir(recursive)` is automatic on write.
- `versioningEnabled = true`; `get capabilities() { return { versioning: true, presignedUrls: false }; }`.
- **Content-addressed blob scheme** (confirmed decision): every version's bytes are stored at a reserved top-level key `_afs-blobs/sha256/<hash>` (optionally fanned out `_afs-blobs/sha256/<hash[0:2]>/<hash>`). This prefix is **outside** any `<orgId>/drives/<driveId>/…` listing prefix, so it never surfaces in `ls`/`glob`. The opaque version handle = the sha-256 hash (stored in `file_versions.s3_version_id` by the ops). Reuses the same hash the write path already computes (`write.ts:75-77`), so the handle is free and identical content dedups.
- `putObject(key, body, _metadata, contentType)`: compute `hash = sha256(bytes)`. **Write the blob first** (`exists(_afs-blobs/sha256/<hash>)` → skip if present, else `upload`), **then** write the plain current key via `files.upload(key, bytes, { contentType })`. Blob-first guarantees history durability even if the plain-key write fails. Return `{ etag: hash, versionId: hash }`.
- `getObject(key, versionId?, _opts?)`: if `versionId` → `download("_afs-blobs/sha256/" + versionId)`; else `download(key)`. Materialize `await stored.arrayBuffer()` → `Uint8Array`; map to `{ body, contentType: stored.type, size: stored.size, versionId, etag: stored.etag }`. **Translate `FilesError` with `code === "NotFound"`** into the S3-compatible not-found shape the ops branch on (`const e = new Error(...); e.name = "NoSuchKey"; throw e;`).
- `deleteObject(key)`: delete the plain key only (`files.delete(key)`); **leave blobs intact** (they are the version history). Swallow `NotFound`. (Matches S3 delete-marker semantics: prior versions stay retrievable by handle — research §2 item 6.)
- `copyObject(from, to)`: read `from`'s bytes → `putObject(to, bytes, …)` (ensures the blob exists + writes the plain `to` key). Return `{ etag: hash, versionId: hash }`.
- `listObjects(prefix, opts?)`: `files.list({ prefix, delimiter: opts?.delimiter })` → map page `items` → `S3Object[]` (`{ key, size, lastModified, etag }`) and `prefixes` → `string[]`. Drain the paginated/async-iterable result (handle `cursor`). Verified: fs synthesizes `/`-delimited common prefixes, so `ls` works with no `.raw`.
- `headObject(key)`: `files.head(key)` → `{ contentType: stored.type, size, lastModified, etag }`; translate `NotFound`.
- `listObjectVersions(key)`: unused by ops — return `[]`.
- `checkVersioningEnabled()`: `true`. `enableVersioning()`: `true` (no-op; app-level versioning is always on).
- `getPresignedUrl()`: `throw new UnsupportedOperation("signed-url", "local")` — defensive; the op-level capability check (below) should fall back *before* calling this.

#### 3. `signed-url` op: capability-gated fallback to the app URL
**File**: `packages/core/src/ops/signed-url.ts`
**Changes**: Before calling `ctx.s3.getPresignedUrl` (`:40`), branch on capability: if `!ctx.s3.capabilities.presignedUrls`, return a fallback URL built with `buildAppUrl(ctx.appUrl, ctx.orgId, ctx.driveId, normalizedPath)` (`ops/urls.ts:1-9`) instead of presigning.
- **Verified caveat (must be surfaced):** the daemon `GET …/raw` route and the `/file/~/…` app viewer are **auth-gated** (`routes/files.ts:25` reads `c.get("user")`). So this fallback URL is an *authenticated in-app link*, **not** an unauthenticated public/presigned URL. Reflect this in the result: the app URL does not expire, so set `expiresIn: 0` / omit `expiresAt` (or document it as nominal), and add a field/marker (e.g. `kind: "app" | "presigned"`) so the CLI/UI can label it "app link (requires sign-in)". 
- If `ctx.appUrl` is unset (can't build a URL), throw `UnsupportedOperation("signed-url", "local")`.
- Keep the existing head-check + `NotFoundError` mapping (`:28-37`) unchanged.

#### 4. Cross-store atomicity (call-out, minimal code)
**File**: `packages/core/src/ops/write.ts` (no change) + adapter doc comment
**Changes**: Document in `local-adapter.ts` that the write path stays object-then-commit (`putObject` then `createVersion`) — unchanged. Inside `putObject`, blob-first-then-plain-key ordering keeps history durable. On a `createVersion` failure the orphan is a content-addressed blob that is **dedup-shared and safe to leave** (do NOT delete on failure — the hash may back another version), so no new cleanup is needed; the local partial-failure window matches today's S3 path. Real reconciliation/retry is deferred to the remote/consumer adapter (follow-up plan).

### Success Criteria:

#### Automated Verification:
- [ ] `files-sdk` recorded in `packages/core/package.json`; `bun install` clean.
- [ ] Typecheck + tests: `bun run typecheck` && `bun test`
- [ ] Adapter integration test (`packages/core/src/storage/__tests__/local-adapter.test.ts`, temp dir via `mkdtemp`): put/get/head/delete/copy round-trip; `listObjects(prefix, { delimiter: "/" })` returns files in `objects` + subdirs in `prefixes` and **never** surfaces `_afs-blobs`; `getObject(key)` after two writes returns latest, `getObject(key, oldHash)` returns the older bytes; `headObject` on a missing key throws an error with `name === "NoSuchKey"`.

#### Automated QA:
- [ ] Op-level end-to-end test with `ctx.s3 = new LocalStorageAdapter({ root: tmp })` + a test DB: `write → edit → append → log → diff(v1,v2) → revert(v1)` all succeed and **`revert`/`diff` return real content** (full tier proven on local).
- [ ] `signed-url` op against the local adapter (with `ctx.appUrl` set) returns the `buildAppUrl` fallback URL, asserts it does **not** throw, and the result is marked as an app/non-presigned link; with `ctx.appUrl` unset it throws `UnsupportedOperation`.

#### Manual Verification:
- [ ] Confirm the signed-url fallback semantics are acceptable: given `/raw` + the viewer require auth, an authenticated app link (not a public URL) is the right "share" behavior for a local backend — sign off or adjust the labeling/UX.
- [ ] Inspect a temp `root` after a few writes+revert: plain current files mirror the key paths, history lives under `_afs-blobs/sha256/…`, identical content deduped to one blob.

**Implementation Note**: Vertical slice — a real local-FS backend with working revert/diff and a sensible signed-url fallback, proven against a temp directory without any server wiring (that's step-4). After completing this step, pause for manual confirmation. Commit-per-step is enabled: commit as `[step-3] files-sdk local-FS adapter with content-addressed versioning` after verification passes.

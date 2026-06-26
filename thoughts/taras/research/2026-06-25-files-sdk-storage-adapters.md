---
date: 2026-06-25T11:20:00-00:00
researcher: Claude (for Taras)
git_commit: 028667b60761aed5586b0bdca0407f69ae944ab2
branch: main
repository: desplega-ai/agent-fs
topic: "Migrating agent-fs storage to files-sdk.dev with multi-adapter support"
tags: [research, codebase, storage, s3, files-sdk, adapters, versioning]
status: complete
autonomy: critical
last_updated: 2026-06-25
last_updated_by: Claude (for Taras)
---

# Research: Migrating agent-fs storage to files-sdk.dev with multi-adapter support

**Date**: 2026-06-25
**Researcher**: Claude (for Taras)
**Git Commit**: 028667b60761aed5586b0bdca0407f69ae944ab2
**Branch**: main

## Research Question

How could we change the current implementation of agent-fs storage to use [files-sdk.dev](https://files-sdk.dev/) for the connection, bringing the option to support multiple storage adapters?

## Summary

agent-fs already has the structural prerequisite for multi-adapter storage: **every byte of object I/O flows through a single wrapper class, `AgentS3Client`** (`packages/core/src/s3/client.ts`), exposed to the rest of the system only as `ctx.s3` on `OpContext` (`packages/core/src/ops/types.ts:5-13`). There are **zero direct `@aws-sdk/client-s3` imports anywhere outside that one file** — the ~16 ops (`write`, `cat`, `ls`, `cp`, `mv`, `rm`, `append`, `edit`, `diff`, `revert`, `stat`, `glob`, `signed-url`, `reindex`, `tail`, `log`) all call `ctx.s3.<method>()`. A `MockS3Client` already implements the same shape for tests (`packages/core/src/test-utils.ts`). So introducing alternative backends is structurally a matter of (a) extracting a `StorageAdapter` interface from `AgentS3Client`'s 10-method surface, (b) writing one or more adapter implementations, and (c) choosing the concrete instance at the single construction site (`packages/server/src/index.ts:13`). No op code needs to change.

The real question is **semantic, not structural**: the current backend leans on three S3-specific capabilities that `files-sdk`'s *unified* API deliberately does not model — (1) **per-object versioned reads** (`getObject(key, versionId)`), which `revert` and historical `diff` depend on and which `revert` hard-requires (`packages/core/src/ops/revert.ts:44-54`); (2) **prefix listing with a `/` delimiter** that returns directory "common prefixes," which `ls` consumes (`packages/core/src/ops/ls.ts:15`, `client.ts:145-165`); and (3) a **separate presign endpoint** (`publicEndpoint`) so signed URLs point at a public host while internal ops hit an internal one (`client.ts:69-74`). `files-sdk` (v2.0.0, by Hayden Bleasel, npm `files-sdk`) is a clean, Bun-tested, web-streams unified storage SDK with first-class S3/MinIO support, presigned GET (`url({expiresIn})`), presigned PUT (`signedUploadUrl`), byte-range reads, and multipart — but it pushes versioning, conditional/ETag writes, and arbitrary object metadata to its `files.raw` escape hatch (the native `S3Client`). 

This means a `files-sdk`-based S3 adapter would use the unified API for the bulk of ops (put/get/head/copy/delete/upload-url) and drop to `files.raw` for the version-id-aware read in `revert`/`diff`, the delimiter listing in `ls`, and the bucket-versioning enable/check. Because so much of agent-fs's "filesystem" semantics (version numbering, dedup, concurrency, metadata, search) already lives in **SQLite, not S3** (`packages/core/src/db/raw.ts`, `packages/core/src/ops/versioning.ts`), the object store is genuinely "just a keyed blob store," which is exactly `files-sdk`'s sweet spot. The decision point worth surfacing before any plan: whether the abstraction earns its keep given the version-critical paths still need `.raw` — versus extracting agent-fs's *own* `StorageAdapter` interface and writing thin adapters directly (S3 via `@aws-sdk` or `Bun.s3`, plus e.g. GCS/local), with `files-sdk` as one possible adapter implementation rather than the interface itself.

## Detailed Findings

### 1. Current storage architecture — a single-boundary S3 wrapper

> **Ease of abstraction:** Very easy. The expensive part of an abstraction refactor — finding and rerouting scattered direct-SDK call sites — is already done: `AgentS3Client` is the *only* file importing `@aws-sdk`, and every consumer goes through `ctx.s3`. A second working implementation of the surface already exists — `MockS3Client` (`packages/core/src/test-utils.ts:50`) — though it currently **duck-types** the surface and is wired into `OpContext` via an `as any` cast (`test-utils.ts:225`), as there is **no shared interface yet**. So extracting a real `StorageAdapter` interface is near-mechanical (and would also remove that cast, surfacing any latent Mock-vs-real drift the cast hides); the substantive work is the *semantic* gap (versioning on non-S3 backends), not the plumbing.

All S3 access is funneled through one concrete class with no abstract interface and no leakage:

- **The wrapper**: `export class AgentS3Client` — `packages/core/src/s3/client.ts:51`. It owns the only imports of `@aws-sdk/client-s3` (`client.ts:1-12`) and `@aws-sdk/s3-request-presigner` (`client.ts:13`).
- **Construction**: builds **two** `S3Client` instances — `this.client` against `config.endpoint` (`client.ts:63-68`) and `this.presignClient` against `config.publicEndpoint ?? config.endpoint` (`client.ts:69-74`), both with `forcePathStyle: true` hardcoded (`client.ts:67`, `:73`).
- **The seam**: `OpContext` carries `s3: AgentS3Client` (`packages/core/src/ops/types.ts:5-13`). Every op receives `ctx` and calls `ctx.s3.*`. No op imports the AWS SDK.
- **Single construction site**: `const s3 = new AgentS3Client(config.s3)` — `packages/server/src/index.ts:13`. This `s3` is threaded into HTTP routes, IPC handlers (FUSE), and the MCP server via `createApp` (`packages/server/src/app.ts:18-77`).
- **Already mocked**: `MockS3Client` (`packages/core/src/test-utils.ts:50`) is a second working implementation of the surface for unit tests — wired into `OpContext` via an `as any` cast (`test-utils.ts:225`), since there is no shared interface yet (the conformance is structural/duck-typed, not typechecked).
- **Other touch points** (none import the SDK; all use the wrapper type): `packages/cli/src/commands/config-cmd.ts:85-87` (constructs `new AgentS3Client(config.s3)` purely for a `config validate` connectivity check), `packages/mcp/src/server.ts` (types `s3: AgentS3Client` in its context), `packages/server/src/ipc/handlers.ts:30-42`, `routes/ops.ts`, `routes/files.ts`.

**The full method surface that any replacement adapter must satisfy** (`packages/core/src/s3/client.ts`):

| Method | Lines | Returns | Underlying S3 |
|--------|-------|---------|---------------|
| `putObject(key, body, metadata?, contentType?)` | `:78-97` | `{ etag?, versionId? }` | `PutObjectCommand` |
| `getObject(key, versionId?, { abortSignal? })` | `:99-120` | `{ body: Uint8Array, contentType?, size?, versionId?, etag? }` | `GetObjectCommand` |
| `deleteObject(key)` | `:122-129` | `void` | `DeleteObjectCommand` |
| `copyObject(fromKey, toKey)` | `:131-143` | `{ etag?, versionId? }` | `CopyObjectCommand` |
| `listObjects(prefix, { delimiter? })` | `:145-165` | `{ objects: S3Object[], prefixes: string[] }` | `ListObjectsV2Command` |
| `headObject(key)` | `:167-181` | `{ contentType?, size, lastModified?, etag?, versionId? }` | `HeadObjectCommand` |
| `listObjectVersions(key)` | `:183-198` | `S3ObjectVersion[]` | `ListObjectVersionsCommand` |
| `checkVersioningEnabled()` | `:200-209` | `boolean` | `GetBucketVersioningCommand` |
| `enableVersioning()` | `:211-224` | `boolean` | `PutBucketVersioningCommand` |
| `getPresignedUrl(key, expiresIn=86400, responseContentType?)` | `:226-238` | `string` | `GetObjectCommand` + `getSignedUrl` |

Plus a public `versioningEnabled: boolean` field set from config at construction (`client.ts:55`, `:75`). There is **no multipart upload** anywhere — every put sends the whole body in one `PutObjectCommand` (`client.ts:78-97`).

### 2. The storage backend contract (what an adapter actually has to provide)

The object store is a **flat key/value blob store**. Keys are derived purely from path, not content:

- **Key derivation**: `getS3Key(orgId, driveId, path)` → `` `${orgId}/drives/${driveId}/${normalized}` `` (`packages/core/src/ops/versioning.ts:11-14`). Called per-op. Multi-tenancy = key prefixing; there is **one bucket** for all orgs/drives.
- **Content hashing is app-side, not key-level**: SHA-256 via `node:crypto` (`packages/core/src/ops/write.ts:75-77`), stored in `file_versions.content_hash`, used only for the dedup short-circuit (`write.ts:80-102`) — not for addressing.
- **Buffered, whole-object I/O**: `getObject` materializes the whole object via `result.Body!.transformToByteArray()` (`client.ts:112`); reads return bytes, not a redirect. No range reads, no streaming, no multipart in current code.
- **`edit`/`append` are read-modify-write of the entire object** (`packages/core/src/ops/edit.ts:13-99`, `append.ts:13-69`) — no partial/range writes.

**S3-specific dependencies the code actually relies on** (the migration-critical list):

1. **Per-object versioned reads** — `getObject(key, versionId)` passes `VersionId` (`client.ts:108`); used by `revert` (`packages/core/src/ops/revert.ts:54`) and historical `diff` (`packages/core/src/ops/diff.ts:49-52`). `revert` throws `VERSIONING_REQUIRED` if the target row's `s3VersionId` is empty (`revert.ts:44-50`). **This is the single hard S3-semantic dependency.**
2. **`VersionId` returned from writes** — `putObject`/`copyObject` surface `result.VersionId` (`client.ts:95`, `:141`), persisted to `file_versions.s3_version_id`.
3. **Prefix + `/` delimiter listing** — `ls` calls `listObjects(prefix, { delimiter: "/" })` and consumes `CommonPrefixes` as directories + `Contents` as files (`ls.ts:15`, `client.ts:145-165`); `glob` uses prefix listing too (`glob.ts:55`).
4. **Presigned GET URLs** with `expiresIn` + optional `ResponseContentType` override (`client.ts:226-238`), minted against a **separate public endpoint** (`presignClient`, `client.ts:69-74`).
5. **Bucket-versioning enable/check** (`GetBucketVersioning`/`PutBucketVersioning`, `client.ts:200-224`) — only called from tests, not the production daemon startup.
6. **Delete markers** — `rm` relies on S3 delete-marker semantics when versioning is on (`rm.ts:23-24`); prior versions stay retrievable by `s3VersionId`.
7. **S3 error-shape coupling** — ops branch on `err?.name === "NoSuchKey" | "NotFound"` and `err?.$metadata?.httpStatusCode === 404` to map to `NotFoundError` (`cat.ts:45`, `stat.ts:18`, `append.ts:30`, `edit.ts:31`, `signed-url.ts:31`, `routes/files.ts:77`). An adapter must reproduce or translate these.
8. **`forcePathStyle: true`** on both clients (`client.ts:67`, `:73`) — required for MinIO/S3-compatible.
9. **No conditional/ETag writes** — optimistic concurrency is enforced in **SQLite** via `assertExpectedVersion` (`versioning.ts:92-109`), not S3 `If-Match`. ETags are stored but never used as preconditions.

**What is NOT S3's job** (all SQLite): version numbering (`getNextVersion`, `versioning.ts:19-35`), history listing (`log.ts:11-22`), head/version lookups, dedup, optimistic concurrency, FTS5 search, embeddings/vectors, comments.

### 3. Versioning model — dual-layer (SQLite + optional S3 object versioning)

This is the heart of why the backend choice matters:

- **App-level (always on)**: every mutating op calls `createVersion` (`versioning.ts:152-258`), which assigns a monotonic per-`(path, driveId)` integer `version`, writes a `file_versions` row, and upserts the `files` current-state row — all inside one `ctx.db.transaction` (`versioning.ts:172`). Atomicity/concurrency comes from the SQLite unique index `(path, drive_id, version)` (`db/raw.ts:70-72`), mapped to `EditConflictError` on violation (`versioning.ts:236-255`).
- **S3-level (optional)**: when bucket versioning is enabled, writes return distinct S3 version IDs captured into `file_versions.s3_version_id`. This is what makes **old-version content** retrievable:
  - `revert` (`revert.ts:14-77`): `getObject(key, s3VersionId)` to fetch old bytes → re-PUT as a new head → new `"revert"` version. **Forward-moving, not an S3 rollback.** Hard-fails without `s3VersionId`.
  - `diff` (`diff.ts:8-94`): fetches both versions' bytes by `s3VersionId` in parallel; **falls back to a stored `diffSummary` JSON** when version IDs are absent or fetch fails (`diff.ts:81-91`).
- History (`log`) never touches S3 — it reads `file_versions` ordered by `version DESC` (`log.ts:11-22`).

**Implication**: with a backend that lacks version-id reads, `log` and forward history still work; `revert` and historical `diff` of binary content break unless emulated. `diff` degrades gracefully (diffSummary); `revert` does not (hard error).

### 4. Configuration & credentials flow

- **Schema**: `AgentFSConfig.s3` (`packages/core/src/config.ts:13-23`) = `{ provider, bucket, region, endpoint, publicEndpoint?, accessKeyId, secretAccessKey, versioningEnabled? }`. `forcePathStyle` is **not** configurable — hardcoded in the client.
- **Defaults (local MinIO)**: `DEFAULT_CONFIG.s3` = provider `minio`, bucket `agentfs`, region `us-east-1`, endpoint `http://localhost:9000`, empty creds (`config.ts:53-61`).
- **Resolution**: `getConfig()` (`config.ts:173-185`) reads `~/.agent-fs/config.json` (or `AGENT_FS_HOME`), deep-merges over defaults, then applies env overrides.
- **Env overrides** (`applyEnvOverrides`, `config.ts:132-147`), `AWS_*` taking precedence over `S3_*` (for Tigris): `AWS_ENDPOINT_URL_S3`/`S3_ENDPOINT`, `AWS_ACCESS_KEY_ID`/`S3_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`/`S3_SECRET_ACCESS_KEY`, `BUCKET_NAME`/`S3_BUCKET`, `AWS_REGION`/`S3_REGION`, `S3_PROVIDER`, `S3_PUBLIC_ENDPOINT`.
- **Storage is a global singleton** — there are **no per-org/per-drive storage columns** anywhere in the schema (the `orgs` and `drives` tables carry only id/name/flags; `db/schema.ts:18-25`, `:45-55`). The only S3-related column in the whole DB is `file_versions.s3_version_id`. A backend is therefore a process-wide singleton, not a per-tenant object.
- **Local vs hosted is config-only, one code path**: local = `onboard --local` spins up MinIO (`docker run --name agent-fs-minio …`, `onboard.ts:207-228`) and writes minioadmin creds (`onboard.ts:245-250`); hosted = external S3 via env or mounted `config.json` (`docker-compose.hosted.yml`, with a commented R2 example). Both funnel through the identical `getConfig().s3` → `new AgentS3Client(config.s3)` path.
- **CLI is a thin HTTP client** to the daemon/hosted API (`api-client.ts:7-17`); it does not do object I/O itself except the `config validate` connectivity check.

### 5. Database schema (storage-relevant columns)

Authoritative DDL is `CREATE_TABLES_SQL` in `packages/core/src/db/raw.ts:4-123` (run on every init via `db/index.ts:39`); the Drizzle TS mirror is `db/schema.ts`.

- **`files`** (`raw.ts:41-53`): `path, drive_id, size, content_type, author, current_version_id, created_at, modified_at, is_deleted, embedding_status`; PK `(path, drive_id)`. No blob column — content lives in the object store. Files are **soft-deleted** (`is_deleted`).
- **`file_versions`** (`raw.ts:55-72`): `id, path, drive_id, version, s3_version_id, author, operation('write'|'edit'|'append'|'delete'|'revert'), message, diff_summary, size, etag, content_hash, created_at`; unique index `(path, drive_id, version)`. **The object key is NOT stored** — recomputed deterministically from `orgId/driveId/path`.
- Search/embeddings: `content_chunks` (`raw.ts:114-122`), FTS5 `files_fts` + sqlite-vec `chunk_vectors` (`raw.ts:125-136`).

### 6. files-sdk.dev capability report (verified against the official site + README)

**Identity** — npm package `files-sdk` (unscoped), **v2.0.0**, by **Hayden Bleasel** (`github.com/haydenbleasel/files-sdk`), site `files-sdk.dev`. Self-described: "A unified storage SDK for object and blob backends. One small, honest API. Web-standards I/O. An escape hatch when you need the native client." **Distinct** from `@flystorage/*` (Frank de Jonge), `flydrive` (Adonis), and files.com's commercial SDK (naming collision only).

**Core abstraction** — a `Files` instance constructed with an injected adapter:
```ts
import { Files } from "files-sdk";
import { s3 } from "files-sdk/s3";
const files = new Files({ adapter: s3({ bucket: "uploads", region: "us-east-1" }) });
```
Adapters are **subpath exports of the same package** (`files-sdk/s3`, `files-sdk/r2`, `files-sdk/gcs`, `files-sdk/azure`, `files-sdk/vercel-blob`, `files-sdk/netlify-blobs`, `files-sdk/local`, …). Each provider's native SDK is an **optional peer dependency** (S3 needs `@aws-sdk/client-s3 @aws-sdk/s3-presigned-post @aws-sdk/s3-request-presigner`). "30+ adapters" advertised; S3-compatible explicitly covers **R2, MinIO, DigitalOcean Spaces, Backblaze B2, Wasabi**.

**Unified API** (the complete method list): `upload`, `download`, `head`, `exists`, `delete`, `copy`, `move`, `list`/`listAll`, `url`, `signedUploadUrl`, plus `file(key)` for a key-scoped handle. Notable behaviors:
- **`upload(key, body, { contentType, multipart? })`** — body is `Blob | File | ReadableStream | Uint8Array | ArrayBuffer | string`. Multipart via `{ multipart: true }` or `{ multipart: { partSize, concurrency } }`.
- **`download(key, { range?, as? })`** — web-standard `Blob`/`ReadableStream`; **byte-range reads** map to HTTP 206 (`{ range: { start, end }, as: "stream" }`).
- **`head(key)`** → `{ size, contentType, lastModified, etag }`.
- **`exists(key)`** → `false` only on provider `NotFound`; auth/transport failures still throw.
- **`url(key, { expiresIn })`** → presigned/temporary GET URL.
- **`signedUploadUrl(key, { maxSize? })`** → presigned PUT (or presigned POST with a `content-length-range` policy when `maxSize` is set).
- **`list`/`listAll({ prefix })`** → lazy async iterable of `{ key, size, … }`.
- **`files.raw`** → the native underlying client (the configured `S3Client`) for anything provider-specific.
- **Lifecycle hooks** at the constructor: `onAction`, `onRetry`, `onError`.
- **Error model**: provider errors classified into canonical `NotFound`, `Unauthorized`, `Conflict`, `Provider`.

**Runtime** — TypeScript-native, ESM, tree-shakeable (`sideEffects: false`); the test suite runs under `bun test` (strong Bun signal). S3 path is pure JS via `@aws-sdk/*`, which runs under Bun. (CJS presence unconfirmed — irrelevant for agent-fs's ESM/Bun runtime.)

**Gaps relevant to a versioned filesystem** (deliberately pushed to `.raw`):
1. **Object versioning** — no `listVersions`, no version-id-aware `download`/`delete` in the unified API. S3 versioning is explicitly a `.raw` concern.
2. **Conditional/ETag writes** — no `upload(..., { ifMatch })` primitive. (agent-fs doesn't need this — concurrency is in SQLite.)
3. **Arbitrary object metadata** (`x-amz-meta-*`) — not first-class (agent-fs already passes `metadata: undefined`, so no loss).
4. **Delimiter/`CommonPrefixes` directory listing** — the unified `list({ prefix })` returns a flat key iterable; the `/`-delimiter "folders" semantic `ls` relies on is not obviously surfaced (needs verification / `.raw` / client-side prefix derivation).
5. **Response-content-type override on presigned GET** — `url({ expiresIn })` shown without a `responseContentType` param (agent-fs currently sets it; may need `.raw` or may be unnecessary since content-type is stored on the object).
6. **Single client per `Files` instance** — agent-fs's two-endpoint split (internal vs `publicEndpoint` presign) would need two `Files` instances or a `.raw` presigner.
7. Young, single-maintainer project (weigh for production).

### 7. Integration surface — mapping current ops onto a multi-adapter layer

The change has three structural pieces and one semantic decision.

**Structural piece A — extract an interface.** Promote `AgentS3Client`'s 10-method surface (§1 table) into a `StorageAdapter` interface in `packages/core/src/s3/` (or a renamed `packages/core/src/storage/`). `OpContext.s3` becomes `OpContext.storage: StorageAdapter` (or keep the name `s3` to minimize churn). `MockS3Client` already conforms (`test-utils.ts`).

**Structural piece B — write adapters.** Each adapter implements the interface. Mapping current methods → `files-sdk`:

| `AgentS3Client` method | `files-sdk` unified equivalent | Gap / `.raw` needed? |
|---|---|---|
| `putObject(key, body, _, contentType)` | `files.upload(key, body, { contentType })` | clean |
| `getObject(key)` (no version) | `files.download(key)` → bytes | clean (consume Blob→Uint8Array) |
| `getObject(key, versionId)` | — | **`.raw` `GetObjectCommand` with `VersionId`** (revert/diff) |
| `deleteObject(key)` | `files.delete(key)` | clean |
| `copyObject(from, to)` | `files.copy(from, to)` | clean (versionId return via `.raw` if needed) |
| `listObjects(prefix, {delimiter})` | `files.list({ prefix })` | **delimiter/CommonPrefixes via `.raw` or client-side** |
| `headObject(key)` | `files.head(key)` | clean |
| `listObjectVersions(key)` | — | `.raw` (currently unused by ops) |
| `checkVersioningEnabled`/`enableVersioning` | — | `.raw` bucket-versioning commands |
| `getPresignedUrl(key, expiresIn, respCT?)` | `files.url(key, { expiresIn })` | response-content-type + public-endpoint split may need `.raw`/2nd instance |

**Structural piece C — choose the adapter at startup.** Add a `provider`/`adapter` discriminator to `AgentFSConfig.s3` (the field `provider` already exists, currently informational). At `packages/server/src/index.ts:13`, switch on it to construct the right adapter. Config schema (`config.ts:13-23`) gains adapter-specific shapes (e.g. GCS keyfile, Azure connection string) — likely a tagged union. `forcePathStyle` would move from hardcoded into S3-adapter config.

**Semantic decision (the part that needs a human call):** the version-critical paths (`revert`, historical `diff`) require version-id reads that no unified abstraction (`files-sdk` or flystorage) models. Two shapes:
- **(i) `files-sdk` as the interface** — adapters wrap `Files`, drop to `files.raw` for versioned reads, delimiter listing, and bucket versioning. Pro: get 30+ backends, multipart, range reads, hooks "for free." Con: the version-critical S3 paths bypass the abstraction anyway, and non-S3 adapters (GCS/Azure/local) would need their *own* versioning emulation (e.g. copy-on-write version keys) since S3 object-versionId semantics don't port.
- **(ii) agent-fs owns a thin `StorageAdapter` interface** — write adapters directly (S3 via `@aws-sdk` or `Bun.s3`; GCS; local FS), each free to implement versioned reads however its backend allows. `files-sdk` could be *one* adapter implementation. Pro: full control of the version contract; Con: more code, lose `files-sdk`'s breadth.
- A hybrid is viable: keep the existing `AgentS3Client` as the S3 adapter (zero risk to the working S3 path), add a `files-sdk`-backed adapter for *new* backends where app-level versioning (copy-on-write to distinct keys, tracked in SQLite) replaces S3 object versioning.

A genuinely portable versioning model would shift old-version retrieval off S3 object-versionId entirely — e.g. store each version under its own content-addressed key (`…/path/@v{n}` or `…/sha256/{hash}`) tracked by the existing `file_versions` table — making *every* backend (including plain local FS) capable of revert/diff without provider versioning. That is the largest design lever and the main thing a plan should decide.

## Code References

| File | Line | Description |
|------|------|-------------|
| `packages/core/src/s3/client.ts` | 51 | `AgentS3Client` — the single storage boundary; only AWS SDK importer |
| `packages/core/src/s3/client.ts` | 63-74 | Dual client construction (internal `client` + `presignClient` on `publicEndpoint`), `forcePathStyle: true` |
| `packages/core/src/s3/client.ts` | 78-238 | All 10 storage methods (put/get/delete/copy/list/head/listVersions/check+enable versioning/presign) |
| `packages/core/src/s3/client.ts` | 99-120 | `getObject(key, versionId?)` — version-id read path |
| `packages/core/src/ops/types.ts` | 5-13 | `OpContext` carrying `s3: AgentS3Client` — the injection seam |
| `packages/core/src/ops/versioning.ts` | 11-14 | `getS3Key` key format `<orgId>/drives/<driveId>/<path>` |
| `packages/core/src/ops/versioning.ts` | 152-258 | `createVersion` — SQLite version row + files upsert in one transaction |
| `packages/core/src/ops/versioning.ts` | 92-109 | `assertExpectedVersion` — optimistic concurrency in SQLite (not S3) |
| `packages/core/src/ops/write.ts` | 55-128 | `writeInternal` — hash, dedup short-circuit, `putObject`, `createVersion`, index |
| `packages/core/src/ops/revert.ts` | 44-77 | Hard `VERSIONING_REQUIRED`; `getObject(key, s3VersionId)` → re-PUT |
| `packages/core/src/ops/diff.ts` | 49-91 | Parallel version-id reads, `diffSummary` fallback |
| `packages/core/src/ops/ls.ts` | 15 | `listObjects(prefix, { delimiter: "/" })` directory listing |
| `packages/core/src/ops/signed-url.ts` | 19-52 | Presigned URL op (head-check + `getPresignedUrl`) |
| `packages/core/src/config.ts` | 13-23 | `AgentFSConfig.s3` schema |
| `packages/core/src/config.ts` | 132-147 | `applyEnvOverrides` — `AWS_*`/`S3_*` precedence |
| `packages/core/src/db/raw.ts` | 41-72 | `files` + `file_versions` DDL (storage-relevant columns) |
| `packages/server/src/index.ts` | 13 | `new AgentS3Client(config.s3)` — the single construction site to swap |
| `packages/server/src/app.ts` | 18-77 | Threads `s3` into routes / IPC / MCP |
| `packages/core/src/test-utils.ts` | — | `MockS3Client` already implements the interface shape |
| `packages/cli/src/commands/onboard.ts` | 207-250 | MinIO container setup + S3 config write |
| `docker-compose.hosted.yml` | 1-19 | Hosted/external-S3 wiring (R2 example) |

## Decisions (ironed out 2026-06-25)

Resolved with Taras via AskUserQuestion. These settle the central forks; the residual items move to *Verification for the plan* below.

- **Goal & guiding value** — adopt a multi-adapter storage layer to get *automatic* support for a broad set of backends (S3/MinIO, local filesystem, and consumer providers like Dropbox / Google Drive) via `files-sdk`. Some backends will be feature-limited, and that is acceptable: the durable value — file **comments** and **search** — lives in SQLite and works on every backend regardless of object-store capabilities.
- **Architecture — internal interface, keep `AgentS3Client`.** agent-fs owns a thin `StorageAdapter` interface (extracted from the current `AgentS3Client` surface, §1 table). The existing `AgentS3Client` stays as the full-featured **S3/MinIO** adapter (native versioning, dual internal-vs-public presign endpoint). A separate **`files-sdk`-backed adapter** supplies the breadth (local + consumer providers). This insulates agent-fs from churn in `files-sdk` (young, single-maintainer dep) and keeps **near-zero risk on the proven S3 path** (`AgentS3Client`'s behavior is unchanged; it only gains an `implements StorageAdapter` declaration). `files-sdk` is an *adapter implementation behind our interface*, not the interface itself.
- **Versioning — per-backend, native where possible.** Three tiers:
  1. **S3/MinIO (full):** keep native S3 object versioning for `revert` / historical `diff` (unchanged).
  2. **Local filesystem (full):** implement an app-level version-key scheme — each version's bytes stored under its own key (tracked by the existing `file_versions` table) — so `revert` / `diff` work without object versioning. This uses the plain `upload`/`download` surface (distinct keys), **not** the `.raw` escape hatch.
  3. **Other adapters (basic):** `revert` and historical-*content* `diff` are **unsupported**; `diff` still degrades to the stored `diffSummary`, and forward history (`log`) still works since it's SQLite-only.
- **Limited-op behavior — typed `unsupported` error + capability metadata.** Ops a backend can't satisfy throw a typed `UnsupportedOperation`, surfaced cleanly in CLI/MCP. Each adapter advertises **capability metadata** (e.g. `{ versioning: false }`) so callers / the UI can check support up front instead of failing blindly.

## Open Questions / Verification for the plan

Technical items to confirm during planning/implementation (not blocking decisions):

- **`StorageAdapter` interface shape** — finalize the method set extracted from `AgentS3Client` (§1 table) and where capability metadata lives. `revert` / `diff` / `ls` are the ops whose contracts must accommodate "unsupported" + non-S3 versioning. `file_versions.s3_version_id` becomes an **opaque per-adapter version handle**, not S3-specific.
- **Local-FS versioning mechanism** — exact key scheme for per-version content on local (e.g. `<key>/.versions/v{n}` vs content-addressed `sha256/{hash}`) and how `revert`/`diff` resolve it.
- **Delimiter directory listing** — confirm whether `files-sdk` `list({ prefix })` returns `/`-delimited common prefixes (folders) for `ls`, or whether the adapter derives them client-side / via `.raw`. (Not confirmed from the docs read.)
- **Presigned GET nuances** — confirm `files-sdk` `url({ expiresIn })` can express a `responseContentType`-equivalent, and how to replicate the internal-vs-public presign endpoint split for non-S3 adapters (likely native to each provider's URL semantics).
- **Per-backend config schema** — evolve `AgentFSConfig.s3` into a tagged union keyed by `provider`/adapter (S3 knobs incl. `forcePathStyle`/`publicEndpoint`, R2 `accountId`, GCS keyfile, Azure connection string, local path, OAuth tokens for Dropbox/GDrive). Adapter selection happens at `packages/server/src/index.ts:13`.
- **FUSE/raw-write path** (`routes/files.ts`, `writeRaw`) — whether to adopt `files-sdk` multipart/streaming for large binary uploads (currently fully buffered, 50 MB cap) — an independent improvement.
- **Bun + `files-sdk` live check** — verify a live `files-sdk` `s3()` / local adapter under Bun (against the MinIO container for S3) before committing.
- **Presigned URLs are themselves a per-backend capability** — local FS and some consumer providers have no presigned-URL concept, so `signed-url` joins `revert`/`diff` as a capability-gated op (not just a "nuance"). agent-fs already has a byte-serving fallback: the daemon's `GET …/raw` route (`packages/server/src/routes/files.ts`) + the in-app viewer `buildAppUrl` (`packages/core/src/ops/urls.ts:1-9`). Decide whether limited backends return `UnsupportedOperation` for `signed-url` or transparently fall back to the daemon route.
- **Cross-store consistency / atomicity** — the write path does `putObject` then `createVersion` (a SQLite transaction) as two non-atomic steps (`packages/core/src/ops/write.ts`). On remote/consumer backends (network failures, eventual consistency) the partial-failure window (object written but DB row not, or vice versa) is wider than on S3/local. Decide on ordering + a reconciliation/retry strategy (e.g. object-then-commit + orphan cleanup), or accept best-effort for limited backends.
- **Auth for consumer providers** — Dropbox / Google Drive need OAuth token storage + refresh; likely out of scope for the first cut, but flag the surface (new config + per-drive credential storage).

## Appendix

- **Architecture notes**:
  - The storage layer is already a clean single-boundary adapter (`AgentS3Client` + `ctx.s3`), with a conforming mock. This is the ideal precondition for multi-adapter support — the refactor is interface-extraction + a construction-site switch, not a scattered rewrite.
  - agent-fs deliberately keeps almost all "filesystem" semantics in SQLite (version numbering, dedup, concurrency, metadata, search), treating the object store as a dumb keyed blob store. The one leak is S3 **object versioning** for old-content retrieval (revert/diff).
  - Multi-tenancy is by key prefix in a single bucket; there is no per-org/per-drive backend concept today. Per-tenant backends would be a separate, larger feature (new DB columns + per-request adapter resolution).
  - **Release-checklist reminder for any eventual plan** (from project `CLAUDE.md`): core/CLI/MCP changes require updating `skills/agent-fs/SKILL.md`, bumping `.claude-plugin/plugin.json` and root `package.json`, and extending `scripts/e2e.ts`. A storage-adapter change touches core ops semantics, so E2E coverage (incl. a non-S3 adapter and revert/diff under each backend) is in scope.
- **files-sdk source**: site `https://files-sdk.dev/`, repo `https://github.com/haydenbleasel/files-sdk` (README at `packages/files-sdk/README.md`), npm `files-sdk` v2.0.0. Verified directly this session (the unified method list, MinIO/S3-compatible support, presigned GET/PUT, range reads, multipart, Bun test suite, and that versioning is a `.raw`-only concern).
- **Permalink base** (this commit): `https://github.com/desplega-ai/agent-fs/blob/028667b60761aed5586b0bdca0407f69ae944ab2/<path>#L<line>`.
- **Related research**: none found in `thoughts/taras/research/` on storage adapters prior to this document.

## Review Errata

_Reviewed: 2026-06-25 by Claude (structured review, auto-apply mode)_

### Applied (auto-fixed)
- [x] **File:line accuracy verified** — two mapping sub-agents had reported conflicting line numbers for `s3/client.ts` (`:48-65` vs `:78-97` for `putObject`, etc.). Read `client.ts` directly and confirmed the doc uses the **correct** set (`putObject:78-97` … `getPresignedUrl:226-238`, class `:51`, construction `:63-74`). Spot-checked `versioning.ts:11`, `write.ts:75`, `revert.ts:46/54`, `ops/types.ts:5-7`, `server/index.ts:13`, `config.ts:136-147`, `db/raw.ts:41/55/71`, `ops/ls.ts:15-16` — all accurate. No reference changes needed.
- [x] **`MockS3Client` claim corrected (Important)** — it is a *duck-typed* second implementation wired in via an `as any` cast (`test-utils.ts:225`), not a typechecked interface implementation. Tempered the "already a conforming implementation" phrasing in §1 and the Summary's implication; the "ease" argument still holds (extracting the interface also removes the cast).
- [x] **`signed-url` added as a capability-gated op (Important)** — presigned URLs are themselves backend-specific (no concept on local FS / some providers); added to the verification list with the existing `/raw` + `buildAppUrl` fallback noted.
- [x] **Cross-store atomicity gap added (Important)** — `putObject` + `createVersion` are non-atomic; partial-failure window widens on remote/consumer backends. Added as a verification item.
- [x] **"zero risk" → "near-zero risk" (Minor)** — `AgentS3Client` gains an `implements StorageAdapter` declaration, so the path isn't literally untouched.
- [x] **Local-FS versioning wording (Minor)** — clarified it uses the plain `upload`/`download` surface with distinct keys, not the `.raw` escape hatch.

### Notes (no change required)
- **Genre**: at Taras's request (review comment), this document now carries a forward-looking *Decisions* section alongside the as-is research — a deliberate deviation from pure "document what IS." Captured here for transparency.
- **Unverified-but-disclosed**: the `files-sdk` delimiter-listing and presigned-`responseContentType` behaviors remain flagged in the verification list (could not be confirmed from the docs read); these are plan-phase checks, not doc defects.

### Remaining
- None. No Critical findings.

---
date: 2026-05-15
author: Claude (bg research)
topic: "Current write path in agent-fs (codebase trace)"
tags: [research, agent-fs, codebase, write-path]
parent_brainstorm: thoughts/taras/brainstorms/2026-05-15-agent-fs-as-linux-filesystem.md
status: complete
---

# Research: Current write path in agent-fs (codebase trace)

## Summary

agent-fs has **no dedicated file-upload route**. All writes flow through one generic JSON op endpoint (`POST /orgs/:orgId/ops` with `{op:"write", path, content, expectedVersion?, ...}`). Content is buffered into memory as a UTF-8 string (10 MB cap). The op dispatcher resolves drive context via API-key → user → drive RBAC, calls `s3.putObject` (an unconditional S3 `PutObject` — no `If-Match`/`If-None-Match`), then writes a `file_versions` row with a monotonically incremented integer `version` (no `parent_version_id`, no `content_hash` column), upserts the `files` row, runs FTS5 indexing synchronously, and fires-and-forgets embeddings on an in-process semaphore. **Optimistic concurrency exists already** via `expectedVersion` in `write` op (`packages/core/src/ops/write.ts:29-41`) — it's a check against the next-version computation, not an S3 precondition. No SSE/WebSocket push channel; the `events` table is wired for comments only. A default-drive concept exists (`drives.isDefault` + `resolveContext` fallback chain). The read path returns version metadata only via `stat` op (`currentVersion: number`) or `/files/.../raw` (no version header); `head_version_id` at `open()` time would need a separate `stat`/`log` call.

## Numbered findings

### 1. Upload entry point(s)

- **No PUT endpoint.** The only file-mutating HTTP route is the generic ops endpoint at `packages/server/src/routes/ops.ts:9`:
  ```ts
  router.post("/:orgId/ops", async (c) => {
    const body = await c.req.json();
    const { op, ...params } = body;
    ...
    const result = await dispatchOp(ctx, op, params);
  ```
- Mounted in `packages/server/src/app.ts:72` as `app.route("/orgs", opsRoutes(db, s3, embeddingProvider, config.appUrl))`.
- **Buffered, not streamed.** Body parsed via `c.req.json()` (whole JSON body in memory). Hono `bodyLimit` middleware caps request bodies at 50 MB (`packages/server/src/app.ts:30`); inside the `write` op a stricter **10 MB content limit** is enforced (`packages/core/src/ops/write.ts:10,21-26`). Content is a JSON-string field, so binary uploads aren't supported through this path.
- The CLI `ApiClient` always sets `Content-Type: application/json` and `JSON.stringify`s the body (`packages/cli/src/api-client.ts:24,57`), confirming buffered upload model.
- A read-only raw byte route exists for downloads: `GET /orgs/:orgId/drives/:driveId/files/*/raw` (`packages/server/src/routes/files.ts:12-50`). It does **not** accept PUT.

### 2. Version creation

- Created by `createVersion()` in `packages/core/src/ops/versioning.ts:39-115`. Called from `write` (`packages/core/src/ops/write.ts:48-56`), `edit` (`packages/core/src/ops/edit.ts:64-73`), `append` (`packages/core/src/ops/append.ts:36-44`), and similar for `mv`/`cp`/`revert`/`rm`.
- Insert into `file_versions` (`packages/core/src/ops/versioning.ts:56-68`) sets:
  - `path`, `driveId`, `version` (next integer from `getNextVersion()` at `packages/core/src/ops/versioning.ts:18-34` — `SELECT MAX(version) + 1` per `(path, driveId)`)
  - `s3VersionId` (string from S3 PUT response, `""` if bucket versioning is disabled)
  - `author: ctx.userId`
  - `operation: "write" | "edit" | "append" | "delete" | "revert"`
  - `message?`, `diffSummary?`, `size?`, `etag?`, `createdAt`
- **No `parent_version_id` column.** Lineage is implicit via `(path, driveId, version-1)`. Schema at `packages/core/src/db/schema.ts:102-117`.
- **No `content_hash` column.** Confirmed via grep — only `content_chunks` (embedding chunks) and `api_key_hash` columns exist. Close-time content-hash dedup would be **new behavior**.
- File metadata upsert immediately follows (`packages/core/src/ops/versioning.ts:71-112`): `files.currentVersionId = String(version)`, `modifiedAt = now`, `author = ctx.userId`. The `currentVersionId` column is `TEXT` (`packages/core/src/db/schema.ts:84`) but stores stringified integers (`packages/core/src/ops/versioning.ts:89,107`).

### 3. S3 PUT

- Implementation: `AgentS3Client.putObject` in `packages/core/src/s3/client.ts:78-97`:
  ```ts
  const result = await this.client.send(
    new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: typeof body === "string" ? Buffer.from(body) : body,
      Metadata: metadata,
      ...(contentType && { ContentType: contentType }),
    })
  );
  return { etag: result.ETag, versionId: result.VersionId };
  ```
- **No `IfMatch`/`IfNoneMatch` passed.** The wrapper does not surface those options. The underlying AWS SDK `PutObjectCommand` accepts them, but agent-fs does not.
- Returned `etag` and `versionId` are stored on the `file_versions` row (`packages/core/src/ops/write.ts:50,54`) but not used to gate subsequent writes. No code path expresses "only write if head version is still X" at the S3 layer.
- S3 key shape: `<orgId>/drives/<driveId>/<path>` (`packages/core/src/ops/versioning.ts:10-13`).
- Bucket-versioning toggle lives in `AgentS3Client.versioningEnabled` / `checkVersioningEnabled` / `enableVersioning` (`packages/core/src/s3/client.ts:55,195-219`) — orthogonal to per-write conditionals.

### 4. Embedding + index trigger

- Triggered **inside each mutating op** after `createVersion`, never from the daemon/route:
  - `write` (`packages/core/src/ops/write.ts:58-66`)
  - `edit` (`packages/core/src/ops/edit.ts:75-83`)
  - `append` (`packages/core/src/ops/append.ts:46-54`)
  - `cp` also calls `scheduleEmbedding`.
- **FTS5 index — synchronous.** `indexFile(ctx.db, {path, driveId, content})` deletes + re-inserts the row in the `files_fts` virtual table (`packages/core/src/search/fts.ts:8-23`). Runs on the same async path, awaited before the op returns.
- **Embeddings — asynchronous, fire-and-forget.** `scheduleEmbedding(db, provider, {...})` (`packages/core/src/search/pipeline.ts:149-176`):
  1. Synchronously sets `files.embeddingStatus = 'pending'`.
  2. Acquires one of two permits (`embeddingSemaphore = new Semaphore(2)` at `packages/core/src/search/pipeline.ts:42`).
  3. Calls `indexFileEmbeddings` which chunks content, calls `provider.embedBatch`, replaces `content_chunks` rows and `chunk_vectors` virtual-table rows, then sets `embeddingStatus = 'indexed'` (or `'failed'` on error). All in-process.
- **Tied to op invocation, not version creation per se** — but in practice the op call _is_ the trigger that produces a version, so the two are coincident. If no `EmbeddingProvider` is configured, `scheduleEmbedding` is a no-op (`packages/core/src/search/pipeline.ts:154`).

### 5. Author attribution

- Single mechanism: the API key. Auth middleware at `packages/server/src/middleware/auth.ts:8-45`:
  - Extracts `Authorization: Bearer <api_key>` (line 16-28).
  - Calls `getUserByApiKey(db, apiKey)` (line 29).
  - Sets `c.set("user", user)` (line 42) — that `user.id` is the only identity flowing downstream.
- API-key → user mapping in `packages/core/src/identity/users.ts:51-64`: `getUserByApiKey` SHA-256-hashes the key (`Bun.CryptoHasher("sha256")`, line 6-10) and looks up `users.apiKeyHash`. No separate "agent identity" or "machine user" concept — every API key belongs to one `users.id`.
- Routes pull `c.get("user")` and pass `userId: user.id` into `resolveContext` and the `OpContext` (`packages/server/src/routes/ops.ts:10,34`). `createVersion` writes that as `author` on both `file_versions.author` and `files.author` (`packages/core/src/ops/versioning.ts:62,88,106`).
- Local/embedded mode bootstraps a `local@agent-fs.local` user on first run (`packages/core/src/identity/bootstrap.ts:10-23`) and persists the generated API key to config.

### 6. Conditional-write / optimistic concurrency

- **Already exists, app-layer only.** `WriteParams.expectedVersion?: number` (`packages/core/src/ops/types.ts:21`) is validated by the `write` op handler at `packages/core/src/ops/write.ts:29-41`:
  ```ts
  if (params.expectedVersion !== undefined) {
    const nextVersion = await getNextVersion(ctx, params.path);
    const currentVersion = nextVersion - 1;
    if (currentVersion !== params.expectedVersion) {
      throw new EditConflictError(
        `Expected version ${params.expectedVersion} but file is at version ${currentVersion}`,
        ...
      );
    }
  }
  ```
- On mismatch: `EditConflictError` is thrown, mapped to HTTP 409 in `packages/server/src/middleware/error.ts:13`. Error JSON shape includes `error: "EDIT_CONFLICT"`, `message`, `suggestion`, `path` (`packages/core/src/errors.ts:59-73`).
- **Caveats vs FUSE's needs:**
  - Check is **TOCTOU** — `getNextVersion` runs, then `s3.putObject` runs, then `createVersion` runs. Two concurrent writers can both pass the check before either inserts. There's no `UNIQUE(path, drive_id, version)` constraint to backstop (only `id PRIMARY KEY AUTOINCREMENT` — see `packages/core/src/db/schema.ts:102-117`).
  - It compares against **`MAX(version)`** (a SQLite-computed integer), not the S3 `versionId` or ETag.
  - Only the `write` op honors `expectedVersion`. `edit`, `append`, `mv`, `cp`, `revert`, `rm` do **not**.
- **Smallest change to make it FUSE-safe:** route `expectedVersion` through `edit`/`append` etc. (one extra branch each, mirroring `write.ts:29-41`), and wrap the version-insert in a SQLite transaction / add `UNIQUE(path, drive_id, version)` to close the TOCTOU window. S3-layer `If-Match` is the deeper option (S3 PutObject supports `If-Match: <etag>` on newer providers; agent-fs's wrapper would need a new optional param at `packages/core/src/s3/client.ts:78`).

### 7. Read path

- **Two read surfaces:**
  - `cat` op (`packages/core/src/ops/cat.ts:7-41`) — returns `{content, totalLines, truncated}`. **No version id returned.**
  - `GET /orgs/:orgId/drives/:driveId/files/*/raw` (`packages/server/src/routes/files.ts:12-50`) — streams raw bytes via `s3.getObject`. Returns headers `Content-Type`, `Content-Length`, `Cache-Control: private, max-age=60`. **No `ETag`, no `x-agent-fs-version`, no S3 versionId leaked.**
- To learn `head_version_id` at `open()`, current options:
  - Call `stat` op (`packages/core/src/ops/stat.ts:7-51`) which returns `currentVersion?: number` (from `files.currentVersionId`). Costs a SQLite read + an S3 `HEAD` (line 16).
  - Or call `log` op with `limit:1` (`packages/core/src/ops/log.ts:5-35`) — SQLite-only, returns the top `file_versions` row.
- **The `/raw` GET does not carry the version inline.** Mount would need a separate `stat` round-trip per `open()` to capture head version. (Adding an `x-agent-fs-version` response header to `/raw` would be the smallest change.)

### 8. Drive listing

- **No "drives accessible to this API key" endpoint.** Listing is per-org:
  - `GET /orgs` returns orgs the user is a member of (`packages/server/src/routes/orgs.ts:22-26` → `listUserOrgs` at `packages/core/src/identity/orgs.ts:37-59`).
  - `GET /orgs/:orgId/drives` returns drives in that org (`packages/server/src/routes/orgs.ts:42-46` → `listDrives` at `packages/core/src/identity/drives.ts:25-35`). `listDrives` returns **all drives in the org**, with no `driveMembers` join — so it can list drives the user doesn't actually have access to. Access is enforced later inside ops via `getUserDriveRole`/`checkPermission` and `resolveContext` (`packages/core/src/identity/context.ts:18-86`).
- **Default-drive concept exists.** `drives.isDefault: boolean` column (`packages/core/src/db/schema.ts:50-52`). Set on the org's first drive at org creation: `createDrive(db, { orgId, name: "default", isDefault: true })` (`packages/core/src/identity/orgs.ts:28`). `resolveContext` (`packages/core/src/identity/context.ts:13-86`) falls back to:
  1. Explicit `driveId` (with RBAC check)
  2. Else `orgId`'s `isDefault` drive
  3. Else user's **personal-org default drive** (auto-created at registration — `packages/core/src/identity/users.ts:42-46`)
- `GET /auth/me` exposes the default drive directly: returns `{userId, email, defaultOrgId, defaultDriveId}` (`packages/server/src/routes/auth.ts:39-59`) — useful for a mount's "current" symlink.

### 9. Notification / SSE

- **No push channel.** Grep for `sse`, `SSE`, `EventSource`, `WebSocket`, `stream` across `packages/` yields only:
  - `packages/server/src/routes/files.ts` — `Response(... body.buffer ...)` (not a stream).
  - The MCP transport (`WebStandardStreamableHTTPServerTransport` in `packages/server/src/app.ts:51-66`) — used per-request, stateless (`sessionIdGenerator: undefined`, `enableJsonResponse: true`); not a push channel.
- An `events` table exists in the schema (`packages/core/src/db/schema.ts:147-164`; raw DDL at `packages/core/src/db/raw.ts:94-108`) with columns `type`, `resourceType`, `resourceId`, `actor`, `target`, `status (created/ack/deleted)`, `metadata`. But it is written **only by comment ops** (`packages/core/src/ops/comment.ts:35` and around) — no file-write op emits an event row. There is no consumer/dispatcher reading from it.
- Net: any cross-mount invalidation channel for the FUSE work would be net-new (server-side fanout, client-side connection, and emission inside `createVersion` or the op handlers).

## Gaps to fill for FUSE mount

1. **No raw byte PUT.** Adding a `PUT /orgs/:orgId/drives/:driveId/files/*/raw` (binary body, streamed) would let FUSE upload without JSON-encoding bytes and let the daemon stream into S3. The current ops endpoint requires UTF-8 string content under 10 MB.
2. **No `content_hash`.** Skipping no-op closes requires either (a) a new `file_versions.content_hash` column populated on insert and surfaced via `stat`/`/raw` headers, or (b) the daemon computing SHA-256 over the incoming byte stream and comparing against the prior version on-the-fly.
3. **No `parent_version_id` column.** Per-version lineage is implicit (`version - 1`). If conflicts produce side-versions, recording the parent explicitly would matter.
4. **No S3 conditional PUT.** `AgentS3Client.putObject` doesn't accept `IfMatch`/`IfNoneMatch`. App-level `expectedVersion` check exists for `write` only and is TOCTOU.
5. **No version exposed on raw GET.** `/raw` returns no `ETag` or `x-agent-fs-version` header — FUSE `open()` needs a separate `stat` call.
6. **No SSE/WebSocket.** Cross-mount invalidation is poll-only today.
7. **No drives-by-api-key endpoint.** Mount must compose `GET /orgs` → `GET /orgs/:id/drives` (and `GET /auth/me` for the default). The drives list does not check `driveMembers` membership; the mount would have to filter or rely on first-op-fails-with-403.
8. **No "agent identity" distinct from `users.id`.** Author attribution lands on whoever owns the API key. If multiple agents share one key, versions are indistinguishable.
9. **Embedding triggers live inside each op handler.** Hooking the FUSE upload through a new `PUT /raw` route means duplicating the `createVersion → indexFile → scheduleEmbedding` sequence (or routing the new endpoint through `write` op internally).
10. **No `If-Match` semantics at the HTTP edge.** Express `If-Match: <head_version_id>` would translate naturally to the existing `expectedVersion` field if exposed as a header.

## Diagram-ish flow (current write through `write` op)

```
HTTP client (CLI / MCP / future FUSE daemon)
   |
   |  POST /orgs/:orgId/ops
   |  Authorization: Bearer <apiKey>
   |  Content-Type: application/json
   |  body: { op:"write", path, content, expectedVersion?, message?, driveId? }
   v
[ packages/server/src/app.ts ]
   |  bodyLimit 50MB                     (app.ts:30)
   |  authMiddleware                     (middleware/auth.ts:8) -> c.set("user", {id,email}) from apiKeyHash
   |  rateLimitMiddleware (1200 rpm)     (app.ts:35)
   v
[ packages/server/src/routes/ops.ts:9 ]
   |  body = await c.req.json()          (full buffer in memory)
   |  resolved = resolveContext(db, {userId, orgId, driveId})
   |                                      (identity/context.ts:13)
   |  ctx = { db, s3, orgId, driveId, userId, embeddingProvider, appUrl }
   |  dispatchOp(ctx, "write", params)   (ops/index.ts:274)
   v
[ packages/core/src/ops/index.ts:274 ]
   |  RBAC: getRequiredRole("write") -> "editor"
   |        checkPermission(db, {userId, driveId, requiredRole})
   |  zod-validate params
   v
[ packages/core/src/ops/write.ts:12 ]
   |  size check (10 MB cap)              (write.ts:21)
   |  if expectedVersion: getNextVersion()-1 == expectedVersion ? else EditConflict (write.ts:29-41)
   |  s3Key = "<orgId>/drives/<driveId>/<path>"
   |  s3.putObject(s3Key, content, undefined, contentType)
   |                                       (s3/client.ts:78)  -- PutObjectCommand, NO IfMatch
   |  createVersion(ctx, {...})            (ops/versioning.ts:39)
   |    - getNextVersion (MAX(version)+1)
   |    - INSERT file_versions row (author = ctx.userId, s3VersionId, etag, operation:"write")
   |    - UPSERT files row (currentVersionId, modifiedAt, author)
   |  indexFile(db, {...})  -- SYNC FTS5  (search/fts.ts:8) delete+insert files_fts row
   |  scheduleEmbedding(db, provider, {...}) -- ASYNC fire-and-forget (search/pipeline.ts:149)
   |    sets embeddingStatus='pending'; later 'indexed' or 'failed'
   v
return { version, path, size } -> enriched with appUrl (ops/index.ts:299-305) -> JSON response
```

## 10-line summary

1. Single write entry: `POST /orgs/:orgId/ops` (`packages/server/src/routes/ops.ts:9`) with JSON-buffered content; **no PUT/binary route**.
2. Hard 10 MB content cap inside `write` op (`packages/core/src/ops/write.ts:10-26`); Hono body limit is 50 MB.
3. Version row written in `createVersion` (`packages/core/src/ops/versioning.ts:39-115`): monotonic int, no `parent_version_id`, **no `content_hash`** — dedup would be net-new.
4. S3 PUT via `AgentS3Client.putObject` (`packages/core/src/s3/client.ts:78`) — **no `If-Match`/`If-None-Match` plumbing**.
5. Optimistic concurrency **already exists** as `expectedVersion` on `write` only (`packages/core/src/ops/write.ts:29-41`); TOCTOU and not propagated to `edit`/`append`/etc.
6. FTS5 indexing synchronous (`packages/core/src/search/fts.ts:8`); embeddings fire-and-forget via in-process semaphore (`packages/core/src/search/pipeline.ts:42,149`).
7. Author = `users.id` resolved from `Authorization: Bearer` SHA-256 hash (`packages/server/src/middleware/auth.ts:29`, `packages/core/src/identity/users.ts:51-64`); **no agent-vs-user-vs-key distinction**.
8. Read `/orgs/:orgId/drives/:driveId/files/*/raw` (`packages/server/src/routes/files.ts:12`) returns bytes only — **no version header**; FUSE would call `stat` op separately.
9. Default-drive concept exists (`drives.isDefault`, `resolveContext` fallback chain, `/auth/me` exposes `defaultDriveId`).
10. **No SSE/WebSocket** anywhere; `events` table written only by comment ops (`packages/core/src/ops/comment.ts:35`) — invalidation would be net-new.

**Biggest seams to hook the FUSE mount into:**
- The op dispatcher contract (`OpContext` + `dispatchOp`) — a new `PUT /raw` route can call into `write.ts` and reuse RBAC + versioning + indexing for free.
- `WriteParams.expectedVersion` + `EditConflictError → HTTP 409` — already wired end-to-end; just needs a header surface and extension to other ops.
- `resolveContext` / `getDrive` / `/auth/me` for drive enumeration and default-drive resolution.

**Biggest missing pieces:**
- Streamed binary upload route (no JSON shim, no 10 MB ceiling).
- Content-hash column + skip-PUT-if-unchanged path.
- Conditional S3 PUT (`If-Match` flow through `putObject` and into the op).
- Version id surfaced on the `/raw` GET (or a cheap combined `HEAD /raw`).
- Cross-mount invalidation channel (server-pushed; `events` table is the natural spine but has no consumer).
- Multi-agent attribution beyond `users.id`.

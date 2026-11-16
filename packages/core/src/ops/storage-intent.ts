import { createHash } from "node:crypto";
import { and, desc, eq, inArray, lte } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { DB } from "../db/index.js";
import type { EmbeddingProvider } from "../search/embeddings/provider.js";
import type { GetObjectResult, StorageAdapter } from "../storage/adapter.js";
import { LocalStorageAdapter } from "../storage/local-adapter.js";
import type { OpContext } from "./types.js";
import { createVersion, getS3Key } from "./versioning.js";
import { clearSearchData, indexBytesForSearch } from "./search-index.js";
import { detectMimeType } from "./mime.js";
import { withPathLock } from "./path-lock.js";
import { finishRemove } from "./rm.js";

/**
 * Crash consistency for ops that change storage and then the database.
 *
 * A write stores the object, then records the version row and search index.
 * A crash in between leaves storage and the database disagreeing: bytes with
 * no version row, a deleted object still in search. Each such op records an
 * intent row per path before its storage call and deletes it once everything
 * is committed. A leftover row names a path to settle: reconcileStorageIntents
 * reads the object store, which is what readers see, and brings the version
 * row and search index in line with it.
 */
export type IntentOp = (typeof schema.storageIntents.$inferInsert)["op"];

/** Intent ids whose op is still running in this process. */
const inflight = new Set<number>();

export async function withStorageIntent<T>(
  ctx: OpContext,
  entries: Array<{ path: string; op: IntentOp; message?: string }>,
  fn: () => Promise<T>
): Promise<T> {
  const createdAt = new Date();
  const ids = ctx.db.transaction((tx) =>
    entries.map((e) =>
      tx.insert(schema.storageIntents)
        .values({
          orgId: ctx.orgId,
          driveId: ctx.driveId,
          path: e.path,
          op: e.op,
          author: ctx.userId,
          message: e.message ?? null,
          createdAt,
        })
        .returning({ id: schema.storageIntents.id })
        .get().id
    )
  );
  for (const id of ids) inflight.add(id);
  try {
    const result = await fn();
    ctx.db.delete(schema.storageIntents).where(inArray(schema.storageIntents.id, ids)).run();
    return result;
  } finally {
    // A failed op keeps its rows: the storage call may have landed anyway (a
    // timeout after the store applied it), so the sweep settles them.
    for (const id of ids) inflight.delete(id);
  }
}

/** Resolves once no op in this process is between its storage call and its commit. */
export async function drainStorageIntents(): Promise<void> {
  while (inflight.size > 0) await Bun.sleep(25);
}

export interface ReconcileDeps {
  db: DB;
  s3: StorageAdapter;
  embeddingProvider?: EmbeddingProvider | null;
}

function isNotFound(err: any): boolean {
  return (
    err?.name === "NotFound" ||
    err?.name === "NoSuchKey" ||
    err?.$metadata?.httpStatusCode === 404
  );
}

type IntentRow = typeof schema.storageIntents.$inferSelect;

/**
 * Settle one path from the object store. Idempotent: a path that already
 * agrees only gets its search index rebuilt.
 */
async function reconcileIntent(deps: ReconcileDeps, row: IntentRow): Promise<string> {
  const ctx: OpContext = {
    db: deps.db,
    s3: deps.s3,
    embeddingProvider: deps.embeddingProvider,
    orgId: row.orgId,
    driveId: row.driveId,
    userId: row.author,
  };
  const path = row.path;
  return withPathLock(row.driveId, [path], async () => {
    let obj: GetObjectResult | null = null;
    try {
      obj = await ctx.s3.getObject(getS3Key(row.orgId, row.driveId, path));
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    const head = ctx.db
      .select({
        operation: schema.fileVersions.operation,
        contentHash: schema.fileVersions.contentHash,
        size: schema.fileVersions.size,
      })
      .from(schema.fileVersions)
      .where(and(eq(schema.fileVersions.path, path), eq(schema.fileVersions.driveId, row.driveId)))
      .orderBy(desc(schema.fileVersions.version))
      .limit(1)
      .get();
    const live = head !== undefined && head.operation !== "delete";
    let outcome = "consistent";

    if (obj === null) {
      if (live) {
        await createVersion(ctx, { path, s3VersionId: "", operation: "delete", message: row.message ?? undefined });
        outcome = "recorded delete";
        // shortcut: a recovered mv source skips favoritesAfterMove, so its stars are dropped, not moved; carry the destination in the intent if that matters.
        if (row.op === "rm") await finishRemove(ctx, path);
      }
      clearSearchData(ctx, path, "all");
    } else {
      const contentHash = createHash("sha256").update(obj.body).digest("hex");
      // Rows from before content_hash existed match on size.
      const matches = live && (head.contentHash === null ? head.size === obj.body.byteLength : head.contentHash === contentHash);
      const contentType = obj.contentType ?? detectMimeType(path);
      if (!matches) {
        await createVersion(ctx, {
          path,
          // The local backend's version handle is the content hash (local-adapter.ts).
          s3VersionId: obj.versionId ?? (ctx.s3 instanceof LocalStorageAdapter ? contentHash : ""),
          operation: row.op === "edit" || row.op === "append" || row.op === "revert" ? row.op : "write",
          message: row.message ?? undefined,
          size: obj.body.byteLength,
          etag: obj.etag,
          contentType,
          contentHash,
        });
        outcome = "recorded write";
      }
      await indexBytesForSearch(ctx, path, obj.body, contentType);
    }
    ctx.db.delete(schema.storageIntents).where(eq(schema.storageIntents.id, row.id)).run();
    return outcome;
  });
}

let sweeping: Promise<number> | null = null;

/**
 * Settle every intent row older than `olderThanMs` whose op is not running in
 * this process. A row whose storage call fails (storage still down) stays for
 * the next sweep. Returns how many rows were settled.
 */
export function reconcileStorageIntents(
  deps: ReconcileDeps,
  opts: { olderThanMs?: number; log?: (msg: string) => void } = {}
): Promise<number> {
  sweeping ??= (async () => {
    const cutoff = new Date(Date.now() - (opts.olderThanMs ?? 0));
    const rows = deps.db
      .select()
      .from(schema.storageIntents)
      .where(lte(schema.storageIntents.createdAt, cutoff))
      .all()
      .filter((r) => !inflight.has(r.id));
    let settled = 0;
    for (const row of rows) {
      try {
        const outcome = await reconcileIntent(deps, row);
        settled++;
        if (outcome !== "consistent") opts.log?.(`storage intent ${row.op} ${row.path}: ${outcome}`);
      } catch (err) {
        opts.log?.(`storage intent ${row.op} ${row.path}: not settled (will retry): ${err instanceof Error ? err.message : err}`);
      }
    }
    return settled;
  })().finally(() => {
    sweeping = null;
  });
  return sweeping;
}

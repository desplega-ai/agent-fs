import { and, eq, gte, lt } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { OpContext } from "./types.js";
import { getS3Key } from "./versioning.js";
import { normalizePrefix } from "./paths.js";

/**
 * What a normalized path names in storage right now: `file`, `directory`, or
 * null when nothing is there.
 *
 * A folder is an implicit prefix with no object of its own; one level of
 * listing is enough to tell it exists. The listing also runs when the object
 * exists, because S3 can hold an object and a folder under one name, and a
 * folder wins over a file.
 */
export async function resolvePathKind(
  ctx: OpContext,
  path: string
): Promise<"file" | "directory" | null> {
  let isFile = false;
  if (path !== "/") {
    try {
      await ctx.s3.headObject(getS3Key(ctx.orgId, ctx.driveId, path));
      isFile = true;
    } catch (err: any) {
      if (!(err?.name === "NotFound" || err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404)) {
        throw err;
      }
    }
  }
  const prefix = normalizePrefix(path);
  const level = await ctx.s3.listObjects(getS3Key(ctx.orgId, ctx.driveId, prefix), {
    delimiter: "/",
  });
  if (level.objects.length > 0) return "directory";
  if ((await liveFolderPrefixes(ctx, level.prefixes)).length > 0) return "directory";
  return isFile ? "file" : null;
}

/**
 * The folder prefixes (S3 CommonPrefixes of this drive) that still hold a live
 * file, in input order.
 *
 * A prefix alone does not prove a folder: a versioned bucket can keep
 * reporting a prefix whose objects are all noncurrent versions behind delete
 * markers (MinIO does). A non-deleted `files` row answers from the database;
 * only a prefix without one costs a storage read, because the bucket can hold
 * objects the database has no row for.
 */
export async function liveFolderPrefixes(
  ctx: OpContext,
  prefixes: string[]
): Promise<string[]> {
  const driveKey = getS3Key(ctx.orgId, ctx.driveId, "/");
  const live = await Promise.all(
    prefixes.map(async (s3Prefix) => {
      if (hasLiveFileRow(ctx, "/" + s3Prefix.slice(driveKey.length))) return true;
      const { objects } = await ctx.s3.listObjects(s3Prefix, { maxKeys: 1 });
      return objects.length > 0;
    })
  );
  return prefixes.filter((_, i) => live[i]);
}

/** Whether a non-deleted file exists under the directory prefix `dir` (ends in `/`). */
function hasLiveFileRow(ctx: OpContext, dir: string): boolean {
  // Every path starting with `dir` sorts in [dir, dir with its last `/` bumped
  // to `0`), the next character, so the (drive_id, path) index answers it.
  const row = ctx.db
    .select({ path: schema.files.path })
    .from(schema.files)
    .where(
      and(
        eq(schema.files.driveId, ctx.driveId),
        gte(schema.files.path, dir),
        lt(schema.files.path, dir.slice(0, -1) + "0"),
        eq(schema.files.isDeleted, false)
      )
    )
    .limit(1)
    .get();
  return row !== undefined;
}

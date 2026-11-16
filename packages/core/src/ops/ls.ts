import { eq, and, inArray } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { OpContext, LsParams, LsResult, LsEntry } from "./types.js";
import { getS3Key } from "./versioning.js";
import { normalizePrefix } from "./paths.js";
import { liveFolderPrefixes } from "./path-kind.js";

// Keep batches below SQLite's older 999-variable limit, including the two filters.
const METADATA_BATCH_SIZE = 500;

export async function ls(
  ctx: OpContext,
  params: LsParams
): Promise<LsResult> {
  const prefix = normalizePrefix(params.path ?? "/");
  const s3Prefix = getS3Key(ctx.orgId, ctx.driveId, prefix);

  // List from S3 with delimiter for efficient immediate-children-only listing
  const { objects, prefixes } = await ctx.s3.listObjects(s3Prefix, {
    delimiter: "/",
  });

  // Read metadata only for the file objects in this listing, using exact indexed paths.
  const paths = objects
    .filter((obj) => obj.key !== s3Prefix && !obj.key.endsWith("/"))
    .map((obj) => prefix + obj.key.slice(s3Prefix.length));
  const dbFileMap = new Map<string, Pick<typeof schema.files.$inferSelect, "size" | "author" | "modifiedAt">>();
  for (let offset = 0; offset < paths.length; offset += METADATA_BATCH_SIZE) {
    const dbFiles = ctx.db
      .select({
        path: schema.files.path,
        size: schema.files.size,
        author: schema.files.author,
        modifiedAt: schema.files.modifiedAt,
      })
      .from(schema.files)
      .where(
        and(
          eq(schema.files.driveId, ctx.driveId),
          inArray(schema.files.path, paths.slice(offset, offset + METADATA_BATCH_SIZE)),
          eq(schema.files.isDeleted, false)
        )
      )
      .all();
    for (const file of dbFiles) dbFileMap.set(file.path, file);
  }

  const entries: LsEntry[] = [];

  // Add directories from S3 CommonPrefixes that still hold a live file
  for (const dirPrefix of await liveFolderPrefixes(ctx, prefixes)) {
    const dirName = dirPrefix.slice(s3Prefix.length).replace(/\/$/, "");
    if (dirName) {
      entries.push({ name: dirName, type: "directory", size: 0 });
    }
  }

  // Add files from S3 Contents (direct children only)
  for (const obj of objects) {
    const relativePath = obj.key.slice(s3Prefix.length);
    if (!relativePath) continue;

    const isDir = relativePath.endsWith("/");
    const name = isDir ? relativePath.slice(0, -1) : relativePath;

    if (isDir) {
      entries.push({ name, type: "directory", size: 0 });
    } else {
      const fullPath = prefix + name;
      const dbFile = dbFileMap.get(fullPath);
      entries.push({
        name,
        type: "file",
        size: dbFile?.size ?? obj.size,
        author: dbFile?.author,
        modifiedAt: dbFile?.modifiedAt ?? obj.lastModified,
      });
    }
  }

  return { entries };
}

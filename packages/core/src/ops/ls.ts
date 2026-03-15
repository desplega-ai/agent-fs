import { eq, and, like } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { OpContext, LsParams, LsResult, LsEntry } from "./types.js";
import { getS3Key } from "./versioning.js";
import { normalizePrefix } from "./paths.js";

export async function ls(
  ctx: OpContext,
  params: LsParams
): Promise<LsResult> {
  const prefix = normalizePrefix(params.path);
  const s3Prefix = getS3Key(ctx.orgId, ctx.driveId, prefix);

  // List from S3 with delimiter for efficient immediate-children-only listing
  const { objects, prefixes } = await ctx.s3.listObjects(s3Prefix, {
    delimiter: "/",
  });

  // Get metadata from SQLite for files in this drive
  const dbFiles = ctx.db
    .select()
    .from(schema.files)
    .where(
      and(
        eq(schema.files.driveId, ctx.driveId),
        like(schema.files.path, prefix + "%"),
        eq(schema.files.isDeleted, false)
      )
    )
    .all();

  const dbFileMap = new Map(dbFiles.map((f) => [f.path, f]));

  const entries: LsEntry[] = [];

  // Add directories from S3 CommonPrefixes
  for (const dirPrefix of prefixes) {
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

import { eq, and, like } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { OpContext, LsParams, LsResult, LsEntry } from "./types.js";
import { getS3Key } from "./versioning.js";

export async function ls(
  ctx: OpContext,
  params: LsParams
): Promise<LsResult> {
  const prefix = params.path.endsWith("/") ? params.path : params.path + "/";
  const s3Prefix = getS3Key(ctx.orgId, ctx.driveId, prefix);

  // List from S3
  const s3Objects = await ctx.s3.listObjects(s3Prefix);

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

  // Build entries — deduplicate directories
  const entries: LsEntry[] = [];
  const seenDirs = new Set<string>();

  for (const obj of s3Objects) {
    // Strip the org/drive prefix to get the relative path
    const relativePath = obj.key.slice(s3Prefix.length);
    if (!relativePath) continue;

    // Check if this is a direct child or nested
    const slashIdx = relativePath.indexOf("/");
    if (slashIdx > 0 && slashIdx < relativePath.length - 1) {
      // Nested — show as directory
      const dirName = relativePath.slice(0, slashIdx);
      if (!seenDirs.has(dirName)) {
        seenDirs.add(dirName);
        entries.push({ name: dirName, type: "directory", size: 0 });
      }
      continue;
    }

    // Direct child
    const name = relativePath.endsWith("/")
      ? relativePath.slice(0, -1)
      : relativePath;
    const isDir = relativePath.endsWith("/");

    if (isDir) {
      if (!seenDirs.has(name)) {
        seenDirs.add(name);
        entries.push({ name, type: "directory", size: 0 });
      }
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

import { eq, and, like } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { OpContext, TreeParams, TreeResult, TreeEntry } from "./types.js";
import { getS3Key } from "./versioning.js";
import { normalizePrefix } from "./paths.js";

export async function tree(
  ctx: OpContext,
  params: TreeParams
): Promise<TreeResult> {
  const prefix = normalizePrefix(params.path ?? "/");
  const s3Prefix = getS3Key(ctx.orgId, ctx.driveId, prefix);

  // List ALL objects recursively (no delimiter)
  const { objects } = await ctx.s3.listObjects(s3Prefix);

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

  // Build tree from flat S3 keys
  const root: TreeEntry[] = [];
  // Folder lookup per sibling array, so nesting stays linear in the key count.
  const dirIndex = new Map<TreeEntry[], Map<string, TreeEntry>>();
  const findOrCreateDir = (siblings: TreeEntry[], name: string): TreeEntry => {
    let dirs = dirIndex.get(siblings);
    if (!dirs) {
      dirs = new Map();
      dirIndex.set(siblings, dirs);
    }
    let dir = dirs.get(name);
    if (!dir) {
      dir = { name, type: "directory", children: [] };
      siblings.push(dir);
      dirs.set(name, dir);
    }
    return dir;
  };

  for (const obj of objects) {
    const relativePath = obj.key.slice(s3Prefix.length);
    if (!relativePath) continue;

    const parts = relativePath.split("/").filter(Boolean);
    if (parts.length === 0) continue;

    // Check depth limit
    if (params.depth !== undefined && parts.length > params.depth) continue;

    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const isDir = !isLast || relativePath.endsWith("/");

      if (isDir && !isLast) {
        // Intermediate directory — find or create
        const dir = findOrCreateDir(current, part);
        if (!dir.children) dir.children = [];
        current = dir.children;
      } else if (isDir && isLast) {
        // Trailing-slash directory entry
        findOrCreateDir(current, part);
      } else {
        // File entry
        const fullPath = prefix + parts.slice(0, i + 1).join("/");
        const dbFile = dbFileMap.get(fullPath);
        const entry: TreeEntry = {
          name: part,
          type: "file",
          size: dbFile?.size ?? obj.size,
        };
        if (dbFile?.author) entry.author = dbFile.author;
        if (dbFile?.modifiedAt ?? obj.lastModified) {
          entry.modifiedAt = dbFile?.modifiedAt ?? obj.lastModified;
        }
        current.push(entry);
      }
    }
  }

  return { tree: root };
}

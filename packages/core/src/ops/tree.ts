import { eq, and, inArray } from "drizzle-orm";
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

  const listing = await ctx.s3.listObjects(
    s3Prefix,
    params.depth === undefined ? undefined : { maxDepth: params.depth }
  );
  // Adapters may ignore the depth hint. Keep the public depth rule here.
  const objects = listing.objects.filter((object) =>
    params.depth === undefined ||
    object.key.slice(s3Prefix.length).split("/").filter(Boolean).length <= params.depth
  );

  // Fetch only metadata for files that the storage listing can return.
  const paths = Array.from(new Set(objects
    .filter((object) => !object.key.endsWith("/"))
    .map((object) => prefix + object.key.slice(s3Prefix.length).split("/").filter(Boolean).join("/"))));
  const dbFileMap = new Map<string, { size: number; author: string; modifiedAt: Date }>();
  for (let offset = 0; offset < paths.length; offset += 400) {
    const rows = ctx.db
      .select({
        path: schema.files.path,
        size: schema.files.size,
        author: schema.files.author,
        modifiedAt: schema.files.modifiedAt,
      })
      .from(schema.files)
      .where(and(
        eq(schema.files.driveId, ctx.driveId),
        inArray(schema.files.path, paths.slice(offset, offset + 400)),
        eq(schema.files.isDeleted, false),
      ))
      .all();
    for (const row of rows) dbFileMap.set(row.path, row);
  }

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

    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const isDir = !isLast || relativePath.endsWith("/");

      if (isDir && !isLast) {
        // Create an intermediate directory only once.
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

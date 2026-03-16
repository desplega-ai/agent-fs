import { eq, and, like } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { OpContext, GlobParams, GlobResult, GlobMatch } from "./types.js";
import { getS3Key } from "./versioning.js";
import { normalizePrefix } from "./paths.js";

/**
 * Convert a glob pattern to a RegExp.
 * Supports: `*` (any chars except /), `?` (single char except /), `**` (any chars including /)
 */
function globToRegex(pattern: string): RegExp {
  let regex = "";
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i];

    if (char === "*") {
      if (pattern[i + 1] === "*") {
        // ** matches everything including /
        regex += ".*";
        i += 2;
        // Skip trailing / after **
        if (pattern[i] === "/") i++;
      } else {
        // * matches everything except /
        regex += "[^/]*";
        i++;
      }
    } else if (char === "?") {
      regex += "[^/]";
      i++;
    } else if (".+^${}()|[]\\".includes(char)) {
      regex += "\\" + char;
      i++;
    } else {
      regex += char;
      i++;
    }
  }

  return new RegExp("^" + regex + "$");
}

export async function glob(
  ctx: OpContext,
  params: GlobParams
): Promise<GlobResult> {
  const prefix = params.path
    ? normalizePrefix(params.path)
    : "/";
  const s3Prefix = getS3Key(ctx.orgId, ctx.driveId, prefix);

  // List ALL objects recursively (no delimiter)
  const { objects } = await ctx.s3.listObjects(s3Prefix);

  // Get metadata from SQLite
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

  const regex = globToRegex(params.pattern);
  const matches: GlobMatch[] = [];

  for (const obj of objects) {
    const relativePath = obj.key.slice(s3Prefix.length);
    if (!relativePath || relativePath.endsWith("/")) continue;

    // Test the relative path against the glob pattern
    if (regex.test(relativePath)) {
      const fullPath = prefix + relativePath;
      const dbFile = dbFileMap.get(fullPath);
      matches.push({
        path: fullPath,
        size: dbFile?.size ?? obj.size,
        modifiedAt: dbFile?.modifiedAt ?? obj.lastModified,
      });
    }
  }

  return { matches };
}

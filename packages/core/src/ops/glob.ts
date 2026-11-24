import { eq, and, sql } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { OpContext, GlobParams, GlobResult, GlobMatch } from "./types.js";
import { getS3Key } from "./versioning.js";
import { likePrefix, normalizePrefix } from "./paths.js";
import { getCachedDriveListing } from "./glob-cache.js";

/**
 * Compile a glob pattern into a path matcher.
 * Supports: `*` (any chars except /), `?` (single char except /), `**` (any chars including /)
 */
function globToMatcher(pattern: string): (path: string) => boolean {
  const tokens: string[] = [];
  for (let i = 0; i < pattern.length; ) {
    if (pattern.startsWith("**", i)) {
      tokens.push("**");
      i += 2;
      // Skip trailing / after **
      if (pattern[i] === "/") i++;
    } else {
      tokens.push(pattern[i]);
      i++;
    }
  }

  // Track every pattern position at once instead of compiling a RegExp: a
  // backtracking regex grows with path length to the power of the wildcard
  // count, this stays path length times pattern length.
  // live[j]: tokens[0..j) match the path read so far.
  return (path) => {
    let live = new Uint8Array(tokens.length + 1);
    let next = new Uint8Array(tokens.length + 1);
    live[0] = 1;
    for (let j = 0; j < tokens.length && (tokens[j] === "*" || tokens[j] === "**"); j++) live[j + 1] = 1;

    for (let i = 0; i < path.length; i++) {
      const ch = path[i];
      next.fill(0);
      let alive = false;
      for (let j = 1; j <= tokens.length; j++) {
        const t = tokens[j - 1];
        const ok =
          t === "**" ? next[j - 1] || live[j]
          : t === "*" ? next[j - 1] || (live[j] && ch !== "/")
          : t === "?" ? live[j - 1] && ch !== "/"
          : live[j - 1] && ch === t;
        if (ok) {
          next[j] = 1;
          alive = true;
        }
      }
      if (!alive) return false;
      [live, next] = [next, live];
    }
    return live[tokens.length] === 1;
  };
}

export async function glob(
  ctx: OpContext,
  params: GlobParams
): Promise<GlobResult> {
  const prefix = params.path
    ? normalizePrefix(params.path)
    : "/";
  const s3Prefix = getS3Key(ctx.orgId, ctx.driveId, prefix);

  // List all objects recursively (no delimiter)
  const { objects } = await getCachedDriveListing(
    ctx.orgId,
    ctx.driveId,
    prefix,
    () => ctx.s3.listObjects(s3Prefix),
  );

  // Get metadata from SQLite
  const dbFiles = ctx.db
    .select()
    .from(schema.files)
    .where(
      and(
        eq(schema.files.driveId, ctx.driveId),
        sql`${schema.files.path} LIKE ${likePrefix(prefix)} ESCAPE '\\'`,
        eq(schema.files.isDeleted, false)
      )
    )
    .all();

  const dbFileMap = new Map(dbFiles.map((f) => [f.path, f]));

  const isMatch = globToMatcher(params.pattern);
  const matches: GlobMatch[] = [];

  for (const obj of objects) {
    const relativePath = obj.key.slice(s3Prefix.length);
    if (!relativePath || relativePath.endsWith("/")) continue;

    // Test the relative path against the glob pattern
    if (isMatch(relativePath)) {
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

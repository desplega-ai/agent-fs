import type { OpContext, RevealParams, RevealResult } from "./types.js";
import { ls } from "./ls.js";
import { stat } from "./stat.js";
import { normalizePath } from "./paths.js";
import { ValidationError } from "../errors.js";

/**
 * Every directory that must be expanded to show `filePath`, root first:
 * "/a/b/c.md" → ["/", "/a", "/a/b"].
 */
export function revealAncestors(filePath: string): string[] {
  const parts = filePath.split("/").filter(Boolean);
  return ["/", ...parts.slice(0, -1).map((_, i) => "/" + parts.slice(0, i + 1).join("/"))];
}

/**
 * Everything a file tree needs to show one file, in one round trip: the `ls`
 * listing of every ancestor directory plus the file's `stat`. Each listing is
 * exactly what `ls` returns for that path, so clients can cache it as such.
 */
export async function reveal(
  ctx: OpContext,
  params: RevealParams
): Promise<RevealResult> {
  const path = normalizePath(params.path);
  if (path === "/") {
    throw new ValidationError("reveal needs a file path, not the drive root", {
      field: "path",
      suggestion: "Use ls to list the drive root.",
    });
  }

  const ancestors = revealAncestors(path);
  const [fileStat, ...listings] = await Promise.all([
    stat(ctx, { path }),
    ...ancestors.map((dir) => ls(ctx, { path: dir })),
  ]);

  return {
    path,
    stat: fileStat,
    listings: ancestors.map((dir, i) => ({ path: dir, entries: listings[i]!.entries })),
  };
}

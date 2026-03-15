import { eq, and, like } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { OpContext } from "./types.js";
import { getS3Key } from "./versioning.js";

export interface GrepParams {
  pattern: string;
  path: string;
}

export interface GrepMatch {
  path: string;
  lineNumber: number;
  content: string;
}

export interface GrepResult {
  matches: GrepMatch[];
}

export async function grep(
  ctx: OpContext,
  params: GrepParams
): Promise<GrepResult> {
  const regex = new RegExp(params.pattern);
  const prefix = params.path.endsWith("/") ? params.path : params.path + "/";

  // Get files in the path prefix from SQLite
  const files = ctx.db
    .select({ path: schema.files.path })
    .from(schema.files)
    .where(
      and(
        eq(schema.files.driveId, ctx.driveId),
        like(schema.files.path, prefix + "%"),
        eq(schema.files.isDeleted, false)
      )
    )
    .all();

  const matches: GrepMatch[] = [];

  for (const file of files) {
    const s3Key = getS3Key(ctx.orgId, ctx.driveId, file.path);
    try {
      const result = await ctx.s3.getObject(s3Key);
      const content = new TextDecoder().decode(result.body);
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          matches.push({
            path: file.path,
            lineNumber: i + 1,
            content: lines[i],
          });
        }
      }
    } catch {
      // Skip files that can't be read
    }
  }

  return { matches };
}

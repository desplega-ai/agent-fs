import { eq, and, desc } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { OpContext, LogParams, LogResult } from "./types.js";

export async function log(
  ctx: OpContext,
  params: LogParams
): Promise<LogResult> {
  const limit = params.limit ?? 50;

  const rows = ctx.db
    .select()
    .from(schema.fileVersions)
    .where(
      and(
        eq(schema.fileVersions.path, params.path),
        eq(schema.fileVersions.driveId, ctx.driveId)
      )
    )
    .orderBy(desc(schema.fileVersions.version))
    .limit(limit)
    .all();

  return {
    versions: rows.map((r) => ({
      version: r.version,
      author: r.author,
      createdAt: r.createdAt,
      operation: r.operation,
      message: r.message ?? undefined,
      diffSummary: r.diffSummary ?? undefined,
      size: r.size ?? undefined,
    })),
  };
}

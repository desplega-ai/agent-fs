import { eq, and, desc, gte, like } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { OpContext, RecentParams, RecentResult } from "./types.js";

export async function recent(
  ctx: OpContext,
  params: RecentParams
): Promise<RecentResult> {
  const limit = params.limit ?? 50;

  let query = ctx.db
    .select()
    .from(schema.fileVersions)
    .where(eq(schema.fileVersions.driveId, ctx.driveId))
    .$dynamic();

  if (params.path) {
    query = query.where(
      and(
        eq(schema.fileVersions.driveId, ctx.driveId),
        like(schema.fileVersions.path, params.path + "%")
      )
    );
  }

  if (params.since) {
    query = query.where(
      and(
        eq(schema.fileVersions.driveId, ctx.driveId),
        gte(schema.fileVersions.createdAt, params.since)
      )
    );
  }

  const rows = query
    .orderBy(desc(schema.fileVersions.createdAt))
    .limit(limit)
    .all();

  return {
    entries: rows.map((r) => ({
      path: r.path,
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

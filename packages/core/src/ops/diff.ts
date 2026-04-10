import { eq, and } from "drizzle-orm";
import { structuredPatch } from "diff";
import { schema } from "../db/index.js";
import type { OpContext, DiffParams, DiffResult, DiffChange } from "./types.js";
import { getS3Key } from "./versioning.js";
import { NotFoundError } from "../errors.js";

export async function diff(
  ctx: OpContext,
  params: DiffParams
): Promise<DiffResult> {
  // Get version records
  const v1Record = ctx.db
    .select()
    .from(schema.fileVersions)
    .where(
      and(
        eq(schema.fileVersions.path, params.path),
        eq(schema.fileVersions.driveId, ctx.driveId),
        eq(schema.fileVersions.version, params.v1)
      )
    )
    .get();

  const v2Record = ctx.db
    .select()
    .from(schema.fileVersions)
    .where(
      and(
        eq(schema.fileVersions.path, params.path),
        eq(schema.fileVersions.driveId, ctx.driveId),
        eq(schema.fileVersions.version, params.v2)
      )
    )
    .get();

  if (!v1Record || !v2Record) {
    throw new NotFoundError(
      `Version ${!v1Record ? params.v1 : params.v2} not found for ${params.path}`,
      { path: params.path }
    );
  }

  // If both versions have S3 version IDs, fetch and diff the actual content
  if (v1Record.s3VersionId && v2Record.s3VersionId) {
    const s3Key = getS3Key(ctx.orgId, ctx.driveId, params.path);

    try {
      const [content1, content2] = await Promise.all([
        ctx.s3.getObject(s3Key, v1Record.s3VersionId),
        ctx.s3.getObject(s3Key, v2Record.s3VersionId),
      ]);

      const text1 = new TextDecoder().decode(content1.body);
      const text2 = new TextDecoder().decode(content2.body);

      const patch = structuredPatch(
        params.path,
        params.path,
        text1,
        text2
      );

      const changes: DiffChange[] = [];
      for (const hunk of patch.hunks) {
        for (const line of hunk.lines) {
          const type =
            line.startsWith("+") ? "add" :
            line.startsWith("-") ? "remove" :
            "context";
          changes.push({ type, content: line.slice(1) });
        }
      }

      return { changes };
    } catch (err) {
      console.warn(`[diff] S3 content fetch failed for ${params.path}, falling back to diffSummary:`, err);
    }
  }

  // Fallback: use stored diffSummary
  const changes: DiffChange[] = [];
  if (v2Record.diffSummary) {
    try {
      const summary = JSON.parse(v2Record.diffSummary);
      if (summary.old) changes.push({ type: "remove", content: summary.old });
      if (summary.new) changes.push({ type: "add", content: summary.new });
    } catch {
      changes.push({ type: "context", content: v2Record.diffSummary });
    }
  }

  return { changes };
}

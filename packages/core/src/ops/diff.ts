import { eq, and } from "drizzle-orm";
import { structuredPatch } from "diff";
import { schema } from "../db/index.js";
import type { OpContext, DiffParams, DiffResult, DiffChange } from "./types.js";
import { getS3Key } from "./versioning.js";
import { NotFoundError } from "../errors.js";
import { normalizePath } from "./paths.js";

export async function diff(
  ctx: OpContext,
  params: DiffParams
): Promise<DiffResult> {
  const path = normalizePath(params.path);
  // Get version records
  const v1Record = ctx.db
    .select()
    .from(schema.fileVersions)
    .where(
      and(
        eq(schema.fileVersions.path, path),
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
        eq(schema.fileVersions.path, path),
        eq(schema.fileVersions.driveId, ctx.driveId),
        eq(schema.fileVersions.version, params.v2)
      )
    )
    .get();

  if (!v1Record || !v2Record) {
    throw new NotFoundError(
      `Version ${!v1Record ? params.v1 : params.v2} not found for ${path}`,
      { path }
    );
  }

  // If the backend supports versioning AND both versions have version handles,
  // fetch and diff the actual content. Unlike `revert` (which hard-throws
  // UnsupportedOperation), historical `diff` degrades gracefully: a backend
  // without versioning skips the doomed version-handle fetch and falls back to
  // the stored `diffSummary` below — it must never throw UnsupportedOperation.
  if (ctx.s3.capabilities.versioning && v1Record.s3VersionId && v2Record.s3VersionId) {
    const s3Key = getS3Key(ctx.orgId, ctx.driveId, path);

    try {
      const [content1, content2] = await Promise.all([
        ctx.s3.getObject(s3Key, v1Record.s3VersionId),
        ctx.s3.getObject(s3Key, v2Record.s3VersionId),
      ]);

      const text1 = new TextDecoder().decode(content1.body);
      const text2 = new TextDecoder().decode(content2.body);

      const patch = structuredPatch(
        path,
        path,
        text1,
        text2
      );

      const changes: DiffChange[] = [];
      for (const hunk of patch.hunks) {
        let oldLine = hunk.oldStart;
        let newLine = hunk.newStart;
        for (const line of hunk.lines) {
          if (line.startsWith("\\")) {
            // "\ No newline at end of file" marker: not a content line, so no
            // line numbers (kept in `changes` as before).
            changes.push({ type: "context", content: line.slice(1) });
          } else if (line.startsWith("+")) {
            changes.push({ type: "add", content: line.slice(1), newLine: newLine++ });
          } else if (line.startsWith("-")) {
            changes.push({ type: "remove", content: line.slice(1), oldLine: oldLine++ });
          } else {
            changes.push({ type: "context", content: line.slice(1), oldLine: oldLine++, newLine: newLine++ });
          }
        }
      }

      return { changes, source: "content" };
    } catch (err) {
      console.warn(`[diff] S3 content fetch failed for ${path}, falling back to diffSummary:`, err);
    }
  }

  // Fallback: use stored diffSummary. The versions were not compared, so the
  // result says so via `source`: `write` stores no summary, and an empty
  // `changes` here must not read as "identical".
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

  return { changes, source: changes.length > 0 ? "summary" : "none" };
}

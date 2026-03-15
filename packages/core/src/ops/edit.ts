import type { OpContext, EditParams, EditResult } from "./types.js";
import { getS3Key, createVersion } from "./versioning.js";
import { NotFoundError, EditConflictError } from "../errors.js";

export async function edit(
  ctx: OpContext,
  params: EditParams
): Promise<EditResult> {
  const s3Key = getS3Key(ctx.orgId, ctx.driveId, params.path);

  // 1. Get current content
  let body: Uint8Array;
  try {
    const result = await ctx.s3.getObject(s3Key);
    body = result.body;
  } catch (err: any) {
    if (err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) {
      throw new NotFoundError(`File not found: ${params.path}`, {
        path: params.path,
      });
    }
    throw err;
  }

  const content = new TextDecoder().decode(body);

  // 2. Verify old_string exists exactly once
  const occurrences = content.split(params.old_string).length - 1;
  if (occurrences === 0) {
    throw new EditConflictError(
      `old_string not found in ${params.path}`,
      {
        path: params.path,
        suggestion: "Verify the exact text you want to replace",
      }
    );
  }
  if (occurrences > 1) {
    throw new EditConflictError(
      `old_string found ${occurrences} times in ${params.path}, expected exactly 1`,
      {
        path: params.path,
        suggestion: "Provide more surrounding context to make the match unique",
      }
    );
  }

  // 3. Replace and write back
  const newContent = content.replace(params.old_string, params.new_string);
  const size = Buffer.byteLength(newContent);

  const s3Result = await ctx.s3.putObject(s3Key, newContent);

  // 4. Create version with diff summary
  const diffSummary = JSON.stringify({
    old: params.old_string,
    new: params.new_string,
  });

  const version = await createVersion(ctx, {
    path: params.path,
    s3VersionId: s3Result.versionId ?? "",
    operation: "edit",
    message: params.message,
    diffSummary,
    size,
    etag: s3Result.etag,
  });

  return { version, path: params.path, changes: 1 };
}

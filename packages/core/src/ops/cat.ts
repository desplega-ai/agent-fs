import type { OpContext, CatParams, CatResult } from "./types.js";
import { getS3Key } from "./versioning.js";
import { NotFoundError } from "../errors.js";

const DEFAULT_LIMIT = 200;

export async function cat(
  ctx: OpContext,
  params: CatParams
): Promise<CatResult> {
  const s3Key = getS3Key(ctx.orgId, ctx.driveId, params.path);

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
  const lines = content.split("\n");
  const totalLines = lines.length;

  const offset = params.offset ?? 0;
  const limit = params.limit ?? DEFAULT_LIMIT;

  const sliced = lines.slice(offset, offset + limit);
  const truncated = offset + limit < totalLines;

  return {
    content: sliced.join("\n"),
    totalLines,
    truncated,
  };
}

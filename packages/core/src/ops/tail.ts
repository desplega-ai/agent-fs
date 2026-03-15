import type { OpContext, TailParams, CatResult } from "./types.js";
import { getS3Key } from "./versioning.js";
import { NotFoundError } from "../errors.js";

const DEFAULT_LINES = 20;

export async function tail(
  ctx: OpContext,
  params: TailParams
): Promise<CatResult> {
  const s3Key = getS3Key(ctx.orgId, ctx.driveId, params.path);
  const n = params.lines ?? DEFAULT_LINES;

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

  const start = Math.max(0, totalLines - n);
  const sliced = lines.slice(start);
  const truncated = start > 0;

  return {
    content: sliced.join("\n"),
    totalLines,
    truncated,
  };
}

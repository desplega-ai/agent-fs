import type { OpContext, CatParams, CatResult } from "./types.js";
import { getS3Key } from "./versioning.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { decodeIndexableText, detectMimeType } from "./mime.js";

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
    const contentType = result.contentType ?? detectMimeType(params.path);
    const content = decodeIndexableText(body, contentType);
    if (content === null) {
      throw new ValidationError(
        `File is not readable as text: ${params.path}`,
        {
          field: "path",
          suggestion: "Use `agent-fs download` or `agent-fs signed-url` for binary files",
        }
      );
    }

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
  } catch (err: any) {
    if (err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404) {
      throw new NotFoundError(`File not found: ${params.path}`, {
        path: params.path,
      });
    }
    throw err;
  }
}

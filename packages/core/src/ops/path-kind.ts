import type { OpContext } from "./types.js";
import { getS3Key } from "./versioning.js";
import { normalizePrefix } from "./paths.js";

/**
 * What a normalized path names in storage right now: `file`, `directory`, or
 * null when nothing is there.
 *
 * A folder is an implicit prefix with no object of its own; one level of
 * listing is enough to tell it exists. The listing also runs when the object
 * exists, because the local backend answers headObject for a directory as
 * well, so a folder wins over a file.
 */
export async function resolvePathKind(
  ctx: OpContext,
  path: string
): Promise<"file" | "directory" | null> {
  let isFile = false;
  if (path !== "/") {
    try {
      await ctx.s3.headObject(getS3Key(ctx.orgId, ctx.driveId, path));
      isFile = true;
    } catch (err: any) {
      if (!(err?.name === "NotFound" || err?.name === "NoSuchKey" || err?.$metadata?.httpStatusCode === 404)) {
        throw err;
      }
    }
  }
  const level = await ctx.s3.listObjects(getS3Key(ctx.orgId, ctx.driveId, normalizePrefix(path)), {
    delimiter: "/",
  });
  if (level.objects.length > 0 || level.prefixes.length > 0) return "directory";
  return isFile ? "file" : null;
}

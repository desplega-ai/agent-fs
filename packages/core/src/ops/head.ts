import type { OpContext, HeadParams, CatResult } from "./types.js";
import { cat } from "./cat.js";

const DEFAULT_LINES = 20;

export async function head(
  ctx: OpContext,
  params: HeadParams
): Promise<CatResult> {
  return cat(ctx, {
    path: params.path,
    offset: 0,
    limit: params.lines ?? DEFAULT_LINES,
  });
}

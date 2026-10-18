import { z } from "zod";

export const presenceSessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const quote = z.object({
  exact: z.string().max(256),
  prefix: z.string().max(64).optional(),
  suffix: z.string().max(64).optional(),
});
const line = z.number().int().nonnegative();
const fileVersion = z.number().nullable().optional();
export const presenceStateSchema = z.object({
  path: z.string().max(4096).nullable(),
  mode: z.enum(["view", "edit"]),
  selection: z.object({
    quote,
    lineStart: line,
    lineEnd: line,
    fileVersion,
    collapsed: z.boolean(),
  }).nullable().optional(),
  pointer: z.object({ quote, charOffset: line, lineStart: line, fileVersion }).nullable().optional(),
  commentId: z.string().max(128).nullable().optional(),
  commentState: z.enum(["viewing", "replying"]).nullable().optional(),
});

import { z } from "zod";
import type { OpContext } from "./types.js";
import { checkPermission, getRequiredRole } from "../identity/rbac.js";
import { write } from "./write.js";
import { cat } from "./cat.js";
import { edit } from "./edit.js";
import { append } from "./append.js";
import { ls } from "./ls.js";
import { stat } from "./stat.js";
import { rm } from "./rm.js";
import { mv } from "./mv.js";
import { cp } from "./cp.js";
import { head } from "./head.js";
import { tail } from "./tail.js";
import { mkdir } from "./mkdir.js";
import { log } from "./log.js";
import { diff } from "./diff.js";
import { revert } from "./revert.js";
import { recent } from "./recent.js";
import { grep } from "./grep.js";
import { find } from "./find.js";

export interface OpDefinition {
  handler: (ctx: OpContext, params: any) => Promise<any>;
  schema: z.ZodType;
}

const opRegistry: Record<string, OpDefinition> = {
  write: {
    handler: write,
    schema: z.object({
      path: z.string(),
      content: z.string(),
      message: z.string().optional(),
    }),
  },
  cat: {
    handler: cat,
    schema: z.object({
      path: z.string(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).optional(),
    }),
  },
  edit: {
    handler: edit,
    schema: z.object({
      path: z.string(),
      old_string: z.string(),
      new_string: z.string(),
      message: z.string().optional(),
    }),
  },
  append: {
    handler: append,
    schema: z.object({
      path: z.string(),
      content: z.string(),
      message: z.string().optional(),
    }),
  },
  ls: {
    handler: ls,
    schema: z.object({ path: z.string() }),
  },
  stat: {
    handler: stat,
    schema: z.object({ path: z.string() }),
  },
  rm: {
    handler: rm,
    schema: z.object({ path: z.string() }),
  },
  mv: {
    handler: mv,
    schema: z.object({
      from: z.string(),
      to: z.string(),
      message: z.string().optional(),
    }),
  },
  cp: {
    handler: cp,
    schema: z.object({
      from: z.string(),
      to: z.string(),
    }),
  },
  head: {
    handler: head,
    schema: z.object({
      path: z.string(),
      lines: z.number().int().min(1).optional(),
    }),
  },
  tail: {
    handler: tail,
    schema: z.object({
      path: z.string(),
      lines: z.number().int().min(1).optional(),
    }),
  },
  mkdir: {
    handler: mkdir,
    schema: z.object({ path: z.string() }),
  },
  log: {
    handler: log,
    schema: z.object({
      path: z.string(),
      limit: z.number().int().min(1).optional(),
    }),
  },
  diff: {
    handler: diff,
    schema: z.object({
      path: z.string(),
      v1: z.number().int(),
      v2: z.number().int(),
    }),
  },
  revert: {
    handler: revert,
    schema: z.object({
      path: z.string(),
      version: z.number().int(),
    }),
  },
  recent: {
    handler: recent,
    schema: z.object({
      path: z.string().optional(),
      since: z.coerce.date().optional(),
      limit: z.number().int().min(1).optional(),
    }),
  },
  grep: {
    handler: grep,
    schema: z.object({
      pattern: z.string(),
      path: z.string(),
    }),
  },
  find: {
    handler: find,
    schema: z.object({
      pattern: z.string(),
      path: z.string().optional(),
    }),
  },
};

export async function dispatchOp(
  ctx: OpContext,
  opName: string,
  params: unknown,
  opts?: { skipAuth?: boolean }
): Promise<unknown> {
  const op = opRegistry[opName];
  if (!op) {
    throw new Error(`Unknown operation: ${opName}`);
  }

  // RBAC check — enforced at the core dispatcher level
  if (!opts?.skipAuth) {
    const requiredRole = getRequiredRole(opName);
    checkPermission(ctx.db, {
      userId: ctx.userId,
      driveId: ctx.driveId,
      requiredRole,
    });
  }

  const validated = op.schema.parse(params);
  return op.handler(ctx, validated);
}

export function getRegisteredOps(): string[] {
  return Object.keys(opRegistry);
}

export function getOpDefinition(name: string): OpDefinition | undefined {
  return opRegistry[name];
}

// Re-export individual ops for direct use
export { write, cat, edit, append, ls, stat, rm, mv, cp, head, tail, mkdir, log, diff, revert, recent, grep, find };
export { search } from "./search.js";
export type * from "./types.js";

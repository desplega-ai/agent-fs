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
import { tail } from "./tail.js";
import { log } from "./log.js";
import { diff } from "./diff.js";
import { revert } from "./revert.js";
import { recent } from "./recent.js";
import { grep } from "./grep.js";
import { fts } from "./fts.js";
import { search } from "./search.js";
import { reindex } from "./reindex.js";
import { tree } from "./tree.js";
import { glob } from "./glob.js";

export interface OpDefinition {
  description: string;
  handler: (ctx: OpContext, params: any) => Promise<any>;
  schema: z.ZodType;
}

const opRegistry: Record<string, OpDefinition> = {
  write: {
    description: "Write or overwrite a file. Creates the file if it doesn't exist, or creates a new version. Use expectedVersion for optimistic concurrency. Returns { version, path, size }.",
    handler: write,
    schema: z.object({
      path: z.string(),
      content: z.string(),
      message: z.string().optional(),
      expectedVersion: z.number().int().optional(),
    }),
  },
  cat: {
    description: "Read file content with optional pagination via offset/limit. Returns { content, totalLines, truncated }.",
    handler: cat,
    schema: z.object({
      path: z.string(),
      offset: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).optional(),
    }),
  },
  edit: {
    description: "Replace a specific string in a file (surgical find-and-replace). Captures the edit intent as a diff summary in version history. Returns { version, path, changes }.",
    handler: edit,
    schema: z.object({
      path: z.string(),
      old_string: z.string(),
      new_string: z.string(),
      message: z.string().optional(),
    }),
  },
  append: {
    description: "Append content to the end of an existing file. Creates a new version. Returns { version, size }.",
    handler: append,
    schema: z.object({
      path: z.string(),
      content: z.string(),
      message: z.string().optional(),
    }),
  },
  ls: {
    description: "List immediate children of a directory. Returns { entries } where each entry has name, type (file/directory), size, author, modifiedAt.",
    handler: ls,
    schema: z.object({ path: z.string() }),
  },
  stat: {
    description: "Get file metadata without reading content. Returns path, size, contentType, author, currentVersion, createdAt, modifiedAt, isDeleted, embeddingStatus.",
    handler: stat,
    schema: z.object({ path: z.string() }),
  },
  rm: {
    description: "Delete a file. Removes from S3, cleans up FTS5 index and vector embeddings. Returns { path, deleted }.",
    handler: rm,
    schema: z.object({ path: z.string() }),
  },
  mv: {
    description: "Move or rename a file. Preserves version history at the new path. Returns { from, to, version }.",
    handler: mv,
    schema: z.object({
      from: z.string(),
      to: z.string(),
      message: z.string().optional(),
    }),
  },
  cp: {
    description: "Copy a file using server-side S3 copy. Creates a new version at the destination. Returns { from, to, version }.",
    handler: cp,
    schema: z.object({
      from: z.string(),
      to: z.string(),
    }),
  },
  tail: {
    description: "Read the last N lines of a file (default 20). Returns { content, totalLines, truncated }.",
    handler: tail,
    schema: z.object({
      path: z.string(),
      lines: z.number().int().min(1).optional(),
    }),
  },
  log: {
    description: "Show version history for a file. Returns { versions } with version number, author, timestamp, operation type, message, and diff summary.",
    handler: log,
    schema: z.object({
      path: z.string(),
      limit: z.number().int().min(1).optional(),
    }),
  },
  diff: {
    description: "Show the diff between two versions of a file. Specify v1 and v2 version numbers. Returns { changes } as add/remove/context hunks.",
    handler: diff,
    schema: z.object({
      path: z.string(),
      v1: z.number().int(),
      v2: z.number().int(),
    }),
  },
  revert: {
    description: "Revert a file to a previous version. Creates a new version with the old content. Returns { version, revertedTo }.",
    handler: revert,
    schema: z.object({
      path: z.string(),
      version: z.number().int(),
    }),
  },
  recent: {
    description: "Show recent activity across the drive. Optionally filter by path prefix and time window (since). Returns { entries } with path and version details.",
    handler: recent,
    schema: z.object({
      path: z.string().optional(),
      since: z.coerce.date().optional(),
      limit: z.number().int().min(1).optional(),
    }),
  },
  grep: {
    description: "Search file content using regex pattern within a specific path. Returns matching lines with line numbers. Searches the FTS5 index, not S3 directly.",
    handler: grep,
    schema: z.object({
      pattern: z.string(),
      path: z.string(),
    }),
  },
  fts: {
    description: "Full-text search across all file content using FTS5 tokens. Different from grep (regex) and search (semantic). Returns { matches } with path, snippet, and rank.",
    handler: fts,
    schema: z.object({
      pattern: z.string(),
      path: z.string().optional(),
    }),
  },
  search: {
    description: "Semantic/vector search using natural language queries. Requires an embedding provider (OPENAI_API_KEY or GEMINI_API_KEY). Returns { results } ranked by relevance.",
    handler: search,
    schema: z.object({
      query: z.string(),
      limit: z.number().int().min(1).optional(),
    }),
  },
  reindex: {
    description: "Re-index files with failed or missing FTS5/embedding entries. Optionally scope to a path prefix. Use after bulk writes or provider changes.",
    handler: reindex,
    schema: z.object({
      path: z.string().optional(),
    }),
  },
  tree: {
    description: "Recursively list all files and directories. Use depth to limit recursion. Returns a nested tree structure with name, type, size, and children.",
    handler: tree,
    schema: z.object({
      path: z.string(),
      depth: z.number().int().min(1).optional(),
    }),
  },
  glob: {
    description: "Find files by name pattern (e.g., *.md, config.*). Optionally scope to a path prefix. Returns { matches } with path, size, and modifiedAt.",
    handler: glob,
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
export { write, cat, edit, append, ls, stat, rm, mv, cp, tail, log, diff, revert, recent, grep, fts, search, reindex, tree, glob };
export type * from "./types.js";

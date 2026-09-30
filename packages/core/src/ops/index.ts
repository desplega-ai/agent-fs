import { z } from "zod";
import type { OpContext } from "./types.js";
import { checkPermission, getRequiredRole } from "../identity/rbac.js";
import { write, writeRaw } from "./write.js";
import { cat } from "./cat.js";
import { edit } from "./edit.js";
import { append } from "./append.js";
import { ls } from "./ls.js";
import { stat } from "./stat.js";
import { reveal } from "./reveal.js";
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
import { vecSearch } from "./vec-search.js";
import { search } from "./search.js";
import { reindex } from "./reindex.js";
import { tree } from "./tree.js";
import { glob } from "./glob.js";
import { sql } from "./sql.js";
import { signedUrl } from "./signed-url.js";
import { shareCreate, shareRevoke } from "./share.js";
import { buildAppUrl } from "./urls.js";
import { recordOp } from "../telemetry.js";
import {
  commentAdd,
  commentList,
  commentGet,
  commentUpdate,
  commentDelete,
  commentResolve,
} from "./comment.js";
import {
  commentNotificationList,
  commentNotificationRead,
} from "./comment-notification.js";
import { driveMembers } from "./drive-members.js";

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
    description: "Read file content with optional pagination via offset/limit; defaults to the first 200 lines when limit is omitted. Returns { content, totalLines, truncated } — always check `truncated` before trusting a row/line count. For a complete, byte-exact read (e.g. before parsing as CSV/JSON), use `download` instead.",
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
      expectedVersion: z.number().int().optional(),
    }),
  },
  append: {
    description: "Append content to the end of an existing file. Creates a new version. Returns { version, size }.",
    handler: append,
    schema: z.object({
      path: z.string(),
      content: z.string(),
      message: z.string().optional(),
      expectedVersion: z.number().int().optional(),
    }),
  },
  ls: {
    description: "List immediate children of a directory. Returns { entries } where each entry has name, type (file/directory), size, author, modifiedAt.",
    handler: ls,
    schema: z.object({ path: z.string().optional() }),
  },
  stat: {
    description: "Get file metadata without reading content. Returns path, size, contentType, author, currentVersion, createdAt, modifiedAt, isDeleted, embeddingStatus, etag (opaque id of the current bytes, compare for equality).",
    handler: stat,
    schema: z.object({ path: z.string() }),
  },
  reveal: {
    description: "Everything needed to show one file in a tree, in one call: the ls listing of every ancestor directory (root first) plus the file's stat. Returns { path, stat, listings } where each listing is { path, entries } with entries shaped exactly like ls.",
    handler: reveal,
    schema: z.object({ path: z.string() }),
  },
  rm: {
    description: "Delete a file. Removes from S3, cleans up FTS5 index and vector embeddings. Returns { path, deleted }.",
    handler: rm,
    schema: z.object({
      path: z.string(),
      expectedVersion: z.number().int().optional(),
    }),
  },
  mv: {
    description: "Move or rename a file. Preserves version history at the new path. Returns { from, to, version }.",
    handler: mv,
    schema: z.object({
      from: z.string(),
      to: z.string(),
      message: z.string().optional(),
      expectedVersion: z.number().int().optional(),
    }),
  },
  cp: {
    description: "Copy a file using server-side S3 copy. Creates a new version at the destination. Returns { from, to, version }.",
    handler: cp,
    schema: z.object({
      from: z.string(),
      to: z.string(),
      expectedVersion: z.number().int().optional(),
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
    description: "Show the diff between two versions of a file. Specify v1 and v2 version numbers. Returns { changes } as add/remove/context hunks; when file content was diffed each change carries oldLine/newLine.",
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
      expectedVersion: z.number().int().optional(),
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
    description: "Hybrid search combining semantic (vector) and keyword (FTS5) matching. Best for natural language queries. Degrades to keyword-only without an embedding provider.",
    handler: search,
    schema: z.object({
      query: z.string(),
      limit: z.number().int().min(1).optional(),
    }),
  },
  "vec-search": {
    description: "Vector-only semantic search using embeddings. Returns results ranked by cosine similarity. Requires an embedding provider (OPENAI_API_KEY, GEMINI_API_KEY, or local).",
    handler: vecSearch,
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
      path: z.string().optional(),
      depth: z.number().int().min(1).optional(),
    }),
  },
  glob: {
    description: "Find files by name pattern. Use `*.md` for root-level files only, `**/*.md` for recursive matching across all subdirectories. Supports `*` (any chars except /), `?` (single char), `**` (any path depth). Optionally scope to a path prefix. Returns { matches } with path, size, and modifiedAt.",
    handler: glob,
    schema: z.object({
      pattern: z.string(),
      path: z.string().optional(),
    }),
  },
  sql: {
    description: "Run a DuckDB SQL query over documents stored in the drive. Reference documents directly by path string literal (e.g. SELECT * FROM '/data/sales.csv') or bind them as named tables via `tables` ({ name: path } or { name: { path, format } } to override format detection). Supports csv, tsv, parquet, xlsx, json, ndjson/jsonl (each also .gz except parquet/xlsx), sqlite (.db/.sqlite/.sqlite3, tables exposed as name.tablename), and .duckdb files. Queries run sandboxed: no filesystem or network access beyond the bound documents. Returns { columns, rows, rowCount, truncated, files, elapsedMs }.",
    handler: sql,
    schema: z.object({
      query: z.string(),
      tables: z
        .record(
          z.union([
            z.string(),
            z.object({
              path: z.string(),
              format: z
                .enum(["csv", "tsv", "parquet", "xlsx", "json", "ndjson", "sqlite", "duckdb"])
                .optional(),
            }),
          ])
        )
        .optional(),
      maxRows: z.number().int().min(1).max(10000).optional(),
    }),
  },
  "signed-url": {
    description: "Generate a temporary presigned URL for direct file download. Default expiry is 24 hours (86400 seconds). The URL requires no authentication. Set disposition to \"inline\" when the URL will be rendered in the browser (PDF in an iframe, image in a tab); the default \"attachment\" forces a download. Returns { url, path, expiresIn, expiresAt, kind }.",
    handler: signedUrl,
    schema: z.object({
      path: z.string(),
      expiresIn: z.number().int().min(60).max(604800).optional(),
      disposition: z.enum(["inline", "attachment"]).optional(),
    }),
  },
  "share-create": {
    description: "Create a public share link for a file: an unauthenticated /share/<token> page on the API host with a preview (markdown, text/code, image, PDF, audio, video) and a Download button. Default expiry is 24 hours (max 7 days); set maxViews to limit how often the page can be opened (maxViews=1 is a one-off link). Anyone with the link can open it, so share deliberately. Returns { id, url, sharePath, path, expiresIn, expiresAt, maxViews }. The link is shown only once; keep the id to revoke it.",
    handler: shareCreate,
    schema: z.object({
      path: z.string(),
      expiresIn: z.number().int().min(60).max(604800).optional(),
      maxViews: z.number().int().min(1).max(1000000).optional(),
    }),
  },
  "share-revoke": {
    description: "Revoke share links so they stop working immediately. Pass exactly one of: id (from share-create), token (the token or the full share URL), or path (revokes every link to that file). Only the link's creator or a drive admin can revoke. Returns { revoked, ids }.",
    handler: shareRevoke,
    schema: z.object({
      id: z.string().optional(),
      token: z.string().optional(),
      path: z.string().optional(),
    }),
  },
  "comment-add": {
    description: "Add a comment to a file. Supports line ranges, a text-quote anchor ({ exact, prefix, suffix }), and threading via parentId. Replies auto-resolve path from parent. Returns { id, path, body, author, createdAt }.",
    handler: commentAdd,
    schema: z.object({
      path: z.string().optional(),
      body: z.string(),
      parentId: z.string().optional(),
      lineStart: z.number().int().optional(),
      lineEnd: z.number().int().optional(),
      quotedContent: z.string().optional(),
      quote: z
        .object({
          exact: z.string(),
          prefix: z.string().optional(),
          suffix: z.string().optional(),
        })
        .optional()
        .describe("Text-quote anchor: the exact selected text plus ~32 chars of context before (prefix) and after (suffix). Lets viewers re-find the selection after the file is edited."),
    }),
  },
  "comment-list": {
    description: "List comments on a file or below a path prefix. Filter by path, pathPrefix, resolved state, or parentId. Defaults to unresolved root comments. Returns { comments } with inline replies.",
    handler: commentList,
    schema: z
      .object({
        path: z.string().optional(),
        pathPrefix: z.string().optional(),
        parentId: z.string().optional(),
        resolved: z.boolean().optional(),
        orgId: z.string().optional(),
        limit: z.number().int().min(1).optional(),
        offset: z.number().int().min(0).optional(),
      })
      .refine(
        ({ path, pathPrefix }) => path === undefined || pathPrefix === undefined,
        { message: "path and pathPrefix cannot be used together" }
      ),
  },
  "comment-get": {
    description: "Get a single comment by ID with all its replies. Returns { comment, replies }.",
    handler: commentGet,
    schema: z.object({
      id: z.string(),
    }),
  },
  "comment-update": {
    description: "Update a comment's body. Only the original author can update. Returns { id, body, updatedAt }.",
    handler: commentUpdate,
    schema: z.object({
      id: z.string(),
      body: z.string(),
    }),
  },
  "comment-delete": {
    description: "Soft-delete a comment. Only the original author can delete. Deleting a root comment also soft-deletes its replies. Returns { deleted }.",
    handler: commentDelete,
    schema: z.object({
      id: z.string(),
    }),
  },
  "comment-resolve": {
    description: "Resolve or reopen a root comment. Set resolved=true to resolve, resolved=false to reopen. Only root comments can be resolved. Returns { id, resolved, resolvedBy, resolvedAt }.",
    handler: commentResolve,
    schema: z.object({
      id: z.string(),
      resolved: z.boolean(),
    }),
  },
  "comment-notification-list": {
    description: "List comment notifications for the current user in the active drive. Returns { notifications, unreadCount }.",
    handler: commentNotificationList,
    schema: z.object({
      unreadOnly: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    }),
  },
  "comment-notification-read": {
    description: "Mark selected comment notification IDs, or all comment notifications in the active drive, as read. Returns { markedRead }.",
    handler: commentNotificationRead,
    schema: z.object({
      ids: z.array(z.string()).min(1).max(100).optional(),
      all: z.literal(true).optional(),
    }),
  },
  "drive-members": {
    description: "List members of the active drive. Returns { members } with userId, email, and displayName. Membership roles are not included.",
    handler: driveMembers,
    schema: z.object({}),
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
  const result = await op.handler(ctx, validated);
  recordOp(opName);

  // Enrich results with appUrl when available
  if (ctx.appUrl && result && typeof result === "object") {
    if ("path" in result) {
      (result as any).appUrl = buildAppUrl(ctx.appUrl, ctx.orgId, ctx.driveId, (result as any).path);
    } else if ("to" in result) {
      (result as any).appUrl = buildAppUrl(ctx.appUrl, ctx.orgId, ctx.driveId, (result as any).to);
    }
  }

  return result;
}

export function getRegisteredOps(): string[] {
  return Object.keys(opRegistry);
}

export function getOpDefinition(name: string): OpDefinition | undefined {
  return opRegistry[name];
}

// Re-export individual ops for direct use
export { write, writeRaw, cat, edit, append, ls, stat, reveal, rm, mv, cp, tail, log, diff, revert, recent, grep, fts, search, vecSearch, reindex, tree, glob, sql, signedUrl, shareCreate, shareRevoke, commentAdd, commentList, commentGet, commentUpdate, commentDelete, commentResolve, commentNotificationList, commentNotificationRead, driveMembers };
export type * from "./types.js";

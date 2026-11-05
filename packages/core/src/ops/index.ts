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
import { find } from "./find.js";
import { sql } from "./sql.js";
import { signedUrl } from "./signed-url.js";
import { shareCreate, shareRevoke } from "./share.js";
import { shareList, SHARE_LIST_MAX_LIMIT } from "./share-list.js";
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
import { favoriteAdd, favoriteRemove, favoriteList } from "./favorite.js";
import {
  webhookCreate,
  webhookList,
  webhookUpdate,
  webhookDelete,
  webhookTest,
  webhookDeliveries,
  webhookRedeliver,
} from "./webhook.js";
import { WEBHOOK_EVENT_TYPES } from "../webhooks/events.js";
import { MAX_DELIVERIES_LIMIT } from "../webhooks/deliveries.js";

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
    description: "Get file metadata without reading content. Returns path, size, contentType, author, currentVersion, createdAt, modifiedAt, isDeleted, embeddingStatus, etag (opaque id of the current bytes, compare for equality). Embedding status is pending, indexed, failed, or skipped.",
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
    description: "Show the diff between two versions of a file. Specify v1 and v2 version numbers. Returns { changes, source } as add/remove/context hunks; when file content was diffed each change carries oldLine/newLine. source is 'content' when both versions were compared, 'summary' when changes come from the stored edit summary, or 'none' when the versions were not compared at all. Only source 'content' with empty changes means the versions are identical.",
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
    description: "Re-index files with failed or missing FTS5/embedding entries. Skip files with indexed or skipped status. Optionally scope to a path prefix. Use after bulk writes or provider changes.",
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
    description: "Find files by name pattern. Use `*.md` for root-level files only, `**/*.md` for recursive matching across all subdirectories. Supports `*` (any chars except /), `?` (single char), `**` (any path depth). Optionally scope to a path prefix. Case-sensitive. To look up a file by an approximate name, use find. Returns { matches } with path, size, and modifiedAt.",
    handler: glob,
    schema: z.object({
      pattern: z.string(),
      path: z.string().optional(),
    }),
  },
  find: {
    description: "Find files by approximate name. Matching is case- and accent-insensitive. Every query word must match the path, in any order. When no file has every word as typed, letters can be skipped (\"zphr\" finds \"Zephyr.pdf\"). File-name hits rank above folder hits. Optionally scope to a path prefix. Returns { matches, total }: matches holds path, size, modifiedAt, and score, best first, capped at limit (default 50). total counts all matching files.",
    handler: find,
    schema: z.object({
      query: z.string().min(1),
      path: z.string().optional(),
      limit: z.number().int().min(1).max(500).optional(),
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
    description: "Create a public share link for a file or folder. A file gets an unauthenticated /share/<token> page on the API host with a preview (markdown, text/code, image, PDF, audio, video, and HTML pages rendered in a sandboxed frame with only that file shared) and a Download button. A folder becomes an HTML site (kind \"site\") at /site/<token>/: index.html is the entry page (without one, the only HTML page opens, or else a list of the HTML pages), relative paths resolve inside the folder, and pages run in a sandbox with no cookies or localStorage. A site page can read every file under its folder while the link is valid. Default expiry is 24 hours (max 7 days); expiresIn null makes a link with no time limit, which ends only with share-revoke or at maxViews. Set maxViews to limit how often a file page can be opened (maxViews=1 is a one-off link; folders reject maxViews). Anyone with the link can open it, so share deliberately. Returns { id, kind, url, urlSource, sharePath, path, expiresIn, expiresAt, maxViews } (expiresIn and expiresAt are null for a link that never expires); urlSource (always present) is \"configured\" when url is built on AGENT_FS_PUBLIC_URL, \"request\" when it comes from the request's Host (resolve sharePath against the address you reached the API at). The link is shown only once; keep the id to revoke it.",
    handler: shareCreate,
    schema: z.object({
      path: z.string(),
      expiresIn: z.number().int().min(60).max(604800).nullable().optional(),
      maxViews: z.number().int().min(1).max(1000000).optional(),
    }),
  },
  "share-revoke": {
    description: "Revoke share links so they stop working immediately. Pass exactly one of: id (from share-create), token (the token or the full share URL), or path (revokes every link to that file or folder). Only the link's creator or a drive admin can revoke. Returns { revoked, ids }.",
    handler: shareRevoke,
    schema: z.object({
      id: z.string().optional(),
      token: z.string().optional(),
      path: z.string().optional(),
    }),
  },
  "comment-add": {
    description: "Add a comment to a file. Supports line ranges, a text-quote anchor ({ exact, prefix, suffix }), mentions by drive-member user ID or email, and threading via parentId. Replies auto-resolve path from parent. Returns { id, path, body, author, createdAt }.",
    handler: commentAdd,
    schema: z.object({
      path: z.string().optional(),
      body: z.string(),
      parentId: z.string().optional(),
      mentions: z.array(z.string().min(1)).max(20).optional(),
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
    description: "Update a comment's body and optionally replace its mentions. Mentions accept drive-member user IDs or emails. Only the original author can update. Returns { id, body, updatedAt }.",
    handler: commentUpdate,
    schema: z.object({
      id: z.string(),
      body: z.string(),
      mentions: z.array(z.string().min(1)).max(20).optional(),
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
    description: "List comment or mention notifications for the current user in the active drive. Defaults to comment notifications. Returns { notifications, unreadCount }.",
    handler: commentNotificationList,
    schema: z.object({
      unreadOnly: z.boolean().optional(),
      kinds: z.array(z.enum(["comment", "mention"])).min(1).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    }),
  },
  "comment-notification-read": {
    description: "Mark selected comment or mention notification IDs, or all notifications of the selected kinds in the active drive, as read. All defaults to comment notifications. Returns { markedRead }.",
    handler: commentNotificationRead,
    schema: z.object({
      ids: z.array(z.string()).min(1).max(100).optional(),
      all: z.literal(true).optional(),
      kinds: z.array(z.enum(["comment", "mention"])).min(1).optional(),
    }),
  },
  "drive-members": {
    description: "List members of the active drive. Returns { members } with userId, email, and displayName. Membership roles are not included.",
    handler: driveMembers,
    schema: z.object({}),
  },
  "favorite-add": {
    description: "Star a file or folder for the current user. Favorites are personal: no other user sees them. Starring twice is a no-op. Moving or renaming a starred file keeps the star; deleting it removes the star, and a folder's star goes away once the folder is gone. Returns { path, kind, createdAt, favorited }.",
    handler: favoriteAdd,
    schema: z.object({ path: z.string() }),
  },
  "favorite-remove": {
    description: "Remove the current user's star from a file or folder. Works even when the path no longer exists. Returns { path, removed } where removed is false when there was no star.",
    handler: favoriteRemove,
    schema: z.object({ path: z.string() }),
  },
  "favorite-list": {
    description: "List the current user's favorites in the active drive, sorted by path. Returns { favorites } with path, kind (file/directory), and createdAt.",
    handler: favoriteList,
    schema: z.object({}),
  },
  "webhook-create": {
    description: "Create an outbound webhook that POSTs signed Standard Webhooks events (comment.created, comment.mentioned, comment.updated, comment.resolved, comment.reopened, comment.deleted) to url. scope 'drive' (default) covers the active drive and needs drive admin or org admin; scope 'org' covers every drive in the org and needs org admin. The url must be public https (private/loopback targets only via the server's AGENT_FS_WEBHOOK_ALLOWED_HOSTS). Returns the webhook plus its whsec_ signing secret, shown only this once. Delivery needs AGENT_FS_WEBHOOK_WORKER on the server (see workerEnabled).",
    handler: webhookCreate,
    schema: z.object({
      scope: z.enum(["drive", "org"]).optional().describe("drive (default): the active drive only. org: every drive in the org (org admin only)."),
      url: z.string().url().max(2048),
      eventTypes: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1).max(6),
      description: z.string().max(500).optional(),
    }),
  },
  "webhook-list": {
    description: "List outbound webhooks. scope 'drive' needs drive admin or org admin, 'org' needs org admin, and 'all' (default) returns this drive's hooks for a drive admin plus the org's hooks for an org admin. Never returns signing secrets. Returns { webhooks }.",
    handler: webhookList,
    schema: z.object({
      scope: z.enum(["drive", "org", "all"]).optional(),
    }),
  },
  "webhook-update": {
    description: "Update a webhook's url, eventTypes or description, enable or disable it, or rotate its signing secret. Needs drive admin or org admin for a drive hook, org admin for an org hook. enabled=true clears the disabled state and failure counters; enabled=false fails its pending deliveries. rotateSecret=true returns the new whsec_ secret once; the old secret stops working at once (no grace period). Returns the webhook.",
    handler: webhookUpdate,
    schema: z.object({
      id: z.string(),
      url: z.string().url().max(2048).optional(),
      eventTypes: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1).max(6).optional(),
      description: z.string().max(500).optional().describe("An empty string clears it."),
      enabled: z.boolean().optional(),
      rotateSecret: z.boolean().optional(),
    }),
  },
  "webhook-delete": {
    description: "Delete a webhook and its delivery history. Needs drive admin or org admin for a drive hook, org admin for an org hook. Returns { deleted }.",
    handler: webhookDelete,
    schema: z.object({
      id: z.string(),
    }),
  },
  "webhook-test": {
    description: "Send a signed ping event to a webhook now, inline, and report the receiver's answer. Works with the delivery worker off and does not count toward failures. Needs drive admin or org admin for a drive hook, org admin for an org hook. Returns { ok, statusCode, error, durationMs, webhookId }.",
    handler: webhookTest,
    schema: z.object({
      id: z.string(),
    }),
  },
  "share-list": {
    description: "List share links without revealing them: the link itself is shown only once, by share-create, and is never listed. scope \"drive\" (default) lists links in the active drive; drive admins see every member's links, everyone else only their own. With path, it returns the links on that file or folder plus folder (site) links on any parent folder that also publish it (relation \"exact\" or \"covering\"). scope \"mine\" lists your own links in every drive of this org you are a member of (one org, never across orgs; path not allowed). Active links only unless includeInactive is true. Newest first; limit (default 100, max 500) and offset page through total. Returns { shares, total, limit, offset, scope, visibility } where each share has id, drive { id, name }, path, kind (file/site), relation, status (active/expired/exhausted/revoked), createdAt, createdBy { userId, email, displayName }, expiresAt (null = never expires), views, maxViews, lastViewedAt, revokedAt, canRevoke, and appUrl when configured. Revoke a link with share-revoke and its id, on the drive in drive.id.",
    handler: shareList,
    schema: z.object({
      scope: z.enum(["drive", "mine"]).optional(),
      path: z.string().optional(),
      includeInactive: z.boolean().optional(),
      limit: z.number().int().min(1).max(SHARE_LIST_MAX_LIMIT).optional(),
      offset: z.number().int().min(0).optional(),
    }),
  },
  "webhook-deliveries": {
    description: "List a webhook's delivery log, newest first: status (pending, delivered, failed), attempts, next attempt, last status code and error. Omits each delivery's payload unless includePayload is true (it is then the exact JSON body that was signed and sent). Delivered and failed rows are pruned after 30 days. Needs drive admin or org admin for a drive hook, org admin for an org hook. Returns { deliveries, nextCursor }; pass nextCursor back as cursor for the next page (null on the last page).",
    handler: webhookDeliveries,
    schema: z.object({
      id: z.string().describe("Webhook id."),
      status: z.enum(["pending", "delivered", "failed"]).optional(),
      limit: z.number().int().min(1).max(MAX_DELIVERIES_LIMIT).optional().describe("Page size, default 50."),
      cursor: z.string().max(512).optional().describe("nextCursor from the previous page."),
      includePayload: z.boolean().optional(),
    }),
  },
  "webhook-redeliver": {
    description: "Queue one delivery to be sent again now with the same webhook-id and body: sets it pending, due now, and keeps its attempt count (a row past the retry schedule gets this one attempt, no further retries). Refused while the webhook is disabled (re-enable it with webhook-update enabled=true first) and while the delivery is being sent. Needs the same role as the webhook. Sent by the delivery worker (AGENT_FS_WEBHOOK_WORKER). Returns the delivery.",
    handler: webhookRedeliver,
    schema: z.object({
      deliveryId: z.string(),
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
export { write, writeRaw, cat, edit, append, ls, stat, reveal, rm, mv, cp, tail, log, diff, revert, recent, grep, fts, search, vecSearch, reindex, tree, glob, find, sql, signedUrl, shareCreate, shareRevoke, commentAdd, commentList, commentGet, commentUpdate, commentDelete, commentResolve, commentNotificationList, commentNotificationRead, driveMembers, favoriteAdd, favoriteRemove, favoriteList, webhookCreate, webhookList, webhookUpdate, webhookDelete, webhookTest, webhookDeliveries, webhookRedeliver };
export { shareList };
export type * from "./types.js";

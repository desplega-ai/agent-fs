import { eq, and, sql, desc, ne, inArray, notInArray } from "drizzle-orm";
import { schema } from "../db/index.js";
import type {
  OpContext,
  CommentAddParams,
  CommentAddResult,
  CommentListParams,
  CommentListResult,
  CommentListEntry,
  CommentGetParams,
  CommentGetResult,
  CommentUpdateParams,
  CommentUpdateResult,
  CommentDeleteParams,
  CommentDeleteResult,
  CommentResolveParams,
  CommentResolveResult,
  CommentEntry,
  CommentQuote,
} from "./types.js";
import { NotFoundError, ValidationError, PermissionDeniedError } from "../errors.js";
import { normalizePrefix } from "./paths.js";
import { publishDriveEvent, type DriveEvent } from "../events/bus.js";
import {
  COMMENT_MENTION_EVENT,
  COMMENT_NOTIFICATION_EVENT,
  addMentions,
  emitCommentNotificationEvents,
  emitMentionNotifications,
  resolveMentions,
  saveMentions,
} from "./comment-mentions.js";

// --- Event helper ---

function emitEvent(
  ctx: OpContext,
  params: {
    type: string;
    resourceType: string;
    resourceId: string;
    target?: string;
    metadata?: Record<string, unknown>;
  }
) {
  ctx.db
    .insert(schema.events)
    .values({
      id: crypto.randomUUID(),
      orgId: ctx.orgId,
      type: params.type,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      actor: ctx.userId,
      target: params.target ?? null,
      status: "created",
      metadata: params.metadata ? JSON.stringify(params.metadata) : null,
      createdAt: new Date(),
    })
    .run();
}

function publishCommentChange(
  ctx: OpContext,
  comment: { id: string; path: string; parentId?: string | null },
  action: Extract<DriveEvent, { type: "comment.changed" }>["action"],
  at: Date
) {
  publishDriveEvent({
    type: "comment.changed",
    driveId: ctx.driveId,
    path: comment.path,
    commentId: comment.id,
    parentId: comment.parentId ?? null,
    action,
    actor: ctx.userId,
    at: at.toISOString(),
  });
}

function emitCommentNotifications(
  ctx: OpContext,
  params: { commentId: string; path: string; parentId?: string; createdAt: Date }
) {
  const recipients = ctx.db
    .select({ userId: schema.driveMembers.userId })
    .from(schema.driveMembers)
    .where(
      and(
        eq(schema.driveMembers.driveId, ctx.driveId),
        ne(schema.driveMembers.userId, ctx.userId)
      )
    )
    .all();

  if (recipients.length === 0) return;

  emitCommentNotificationEvents(ctx, {
    eventType: COMMENT_NOTIFICATION_EVENT,
    commentId: params.commentId,
    userIds: recipients.map(({ userId }) => userId),
    metadata: { path: params.path, parentId: params.parentId },
    createdAt: params.createdAt,
  });
}

// --- Helpers ---

/**
 * Fetch a live (non-deleted) comment by ID, scoped to the active org and
 * drive. Out-of-scope comment IDs behave exactly like missing IDs (callers
 * throw NotFoundError), so comment IDs never act as a cross-tenant
 * existence oracle.
 */
function getScopedComment(ctx: OpContext, id: string) {
  return ctx.db
    .select()
    .from(schema.comments)
    .where(
      and(
        eq(schema.comments.id, id),
        eq(schema.comments.orgId, ctx.orgId),
        eq(schema.comments.driveId, ctx.driveId),
        eq(schema.comments.isDeleted, false)
      )
    )
    .get();
}

// Quote anchors only need enough text to re-find the selection; cap what we
// store rather than reject, so a long selection never fails comment-add.
const QUOTE_EXACT_MAX = 4000;
const QUOTE_CONTEXT_MAX = 64;

function normalizeQuote(quote: CommentQuote | undefined): CommentQuote | undefined {
  if (!quote || !quote.exact) return undefined;
  return {
    exact: quote.exact.slice(0, QUOTE_EXACT_MAX),
    // Keep the context closest to the selection.
    prefix: quote.prefix ? quote.prefix.slice(-QUOTE_CONTEXT_MAX) : undefined,
    suffix: quote.suffix ? quote.suffix.slice(0, QUOTE_CONTEXT_MAX) : undefined,
  };
}

function toCommentEntry(row: any): CommentEntry {
  return {
    id: row.id,
    parentId: row.parentId ?? undefined,
    path: row.path,
    lineStart: row.lineStart ?? undefined,
    lineEnd: row.lineEnd ?? undefined,
    quotedContent: row.quotedContent ?? undefined,
    quote: row.quoteExact
      ? {
          exact: row.quoteExact,
          prefix: row.quotePrefix ?? undefined,
          suffix: row.quoteSuffix ?? undefined,
        }
      : undefined,
    body: row.body,
    author: row.author,
    resolved: row.resolved ?? false,
    resolvedBy: row.resolvedBy ?? undefined,
    resolvedAt: row.resolvedAt ?? undefined,
    fileVersionId: row.fileVersionId ?? undefined,
    replyCount: row.replyCount ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// This lookup adds display names to comments. Member emails are available through
// drive-members, while membership roles remain private to admin surfaces.
function addAuthorNames<T extends { author: string; authorDisplayName?: string }>(ctx: OpContext, entries: T[]): T[] {
  const ids = [...new Set(entries.map((entry) => entry.author))];
  if (!ids.length) return entries;
  const users = ctx.db.select({ id: schema.users.id, displayName: schema.users.displayName })
    .from(schema.users).where(inArray(schema.users.id, ids)).all();
  const names = new Map(users.map((user) => [user.id, user.displayName]));
  for (const entry of entries) entry.authorDisplayName = names.get(entry.author) ?? undefined;
  return entries;
}

// Resolve fileVersionId (a file_versions row id) to its version number so
// clients can diff the anchor version against the current one.
function addFileVersions<T extends { fileVersionId?: number; fileVersion?: number }>(ctx: OpContext, entries: T[]): T[] {
  const ids = [...new Set(entries.flatMap((entry) => entry.fileVersionId ?? []))];
  if (!ids.length) return entries;
  const rows = ctx.db.select({ id: schema.fileVersions.id, version: schema.fileVersions.version })
    .from(schema.fileVersions)
    .where(and(inArray(schema.fileVersions.id, ids), eq(schema.fileVersions.driveId, ctx.driveId)))
    .all();
  const versions = new Map(rows.map((row) => [row.id, row.version]));
  for (const entry of entries) {
    if (entry.fileVersionId !== undefined) entry.fileVersion = versions.get(entry.fileVersionId);
  }
  return entries;
}

// --- Handlers ---

export async function commentAdd(
  ctx: OpContext,
  params: CommentAddParams
): Promise<CommentAddResult> {
  const now = new Date();
  const id = crypto.randomUUID();
  let path = params.path;

  if (params.parentId) {
    // Resolve parent (scoped to the active org/drive)
    const parent = getScopedComment(ctx, params.parentId);

    if (!parent) {
      throw new NotFoundError("Parent comment not found", {
        suggestion: "Check that the parent comment ID is correct and not deleted",
      });
    }

    // Flat threading: replies only to root comments
    if (parent.parentId) {
      throw new ValidationError("Cannot reply to a reply — only root comments accept replies", {
        suggestion: "Reply to the root comment instead",
      });
    }

    // Resolve path from parent if not provided
    if (!path) {
      path = parent.path;
    }
  }

  if (!path) {
    throw new ValidationError("path is required for root comments", {
      field: "path",
    });
  }

  const mentionUserIds = params.mentions
    ? resolveMentions(ctx, params.mentions)
    : [];
  const quote = normalizeQuote(params.quote);

  // Capture current file version ID
  const currentVersion = ctx.db
    .select({ id: schema.fileVersions.id })
    .from(schema.fileVersions)
    .where(
      and(
        eq(schema.fileVersions.path, path),
        eq(schema.fileVersions.driveId, ctx.driveId)
      )
    )
    .orderBy(desc(schema.fileVersions.id))
    .limit(1)
    .get();

  ctx.db.transaction((tx) => {
    const txCtx = { ...ctx, db: tx as unknown as typeof ctx.db };
    tx.insert(schema.comments)
      .values({
        id,
        parentId: params.parentId ?? null,
        orgId: ctx.orgId,
        driveId: ctx.driveId,
        path,
        lineStart: params.lineStart ?? null,
        lineEnd: params.lineEnd ?? null,
        quotedContent: params.quotedContent ?? null,
        quoteExact: quote?.exact ?? null,
        quotePrefix: quote?.prefix ?? null,
        quoteSuffix: quote?.suffix ?? null,
        fileVersionId: currentVersion?.id ?? null,
        body: params.body,
        author: ctx.userId,
        resolved: false,
        createdAt: now,
        updatedAt: now,
        isDeleted: false,
      })
      .run();

    const newMentionUserIds = saveMentions(txCtx, id, mentionUserIds);
    emitMentionNotifications(txCtx, {
      commentId: id,
      path,
      parentId: params.parentId,
      userIds: newMentionUserIds,
      createdAt: now,
    });
    emitEvent(txCtx, {
      type: "comment_created",
      resourceType: "comment",
      resourceId: id,
      metadata: { path, parentId: params.parentId },
    });
    emitCommentNotifications(txCtx, {
      commentId: id,
      path,
      parentId: params.parentId,
      createdAt: now,
    });
  });
  publishCommentChange(ctx, { id, path, parentId: params.parentId }, "created", now);

  return addAuthorNames(ctx, [{
    id,
    path,
    body: params.body,
    parentId: params.parentId,
    lineStart: params.lineStart,
    lineEnd: params.lineEnd,
    quote,
    author: ctx.userId,
    createdAt: now,
  }])[0];
}

export async function commentList(
  ctx: OpContext,
  params: CommentListParams
): Promise<CommentListResult> {
  const conditions = [
    eq(schema.comments.orgId, ctx.orgId),
    eq(schema.comments.driveId, ctx.driveId),
    eq(schema.comments.isDeleted, false),
  ];

  if (params.path) {
    conditions.push(eq(schema.comments.path, params.path));
  }

  if (params.pathPrefix !== undefined) {
    const prefix = normalizePrefix(params.pathPrefix);
    if (prefix !== "/") {
      const relativePrefix = prefix.slice(1);
      // "0" is the BINARY-collation upper bound after a trailing "/".
      const prefixUpper = prefix.slice(0, -1) + "0";
      const relativePrefixUpper = relativePrefix.slice(0, -1) + "0";
      conditions.push(sql`(
        (${schema.comments.path} >= ${prefix} AND ${schema.comments.path} < ${prefixUpper})
        OR
        (${schema.comments.path} >= ${relativePrefix} AND ${schema.comments.path} < ${relativePrefixUpper})
      )`);
    }
  }

  if (params.parentId) {
    conditions.push(eq(schema.comments.parentId, params.parentId));
  } else if (params.parentId === undefined && !params.resolved) {
    // Default: show only root comments that are unresolved
    conditions.push(sql`${schema.comments.parentId} IS NULL`);
    conditions.push(eq(schema.comments.resolved, false));
  } else if (params.parentId === undefined && params.resolved) {
    // Show root comments filtered by resolved state
    conditions.push(sql`${schema.comments.parentId} IS NULL`);
  }

  if (params.orgId) {
    conditions.push(eq(schema.comments.orgId, params.orgId));
  }

  const limit = params.limit ?? 50;
  const offset = params.offset ?? 0;

  const rows = ctx.db
    .select()
    .from(schema.comments)
    .where(and(...conditions))
    .orderBy(desc(schema.comments.createdAt))
    .limit(limit)
    .offset(offset)
    .all();

  // Fetch replies inline for each root comment (scoped to the active org/drive)
  const comments: CommentListEntry[] = rows.map((row) => {
    const replyRows = ctx.db
      .select()
      .from(schema.comments)
      .where(
        and(
          eq(schema.comments.parentId, row.id),
          eq(schema.comments.orgId, ctx.orgId),
          eq(schema.comments.driveId, ctx.driveId),
          eq(schema.comments.isDeleted, false)
        )
      )
      .orderBy(schema.comments.createdAt)
      .all();

    const replies = replyRows.map((r) => toCommentEntry({ ...r, replyCount: 0 }));

    return {
      ...toCommentEntry({ ...row, replyCount: replies.length }),
      replies,
    };
  });

  const entries = comments.flatMap((comment) => [comment, ...comment.replies]);
  addAuthorNames(ctx, entries);
  addMentions(ctx, entries);
  addFileVersions(ctx, comments);
  return { comments };
}

export async function commentGet(
  ctx: OpContext,
  params: CommentGetParams
): Promise<CommentGetResult> {
  const row = getScopedComment(ctx, params.id);

  if (!row) {
    throw new NotFoundError("Comment not found", {
      suggestion: "Check that the comment ID is correct",
    });
  }

  // Count replies for the main comment (scoped to the active org/drive)
  const replyCount = ctx.db
    .select({ count: sql<number>`count(*)` })
    .from(schema.comments)
    .where(
      and(
        eq(schema.comments.parentId, row.id),
        eq(schema.comments.orgId, ctx.orgId),
        eq(schema.comments.driveId, ctx.driveId),
        eq(schema.comments.isDeleted, false)
      )
    )
    .get();

  const comment = toCommentEntry({
    ...row,
    replyCount: replyCount?.count ?? 0,
  });

  // Fetch replies (scoped to the active org/drive)
  const replyRows = ctx.db
    .select()
    .from(schema.comments)
    .where(
      and(
        eq(schema.comments.parentId, params.id),
        eq(schema.comments.orgId, ctx.orgId),
        eq(schema.comments.driveId, ctx.driveId),
        eq(schema.comments.isDeleted, false)
      )
    )
    .orderBy(schema.comments.createdAt)
    .all();

  const replies = replyRows.map((r) => toCommentEntry({ ...r, replyCount: 0 }));

  const entries = [comment, ...replies];
  addAuthorNames(ctx, entries);
  addMentions(ctx, entries);
  addFileVersions(ctx, [comment]);
  return { comment, replies };
}

export async function commentUpdate(
  ctx: OpContext,
  params: CommentUpdateParams
): Promise<CommentUpdateResult> {
  const row = getScopedComment(ctx, params.id);

  if (!row) {
    throw new NotFoundError("Comment not found", {
      suggestion: "Check that the comment ID is correct",
    });
  }

  if (row.author !== ctx.userId) {
    throw new PermissionDeniedError("You can only edit your own comments", {
      suggestion: "Only the comment author can update it",
    });
  }

  const mentionUserIds = params.mentions === undefined
    ? undefined
    : resolveMentions(ctx, params.mentions);
  const now = new Date();
  ctx.db.transaction((tx) => {
    const txCtx = { ...ctx, db: tx as unknown as typeof ctx.db };
    tx.update(schema.comments)
      .set({ body: params.body, updatedAt: now })
      .where(
        and(
          eq(schema.comments.id, params.id),
          eq(schema.comments.orgId, ctx.orgId),
          eq(schema.comments.driveId, ctx.driveId)
        )
      )
      .run();

    if (mentionUserIds !== undefined) {
      const removeCondition = mentionUserIds.length > 0
        ? and(
            eq(schema.commentMentions.commentId, params.id),
            notInArray(schema.commentMentions.userId, mentionUserIds)
          )
        : eq(schema.commentMentions.commentId, params.id);
      const removedUserIds = tx.select({ userId: schema.commentMentions.userId })
        .from(schema.commentMentions)
        .where(removeCondition)
        .all()
        .map(({ userId }) => userId);
      tx.delete(schema.commentMentions).where(removeCondition).run();

      if (removedUserIds.length > 0) {
        tx.update(schema.events)
          .set({ status: "deleted" })
          .where(
            and(
              eq(schema.events.orgId, txCtx.orgId),
              eq(schema.events.type, COMMENT_MENTION_EVENT),
              eq(schema.events.resourceType, "comment"),
              eq(schema.events.resourceId, params.id),
              inArray(schema.events.target, removedUserIds),
              eq(schema.events.status, "created")
            )
          )
          .run();
      }

      const newMentionUserIds = saveMentions(txCtx, params.id, mentionUserIds);
      emitMentionNotifications(txCtx, {
        commentId: params.id,
        path: row.path,
        parentId: row.parentId ?? undefined,
        userIds: newMentionUserIds,
        createdAt: now,
      });
    }
  });

  publishCommentChange(ctx, row, "updated", now);
  return { id: params.id, body: params.body, updatedAt: now };
}

export async function commentDelete(
  ctx: OpContext,
  params: CommentDeleteParams
): Promise<CommentDeleteResult> {
  const row = getScopedComment(ctx, params.id);

  if (!row) {
    throw new NotFoundError("Comment not found", {
      suggestion: "Check that the comment ID is correct",
    });
  }

  if (row.author !== ctx.userId) {
    throw new PermissionDeniedError("You can only delete your own comments", {
      suggestion: "Only the comment author can delete it",
    });
  }

  const now = new Date();

  // Soft-delete the comment (scoped to the active org/drive)
  ctx.db
    .update(schema.comments)
    .set({ isDeleted: true, updatedAt: now })
    .where(
      and(
        eq(schema.comments.id, params.id),
        eq(schema.comments.orgId, ctx.orgId),
        eq(schema.comments.driveId, ctx.driveId)
      )
    )
    .run();

  // If root comment, also soft-delete all replies (scoped to the active org/drive)
  if (!row.parentId) {
    ctx.db
      .update(schema.comments)
      .set({ isDeleted: true, updatedAt: now })
      .where(
        and(
          eq(schema.comments.parentId, params.id),
          eq(schema.comments.orgId, ctx.orgId),
          eq(schema.comments.driveId, ctx.driveId)
        )
      )
      .run();
  }

  emitEvent(ctx, {
    type: "comment_deleted",
    resourceType: "comment",
    resourceId: params.id,
  });

  publishCommentChange(ctx, row, "deleted", now);
  return { deleted: true };
}

export async function commentResolve(
  ctx: OpContext,
  params: CommentResolveParams
): Promise<CommentResolveResult> {
  const row = getScopedComment(ctx, params.id);

  if (!row) {
    throw new NotFoundError("Comment not found", {
      suggestion: "Check that the comment ID is correct",
    });
  }

  if (row.parentId) {
    throw new ValidationError("Cannot resolve a reply — only root comments can be resolved", {
      suggestion: "Resolve the parent comment instead",
    });
  }

  const now = new Date();
  const resolvedAt = params.resolved ? now : null;
  const resolvedBy = params.resolved ? ctx.userId : null;

  ctx.db
    .update(schema.comments)
    .set({
      resolved: params.resolved,
      resolvedBy,
      resolvedAt,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.comments.id, params.id),
        eq(schema.comments.orgId, ctx.orgId),
        eq(schema.comments.driveId, ctx.driveId)
      )
    )
    .run();

  emitEvent(ctx, {
    type: params.resolved ? "comment_resolved" : "comment_reopened",
    resourceType: "comment",
    resourceId: params.id,
  });
  publishCommentChange(ctx, row, params.resolved ? "resolved" : "reopened", now);

  return {
    id: params.id,
    resolved: params.resolved,
    resolvedBy: resolvedBy ?? undefined,
    resolvedAt: resolvedAt ?? undefined,
  };
}

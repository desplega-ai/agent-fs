import { eq, and, sql, desc } from "drizzle-orm";
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
} from "./types.js";
import { NotFoundError, ValidationError, PermissionDeniedError } from "../errors.js";

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

// --- Helpers ---

function toCommentEntry(row: any): CommentEntry {
  return {
    id: row.id,
    parentId: row.parentId ?? undefined,
    path: row.path,
    lineStart: row.lineStart ?? undefined,
    lineEnd: row.lineEnd ?? undefined,
    quotedContent: row.quotedContent ?? undefined,
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

// --- Handlers ---

export async function commentAdd(
  ctx: OpContext,
  params: CommentAddParams
): Promise<CommentAddResult> {
  const now = new Date();
  const id = crypto.randomUUID();
  let path = params.path;

  if (params.parentId) {
    // Resolve parent
    const parent = ctx.db
      .select()
      .from(schema.comments)
      .where(
        and(
          eq(schema.comments.id, params.parentId),
          eq(schema.comments.isDeleted, false)
        )
      )
      .get();

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

  ctx.db
    .insert(schema.comments)
    .values({
      id,
      parentId: params.parentId ?? null,
      orgId: ctx.orgId,
      driveId: ctx.driveId,
      path,
      lineStart: params.lineStart ?? null,
      lineEnd: params.lineEnd ?? null,
      quotedContent: params.quotedContent ?? null,
      fileVersionId: currentVersion?.id ?? null,
      body: params.body,
      author: ctx.userId,
      resolved: false,
      createdAt: now,
      updatedAt: now,
      isDeleted: false,
    })
    .run();

  emitEvent(ctx, {
    type: "comment_created",
    resourceType: "comment",
    resourceId: id,
    metadata: { path, parentId: params.parentId },
  });

  return {
    id,
    path,
    body: params.body,
    parentId: params.parentId,
    lineStart: params.lineStart,
    lineEnd: params.lineEnd,
    author: ctx.userId,
    createdAt: now,
  };
}

export async function commentList(
  ctx: OpContext,
  params: CommentListParams
): Promise<CommentListResult> {
  const conditions = [
    eq(schema.comments.driveId, ctx.driveId),
    eq(schema.comments.isDeleted, false),
  ];

  if (params.path) {
    conditions.push(eq(schema.comments.path, params.path));
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

  // Fetch replies inline for each root comment
  const comments: CommentListEntry[] = rows.map((row) => {
    const replyRows = ctx.db
      .select()
      .from(schema.comments)
      .where(
        and(
          eq(schema.comments.parentId, row.id),
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

  return { comments };
}

export async function commentGet(
  ctx: OpContext,
  params: CommentGetParams
): Promise<CommentGetResult> {
  const row = ctx.db
    .select()
    .from(schema.comments)
    .where(
      and(
        eq(schema.comments.id, params.id),
        eq(schema.comments.isDeleted, false)
      )
    )
    .get();

  if (!row) {
    throw new NotFoundError("Comment not found", {
      suggestion: "Check that the comment ID is correct",
    });
  }

  // Count replies for the main comment
  const replyCount = ctx.db
    .select({ count: sql<number>`count(*)` })
    .from(schema.comments)
    .where(
      and(
        eq(schema.comments.parentId, row.id),
        eq(schema.comments.isDeleted, false)
      )
    )
    .get();

  const comment = toCommentEntry({
    ...row,
    replyCount: replyCount?.count ?? 0,
  });

  // Fetch replies
  const replyRows = ctx.db
    .select()
    .from(schema.comments)
    .where(
      and(
        eq(schema.comments.parentId, params.id),
        eq(schema.comments.isDeleted, false)
      )
    )
    .orderBy(schema.comments.createdAt)
    .all();

  const replies = replyRows.map((r) => toCommentEntry({ ...r, replyCount: 0 }));

  return { comment, replies };
}

export async function commentUpdate(
  ctx: OpContext,
  params: CommentUpdateParams
): Promise<CommentUpdateResult> {
  const row = ctx.db
    .select()
    .from(schema.comments)
    .where(
      and(
        eq(schema.comments.id, params.id),
        eq(schema.comments.isDeleted, false)
      )
    )
    .get();

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

  const now = new Date();
  ctx.db
    .update(schema.comments)
    .set({ body: params.body, updatedAt: now })
    .where(eq(schema.comments.id, params.id))
    .run();

  return { id: params.id, body: params.body, updatedAt: now };
}

export async function commentDelete(
  ctx: OpContext,
  params: CommentDeleteParams
): Promise<CommentDeleteResult> {
  const row = ctx.db
    .select()
    .from(schema.comments)
    .where(
      and(
        eq(schema.comments.id, params.id),
        eq(schema.comments.isDeleted, false)
      )
    )
    .get();

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

  // Soft-delete the comment
  ctx.db
    .update(schema.comments)
    .set({ isDeleted: true, updatedAt: now })
    .where(eq(schema.comments.id, params.id))
    .run();

  // If root comment, also soft-delete all replies
  if (!row.parentId) {
    ctx.db
      .update(schema.comments)
      .set({ isDeleted: true, updatedAt: now })
      .where(eq(schema.comments.parentId, params.id))
      .run();
  }

  emitEvent(ctx, {
    type: "comment_deleted",
    resourceType: "comment",
    resourceId: params.id,
  });

  return { deleted: true };
}

export async function commentResolve(
  ctx: OpContext,
  params: CommentResolveParams
): Promise<CommentResolveResult> {
  const row = ctx.db
    .select()
    .from(schema.comments)
    .where(
      and(
        eq(schema.comments.id, params.id),
        eq(schema.comments.isDeleted, false)
      )
    )
    .get();

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
    .where(eq(schema.comments.id, params.id))
    .run();

  emitEvent(ctx, {
    type: params.resolved ? "comment_resolved" : "comment_reopened",
    resourceType: "comment",
    resourceId: params.id,
  });

  return {
    id: params.id,
    resolved: params.resolved,
    resolvedBy: resolvedBy ?? undefined,
    resolvedAt: resolvedAt ?? undefined,
  };
}

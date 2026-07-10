import { and, count, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { schema } from "../db/index.js";
import { ValidationError } from "../errors.js";
import type {
  CommentNotificationEntry,
  CommentNotificationListParams,
  CommentNotificationListResult,
  CommentNotificationReadParams,
  CommentNotificationReadResult,
  OpContext,
} from "./types.js";

const NOTIFICATION_TYPE = "comment_notification";
const DEFAULT_LIMIT = 50;
const READ_BATCH_SIZE = 500;

function notificationScope(ctx: OpContext) {
  return [
    eq(schema.events.orgId, ctx.orgId),
    eq(schema.events.type, NOTIFICATION_TYPE),
    eq(schema.events.resourceType, "comment"),
    eq(schema.events.target, ctx.userId),
    eq(schema.comments.orgId, ctx.orgId),
    eq(schema.comments.driveId, ctx.driveId),
    eq(schema.comments.isDeleted, false),
  ];
}

export async function commentNotificationList(
  ctx: OpContext,
  params: CommentNotificationListParams
): Promise<CommentNotificationListResult> {
  const conditions = [
    ...notificationScope(ctx),
    ne(schema.events.status, "deleted"),
  ];

  if (params.unreadOnly) {
    conditions.push(eq(schema.events.status, "created"));
  }

  const rows = ctx.db
    .select({
      id: schema.events.id,
      commentId: schema.comments.id,
      parentId: schema.comments.parentId,
      path: schema.comments.path,
      body: schema.comments.body,
      actor: schema.events.actor,
      createdAt: schema.events.createdAt,
      status: schema.events.status,
    })
    .from(schema.events)
    .innerJoin(
      schema.comments,
      and(
        eq(schema.events.resourceId, schema.comments.id),
        eq(schema.events.resourceType, "comment")
      )
    )
    .where(and(...conditions))
    // Keep every unread item reachable even when the inbox contains more than
    // one page of already-read history. Within each state, show newest first.
    .orderBy(
      sql`CASE WHEN ${schema.events.status} = 'created' THEN 0 ELSE 1 END`,
      desc(schema.events.createdAt)
    )
    .limit(params.limit ?? DEFAULT_LIMIT)
    .offset(params.offset ?? 0)
    .all();

  const unread = ctx.db
    .select({ value: count() })
    .from(schema.events)
    .innerJoin(
      schema.comments,
      and(
        eq(schema.events.resourceId, schema.comments.id),
        eq(schema.events.resourceType, "comment")
      )
    )
    .where(
      and(
        ...notificationScope(ctx),
        eq(schema.events.status, "created")
      )
    )
    .get();

  const notifications: CommentNotificationEntry[] = rows.map((row) => ({
    id: row.id,
    commentId: row.commentId,
    parentId: row.parentId ?? undefined,
    path: row.path,
    body: row.body,
    actor: row.actor,
    createdAt: row.createdAt,
    read: row.status === "ack",
  }));

  return {
    notifications,
    unreadCount: Number(unread?.value ?? 0),
  };
}

export async function commentNotificationRead(
  ctx: OpContext,
  params: CommentNotificationReadParams
): Promise<CommentNotificationReadResult> {
  if (params.all === true && params.ids && params.ids.length > 0) {
    throw new ValidationError("Provide notification IDs or set all=true, not both", {
      suggestion: "Remove ids to mark all notifications, or omit all to mark selected IDs",
    });
  }

  if (params.all !== true && (!params.ids || params.ids.length === 0)) {
    throw new ValidationError("Provide notification IDs or set all=true", {
      suggestion: "Pass ids: [...] to mark selected notifications, or all: true",
    });
  }

  const conditions = [
    ...notificationScope(ctx),
    eq(schema.events.status, "created"),
  ];

  if (!params.all) {
    const ids = params.ids ?? [];
    if (ids.length === 0) {
      return { markedRead: 0 };
    }
    conditions.push(inArray(schema.events.id, ids));
  }

  // Resolve IDs through the comments join first. Events do not carry drive_id,
  // so updating only by event ID/target would allow a known ID from another
  // drive to cross the active drive boundary.
  const scopedIds = ctx.db
    .select({ id: schema.events.id })
    .from(schema.events)
    .innerJoin(
      schema.comments,
      and(
        eq(schema.events.resourceId, schema.comments.id),
        eq(schema.events.resourceType, "comment")
      )
    )
    .where(and(...conditions))
    .all()
    .map((row) => row.id);

  let markedRead = 0;
  for (let offset = 0; offset < scopedIds.length; offset += READ_BATCH_SIZE) {
    const batch = scopedIds.slice(offset, offset + READ_BATCH_SIZE);
    const updated = ctx.db
      .update(schema.events)
      .set({ status: "ack" })
      .where(
        and(
          inArray(schema.events.id, batch),
          eq(schema.events.orgId, ctx.orgId),
          eq(schema.events.target, ctx.userId),
          eq(schema.events.type, NOTIFICATION_TYPE),
          eq(schema.events.status, "created")
        )
      )
      .returning({ id: schema.events.id })
      .all();
    markedRead += updated.length;
  }

  return { markedRead };
}

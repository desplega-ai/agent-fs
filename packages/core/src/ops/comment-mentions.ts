import { eq, inArray } from "drizzle-orm";
import { schema } from "../db/index.js";
import { ValidationError } from "../errors.js";
import { listDriveMembersPublic } from "../identity/drives.js";
import type { CommentEntry, OpContext } from "./types.js";

type Mention = NonNullable<CommentEntry["mentions"]>[number];

export function resolveMentions(ctx: OpContext, raw: string[]): string[] {
  const members = listDriveMembersPublic(ctx.db, ctx.driveId);
  const byId = new Map(members.map((member) => [member.userId, member.userId]));
  const byEmail = new Map<string, string[]>();
  for (const member of members) {
    const email = member.email.toLowerCase();
    const userIds = byEmail.get(email) ?? [];
    userIds.push(member.userId);
    byEmail.set(email, userIds);
  }
  const resolved = new Set<string>();

  for (const entry of raw) {
    let userId = byId.get(entry);
    if (!userId) {
      const matches = byEmail.get(entry.toLowerCase());
      if (matches && matches.length > 1) {
        throw new ValidationError(
          `Mention email matches multiple drive members: ${entry}`,
          {
            field: "mentions",
            suggestion: "Use a user ID to select the intended drive member",
          }
        );
      }
      userId = matches?.[0];
    }
    if (!userId) {
      throw new ValidationError(
        `Mention target is not a member of this drive: ${entry}`,
        { field: "mentions" }
      );
    }
    if (userId !== ctx.userId) resolved.add(userId);
  }

  return [...resolved];
}

export function saveMentions(
  ctx: OpContext,
  commentId: string,
  userIds: string[]
): string[] {
  if (userIds.length === 0) return [];

  return ctx.db
    .insert(schema.commentMentions)
    .values(
      userIds.map((userId) => ({
        commentId,
        userId,
        createdAt: new Date(),
      }))
    )
    .onConflictDoNothing()
    .returning({ userId: schema.commentMentions.userId })
    .all()
    .map((row) => row.userId);
}

export function emitMentionNotifications(
  ctx: OpContext,
  params: {
    commentId: string;
    path: string;
    parentId?: string;
    userIds: string[];
  }
): void {
  if (params.userIds.length === 0) return;

  const createdAt = new Date();
  ctx.db
    .insert(schema.events)
    .values(
      params.userIds.map((userId) => ({
        id: crypto.randomUUID(),
        orgId: ctx.orgId,
        type: "comment_mention",
        resourceType: "comment",
        resourceId: params.commentId,
        actor: ctx.userId,
        target: userId,
        status: "created" as const,
        metadata: JSON.stringify({
          path: params.path,
          parentId: params.parentId,
        }),
        createdAt,
      }))
    )
    .run();
}

export function loadMentions(
  ctx: OpContext,
  commentIds: string[]
): Map<string, Mention[]> {
  if (commentIds.length === 0) return new Map();

  const rows = ctx.db
    .select({
      commentId: schema.commentMentions.commentId,
      userId: schema.users.id,
      email: schema.users.email,
      displayName: schema.users.displayName,
    })
    .from(schema.commentMentions)
    .innerJoin(schema.users, eq(schema.commentMentions.userId, schema.users.id))
    .where(inArray(schema.commentMentions.commentId, commentIds))
    .orderBy(schema.commentMentions.createdAt)
    .all();

  const mentions = new Map<string, Mention[]>();
  for (const row of rows) {
    const entries = mentions.get(row.commentId) ?? [];
    entries.push({
      userId: row.userId,
      email: row.email,
      displayName: row.displayName,
    });
    mentions.set(row.commentId, entries);
  }
  return mentions;
}

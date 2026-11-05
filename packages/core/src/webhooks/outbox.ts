// Transactional webhook outbox. The comment ops call enqueueCommentWebhooks()
// inside the same SQLite transaction that writes their `events` rows, and
// createVersion() calls enqueueFileWebhooks() inside the one that writes the
// version row, so a delivery row exists exactly when the change does. Everything here is
// synchronous (the bun-sqlite transaction callback is sync): SQL and JSON
// only, no crypto and no network.

import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { CommentEntry, OpContext } from "../ops/types.js";
import { addMentions } from "../ops/comment-mentions.js";
import { normalizePath } from "../ops/paths.js";
import { buildAppUrl } from "../ops/urls.js";
import { BODY_MAX_CHARS, INTERNAL_TO_WEBHOOK, type WebhookEventType } from "./events.js";

/** A comment row as stored, after the change the op made. */
export type CommentSnapshot = typeof schema.comments.$inferSelect;

/** One `events` row the op wrote, to fan out to matching subscriptions. */
export interface CommentWebhookEvent {
  /** `events.id`; sent as `webhook-id`. */
  eventId: string;
  /** `events.type`, e.g. `comment_created`. Unmapped types are skipped. */
  internalType: string;
  /** Set for `comment_mention` rows: the user who was mentioned. */
  mentionedUserId?: string;
}

export interface WebhookUserRef {
  id: string;
  email: string | null;
  displayName: string | null;
}

export interface CommentWebhookData {
  eventId: string;
  orgId: string;
  driveId: string;
  path: string;
  /** Omitted when the server has no app URL configured. */
  url?: string;
  actor: WebhookUserRef;
  comment: {
    id: string;
    parentId: string | null;
    body: string;
    bodyTruncated: boolean;
    quote: { exact: string; prefix: string | null; suffix: string | null } | null;
    lineStart: number | null;
    lineEnd: number | null;
    resolved: boolean;
    createdAt: string;
    updatedAt: string;
    author: WebhookUserRef;
    mentions: WebhookUserRef[];
  };
  /** Only on `comment.mentioned`. */
  mentioned?: WebhookUserRef;
  /** Only when the comment is a reply. */
  thread?: { rootId: string; participants: WebhookUserRef[] };
}

/** `data` of a `file.changed` event. Metadata only, never file content. */
export interface FileChangedWebhookData {
  eventId: string;
  orgId: string;
  driveId: string;
  path: string;
  /** Omitted when the server has no app URL configured. */
  url?: string;
  version: number;
  operation: FileChangeOperation;
  author: WebhookUserRef;
  /** Bytes; null for a delete. */
  size: number | null;
  etag: string | null;
}

export type FileChangeOperation = "write" | "edit" | "append" | "delete" | "revert";

export interface WebhookEnvelope<T = CommentWebhookData> {
  type: WebhookEventType | "ping";
  timestamp: string;
  data: T;
}

/** Cut `body` to BODY_MAX_CHARS without splitting a surrogate pair. */
export function truncateWebhookBody(body: string): { body: string; truncated: boolean } {
  if (body.length <= BODY_MAX_CHARS) return { body, truncated: false };
  let end = BODY_MAX_CHARS;
  const last = body.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { body: body.slice(0, end), truncated: true };
}

// Subscription ids already reported as unreadable, so a corrupt row logs once
// per process instead of on every comment op.
const warnedCorruptSubs = new Set<string>();

/**
 * A subscription's `event_types`, or null when the stored value is not a JSON
 * array. A corrupt row is skipped (it gets no delivery) rather than failing
 * the comment op: one bad row must not block every comment in its org.
 */
function parseEventTypes(raw: string, subscriptionId: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (!Array.isArray(parsed)) {
    if (!warnedCorruptSubs.has(subscriptionId)) {
      warnedCorruptSubs.add(subscriptionId);
      console.warn(
        `[webhooks] skipping subscription ${subscriptionId}: event_types is not a JSON array`
      );
    }
    return null;
  }
  return parsed.filter((t): t is string => typeof t === "string");
}

/**
 * Write one `webhook_deliveries` row per (enabled matching subscription ×
 * webhook event). Must run inside the op's transaction (`ctx.db` is the tx).
 * Returns the number of rows inserted; 0 with no subscriptions is the hot
 * path and costs one indexed query. A subscription whose stored
 * `event_types` is unreadable is skipped with a warning. Any other error
 * propagates and rolls the op back, so a comment change never commits
 * without its deliveries.
 */
export function enqueueCommentWebhooks(
  ctx: OpContext,
  input: { comment: CommentSnapshot; events: CommentWebhookEvent[]; at: Date }
): number {
  if (input.events.length === 0) return 0;

  const subs = ctx.db
    .select({ id: schema.webhookSubscriptions.id, eventTypes: schema.webhookSubscriptions.eventTypes })
    .from(schema.webhookSubscriptions)
    .where(
      and(
        eq(schema.webhookSubscriptions.orgId, ctx.orgId),
        eq(schema.webhookSubscriptions.enabled, true),
        or(
          isNull(schema.webhookSubscriptions.driveId),
          eq(schema.webhookSubscriptions.driveId, ctx.driveId)
        )
      )
    )
    .all();
  if (subs.length === 0) return 0;

  const subTypes: Array<{ id: string; types: Set<string> }> = [];
  for (const s of subs) {
    const types = parseEventTypes(s.eventTypes, s.id);
    if (types) subTypes.push({ id: s.id, types: new Set(types) });
  }

  // Pair each mapped event with the subscriptions that want it.
  const work: Array<{ event: CommentWebhookEvent; type: WebhookEventType; subIds: string[] }> = [];
  for (const event of input.events) {
    const type = INTERNAL_TO_WEBHOOK[event.internalType];
    if (!type) continue;
    const subIds = subTypes.filter((s) => s.types.has(type)).map((s) => s.id);
    if (subIds.length > 0) work.push({ event, type, subIds });
  }
  if (work.length === 0) return 0;

  const { comment } = input;

  // Thread participants: root author + distinct reply authors, minus the
  // actor, in order of first appearance. rowid breaks same-second ties.
  let participantIds: string[] = [];
  if (comment.parentId) {
    participantIds = ctx.db
      .select({ author: schema.comments.author })
      .from(schema.comments)
      .where(
        and(
          eq(schema.comments.driveId, comment.driveId),
          or(eq(schema.comments.id, comment.parentId), eq(schema.comments.parentId, comment.parentId)),
          eq(schema.comments.isDeleted, false),
          ne(schema.comments.author, ctx.userId)
        )
      )
      .groupBy(schema.comments.author)
      .orderBy(sql`MIN(${schema.comments.createdAt})`, sql`MIN(rowid)`)
      .all()
      .map((r) => r.author);
  }

  const userIds = new Set<string>([ctx.userId, comment.author, ...participantIds]);
  for (const { event } of work) if (event.mentionedUserId) userIds.add(event.mentionedUserId);
  const users = ctx.db
    .select({ id: schema.users.id, email: schema.users.email, displayName: schema.users.displayName })
    .from(schema.users)
    .where(inArray(schema.users.id, [...userIds]))
    .all();
  const byId = new Map(users.map((u) => [u.id, u]));
  const ref = (id: string): WebhookUserRef => {
    const u = byId.get(id);
    return { id, email: u?.email ?? null, displayName: u?.displayName ?? null };
  };

  const [withMentions] = addMentions<{ id: string; mentions?: CommentEntry["mentions"] }>(ctx, [{ id: comment.id }]);
  const { body, truncated } = truncateWebhookBody(comment.body);

  const base: Omit<CommentWebhookData, "eventId" | "mentioned"> = {
    orgId: ctx.orgId,
    driveId: comment.driveId,
    path: comment.path,
    ...(ctx.appUrl ? { url: buildAppUrl(ctx.appUrl, ctx.orgId, comment.driveId, comment.path) } : {}),
    actor: ref(ctx.userId),
    comment: {
      id: comment.id,
      parentId: comment.parentId ?? null,
      body,
      bodyTruncated: truncated,
      quote: comment.quoteExact
        ? { exact: comment.quoteExact, prefix: comment.quotePrefix ?? null, suffix: comment.quoteSuffix ?? null }
        : null,
      lineStart: comment.lineStart ?? null,
      lineEnd: comment.lineEnd ?? null,
      resolved: comment.resolved,
      createdAt: comment.createdAt.toISOString(),
      updatedAt: comment.updatedAt.toISOString(),
      author: ref(comment.author),
      mentions: (withMentions.mentions ?? []).map((m) => ({
        id: m.userId,
        email: m.email,
        displayName: m.displayName ?? null,
      })),
    },
  };
  const thread = comment.parentId
    ? { rootId: comment.parentId, participants: participantIds.map(ref) }
    : undefined;

  const timestamp = input.at.toISOString();
  const rows: Array<typeof schema.webhookDeliveries.$inferInsert> = [];
  for (const { event, type, subIds } of work) {
    const data: CommentWebhookData = {
      eventId: event.eventId,
      ...base,
      ...(type === "comment.mentioned" && event.mentionedUserId
        ? { mentioned: ref(event.mentionedUserId) }
        : {}),
      ...(thread ? { thread } : {}),
    };
    const envelope: WebhookEnvelope = { type, timestamp, data };
    const payload = JSON.stringify(envelope);
    for (const subscriptionId of subIds) {
      rows.push({
        id: crypto.randomUUID(),
        subscriptionId,
        eventId: event.eventId,
        eventType: type,
        payload,
        status: "pending",
        attempts: 0,
        nextAttemptAt: input.at,
        createdAt: input.at,
      });
    }
  }

  return ctx.db
    .insert(schema.webhookDeliveries)
    .values(rows)
    .onConflictDoNothing({
      target: [schema.webhookDeliveries.subscriptionId, schema.webhookDeliveries.eventId],
    })
    .returning({ id: schema.webhookDeliveries.id })
    .all().length;
}

/**
 * Write one `file.changed` delivery per enabled subscription that lists
 * `file.changed` and whose `path_prefix` (if set) contains `path`. Same
 * scoping as comments: this drive's hooks plus the org's. Must run inside
 * createVersion's transaction (`ctx.db` is the tx); an error rolls the
 * version back. Returns the number of rows inserted.
 */
export function enqueueFileWebhooks(
  ctx: OpContext,
  input: {
    path: string;
    version: number;
    operation: FileChangeOperation;
    size: number | null;
    etag: string | null;
    at: Date;
  }
): number {
  const s = schema.webhookSubscriptions;
  // Stored file paths are usually absolute, but some writers store them
  // without the leading "/". A prefix is stored as "/dir/"; match the path
  // against it and its relative form. "0" follows "/" in BINARY collation, so
  // [prefix, prefix-without-slash + "0") holds exactly the paths under it.
  const subs = ctx.db
    .select({ id: s.id, eventTypes: s.eventTypes })
    .from(s)
    .where(
      and(
        eq(s.orgId, ctx.orgId),
        eq(s.enabled, true),
        or(isNull(s.driveId), eq(s.driveId, ctx.driveId)),
        sql`(
          ${s.pathPrefix} IS NULL
          OR (${input.path} >= ${s.pathPrefix}
            AND ${input.path} < substr(${s.pathPrefix}, 1, length(${s.pathPrefix}) - 1) || '0')
          OR (${input.path} >= substr(${s.pathPrefix}, 2)
            AND ${input.path} < substr(${s.pathPrefix}, 2, length(${s.pathPrefix}) - 2) || '0')
        )`
      )
    )
    .all();
  if (subs.length === 0) return 0;

  const subIds = subs
    .filter((sub) => parseEventTypes(sub.eventTypes, sub.id)?.includes("file.changed"))
    .map((sub) => sub.id);
  if (subIds.length === 0) return 0;

  const user = ctx.db
    .select({ id: schema.users.id, email: schema.users.email, displayName: schema.users.displayName })
    .from(schema.users)
    .where(eq(schema.users.id, ctx.userId))
    .get();
  const path = normalizePath(input.path);
  const eventId = crypto.randomUUID();
  const data: FileChangedWebhookData = {
    eventId,
    orgId: ctx.orgId,
    driveId: ctx.driveId,
    path,
    ...(ctx.appUrl ? { url: buildAppUrl(ctx.appUrl, ctx.orgId, ctx.driveId, path) } : {}),
    version: input.version,
    operation: input.operation,
    author: { id: ctx.userId, email: user?.email ?? null, displayName: user?.displayName ?? null },
    size: input.size,
    etag: input.etag,
  };
  const envelope: WebhookEnvelope<FileChangedWebhookData> = {
    type: "file.changed",
    timestamp: input.at.toISOString(),
    data,
  };
  const payload = JSON.stringify(envelope);

  return ctx.db
    .insert(schema.webhookDeliveries)
    .values(
      subIds.map((subscriptionId) => ({
        id: crypto.randomUUID(),
        subscriptionId,
        eventId,
        eventType: "file.changed" as const,
        payload,
        status: "pending" as const,
        attempts: 0,
        nextAttemptAt: input.at,
        createdAt: input.at,
      }))
    )
    .returning({ id: schema.webhookDeliveries.id })
    .all().length;
}

// --- Early-tick signal -------------------------------------------------------

type EnqueueListener = () => void;
const listeners = new Set<EnqueueListener>();

/**
 * Register a callback fired after an op commits new deliveries (the
 * worker uses it for an early tick). Returns an unregister function.
 */
export function onWebhooksEnqueued(cb: EnqueueListener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Call after the transaction commits, only when enqueue inserted rows. */
export function notifyWebhooksEnqueued(): void {
  for (const cb of [...listeners]) {
    try {
      cb();
    } catch (err) {
      console.error("[webhooks] enqueue listener failed:", err);
    }
  }
}

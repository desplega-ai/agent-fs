import { describe, expect, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { and, eq } from "drizzle-orm";
import { createTestContext } from "../../test-utils.js";
import { schema } from "../../db/index.js";
import type { DB } from "../../db/index.js";
import { createUser } from "../../identity/users.js";
import { createDrive } from "../../identity/drives.js";
import { grantDriveRole, grantOrgRole } from "../../identity/grants.js";
import { listUserOrgs } from "../../identity/orgs.js";
import { listDrives } from "../../identity/drives.js";
import { commentAdd, commentDelete, commentResolve, commentUpdate } from "../comment.js";
import { onWebhooksEnqueued, type CommentWebhookData, type WebhookEnvelope } from "../../webhooks/outbox.js";
import { BODY_MAX_CHARS, WEBHOOK_EVENT_TYPES, type WebhookEventType } from "../../webhooks/events.js";
import type { OpContext } from "../types.js";

// Subscriptions are inserted directly with a dummy ciphertext: the outbox
// never touches secrets, so no key material is needed here.

function rawOf(db: DB): Database {
  return (db as unknown as { $client: Database }).$client;
}

function addSub(
  db: DB,
  params: {
    orgId: string;
    driveId?: string | null;
    createdBy: string;
    eventTypes?: readonly WebhookEventType[] | string;
    enabled?: boolean;
  }
): string {
  const id = crypto.randomUUID();
  const now = new Date();
  db.insert(schema.webhookSubscriptions)
    .values({
      id,
      orgId: params.orgId,
      driveId: params.driveId ?? null,
      url: "https://hooks.example.com/af",
      eventTypes:
        typeof params.eventTypes === "string"
          ? params.eventTypes
          : JSON.stringify(params.eventTypes ?? WEBHOOK_EVENT_TYPES),
      secretCiphertext: "dummy-ciphertext",
      enabled: params.enabled ?? true,
      createdBy: params.createdBy,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return id;
}

interface Delivery {
  id: string;
  subscriptionId: string;
  eventId: string;
  eventType: string;
  status: string;
  attempts: number;
  nextAttemptAt: Date;
  envelope: WebhookEnvelope<CommentWebhookData>;
}

function deliveries(db: DB, subscriptionId?: string): Delivery[] {
  const rows = db
    .select()
    .from(schema.webhookDeliveries)
    .where(subscriptionId ? eq(schema.webhookDeliveries.subscriptionId, subscriptionId) : undefined)
    .orderBy(schema.webhookDeliveries.createdAt)
    .all();
  // Order within one op follows insertion (rowid); createdAt ties there.
  const order = new Map(
    (rawOf(db).query("SELECT id FROM webhook_deliveries ORDER BY rowid").all() as Array<{ id: string }>).map(
      (r, i) => [r.id, i]
    )
  );
  rows.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return rows.map((r) => ({
    id: r.id,
    subscriptionId: r.subscriptionId,
    eventId: r.eventId,
    eventType: r.eventType,
    status: r.status,
    attempts: r.attempts,
    nextAttemptAt: r.nextAttemptAt,
    envelope: JSON.parse(r.payload),
  }));
}

function eventRows(db: DB, type: string, resourceId?: string) {
  return db
    .select()
    .from(schema.events)
    .where(
      resourceId
        ? and(eq(schema.events.type, type), eq(schema.events.resourceId, resourceId))
        : eq(schema.events.type, type)
    )
    .all();
}

/** One org with drive A (default) and drive B, users A (owner), B and C on drive A. */
function fixture() {
  const base = createTestContext();
  const { db, ctx } = base;
  const b = createUser(db, { email: "bee@example.com" }).user;
  const c = createUser(db, { email: "cee@example.com" }).user;
  db.update(schema.users).set({ displayName: "Bee" }).where(eq(schema.users.id, b.id)).run();
  for (const user of [b, c]) {
    grantOrgRole(db, { orgId: ctx.orgId, userId: user.id, role: "editor" });
    grantDriveRole(db, { driveId: ctx.driveId, userId: user.id, role: "editor" });
  }
  const driveB = createDrive(db, { orgId: ctx.orgId, name: "second", creatorUserId: ctx.userId });
  const as = (userId: string): OpContext => ({ ...ctx, userId });
  return { ...base, b, c, driveB, as };
}

describe("comment webhook outbox", () => {
  test("no subscription: comment ops write no delivery rows and never notify", async () => {
    const { ctx, db, b } = fixture();
    let notified = 0;
    const off = onWebhooksEnqueued(() => notified++);
    try {
      const root = await commentAdd(ctx, { path: "/a.md", body: "Root", mentions: [b.email] });
      await commentUpdate(ctx, { id: root.id, body: "Edited" });
      await commentResolve(ctx, { id: root.id, resolved: true });
      await commentResolve(ctx, { id: root.id, resolved: false });
      await commentDelete(ctx, { id: root.id });
      expect(deliveries(db)).toEqual([]);
      expect(notified).toBe(0);
    } finally {
      off();
    }
  });

  test("scope: drive hook sees its drive only, org hook sees every drive in the org", async () => {
    const { ctx, db, driveB } = fixture();
    const other = createUser(db, { email: "other@example.com" }).user;
    const otherOrg = listUserOrgs(db, other.id)[0].id;
    const otherDrive = listDrives(db, otherOrg)[0].id;

    const driveHook = addSub(db, { orgId: ctx.orgId, driveId: ctx.driveId, createdBy: ctx.userId });
    const driveBHook = addSub(db, { orgId: ctx.orgId, driveId: driveB.id, createdBy: ctx.userId });
    const orgHook = addSub(db, { orgId: ctx.orgId, createdBy: ctx.userId });
    const otherOrgHook = addSub(db, { orgId: otherOrg, createdBy: other.id });
    const otherDriveHook = addSub(db, { orgId: otherOrg, driveId: otherDrive, createdBy: other.id });
    const disabledHook = addSub(db, { orgId: ctx.orgId, createdBy: ctx.userId, enabled: false });

    const onA = await commentAdd(ctx, { path: "/a.md", body: "On A" });
    const onB = await commentAdd({ ...ctx, driveId: driveB.id }, { path: "/b.md", body: "On B" });

    expect(deliveries(db, driveHook).map((d) => d.envelope.data.comment.id)).toEqual([onA.id]);
    expect(deliveries(db, driveBHook).map((d) => d.envelope.data.comment.id)).toEqual([onB.id]);
    expect(deliveries(db, orgHook).map((d) => d.envelope.data.comment.id)).toEqual([onA.id, onB.id]);
    expect(deliveries(db, orgHook).map((d) => d.envelope.data.driveId)).toEqual([ctx.driveId, driveB.id]);
    expect(deliveries(db, otherOrgHook)).toEqual([]);
    expect(deliveries(db, otherDriveHook)).toEqual([]);
    expect(deliveries(db, disabledHook)).toEqual([]);

    // One event fans out to N hooks with the same webhook-id (the events.id).
    const createdA = eventRows(db, "comment_created", onA.id);
    expect(createdA).toHaveLength(1);
    const fanOut = deliveries(db).filter((d) => d.envelope.data.comment.id === onA.id);
    expect(fanOut.map((d) => d.eventId)).toEqual([createdA[0].id, createdA[0].id]);
    expect(new Set(fanOut.map((d) => d.id)).size).toBe(2);
  });

  test("delivery row and envelope shape", async () => {
    const { ctx, db } = fixture();
    const hook = addSub(db, { orgId: ctx.orgId, driveId: ctx.driveId, createdBy: ctx.userId });
    const withUrl = { ...ctx, appUrl: "https://live.example.com" };
    const root = await commentAdd(withUrl, {
      path: "docs/plan.md",
      body: "Root",
      lineStart: 3,
      lineEnd: 4,
      quote: { exact: "the quote", prefix: "before ", suffix: " after" },
    });
    await commentAdd(ctx, { path: "/docs/no-url.md", body: "No url" });

    const [first, second] = deliveries(db, hook);
    expect(first.status).toBe("pending");
    expect(first.attempts).toBe(0);
    expect(first.eventType).toBe("comment.created");
    expect(first.nextAttemptAt.getTime()).toBe(new Date(first.envelope.timestamp).getTime());
    expect(first.envelope).toEqual({
      type: "comment.created",
      timestamp: expect.any(String),
      data: {
        eventId: first.eventId,
        orgId: ctx.orgId,
        driveId: ctx.driveId,
        path: "/docs/plan.md",
        url: `https://live.example.com/file/~/${ctx.orgId}/${ctx.driveId}/docs/plan.md`,
        actor: { id: ctx.userId, email: "test@example.com", displayName: null },
        comment: {
          id: root.id,
          parentId: null,
          body: "Root",
          bodyTruncated: false,
          quote: { exact: "the quote", prefix: "before ", suffix: " after" },
          lineStart: 3,
          lineEnd: 4,
          resolved: false,
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
          author: { id: ctx.userId, email: "test@example.com", displayName: null },
          mentions: [],
        },
      },
    });
    expect("url" in second.envelope.data).toBe(false);
    expect(second.envelope.data.comment.quote).toBeNull();
  });

  test("event-type filter: a mentioned-only hook gets one row per mentioned user", async () => {
    const { ctx, db, b, c } = fixture();
    const mentionedOnly = addSub(db, {
      orgId: ctx.orgId,
      driveId: ctx.driveId,
      createdBy: ctx.userId,
      eventTypes: ["comment.mentioned"],
    });
    const all = addSub(db, { orgId: ctx.orgId, driveId: ctx.driveId, createdBy: ctx.userId });

    const root = await commentAdd(ctx, { path: "/m.md", body: "Hi both", mentions: [b.email, c.id] });

    const mentionEvents = eventRows(db, "comment_mention", root.id);
    expect(mentionEvents).toHaveLength(2);
    const eventIdByTarget = new Map(mentionEvents.map((e) => [e.target, e.id]));

    const rows = deliveries(db, mentionedOnly);
    expect(rows).toHaveLength(2);
    expect(rows.every((d) => d.eventType === "comment.mentioned")).toBe(true);
    for (const row of rows) {
      const mentioned = row.envelope.data.mentioned!;
      expect(row.eventId).toBe(eventIdByTarget.get(mentioned.id)!);
    }
    expect(rows.map((d) => d.envelope.data.mentioned)).toEqual(
      expect.arrayContaining([
        { id: b.id, email: "bee@example.com", displayName: "Bee" },
        { id: c.id, email: "cee@example.com", displayName: null },
      ])
    );
    expect(rows[0].envelope.data.comment.mentions.map((m) => m.id).sort()).toEqual([b.id, c.id].sort());

    const allRows = deliveries(db, all);
    expect(allRows.map((d) => d.eventType).sort()).toEqual([
      "comment.created",
      "comment.mentioned",
      "comment.mentioned",
    ]);
    const created = allRows.find((d) => d.eventType === "comment.created")!;
    expect(created.eventId).toBe(eventRows(db, "comment_created", root.id)[0].id);
    expect("mentioned" in created.envelope.data).toBe(false);
  });

  test("thread participants: root author plus reply authors, minus the actor, in order", async () => {
    const { ctx, db, b, c, as } = fixture();
    const hook = addSub(db, {
      orgId: ctx.orgId,
      driveId: ctx.driveId,
      createdBy: ctx.userId,
      eventTypes: ["comment.created"],
    });

    const root = await commentAdd(ctx, { path: "/t.md", body: "Root by A" });
    await commentAdd(as(b.id), { parentId: root.id, body: "Reply by B" });
    const byA = await commentAdd(ctx, { parentId: root.id, body: "Reply by A" });
    const byC = await commentAdd(as(c.id), { parentId: root.id, body: "Reply by C" });

    const byComment = new Map(deliveries(db, hook).map((d) => [d.envelope.data.comment.id, d.envelope.data]));
    expect("thread" in byComment.get(root.id)!).toBe(false);
    expect(byComment.get(byA.id)!.thread).toEqual({
      rootId: root.id,
      participants: [{ id: b.id, email: "bee@example.com", displayName: "Bee" }],
    });
    expect(byComment.get(byC.id)!.thread!.rootId).toBe(root.id);
    expect(byComment.get(byC.id)!.thread!.participants.map((p) => p.id)).toEqual([ctx.userId, b.id]);
    expect(byComment.get(byC.id)!.actor.id).toBe(c.id);
    expect(byComment.get(byC.id)!.comment.author.id).toBe(c.id);
  });

  test("comment-update writes a comment_updated row and delivery; only new mentions fire", async () => {
    const { ctx, db, b } = fixture();
    const hook = addSub(db, { orgId: ctx.orgId, driveId: ctx.driveId, createdBy: ctx.userId });
    const root = await commentAdd(ctx, { path: "/u.md", body: "Original" });
    const before = deliveries(db, hook).length;

    await commentUpdate(ctx, { id: root.id, body: "Edited" });
    const updatedEvents = eventRows(db, "comment_updated", root.id);
    expect(updatedEvents).toHaveLength(1);
    expect(JSON.parse(updatedEvents[0].metadata!)).toEqual({ path: "/u.md" });
    let rows = deliveries(db, hook).slice(before);
    expect(rows.map((d) => d.eventType)).toEqual(["comment.updated"]);
    expect(rows[0].eventId).toBe(updatedEvents[0].id);
    expect(rows[0].envelope.data.comment.body).toBe("Edited");

    await commentUpdate(ctx, { id: root.id, body: "Now mentions B", mentions: [b.email] });
    rows = deliveries(db, hook).slice(before + 1);
    expect(rows.map((d) => d.eventType)).toEqual(["comment.updated", "comment.mentioned"]);
    const mentionEvent = eventRows(db, "comment_mention", root.id);
    expect(mentionEvent).toHaveLength(1);
    expect(rows[1].eventId).toBe(mentionEvent[0].id);
    expect(rows[1].envelope.data.mentioned!.id).toBe(b.id);

    // Re-saving the same mention adds no comment.mentioned row.
    await commentUpdate(ctx, { id: root.id, body: "Still mentions B", mentions: [b.email] });
    rows = deliveries(db, hook).slice(before + 3);
    expect(rows.map((d) => d.eventType)).toEqual(["comment.updated"]);
    expect(eventRows(db, "comment_updated", root.id)).toHaveLength(3);

    // Removing the mention emits no webhook beyond comment.updated.
    await commentUpdate(ctx, { id: root.id, body: "No mentions", mentions: [] });
    rows = deliveries(db, hook).slice(before + 4);
    expect(rows.map((d) => d.eventType)).toEqual(["comment.updated"]);
  });

  test("resolve, reopen and delete each write one delivery; delete keeps the body", async () => {
    const { ctx, db, b, as } = fixture();
    const hook = addSub(db, { orgId: ctx.orgId, driveId: ctx.driveId, createdBy: ctx.userId });
    const root = await commentAdd(ctx, { path: "/r.md", body: "Resolve me" });
    const reply = await commentAdd(as(b.id), { parentId: root.id, body: "Reply" });
    const start = deliveries(db, hook).length;

    await commentResolve(as(b.id), { id: root.id, resolved: true });
    await commentResolve(ctx, { id: root.id, resolved: false });
    await commentDelete(as(b.id), { id: reply.id });
    await commentDelete(ctx, { id: root.id });

    const rows = deliveries(db, hook).slice(start);
    expect(rows.map((d) => [d.eventType, d.envelope.data.comment.id])).toEqual([
      ["comment.resolved", root.id],
      ["comment.reopened", root.id],
      ["comment.deleted", reply.id],
      ["comment.deleted", root.id],
    ]);
    const [resolved, reopened, deletedReply, deletedRoot] = rows;
    expect(resolved.eventId).toBe(eventRows(db, "comment_resolved", root.id)[0].id);
    expect(resolved.envelope.data.comment.resolved).toBe(true);
    expect(resolved.envelope.data.actor.id).toBe(b.id);
    expect(resolved.envelope.data.comment.author.id).toBe(ctx.userId);
    expect(reopened.eventId).toBe(eventRows(db, "comment_reopened", root.id)[0].id);
    expect(reopened.envelope.data.comment.resolved).toBe(false);
    expect(deletedReply.envelope.data.comment.body).toBe("Reply");
    expect(deletedReply.envelope.data.thread!.rootId).toBe(root.id);
    expect(deletedRoot.envelope.data.comment.body).toBe("Resolve me");
    expect(deletedRoot.eventId).toBe(eventRows(db, "comment_deleted", root.id)[0].id);
    // Deleting a root emits one event for the root only.
    expect(eventRows(db, "comment_deleted")).toHaveLength(2);
  });

  describe("atomicity", () => {
    function commentState(db: DB, id: string) {
      return db
        .select({ isDeleted: schema.comments.isDeleted, resolved: schema.comments.resolved, resolvedBy: schema.comments.resolvedBy })
        .from(schema.comments)
        .where(eq(schema.comments.id, id))
        .get();
    }

    test("a failing enqueue rolls back commentDelete and commentResolve", async () => {
      const { ctx, db, b, as } = fixture();
      addSub(db, { orgId: ctx.orgId, driveId: ctx.driveId, createdBy: ctx.userId });
      const root = await commentAdd(ctx, { path: "/x.md", body: "Root" });
      const reply = await commentAdd(as(b.id), { parentId: root.id, body: "Reply" });
      const deliveriesBefore = deliveries(db).length;

      rawOf(db).exec(
        "CREATE TRIGGER fail_webhook_enqueue BEFORE INSERT ON webhook_deliveries BEGIN SELECT RAISE(ABORT, 'enqueue failed'); END"
      );
      let notified = 0;
      const off = onWebhooksEnqueued(() => notified++);
      try {
        await expect(commentDelete(ctx, { id: root.id })).rejects.toThrow("enqueue failed");
        expect(commentState(db, root.id)!.isDeleted).toBe(false);
        expect(commentState(db, reply.id)!.isDeleted).toBe(false);
        expect(eventRows(db, "comment_deleted")).toHaveLength(0);

        await expect(commentDelete(as(b.id), { id: reply.id })).rejects.toThrow("enqueue failed");
        expect(commentState(db, reply.id)!.isDeleted).toBe(false);
        expect(eventRows(db, "comment_deleted")).toHaveLength(0);

        await expect(commentResolve(ctx, { id: root.id, resolved: true })).rejects.toThrow("enqueue failed");
        expect(commentState(db, root.id)).toEqual({ isDeleted: false, resolved: false, resolvedBy: null });
        expect(eventRows(db, "comment_resolved")).toHaveLength(0);

        expect(deliveries(db)).toHaveLength(deliveriesBefore);
        expect(notified).toBe(0);
      } finally {
        off();
      }
    });

    test("an unreadable subscription row is skipped and does not block the op", async () => {
      const { ctx, db } = fixture();
      const root = await commentAdd(ctx, { path: "/y.md", body: "Root" });
      const corrupt = addSub(db, { orgId: ctx.orgId, createdBy: ctx.userId, eventTypes: "not json" });
      const healthy = addSub(db, { orgId: ctx.orgId, driveId: ctx.driveId, createdBy: ctx.userId });

      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        await commentResolve(ctx, { id: root.id, resolved: true });
        expect(commentState(db, root.id)!.resolved).toBe(true);
        expect(eventRows(db, "comment_resolved")).toHaveLength(1);

        await commentDelete(ctx, { id: root.id });
        expect(commentState(db, root.id)!.isDeleted).toBe(true);
        expect(eventRows(db, "comment_deleted")).toHaveLength(1);

        expect(deliveries(db, corrupt)).toEqual([]);
        expect(deliveries(db, healthy).map((d) => d.eventType)).toEqual(["comment.resolved", "comment.deleted"]);
        // Logged once for the row, not once per op.
        const corruptWarnings = warn.mock.calls.filter((args) => String(args[0]).includes(corrupt));
        expect(corruptWarnings).toHaveLength(1);
      } finally {
        warn.mockRestore();
      }
    });
  });

  test("a body over the cap is cut with bodyTruncated", async () => {
    const { ctx, db } = fixture();
    const hook = addSub(db, { orgId: ctx.orgId, driveId: ctx.driveId, createdBy: ctx.userId });
    const long = "x".repeat(BODY_MAX_CHARS + 500);
    await commentAdd(ctx, { path: "/long.md", body: long });
    // A surrogate pair straddling the cut is dropped whole, never split.
    const emoji = "y".repeat(BODY_MAX_CHARS - 1) + "\u{1F600}" + "tail";
    await commentAdd(ctx, { path: "/emoji.md", body: emoji });
    await commentAdd(ctx, { path: "/exact.md", body: "z".repeat(BODY_MAX_CHARS) });

    const [cut, emojiCut, exact] = deliveries(db, hook).map((d) => d.envelope.data.comment);
    expect(cut.body).toBe("x".repeat(BODY_MAX_CHARS));
    expect(cut.bodyTruncated).toBe(true);
    expect(emojiCut.body).toBe("y".repeat(BODY_MAX_CHARS - 1));
    expect(emojiCut.bodyTruncated).toBe(true);
    expect(exact.body).toHaveLength(BODY_MAX_CHARS);
    expect(exact.bodyTruncated).toBe(false);
  });

  test("notifyWebhooksEnqueued fires once per op, after commit", async () => {
    const { ctx, db, b } = fixture();
    addSub(db, { orgId: ctx.orgId, driveId: ctx.driveId, createdBy: ctx.userId });
    const raw = rawOf(db);
    const calls: boolean[] = [];
    const off = onWebhooksEnqueued(() => calls.push(!raw.inTransaction));
    try {
      const root = await commentAdd(ctx, { path: "/n.md", body: "Root", mentions: [b.email] });
      expect(calls).toEqual([true]);
      await commentUpdate(ctx, { id: root.id, body: "Edited" });
      await commentResolve(ctx, { id: root.id, resolved: true });
      await commentResolve(ctx, { id: root.id, resolved: false });
      await commentDelete(ctx, { id: root.id });
      expect(calls).toEqual([true, true, true, true, true]);
    } finally {
      off();
    }
    // Unregistered listeners are not called.
    await commentAdd(ctx, { path: "/n2.md", body: "After off" });
    expect(calls).toHaveLength(5);
  });

  test("hooks whose event types do not match write nothing and do not notify", async () => {
    const { ctx, db } = fixture();
    addSub(db, { orgId: ctx.orgId, createdBy: ctx.userId, eventTypes: ["comment.deleted"] });
    let notified = 0;
    const off = onWebhooksEnqueued(() => notified++);
    try {
      const root = await commentAdd(ctx, { path: "/q.md", body: "Root" });
      await commentResolve(ctx, { id: root.id, resolved: true });
      expect(deliveries(db)).toEqual([]);
      expect(notified).toBe(0);
      await commentDelete(ctx, { id: root.id });
      expect(deliveries(db).map((d) => d.eventType)).toEqual(["comment.deleted"]);
      expect(notified).toBe(1);
    } finally {
      off();
    }
  });
});

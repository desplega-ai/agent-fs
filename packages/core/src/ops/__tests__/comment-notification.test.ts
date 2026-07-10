import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { schema } from "../../db/index.js";
import { createTestDb } from "../../test-utils.js";
import { ValidationError } from "../../errors.js";
import { commentAdd, commentDelete } from "../comment.js";
import {
  commentNotificationList,
  commentNotificationRead,
} from "../comment-notification.js";
import type { OpContext } from "../types.js";

const ORG_1 = "notification-org-1";
const ORG_2 = "notification-org-2";
const DRIVE_1 = "notification-drive-1";
const DRIVE_2 = "notification-drive-2";
const DRIVE_3 = "notification-drive-3";
const USER_A = "notification-user-a";
const USER_B = "notification-user-b";
const USER_C = "notification-user-c";
const USER_D = "notification-user-d";

function createFixture() {
  const db = createTestDb();
  const now = new Date();

  for (const [id, email] of [
    [USER_A, "notification-a@test.com"],
    [USER_B, "notification-b@test.com"],
    [USER_C, "notification-c@test.com"],
    [USER_D, "notification-d@test.com"],
  ] as const) {
    db.insert(schema.users)
      .values({ id, email, apiKeyHash: id, createdAt: now })
      .run();
  }

  db.insert(schema.orgs)
    .values([
      { id: ORG_1, name: "Notification Org 1", createdAt: now },
      { id: ORG_2, name: "Notification Org 2", createdAt: now },
    ])
    .run();
  db.insert(schema.drives)
    .values([
      { id: DRIVE_1, orgId: ORG_1, name: "Drive 1", createdAt: now },
      { id: DRIVE_2, orgId: ORG_1, name: "Drive 2", createdAt: now },
      { id: DRIVE_3, orgId: ORG_2, name: "Drive 3", createdAt: now },
    ])
    .run();
  db.insert(schema.orgMembers)
    .values([
      { orgId: ORG_1, userId: USER_A, role: "editor" },
      { orgId: ORG_1, userId: USER_B, role: "viewer" },
      { orgId: ORG_1, userId: USER_C, role: "editor" },
      { orgId: ORG_2, userId: USER_B, role: "viewer" },
      { orgId: ORG_2, userId: USER_D, role: "editor" },
    ])
    .run();
  db.insert(schema.driveMembers)
    .values([
      { driveId: DRIVE_1, userId: USER_A, role: "editor" },
      { driveId: DRIVE_1, userId: USER_B, role: "viewer" },
      { driveId: DRIVE_2, userId: USER_C, role: "editor" },
      { driveId: DRIVE_2, userId: USER_B, role: "viewer" },
      { driveId: DRIVE_3, userId: USER_D, role: "editor" },
      { driveId: DRIVE_3, userId: USER_B, role: "viewer" },
    ])
    .run();

  const ctx = (orgId: string, driveId: string, userId: string): OpContext => ({
    db,
    s3: null as any,
    orgId,
    driveId,
    userId,
  });

  return {
    db,
    ctxA1: ctx(ORG_1, DRIVE_1, USER_A),
    ctxB1: ctx(ORG_1, DRIVE_1, USER_B),
    ctxB2: ctx(ORG_1, DRIVE_2, USER_B),
    ctxB3: ctx(ORG_2, DRIVE_3, USER_B),
    ctxC2: ctx(ORG_1, DRIVE_2, USER_C),
    ctxD3: ctx(ORG_2, DRIVE_3, USER_D),
  };
}

describe("comment notifications", () => {
  test("requires notification IDs or all=true when marking read", async () => {
    const { ctxB1 } = createFixture();

    await expect(commentNotificationRead(ctxB1, {})).rejects.toThrow(
      ValidationError
    );
    await expect(
      commentNotificationRead(ctxB1, { ids: ["notification-id"], all: true })
    ).rejects.toThrow(ValidationError);
  });

  test("emits one targeted notification per other current drive member", async () => {
    const { db, ctxA1, ctxB1, ctxB2 } = createFixture();
    const comment = await commentAdd(ctxA1, {
      path: "/docs/notification.md",
      body: "Please review this",
    });

    const events = db
      .select()
      .from(schema.events)
      .where(eq(schema.events.type, "comment_notification"))
      .all();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      resourceType: "comment",
      resourceId: comment.id,
      actor: USER_A,
      target: USER_B,
      status: "created",
    });

    const recipient = await commentNotificationList(ctxB1, {});
    expect(recipient.unreadCount).toBe(1);
    expect(recipient.notifications).toEqual([
      expect.objectContaining({
        id: events[0].id,
        commentId: comment.id,
        path: "/docs/notification.md",
        body: "Please review this",
        actor: USER_A,
        read: false,
      }),
    ]);

    expect((await commentNotificationList(ctxA1, {})).notifications).toEqual([]);
    expect((await commentNotificationList(ctxB2, {})).notifications).toEqual([]);

    // The existing target-less lifecycle event remains audit-only and is not
    // interpreted as an unread notification by the new API.
    const auditEvent = db
      .select()
      .from(schema.events)
      .where(
        and(
          eq(schema.events.type, "comment_created"),
          eq(schema.events.resourceId, comment.id)
        )
      )
      .get();
    expect(auditEvent?.target).toBeNull();
  });

  test("notifies for replies and includes the parent ID", async () => {
    const { ctxA1, ctxB1 } = createFixture();
    const root = await commentAdd(ctxA1, {
      path: "/docs/thread.md",
      body: "Root",
    });
    const reply = await commentAdd(ctxA1, {
      parentId: root.id,
      body: "Reply",
    });

    const result = await commentNotificationList(ctxB1, {});
    const replyNotification = result.notifications.find(
      (notification) => notification.commentId === reply.id
    );
    expect(replyNotification).toMatchObject({
      parentId: root.id,
      path: "/docs/thread.md",
      body: "Reply",
    });
  });

  test("marks selected or all active-drive notifications as read", async () => {
    const { db, ctxA1, ctxB1 } = createFixture();
    await commentAdd(ctxA1, { path: "/docs/one.md", body: "One" });
    await commentAdd(ctxA1, { path: "/docs/two.md", body: "Two" });

    const initial = await commentNotificationList(ctxB1, {});
    expect(initial.unreadCount).toBe(2);

    expect(
      await commentNotificationRead(ctxB1, { ids: [initial.notifications[0].id] })
    ).toEqual({ markedRead: 1 });
    expect(
      await commentNotificationRead(ctxB1, { ids: [initial.notifications[0].id] })
    ).toEqual({ markedRead: 0 });

    const partiallyRead = await commentNotificationList(ctxB1, {});
    expect(partiallyRead.unreadCount).toBe(1);
    expect(partiallyRead.notifications.filter((item) => item.read)).toHaveLength(1);
    const readNotification = partiallyRead.notifications.find((item) => item.read)!;
    const unreadNotification = partiallyRead.notifications.find((item) => !item.read)!;
    db.update(schema.events)
      .set({ createdAt: new Date(Date.now() + 60_000) })
      .where(eq(schema.events.id, readNotification.id))
      .run();
    expect(
      (await commentNotificationList(ctxB1, { limit: 1 })).notifications[0].id
    ).toBe(unreadNotification.id);
    expect(
      (await commentNotificationList(ctxB1, { unreadOnly: true })).notifications
    ).toHaveLength(1);

    expect(await commentNotificationRead(ctxB1, { all: true })).toEqual({
      markedRead: 1,
    });
    expect((await commentNotificationList(ctxB1, {})).unreadCount).toBe(0);
  });

  test("read operations cannot cross user, drive, or org boundaries", async () => {
    const { db, ctxA1, ctxB1, ctxB2, ctxB3, ctxC2, ctxD3 } = createFixture();
    await commentAdd(ctxA1, { path: "/drive-1.md", body: "Drive 1" });
    await commentAdd(ctxC2, { path: "/drive-2.md", body: "Drive 2" });
    await commentAdd(ctxD3, { path: "/drive-3.md", body: "Drive 3" });

    const drive1Notification = (await commentNotificationList(ctxB1, {}))
      .notifications[0];
    expect(drive1Notification).toBeDefined();
    expect((await commentNotificationList(ctxB2, {})).notifications).toHaveLength(1);
    expect((await commentNotificationList(ctxB3, {})).notifications).toHaveLength(1);

    expect(
      await commentNotificationRead(ctxA1, { ids: [drive1Notification.id] })
    ).toEqual({ markedRead: 0 });
    expect(
      await commentNotificationRead(ctxB2, { ids: [drive1Notification.id] })
    ).toEqual({ markedRead: 0 });
    expect(
      await commentNotificationRead(ctxB3, { ids: [drive1Notification.id] })
    ).toEqual({ markedRead: 0 });

    expect(
      db
        .select({ status: schema.events.status })
        .from(schema.events)
        .where(eq(schema.events.id, drive1Notification.id))
        .get()?.status
    ).toBe("created");
    expect(
      await commentNotificationRead(ctxB1, { ids: [drive1Notification.id] })
    ).toEqual({ markedRead: 1 });
  });

  test("does not return notifications whose comments were deleted", async () => {
    const { ctxA1, ctxB1 } = createFixture();
    const comment = await commentAdd(ctxA1, {
      path: "/docs/deleted.md",
      body: "Delete me",
    });
    await commentDelete(ctxA1, { id: comment.id });

    expect(await commentNotificationList(ctxB1, {})).toEqual({
      notifications: [],
      unreadCount: 0,
    });
  });
});

import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { schema } from "../../db/index.js";
import { ValidationError } from "../../errors.js";
import { createTestDb } from "../../test-utils.js";
import { commentNotificationList, commentNotificationRead } from "../comment-notification.js";
import { commentAdd, commentGet, commentList, commentUpdate } from "../comment.js";
import type { OpContext } from "../types.js";

const ORG_ID = "mention-org";
const DRIVE_ID = "mention-drive";
const AUTHOR_ID = "mention-author";
const MEMBER_B_ID = "mention-member-b";
const MEMBER_C_ID = "mention-member-c";
const OUTSIDER_ID = "mention-outsider";

function createFixture() {
  const db = createTestDb();
  const now = new Date();
  db.insert(schema.users)
    .values([
      {
        id: AUTHOR_ID,
        email: "author@test.com",
        displayName: "Author",
        apiKeyHash: "author",
        createdAt: now,
      },
      {
        id: MEMBER_B_ID,
        email: "member-b@test.com",
        displayName: "Member B",
        apiKeyHash: "member-b",
        createdAt: now,
      },
      {
        id: MEMBER_C_ID,
        email: "member-c@test.com",
        displayName: null,
        apiKeyHash: "member-c",
        createdAt: now,
      },
      {
        id: OUTSIDER_ID,
        email: "outsider@test.com",
        displayName: "Outsider",
        apiKeyHash: "outsider",
        createdAt: now,
      },
    ])
    .run();
  db.insert(schema.orgs)
    .values({ id: ORG_ID, name: "Mention Org", createdAt: now })
    .run();
  db.insert(schema.drives)
    .values({ id: DRIVE_ID, orgId: ORG_ID, name: "Mention Drive", createdAt: now })
    .run();
  db.insert(schema.driveMembers)
    .values([
      { driveId: DRIVE_ID, userId: AUTHOR_ID, role: "editor" },
      { driveId: DRIVE_ID, userId: MEMBER_B_ID, role: "viewer" },
      { driveId: DRIVE_ID, userId: MEMBER_C_ID, role: "viewer" },
    ])
    .run();

  const ctx = (userId: string): OpContext => ({
    db,
    s3: null as any,
    orgId: ORG_ID,
    driveId: DRIVE_ID,
    userId,
  });

  return {
    db,
    author: ctx(AUTHOR_ID),
    memberB: ctx(MEMBER_B_ID),
    memberC: ctx(MEMBER_C_ID),
  };
}

describe("comment mentions", () => {
  test("resolves user IDs and emails case-insensitively without duplicates", async () => {
    const { db, author } = createFixture();
    const comment = await commentAdd(author, {
      path: "/mentions.md",
      body: "Please review",
      mentions: [MEMBER_B_ID, "MEMBER-B@TEST.COM"],
    });

    expect(
      db.select()
        .from(schema.commentMentions)
        .where(eq(schema.commentMentions.commentId, comment.id))
        .all()
    ).toHaveLength(1);
    expect(
      db.select()
        .from(schema.commentMentions)
        .where(eq(schema.commentMentions.commentId, comment.id))
        .get()?.userId
    ).toBe(MEMBER_B_ID);
  });

  test("rejects an email that case-insensitively matches multiple members", async () => {
    const { db, author } = createFixture();
    const ambiguousUserId = "mention-member-b-case-variant";
    const target = "MEMBER-B@TEST.COM";
    db.insert(schema.users)
      .values({
        id: ambiguousUserId,
        email: "Member-B@Test.com",
        apiKeyHash: ambiguousUserId,
        createdAt: new Date(),
      })
      .run();
    db.insert(schema.driveMembers)
      .values({ driveId: DRIVE_ID, userId: ambiguousUserId, role: "viewer" })
      .run();

    const error = await commentAdd(author, {
      path: "/ambiguous.md",
      body: "Ambiguous mention",
      mentions: [target],
    }).then(
      () => undefined,
      (cause) => cause
    );

    expect(error).toBeInstanceOf(ValidationError);
    expect(error.message).toContain(target);
    expect(error.suggestion).toContain("user ID");
    expect(db.select().from(schema.comments).all()).toEqual([]);

    const byId = await commentAdd(author, {
      path: "/unambiguous.md",
      body: "Exact user ID",
      mentions: [ambiguousUserId],
    });
    expect(
      db.select({ userId: schema.commentMentions.userId })
        .from(schema.commentMentions)
        .where(eq(schema.commentMentions.commentId, byId.id))
        .all()
    ).toEqual([{ userId: ambiguousUserId }]);
  });

  test("rejects unknown or non-member targets before creating a comment", async () => {
    const { db, author } = createFixture();

    for (const target of [OUTSIDER_ID, "unknown@test.com"]) {
      await expect(
        commentAdd(author, {
          path: "/invalid.md",
          body: "Invalid mention",
          mentions: [target],
        })
      ).rejects.toThrow(ValidationError);
      await expect(
        commentAdd(author, {
          path: "/invalid.md",
          body: "Invalid mention",
          mentions: [target],
        })
      ).rejects.toThrow(target);
    }

    expect(db.select().from(schema.comments).all()).toEqual([]);
  });

  test("drops mentions of the comment author", async () => {
    const { db, author } = createFixture();
    const comment = await commentAdd(author, {
      path: "/self.md",
      body: "Self mention",
      mentions: [AUTHOR_ID, "AUTHOR@TEST.COM"],
    });

    expect(
      db.select()
        .from(schema.commentMentions)
        .where(eq(schema.commentMentions.commentId, comment.id))
        .all()
    ).toEqual([]);
    expect(
      db.select()
        .from(schema.events)
        .where(eq(schema.events.type, "comment_mention"))
        .all()
    ).toEqual([]);
  });

  test("lists and reads targeted mention notifications separately", async () => {
    const { author, memberB } = createFixture();
    const comment = await commentAdd(author, {
      path: "/notification.md",
      body: "Please decide",
      mentions: [MEMBER_B_ID],
    });

    const mentionInbox = await commentNotificationList(memberB, {
      kinds: ["mention"],
    });
    expect(mentionInbox.unreadCount).toBe(1);
    expect(mentionInbox.notifications).toEqual([
      expect.objectContaining({
        kind: "mention",
        commentId: comment.id,
        actor: AUTHOR_ID,
        read: false,
      }),
    ]);

    const defaultInbox = await commentNotificationList(memberB, {});
    expect(defaultInbox.notifications).toEqual([
      expect.objectContaining({ kind: "comment", commentId: comment.id }),
    ]);
    expect(defaultInbox.notifications.some((entry) => entry.kind === "mention")).toBe(false);

    expect(
      await commentNotificationRead(memberB, {
        ids: [mentionInbox.notifications[0].id],
      })
    ).toEqual({ markedRead: 1 });
    expect(
      await commentNotificationList(memberB, { kinds: ["mention"] })
    ).toMatchObject({ unreadCount: 0 });
  });

  test("updates the mention set and notifies only newly added members", async () => {
    const { db, author } = createFixture();
    const comment = await commentAdd(author, {
      path: "/update.md",
      body: "Initial",
      mentions: [MEMBER_B_ID],
    });

    await commentUpdate(author, { id: comment.id, body: "Body only" });
    expect(
      db.select({ userId: schema.commentMentions.userId })
        .from(schema.commentMentions)
        .where(eq(schema.commentMentions.commentId, comment.id))
        .all()
    ).toEqual([{ userId: MEMBER_B_ID }]);

    await commentUpdate(author, {
      id: comment.id,
      body: "Add C",
      mentions: [MEMBER_B_ID, MEMBER_C_ID],
    });

    const mentionEvents = () => db
      .select()
      .from(schema.events)
      .where(
        and(
          eq(schema.events.type, "comment_mention"),
          eq(schema.events.resourceId, comment.id)
        )
      )
      .all();
    expect(mentionEvents().filter((event) => event.target === MEMBER_B_ID)).toHaveLength(1);
    expect(mentionEvents().filter((event) => event.target === MEMBER_C_ID)).toHaveLength(1);

    await commentUpdate(author, {
      id: comment.id,
      body: "Remove B",
      mentions: [MEMBER_C_ID],
    });

    expect(
      db.select({ userId: schema.commentMentions.userId })
        .from(schema.commentMentions)
        .where(eq(schema.commentMentions.commentId, comment.id))
        .all()
    ).toEqual([{ userId: MEMBER_C_ID }]);
    expect(mentionEvents()).toHaveLength(2);
  });

  test("returns mention profiles for roots and replies", async () => {
    const { author, memberB } = createFixture();
    const root = await commentAdd(author, {
      path: "/thread.md",
      body: "Root",
      mentions: [MEMBER_B_ID],
    });
    const reply = await commentAdd(memberB, {
      parentId: root.id,
      body: "Reply",
      mentions: [MEMBER_C_ID],
    });

    const list = await commentList(author, { path: "/thread.md" });
    expect(list.comments[0].mentions).toEqual([
      {
        userId: MEMBER_B_ID,
        email: "member-b@test.com",
        displayName: "Member B",
      },
    ]);
    expect(list.comments[0].replies[0]).toMatchObject({
      id: reply.id,
      mentions: [
        {
          userId: MEMBER_C_ID,
          email: "member-c@test.com",
          displayName: null,
        },
      ],
    });

    const get = await commentGet(author, { id: root.id });
    expect(get.comment.mentions).toEqual(list.comments[0].mentions);
    expect(get.replies[0].mentions).toEqual(list.comments[0].replies[0].mentions);
  });
});

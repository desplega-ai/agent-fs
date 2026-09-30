import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createTestContext } from "../../test-utils.js";
import { schema } from "../../db/index.js";
import { subscribeDrive, type DriveEvent } from "../../events/bus.js";
import { commentAdd, commentUpdate, commentResolve, commentDelete } from "../comment.js";

describe("comment change events", () => {
  test("add, reply, update, resolve, reopen, and delete publish one event each", async () => {
    const { ctx, db } = createTestContext();
    const received: DriveEvent[] = [];
    const stored: Array<{ body: string; resolved: boolean; isDeleted: boolean } | undefined> = [];
    const unsubscribe = subscribeDrive(ctx.driveId, (event) => {
      received.push(event);
      if (event.type === "comment.changed") {
        stored.push(db.select().from(schema.comments).where(eq(schema.comments.id, event.commentId)).get());
      }
    });
    try {
      const root = await commentAdd(ctx, { path: "/docs/a.md", body: "Root" });
      const reply = await commentAdd(ctx, { parentId: root.id, body: "Reply" });
      await commentUpdate(ctx, { id: reply.id, body: "Updated" });
      await commentResolve(ctx, { id: root.id, resolved: true });
      await commentResolve(ctx, { id: root.id, resolved: false });
      await commentDelete(ctx, { id: reply.id });
      await commentDelete(ctx, { id: root.id });

      const expected = [
        [root.id, null, "created"],
        [reply.id, root.id, "created"],
        [reply.id, root.id, "updated"],
        [root.id, null, "resolved"],
        [root.id, null, "reopened"],
        [reply.id, root.id, "deleted"],
        [root.id, null, "deleted"],
      ] as const;
      expect(received).toEqual(expected.map(([commentId, parentId, action]) => ({
        type: "comment.changed", driveId: ctx.driveId, path: "/docs/a.md",
        commentId, parentId, action, actor: ctx.userId, at: expect.any(String),
      })));
      expect(stored.map((row) => row?.body)).toEqual(["Root", "Reply", "Updated", "Root", "Root", "Updated", "Root"]);
      expect(stored.map((row) => row?.resolved)).toEqual([false, false, false, true, false, false, false]);
      expect(stored.map((row) => row?.isDeleted)).toEqual([false, false, false, false, false, true, true]);
      for (const event of received) expect(new Date(event.at).toISOString()).toBe(event.at);
    } finally {
      unsubscribe();
    }
  });

  test("failed mutations publish nothing", async () => {
    const { ctx } = createTestContext();
    const root = await commentAdd(ctx, { path: "/a.md", body: "Root" });
    const reply = await commentAdd(ctx, { parentId: root.id, body: "Reply" });
    const received: DriveEvent[] = [];
    const unsubscribe = subscribeDrive(ctx.driveId, (event) => received.push(event));
    try {
      await expect(commentAdd(ctx, { path: "/a.md", body: "Bad mention", mentions: ["missing@example.com"] })).rejects.toThrow();
      await expect(commentUpdate(ctx, { id: "missing", body: "Missing" })).rejects.toThrow();
      await expect(commentResolve(ctx, { id: reply.id, resolved: true })).rejects.toThrow();
      await expect(commentDelete({ ...ctx, userId: "another-user" }, { id: root.id })).rejects.toThrow();
      expect(received).toEqual([]);
    } finally {
      unsubscribe();
    }
  });
});

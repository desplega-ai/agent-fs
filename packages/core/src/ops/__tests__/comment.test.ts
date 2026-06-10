import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { createDatabase, schema } from "../../db/index.js";
import type { OpContext } from "../types.js";
import {
  commentAdd,
  commentList,
  commentGet,
  commentUpdate,
  commentDelete,
  commentResolve,
} from "../comment.js";
import { NotFoundError, ValidationError, PermissionDeniedError } from "../../errors.js";

const TEST_DB = join(tmpdir(), `agent-fs-comment-test-${Date.now()}.db`);
const ORG_ID = "test-org";
const DRIVE_ID = "test-drive";
const OTHER_DRIVE_ID = "test-drive-2";
const OTHER_ORG_ID = "other-org";
const OTHER_ORG_DRIVE_ID = "other-org-drive";
const USER_A = "user-a";
const USER_B = "user-b";
const USER_C = "user-c";

let ctx: OpContext;
let ctxB: OpContext;
let ctxOtherDrive: OpContext;
let ctxOtherOrg: OpContext;

beforeAll(() => {
  const db = createDatabase(TEST_DB);
  const now = new Date();

  // Seed FK data
  db.insert(schema.users).values({ id: USER_A, email: "a@test.com", apiKeyHash: "a", createdAt: now }).run();
  db.insert(schema.users).values({ id: USER_B, email: "b@test.com", apiKeyHash: "b", createdAt: now }).run();
  db.insert(schema.users).values({ id: USER_C, email: "c@test.com", apiKeyHash: "c", createdAt: now }).run();
  db.insert(schema.orgs).values({ id: ORG_ID, name: "Test Org", createdAt: now }).run();
  db.insert(schema.orgs).values({ id: OTHER_ORG_ID, name: "Other Org", createdAt: now }).run();
  db.insert(schema.drives).values({ id: DRIVE_ID, orgId: ORG_ID, name: "default", isDefault: true, createdAt: now }).run();
  db.insert(schema.drives).values({ id: OTHER_DRIVE_ID, orgId: ORG_ID, name: "second", isDefault: false, createdAt: now }).run();
  db.insert(schema.drives).values({ id: OTHER_ORG_DRIVE_ID, orgId: OTHER_ORG_ID, name: "default", isDefault: true, createdAt: now }).run();
  db.insert(schema.orgMembers).values({ orgId: ORG_ID, userId: USER_A, role: "admin" }).run();
  db.insert(schema.orgMembers).values({ orgId: ORG_ID, userId: USER_B, role: "editor" }).run();
  db.insert(schema.orgMembers).values({ orgId: OTHER_ORG_ID, userId: USER_C, role: "admin" }).run();
  db.insert(schema.driveMembers).values({ driveId: DRIVE_ID, userId: USER_A, role: "admin" }).run();
  db.insert(schema.driveMembers).values({ driveId: DRIVE_ID, userId: USER_B, role: "editor" }).run();
  db.insert(schema.driveMembers).values({ driveId: OTHER_DRIVE_ID, userId: USER_A, role: "admin" }).run();
  db.insert(schema.driveMembers).values({ driveId: OTHER_ORG_DRIVE_ID, userId: USER_C, role: "admin" }).run();

  // S3 client is not used by comment ops — pass null cast
  const nullS3 = null as any;
  ctx = { db, s3: nullS3, orgId: ORG_ID, driveId: DRIVE_ID, userId: USER_A };
  ctxB = { db, s3: nullS3, orgId: ORG_ID, driveId: DRIVE_ID, userId: USER_B };
  // Same user/org, different drive — must not see DRIVE_ID comments
  ctxOtherDrive = { db, s3: nullS3, orgId: ORG_ID, driveId: OTHER_DRIVE_ID, userId: USER_A };
  // Different org entirely — must not see ORG_ID comments
  ctxOtherOrg = { db, s3: nullS3, orgId: OTHER_ORG_ID, driveId: OTHER_ORG_DRIVE_ID, userId: USER_C };
}, 30_000);

afterAll(() => {
  try {
    unlinkSync(TEST_DB);
    unlinkSync(TEST_DB + "-wal");
    unlinkSync(TEST_DB + "-shm");
  } catch {}
});

describe("commentAdd", () => {
  test("creates a root comment", async () => {
    const result = await commentAdd(ctx, {
      path: "/docs/readme.md",
      body: "Needs refactoring",
    });

    expect(result.id).toBeTruthy();
    expect(result.path).toBe("/docs/readme.md");
    expect(result.body).toBe("Needs refactoring");
    expect(result.author).toBe(USER_A);
    expect(result.createdAt).toBeInstanceOf(Date);
  });

  test("creates a line-range comment", async () => {
    const result = await commentAdd(ctx, {
      path: "/docs/readme.md",
      body: "Fix this section",
      lineStart: 10,
      lineEnd: 20,
    });

    expect(result.lineStart).toBe(10);
    expect(result.lineEnd).toBe(20);
  });

  test("creates a reply and resolves path from parent", async () => {
    const root = await commentAdd(ctx, {
      path: "/docs/api.md",
      body: "Root comment",
    });

    const reply = await commentAdd(ctxB, {
      parentId: root.id,
      body: "Reply to root",
    });

    expect(reply.parentId).toBe(root.id);
    expect(reply.path).toBe("/docs/api.md");
  });

  test("rejects nested reply (reply to reply)", async () => {
    const root = await commentAdd(ctx, {
      path: "/docs/nested.md",
      body: "Root",
    });

    const reply = await commentAdd(ctxB, {
      parentId: root.id,
      body: "Reply",
    });

    expect(
      commentAdd(ctx, { parentId: reply.id, body: "Nested reply" })
    ).rejects.toThrow(ValidationError);
  });

  test("requires path for root comments", async () => {
    expect(
      commentAdd(ctx, { body: "No path" })
    ).rejects.toThrow(ValidationError);
  });
});

describe("commentList", () => {
  test("filters by path", async () => {
    const result = await commentList(ctx, { path: "/docs/readme.md" });
    expect(result.comments.length).toBeGreaterThan(0);
    for (const c of result.comments) {
      expect(c.path).toBe("/docs/readme.md");
    }
  });

  test("excludes soft-deleted comments", async () => {
    const added = await commentAdd(ctx, {
      path: "/docs/deletable.md",
      body: "Will be deleted",
    });

    await commentDelete(ctx, { id: added.id });

    const result = await commentList(ctx, { path: "/docs/deletable.md" });
    const ids = result.comments.map((c) => c.id);
    expect(ids).not.toContain(added.id);
  });

  test("filters by resolved state", async () => {
    const added = await commentAdd(ctx, {
      path: "/docs/resolvable.md",
      body: "To resolve",
    });
    await commentResolve(ctx, { id: added.id, resolved: true });

    // Default list (unresolved) should not include it
    const unresolved = await commentList(ctx, { path: "/docs/resolvable.md" });
    const unresolvedIds = unresolved.comments.map((c) => c.id);
    expect(unresolvedIds).not.toContain(added.id);

    // With resolved=true should include it
    const resolved = await commentList(ctx, {
      path: "/docs/resolvable.md",
      resolved: true,
    });
    const resolvedIds = resolved.comments.map((c) => c.id);
    expect(resolvedIds).toContain(added.id);
  });
});

describe("commentGet", () => {
  test("returns comment with replies", async () => {
    const root = await commentAdd(ctx, {
      path: "/docs/gettest.md",
      body: "Root for get test",
    });

    await commentAdd(ctxB, { parentId: root.id, body: "Reply 1" });
    await commentAdd(ctx, { parentId: root.id, body: "Reply 2" });

    const result = await commentGet(ctx, { id: root.id });
    expect(result.comment.id).toBe(root.id);
    expect(result.comment.replyCount).toBe(2);
    expect(result.replies.length).toBe(2);
  });

  test("throws NotFoundError for missing comment", async () => {
    expect(
      commentGet(ctx, { id: "nonexistent" })
    ).rejects.toThrow(NotFoundError);
  });
});

describe("commentUpdate", () => {
  test("updates comment body", async () => {
    const added = await commentAdd(ctx, {
      path: "/docs/update.md",
      body: "Original body",
    });

    const result = await commentUpdate(ctx, {
      id: added.id,
      body: "Updated body",
    });

    expect(result.body).toBe("Updated body");
    expect(result.updatedAt.getTime()).toBeGreaterThanOrEqual(added.createdAt.getTime());
  });

  test("rejects update from non-author", async () => {
    const added = await commentAdd(ctx, {
      path: "/docs/update-perm.md",
      body: "By user A",
    });

    expect(
      commentUpdate(ctxB, { id: added.id, body: "By user B" })
    ).rejects.toThrow(PermissionDeniedError);
  });
});

describe("commentDelete", () => {
  test("soft-deletes root comment and replies", async () => {
    const root = await commentAdd(ctx, {
      path: "/docs/delete-cascade.md",
      body: "Root to delete",
    });

    await commentAdd(ctx, { parentId: root.id, body: "Reply" });

    const deleteResult = await commentDelete(ctx, { id: root.id });
    expect(deleteResult.deleted).toBe(true);

    // Both root and reply should be gone from list
    const list = await commentList(ctx, { path: "/docs/delete-cascade.md" });
    expect(list.comments.map((c) => c.id)).not.toContain(root.id);

    // Get should also fail
    expect(commentGet(ctx, { id: root.id })).rejects.toThrow(NotFoundError);
  });

  test("rejects delete from non-author", async () => {
    const added = await commentAdd(ctx, {
      path: "/docs/delete-perm.md",
      body: "By user A",
    });

    expect(
      commentDelete(ctxB, { id: added.id })
    ).rejects.toThrow(PermissionDeniedError);
  });
});

describe("commentResolve", () => {
  test("resolves and reopens a comment", async () => {
    const added = await commentAdd(ctx, {
      path: "/docs/resolve.md",
      body: "To resolve",
    });

    const resolved = await commentResolve(ctx, { id: added.id, resolved: true });
    expect(resolved.resolved).toBe(true);
    expect(resolved.resolvedBy).toBe(USER_A);
    expect(resolved.resolvedAt).toBeInstanceOf(Date);

    const reopened = await commentResolve(ctx, { id: added.id, resolved: false });
    expect(reopened.resolved).toBe(false);
    expect(reopened.resolvedBy).toBeUndefined();
    expect(reopened.resolvedAt).toBeUndefined();
  });

  test("rejects resolve on a reply", async () => {
    const root = await commentAdd(ctx, {
      path: "/docs/resolve-reply.md",
      body: "Root",
    });

    const reply = await commentAdd(ctxB, {
      parentId: root.id,
      body: "Reply",
    });

    expect(
      commentResolve(ctx, { id: reply.id, resolved: true })
    ).rejects.toThrow(ValidationError);
  });
});

describe("events", () => {
  test("emits events for create, resolve, delete", async () => {
    const added = await commentAdd(ctx, {
      path: "/docs/events.md",
      body: "Event test",
    });

    await commentResolve(ctx, { id: added.id, resolved: true });

    // Create a new comment to delete (can't delete the resolved one as different flow)
    const toDelete = await commentAdd(ctx, {
      path: "/docs/events2.md",
      body: "Delete event test",
    });
    await commentDelete(ctx, { id: toDelete.id });

    // Verify events exist
    const events = ctx.db
      .select()
      .from(schema.events)
      .where(
        eq(schema.events.resourceType, "comment")
      )
      .all();

    const types = events.map((e) => e.type);
    expect(types).toContain("comment_created");
    expect(types).toContain("comment_resolved");
    expect(types).toContain("comment_deleted");
  });
});

describe("cross-tenant comment scoping", () => {
  test("cross-tenant comment IDs are not found", async () => {
    const root = await commentAdd(ctx, {
      path: "/docs/tenant.md",
      body: "Drive A comment",
    });

    // Same org, different drive — every ID-based op must behave as if the
    // comment does not exist (NotFoundError, never PermissionDeniedError,
    // even though USER_A is the author).
    expect(commentGet(ctxOtherDrive, { id: root.id })).rejects.toThrow(NotFoundError);
    expect(commentUpdate(ctxOtherDrive, { id: root.id, body: "hijack" })).rejects.toThrow(NotFoundError);
    expect(commentDelete(ctxOtherDrive, { id: root.id })).rejects.toThrow(NotFoundError);
    expect(commentResolve(ctxOtherDrive, { id: root.id, resolved: true })).rejects.toThrow(NotFoundError);
    expect(commentAdd(ctxOtherDrive, { parentId: root.id, body: "cross-drive reply" })).rejects.toThrow(NotFoundError);

    // Different org — same behavior
    expect(commentGet(ctxOtherOrg, { id: root.id })).rejects.toThrow(NotFoundError);
    expect(commentUpdate(ctxOtherOrg, { id: root.id, body: "hijack" })).rejects.toThrow(NotFoundError);
    expect(commentDelete(ctxOtherOrg, { id: root.id })).rejects.toThrow(NotFoundError);
    expect(commentResolve(ctxOtherOrg, { id: root.id, resolved: true })).rejects.toThrow(NotFoundError);
    expect(commentAdd(ctxOtherOrg, { parentId: root.id, body: "cross-org reply" })).rejects.toThrow(NotFoundError);

    // The comment is untouched in its own drive
    const stillThere = await commentGet(ctx, { id: root.id });
    expect(stillThere.comment.body).toBe("Drive A comment");
    expect(stillThere.comment.resolved).toBe(false);
  });

  test("cross-drive comments do not appear in list or inline replies", async () => {
    const root = await commentAdd(ctx, {
      path: "/docs/tenant-list.md",
      body: "Drive A root",
    });
    const legitReply = await commentAdd(ctxB, {
      parentId: root.id,
      body: "Legit same-drive reply",
    });

    // Forge a reply row pointing at the drive-A root but living in another
    // drive (simulates tampered or legacy data) — scoped reply queries must
    // exclude it.
    const now = new Date();
    ctx.db
      .insert(schema.comments)
      .values({
        id: "forged-cross-drive-reply",
        parentId: root.id,
        orgId: ORG_ID,
        driveId: OTHER_DRIVE_ID,
        path: "/docs/tenant-list.md",
        body: "Forged cross-drive reply",
        author: USER_A,
        resolved: false,
        createdAt: now,
        updatedAt: now,
        isDeleted: false,
      })
      .run();

    // commentList from another drive at the same path sees nothing
    const otherDriveList = await commentList(ctxOtherDrive, { path: "/docs/tenant-list.md" });
    expect(otherDriveList.comments.map((c) => c.id)).not.toContain(root.id);

    // commentGet excludes the forged reply from replies and replyCount
    const got = await commentGet(ctx, { id: root.id });
    expect(got.comment.replyCount).toBe(1);
    expect(got.replies.map((r) => r.id)).toEqual([legitReply.id]);

    // commentList inline replies exclude the forged reply too
    const list = await commentList(ctx, { path: "/docs/tenant-list.md" });
    const rootEntry = list.comments.find((c) => c.id === root.id);
    expect(rootEntry).toBeDefined();
    expect(rootEntry!.replies.map((r) => r.id)).toEqual([legitReply.id]);

    // Deleting the root cascades only within the drive — forged row untouched
    await commentDelete(ctx, { id: root.id });
    const forged = ctx.db
      .select()
      .from(schema.comments)
      .where(eq(schema.comments.id, "forged-cross-drive-reply"))
      .get();
    expect(forged!.isDeleted).toBe(false);
  });

  test("author-only comment mutations still apply", async () => {
    const added = await commentAdd(ctx, {
      path: "/docs/tenant-author.md",
      body: "By user A",
    });

    // Same drive, non-author: still PermissionDeniedError (not NotFound)
    expect(commentUpdate(ctxB, { id: added.id, body: "By user B" })).rejects.toThrow(PermissionDeniedError);
    expect(commentDelete(ctxB, { id: added.id })).rejects.toThrow(PermissionDeniedError);

    // Author can still update and delete within the same drive
    const updated = await commentUpdate(ctx, { id: added.id, body: "Edited by author" });
    expect(updated.body).toBe("Edited by author");

    const deleted = await commentDelete(ctx, { id: added.id });
    expect(deleted.deleted).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { schema } from "../../db/index.js";
import { createUser } from "../../identity/users.js";
import { setDriveMember } from "../../identity/drives.js";
import { createTestContext } from "../../test-utils.js";
import { dispatchOp } from "../index.js";
import type { DriveMembersResult } from "../types.js";

describe("drive-members", () => {
  test("a viewer sees only public members of the active drive", async () => {
    const { ctx, db, userId, driveId } = createTestContext();
    db.update(schema.users)
      .set({ displayName: "Admin" })
      .where(eq(schema.users.id, userId))
      .run();

    const viewer = createUser(db, { email: "viewer@example.com" });
    setDriveMember(db, {
      driveId,
      userId: viewer.user.id,
      role: "viewer",
    });
    const outsider = createUser(db, { email: "outsider@example.com" });

    const result = await dispatchOp(
      { ...ctx, userId: viewer.user.id },
      "drive-members",
      {}
    ) as DriveMembersResult;

    expect(result.members).toEqual([
      {
        userId,
        email: "test@example.com",
        displayName: "Admin",
      },
      {
        userId: viewer.user.id,
        email: "viewer@example.com",
        displayName: null,
      },
    ]);
    expect(result.members.some((member) => member.userId === outsider.user.id)).toBe(false);
    for (const member of result.members) {
      expect(member).not.toHaveProperty("role");
    }
  });
});

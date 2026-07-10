import { describe, expect, test } from "bun:test";
import { commentCommands } from "../commands/comment.js";
import type { ApiClient } from "../api-client.js";

describe("comment commands", () => {
  test("includes the resolved drive in notification operations", async () => {
    const calls: Array<{
      orgId: string;
      op: string;
      params: Record<string, unknown>;
    }> = [];
    const client = {
      callOp: async (
        orgId: string,
        op: string,
        params: Record<string, unknown>
      ) => {
        calls.push({ orgId, op, params });
        return { notifications: [], unreadCount: 0 };
      },
    } as Pick<ApiClient, "callOp"> as ApiClient;

    const command = commentCommands(
      client,
      () => "org-1",
      (orgId) => {
        expect(orgId).toBe("org-1");
        return "drive-2";
      }
    );

    await command.parseAsync(["notifications", "--unread"], { from: "user" });

    expect(calls).toEqual([
      {
        orgId: "org-1",
        op: "comment-notification-list",
        params: { unreadOnly: true, driveId: "drive-2" },
      },
    ]);
  });
});

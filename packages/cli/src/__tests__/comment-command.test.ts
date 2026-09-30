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

  test("maps --prefix to pathPrefix", async () => {
    const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
    const client = {
      callOp: async (_orgId: string, op: string, params: Record<string, unknown>) => {
        calls.push({ op, params });
        return { comments: [] };
      },
    } as Pick<ApiClient, "callOp"> as ApiClient;

    const command = commentCommands(client, () => "org-1", () => "drive-2");
    await command.parseAsync(["list", "--prefix", "docs/"], { from: "user" });

    expect(calls).toEqual([
      {
        op: "comment-list",
        params: { pathPrefix: "docs/", driveId: "drive-2" },
      },
    ]);
  });

  test("maps repeatable mention flags for add, reply, and update", async () => {
    const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
    const client = {
      callOp: async (_orgId: string, op: string, params: Record<string, unknown>) => {
        calls.push({ op, params });
        return {};
      },
    } as Pick<ApiClient, "callOp"> as ApiClient;
    const command = commentCommands(client, () => "org-1", () => "drive-2");

    await command.parseAsync([
      "add",
      "/doc.md",
      "--body",
      "Review",
      "--mention",
      "user-1",
      "--mention",
      "person@example.com",
    ], { from: "user" });
    await command.parseAsync([
      "reply",
      "comment-1",
      "--body",
      "Reply",
      "--mention",
      "user-2",
    ], { from: "user" });
    await command.parseAsync([
      "update",
      "comment-2",
      "--body",
      "Updated",
      "--mention",
      "user-3",
    ], { from: "user" });

    expect(calls).toEqual([
      {
        op: "comment-add",
        params: {
          path: "/doc.md",
          body: "Review",
          mentions: ["user-1", "person@example.com"],
          driveId: "drive-2",
        },
      },
      {
        op: "comment-add",
        params: {
          parentId: "comment-1",
          body: "Reply",
          mentions: ["user-2"],
          driveId: "drive-2",
        },
      },
      {
        op: "comment-update",
        params: {
          id: "comment-2",
          body: "Updated",
          mentions: ["user-3"],
          driveId: "drive-2",
        },
      },
    ]);
  });

  test("omits mention parameters unless flags are present", async () => {
    const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
    const client = {
      callOp: async (_orgId: string, op: string, params: Record<string, unknown>) => {
        calls.push({ op, params });
        return {};
      },
    } as Pick<ApiClient, "callOp"> as ApiClient;
    const command = commentCommands(client, () => "org-1", () => "drive-2");

    await command.parseAsync(["add", "/doc.md", "--body", "No mention"], { from: "user" });
    await command.parseAsync(["update", "comment-1", "--body", "Keep mentions"], { from: "user" });

    expect(calls).toEqual([
      {
        op: "comment-add",
        params: { path: "/doc.md", body: "No mention", driveId: "drive-2" },
      },
      {
        op: "comment-update",
        params: { id: "comment-1", body: "Keep mentions", driveId: "drive-2" },
      },
    ]);
  });

  test("maps repeatable notification kinds", async () => {
    const calls: Array<{ op: string; params: Record<string, unknown> }> = [];
    const client = {
      callOp: async (_orgId: string, op: string, params: Record<string, unknown>) => {
        calls.push({ op, params });
        return { notifications: [], unreadCount: 0 };
      },
    } as Pick<ApiClient, "callOp"> as ApiClient;
    const command = commentCommands(client, () => "org-1", () => "drive-2");

    await command.parseAsync([
      "notifications",
      "--kind",
      "comment",
      "--kind",
      "mention",
    ], { from: "user" });

    expect(calls).toEqual([
      {
        op: "comment-notification-list",
        params: { kinds: ["comment", "mention"], driveId: "drive-2" },
      },
    ]);
  });
});

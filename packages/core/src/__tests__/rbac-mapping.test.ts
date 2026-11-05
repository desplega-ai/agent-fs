import { describe, test, expect } from "bun:test";
import { getRequiredRole } from "../identity/rbac.js";

describe("getRequiredRole", () => {
  const viewerOps = [
    "ls", "cat", "tail", "stat", "reveal", "grep", "fts", "search", "log", "diff", "recent", "signed-url", "share-create", "share-revoke", "share-list",
    "comment-notification-list", "comment-notification-read",
    "favorite-add", "favorite-remove", "favorite-list",
  ];
  const editorOps = ["write", "edit", "append", "rm", "mv", "cp", "revert"];
  const adminOps = ["reindex"];
  // Viewer is only the membership floor for these: each handler enforces
  // drive admin / org admin itself (see ops/__tests__/webhook-ops.test.ts).
  const handlerAuthorizedOps = [
    "webhook-create", "webhook-list", "webhook-update", "webhook-delete", "webhook-test",
  ];

  test.each(viewerOps)("%s requires viewer", (op) => {
    expect(getRequiredRole(op)).toBe("viewer");
  });

  test.each(editorOps)("%s requires editor", (op) => {
    expect(getRequiredRole(op)).toBe("editor");
  });

  test.each(adminOps)("%s requires admin", (op) => {
    expect(getRequiredRole(op)).toBe("admin");
  });

  test.each(handlerAuthorizedOps)("%s requires viewer at the dispatcher (handler enforces admin)", (op) => {
    expect(getRequiredRole(op)).toBe("viewer");
  });

  test("unknown op defaults to admin", () => {
    expect(getRequiredRole("unknown_op")).toBe("admin");
    expect(getRequiredRole("")).toBe("admin");
  });
});

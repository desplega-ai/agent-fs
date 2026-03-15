import { describe, test, expect } from "bun:test";
import { getRequiredRole } from "../identity/rbac.js";

describe("getRequiredRole", () => {
  const viewerOps = ["ls", "cat", "head", "tail", "stat", "grep", "find", "search", "log", "diff", "recent"];
  const editorOps = ["write", "edit", "append", "rm", "mv", "cp", "mkdir", "revert"];
  const adminOps = ["reindex"];

  test.each(viewerOps)("%s requires viewer", (op) => {
    expect(getRequiredRole(op)).toBe("viewer");
  });

  test.each(editorOps)("%s requires editor", (op) => {
    expect(getRequiredRole(op)).toBe("editor");
  });

  test.each(adminOps)("%s requires admin", (op) => {
    expect(getRequiredRole(op)).toBe("admin");
  });

  test("unknown op defaults to admin", () => {
    expect(getRequiredRole("unknown_op")).toBe("admin");
    expect(getRequiredRole("")).toBe("admin");
  });
});

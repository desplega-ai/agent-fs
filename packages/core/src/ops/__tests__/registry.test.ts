import { describe, test, expect } from "bun:test";
import { getRegisteredOps, getOpDefinition, dispatchOp } from "../index.js";

describe("Op Registry", () => {
  const expectedOps = [
    "write", "cat", "edit", "append", "ls", "stat", "reveal", "rm", "mv", "cp",
    "tail", "log", "diff", "revert", "recent",
    "grep", "fts", "search", "vec-search", "reindex", "tree", "glob", "find", "sql", "signed-url", "share-create", "share-revoke", "share-list",
    "comment-add", "comment-list", "comment-get", "comment-update", "comment-delete", "comment-resolve",
    "comment-notification-list", "comment-notification-read",
    "drive-members",
    "favorite-add", "favorite-remove", "favorite-list",
    "webhook-create", "webhook-list", "webhook-update", "webhook-delete", "webhook-test",
    "webhook-deliveries", "webhook-redeliver",
  ];

  test("getRegisteredOps returns all 47 ops", () => {
    const ops = getRegisteredOps();
    expect(ops.length).toBe(47);
    for (const op of expectedOps) {
      expect(ops).toContain(op);
    }
  });

  test.each(expectedOps)("getOpDefinition('%s') returns schema and handler", (op) => {
    const def = getOpDefinition(op);
    expect(def).toBeDefined();
    expect(def!.handler).toBeInstanceOf(Function);
    expect(def!.schema).toBeDefined();
    expect(def!.schema.parse).toBeInstanceOf(Function);
  });

  test("getOpDefinition returns undefined for unknown op", () => {
    expect(getOpDefinition("nonexistent")).toBeUndefined();
  });

  test.each(["constructor", "__proto__", "toString", "hasOwnProperty"])("getOpDefinition returns undefined for inherited name %s", (name) => {
    expect(getOpDefinition(name)).toBeUndefined();
  });

  // The unknown-op check runs before ctx is touched, so no DB or S3 is needed here.
  test.each(["constructor", "__proto__", "toString", "hasOwnProperty"])("dispatchOp rejects inherited name %s as an unknown op", async (name) => {
    await expect(dispatchOp({} as any, name, {})).rejects.toThrow(`Unknown operation: ${name}`);
  });
});

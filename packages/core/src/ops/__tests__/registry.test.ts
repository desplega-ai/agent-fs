import { describe, test, expect } from "bun:test";
import { getRegisteredOps, getOpDefinition } from "../index.js";

describe("Op Registry", () => {
  const expectedOps = [
    "write", "cat", "edit", "append", "ls", "stat", "rm", "mv", "cp",
    "tail", "log", "diff", "revert", "recent",
    "grep", "fts", "search", "reindex",
  ];

  test("getRegisteredOps returns all 18 ops", () => {
    const ops = getRegisteredOps();
    expect(ops.length).toBe(18);
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
});

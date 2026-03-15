import { describe, test, expect } from "bun:test";
import { getRegisteredOps, getOpDefinition } from "../index.js";

describe("Op Registry", () => {
  const expectedOps = [
    "write", "cat", "edit", "append", "ls", "stat", "rm", "mv", "cp",
    "head", "tail", "mkdir", "log", "diff", "revert", "recent",
    "grep", "find", "search", "reindex",
  ];

  test("getRegisteredOps returns all 20 ops", () => {
    const ops = getRegisteredOps();
    expect(ops.length).toBe(20);
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

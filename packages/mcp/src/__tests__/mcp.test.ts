import { describe, test, expect } from "bun:test";
import { getRegisteredOps, getOpDefinition } from "@agentfs/core";

describe("MCP tool registration", () => {
  test("all ops from registry are available as tools", () => {
    const ops = getRegisteredOps();
    expect(ops.length).toBeGreaterThanOrEqual(18);

    // Verify each op has a Zod schema
    for (const op of ops) {
      const def = getOpDefinition(op);
      expect(def).toBeTruthy();
      expect(def!.schema).toBeTruthy();
      expect(def!.handler).toBeInstanceOf(Function);
    }
  });

  test("expected ops are registered", () => {
    const ops = getRegisteredOps();
    const expected = [
      "write", "cat", "edit", "append", "ls", "stat", "rm",
      "mv", "cp", "tail", "log", "diff",
      "revert", "recent", "grep", "fts",
    ];
    for (const op of expected) {
      expect(ops).toContain(op);
    }
  });
});

import { describe, test, expect } from "bun:test";
import { getRegisteredOps, getOpDefinition } from "@/core";
import type { OpContext } from "@/core";
import { registerIdentityTools } from "../server.js";
import { createTestDb } from "../../../core/src/test-utils.js";

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

  test("registerIdentityTools registers whoami and member management tools", () => {
    const names: string[] = [];
    const mockServer = {
      tool: (name: string, _desc: string, _schema: any, _handler: any) => {
        names.push(name);
      },
    };

    const db = createTestDb();
    const getContext = (): OpContext => {
      throw new Error("getContext should not be called during registration");
    };

    registerIdentityTools(mockServer as any, { db, getContext });

    expect(names.sort()).toEqual(
      ["member-invite", "member-list", "member-remove", "member-update-role", "whoami"].sort()
    );
  });
});

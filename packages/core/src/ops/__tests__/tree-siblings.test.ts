import { describe, test, expect } from "bun:test";
import { tree } from "../tree.js";
import { getS3Key } from "../versioning.js";
import { createTestContext } from "../../test-utils.js";

describe("tree with many siblings", () => {
  // Nesting 20k keys in linear time takes tens of milliseconds; the budget
  // leaves room for slow CI while catching a per-key sibling scan (seconds).
  const M = 20_000;
  const BUDGET_MS = 500;

  function contextWithKeys(relativeKeys: string[]) {
    const { ctx } = createTestContext();
    const base = getS3Key(ctx.orgId, ctx.driveId, "/");
    const objects = relativeKeys.map((k) => ({
      key: base + k,
      size: 1,
      lastModified: new Date(0),
    }));
    ctx.s3.listObjects = async () => ({ objects, prefixes: [] });
    return ctx;
  }

  async function timedTree(ctx: ReturnType<typeof contextWithKeys>, depth?: number) {
    const start = performance.now();
    const result = await tree(ctx, { path: "/", depth });
    return { ms: performance.now() - start, result };
  }

  test("control: one folder with many files is fast", async () => {
    const keys = Array.from({ length: M }, (_, k) => `d/f${k}`);
    const { ms, result } = await timedTree(contextWithKeys(keys));
    expect(result.tree).toHaveLength(1);
    expect(result.tree[0].children).toHaveLength(M);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  test("control: many sibling folders with depth=1 are fast", async () => {
    const keys = Array.from({ length: M }, (_, k) => `d${k}/f`);
    const { ms, result } = await timedTree(contextWithKeys(keys), 1);
    expect(result.tree).toHaveLength(0);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  test("many sibling folders are nested in linear time", async () => {
    const keys = Array.from({ length: M }, (_, k) => `d${k}/f`);
    const { ms, result } = await timedTree(contextWithKeys(keys));
    expect(result.tree).toHaveLength(M);
    expect(result.tree[M - 1]).toEqual({
      name: `d${M - 1}`,
      type: "directory",
      children: [{ name: "f", type: "file", size: 1, modifiedAt: new Date(0) }],
    });
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  test("keeps folder order and merges repeated folders", async () => {
    const keys = ["b/x", "a/", "a/y", "b/z", "a", "c/d/e"];
    const { result } = await timedTree(contextWithKeys(keys));
    const shape = (entries: any[]): any[] =>
      entries.map((e) => (e.type === "directory" ? [e.name, shape(e.children)] : e.name));
    expect(shape(result.tree)).toEqual([
      ["b", ["x", "z"]],
      ["a", ["y"]],
      "a",
      ["c", [["d", ["e"]]]],
    ]);
  });
});

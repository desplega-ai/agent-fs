import { describe, test, expect } from "bun:test";
import { dispatchOp } from "../index.js";
import { createTestContext } from "../../test-utils.js";

const MAX_MS = 250;

async function timed<T>(fn: () => Promise<T>): Promise<{ ms: number; result: T }> {
  const started = performance.now();
  const result = await fn();
  return { ms: performance.now() - started, result };
}

describe("glob matching time stays bounded", () => {
  test("control: ordinary patterns match as before", async () => {
    const { ctx } = createTestContext();
    await dispatchOp(ctx, "write", { path: "/docs/readme.md", content: "x" });
    await dispatchOp(ctx, "write", { path: "/docs/sub/deep.md", content: "x" });
    await dispatchOp(ctx, "write", { path: "/notes.txt", content: "x" });

    const top = (await dispatchOp(ctx, "glob", { pattern: "docs/*.md" })) as any;
    expect(top.matches.map((m: any) => m.path)).toEqual(["/docs/readme.md"]);

    const deep = (await dispatchOp(ctx, "glob", { pattern: "**/*.md" })) as any;
    expect(deep.matches.map((m: any) => m.path).sort()).toEqual(["/docs/readme.md", "/docs/sub/deep.md"]);

    const qm = (await dispatchOp(ctx, "glob", { pattern: "note?.txt" })) as any;
    expect(qm.matches.map((m: any) => m.path)).toEqual(["/notes.txt"]);
  });

  test("many wildcards against a long repetitive name finish quickly", async () => {
    const { ctx } = createTestContext();
    await dispatchOp(ctx, "write", { path: "/" + "a".repeat(96), content: "x" });

    const { ms, result } = await timed(() =>
      dispatchOp(ctx, "glob", { pattern: "*a".repeat(6) + "b" })
    );

    expect((result as any).matches).toEqual([]);
    expect(ms).toBeLessThan(MAX_MS);
  }, 60_000);
});

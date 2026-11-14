import { describe, test, expect } from "bun:test";
import { dispatchOp } from "../index.js";
import { grep } from "../grep.js";
import { ValidationError } from "../../errors.js";
import { createTestContext } from "../../test-utils.js";

// Longest gap between ticks of a 5 ms interval while `fn` runs: how long the
// event loop was held without yielding.
async function maxEventLoopGap(fn: () => Promise<unknown>): Promise<{ gapMs: number; result: unknown; error: unknown }> {
  let last = performance.now();
  let gapMs = 0;
  const iv = setInterval(() => {
    const now = performance.now();
    gapMs = Math.max(gapMs, now - last);
    last = now;
  }, 5);
  let result: unknown;
  let error: unknown;
  try {
    result = await fn();
  } catch (err) {
    error = err;
  }
  // One more tick so a stall at the very end is counted.
  await new Promise((r) => setTimeout(r, 20));
  clearInterval(iv);
  return { gapMs, result, error };
}

const MAX_GAP_MS = 250;

describe("grep keeps the event loop responsive", () => {
  test("control: an ordinary pattern returns matches without holding the loop", async () => {
    const { ctx } = createTestContext();
    await dispatchOp(ctx, "write", { path: "/notes.txt", content: "alpha\nbeta\ngamma beta" });

    const { gapMs, result, error } = await maxEventLoopGap(() =>
      dispatchOp(ctx, "grep", { pattern: "beta", path: "/" })
    );

    expect(error).toBeUndefined();
    expect((result as any).matches.map((m: any) => m.lineNumber)).toEqual([2, 3]);
    expect(gapMs).toBeLessThan(MAX_GAP_MS);
  });

  test("a pattern with heavy backtracking does not hold the loop", async () => {
    const { ctx } = createTestContext();
    await dispatchOp(ctx, "write", { path: "/line.txt", content: "a".repeat(28) + "!" });

    const { gapMs } = await maxEventLoopGap(() =>
      dispatchOp(ctx, "grep", { pattern: "^(a+)+$", path: "/" })
    );

    // Either outcome is fine (no match, or a bounded-time error); the loop
    // must stay free while the pattern is evaluated.
    expect(gapMs).toBeLessThan(MAX_GAP_MS);
  }, 30_000);

  test("a pattern that runs past the timeout is stopped with a validation error", async () => {
    const { ctx } = createTestContext();
    await dispatchOp(ctx, "write", { path: "/line.txt", content: "a".repeat(40) + "!" });

    const started = performance.now();
    const err = await grep(ctx, { pattern: "^(a+)+$", path: "/" }, 200).catch((e) => e);

    expect(err).toBeInstanceOf(ValidationError);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("an invalid pattern still throws a SyntaxError", async () => {
    const { ctx } = createTestContext();
    await expect(dispatchOp(ctx, "grep", { pattern: "(", path: "/" })).rejects.toThrow(SyntaxError);
  });
});

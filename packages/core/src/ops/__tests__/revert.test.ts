import { describe, test, expect } from "bun:test";
import { dispatchOp } from "../index.js";
import { revert } from "../revert.js";
import { diff } from "../diff.js";
import { createTestContext } from "../../test-utils.js";
import { UnsupportedOperation } from "../../errors.js";

describe("capability gating: revert", () => {
  test("revert on a no-versioning backend throws UnsupportedOperation", async () => {
    const { ctx } = createTestContext({ capabilities: { versioning: false } });

    await dispatchOp(ctx, "write", { path: "/r.txt", content: "v1" });
    await dispatchOp(ctx, "edit", {
      path: "/r.txt",
      old_string: "v1",
      new_string: "v2",
    });

    // Call the op directly so we can assert on the concrete error instance/code.
    await expect(
      revert(ctx, { path: "/r.txt", version: 1 })
    ).rejects.toBeInstanceOf(UnsupportedOperation);

    try {
      await revert(ctx, { path: "/r.txt", version: 1 });
      throw new Error("expected revert to throw");
    } catch (err: any) {
      expect(err).toBeInstanceOf(UnsupportedOperation);
      expect(err.code).toBe("UNSUPPORTED_OPERATION");
      expect(err.operation).toBe("revert");
      expect(err.suggestion).toBeTruthy();
    }
  });

  test("revert through dispatchOp also surfaces the typed code", async () => {
    const { ctx } = createTestContext({ capabilities: { versioning: false } });
    await dispatchOp(ctx, "write", { path: "/r2.txt", content: "hello" });

    try {
      await dispatchOp(ctx, "revert", { path: "/r2.txt", version: 1 });
      throw new Error("expected revert to throw");
    } catch (err: any) {
      expect(err.code).toBe("UNSUPPORTED_OPERATION");
    }
  });
});

describe("capability gating: diff degrades, never throws", () => {
  test("historical diff on a no-versioning backend returns the diffSummary fallback", async () => {
    const { ctx } = createTestContext({ capabilities: { versioning: false } });

    await dispatchOp(ctx, "write", { path: "/d.txt", content: "old" });
    await dispatchOp(ctx, "edit", {
      path: "/d.txt",
      old_string: "old",
      new_string: "new",
    });

    // Must NOT throw UnsupportedOperation — diff degrades to the stored summary.
    const result = (await diff(ctx, { path: "/d.txt", v1: 1, v2: 2 })) as any;
    expect(Array.isArray(result.changes)).toBe(true);
    // The edit op records a diffSummary, so the fallback produces changes.
    expect(result.changes.length).toBeGreaterThan(0);
  });
});

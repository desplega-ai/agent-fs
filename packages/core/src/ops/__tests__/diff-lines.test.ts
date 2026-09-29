import { describe, test, expect } from "bun:test";
import { dispatchOp } from "../index.js";
import { diff } from "../diff.js";
import { commentAdd, commentList, commentGet } from "../comment.js";
import { createTestContext } from "../../test-utils.js";

describe("diff line numbers", () => {
  test("changes carry oldLine/newLine so callers can remap line ranges", async () => {
    const { ctx } = createTestContext({ versioningEnabled: true });
    const v1 = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n");
    await dispatchOp(ctx, "write", { path: "/lines.txt", content: v1 });
    // Insert two lines above "c" and drop "h".
    const v2 = ["a", "b", "new1", "new2", "c", "d", "e", "f", "g", "i", "j"].join("\n");
    await dispatchOp(ctx, "write", { path: "/lines.txt", content: v2 });

    const result = await diff(ctx, { path: "/lines.txt", v1: 1, v2: 2 });
    const byType = (t: string) => result.changes.filter((c) => c.type === t);

    expect(byType("add").map((c) => [c.content, c.newLine])).toEqual([["new1", 3], ["new2", 4]]);
    expect(byType("remove").map((c) => [c.content, c.oldLine])).toEqual([["h", 8]]);
    const c = result.changes.find((ch) => ch.type === "context" && ch.content === "c");
    expect([c?.oldLine, c?.newLine]).toEqual([3, 5]);
    // The "\ No newline at end of file" marker stays a line-less context entry.
    for (const ch of byType("context").filter((ch) => !ch.content.startsWith(" No newline"))) {
      expect(ch.oldLine).toBeGreaterThan(0);
      expect(ch.newLine).toBeGreaterThan(0);
    }
  });
});

describe("comment quote anchors", () => {
  test("stores the quote and reports the anchor version number", async () => {
    const { ctx } = createTestContext({ versioningEnabled: true });
    await dispatchOp(ctx, "write", { path: "/doc.md", content: "one\ntwo\nthree" });
    await dispatchOp(ctx, "write", { path: "/doc.md", content: "one\ntwo\nthree\nfour" });

    const added = await commentAdd(ctx, {
      path: "/doc.md",
      body: "anchored",
      lineStart: 2,
      lineEnd: 2,
      quotedContent: "two",
      quote: { exact: "two", prefix: "one\n", suffix: "\nthree" },
    });
    expect(added.quote).toEqual({ exact: "two", prefix: "one\n", suffix: "\nthree" });

    const { comments } = await commentList(ctx, { path: "/doc.md" });
    expect(comments[0].quote).toEqual({ exact: "two", prefix: "one\n", suffix: "\nthree" });
    expect(comments[0].fileVersion).toBe(2);
    expect(comments[0].fileVersionId).toBeGreaterThan(0);

    const { comment } = await commentGet(ctx, { id: added.id });
    expect(comment.quote?.exact).toBe("two");
    expect(comment.fileVersion).toBe(2);
  });

  test("comments without a quote keep today's shape", async () => {
    const { ctx } = createTestContext();
    await dispatchOp(ctx, "write", { path: "/old.md", content: "x" });
    await dispatchOp(ctx, "comment-add", { path: "/old.md", body: "legacy", quotedContent: "x" });
    const { comments } = await commentList(ctx, { path: "/old.md" });
    expect(comments[0].quote).toBeUndefined();
    expect(comments[0].quotedContent).toBe("x");
  });

  test("caps stored quote lengths instead of rejecting", async () => {
    const { ctx } = createTestContext();
    await dispatchOp(ctx, "write", { path: "/long.md", content: "x" });
    const added = await dispatchOp(ctx, "comment-add", {
      path: "/long.md",
      body: "long",
      quote: { exact: "e".repeat(5000), prefix: "p".repeat(100) + "END", suffix: "START" + "s".repeat(100) },
    }) as any;
    expect(added.quote.exact.length).toBe(4000);
    expect(added.quote.prefix.endsWith("END")).toBe(true);
    expect(added.quote.prefix.length).toBe(64);
    expect(added.quote.suffix.startsWith("START")).toBe(true);
    expect(added.quote.suffix.length).toBe(64);
  });
});

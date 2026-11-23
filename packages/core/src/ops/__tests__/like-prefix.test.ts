import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { schema } from "../../db/index.js";
import { createTestContext } from "../../test-utils.js";
import { dispatchOp } from "../index.js";
import { likePrefix } from "../paths.js";

describe("literal SQL path prefixes", () => {
  test("LIKE patterns escape underscore, percent, and backslash", () => {
    expect(likePrefix("/q_1/")).toBe("/q\\_1/%");
    expect(likePrefix("/100%/")).toBe("/100\\%/%");
    expect(likePrefix("/slash\\name/")).toBe("/slash\\\\name/%");
    expect(likePrefix("/docs/")).toBe("/docs/%");
    expect(likePrefix("/")).toBe("/%");
  });

  test.each([
    { label: "underscore", directory: "/q_1", match: "/q_1/a.md", other: "/qX1/b.md" },
    { label: "percent", directory: "/100%", match: "/100%/a.md", other: "/100x/b.md" },
  ])("$label is literal in grep, recent, fts and glob", async ({ directory, match, other }) => {
    const { ctx } = createTestContext();
    await dispatchOp(ctx, "write", { path: match, content: "needle" });
    await dispatchOp(ctx, "write", { path: other, content: "needle" });

    const grep = (await dispatchOp(ctx, "grep", { pattern: "needle", path: directory })) as any;
    expect(grep.matches.map((m: any) => m.path)).toEqual([match]);

    const recent = (await dispatchOp(ctx, "recent", { path: directory })) as any;
    expect(recent.entries.map((e: any) => e.path)).toEqual([match]);

    const fts = (await dispatchOp(ctx, "fts", { pattern: "needle", path: directory })) as any;
    expect(fts.matches.map((m: any) => m.path)).toEqual([match]);

    const glob = (await dispatchOp(ctx, "glob", { pattern: "*.md", path: directory })) as any;
    expect(glob.matches.map((m: any) => m.path)).toEqual([match]);
  });

  test("reindex limits its database scan to a literal directory", async () => {
    const { ctx, db } = createTestContext();
    await dispatchOp(ctx, "write", { path: "/q_1/a.md", content: "needle" });
    await dispatchOp(ctx, "write", { path: "/qX1/b.md", content: "needle" });

    const raw = db.$client;
    raw.prepare("DELETE FROM files_fts_docs WHERE drive_id = ?").run(ctx.driveId);
    db.update(schema.files)
      .set({ embeddingStatus: "pending" })
      .where(eq(schema.files.driveId, ctx.driveId))
      .run();

    await dispatchOp(ctx, "reindex", { path: "/q_1" });
    const rows = raw
      .prepare("SELECT path FROM files_fts_docs WHERE drive_id = ? ORDER BY path")
      .all(ctx.driveId) as Array<{ path: string }>;
    expect(rows.map((r) => r.path)).toEqual(["/q_1/a.md"]);
  });

  test("ordinary prefixes preserve their existing scope", async () => {
    const { ctx } = createTestContext();
    await dispatchOp(ctx, "write", { path: "/docs/a.md", content: "needle" });
    await dispatchOp(ctx, "write", { path: "/docs2/b.md", content: "needle" });

    const grep = (await dispatchOp(ctx, "grep", { pattern: "needle", path: "/docs" })) as any;
    expect(grep.matches.map((m: any) => m.path)).toEqual(["/docs/a.md"]);

    // recent and fts historically accept arbitrary prefixes, without a trailing slash.
    const recent = (await dispatchOp(ctx, "recent", { path: "/docs" })) as any;
    expect(recent.entries.map((e: any) => e.path).sort()).toEqual(["/docs/a.md", "/docs2/b.md"]);
    const fts = (await dispatchOp(ctx, "fts", { pattern: "needle", path: "/docs" })) as any;
    expect(fts.matches.map((m: any) => m.path).sort()).toEqual(["/docs/a.md", "/docs2/b.md"]);

    const root = (await dispatchOp(ctx, "fts", { pattern: "needle", path: "/" })) as any;
    expect(root.matches.map((m: any) => m.path).sort()).toEqual(["/docs/a.md", "/docs2/b.md"]);
  });
});

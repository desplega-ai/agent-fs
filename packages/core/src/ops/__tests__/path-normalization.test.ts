import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTestContext } from "../../test-utils.js";
import { subscribeDrive, type DriveEvent } from "../../events/bus.js";
import { dispatchOp, writeRaw } from "../index.js";

describe("file operation path normalization", () => {
  test("exact-path operations use one canonical file and emit canonical paths", async () => {
    const { ctx, db } = createTestContext({ versioningEnabled: true });
    const raw = (db as any).$client as Database;
    const events: DriveEvent[] = [];
    const unsubscribe = subscribeDrive(ctx.driveId, (event) => events.push(event));

    try {
      const written = await dispatchOp(ctx, "write", {
        path: "normalized/file.md",
        content: "one\ntwo",
      }) as { path: string; version: number };
      expect(written).toMatchObject({ path: "/normalized/file.md", version: 1 });

      expect((await dispatchOp(ctx, "cat", { path: "/normalized/file.md" }) as any).content)
        .toBe("one\ntwo");
      expect((await dispatchOp(ctx, "stat", { path: "normalized/file.md" }) as any))
        .toMatchObject({ path: "/normalized/file.md", currentVersion: 1 });

      await dispatchOp(ctx, "append", {
        path: "normalized/file.md",
        content: "\nthree",
      });
      const edited = await dispatchOp(ctx, "edit", {
        path: "normalized/file.md",
        old_string: "two",
        new_string: "TWO",
      }) as { path: string; version: number };
      expect(edited).toMatchObject({ path: "/normalized/file.md", version: 3 });

      const tail = await dispatchOp(ctx, "tail", {
        path: "normalized/file.md",
        lines: 2,
      }) as { content: string };
      expect(tail.content).toBe("TWO\nthree");
      const history = await dispatchOp(ctx, "log", {
        path: "normalized/file.md",
      }) as { versions: Array<{ version: number }> };
      expect(history.versions.map((row) => row.version)).toEqual([3, 2, 1]);
      const compared = await dispatchOp(ctx, "diff", {
        path: "normalized/file.md",
        v1: 1,
        v2: 3,
      }) as { changes: unknown[] };
      expect(compared.changes.length).toBeGreaterThan(0);

      const signed = await dispatchOp(ctx, "signed-url", {
        path: "normalized/file.md",
      }) as { path: string };
      expect(signed.path).toBe("/normalized/file.md");
      const revealed = await dispatchOp(ctx, "reveal", {
        path: "normalized/file.md",
      }) as { path: string; stat: { path: string } };
      expect(revealed).toMatchObject({
        path: "/normalized/file.md",
        stat: { path: "/normalized/file.md" },
      });

      const share = await dispatchOp(ctx, "share-create", {
        path: "normalized/file.md",
      }) as { path: string };
      expect(share.path).toBe("/normalized/file.md");
      expect(await dispatchOp(ctx, "share-revoke", { path: "normalized/file.md" }))
        .toMatchObject({ revoked: 1 });

      const comment = await dispatchOp(ctx, "comment-add", {
        path: "normalized/file.md",
        body: "canonical comment",
      }) as { path: string };
      expect(comment.path).toBe("/normalized/file.md");
      const comments = await dispatchOp(ctx, "comment-list", {
        path: "normalized/file.md",
      }) as { comments: Array<{ path: string }> };
      expect(comments.comments.map((row) => row.path)).toEqual(["/normalized/file.md"]);

      const copied = await dispatchOp(ctx, "cp", {
        from: "normalized/file.md",
        to: "normalized/copy.md",
      }) as { from: string; to: string };
      expect(copied).toMatchObject({
        from: "/normalized/file.md",
        to: "/normalized/copy.md",
      });
      const moved = await dispatchOp(ctx, "mv", {
        from: "normalized/copy.md",
        to: "normalized/moved.md",
      }) as { from: string; to: string };
      expect(moved).toMatchObject({
        from: "/normalized/copy.md",
        to: "/normalized/moved.md",
      });

      const reverted = await dispatchOp(ctx, "revert", {
        path: "normalized/file.md",
        version: 1,
      }) as { version: number; revertedTo: number };
      expect(reverted).toMatchObject({ version: 4, revertedTo: 1 });
      const removed = await dispatchOp(ctx, "rm", {
        path: "normalized/file.md",
      }) as { path: string; deleted: boolean };
      expect(removed).toEqual({ path: "/normalized/file.md", deleted: true });

      for (const table of ["files", "file_versions", "comments", "shares"]) {
        const row = raw
          .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE path NOT LIKE '/%'`)
          .get() as { count: number };
        expect(row.count).toBe(0);
      }
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((event) => event.path.startsWith("/"))).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  test("writeRaw normalizes before storage, metadata, indexing, and output", async () => {
    const { ctx, db } = createTestContext();
    const result = await writeRaw(ctx, {
      path: "raw/note.md",
      bytes: new TextEncoder().encode("raw path content"),
    });
    expect(result.path).toBe("/raw/note.md");

    const raw = (db as any).$client as Database;
    expect(raw.prepare("SELECT path FROM files").all()).toEqual([{ path: "/raw/note.md" }]);
    expect(raw.prepare("SELECT path FROM file_versions").all()).toEqual([{ path: "/raw/note.md" }]);
    expect(raw.prepare("SELECT path FROM files_fts_docs").all()).toEqual([{ path: "/raw/note.md" }]);
  });

  test("prefix operations accept bare inputs and return canonical result paths", async () => {
    const { ctx } = createTestContext();
    await dispatchOp(ctx, "write", {
      path: "prefix/sub/a.md",
      content: "unique normalized search token",
    });

    const listed = await dispatchOp(ctx, "ls", { path: "prefix/sub" }) as {
      entries: Array<{ name: string }>;
    };
    expect(listed.entries.map((entry) => entry.name)).toContain("a.md");

    const tree = await dispatchOp(ctx, "tree", { path: "prefix" }) as {
      tree: Array<{ name: string }>;
    };
    expect(tree.tree.map((entry) => entry.name)).toContain("sub");

    const glob = await dispatchOp(ctx, "glob", {
      path: "prefix",
      pattern: "**/*.md",
    }) as { matches: Array<{ path: string }> };
    expect(glob.matches.map((entry) => entry.path)).toEqual(["/prefix/sub/a.md"]);

    const grep = await dispatchOp(ctx, "grep", {
      path: "prefix",
      pattern: "normalized",
    }) as { matches: Array<{ path: string }> };
    expect(grep.matches.map((entry) => entry.path)).toEqual(["/prefix/sub/a.md"]);

    const fts = await dispatchOp(ctx, "fts", {
      path: "prefix",
      pattern: "normalized",
    }) as { matches: Array<{ path: string }> };
    expect(fts.matches.map((entry) => entry.path)).toEqual(["/prefix/sub/a.md"]);

    const search = await dispatchOp(ctx, "search", {
      query: "normalized",
    }) as { results: Array<{ path: string }> };
    expect(search.results.every((entry) => entry.path.startsWith("/"))).toBe(true);

    const recent = await dispatchOp(ctx, "recent", { path: "prefix" }) as {
      entries: Array<{ path: string }>;
    };
    expect(recent.entries.map((entry) => entry.path)).toEqual(["/prefix/sub/a.md"]);

    const reindexed = await dispatchOp(ctx, "reindex", { path: "prefix/sub/a.md" }) as {
      failed: number;
      skipped: number;
    };
    expect(reindexed).toMatchObject({ failed: 0, skipped: 1 });
  });
});

import { describe, test, expect } from "bun:test";
import { indexFile, removeFromIndex, ftsQuery } from "../fts.js";
import { createTestContext } from "../../test-utils.js";

describe("FTS indexing", () => {
  test("indexFile makes content searchable", () => {
    const { db, driveId } = createTestContext();

    indexFile(db, {
      path: "/hello.txt",
      driveId,
      content: "The quick brown fox jumps over the lazy dog",
    });

    const results = ftsQuery(db, { pattern: "quick brown", driveId });
    expect(results.length).toBe(1);
    expect(results[0].path).toBe("/hello.txt");
  });

  test("indexFile upserts on same path", () => {
    const { db, driveId } = createTestContext();

    indexFile(db, { path: "/a.txt", driveId, content: "old content alpha" });
    indexFile(db, { path: "/a.txt", driveId, content: "new content beta" });

    // Old content should not match
    const oldResults = ftsQuery(db, { pattern: "alpha", driveId });
    expect(oldResults.length).toBe(0);

    // New content should match
    const newResults = ftsQuery(db, { pattern: "beta", driveId });
    expect(newResults.length).toBe(1);
  });

  test("removeFromIndex removes content", () => {
    const { db, driveId } = createTestContext();

    indexFile(db, { path: "/rm.txt", driveId, content: "removable content gamma" });

    const before = ftsQuery(db, { pattern: "gamma", driveId });
    expect(before.length).toBe(1);

    removeFromIndex(db, { path: "/rm.txt", driveId });

    const after = ftsQuery(db, { pattern: "gamma", driveId });
    expect(after.length).toBe(0);
  });

  test("ftsQuery scoped to driveId", () => {
    const { db, driveId } = createTestContext();
    const otherDriveId = "other-drive-id";

    indexFile(db, { path: "/scoped.txt", driveId, content: "scoped content delta" });

    const correct = ftsQuery(db, { pattern: "delta", driveId });
    expect(correct.length).toBe(1);

    const wrong = ftsQuery(db, { pattern: "delta", driveId: otherDriveId });
    expect(wrong.length).toBe(0);
  });

  test("ftsQuery with pathPrefix filters by path", () => {
    const { db, driveId } = createTestContext();

    indexFile(db, { path: "/docs/a.txt", driveId, content: "hello epsilon" });
    indexFile(db, { path: "/src/b.txt", driveId, content: "hello epsilon" });

    const all = ftsQuery(db, { pattern: "epsilon", driveId });
    expect(all.length).toBe(2);

    const docsOnly = ftsQuery(db, {
      pattern: "epsilon",
      driveId,
      pathPrefix: "/docs/",
    });
    expect(docsOnly.length).toBe(1);
    expect(docsOnly[0].path).toBe("/docs/a.txt");
  });

  test("ftsQuery returns snippet with highlights", () => {
    const { db, driveId } = createTestContext();

    indexFile(db, {
      path: "/snip.txt",
      driveId,
      content: "This document contains important information about testing",
    });

    const results = ftsQuery(db, { pattern: "important", driveId });
    expect(results.length).toBe(1);
    expect(results[0].snippet).toContain("<b>");
    expect(results[0].snippet).toContain("</b>");
  });

  test("ftsQuery returns results ordered by rank", () => {
    const { db, driveId } = createTestContext();

    indexFile(db, {
      path: "/low.txt",
      driveId,
      content: "This has one mention of the keyword zeta in a long paragraph of other text that dilutes relevance",
    });
    indexFile(db, {
      path: "/high.txt",
      driveId,
      content: "zeta zeta zeta zeta zeta",
    });

    const results = ftsQuery(db, { pattern: "zeta", driveId });
    expect(results.length).toBe(2);
    // rank is negative in FTS5 (more negative = better), so first result should be better match
    expect(results[0].rank).toBeLessThanOrEqual(results[1].rank);
  });
});

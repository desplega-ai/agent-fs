import { describe, test, expect } from "bun:test";
import { indexFile, removeFromIndex, ftsQuery, plainSnippet } from "../fts.js";
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

describe("FTS on large documents", () => {
  test("a document with many hits of a common term returns quickly, with a snippet", () => {
    const { db, driveId } = createTestContext();
    // 200k hits: FTS5 snippet() on this row alone runs for minutes.
    const rows = Array.from({ length: 200_000 }, (_, i) => `row${i},agent,value`);
    indexFile(db, { path: "/big.csv", driveId, content: rows.join("\n") });
    indexFile(db, { path: "/small.md", driveId, content: "the agent runs here" });

    const started = performance.now();
    const results = ftsQuery(db, { pattern: "agent", driveId });
    expect(performance.now() - started).toBeLessThan(2000);

    const big = results.find((r) => r.path === "/big.csv")!;
    expect(big.snippet).toContain("<b>agent</b>");
    expect(big.snippet.length).toBeLessThan(400);
    expect(results.find((r) => r.path === "/small.md")!.snippet).toBe("the <b>agent</b> runs here");
  });

  test("matches content only, not the path", () => {
    const { db, driveId } = createTestContext();
    indexFile(db, { path: "/omega/notes.txt", driveId, content: "nothing to see" });
    expect(ftsQuery(db, { pattern: "omega", driveId })).toEqual([]);
  });

  test("returns at most 50 results, best rank first", () => {
    const { db, driveId } = createTestContext();
    for (let i = 0; i < 60; i++) {
      indexFile(db, { path: `/f${i}.txt`, driveId, content: `kappa ${"filler ".repeat(i)}` });
    }
    const results = ftsQuery(db, { pattern: "kappa", driveId });
    expect(results.length).toBe(50);
    expect(results[0].path).toBe("/f0.txt");
    for (let i = 1; i < results.length; i++) expect(results[i - 1].rank).toBeLessThanOrEqual(results[i].rank);
  });
});

describe("plainSnippet", () => {
  test("windows the first match and marks every match in the window", () => {
    const content = `${"lead ".repeat(100)}Agent and agents, agent.${" tail".repeat(100)}`;
    const s = plainSnippet(content, '"agent"');
    expect(s.startsWith("...")).toBe(true);
    expect(s.endsWith("...")).toBe(true);
    expect(s).toContain("<b>Agent</b> and agents, <b>agent</b>.");
  });

  test("handles prefixes, operators and column filters", () => {
    expect(plainSnippet("alpha beta gamma", "content: bet* OR NOT zeta")).toBe("alpha <b>beta</b> gamma");
    expect(plainSnippet("alpha beta gamma", "(alpha AND gamma)")).toBe("<b>alpha</b> beta <b>gamma</b>");
  });

  test("falls back to the start of the document when no term is found", () => {
    expect(plainSnippet("plain text here", "zzz")).toBe("plain text here");
  });
});

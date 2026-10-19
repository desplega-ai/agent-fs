import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { createTestContext } from "../../test-utils.js";
import { schema } from "../../db/index.js";
import { dispatchOp } from "../index.js";
import { pathScore, queryWords } from "../find.js";
import type { FindResult } from "../types.js";

async function seed(paths: string[]) {
  const t = createTestContext();
  for (const path of paths) {
    await dispatchOp(t.ctx, "write", { path, content: "x" });
  }
  const find = async (query: string, extra: Record<string, unknown> = {}) =>
    (await dispatchOp(t.ctx, "find", { query, ...extra })) as FindResult;
  return { ...t, find };
}

const DECK = "/research/decks/Zephyr Pitch Deck.pdf";

describe("find op", () => {
  test("ignores case: lowercase query finds a capitalized name", async () => {
    const { find } = await seed([DECK, "/notes/other.md"]);
    expect((await find("zephyr")).matches.map((m) => m.path)).toEqual([DECK]);
    expect((await find("ZEPHYR")).matches.map((m) => m.path)).toEqual([DECK]);
  });

  test("ignores accents in the query and in the path", async () => {
    const { find } = await seed(["/menus/Café Crème.md"]);
    expect((await find("cafe creme")).matches.map((m) => m.path)).toEqual(["/menus/Café Crème.md"]);
    expect((await find("CRÈME")).total).toBe(1);
  });

  test("matches every word in any order, split on spaces and punctuation", async () => {
    const { find } = await seed([DECK, "/decks/Acme Deck.pdf"]);
    for (const query of ["zephyr deck", "deck zephyr", "zephyr_deck", "decks/zephyr", "pitch-deck zephyr"]) {
      expect((await find(query)).matches.map((m) => m.path)).toEqual([DECK]);
    }
  });

  test("falls back to a subsequence inside one segment", async () => {
    const { find } = await seed([DECK, "/notes/zip-hour.md"]);
    expect((await find("zphr")).matches.map((m) => m.path)).toContain(DECK);
    expect((await find("pitchdeck")).matches.map((m) => m.path)).toEqual([DECK]);
    expect((await find("zzq")).matches).toEqual([]);
  });

  test("shows skipped-letter matches only when no file has every word as typed", async () => {
    const { find } = await seed(["/a/report.md", "/a/retry-poller.ts"]);
    expect(await find("report")).toMatchObject({ matches: [{ path: "/a/report.md" }], total: 1 });
    expect((await find("rprt")).matches.map((m) => m.path).sort()).toEqual(["/a/report.md", "/a/retry-poller.ts"]);
  });

  test("ranks a file-name hit above a folder hit", async () => {
    const { find } = await seed(["/zephyr/notes.md", "/archive/old/Zephyr.pdf"]);
    expect((await find("zephyr")).matches.map((m) => m.path)).toEqual([
      "/archive/old/Zephyr.pdf",
      "/zephyr/notes.md",
    ]);
  });

  test("ranks a whole word above a word prefix above a mid-word hit", async () => {
    const { find } = await seed(["/a/misreported.md", "/a/reporting.md", "/a/q3-report.md"]);
    expect((await find("report")).matches.map((m) => m.path)).toEqual([
      "/a/q3-report.md",
      "/a/reporting.md",
      "/a/misreported.md",
    ]);
  });

  test("breaks score ties by shorter path, then by newer file", async () => {
    const { ctx, find } = await seed(["/x/plan.md", "/x/y/plan.md", "/z/plan.md"]);
    ctx.db
      .update(schema.files)
      .set({ modifiedAt: new Date("2030-01-01T00:00:00Z") })
      .where(and(eq(schema.files.driveId, ctx.driveId), eq(schema.files.path, "/z/plan.md")))
      .run();
    expect((await find("plan")).matches.map((m) => m.path)).toEqual([
      "/z/plan.md",
      "/x/plan.md",
      "/x/y/plan.md",
    ]);
  });

  test("scopes to a path prefix, matches only below it, and skips sibling prefixes", async () => {
    const { find } = await seed(["/decks/Acme.pdf", "/decks/Acme Deck.pdf", "/decks-old/Acme Deck.pdf", "/other/Acme Deck.pdf"]);
    const scoped = await find("deck", { path: "decks" });
    expect(scoped.matches.map((m) => m.path)).toEqual(["/decks/Acme Deck.pdf"]);
    expect((await find("acme", { path: "/decks/" })).total).toBe(2);
  });

  test("skips deleted files", async () => {
    const { ctx, find } = await seed(["/keep/report.md", "/gone/report.md"]);
    await dispatchOp(ctx, "rm", { path: "/gone/report.md" });
    expect((await find("report")).matches.map((m) => m.path)).toEqual(["/keep/report.md"]);
  });

  test("caps matches at limit and reports the full total", async () => {
    const { find } = await seed(["/n/note-1.md", "/n/note-2.md", "/n/note-3.md"]);
    const result = await find("note", { limit: 2 });
    expect(result.matches).toHaveLength(2);
    expect(result.total).toBe(3);
    expect(result.matches[0]).toMatchObject({ size: 1 });
    expect(typeof result.matches[0].score).toBe("number");
  });

  test("returns nothing for a query with no words", async () => {
    const { find } = await seed(["/a/b.md"]);
    expect(await find(" -- ")).toEqual({ matches: [], total: 0 });
  });

  test("rejects an empty query", async () => {
    const { ctx } = createTestContext();
    await expect(dispatchOp(ctx, "find", { query: "" })).rejects.toThrow();
  });
});

describe("find scoring", () => {
  const score = (words: string[], path: string) => pathScore(words, path)?.score ?? 0;

  test("queryWords folds and splits on punctuation", () => {
    expect(queryWords("  Zephyr_Pitch-Deck.PDF  Café ")).toEqual(["zephyr", "pitch", "deck", "pdf", "cafe"]);
  });

  test("folds Greek final sigma, so case does not change the letter", () => {
    expect(pathScore(queryWords("ΟΔΟΣ"), "ΟΔΟΣ.md")).not.toBeNull();
    expect(pathScore(queryWords("σημειωσεις"), "ΣΗΜΕΙΩΣΕΙΣ.pdf")).not.toBeNull();
  });

  test("a contiguous hit beats any subsequence hit, and flags the subsequence as fuzzy", () => {
    expect(score(["deck"], "deck-notes.md")).toBeGreaterThan(score(["dck"], "deck.md"));
    expect(score(["eck"], "deck.md")).toBeGreaterThan(score(["dk"], "deck.md"));
    expect(pathScore(["deck"], "deck.md")?.fuzzy).toBe(false);
    expect(pathScore(["deck", "dk"], "deck.md")?.fuzzy).toBe(true);
  });

  test("a camelCase hump counts as a word start", () => {
    expect(score(["search"], "useGlobSearch.ts")).toBeGreaterThan(score(["search"], "researched.ts"));
  });

  test("a subsequence must start at a word start", () => {
    expect(score(["ck"], "deck.md")).toBeGreaterThan(0); // contiguous
    expect(pathScore(["ek"], "deck.md")).toBeNull();
  });
});

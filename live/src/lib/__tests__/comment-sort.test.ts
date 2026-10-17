import { describe, expect, test } from "bun:test"
import { DEFAULT_COMMENT_SORT, isCommentSort, sortComments } from "../comment-sort"
import type { CommentListEntry } from "@/api/types"
import type { AnchorInfo } from "@/stores/comment-anchors"

/** `day` sets createdAt, so a higher day is newer. */
function comment(id: string, day: number, overrides: Partial<CommentListEntry> = {}): CommentListEntry {
  const createdAt = `2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`
  return {
    id,
    path: "/doc.md",
    body: id,
    author: "u1",
    resolved: false,
    replyCount: 0,
    createdAt,
    updatedAt: createdAt,
    replies: [],
    ...overrides,
  }
}

const ids = (comments: CommentListEntry[]) => comments.map((c) => c.id)

// Stored lines: a=L10, b=L2, c=general, d=L5 (anchor lost), e=L2 (later on the line).
const a = comment("a", 1, { lineStart: 10 })
const b = comment("b", 2, { lineStart: 2 })
const c = comment("c", 3)
const d = comment("d", 4, { lineStart: 5 })
const e = comment("e", 5, { lineStart: 2 })
const all = [a, b, c, d, e]

const anchors = new Map<string, AnchorInfo>([
  ["a", { status: "anchored", lineStart: 10, start: 300 }],
  ["b", { status: "anchored", lineStart: 2, start: 40 }],
  ["d", { status: "lost" }],
  ["e", { status: "anchored", lineStart: 2, start: 20 }],
])

describe("sortComments", () => {
  test("newest and oldest order by creation date", () => {
    expect(ids(sortComments(all, "newest", anchors))).toEqual(["e", "d", "c", "b", "a"])
    expect(ids(sortComments(all, "oldest", anchors))).toEqual(["a", "b", "c", "d", "e"])
  })

  test("line follows the text, then puts comments without a position last, newest first", () => {
    // e and b share line 2: e starts earlier in the text. d's anchor is lost.
    expect(ids(sortComments(all, "line", anchors))).toEqual(["e", "b", "a", "d", "c"])
  })

  test("line uses the viewer's resolved line over the stored one", () => {
    const moved = new Map(anchors).set("a", { status: "moved", lineStart: 1, start: 5 })
    expect(ids(sortComments(all, "line", moved))).toEqual(["a", "e", "b", "d", "c"])
  })

  test("line falls back to stored lines when no viewer resolved the anchors", () => {
    expect(ids(sortComments(all, "line", new Map()))).toEqual(["e", "b", "d", "a", "c"])
  })

  test("status puts open comments first, each group in line order", () => {
    const resolved = all.map((x) => (x.id === "b" || x.id === "c" ? { ...x, resolved: true } : x))
    expect(ids(sortComments(resolved, "status", anchors))).toEqual(["e", "a", "d", "b", "c"])
  })

  test("returns a copy", () => {
    const input = [...all]
    sortComments(input, "oldest", anchors)
    expect(ids(input)).toEqual(ids(all))
  })
})

describe("isCommentSort", () => {
  test("accepts only known sorts", () => {
    expect(isCommentSort(DEFAULT_COMMENT_SORT)).toBe(true)
    expect(isCommentSort("line")).toBe(true)
    expect(isCommentSort("size")).toBe(false)
    expect(isCommentSort(null)).toBe(false)
  })
})

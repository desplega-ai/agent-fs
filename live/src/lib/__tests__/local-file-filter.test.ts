import { describe, expect, test } from "bun:test"
import { fileNameMatcher, filterLoadedListings } from "../local-file-filter"
import type { LsResult } from "../../api/types"

function listing(...entries: Array<[name: string, type: "file" | "directory"]>): LsResult {
  return { entries: entries.map(([name, type]) => ({ name, type, size: 0 })) } as LsResult
}

describe("fileNameMatcher", () => {
  test("ignores case and accents", () => {
    expect(fileNameMatcher("zephyr")("Zephyr Pitch Deck.pdf")).toBe(true)
    expect(fileNameMatcher("CAFE")("Café.md")).toBe(true)
    expect(fileNameMatcher("café")("cafe.md")).toBe(true)
    expect(fileNameMatcher("σημειωσεις")("ΣΗΜΕΙΩΣΕΙΣ.pdf")).toBe(true)
  })

  test("needs every word, in any order, split on spaces and punctuation", () => {
    expect(fileNameMatcher("deck zephyr")("Zephyr Pitch Deck.pdf")).toBe(true)
    expect(fileNameMatcher("zephyr_deck")("Zephyr Pitch Deck.pdf")).toBe(true)
    expect(fileNameMatcher("zephyr memo")("Zephyr Pitch Deck.pdf")).toBe(false)
    expect(fileNameMatcher("(draft)")("notes (draft).md")).toBe(true)
  })

  test("matches nothing for a query with no words", () => {
    expect(fileNameMatcher(" -- ")("a.md")).toBe(false)
  })
})

describe("filterLoadedListings", () => {
  test("returns matching files from every loaded folder, not folders", () => {
    const paths = filterLoadedListings(
      [
        ["", listing(["reports", "directory"], ["report.md", "file"])],
        ["reports", listing(["q3-report.pdf", "file"], ["notes.md", "file"])],
        ["/archive/", listing(["old-report.txt", "file"])],
        ["pending", undefined],
      ],
      "REPORT",
    )
    expect(paths).toEqual(["archive/old-report.txt", "report.md", "reports/q3-report.pdf"])
  })

  test("returns nothing when no loaded name matches", () => {
    expect(filterLoadedListings([["", listing(["a.md", "file"])]], "zz")).toEqual([])
  })
})

import { describe, expect, test } from "bun:test"
import { fileNameMatcher, filterLoadedListings } from "../local-file-filter"
import type { LsResult } from "../../api/types"

function listing(...entries: Array<[name: string, type: "file" | "directory"]>): LsResult {
  return { entries: entries.map(([name, type]) => ({ name, type, size: 0 })) } as LsResult
}

describe("fileNameMatcher", () => {
  test("matches a substring of the name, case-sensitively like glob", () => {
    expect(fileNameMatcher("port").test("report.md")).toBe(true)
    expect(fileNameMatcher("Port").test("report.md")).toBe(false)
  })

  test("keeps * and ? as wildcards and escapes regex syntax", () => {
    expect(fileNameMatcher("re*.md").test("report.md")).toBe(true)
    expect(fileNameMatcher("v?.txt").test("v2.txt")).toBe(true)
    expect(fileNameMatcher("a.b").test("axb")).toBe(false)
    expect(fileNameMatcher("(draft)").test("notes (draft).md")).toBe(true)
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
      "report",
    )
    expect(paths).toEqual(["archive/old-report.txt", "report.md", "reports/q3-report.pdf"])
  })

  test("returns nothing when no loaded name matches", () => {
    expect(filterLoadedListings([["", listing(["a.md", "file"])]], "zz")).toEqual([])
  })
})

import { beforeEach, describe, expect, test } from "bun:test"
import {
  clearSearchFilter,
  fileSearchStore,
  hasMatchingDescendant,
  isPathMatched,
  isPathVisible,
  setSearchError,
  setSearchLoading,
  setSearchResults,
} from "../../stores/file-search"

describe("file search state", () => {
  beforeEach(() => clearSearchFilter())

  test("clears old matches while a new request runs", () => {
    setSearchResults("report", "drive-a", ["docs/report.md"])
    setSearchLoading("notes", "drive-a")

    expect(fileSearchStore.getSnapshot()).toEqual({
      status: "loading",
      query: "notes",
      driveId: "drive-a",
      matchedPaths: [],
      error: null,
    })
    expect(isPathVisible("docs/report.md")).toBe(false)
  })

  test("clears old matches when the active drive changes", () => {
    setSearchResults("report", "drive-a", ["docs/report.md"])
    setSearchLoading("report", "drive-b")

    expect(fileSearchStore.getSnapshot().driveId).toBe("drive-b")
    expect(fileSearchStore.getSnapshot().matchedPaths).toEqual([])
  })

  test("keeps errors distinct from successful empty results", () => {
    setSearchError("report", "drive-a", "Request failed")
    expect(fileSearchStore.getSnapshot().status).toBe("error")
    expect(fileSearchStore.getSnapshot().error).toBe("Request failed")

    setSearchResults("report", "drive-a", [])
    expect(fileSearchStore.getSnapshot().status).toBe("success")
    expect(fileSearchStore.getSnapshot().error).toBeNull()
  })

  test("normalizes and deduplicates matches", () => {
    setSearchResults("report", "drive-a", ["/docs/report.md", "docs/report.md/"])

    expect(fileSearchStore.getSnapshot().matchedPaths).toEqual(["docs/report.md"])
    expect(isPathMatched("/docs/report.md")).toBe(true)
    expect(isPathMatched("docs/other.md")).toBe(false)
    expect(isPathVisible("docs")).toBe(true)
    expect(hasMatchingDescendant("docs")).toBe(true)
  })
})

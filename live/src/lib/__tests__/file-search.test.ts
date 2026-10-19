import { beforeEach, describe, expect, test } from "bun:test"
import {
  clearSearchFilter,
  fileSearchStore,
  setSearchError,
  setSearchLoading,
  setSearchResults,
} from "../../stores/file-search"

describe("file search state", () => {
  beforeEach(() => clearSearchFilter())

  test("clears old matches while a new request runs", () => {
    setSearchResults("report", "drive-a", ["docs/report.md"], 1)
    setSearchLoading("notes", "drive-a")

    expect(fileSearchStore.getSnapshot()).toEqual({
      status: "loading",
      query: "notes",
      driveId: "drive-a",
      matchedPaths: [],
      total: 0,
      error: null,
    })
  })

  test("clears old matches when the active drive changes", () => {
    setSearchResults("report", "drive-a", ["docs/report.md"], 1)
    setSearchLoading("report", "drive-b")

    expect(fileSearchStore.getSnapshot().driveId).toBe("drive-b")
    expect(fileSearchStore.getSnapshot().matchedPaths).toEqual([])
  })

  test("keeps errors distinct from successful empty results", () => {
    setSearchError("report", "drive-a", "Request failed")
    expect(fileSearchStore.getSnapshot().status).toBe("error")
    expect(fileSearchStore.getSnapshot().error).toBe("Request failed")

    setSearchResults("report", "drive-a", [], 0)
    expect(fileSearchStore.getSnapshot().status).toBe("success")
    expect(fileSearchStore.getSnapshot().error).toBeNull()
  })

  test("keeps the server total past the result cap", () => {
    setSearchResults("report", "drive-a", ["a/report.md", "b/report.md"], 120)
    expect(fileSearchStore.getSnapshot().total).toBe(120)
  })

  test("normalizes and deduplicates matches", () => {
    setSearchResults("report", "drive-a", ["/docs/report.md", "docs/report.md/"], 1)

    expect(fileSearchStore.getSnapshot().matchedPaths).toEqual(["docs/report.md"])
  })
})

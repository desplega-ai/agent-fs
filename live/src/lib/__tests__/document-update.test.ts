import { describe, expect, test } from "bun:test"
import { hasDocumentUpdate } from "../document-update"

const displayed = { key: "org/drive/doc.md", version: 3, etag: "e:old" }

describe("document update detection", () => {
  test("detects a newer version and changed bytes with the same version", () => {
    expect(hasDocumentUpdate(displayed.key, displayed, { currentVersion: 4 })).toBe(true)
    expect(hasDocumentUpdate(displayed.key, displayed, { currentVersion: 3, etag: '"new"' })).toBe(true)
  })
  test("does not report stale polls, another document, or matching bytes", () => {
    expect(hasDocumentUpdate(displayed.key, displayed, { currentVersion: 2, etag: '"older"' })).toBe(false)
    expect(hasDocumentUpdate("another", displayed, { currentVersion: 4 })).toBe(false)
    expect(hasDocumentUpdate(displayed.key, displayed, { currentVersion: 3, etag: '"old"' })).toBe(false)
  })
  test("does not infer a byte change from a missing or weak etag", () => {
    expect(hasDocumentUpdate(displayed.key, displayed, { currentVersion: 3 })).toBe(false)
    expect(hasDocumentUpdate(displayed.key, displayed, { currentVersion: 3, etag: 'W/"new"' })).toBe(false)
  })
})

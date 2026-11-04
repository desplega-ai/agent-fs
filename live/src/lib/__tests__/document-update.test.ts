import { describe, expect, test } from "bun:test"
import { documentUpdateNotice, hasDocumentUpdate } from "../document-update"

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

describe("document update notice", () => {
  const base = { key: "org/drive/doc.md", hasUpdate: true, autoUpdate: false, isEditing: false, latest: { currentVersion: 4, etag: '"e"' } }
  test("offers to load a newer version while viewing", () => {
    expect(documentUpdateNotice(base)).toEqual({
      id: "org/drive/doc.md@4:e:e:viewing",
      versionKey: "org/drive/doc.md@4:e:e",
      description: "Version 4 is ready to load.",
      canLoad: true,
    })
  })
  test("shows no notice when there is no update or auto reload loads it now", () => {
    expect(documentUpdateNotice({ ...base, hasUpdate: false })).toBeNull()
    expect(documentUpdateNotice({ ...base, autoUpdate: true })).toBeNull()
  })
  test("tells an editor to finish first, keeping the same version key", () => {
    const manual = documentUpdateNotice({ ...base, isEditing: true })
    const auto = documentUpdateNotice({ ...base, isEditing: true, autoUpdate: true })
    expect(manual).toMatchObject({ canLoad: false, description: "Finish editing to load it.", versionKey: "org/drive/doc.md@4:e:e" })
    expect(auto).toMatchObject({ canLoad: false, description: "It loads when you finish editing." })
    expect(manual?.id).not.toBe(documentUpdateNotice(base)?.id)
  })
})

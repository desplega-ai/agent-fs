import { describe, expect, test } from "bun:test"
import type { DiffResult } from "@/api/types"
import { resolveAnchor, sourceTextSpace } from "../comment-anchor"
import { anchorDiffChanges, diffOutcome } from "../diff-source"

// DiffResultView renders straight from diffOutcome: "identical" is the only
// branch that says "No changes between these versions."
describe("version history diff panel", () => {
  test("two different writes on a backend without object versions do not read as unchanged", () => {
    // What the server returns for write v1 -> write v2 when it can't fetch content.
    expect(diffOutcome({ changes: [], source: "none" })).toEqual({ kind: "unavailable" })
  })

  test("an empty content comparison is the only empty result that claims equality", () => {
    expect(diffOutcome({ changes: [], source: "content" })).toEqual({ kind: "identical" })
    expect(diffOutcome({ changes: [], source: "summary" })).toEqual({ kind: "unavailable" })
  })

  test("an empty result from a server that predates source never claims equality", () => {
    expect(diffOutcome({ changes: [] })).toEqual({ kind: "unavailable" })
  })

  test("summary hunks are labeled as stored snippets, content hunks are not", () => {
    const changes = [{ type: "remove" as const, content: "old" }, { type: "add" as const, content: "new" }]
    expect(diffOutcome({ changes, source: "summary" })).toEqual({ kind: "changes", changes, partial: true })
    expect(diffOutcome({ changes, source: "content" })).toEqual({ kind: "changes", changes, partial: false })
  })
})

describe("comment anchoring through a diff result", () => {
  // v1 had "alpha" on line 1; v2 inserted a new first line, so "alpha" is now line 2.
  const current = sourceTextSpace("inserted\nalpha\nbeta")
  const resolveLineOnly = (diff: DiffResult) =>
    resolveAnchor(current, { lineStart: 1, lineEnd: 1, stale: true, changes: anchorDiffChanges(diff) })

  test("a none result does not anchor a line-only comment on the inserted line", () => {
    const r = resolveLineOnly({ changes: [], source: "none" })
    expect(r.status).not.toBe("anchored")
  })

  test("an empty result from a server that predates source is unavailable", () => {
    expect(anchorDiffChanges({ changes: [] })).toBeNull()
  })

  test("a content diff still remaps the comment to its new line", () => {
    const r = resolveLineOnly({
      source: "content",
      changes: [
        { type: "add", content: "inserted", newLine: 1 },
        { type: "context", content: "alpha", oldLine: 1, newLine: 2 },
        { type: "context", content: "beta", oldLine: 2, newLine: 3 },
      ],
    })
    expect(r.status).toBe("anchored")
    expect(r.lineStart).toBe(2)
  })

  test("old servers keep remapping through non-empty line-numbered changes", () => {
    const changes = [{ type: "add" as const, content: "x", newLine: 1 }]
    expect(anchorDiffChanges({ changes })).toBe(changes)
  })
})

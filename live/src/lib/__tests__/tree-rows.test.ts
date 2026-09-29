import { describe, expect, test } from "bun:test"
import { flattenTree } from "../tree-rows"
import type { LsEntry, LsResult } from "@/api/types"

const dir = (name: string): LsEntry => ({ name, type: "directory", size: 0 })
const file = (name: string): LsEntry => ({ name, type: "file", size: 1 })
const ls = (...entries: LsEntry[]): LsResult => ({ entries })

describe("flattenTree", () => {
  const root = ls(file("b.md"), dir("src"), file("a.md"), dir("docs"))
  const listings = new Map<string, LsResult>([
    ["src", ls(file("index.ts"), dir("lib"))],
    ["src/lib", ls()],
  ])

  test("folders first, then names, depth-first under expanded folders", () => {
    const { rows, expandedDirs } = flattenTree(
      root,
      new Set(["src", "src/lib"]),
      (path) => listings.get(path),
    )
    expect(rows.map((row) => `${row.depth}:${row.kind}:${row.path}`)).toEqual([
      "0:entry:docs",
      "0:entry:src",
      "1:entry:src/lib",
      "2:empty:src/lib/",
      "1:entry:src/index.ts",
      "0:entry:a.md",
      "0:entry:b.md",
    ])
    expect(expandedDirs).toEqual(["src", "src/lib"])
  })

  test("an expanded folder that is not loaded yet shows no children but is reported", () => {
    const { rows, expandedDirs } = flattenTree(root, new Set(["docs"]), () => undefined)
    expect(rows.map((row) => row.path)).toEqual(["docs", "src", "a.md", "b.md"])
    expect(expandedDirs).toEqual(["docs"])
  })

  test("expanded state under a collapsed parent is ignored", () => {
    const { rows, expandedDirs } = flattenTree(root, new Set(["src/lib"]), (path) =>
      listings.get(path),
    )
    expect(rows).toHaveLength(4)
    expect(expandedDirs).toEqual([])
  })

  test("entry rows carry what the row and context menu need", () => {
    const { rows } = flattenTree(root, new Set(["src"]), (path) => listings.get(path))
    expect(rows.find((row) => row.path === "src/index.ts")).toEqual({
      kind: "entry",
      path: "src/index.ts",
      parentPath: "src",
      entry: file("index.ts"),
      depth: 1,
      isDir: false,
      expanded: false,
    })
    expect(rows.find((row) => row.path === "src")).toMatchObject({ isDir: true, expanded: true })
  })

  test("does not reorder the listing it was given", () => {
    flattenTree(root, new Set(), () => undefined)
    expect(root.entries.map((entry) => entry.name)).toEqual(["b.md", "src", "a.md", "docs"])
  })
})

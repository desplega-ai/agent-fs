import { expect, test } from "bun:test"
import { createTreeListingLoader, demandedDirectories } from "../tree-loading"
import { flattenTree } from "../tree-rows"
import type { LsResult } from "@/api/types"

test("viewport demand includes ancestors and focus, but not every mounted or expanded row", () => {
  const root: LsResult = { entries: [
    { name: "a", type: "directory", size: 0 },
    { name: "z", type: "directory", size: 0 },
  ] }
  const { rows } = flattenTree(root, new Set(["a", "z"]), () => ({ entries: [
    { name: "file.md", type: "file", size: 1 },
  ] }))
  expect(demandedDirectories(rows, 1, 1, null)).toEqual(["a", "a/file.md"])
  expect(demandedDirectories(rows, 1, 1, "z")).toEqual(["z", "a", "a/file.md"])
})

test("listing slots survive failures and queued cancellation, and prioritize current focus", async () => {
  const started: string[] = []
  const pending: { resolve: (value: LsResult) => void; reject: (reason: Error) => void }[] = []
  let focused = ""
  const load = createTreeListingLoader((path) => {
    started.push(path)
    return new Promise((resolve, reject) => pending.push({ resolve, reject }))
  }, (path) => path === focused ? 0 : 1)
  const controllers = Array.from({ length: 8 }, () => new AbortController())
  const results = controllers.map((controller, i) => load(String(i), controller.signal).catch(() => null))
  expect(started).toEqual(["0", "1", "2", "3"])
  controllers[4].abort()
  focused = "7"
  pending.shift()!.reject(new Error("Listing failed"))
  await results[0]
  await Promise.resolve()
  expect(started).toEqual(["0", "1", "2", "3", "7"])
  for (let i = 0; i < 3; i++) {
    pending.splice(0).forEach(({ resolve }) => resolve({ entries: [] }))
    await Promise.resolve()
    await Promise.resolve()
  }
  await Promise.all(results)
  expect(started).not.toContain("4")
  expect(started.slice(-2)).toEqual(["5", "6"])
})

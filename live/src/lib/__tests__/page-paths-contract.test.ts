import { describe, expect, test } from "bun:test"
import { assertDataWrite, resolvePagePath } from "../html-page-bridge"
import { assertPageDataWrite, resolvePagePath as resolveOnServer } from "../../../../packages/core/src/ops/page-paths"

// The live host and the server's /page/ shell each keep the page path rules;
// a page must get the same answer from both. Compares results and refusals.

function outcome(fn: () => unknown): unknown {
  try {
    return { ok: fn() ?? true }
  } catch (err) {
    const e = err as { code?: string; message?: string }
    return { code: e.code, message: e.message }
  }
}

const FOLDER = "/work/tasks"

const PATHS = [
  "data/state.json", "notes.md", "a/b/c.txt", "ñ/日本.json", "%2e%2e/x", "a b/c#d.txt", "data/",
  "", "a".repeat(512), "a".repeat(513), "/abs", "a\\b", "a\0b", "../x", "a/../b", "a/./b", "a//b", ".", "..", "x/..",
]

const WRITES: Array<[string, string]> = [
  ["/work/tasks/data/a.json", "{}"],
  ["/work/tasks/data/sub/b.NDJSON", ""],
  ["/work/tasks/data/c.yml", "x"],
  ["/work/tasks/data/d.CSV", "x"],
  ["/work/tasks/a.json", "{}"],
  ["/work/tasks/database/a.json", "{}"],
  ["/work/tasks-other/data/a.json", "{}"],
  ["/work/tasks/data/a.html", "x"],
  ["/work/tasks/data/a.js", "x"],
  ["/work/tasks/data/.json", "x"],
  ["/work/tasks/data/noext", "x"],
  ["/work/tasks/data/a.txt", "é".repeat(128 * 1024)],
  ["/work/tasks/data/a.txt", "é".repeat(128 * 1024 + 1)],
  ["/work/tasks/data/a.txt", "x".repeat(256 * 1024 + 1)],
]

describe("page path rules: live host and server agree", () => {
  test.each(PATHS)("resolve %j", (path) => {
    expect(outcome(() => resolvePagePath(FOLDER, path))).toEqual(outcome(() => resolveOnServer(FOLDER, path)))
  })

  test.each(WRITES.map(([path, content]) => [path, content.length, content] as const))("write %s (%d chars)", (path, _len, content) => {
    expect(outcome(() => assertDataWrite(FOLDER, path, content))).toEqual(outcome(() => assertPageDataWrite(FOLDER, path, content)))
  })
})

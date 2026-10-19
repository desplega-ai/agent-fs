import { beforeEach, describe, expect, test } from "bun:test"
import { FIND_RESULT_LIMIT, fetchFind, resetFindSupport } from "../find-search"
import type { FindResult, GlobResult } from "@/api/types"

type Call = { op: string; params?: Record<string, unknown> }

const FOUND: FindResult = {
  matches: [{ path: "/decks/Zephyr Pitch Deck.pdf", size: 1, score: 36 }],
  total: 1,
}

/** A server with `find` answers it; an old one rejects it like the real API. */
function fakeClient(endpoint: string, opts: { supportsFind: boolean; globPaths?: string[]; error?: Error }) {
  const calls: Call[] = []
  const client = {
    endpoint,
    calls,
    callOp: async <T>(_orgId: string, op: string, params?: Record<string, unknown>): Promise<T> => {
      calls.push({ op, params })
      if (op === "find") {
        if (opts.error) throw opts.error
        if (!opts.supportsFind) throw new Error(`Unknown operation: ${op}`)
        return FOUND as T
      }
      const result: GlobResult = { matches: (opts.globPaths ?? []).map((path) => ({ path, size: 1 })) }
      return result as T
    },
  }
  return client
}

describe("fetchFind", () => {
  beforeEach(() => resetFindSupport())

  test("asks a current server for ranked find results", async () => {
    const client = fakeClient("https://new.example", { supportsFind: true })
    expect(await fetchFind(client, "org", "drive", "zephyr")).toEqual(FOUND)
    expect(client.calls).toEqual([{ op: "find", params: { query: "zephyr", limit: FIND_RESULT_LIMIT } }])
  })

  test("falls back to the old substring glob on a server without find, and remembers it", async () => {
    const client = fakeClient("https://old.example", { supportsFind: false, globPaths: ["/a/report.md"] })
    const result = await fetchFind(client, "org", "drive", "report")
    expect(result).toEqual({ matches: [{ path: "/a/report.md", size: 1, score: 0 }], total: 1 })

    await fetchFind(client, "org", "drive", "notes")
    expect(client.calls.map((call) => call.op)).toEqual(["find", "glob", "glob"])
    expect(client.calls[1].params).toEqual({ pattern: "**/*report*" })
  })

  test("marks only the endpoint that lacks find", async () => {
    await fetchFind(fakeClient("https://old.example", { supportsFind: false }), "org", "drive", "report")
    const current = fakeClient("https://new.example", { supportsFind: true })
    await fetchFind(current, "org", "drive", "report")
    expect(current.calls.map((call) => call.op)).toEqual(["find"])
  })

  test("caps the glob fallback and keeps its full count", async () => {
    const paths = Array.from({ length: FIND_RESULT_LIMIT + 5 }, (_, i) => `/n/note-${i}.md`)
    const client = fakeClient("https://old.example", { supportsFind: false, globPaths: paths })
    const result = await fetchFind(client, "org", "drive", "note")
    expect(result.matches).toHaveLength(FIND_RESULT_LIMIT)
    expect(result.total).toBe(FIND_RESULT_LIMIT + 5)
  })

  test("rethrows other errors without falling back", async () => {
    const client = fakeClient("https://new.example", { supportsFind: true, error: new Error("Too many requests") })
    await expect(fetchFind(client, "org", "drive", "report")).rejects.toThrow("Too many requests")
    expect(client.calls.map((call) => call.op)).toEqual(["find"])
  })
})

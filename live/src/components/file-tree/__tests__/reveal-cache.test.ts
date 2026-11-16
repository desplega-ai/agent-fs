import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { QueryClient } from "@tanstack/react-query"
import { resetRevealSupport, revealFile, TREE_STALE_TIME } from "@/lib/reveal"
import type { LsResult, RevealResult } from "@/api/types"

function fakeClient(endpoint: string) {
  const calls: { op: string }[] = []
  return {
    endpoint,
    calls,
    callOp: async <T>(_org: string, op: string): Promise<T> => {
      calls.push({ op })
      return { path: "/a/b/deep.md", stat: {}, listings: [] } as RevealResult as T
    },
  }
}

describe("revealFile cache reuse", () => {
  let cache: QueryClient
  const data: Record<string, LsResult> = {
    "": { entries: [{ name: "a", type: "directory", size: 0 }] },
    a: { entries: [{ name: "b", type: "directory", size: 0 }] },
    "a/b": { entries: [{ name: "deep.md", type: "file", size: 1 }] },
  }
  const key = (path: string) => ["ls", "org", "drive", path]
  const signal = () => new AbortController().signal
  beforeEach(() => {
    resetRevealSupport()
    cache = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    for (const [path, listing] of Object.entries(data)) cache.setQueryData(key(path), listing)
  })
  afterEach(() => cache.clear())

  test("all ancestors must be fresh and contain the next entry", async () => {
    const client = fakeClient("https://new.example")
    await revealFile(cache, client, "org", "drive", "a/b/deep.md", signal())
    expect(client.calls).toEqual([])
    cache.setQueryData(key("a"), { entries: [] })
    await revealFile(cache, client, "org", "drive", "a/b/deep.md", signal())
    expect(client.calls.map((c) => c.op)).toEqual(["reveal"])
  })

  test("an expired ancestor requires reveal even if it contains the file", async () => {
    const client = fakeClient("https://new.example")
    cache.setQueryData(key("a/b"), data["a/b"], { updatedAt: Date.now() - TREE_STALE_TIME - 1 })
    await revealFile(cache, client, "org", "drive", "a/b/deep.md", signal())
    expect(client.calls.map((c) => c.op)).toEqual(["reveal"])
  })

  test("invalidation requires reveal before the age limit", async () => {
    const client = fakeClient("https://new.example")
    await cache.invalidateQueries({ queryKey: key("a/b") })
    await revealFile(cache, client, "org", "drive", "a/b/deep.md", signal())
    expect(client.calls.map((c) => c.op)).toEqual(["reveal"])
  })

  test("a directory with the file's name does not count as a fresh file", async () => {
    const client = fakeClient("https://new.example")
    cache.setQueryData(key("a/b"), { entries: [{ name: "deep.md", type: "directory", size: 0 }] })
    await revealFile(cache, client, "org", "drive", "a/b/deep.md", signal())
    expect(client.calls.map((c) => c.op)).toEqual(["reveal"])
  })

  test("old-server fallback refreshes only missing or stale parents", async () => {
    cache.setQueryData(key("a/b"), { entries: [] })
    const calls: string[] = []
    const client = {
      endpoint: "https://old.example",
      callOp: async <T>(_org: string, op: string, params?: Record<string, unknown>): Promise<T> => {
        calls.push(`${op} ${params?.path}`)
        if (op === "reveal") throw new Error("Unknown operation: reveal")
        return data[String(params?.path)] as T
      },
    }
    await revealFile(cache, client, "org", "drive", "a/b/deep.md", signal())
    expect(calls).toEqual(["reveal a/b/deep.md", "ls a/b"])
    expect(cache.getQueryData(key("a/b"))).toEqual(data["a/b"])
    await revealFile(cache, client, "org", "drive", "a/b/deep.md", signal())
    expect(calls).toHaveLength(2)
  })

  test("a failed reveal uses listings without disabling reveal support", async () => {
    cache.removeQueries({ queryKey: key("a/b") })
    const calls: string[] = []
    const client = {
      endpoint: "https://flaky.example",
      callOp: async <T>(_org: string, op: string, params?: Record<string, unknown>): Promise<T> => {
        calls.push(op)
        if (op === "reveal") throw new Error("Network error")
        return data[String(params?.path)] as T
      },
    }
    await revealFile(cache, client, "org", "drive", "a/b/deep.md", signal())
    cache.removeQueries({ queryKey: key("a/b") })
    await revealFile(cache, client, "org", "drive", "a/b/deep.md", signal())
    expect(calls).toEqual(["reveal", "ls", "reveal", "ls"])
  })
})

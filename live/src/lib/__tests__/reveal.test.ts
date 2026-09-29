import { beforeEach, describe, expect, test } from "bun:test"
import { fetchReveal, resetRevealSupport } from "../reveal"
import type { RevealResult } from "@/api/types"

const RESULT: RevealResult = {
  path: "/a/b/deep.md",
  stat: {} as RevealResult["stat"],
  listings: [
    { path: "/", entries: [] },
    { path: "/a", entries: [] },
    { path: "/a/b", entries: [] },
  ],
}

type Call = { op: string; signal?: AbortSignal }

/** A server with `reveal` answers it; an old one rejects it like the real API. */
function fakeClient(endpoint: string, supportsReveal: boolean) {
  const calls: Call[] = []
  const client = {
    endpoint,
    calls,
    callOp: async <T>(
      _orgId: string,
      op: string,
      _params?: Record<string, unknown>,
      _driveId?: string,
      opts?: { signal?: AbortSignal },
    ): Promise<T> => {
      calls.push({ op, signal: opts?.signal })
      if (!supportsReveal) throw new Error(`Unknown operation: ${op}`)
      return RESULT as T
    },
  }
  return client
}

describe("fetchReveal", () => {
  beforeEach(() => resetRevealSupport())

  test("old endpoint -> supported endpoint without reload keeps one-request reveal", async () => {
    const oldServer = fakeClient("https://old.example", false)
    const newServer = fakeClient("https://new.example", true)

    expect(await fetchReveal(newServer, "org", "drive", "a/b/deep.md")).toEqual(RESULT)
    expect(await fetchReveal(oldServer, "org", "drive", "a/b/deep.md")).toBeNull()

    // Switching back must still ask the supported server for reveal, every time.
    expect(await fetchReveal(newServer, "org", "drive", "a/b/deep.md")).toEqual(RESULT)
    expect(await fetchReveal(newServer, "org", "drive", "a/b/other.md")).toEqual(RESULT)
    expect(newServer.calls.map((c) => c.op)).toEqual(["reveal", "reveal", "reveal"])
  })

  test("an old endpoint stops sending reveal once it answered unknown operation", async () => {
    const oldServer = fakeClient("https://old.example", false)

    expect(await fetchReveal(oldServer, "org", "drive", "a/b/deep.md")).toBeNull()
    expect(await fetchReveal(oldServer, "org", "drive", "a/b/deep.md")).toBeNull()
    expect(oldServer.calls.map((c) => c.op)).toEqual(["reveal"])
  })

  test("a late rejection from the old endpoint does not disable the new one", async () => {
    let rejectOld!: (error: Error) => void
    const oldServer = {
      endpoint: "https://old.example",
      callOp: <T>(): Promise<T> =>
        new Promise<T>((_resolve, reject) => {
          rejectOld = reject
        }),
    }
    const newServer = fakeClient("https://new.example", true)

    const abort = new AbortController()
    const pending = fetchReveal(oldServer, "org", "drive", "a/b/deep.md", abort.signal)
    abort.abort()
    rejectOld(new Error("Unknown operation: reveal"))
    expect(await pending).toBeNull()

    expect(await fetchReveal(newServer, "org", "drive", "a/b/deep.md")).toEqual(RESULT)
    expect(newServer.calls.map((c) => c.op)).toEqual(["reveal"])
  })

  test("a cancelled or failed request falls back without disabling reveal", async () => {
    const server = fakeClient("https://new.example", true)
    const flaky = {
      endpoint: server.endpoint,
      callOp: async <T>(): Promise<T> => {
        throw new DOMException("The operation was aborted.", "AbortError")
      },
    }

    expect(await fetchReveal(flaky, "org", "drive", "a/b/deep.md")).toBeNull()
    expect(await fetchReveal(server, "org", "drive", "a/b/deep.md")).toEqual(RESULT)
  })

  test("passes the abort signal through to the request", async () => {
    const server = fakeClient("https://new.example", true)
    const abort = new AbortController()
    await fetchReveal(server, "org", "drive", "a/b/deep.md", abort.signal)
    expect(server.calls[0]?.signal).toBe(abort.signal)
  })
})

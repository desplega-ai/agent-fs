import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import {
  MAX_RETAINED_CHARS,
  MAX_TOTAL_RETAINED_CHARS,
  fileContentKey,
  fileContentQueryOptions,
  loadFileContent,
  normalizeEtag,
  statValidator,
  withSavedText,
  type CachedFileContent,
} from "../file-content-cache"

const STAT = { etag: '"abc"' }

/**
 * The slice of TanStack's `QueryClient` the cache module touches, with the same
 * semantics: a successful fetch stores its data and restamps `dataUpdatedAt`,
 * a query with observers is in use, and `remove` drops the entry. The real
 * client is not importable here (`live/` has its own pnpm install, which the
 * root test run does not have), so this is checked against the real one by
 * running this suite with the two swapped.
 */
class FakeQueryClient {
  queries = new Map<string, FakeQuery>()

  getQueryCache() {
    return {
      findAll: ({ queryKey }: { queryKey: readonly unknown[] }) =>
        [...this.queries.values()].filter((q) => q.queryKey[0] === queryKey[0]),
      remove: (query: FakeQuery) => this.queries.delete(query.queryHash),
    }
  }

  getQueryData(queryKey: readonly unknown[]) {
    return this.queries.get(JSON.stringify(queryKey))?.state.data
  }

  async fetchQuery(options: { queryKey: readonly unknown[]; queryFn: (ctx: object) => Promise<unknown> }) {
    const data = await options.queryFn({})
    // Only file text is retained by these tests; stat results are not cached.
    if (options.queryKey[0] !== "file-content") return data
    const queryHash = JSON.stringify(options.queryKey)
    const query = this.queries.get(queryHash) ?? new FakeQuery(options.queryKey, queryHash)
    query.state = { data, dataUpdatedAt: Date.now() }
    this.queries.set(queryHash, query)
    return data
  }

  /** A viewer on screen: the entry now has an observer and must not be evicted. */
  observe(queryKey: readonly unknown[]) {
    const query = this.queries.get(JSON.stringify(queryKey))!
    query.observers++
    return () => query.observers--
  }

  clear() {
    this.queries.clear()
  }
}

class FakeQuery {
  state: { data: unknown; dataUpdatedAt: number } = { data: undefined, dataUpdatedAt: 0 }
  observers = 0
  constructor(
    readonly queryKey: readonly unknown[],
    readonly queryHash: string,
  ) {}

  getObserversCount() {
    return this.observers
  }
}

/** A download that answers with `text`, stamped with `etag` the way a storage response would be. */
const download = (text: string, etag: string | null = STAT.etag) => async () => ({ text, etag })

describe("normalizeEtag", () => {
  test("quotes are not part of the identity", () => {
    expect(normalizeEtag('"abc"')).toBe(normalizeEtag("abc"))
    expect(normalizeEtag('"abc"')).not.toBe(normalizeEtag('"def"'))
  })

  test("absent, empty and weak etags cannot vouch for the bytes", () => {
    expect(normalizeEtag(undefined)).toBeNull()
    expect(normalizeEtag(null)).toBeNull()
    expect(normalizeEtag("")).toBeNull()
    expect(normalizeEtag('""')).toBeNull()
    expect(normalizeEtag('W/"abc"')).toBeNull()
  })
})

describe("statValidator", () => {
  test("is identical for identical etags and differs when the etag moves", () => {
    expect(statValidator({ ...STAT })).toBe(statValidator(STAT))
    expect(statValidator({ etag: '"def"' })).not.toBe(statValidator(STAT))
  })

  test("is null for a server that reports no etag: version, size and mtime do not identify bytes", () => {
    expect(statValidator({})).toBeNull()
    // Extra fields an older server does send are ignored.
    expect(statValidator({ currentVersion: 3, size: 10, modifiedAt: "t" } as never)).toBeNull()
  })
})

describe("loadFileContent", () => {
  test("downloads and stamps the body with the response's etag when nothing is cached", async () => {
    const entry = await loadFileContent(undefined, STAT, download("a\nb"))
    expect(entry).toEqual({ content: "a\nb", totalLines: 2, truncated: false, validator: normalizeEtag(STAT.etag) })
  })

  test("reuses the cached body without downloading when the stat matches", async () => {
    const cached = await loadFileContent(undefined, STAT, download("same"))
    let downloads = 0
    const entry = await loadFileContent(cached, { etag: "abc" }, async () => {
      downloads++
      return { text: "different", etag: "abc" }
    })
    expect(downloads).toBe(0)
    expect(entry).toBe(cached)
  })

  test("downloads again when the file changed, and never returns the old text", async () => {
    const cached = await loadFileContent(undefined, STAT, download("old"))
    const entry = await loadFileContent(cached, { etag: '"new"' }, download("new", '"new"'))
    expect(entry.content).toBe("new")
    expect(entry.validator).toBe(normalizeEtag('"new"'))
  })

  test("a failed download rejects and leaves the cached entry untouched", async () => {
    const cached = await loadFileContent(undefined, STAT, download("old"))
    await expect(
      loadFileContent(cached, { etag: '"new"' }, async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    expect(cached.content).toBe("old")
  })

  test("the stamp is the identity of the downloaded bytes, not of the earlier stat", async () => {
    // stat saw A, but the download returned B: the file was rewritten in between.
    const entry = await loadFileContent(undefined, { etag: '"A"' }, download("body B", '"B"'))
    expect(entry.validator).toBe(normalizeEtag('"B"'))

    let downloads = 0
    const counting = async () => {
      downloads++
      return { text: "body A", etag: '"A"' }
    }
    // The file reverted to A: the cached B must not be served for it.
    const reopened = await loadFileContent(entry, { etag: '"A"' }, counting)
    expect(downloads).toBe(1)
    expect(reopened.content).toBe("body A")
    // While the file still is B the cached body is good.
    await loadFileContent(entry, { etag: '"B"' }, counting)
    expect(downloads).toBe(1)
  })

  test("a download that reports no etag is shown but never reused", async () => {
    const entry = await loadFileContent(undefined, STAT, download("body", null))
    expect(entry.content).toBe("body")
    expect(entry.validator).toBeNull()

    let downloads = 0
    await loadFileContent(entry, STAT, async () => {
      downloads++
      return { text: "body", etag: null }
    })
    expect(downloads).toBe(1)
  })

  test("a stat without an etag never reuses a cached body, even one stamped with a validator", async () => {
    const cached = await loadFileContent(undefined, STAT, download("first"))
    let downloads = 0
    const entry = await loadFileContent(cached, {}, async () => {
      downloads++
      return { text: "other", etag: null }
    })
    expect(downloads).toBe(1)
    expect(entry.content).toBe("other")
  })
})

describe("withSavedText", () => {
  test("carries the saved text but never matches a later stat, so the next open re-downloads", async () => {
    const cached = await loadFileContent(undefined, STAT, download("old"))
    const saved = withSavedText(cached, "saved\ntext")
    expect(saved.content).toBe("saved\ntext")
    expect(saved.totalLines).toBe(2)
    expect(saved.validator).toBeNull()

    let downloads = 0
    await loadFileContent(saved, STAT, async () => {
      downloads++
      return { text: "saved\ntext", etag: STAT.etag }
    })
    expect(downloads).toBe(1)
  })
})

describe("fileContentQueryOptions", () => {
  const realFetch = globalThis.fetch
  const queryClients: FakeQueryClient[] = []
  afterEach(() => {
    globalThis.fetch = realFetch
    setSystemTime()
    for (const queryClient of queryClients.splice(0)) queryClient.clear()
  })

  interface FakeFile {
    text: string
    etag: string
    version: number
  }

  /**
   * A drive of rewritable files served the way object storage serves them,
   * counting every request the viewer makes. `hooks` run at the two points a
   * concurrent writer can slip in.
   */
  function setup(
    opts: {
      /** An older server: `stat` has no `etag`. */
      statEtag?: boolean
      /** Storage that does not expose `ETag` to the page. */
      responseEtag?: boolean
      files?: Record<string, FakeFile>
    } = {},
  ) {
    const { statEtag = true, responseEtag = true } = opts
    const files: Record<string, FakeFile> = opts.files ?? { "/a.md": { text: "v1 body", etag: '"e1"', version: 1 } }
    const file = files["/a.md"]
    const calls = { stat: 0, signedUrl: 0, download: 0 }
    const hooks = { afterStat: undefined as (() => void) | undefined, beforeDownload: undefined as (() => void) | undefined }
    const downloadInit: (RequestInit | undefined)[] = []
    const client = {
      callOp: async (_org: string, op: string, params: { path: string }) => {
        if (op !== "stat") throw new Error(`unexpected op ${op}`)
        calls.stat++
        const f = files[params.path]
        const result = {
          path: params.path,
          size: f.text.length,
          currentVersion: f.version,
          modifiedAt: "t",
          createdAt: "t",
          author: "x",
          isDeleted: false,
          ...(statEtag ? { etag: f.etag } : {}),
        }
        hooks.afterStat?.()
        return result
      },
      getSignedUrl: async (_org: string, _drive: string, path: string) => {
        calls.signedUrl++
        return { url: `https://signed.example${path}?sig=${calls.signedUrl}`, expiresAt: "" }
      },
    }
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      calls.download++
      downloadInit.push(init)
      hooks.beforeDownload?.()
      const f = files[new URL(String(url)).pathname]
      return new Response(f.text, responseEtag ? { headers: { ETag: f.etag } } : undefined)
    }) as unknown as typeof fetch

    const queryClient = new FakeQueryClient()
    queryClients.push(queryClient)
    const optionsFor = (path: string) => fileContentQueryOptions(queryClient, client as never, "org", "drive", path)
    /** What a viewer opening `path` does: run the query, which keeps its result in the cache. */
    const open = (path = "/a.md") => queryClient.fetchQuery(optionsFor(path)) as Promise<CachedFileContent>
    const cachedPaths = () =>
      queryClient
        .getQueryCache()
        .findAll({ queryKey: ["file-content"] })
        .filter((q) => q.state.data)
        .map((q) => q.queryKey[3] as string)
    const retainedChars = () =>
      queryClient
        .getQueryCache()
        .findAll({ queryKey: ["file-content"] })
        .reduce((sum, q) => sum + ((q.state.data as CachedFileContent | undefined)?.content.length ?? 0), 0)
    return { file, files, calls, hooks, downloadInit, open, optionsFor, queryClient, cachedPaths, retainedChars }
  }

  test("is keyed by org, drive and path", () => {
    expect(setup().optionsFor("/a.md").queryKey).toEqual(fileContentKey("org", "drive", "/a.md"))
  })

  test("first open: one stat, one signed URL, one download", async () => {
    const { calls, open } = setup()
    expect((await open()).content).toBe("v1 body")
    expect(calls).toEqual({ stat: 1, signedUrl: 1, download: 1 })
  })

  test("reopening an unchanged file costs one stat and no download", async () => {
    const { calls, open } = setup()
    const first = await open()
    const again = await open()
    const third = await open()
    expect(again).toBe(first)
    expect(third).toBe(first)
    expect(calls).toEqual({ stat: 3, signedUrl: 1, download: 1 })
  })

  test("a rewritten file is downloaded again and never served stale, even with an unchanged version", async () => {
    const { file, calls, open } = setup()
    await open()
    file.text = "v2 body"
    file.etag = '"e2"' // e.g. written through the other path spelling: version stays 1
    const changed = await open()
    expect(changed.content).toBe("v2 body")
    expect(calls).toEqual({ stat: 2, signedUrl: 2, download: 2 })
    // and the new body is now the cached one
    await open()
    expect(calls.download).toBe(2)
  })

  test("downloads bypass the browser HTTP cache", async () => {
    const { downloadInit, open } = setup()
    await open()
    expect(downloadInit[0]?.cache).toBe("no-store")
  })

  test("a non-2xx download rejects instead of caching an error page", async () => {
    const { open } = setup()
    globalThis.fetch = (async () => new Response("nope", { status: 403, statusText: "Forbidden" })) as unknown as typeof fetch
    await expect(open()).rejects.toThrow("Failed to fetch: Forbidden")
  })

  describe("older server without a stat etag", () => {
    test("same-size rewrite through the other path spelling is never served stale", async () => {
      // Bytes change but version, size and modified time all stay as they were,
      // and the old server has no etag to say so.
      const { file, calls, open } = setup({ statEtag: false })
      expect((await open()).content).toBe("v1 body")
      file.text = "v2 body"
      file.etag = '"e2"'
      expect(file.text.length).toBe("v1 body".length)
      expect((await open()).content).toBe("v2 body")
      expect(calls.download).toBe(2)
    })

    test("still shows the file, and re-downloads on every open", async () => {
      const { calls, open } = setup({ statEtag: false })
      await open()
      await open()
      expect(calls).toEqual({ stat: 2, signedUrl: 2, download: 2 })
    })
  })

  describe("storage that does not expose the response etag", () => {
    test("bodies are shown but re-downloaded on every open", async () => {
      const { calls, open } = setup({ responseEtag: false })
      expect((await open()).content).toBe("v1 body")
      expect((await open()).content).toBe("v1 body")
      expect(calls.download).toBe(2)
    })
  })

  describe("a write lands between the stat and the download", () => {
    test("write then revert: the body read as B is not reused once the file is A again", async () => {
      const { file, hooks, calls, open } = setup()
      file.text = "content A"
      file.etag = '"eA"'

      // stat sees A; a writer rewrites to B before the download; the download returns B.
      hooks.afterStat = () => {
        file.text = "content B"
        file.etag = '"eB"'
        hooks.afterStat = undefined
      }
      const first = await open()
      expect(first.content).toBe("content B")

      // The file is reverted to A. Reopening must show A, not the cached B.
      file.text = "content A"
      file.etag = '"eA"'
      const reopened = await open()
      expect(reopened.content).toBe("content A")
      expect(calls.download).toBe(2)
    })

    test("when the file is still B on the next open, the B body is reused", async () => {
      const { file, hooks, calls, open } = setup()
      file.text = "content A"
      file.etag = '"eA"'
      hooks.afterStat = () => {
        file.text = "content B"
        file.etag = '"eB"'
        hooks.afterStat = undefined
      }
      await open()
      const again = await open()
      expect(again.content).toBe("content B")
      expect(calls.download).toBe(1)
    })
  })

  describe("total memory bound", () => {
    const NEAR_CAP = MAX_RETAINED_CHARS - 1 // each file is under the per-file threshold
    const files = (n: number) =>
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [
          `/f${i}.txt`,
          { text: String(i % 10).repeat(NEAR_CAP), etag: `"e${i}"`, version: 1 },
        ]),
      ) as Record<string, FakeFile>

    test("opening many distinct files keeps the cached text within the budget", async () => {
      const { open, retainedChars, cachedPaths } = setup({ files: { "/a.md": { text: "", etag: '"e"', version: 1 }, ...files(30) } })
      for (let i = 0; i < 30; i++) {
        setSystemTime(new Date(1_000_000 + i * 1000))
        await open(`/f${i}.txt`)
        expect(retainedChars()).toBeLessThanOrEqual(MAX_TOTAL_RETAINED_CHARS)
      }
      // Older files were dropped, the newest is still there.
      expect(cachedPaths()).toContain("/f29.txt")
      expect(cachedPaths()).not.toContain("/f0.txt")
      expect(cachedPaths().length).toBe(Math.floor(MAX_TOTAL_RETAINED_CHARS / NEAR_CAP))
    })

    test("evicts the file opened longest ago, and reopening a file keeps it warm", async () => {
      const perBudget = Math.floor(MAX_TOTAL_RETAINED_CHARS / NEAR_CAP)
      const { open, cachedPaths } = setup({ files: { "/a.md": { text: "", etag: '"e"', version: 1 }, ...files(perBudget + 1) } })
      let t = 1_000_000
      const openAt = async (path: string) => {
        setSystemTime(new Date((t += 1000)))
        await open(path)
      }
      for (let i = 0; i < perBudget; i++) await openAt(`/f${i}.txt`)
      await openAt("/f0.txt") // f0 is now the most recently opened
      await openAt(`/f${perBudget}.txt`) // over budget: f1 is the oldest
      expect(cachedPaths()).toContain("/f0.txt")
      expect(cachedPaths()).not.toContain("/f1.txt")
      expect(cachedPaths()).toContain(`/f${perBudget}.txt`)
    })

    test("a file open in a viewer is never evicted", async () => {
      const { open, optionsFor, queryClient, cachedPaths, retainedChars } = setup({ files: files(20) })
      setSystemTime(new Date(1_000_000))
      await open("/f0.txt")
      const unsubscribe = queryClient.observe(optionsFor("/f0.txt").queryKey)
      try {
        for (let i = 1; i < 20; i++) {
          setSystemTime(new Date(1_000_000 + i * 1000))
          await open(`/f${i}.txt`)
        }
        expect(cachedPaths()).toContain("/f0.txt")
        expect(retainedChars()).toBeLessThanOrEqual(MAX_TOTAL_RETAINED_CHARS)
      } finally {
        unsubscribe()
      }
    })

    test("reloading a file replaces its own entry instead of counting it twice", async () => {
      const { file, open, cachedPaths } = setup({ files: { "/a.md": { text: "x".repeat(NEAR_CAP), etag: '"e1"', version: 1 }, ...files(4) } })
      for (let i = 0; i < 4; i++) await open(`/f${i}.txt`)
      await open("/a.md")
      // Five files fill the budget exactly; rewriting one must not push another out.
      file.text = "y".repeat(NEAR_CAP)
      file.etag = '"e2"'
      await open("/a.md")
      expect(cachedPaths().sort()).toEqual(["/a.md", "/f0.txt", "/f1.txt", "/f2.txt", "/f3.txt"])
    })
  })
})

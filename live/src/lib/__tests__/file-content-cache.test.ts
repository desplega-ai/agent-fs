import { afterEach, describe, expect, test } from "bun:test"
import {
  fileContentKey,
  fileContentQueryOptions,
  loadFileContent,
  statValidator,
  withSavedText,
  type CachedFileContent,
} from "../file-content-cache"

const STAT = { etag: '"abc"', currentVersion: 3, size: 10, modifiedAt: "2026-09-28T10:00:00.000Z" }

describe("statValidator", () => {
  test("is identical for identical stats", () => {
    expect(statValidator({ ...STAT })).toBe(statValidator({ ...STAT }))
  })

  test("prefers the storage etag: a changed etag differs even when the version did not move", () => {
    expect(statValidator({ ...STAT, etag: '"def"' })).not.toBe(statValidator(STAT))
  })

  test("an unchanged etag matches even if other fields moved", () => {
    expect(statValidator({ ...STAT, modifiedAt: "2027-01-01T00:00:00.000Z" })).toBe(statValidator(STAT))
  })

  describe("older servers without an etag", () => {
    const old = { currentVersion: 3, size: 10, modifiedAt: STAT.modifiedAt }

    test("matches only when version, size and modified time all match", () => {
      expect(statValidator({ ...old })).toBe(statValidator(old))
      expect(statValidator({ ...old, currentVersion: 4 })).not.toBe(statValidator(old))
      expect(statValidator({ ...old, size: 11 })).not.toBe(statValidator(old))
      expect(statValidator({ ...old, modifiedAt: "2026-09-28T10:00:01.000Z" })).not.toBe(statValidator(old))
    })

    test("works without a tracked version", () => {
      const noVersion = { size: 10, modifiedAt: STAT.modifiedAt }
      expect(statValidator(noVersion)).toBe(statValidator({ ...noVersion }))
      expect(statValidator({ ...noVersion, size: 12 })).not.toBe(statValidator(noVersion))
    })

    test("never collides with an etag validator", () => {
      expect(statValidator(old)).not.toBe(statValidator(STAT))
    })
  })
})

describe("loadFileContent", () => {
  test("downloads and stamps the body when nothing is cached", async () => {
    const entry = await loadFileContent(undefined, STAT, async () => "a\nb")
    expect(entry).toEqual({ content: "a\nb", totalLines: 2, truncated: false, validator: statValidator(STAT) })
  })

  test("reuses the cached body without downloading when the stat matches", async () => {
    const cached = await loadFileContent(undefined, STAT, async () => "same")
    let downloads = 0
    const entry = await loadFileContent(cached, { ...STAT }, async () => {
      downloads++
      return "different"
    })
    expect(downloads).toBe(0)
    expect(entry).toBe(cached)
  })

  test("downloads again when the file changed, and never returns the old text", async () => {
    const cached = await loadFileContent(undefined, STAT, async () => "old")
    const entry = await loadFileContent(cached, { ...STAT, etag: '"new"' }, async () => "new")
    expect(entry.content).toBe("new")
    expect(entry.validator).toBe(statValidator({ ...STAT, etag: '"new"' }))
  })

  test("a failed download rejects and leaves the cached entry untouched", async () => {
    const cached = await loadFileContent(undefined, STAT, async () => "old")
    await expect(
      loadFileContent(cached, { ...STAT, etag: '"new"' }, async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    expect(cached.content).toBe("old")
  })
})

describe("withSavedText", () => {
  test("carries the saved text but never matches a later stat, so the next open re-downloads", async () => {
    const cached = await loadFileContent(undefined, STAT, async () => "old")
    const saved = withSavedText(cached, "saved\ntext")
    expect(saved.content).toBe("saved\ntext")
    expect(saved.totalLines).toBe(2)

    let downloads = 0
    await loadFileContent(saved, STAT, async () => {
      downloads++
      return "saved\ntext"
    })
    expect(downloads).toBe(1)
  })
})

describe("fileContentQueryOptions", () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  /** A drive whose single file can be rewritten, counting every request the viewer makes. */
  function setup() {
    const file = { text: "v1 body", etag: '"e1"', version: 1 }
    const calls = { stat: 0, signedUrl: 0, download: 0 }
    const downloadInit: (RequestInit | undefined)[] = []
    const client = {
      callOp: async (_org: string, op: string) => {
        if (op !== "stat") throw new Error(`unexpected op ${op}`)
        calls.stat++
        return { path: "/a.md", size: file.text.length, etag: file.etag, currentVersion: file.version, modifiedAt: "t", createdAt: "t", author: "x", isDeleted: false }
      },
      getSignedUrl: async () => {
        calls.signedUrl++
        return { url: `https://signed.example/a.md?sig=${calls.signedUrl}`, expiresAt: "" }
      },
    }
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      calls.download++
      downloadInit.push(init)
      return new Response(file.text)
    }) as unknown as typeof fetch

    // Minimal stand-ins for the two QueryClient methods the options use.
    const store = new Map<string, unknown>()
    const queryClient = {
      getQueryData: (key: readonly unknown[]) => store.get(JSON.stringify(key)),
      fetchQuery: (opts: { queryFn: () => Promise<unknown> }) => opts.queryFn(),
    }
    const options = fileContentQueryOptions(queryClient as never, client as never, "org", "drive", "/a.md")
    // What a query does on each open: run the queryFn, keep the result under the key.
    const open = async () => {
      const entry = (await options.queryFn({})) as CachedFileContent
      store.set(JSON.stringify(options.queryKey), entry)
      return entry
    }
    return { file, calls, downloadInit, open, options, store }
  }

  test("is keyed by org, drive and path", () => {
    expect(setup().options.queryKey).toEqual(fileContentKey("org", "drive", "/a.md"))
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
})

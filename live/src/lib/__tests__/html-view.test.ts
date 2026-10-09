import { describe, expect, test } from "bun:test"
import {
  HTML_ROOT_OK_KEY,
  SITE_TOKENS_KEY,
  approveRootHtml,
  folderOf,
  isHtmlPath,
  isRootHtmlApproved,
  resolveHtmlViewUrl,
  siteUrlFor,
  supportsHtmlSites,
  type HtmlViewDeps,
} from "../html-view"

const T0 = Date.parse("2026-10-09T12:00:00.000Z")

function memoryStorage() {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  }
}

/** A fake client whose shares live 15 minutes from the fake clock. */
function fakeClient(clock: { now: number }) {
  const minted: Array<{ path: string; expiresIn?: number }> = []
  const client = {
    endpoint: "https://api.example",
    createShare: async (_org: string, _drive: string, path: string, opts?: { expiresIn?: number }) => {
      minted.push({ path, expiresIn: opts?.expiresIn })
      const expiresIn = opts?.expiresIn ?? 86400
      return {
        id: `s${minted.length}`,
        kind: "site" as const,
        url: `http://internal/site/tok${minted.length}/`,
        sharePath: `/site/tok${minted.length}/`,
        path,
        expiresIn,
        expiresAt: new Date(clock.now + expiresIn * 1000).toISOString(),
        maxViews: null,
      }
    },
  }
  return { client, minted }
}

function setup(headStatus = 200) {
  const clock = { now: T0 }
  const storage = memoryStorage()
  const heads: string[] = []
  const deps: HtmlViewDeps = {
    storage,
    now: () => clock.now,
    fetch: async (url, init) => {
      expect(init.method).toBe("HEAD")
      heads.push(url)
      return { status: headStatus }
    },
  }
  return { clock, storage, heads, deps, ...fakeClient(clock) }
}

describe("html-sites support", () => {
  test("only servers that advertise html-sites render HTML", () => {
    expect(supportsHtmlSites({ ok: true, version: "x", features: ["share-links", "html-sites"] })).toBe(true)
    expect(supportsHtmlSites({ ok: true, version: "x", features: ["share-links"] })).toBe(false)
    expect(supportsHtmlSites({ ok: true, version: "old" })).toBe(false)
    expect(supportsHtmlSites(undefined)).toBe(false)
  })
})

describe("isHtmlPath", () => {
  test("html and htm, any case", () => {
    expect(isHtmlPath("a/b/index.html")).toBe(true)
    expect(isHtmlPath("page.htm")).toBe(true)
    expect(isHtmlPath("/Report.HTML")).toBe(true)
    expect(isHtmlPath("notes.md")).toBe(false)
    expect(isHtmlPath("image.svg")).toBe(false)
    expect(isHtmlPath("html")).toBe(false)
    expect(isHtmlPath("a.html.txt")).toBe(false)
  })
})

describe("folderOf", () => {
  test("a root file is in the drive root", () => {
    expect(folderOf("index.html")).toBe("/")
    expect(folderOf("/index.html")).toBe("/")
  })

  test("a nested file is in its parent folder", () => {
    expect(folderOf("research/radar/radar.html")).toBe("/research/radar")
    expect(folderOf("/site/index.html")).toBe("/site")
  })
})

describe("siteUrlFor", () => {
  test("joins the endpoint, the share path and the file name", () => {
    expect(siteUrlFor("https://api.example/", "/site/tok/", "index.html")).toBe("https://api.example/site/tok/index.html")
    expect(siteUrlFor("https://api.example", "/site/tok", "a.html")).toBe("https://api.example/site/tok/a.html")
  })

  test("encodes spaces, # and unicode in each segment", () => {
    expect(siteUrlFor("https://x", "/site/t/", "my page.html")).toBe("https://x/site/t/my%20page.html")
    expect(siteUrlFor("https://x", "/site/t/", "a#b?.html")).toBe("https://x/site/t/a%23b%3F.html")
    expect(siteUrlFor("https://x", "/site/t/", "résumé ✓.html")).toBe("https://x/site/t/r%C3%A9sum%C3%A9%20%E2%9C%93.html")
    expect(siteUrlFor("https://x", "/site/t/", "sub dir/p.html")).toBe("https://x/site/t/sub%20dir/p.html")
  })
})

describe("resolveHtmlViewUrl", () => {
  test("mints a 15-minute share of the file's folder", async () => {
    const { client, minted, deps, heads } = setup()
    const url = await resolveHtmlViewUrl(client, "org", "drive", "reports/q3 plan.html", deps)
    expect(url).toBe("https://api.example/site/tok1/q3%20plan.html")
    expect(minted).toEqual([{ path: "/reports", expiresIn: 900 }])
    // a fresh mint needs no check
    expect(heads).toEqual([])
  })

  test("reuses a cached share within its TTL after a reload", async () => {
    const { client, minted, deps, clock, heads } = setup()
    await resolveHtmlViewUrl(client, "org", "drive", "reports/a.html", deps)
    clock.now += 5 * 60_000

    // A reload: a fresh copy of the module, same localStorage.
    const reloaded = (await import(`../html-view?reload=${Date.now()}`)) as typeof import("../html-view")
    const url = await reloaded.resolveHtmlViewUrl(client, "org", "drive", "reports/b.html", deps)
    expect(url).toBe("https://api.example/site/tok1/b.html")
    expect(minted).toHaveLength(1)
    expect(heads).toEqual(["https://api.example/site/tok1/b.html"])
  })

  test("caches per endpoint, org, drive and folder", async () => {
    const { client, minted, deps, storage } = setup()
    await resolveHtmlViewUrl(client, "org", "drive", "a/x.html", deps)
    await resolveHtmlViewUrl(client, "org", "drive", "b/x.html", deps)
    await resolveHtmlViewUrl(client, "org", "drive2", "a/x.html", deps)
    await resolveHtmlViewUrl(client, "org", "drive", "a/y.html", deps)
    expect(minted.map((m) => m.path)).toEqual(["/a", "/b", "/a"])
    expect(Object.keys(JSON.parse(storage.data.get(SITE_TOKENS_KEY)!)).sort()).toEqual([
      "https://api.example/org/drive/a",
      "https://api.example/org/drive/b",
      "https://api.example/org/drive2/a",
    ])
  })

  test("mints again when less than 3 minutes are left", async () => {
    const { client, minted, deps, clock, heads } = setup()
    await resolveHtmlViewUrl(client, "org", "drive", "a/x.html", deps)
    clock.now += 12 * 60_000 + 1
    const url = await resolveHtmlViewUrl(client, "org", "drive", "a/x.html", deps)
    expect(url).toBe("https://api.example/site/tok2/x.html")
    expect(minted).toHaveLength(2)
    expect(heads).toEqual([])
  })

  test("drops expired entries on read", async () => {
    const { client, deps, clock, storage } = setup()
    await resolveHtmlViewUrl(client, "org", "drive", "old/x.html", deps)
    clock.now += 16 * 60_000
    await resolveHtmlViewUrl(client, "org", "drive", "new/x.html", deps)
    const cache = JSON.parse(storage.data.get(SITE_TOKENS_KEY)!)
    expect(Object.keys(cache)).toEqual(["https://api.example/org/drive/new"])
    expect(cache["https://api.example/org/drive/new"].expiresAt).toBe(clock.now + 900_000)
  })

  for (const status of [404, 410]) {
    test(`a cached share that answers ${status} is dropped and minted again once`, async () => {
      const { client, minted, deps, heads, storage } = setup(status)
      await resolveHtmlViewUrl(client, "org", "drive", "a/x.html", deps)
      const url = await resolveHtmlViewUrl(client, "org", "drive", "a/x.html", deps)
      expect(url).toBe("https://api.example/site/tok2/x.html")
      expect(minted).toHaveLength(2)
      expect(heads).toEqual(["https://api.example/site/tok1/x.html"])
      expect(JSON.parse(storage.data.get(SITE_TOKENS_KEY)!)["https://api.example/org/drive/a"].url).toBe(
        "https://api.example/site/tok2/",
      )
    })
  }

  test("views that start together share one mint", async () => {
    const { client, minted, deps } = setup()
    const urls = await Promise.all([
      resolveHtmlViewUrl(client, "org", "drive", "a/x.html", deps),
      resolveHtmlViewUrl(client, "org", "drive", "a/y.html", deps),
    ])
    expect(urls).toEqual(["https://api.example/site/tok1/x.html", "https://api.example/site/tok1/y.html"])
    expect(minted).toHaveLength(1)
  })

  test("an unreachable HEAD keeps the cached share", async () => {
    const { client, minted, deps } = setup()
    await resolveHtmlViewUrl(client, "org", "drive", "a/x.html", deps)
    const url = await resolveHtmlViewUrl(client, "org", "drive", "a/x.html", {
      ...deps,
      fetch: async () => {
        throw new TypeError("Failed to fetch")
      },
    })
    expect(url).toBe("https://api.example/site/tok1/x.html")
    expect(minted).toHaveLength(1)
  })

  test("corrupt storage is ignored", async () => {
    const { client, minted, deps, storage } = setup()
    storage.setItem(SITE_TOKENS_KEY, "{not json")
    await resolveHtmlViewUrl(client, "org", "drive", "a/x.html", deps)
    expect(minted).toHaveLength(1)
  })
})

describe("drive-root confirm", () => {
  test("is remembered per org, drive and path", () => {
    const storage = memoryStorage()
    expect(isRootHtmlApproved("org", "drive", "index.html", storage)).toBe(false)
    approveRootHtml("org", "drive", "index.html", storage)
    expect(isRootHtmlApproved("org", "drive", "/index.html", storage)).toBe(true)
    expect(isRootHtmlApproved("org", "drive2", "index.html", storage)).toBe(false)
    expect(isRootHtmlApproved("org", "drive", "other.html", storage)).toBe(false)
    expect(JSON.parse(storage.data.get(HTML_ROOT_OK_KEY)!)).toEqual({ "org/drive/index.html": true })
  })
})

import { afterEach, describe, expect, mock, test } from "bun:test"

const toasts: Array<{ kind: "success" | "error"; message: string; description?: string }> = []
mock.module("../../stores/toast", () => ({
  toast: {
    success: (message: string, opts?: { description?: string }) => toasts.push({ kind: "success", message, ...opts }),
    error: (message: string, opts?: { description?: string }) => toasts.push({ kind: "error", message, ...opts }),
  },
}))

const { copyShareLink, describeExpiry, isUnknownOpError, resolveShareUrl, supportsShareLinks } = await import("../share-link")

const result = {
  id: "s1",
  url: "http://internal-host:7433/share/tok",
  sharePath: "/share/tok",
  path: "/a.md",
  expiresIn: 86400,
  expiresAt: "2026-01-02T00:00:00.000Z",
  maxViews: null,
}

describe("share link support", () => {
  test("only servers that advertise share-links show the action", () => {
    expect(supportsShareLinks({ ok: true, version: "x", features: ["share-links"] })).toBe(true)
    expect(supportsShareLinks({ ok: true, version: "x", features: ["other"] })).toBe(false)
    // older servers omit the field; an unreachable server has no health at all
    expect(supportsShareLinks({ ok: true, version: "old", maxUploadBytes: 1 })).toBe(false)
    expect(supportsShareLinks(undefined)).toBe(false)
  })

  test("recognises an older server rejecting the op", () => {
    expect(isUnknownOpError(new Error("Unknown operation: share-create"))).toBe(true)
    expect(isUnknownOpError(new Error("File not found"))).toBe(false)
    expect(isUnknownOpError("Unknown operation")).toBe(false)
  })
})

describe("resolveShareUrl", () => {
  test("uses the endpoint the app talks to, not the server's own address", () => {
    expect(resolveShareUrl("https://agent-fs-acme.fly.dev", result)).toBe("https://agent-fs-acme.fly.dev/share/tok")
    expect(resolveShareUrl("https://agent-fs-acme.fly.dev/", result)).toBe("https://agent-fs-acme.fly.dev/share/tok")
    expect(resolveShareUrl("https://proxy.example/agent-fs", result)).toBe("https://proxy.example/agent-fs/share/tok")
  })

  test("falls back to the server's url when there is no sharePath", () => {
    expect(resolveShareUrl("https://x", { url: "https://y/share/z", sharePath: "" })).toBe("https://y/share/z")
  })
})

describe("describeExpiry", () => {
  test("is human readable", () => {
    expect(describeExpiry(60)).toBe("1 minutes")
    expect(describeExpiry(1800)).toBe("30 minutes")
    expect(describeExpiry(3600)).toBe("1 hour")
    expect(describeExpiry(86400)).toBe("24 hours")
    expect(describeExpiry(604800)).toBe("7 days")
  })
})

describe("copyShareLink", () => {
  const realNavigator = globalThis.navigator
  const realClipboardItem = (globalThis as any).ClipboardItem
  afterEach(() => {
    Object.defineProperty(globalThis, "navigator", { value: realNavigator, configurable: true })
    ;(globalThis as any).ClipboardItem = realClipboardItem
  })

  function stubClipboard() {
    const written: string[] = []
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { writeText: async (t: string) => void written.push(t) } },
      configurable: true,
    })
    ;(globalThis as any).ClipboardItem = undefined
    return written
  }

  test("copies the link built from the endpoint and reports success", async () => {
    const written = stubClipboard()
    const client = { endpoint: "https://api.example", createShare: async () => result } as any
    expect(await copyShareLink(client, "org", "drive", "/a.md")).toBe(true)
    expect(written).toEqual(["https://api.example/share/tok"])
    const shown = toasts.at(-1)!
    expect(shown.message).toBe("Share link copied")
    expect(shown.description).toContain("24 hours")
  })

  test("a folder copies the site link from sharePath", async () => {
    const written = stubClipboard()
    const site = { ...result, kind: "site" as const, url: "http://internal-host:7433/site/tok/", sharePath: "/site/tok/", path: "/reports" }
    const paths: string[] = []
    const client = {
      endpoint: "https://api.example",
      createShare: async (_org: string, _drive: string, path: string) => (paths.push(path), site),
    } as any
    expect(await copyShareLink(client, "org", "drive", "reports")).toBe(true)
    expect(paths).toEqual(["reports"])
    expect(written).toEqual(["https://api.example/site/tok/"])
    expect(toasts.at(-1)!.message).toBe("Site link copied")
  })

  test("an older server produces a clear message instead of a crash", async () => {
    const written = stubClipboard()
    const client = {
      endpoint: "https://api.example",
      createShare: async () => {
        throw new Error("Unknown operation: share-create")
      },
    } as any
    expect(await copyShareLink(client, "org", "drive", "/a.md")).toBe(false)
    expect(written).toEqual([])
    expect(toasts.at(-1)!.message).toBe("This server doesn't support share links yet")
  })

  test("other failures surface the server's message", async () => {
    stubClipboard()
    const client = {
      endpoint: "https://api.example",
      createShare: async () => {
        throw new Error("File not found: /a.md")
      },
    } as any
    expect(await copyShareLink(client, "org", "drive", "/a.md")).toBe(false)
    const shown = toasts.at(-1)!
    expect(shown.message).toBe("Couldn't create a share link")
    expect(shown.description).toBe("File not found: /a.md")
  })
})

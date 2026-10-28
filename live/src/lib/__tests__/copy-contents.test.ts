import { describe, expect, test } from "bun:test"
import {
  MAX_COPY_BYTES,
  copyBlockMessage,
  copyability,
  isTextLike,
  writeClipboardText,
} from "../copy-contents"

describe("isTextLike", () => {
  test("text-like content types", () => {
    for (const type of [
      "text/plain",
      "text/markdown; charset=utf-8",
      "application/json",
      "application/ld+json",
      "application/xml",
      "application/yaml",
      "application/x-yaml",
      "application/javascript",
      "application/typescript",
      "image/svg+xml",
      "application/toml",
    ]) {
      expect(isTextLike("/file", type)).toBe(true)
    }
  })

  test("binary content types", () => {
    for (const type of ["image/png", "application/pdf", "application/zip", "video/mp4", "audio/mpeg"]) {
      expect(isTextLike("/file", type)).toBe(false)
    }
  })

  test("a known text or code extension wins over the stored type", () => {
    expect(isTextLike("/src/app.ts", "video/mp2t")).toBe(true)
    expect(isTextLike("/notes.md", "application/octet-stream")).toBe(true)
    expect(isTextLike("/logo.svg", undefined)).toBe(true)
    expect(isTextLike("/repo/Dockerfile", undefined)).toBe(true)
  })

  test("an unknown extension with a generic or missing type is not text", () => {
    expect(isTextLike("/blob.dat", "application/octet-stream")).toBe(false)
    expect(isTextLike("/blob.dat", undefined)).toBe(false)
    expect(isTextLike("/photo.png", "image/png")).toBe(false)
  })
})

describe("copyability", () => {
  test("pending until the stat loads", () => {
    expect(copyability("/a.md")).toEqual({ ok: false, reason: "pending" })
  })

  test("text at or under 1 MB is copyable", () => {
    expect(copyability("/a.md", { size: 0, contentType: "text/markdown" })).toEqual({ ok: true })
    expect(copyability("/a.md", { size: MAX_COPY_BYTES, contentType: "text/markdown" })).toEqual({ ok: true })
  })

  test("text over 1 MB is too large", () => {
    expect(copyability("/a.json", { size: MAX_COPY_BYTES + 1, contentType: "application/json" }))
      .toEqual({ ok: false, reason: "too-large" })
  })

  test("a binary type is blocked by type, whatever its size", () => {
    expect(copyability("/a.png", { size: 10, contentType: "image/png" })).toEqual({ ok: false, reason: "type" })
    expect(copyability("/a.zip", { size: MAX_COPY_BYTES * 50, contentType: "application/zip" }))
      .toEqual({ ok: false, reason: "type" })
  })

  test("messages", () => {
    expect(copyBlockMessage("too-large")).toBe("Too large to copy")
    expect(copyBlockMessage("type")).toBe("Can't copy this file type")
    expect(copyBlockMessage("pending")).toBeNull()
  })
})

class FakeClipboardItem {
  constructor(readonly items: Record<string, Promise<Blob>>) {}
}

function fakeClipboard(opts: { write?: boolean; writeRejects?: boolean } = {}) {
  const calls: string[] = []
  let written: string | null = null
  const clipboard = {
    writeText: async (text: string) => {
      calls.push("writeText")
      written = text
    },
    write: opts.write === false
      ? undefined
      : async (items: ClipboardItem[]) => {
          calls.push("write")
          if (opts.writeRejects) throw new DOMException("not allowed", "NotAllowedError")
          const blob = await (items[0] as unknown as FakeClipboardItem).items["text/plain"]
          written = await blob.text()
        },
  }
  return { clipboard, calls, written: () => written }
}

const Item = FakeClipboardItem as unknown as new (items: Record<string, Promise<Blob>>) => ClipboardItem

describe("writeClipboardText", () => {
  test("hands the clipboard a pending item before the text resolves", async () => {
    const { clipboard, calls, written } = fakeClipboard()
    let resolve!: (text: string) => void
    const pending = writeClipboardText(new Promise((r) => { resolve = r }), clipboard, Item)
    // The write starts synchronously, inside the click, with the text still loading.
    expect(calls).toEqual(["write"])
    resolve("hello")
    await pending
    expect(written()).toBe("hello")
    expect(calls).toEqual(["write"])
  })

  test("falls back to writeText without ClipboardItem", async () => {
    const { clipboard, calls, written } = fakeClipboard()
    await writeClipboardText(Promise.resolve("plain"), clipboard, undefined)
    expect(calls).toEqual(["writeText"])
    expect(written()).toBe("plain")
  })

  test("falls back to writeText when clipboard.write is missing", async () => {
    const { clipboard, calls, written } = fakeClipboard({ write: false })
    await writeClipboardText(Promise.resolve("plain"), clipboard, Item)
    expect(calls).toEqual(["writeText"])
    expect(written()).toBe("plain")
  })

  test("falls back to writeText when clipboard.write rejects", async () => {
    const { clipboard, calls, written } = fakeClipboard({ writeRejects: true })
    await writeClipboardText(Promise.resolve("retry"), clipboard, Item)
    expect(calls).toEqual(["write", "writeText"])
    expect(written()).toBe("retry")
  })

  test("a failed load rejects and writes nothing", async () => {
    const { clipboard, written } = fakeClipboard()
    await expect(writeClipboardText(Promise.reject(new Error("fetch failed")), clipboard, Item)).rejects.toThrow("fetch failed")
    expect(written()).toBeNull()
  })
})

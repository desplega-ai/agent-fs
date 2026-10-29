import { describe, expect, test } from "bun:test"
import {
  MAX_COPY_BYTES,
  TooLargeToCopyError,
  copyBlockMessage,
  copyFileText,
  copyability,
  isTextLike,
  writeClipboardText,
} from "../copy-contents"
import { loadFileContent } from "../file-content-cache"

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

describe("copyFileText", () => {
  // The stat the button was enabled on: a small text file, no ETag, so the click downloads.
  const smallStat = { size: 40, contentType: "text/markdown", etag: undefined }
  const grown = "x".repeat(2 * 1024 * 1024)

  // The hook's path: stat says small, the download returns what the file is now.
  const clickCopy = (body: string, clipboard: Parameters<typeof copyFileText>[1], item?: typeof Item) => {
    expect(copyability("/notes.md", smallStat)).toEqual({ ok: true })
    const text = loadFileContent(undefined, smallStat, async () => ({ text: body, etag: null })).then((e) => e.content)
    return copyFileText(text, clipboard, item)
  }

  test("a file that grew past 1 MB after its stat writes nothing (ClipboardItem path)", async () => {
    const { clipboard, calls, written } = fakeClipboard()
    const copy = clickCopy(grown, clipboard, Item)
    // Still handed to the clipboard inside the click.
    expect(calls).toEqual(["write"])
    await expect(copy).rejects.toBeInstanceOf(TooLargeToCopyError)
    expect(written()).toBeNull()
  })

  test("a file that grew past 1 MB after its stat writes nothing (writeText fallback)", async () => {
    const { clipboard, calls, written } = fakeClipboard()
    await expect(clickCopy(grown, clipboard, undefined)).rejects.toBeInstanceOf(TooLargeToCopyError)
    expect(calls).toEqual([])
    expect(written()).toBeNull()
  })

  test("the limit counts UTF-8 bytes, not characters", async () => {
    const { clipboard, written } = fakeClipboard()
    const wide = "é".repeat(MAX_COPY_BYTES / 2 + 1)
    expect(wide.length).toBeLessThan(MAX_COPY_BYTES)
    await expect(clickCopy(wide, clipboard, Item)).rejects.toBeInstanceOf(TooLargeToCopyError)
    expect(written()).toBeNull()
  })

  test("text at exactly 1 MB is copied", async () => {
    const { clipboard, written } = fakeClipboard()
    const atLimit = "y".repeat(MAX_COPY_BYTES)
    await clickCopy(atLimit, clipboard, Item)
    expect(written()).toBe(atLimit)
  })
})

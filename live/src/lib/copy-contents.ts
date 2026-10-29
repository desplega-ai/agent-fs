import type { StatResult } from "@/api/types"

/** Extensions the viewers render as text or code, whatever content type was stored. */
export const TEXT_EXTS = new Set([
  "txt", "ts", "tsx", "js", "jsx", "json", "jsonl", "ndjson", "md", "mdx", "css", "scss",
  "html", "htm", "xml", "yaml", "yml", "toml", "sh", "bash", "py", "rb", "rs",
  "go", "java", "c", "cpp", "h", "hpp", "sql", "graphql", "env", "cfg",
  "ini", "conf", "log", "csv", "tsv", "dockerfile", "makefile", "lock",
])

/** Largest file whose contents the copy button puts on the clipboard. */
export const MAX_COPY_BYTES = 1024 * 1024

export type CopyBlockReason = "pending" | "too-large" | "type"

export type Copyability = { ok: true } | { ok: false; reason: CopyBlockReason }

const TEXT_TYPE_HINTS = ["json", "xml", "yaml", "javascript", "typescript", "markdown", "toml", "svg"]

/**
 * Whether the file reads as text: a known text/code extension, or a text-like
 * content type. A `.ts` file stored as `video/mp2t` is still code, and a file
 * with an unknown extension stored as `application/octet-stream` is not text.
 */
export function isTextLike(path: string, contentType?: string): boolean {
  const name = path.split("/").pop()?.toLowerCase() ?? ""
  const ext = name.split(".").pop() ?? ""
  if (TEXT_EXTS.has(ext) || ext === "svg") return true
  const type = contentType?.split(";")[0].trim().toLowerCase()
  if (!type) return false
  return type.startsWith("text/") || TEXT_TYPE_HINTS.some((hint) => type.includes(hint))
}

/**
 * Decides from metadata alone, before any download, whether the copy button
 * may copy the file's contents. `pending` while the stat has not loaded.
 */
export function copyability(path: string, stat?: Pick<StatResult, "size" | "contentType">): Copyability {
  if (!stat) return { ok: false, reason: "pending" }
  if (!isTextLike(path, stat.contentType)) return { ok: false, reason: "type" }
  if (stat.size > MAX_COPY_BYTES) return { ok: false, reason: "too-large" }
  return { ok: true }
}

/** What the copy popover says when a file's contents cannot be copied. */
export function copyBlockMessage(reason: CopyBlockReason): string | null {
  if (reason === "too-large") return "Too large to copy"
  if (reason === "type") return "Can't copy this file type"
  return null
}

type ClipboardLike = Pick<Clipboard, "writeText"> & Partial<Pick<Clipboard, "write">>
type ClipboardItemCtor = new (items: Record<string, Promise<Blob>>) => ClipboardItem

/**
 * Puts text that is still loading on the clipboard. Safari only honours a
 * clipboard write started inside the click, so the write is handed a pending
 * `ClipboardItem` synchronously and the text fills it in later. Browsers
 * without promise-valued `ClipboardItem`s fall back to `writeText` once the
 * text is ready.
 */
export async function writeClipboardText(
  text: Promise<string>,
  clipboard: ClipboardLike = navigator.clipboard,
  Item: ClipboardItemCtor | undefined = globalThis.ClipboardItem,
): Promise<void> {
  if (Item && clipboard.write) {
    try {
      const blob = text.then((value) => new Blob([value], { type: "text/plain" }))
      await clipboard.write([new Item({ "text/plain": blob })])
      return
    } catch {
      // Fall through: a failed load rejects again below, with its own error.
    }
  }
  await clipboard.writeText(await text)
}

/** The text downloaded for a copy is over `MAX_COPY_BYTES`, whatever the stat said. */
export class TooLargeToCopyError extends Error {
  constructor(readonly bytes: number) {
    super("Too large to copy")
    this.name = "TooLargeToCopyError"
  }
}

/**
 * Copies a file's text once it loads, refusing text over `MAX_COPY_BYTES`.
 * The stat that enabled the button can be stale: the file may have grown
 * since. The limit is checked on the bytes actually loaded, before the
 * clipboard sees them; over it, nothing is written and the promise rejects
 * with `TooLargeToCopyError`. Synchronous up to the clipboard write, like
 * `writeClipboardText`.
 */
export function copyFileText(
  text: Promise<string>,
  clipboard?: ClipboardLike,
  Item?: ClipboardItemCtor,
): Promise<void> {
  const checked = text.then((value) => {
    const bytes = new Blob([value]).size
    if (bytes > MAX_COPY_BYTES) throw new TooLargeToCopyError(bytes)
    return value
  })
  return writeClipboardText(checked, clipboard, Item)
}

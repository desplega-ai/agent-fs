/**
 * The parent side of the HTML preview's comment overlay (the server's
 * `html-comment-overlay.ts`). The page runs in an opaque origin, so
 * `postMessage` is the only channel, and anything in the frame, including the
 * page's own scripts, can post. Messages are accepted only from the frame's
 * window, checked field by field and size-capped. The page can only propose a
 * selection: comments are typed and sent here. Posts use targetOrigin "*"
 * (the only one an opaque origin matches), so nothing sent carries comment
 * bodies, authors or credentials.
 */

const PREFIX = "agent-fs-comments:"
/** Longest page text accepted, in chars. */
export const MAX_FRAME_TEXT = 2 * 1024 * 1024
const MAX_ID = 200

export interface FrameRect { left: number; top: number; width: number; height: number }

export type FrameMessage =
  | { type: "hello"; path: string }
  | { type: "text"; text: string }
  | { type: "selection"; start: number; end: number; rect: FrameRect }
  | { type: "selection"; cleared: true }
  | { type: "activate"; id: string }
  | { type: "hover"; id: string | null }

export interface HighlightRange { id: string; start: number; end: number; state: "anchored" | "moved" | "active" }

export type HostMessage =
  | { type: "host" }
  | { type: "highlights"; ranges: HighlightRange[] }
  | { type: "reveal"; id: string }

const isOffset = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0 && n <= MAX_FRAME_TEXT
const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n)
const isId = (s: unknown): s is string => typeof s === "string" && s.length > 0 && s.length <= MAX_ID

/** A well-formed overlay message, or null for anything else. */
export function parseFrameMessage(data: unknown): FrameMessage | null {
  if (!data || typeof data !== "object") return null
  const d = data as Record<string, unknown>
  if (d.v !== 1 || typeof d.type !== "string" || !d.type.startsWith(PREFIX)) return null
  switch (d.type.slice(PREFIX.length)) {
    case "hello":
      return typeof d.path === "string" && d.path.length <= 4096 ? { type: "hello", path: d.path } : null
    case "text":
      return typeof d.text === "string" && d.text.length <= MAX_FRAME_TEXT ? { type: "text", text: d.text } : null
    case "selection": {
      if (d.cleared === true) return { type: "selection", cleared: true }
      const r = d.rect as Record<string, unknown> | null
      if (!isOffset(d.start) || !isOffset(d.end) || d.end <= d.start || !r || typeof r !== "object") return null
      if (![r.left, r.top, r.width, r.height].every(isNum)) return null
      return { type: "selection", start: d.start, end: d.end, rect: { left: r.left as number, top: r.top as number, width: r.width as number, height: r.height as number } }
    }
    case "activate":
      return isId(d.id) ? { type: "activate", id: d.id } : null
    case "hover":
      return d.id === null || isId(d.id) ? { type: "hover", id: d.id } : null
    default:
      return null
  }
}

export interface HtmlCommentBridge {
  post(msg: HostMessage): void
  dispose(): void
}

type MessageTarget = Pick<Window, "addEventListener" | "removeEventListener">

/**
 * Listen to the overlay in `frame`. `path` is the pathname of the page the
 * frame was given: a `hello` from any other page (the frame navigated) turns
 * the bridge off until the right page says hello again. Until then nothing but
 * `hello` is delivered. Page text is delivered at most once a frame.
 */
export function createHtmlCommentBridge(
  frame: { readonly contentWindow: Window | null },
  path: string,
  onMessage: (msg: FrameMessage) => void,
  win: MessageTarget = window,
): HtmlCommentBridge {
  let hosted = false
  let pendingText: string | null = null
  let disposed = false
  const schedule = globalThis.requestAnimationFrame?.bind(globalThis) ?? ((cb: () => void) => setTimeout(cb, 16))

  const post = (msg: HostMessage) => {
    if (msg.type !== "host" && !hosted) return
    frame.contentWindow?.postMessage({ ...msg, type: PREFIX + msg.type, v: 1 }, "*")
  }

  const listener = (event: Event) => {
    const e = event as MessageEvent
    if (!frame.contentWindow || e.source !== frame.contentWindow) return
    const msg = parseFrameMessage(e.data)
    if (!msg) return
    if (msg.type === "hello") {
      hosted = msg.path === path
      if (hosted) post({ type: "host" })
      // Another page in the frame: drop any selection it proposed.
      else onMessage({ type: "selection", cleared: true })
      return
    }
    if (!hosted) return
    if (msg.type !== "text") return onMessage(msg)
    if (pendingText === null) {
      schedule(() => {
        const text = pendingText
        pendingText = null
        if (!disposed && hosted && text !== null) onMessage({ type: "text", text })
      })
    }
    pendingText = msg.text
  }

  win.addEventListener("message", listener)
  return {
    post,
    dispose() {
      disposed = true
      win.removeEventListener("message", listener)
    },
  }
}

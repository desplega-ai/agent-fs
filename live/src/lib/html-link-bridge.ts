/**
 * The parent side of the link handler the server adds to a site page in a
 * frame (the server's `html-link-handler.ts`). The page's sandbox keeps a
 * link from leaving the frame, so the page posts the address of a link that
 * leaves its shared folder here instead. Only messages from the frame's own
 * window count, and anything in it, including the page's own scripts, can
 * post: an address on this app's file, detail or present view opens in the
 * app, any other http(s) address in a new tab, as a `target="_blank"` link
 * would. Other schemes are dropped.
 */

const PREFIX = "agent-fs-links:"
const APP_VIEWS = /^\/(file|detail|page)\//

export type FrameLink = { route: string } | { open: string }

/** Where an address from the page goes, or null when it is not an http(s) URL. */
export function frameLinkTarget(href: unknown, appOrigin: string): FrameLink | null {
  if (typeof href !== "string") return null
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return null
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null
  if (url.origin === appOrigin && APP_VIEWS.test(url.pathname)) return { route: url.pathname + url.search + url.hash }
  return { open: url.href }
}

interface FrameLinkActions {
  route(to: string): void
  open(href: string): void
}

type MessageTarget = Pick<Window, "addEventListener" | "removeEventListener" | "location">

/**
 * Answer the handler in the frame and act on its links. `frameWindow` is read
 * at each message, so the listener follows a frame that is replaced. Returns
 * the cleanup.
 */
export function listenForFrameLinks(
  frameWindow: () => Window | null | undefined,
  actions: FrameLinkActions,
  win: MessageTarget = window,
): () => void {
  const listener = (event: Event) => {
    const e = event as MessageEvent
    const frame = frameWindow()
    if (!frame || e.source !== frame) return
    const d = e.data as Record<string, unknown> | null
    if (!d || typeof d !== "object" || d.v !== 1) return
    if (d.type === `${PREFIX}hello`) return frame.postMessage({ type: `${PREFIX}host`, v: 1 }, "*")
    if (d.type !== `${PREFIX}navigate`) return
    const link = frameLinkTarget(d.href, win.location.origin)
    if (!link) return
    if ("route" in link) actions.route(link.route)
    else actions.open(link.open)
  }
  win.addEventListener("message", listener)
  return () => win.removeEventListener("message", listener)
}

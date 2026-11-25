/**
 * The parent side of the link handler the server adds to a site page in a
 * frame (the server's `html-link-handler.ts`). The page's sandbox keeps a
 * link from leaving the frame, so the page posts the address of a link that
 * leaves its shared folder here instead: an address on this app's file,
 * detail or present view opens in the app, any other http(s) address in a new
 * tab, as a `target="_blank"` link would. Other schemes are dropped.
 *
 * The frame's window survives its page navigating elsewhere, so only a page
 * that names the frame's share path in its hello gets a nonce, and each
 * address must carry the latest one. The page's own scripts can still post.
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

/**
 * The share path, `/site/<token>/`, of the viewer's frame address
 * `<endpoint>/site/<token>/<file>`, or null for any other address.
 */
export function sharePathOf(src: string): string | null {
  let pathname: string
  try {
    pathname = new URL(src).pathname
  } catch {
    return null
  }
  return pathname.slice(0, pathname.lastIndexOf("/") + 1).match(/\/site\/[^/]+\/$/)?.[0] ?? null
}

/** 128 random bits. `getRandomValues` also works on a plain-HTTP host, where `randomUUID` does not. */
const newNonce = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("")

interface FrameLinkActions {
  route(to: string): void
  open(href: string): void
}

type MessageTarget = Pick<Window, "addEventListener" | "removeEventListener" | "location">
type Frame = Pick<HTMLIFrameElement, "contentWindow" | "src">

/**
 * Answer the handler in the frame and act on its links. `frame` is read at
 * each message, so the listener follows a frame that is replaced. Returns the
 * cleanup.
 */
export function listenForFrameLinks(
  frame: () => Frame | null | undefined,
  actions: FrameLinkActions,
  win: MessageTarget = window,
): () => void {
  let nonce: string | null = null
  const listener = (event: Event) => {
    const e = event as MessageEvent
    const el = frame()
    const w = el?.contentWindow
    if (!el || !w || e.source !== w) return
    const d = e.data as Record<string, unknown> | null
    if (!d || typeof d !== "object" || d.v !== 1) return
    if (d.type === `${PREFIX}hello`) {
      const share = sharePathOf(el.src)
      nonce = share !== null && d.root === share ? newNonce() : null
      if (nonce) w.postMessage({ type: `${PREFIX}host`, v: 1, nonce }, "*")
      return
    }
    if (d.type !== `${PREFIX}navigate` || nonce === null || d.nonce !== nonce) return
    const link = frameLinkTarget(d.href, win.location.origin)
    if (!link) return
    if ("route" in link) actions.route(link.route)
    else actions.open(link.open)
  }
  win.addEventListener("message", listener)
  return () => win.removeEventListener("message", listener)
}

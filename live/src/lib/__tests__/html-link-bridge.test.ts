import { describe, expect, test } from "bun:test"
import { frameLinkTarget, listenForFrameLinks, sharePathOf } from "../html-link-bridge"

const P = "agent-fs-links:"
const APP = "https://docs.example.test"
const API = "https://api.example.test/fs"
const SHARE = "/site/tok_A-1/"

describe("frameLinkTarget", () => {
  test("opens this app's file, detail and present views in the app, any org and drive", () => {
    expect(frameLinkTarget(`${APP}/file/acme/work/notes/plan.md`, APP)).toEqual({ route: "/file/acme/work/notes/plan.md" })
    expect(frameLinkTarget(`${APP}/file/~/o1/d2/a%20b.html?edit=1#screen=home`, APP)).toEqual({ route: "/file/~/o1/d2/a%20b.html?edit=1#screen=home" })
    expect(frameLinkTarget(`${APP}/detail/acme/context/x.md`, APP)).toEqual({ route: "/detail/acme/context/x.md" })
    expect(frameLinkTarget(`${APP}/page/acme/work/slides.html`, APP)).toEqual({ route: "/page/acme/work/slides.html" })
  })

  test("opens every other http(s) address in a new tab", () => {
    for (const href of [
      "https://linear.app/acme/issue/ENG-1",
      "http://example.test/a?b=1#c",
      `${APP}/fs/site/tok/other.html`, // another site share, or a path out of this one
      `${APP}/keys`,
      `${APP}/files`,
      `${APP}/filex/acme/work/a.md`,
      "https://docs.other.test/file/acme/work/a.md", // the same path on another origin
      `${APP.replace("https:", "http:")}/file/acme/work/a.md`, // the same host without TLS
    ]) {
      expect(frameLinkTarget(href, APP), href).toEqual({ open: new URL(href).href })
    }
  })

  test("drops anything that is not an absolute http(s) URL", () => {
    for (const href of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      " javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "blob:https://docs.example.test/123",
      "mailto:a@example.test",
      "file:///etc/passwd",
      "vbscript:x",
      "/file/acme/work/a.md",
      "//evil.test/x",
      "",
      "not a url",
      null,
      undefined,
      42,
      { href: `${APP}/file/a/b/c` },
    ]) {
      expect(frameLinkTarget(href, APP), String(href)).toBeNull()
    }
  })
})

describe("sharePathOf", () => {
  test("is the share path of the viewer's frame address", () => {
    expect(sharePathOf(`${API}${SHARE}page.html`)).toBe(SHARE)
    expect(sharePathOf(`https://api.example.test${SHARE}a%20b.html?__afs_comments=1#screen=home`)).toBe(SHARE)
  })

  test("is null for any other address", () => {
    for (const src of ["", "about:blank", "not a url", `${API}/site/tok/`.slice(0, -1), `${API}${SHARE}sub/page.html`, `${API}/file/a/b.html`]) {
      expect(sharePathOf(src), src).toBeNull()
    }
  })
})

type FakeWindow = Window & { posted: Record<string, unknown>[] }
const fakeWindow = () => {
  const posted: Record<string, unknown>[] = []
  return { posted, postMessage: (m: Record<string, unknown>) => posted.push(m) } as unknown as FakeWindow
}

function harness() {
  const listeners = new Set<(e: Event) => void>()
  const win = {
    location: { origin: APP },
    addEventListener: (_: string, l: (e: Event) => void) => listeners.add(l),
    removeEventListener: (_: string, l: (e: Event) => void) => listeners.delete(l),
  } as unknown as Window
  let frame: { contentWindow: FakeWindow | null; src: string } | null = { contentWindow: fakeWindow(), src: `${API}${SHARE}page.html` }
  const routed: string[] = []
  const opened: string[] = []
  const stop = listenForFrameLinks(() => frame, { route: (to) => routed.push(to), open: (href) => opened.push(href) }, win)
  const send = (data: unknown, source: unknown = frame?.contentWindow) =>
    listeners.forEach((l) => l({ data, source } as unknown as Event))
  /** Says hello as the page of this share does, and returns the nonce it got. */
  const hello = (source: FakeWindow | null | undefined = frame?.contentWindow) => {
    const before = source?.posted.length ?? 0
    send({ type: `${P}hello`, v: 1, root: SHARE }, source)
    const reply = source?.posted[before]
    expect(reply).toEqual({ type: `${P}host`, v: 1, nonce: expect.any(String) })
    return reply!.nonce as string
  }
  const nav = (href: string, nonce: unknown, source?: unknown) => send({ type: `${P}navigate`, v: 1, href, nonce }, source)
  const posted = () => frame?.contentWindow?.posted ?? []
  const setFrame = (f: typeof frame) => { frame = f }
  return { stop, send, hello, nav, posted, routed, opened, listeners, frame: () => frame, setFrame }
}

describe("listenForFrameLinks", () => {
  test("answers a hello that names the frame's share with host and a fresh nonce", () => {
    const h = harness()
    const first = h.hello()
    const second = h.hello()
    expect(first).toMatch(/^[0-9a-f]{32}$/)
    expect(second).toMatch(/^[0-9a-f]{32}$/)
    expect(second).not.toBe(first)
  })

  test("routes app addresses and opens the rest, with the current nonce", () => {
    const h = harness()
    const nonce = h.hello()
    h.nav(`${APP}/file/acme/context/a.md#x`, nonce)
    h.nav("https://linear.app/acme/issue/ENG-1", nonce)
    expect(h.routed).toEqual(["/file/acme/context/a.md#x"])
    expect(h.opened).toEqual(["https://linear.app/acme/issue/ENG-1"])
  })

  test("ignores addresses without the current nonce", () => {
    const h = harness()
    for (const nonce of [undefined, null, "", "guess", 1]) h.nav(`${APP}/file/a/b/c.md`, nonce)
    const nonce = h.hello()
    for (const other of [undefined, null, "", "guess", nonce.toUpperCase(), { nonce }]) {
      h.nav(`${APP}/file/a/b/c.md`, other)
      h.nav("https://example.test/", other)
    }
    expect(h.routed).toEqual([])
    expect(h.opened).toEqual([])
  })

  test("a page the frame navigated to elsewhere gets no nonce and cannot use the last one", () => {
    const h = harness()
    const nonce = h.hello()
    // The same window now holds a page that does not know the share path.
    const sent = h.posted().length
    for (const root of [undefined, "/", "/site/", "/site/guess/", `${API}${SHARE}`, SHARE.slice(0, -1)]) {
      h.send({ type: `${P}hello`, v: 1, root })
      h.nav(`${APP}/file/a/b/c.md`, undefined)
      h.nav("https://example.test/", "guess")
    }
    // Its hello also ends the nonce of the page before it.
    h.nav(`${APP}/file/a/b/c.md`, nonce)
    expect(h.posted().length).toBe(sent)
    expect(h.routed).toEqual([])
    expect(h.opened).toEqual([])
  })

  test("a same-folder page gets a fresh nonce, and the earlier one stops working", () => {
    const h = harness()
    const first = h.hello()
    const second = h.hello()
    h.nav(`${APP}/file/a/b/old.md`, first)
    h.nav(`${APP}/file/a/b/new.md`, second)
    expect(h.routed).toEqual(["/file/a/b/new.md"])
  })

  test("acts only on messages from the frame's own window", () => {
    const h = harness()
    const nonce = h.hello()
    const other = fakeWindow()
    for (const source of [null, other, {}]) {
      h.send({ type: `${P}hello`, v: 1, root: SHARE }, source)
      h.nav(`${APP}/file/a/b/c.md`, nonce, source)
      h.nav("https://example.test/", nonce, source)
    }
    // No frame (still loading, or gone): nothing is its window.
    h.setFrame(null)
    h.nav(`${APP}/file/a/b/c.md`, nonce, null)
    expect(other.posted).toEqual([])
    expect(h.routed).toEqual([])
    expect(h.opened).toEqual([])
  })

  test("follows a replaced frame", () => {
    const h = harness()
    const oldWindow = h.frame()!.contentWindow
    const oldNonce = h.hello()
    h.setFrame({ contentWindow: fakeWindow(), src: `${API}/site/tok_B/page.html` })
    h.nav(`${APP}/file/a/b/old.md`, oldNonce, oldWindow)
    // The new frame's share, not the old one's.
    h.send({ type: `${P}hello`, v: 1, root: SHARE })
    expect(h.posted()).toEqual([])
    h.send({ type: `${P}hello`, v: 1, root: "/site/tok_B/" })
    const nonce = h.posted()[0]?.nonce
    h.nav(`${APP}/file/a/b/new.md`, nonce)
    expect(h.routed).toEqual(["/file/a/b/new.md"])
  })

  test("drops malformed messages, other versions and schemes", () => {
    const h = harness()
    const nonce = h.hello()
    for (const data of [
      null,
      "agent-fs-links:navigate",
      { type: `${P}hello`, root: SHARE },
      { type: `${P}hello`, v: 2, root: SHARE },
      { type: `${P}navigate`, href: `${APP}/file/a/b/c.md`, nonce },
      { type: `${P}navigate`, v: 2, href: `${APP}/file/a/b/c.md`, nonce },
      { type: "agent-fs-comments:navigate", v: 1, href: `${APP}/file/a/b/c.md`, nonce },
      { type: `${P}open`, v: 1, href: "https://example.test/", nonce },
      { type: `${P}navigate`, v: 1, nonce },
      { type: `${P}navigate`, v: 1, href: "javascript:alert(1)", nonce },
      { type: `${P}navigate`, v: 1, href: "data:text/html,x", nonce },
      { type: `${P}navigate`, v: 1, href: "/file/a/b/c.md", nonce },
    ]) h.send(data)
    expect(h.posted()).toHaveLength(1)
    expect(h.routed).toEqual([])
    expect(h.opened).toEqual([])
  })

  test("stops after cleanup", () => {
    const h = harness()
    h.stop()
    expect(h.listeners.size).toBe(0)
  })
})

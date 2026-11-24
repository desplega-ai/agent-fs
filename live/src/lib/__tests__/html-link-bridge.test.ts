import { describe, expect, test } from "bun:test"
import { frameLinkTarget, listenForFrameLinks } from "../html-link-bridge"

const P = "agent-fs-links:"
const APP = "https://docs.example.test"

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

function harness() {
  const listeners = new Set<(e: Event) => void>()
  const win = {
    location: { origin: APP },
    addEventListener: (_: string, l: (e: Event) => void) => listeners.add(l),
    removeEventListener: (_: string, l: (e: Event) => void) => listeners.delete(l),
  } as unknown as Window
  const posted: unknown[] = []
  let frameWindow: Window | null = { postMessage: (m: unknown) => posted.push(m) } as unknown as Window
  const routed: string[] = []
  const opened: string[] = []
  const stop = listenForFrameLinks(() => frameWindow, { route: (to) => routed.push(to), open: (href) => opened.push(href) }, win)
  const send = (data: unknown, source: unknown = frameWindow) =>
    listeners.forEach((l) => l({ data, source } as unknown as Event))
  const setFrame = (w: Window | null) => { frameWindow = w }
  return { stop, send, posted, routed, opened, listeners, frame: () => frameWindow, setFrame }
}

describe("listenForFrameLinks", () => {
  test("answers the frame's hello with host", () => {
    const h = harness()
    h.send({ type: `${P}hello`, v: 1 })
    expect(h.posted).toEqual([{ type: `${P}host`, v: 1 }])
  })

  test("routes app addresses and opens the rest", () => {
    const h = harness()
    h.send({ type: `${P}navigate`, v: 1, href: `${APP}/file/acme/context/a.md#x` })
    h.send({ type: `${P}navigate`, v: 1, href: "https://linear.app/acme/issue/ENG-1" })
    expect(h.routed).toEqual(["/file/acme/context/a.md#x"])
    expect(h.opened).toEqual(["https://linear.app/acme/issue/ENG-1"])
  })

  test("acts only on messages from the frame's own window", () => {
    const h = harness()
    const other = { postMessage: () => {} } as unknown as Window
    for (const source of [null, other, {}]) {
      h.send({ type: `${P}hello`, v: 1 }, source)
      h.send({ type: `${P}navigate`, v: 1, href: `${APP}/file/a/b/c.md` }, source)
      h.send({ type: `${P}navigate`, v: 1, href: "https://example.test/" }, source)
    }
    // No frame (still loading, or gone): nothing is its window.
    h.setFrame(null)
    h.send({ type: `${P}navigate`, v: 1, href: `${APP}/file/a/b/c.md` }, null)
    expect(h.posted).toEqual([])
    expect(h.routed).toEqual([])
    expect(h.opened).toEqual([])
  })

  test("follows a replaced frame", () => {
    const h = harness()
    const old = h.frame()
    const posted: unknown[] = []
    const next = { postMessage: (m: unknown) => posted.push(m) } as unknown as Window
    h.setFrame(next)
    h.send({ type: `${P}navigate`, v: 1, href: `${APP}/file/a/b/old.md` }, old)
    h.send({ type: `${P}hello`, v: 1 }, next)
    h.send({ type: `${P}navigate`, v: 1, href: `${APP}/file/a/b/new.md` }, next)
    expect(posted).toEqual([{ type: `${P}host`, v: 1 }])
    expect(h.routed).toEqual(["/file/a/b/new.md"])
  })

  test("drops malformed messages, other versions and schemes", () => {
    const h = harness()
    for (const data of [
      null,
      "agent-fs-links:navigate",
      { type: `${P}navigate`, href: `${APP}/file/a/b/c.md` },
      { type: `${P}navigate`, v: 2, href: `${APP}/file/a/b/c.md` },
      { type: "agent-fs-comments:navigate", v: 1, href: `${APP}/file/a/b/c.md` },
      { type: `${P}open`, v: 1, href: "https://example.test/" },
      { type: `${P}navigate`, v: 1 },
      { type: `${P}navigate`, v: 1, href: "javascript:alert(1)" },
      { type: `${P}navigate`, v: 1, href: "data:text/html,x" },
      { type: `${P}navigate`, v: 1, href: "/file/a/b/c.md" },
    ]) h.send(data)
    expect(h.posted).toEqual([])
    expect(h.routed).toEqual([])
    expect(h.opened).toEqual([])
  })

  test("stops after cleanup", () => {
    const h = harness()
    h.stop()
    expect(h.listeners.size).toBe(0)
  })
})

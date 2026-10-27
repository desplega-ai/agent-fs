import { describe, expect, test } from "bun:test"
import { createHtmlCommentBridge, MAX_FRAME_TEXT, parseFrameMessage, type FrameMessage } from "../html-comment-bridge"

const P = "agent-fs-comments:"

describe("parseFrameMessage", () => {
  test("accepts each well-formed message", () => {
    expect(parseFrameMessage({ type: `${P}hello`, v: 1, path: "/site/t/a.html" })).toEqual({ type: "hello", path: "/site/t/a.html" })
    expect(parseFrameMessage({ type: `${P}text`, v: 1, text: "hi" })).toEqual({ type: "text", text: "hi" })
    expect(parseFrameMessage({ type: `${P}selection`, v: 1, cleared: true })).toEqual({ type: "selection", cleared: true })
    expect(parseFrameMessage({ type: `${P}selection`, v: 1, start: 1, end: 3, rect: { left: 1, top: 2, width: 3, height: 4 }, extra: "x" }))
      .toEqual({ type: "selection", start: 1, end: 3, rect: { left: 1, top: 2, width: 3, height: 4 } })
    expect(parseFrameMessage({ type: `${P}activate`, v: 1, id: "c1" })).toEqual({ type: "activate", id: "c1" })
    expect(parseFrameMessage({ type: `${P}hover`, v: 1, id: null })).toEqual({ type: "hover", id: null })
  })

  test("rejects bad schema, versions, types and oversize text", () => {
    const bad: unknown[] = [
      null, "string", 42,
      { type: `${P}text`, text: "hi" },
      { type: `${P}text`, v: 2, text: "hi" },
      { type: "other:text", v: 1, text: "hi" },
      { type: `${P}create`, v: 1, body: "Approve" },
      { type: `${P}text`, v: 1, text: 5 },
      { type: `${P}text`, v: 1, text: "x".repeat(MAX_FRAME_TEXT + 1) },
      { type: `${P}selection`, v: 1, start: 3, end: 3, rect: { left: 0, top: 0, width: 0, height: 0 } },
      { type: `${P}selection`, v: 1, start: -1, end: 3, rect: { left: 0, top: 0, width: 0, height: 0 } },
      { type: `${P}selection`, v: 1, start: 0, end: 3, rect: { left: "0", top: 0, width: 0, height: 0 } },
      { type: `${P}selection`, v: 1, start: 0, end: 3 },
      { type: `${P}activate`, v: 1, id: "" },
      { type: `${P}activate`, v: 1, id: "x".repeat(201) },
      { type: `${P}hover`, v: 1, id: 7 },
    ]
    for (const data of bad) expect(parseFrameMessage(data)).toBeNull()
  })
})

function harness(path = "/site/t/a.html") {
  const listeners = new Set<(e: Event) => void>()
  const win = {
    addEventListener: (_: string, l: (e: Event) => void) => listeners.add(l),
    removeEventListener: (_: string, l: (e: Event) => void) => listeners.delete(l),
  } as unknown as Window
  const posted: unknown[] = []
  const frameWindow = { postMessage: (m: unknown) => posted.push(m) } as unknown as Window
  const received: FrameMessage[] = []
  const bridge = createHtmlCommentBridge({ contentWindow: frameWindow }, path, (m) => received.push(m), win)
  const send = (data: unknown, source: unknown = frameWindow) =>
    listeners.forEach((l) => l({ data, source } as unknown as Event))
  return { bridge, posted, received, send, listeners }
}

const frameTick = () => new Promise((r) => setTimeout(r, 40))

describe("createHtmlCommentBridge", () => {
  test("answers hello from its page with host, then delivers messages", async () => {
    const h = harness()
    h.bridge.post({ type: "highlights", ranges: [] })
    expect(h.posted).toEqual([]) // nothing before the handshake
    h.send({ type: `${P}activate`, v: 1, id: "c1" })
    expect(h.received).toEqual([])
    h.send({ type: `${P}hello`, v: 1, path: "/site/t/a.html" })
    expect(h.posted).toEqual([{ type: `${P}host`, v: 1 }])
    h.send({ type: `${P}activate`, v: 1, id: "c1" })
    h.send({ type: `${P}text`, v: 1, text: "one" })
    h.send({ type: `${P}text`, v: 1, text: "two" })
    await frameTick()
    expect(h.received).toEqual([{ type: "activate", id: "c1" }, { type: "text", text: "two" }])
  })

  test("ignores messages from any other window", () => {
    const h = harness()
    const other = {}
    h.send({ type: `${P}hello`, v: 1, path: "/site/t/a.html" }, other)
    h.send({ type: `${P}hello`, v: 1, path: "/site/t/a.html" }, null)
    expect(h.posted).toEqual([])
    h.send({ type: `${P}hello`, v: 1, path: "/site/t/a.html" })
    h.send({ type: `${P}selection`, v: 1, start: 0, end: 2, rect: { left: 0, top: 0, width: 1, height: 1 } }, other)
    expect(h.received).toEqual([])
  })

  test("a hello from another page turns it off", () => {
    const h = harness()
    h.send({ type: `${P}hello`, v: 1, path: "/site/t/a.html" })
    h.send({ type: `${P}hello`, v: 1, path: "/site/t/other.html" })
    expect(h.received).toEqual([{ type: "selection", cleared: true }])
    h.send({ type: `${P}activate`, v: 1, id: "c1" })
    h.bridge.post({ type: "reveal", id: "c1" })
    expect(h.received).toHaveLength(1)
    expect(h.posted).toHaveLength(1)
  })

  test("dispose stops listening", () => {
    const h = harness()
    h.bridge.dispose()
    expect(h.listeners.size).toBe(0)
  })
})

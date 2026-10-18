import { describe, expect, test } from "bun:test"
import { createSseParser, type SseFrame } from "../sse"

function collect() {
  const frames: SseFrame[] = []
  const comments: string[] = []
  const feed = createSseParser({ onFrame: (f) => frames.push(f), onComment: (c) => comments.push(c) })
  return { frames, comments, feed }
}

describe("createSseParser", () => {
  test("parses event + data frames, several per chunk", () => {
    const { frames, feed } = collect()
    feed('event: ready\ndata: {"driveId":"d"}\n\nevent: presence.left\ndata: {"sessionId":"s"}\n\n')
    expect(frames).toEqual([
      { event: "ready", data: '{"driveId":"d"}' },
      { event: "presence.left", data: '{"sessionId":"s"}' },
    ])
  })

  test("a frame split across chunks is emitted once it is complete", () => {
    const { frames, feed } = collect()
    feed("event: presence.upd")
    feed('ated\ndata: {"a"')
    expect(frames).toEqual([])
    feed(":1}\n")
    expect(frames).toEqual([])
    feed("\n")
    expect(frames).toEqual([{ event: "presence.updated", data: '{"a":1}' }])
  })

  test("`: ping` is a comment, not a frame", () => {
    const { frames, comments, feed } = collect()
    feed(": ping\n\n: ping\n\n")
    expect(frames).toEqual([])
    expect(comments).toEqual([" ping", " ping"])
  })

  test("multi-line data joins with newlines; no event name means `message`", () => {
    const { frames, feed } = collect()
    feed("data: line one\ndata:line two\ndata\n\n")
    expect(frames).toEqual([{ event: "message", data: "line one\nline two\n" }])
  })

  test("CRLF line endings", () => {
    const { frames, feed } = collect()
    feed("event: ready\r\ndata: {}\r\n\r\n")
    expect(frames).toEqual([{ event: "ready", data: "{}" }])
  })

  test("unknown fields and blank blocks are ignored", () => {
    const { frames, feed } = collect()
    feed("id: 7\nretry: 100\n\n\n\nevent: x\nid: 8\ndata: y\n\n")
    expect(frames).toEqual([{ event: "x", data: "y" }])
  })
})

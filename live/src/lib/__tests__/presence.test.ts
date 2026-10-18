import { describe, expect, test } from "bun:test"
import {
  PRESENCE_EXACT_MAX,
  caretQuote,
  colorSlot,
  createThrottle,
  docSessions,
  groupSessions,
  pointerAt,
  presenceName,
  resolvePointer,
  resolveSelection,
  selectionAt,
  slotColor,
  supportsPresence,
  userColor,
  type Timers,
} from "../presence"
import { sourceTextSpace } from "../comment-anchor"
import type { PresenceSession } from "@/api/types"

function session(over: Partial<PresenceSession>): PresenceSession {
  return {
    sessionId: "s1",
    userId: "u1",
    email: "u1@example.test",
    displayName: null,
    updatedAt: "2026-10-18T10:00:00.000Z",
    path: "notes.md",
    mode: "view",
    ...over,
  }
}

describe("supportsPresence", () => {
  test("only when /health lists the feature", () => {
    expect(supportsPresence({ ok: true, version: "1", features: ["favorites", "presence"] })).toBe(true)
    expect(supportsPresence({ ok: true, version: "1", features: ["favorites"] })).toBe(false)
    expect(supportsPresence({ ok: true, version: "1" })).toBe(false)
    expect(supportsPresence(undefined)).toBe(false)
  })
})

describe("colors", () => {
  test("slot = round(hash % 360 / 45) % 8, the comment-avatar hash", () => {
    // "a": hash 97 -> 97 / 45 = 2.16 -> slot 2.
    expect(colorSlot("a")).toBe(2)
    // "qa": 97 + (113 * 32 - 113) = 3600 -> 0 degrees -> slot 0.
    expect(colorSlot("qa")).toBe(0)
    // U+015E: hash 350 -> 7.78 rounds to 8, which wraps to slot 0.
    expect(colorSlot("Ş")).toBe(0)
  })

  test("every user maps to one of 8 slots, the same one every time", () => {
    for (const id of ["u1", "u2", "0f9b4c1e-1234-4abc-8def-001122334455", "", "x".repeat(500)]) {
      const slot = colorSlot(id)
      expect(Number.isInteger(slot) && slot >= 0 && slot < 8).toBe(true)
      expect(colorSlot(id)).toBe(slot)
    }
  })

  test("the color is oklch(0.65 0.15 slot*45)", () => {
    expect(slotColor(3)).toBe("oklch(0.65 0.15 135)")
    expect(slotColor(3, 0.25)).toBe("oklch(0.65 0.15 135 / 0.25)")
    expect(userColor("a")).toBe("oklch(0.65 0.15 90)")
  })
})

describe("grouping", () => {
  test("leaves out every tab of the signed-in user", () => {
    const out = groupSessions([session({ userId: "me", sessionId: "a" }), session({ userId: "me", sessionId: "b" }), session({ userId: "u2" })], "me")
    expect(out.map((s) => s.userId)).toEqual(["u2"])
  })

  test("one entry per user and path: the newest updatedAt wins", () => {
    const old = session({ sessionId: "old", updatedAt: "2026-10-18T10:00:00.000Z" })
    const recent = session({ sessionId: "new", updatedAt: "2026-10-18T10:00:05.000Z" })
    const other = session({ sessionId: "other", path: "b.md" })
    const out = groupSessions([recent, old, other], "me")
    expect(out.map((s) => s.sessionId).sort()).toEqual(["new", "other"])
    expect(groupSessions([old, recent], "me").map((s) => s.sessionId)).toEqual(["new"])
  })

  test("docSessions: people on this path only, slashes ignored, sorted by name", () => {
    const sessions = [
      session({ userId: "u3", sessionId: "c", displayName: "Zoe", path: "/docs/a.md" }),
      session({ userId: "u2", sessionId: "b", displayName: "Ann", path: "docs/a.md/" }),
      session({ userId: "u4", sessionId: "d", displayName: "Bob", path: "docs/b.md" }),
      session({ userId: "u5", sessionId: "e", displayName: "Cy", path: null }),
    ]
    expect(docSessions(sessions, "me", "docs/a.md").map((s) => s.displayName)).toEqual(["Ann", "Zoe"])
    expect(docSessions(sessions, "me", "")).toEqual([])
  })

  test("presenceName: display name, else the (shortened) email", () => {
    expect(presenceName({ userId: "u", email: "taras@example.test", displayName: "Taras" })).toBe("Taras")
    expect(presenceName({ userId: "u", email: "bo@example.test", displayName: null })).toBe("bo@example.test")
  })
})

describe("createThrottle", () => {
  function fakeTimers() {
    let now = 0
    let nextId = 1
    const pending = new Map<number, { at: number; fn: () => void }>()
    const timers: Timers = {
      now: () => now,
      setTimeout: (fn, ms) => {
        const id = nextId++
        pending.set(id, { at: now + ms, fn })
        return id
      },
      clearTimeout: (id) => { pending.delete(id as number) },
    }
    const advance = (ms: number) => {
      const end = now + ms
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
        if (!due) break
        pending.delete(due[0])
        now = due[1].at
        due[1].fn()
      }
      now = end
    }
    return { timers, advance }
  }

  test("sends at once, then one trailing send per window", () => {
    const { timers, advance } = fakeTimers()
    const sent: number[] = []
    const t = createThrottle(() => sent.push(timers.now()), timers)
    t.request(100)
    advance(0)
    expect(sent).toEqual([0])
    advance(10)
    t.request(100)
    advance(20)
    t.request(100)
    t.request(100)
    advance(200)
    expect(sent).toEqual([0, 100])
  })

  test("a slower request waits its own window; a faster one pulls it forward", () => {
    const { timers, advance } = fakeTimers()
    const sent: number[] = []
    const t = createThrottle(() => sent.push(timers.now()), timers)
    t.request(300)
    advance(0)
    advance(50)
    t.request(300)
    advance(10)
    t.request(100)
    advance(500)
    expect(sent).toEqual([0, 100])
  })

  test("cancel drops the pending send", () => {
    const { timers, advance } = fakeTimers()
    let count = 0
    const t = createThrottle(() => count++, timers)
    t.request(100)
    advance(0)
    t.request(100)
    t.cancel()
    advance(1000)
    expect(count).toBe(1)
  })
})

describe("selection and caret quotes", () => {
  const text = "# Title\n\nThe quick brown fox jumps over the lazy dog.\nThe end of the story is near.\n"
  const space = sourceTextSpace(text)

  test("a selection round-trips to the same offsets", () => {
    const start = text.indexOf("brown")
    const end = start + "brown fox".length
    const sel = selectionAt(space, start, end, 3)!
    expect(sel).toMatchObject({ collapsed: false, lineStart: 3, lineEnd: 3, fileVersion: 3 })
    expect(sel.quote.exact).toBe("brown fox")
    expect(resolveSelection(space, undefined, sel, 3)).toEqual({ start, end, caret: end })
  })

  test("a backwards selection is normalized", () => {
    const start = text.indexOf("lazy")
    expect(selectionAt(space, start + 4, start)!.quote.exact).toBe("lazy")
  })

  test("a duplicated phrase resolves to the selected occurrence", () => {
    const second = text.lastIndexOf("The ")
    const sel = selectionAt(space, second, second + 3)!
    expect(sel.quote.exact).toBe("The")
    expect(resolveSelection(space, undefined, sel, undefined)?.start).toBe(second)
  })

  test("a caret is placed exactly, also right after whitespace", () => {
    for (const caret of [text.indexOf("fox"), text.indexOf("fox") + 1, text.indexOf(" over") + 1, text.indexOf("near") + 4]) {
      const sel = selectionAt(space, caret, caret)!
      expect(sel.collapsed).toBe(true)
      expect(resolveSelection(space, undefined, sel, undefined)).toEqual({ start: caret, end: caret, caret })
    }
  })

  test("a caret with no text before it is not published", () => {
    expect(selectionAt(space, 0, 0)).toBeNull()
    expect(caretQuote("   \n\n", 4)).toBeUndefined()
  })

  test("a blank-only selection counts as a caret at its end", () => {
    const at = text.indexOf("\n\n") + 2
    const sel = selectionAt(space, at - 1, at)!
    expect(sel.collapsed).toBe(true)
    expect(resolveSelection(space, undefined, sel, undefined)?.caret).toBe(at)
  })

  test("quotes stay inside the server limits", () => {
    const long = `${"word ".repeat(200)}\n${"tail ".repeat(100)}`
    const sp = sourceTextSpace(long)
    const sel = selectionAt(sp, 0, long.length)!
    expect(sel.quote.exact.length).toBe(PRESENCE_EXACT_MAX)
    expect(sel.quote.prefix?.length ?? 0).toBeLessThanOrEqual(64)
    expect(sel.quote.suffix!.length).toBeLessThanOrEqual(64)
    const caret = selectionAt(sp, 900, 900)!
    expect(caret.quote.exact.length).toBeLessThanOrEqual(PRESENCE_EXACT_MAX)
    const ptr = pointerAt(sp, 2)!
    expect(ptr.quote.prefix ?? "").toBe("")
    expect(ptr.quote.suffix!.length).toBeLessThanOrEqual(64)
  })

  test("a selection longer than the quote cap extends to its last line", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `Line ${i + 1}: ${"lorem ipsum ".repeat(4)}`)
    const long = lines.join("\n")
    const sp = sourceTextSpace(long)
    const start = long.indexOf("Line 2:")
    const end = long.indexOf("Line 9:") + 10
    const sel = selectionAt(sp, start, end)!
    expect(sel.lineStart).toBe(2)
    expect(sel.lineEnd).toBe(9)
    const r = resolveSelection(sp, undefined, sel, undefined)!
    expect(r.start).toBe(start)
    // To the end of line 9 (the exact end is not on the wire).
    expect(r.end).toBe(long.indexOf("\nLine 10:"))
  })

  test("a selection whose text is gone resolves to nothing", () => {
    const sel = selectionAt(space, text.indexOf("quick"), text.indexOf("quick") + 5, 1)!
    const edited = sourceTextSpace(text.replace("quick", "slow"))
    expect(resolveSelection(edited, undefined, sel, 2)).toBeNull()
  })

  test("a selection follows its text into a newer version", () => {
    const start = text.indexOf("lazy dog")
    const sel = selectionAt(space, start, start + 8, 1)!
    const edited = `Intro line\n${text}`
    expect(resolveSelection(sourceTextSpace(edited), undefined, sel, 2)?.start).toBe(edited.indexOf("lazy dog"))
  })
})

describe("pointer positions", () => {
  const text = "alpha beta gamma\nthe cat sat on the mat\n"
  const space = sourceTextSpace(text)

  test("the word under the pointer plus the offset inside it", () => {
    const at = text.indexOf("gamma") + 2
    const pos = pointerAt(space, at, 4)!
    expect(pos).toMatchObject({ charOffset: 2, lineStart: 1, fileVersion: 4 })
    expect(pos.quote.exact).toBe("gamma")
    expect(resolvePointer(space, undefined, pos, 4)).toBe(at)
  })

  test("a repeated word resolves by its context", () => {
    const at = text.lastIndexOf("the") + 1
    const pos = pointerAt(space, at)!
    expect(pos.quote.exact).toBe("the")
    expect(resolvePointer(space, undefined, pos, undefined)).toBe(at)
  })

  test("the edge of a word counts; the middle of a gap does not", () => {
    expect(pointerAt(space, text.indexOf(" beta"))?.quote.exact).toBe("alpha")
    expect(pointerAt(sourceTextSpace("a   b"), 2)).toBeNull()
  })

  test("a pointer whose word is gone resolves to nothing", () => {
    const pos = pointerAt(space, text.indexOf("gamma"))!
    expect(resolvePointer(sourceTextSpace("alpha beta delta\n"), undefined, pos, undefined)).toBeNull()
  })
})

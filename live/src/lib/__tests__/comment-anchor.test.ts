import { describe, expect, test } from "bun:test"
import {
  captureQuote,
  commentQuote,
  remapLineRange,
  resolveAnchor,
  sourceTextSpace,
  type AnchorDiffChange,
  type TextSpace,
} from "../comment-anchor"

/** A minimal line diff between two texts (LCS), shaped like the `diff` op's output. */
function lineDiff(a: string, b: string): AnchorDiffChange[] {
  const x = a.split("\n")
  const y = b.split("\n")
  const dp = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0))
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--)
      dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out: AnchorDiffChange[] = []
  let i = 0
  let j = 0
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) { out.push({ type: "context", oldLine: ++i, newLine: ++j }) }
    else if (j < y.length && (i >= x.length || dp[i][j + 1] >= dp[i + 1][j])) { out.push({ type: "add", newLine: ++j }) }
    else { out.push({ type: "remove", oldLine: ++i }) }
  }
  return out
}

function quoteAt(text: string, exact: string, occurrence = 0) {
  let at = -1
  for (let k = 0; k <= occurrence; k++) at = text.indexOf(exact, at + 1)
  if (at < 0) throw new Error(`"${exact}" not in text`)
  return { quote: captureQuote(text, at, at + exact.length)!, at }
}

const lineOf = (text: string, offset: number) => text.slice(0, offset).split("\n").length

describe("drift case 1: file edited above the anchor", () => {
  const v1 = ["# Title", "", "Intro line.", "", "The anchored sentence lives here.", "", "Outro."].join("\n")
  const v2 = ["# Title", "", "A new paragraph.", "", "Another one.", "", "Intro line.", "", "The anchored sentence lives here.", "", "Outro."].join("\n")

  test("quote anchor follows the text to its new position", () => {
    const { quote } = quoteAt(v1, "anchored sentence")
    const r = resolveAnchor(sourceTextSpace(v2), { quote, lineStart: 5, lineEnd: 5, stale: true })
    expect(r.status).toBe("anchored")
    expect(v2.slice(r.start, r.end)).toBe("anchored sentence")
    expect(r.lineStart).toBe(9)
  })

  test("line-only (gutter) comment is remapped through the diff", () => {
    const r = resolveAnchor(sourceTextSpace(v2), { lineStart: 5, lineEnd: 5, stale: true, changes: lineDiff(v1, v2) })
    expect(r).toMatchObject({ status: "anchored", method: "lines", lineStart: 9, lineEnd: 9 })
    expect(v2.slice(r.start, r.end)).toBe("The anchored sentence lives here.")
  })

  test("quote edited away: falls back to the remapped lines and says it moved", () => {
    const v3 = v2.replace("The anchored sentence lives here.", "This sentence was rewritten entirely.")
    const { quote } = quoteAt(v1, "anchored sentence")
    const r = resolveAnchor(sourceTextSpace(v3), { quote, lineStart: 5, lineEnd: 5, stale: true, changes: lineDiff(v1, v3) })
    expect(r).toMatchObject({ status: "moved", method: "lines", lineStart: 9 })
  })

  test("without a diff, a stale line-only comment is flagged, not silently trusted", () => {
    const r = resolveAnchor(sourceTextSpace(v2), { lineStart: 5, lineEnd: 5, stale: true })
    expect(r.status).toBe("moved")
  })

  test("anchor text deleted everywhere: lost", () => {
    const v3 = v2.replace("The anchored sentence lives here.\n", "")
    const { quote } = quoteAt(v1, "anchored sentence")
    const r = resolveAnchor(sourceTextSpace(v3), { quote, lineStart: 5, lineEnd: 5, stale: true, changes: lineDiff(v1, v3) })
    expect(r.status).toBe("lost")
  })
})

describe("drift case 2: duplicate text", () => {
  const doc = ["## Setup", "Install deps.", "", "## Usage", "Run it.", "", "## Setup", "Configure the server.", "", "## Setup", "Deploy to prod."].join("\n")

  test("prefix/suffix pick the third occurrence, not the first", () => {
    const { quote, at } = quoteAt(doc, "Setup", 2)
    const r = resolveAnchor(sourceTextSpace(doc), { quote })
    expect(r).toMatchObject({ status: "anchored", method: "quote", start: at })
    expect(r.lineStart).toBe(10)
  })

  test("legacy quote with no context uses the stored line", () => {
    const r = resolveAnchor(sourceTextSpace(doc), { quote: { exact: "Setup" }, lineStart: 7, lineEnd: 7 })
    expect(r).toMatchObject({ status: "anchored", lineStart: 7 })
  })

  test("legacy quote with neither is flagged ambiguous and falls back to the first", () => {
    const r = resolveAnchor(sourceTextSpace(doc), { quote: { exact: "Setup" } })
    expect(r).toMatchObject({ status: "anchored", ambiguous: true, lineStart: 1 })
  })
})

describe("drift case 3: quote spanning blocks", () => {
  // Rendered text as the DOM space builds it: blocks separated by "\n".
  const rendered = "First paragraph ends here.\nSecond paragraph starts here."
  const source = "First paragraph ends here.\n\nSecond paragraph starts here."

  test("matches across the block boundary in the rendered text", () => {
    const { quote } = quoteAt(rendered, "ends here.\nSecond paragraph")
    const r = resolveAnchor({ text: rendered }, { quote })
    expect(rendered.slice(r.start, r.end)).toBe("ends here.\nSecond paragraph")
  })

  test("the same quote resolves in the source despite the blank line", () => {
    const { quote } = quoteAt(rendered, "ends here.\nSecond paragraph")
    const r = resolveAnchor(sourceTextSpace(source), { quote })
    expect(r).toMatchObject({ status: "anchored", lineStart: 1, lineEnd: 3 })
    expect(source.slice(r.start, r.end)).toBe("ends here.\n\nSecond paragraph")
  })

  test("a legacy comment whose 40-char head spans blocks still resolves", () => {
    // Legacy markdown comments stored textContent (no separator) and matched
    // the first 40 chars against single blocks, so this never highlighted.
    const r = resolveAnchor({ text: rendered }, { quote: { exact: "ends here.Second paragraph starts here." } })
    expect(r.status).toBe("anchored")
  })
})

describe("drift case 4: rendered vs source mode", () => {
  const source = "## Install\n\nRun **bun install** then `bun dev` to [start](https://x.dev) it."
  const rendered = "Install\nRun bun install then bun dev to start it."

  test("quote taken in the rendered preview resolves in source mode", () => {
    const { quote } = quoteAt(rendered, "bun install then bun dev")
    const r = resolveAnchor(sourceTextSpace(source), { quote })
    expect(r).toMatchObject({ status: "anchored", lineStart: 3 })
    expect(source.slice(r.start, r.end)).toBe("bun install** then `bun dev")
  })

  test("quote taken in source mode resolves in the rendered preview", () => {
    const { quote } = quoteAt(source, "**bun install** then `bun dev`")
    const r = resolveAnchor({ text: rendered }, { quote })
    expect(r.status).toBe("anchored")
    expect(rendered.slice(r.start, r.end)).toBe("bun install then bun dev")
  })

  test("link syntax the preview hides falls back to the line range", () => {
    // Same version, quote includes the link URL (not in the preview), lines known.
    const { quote } = quoteAt(source, "[start](https://x.dev) it.")
    const space: TextSpace = { text: rendered, lineRangeToOffsets: (a) => (a === 3 ? [8, rendered.length] : null) }
    const r = resolveAnchor(space, { quote, lineStart: 3, lineEnd: 3 })
    expect(r).toMatchObject({ status: "anchored", method: "lines", start: 8 })
  })
})

describe("drift case 5: sub-block selection", () => {
  const doc = "The quick brown fox jumps over the lazy dog, then naps in the sun."

  test("highlights only the selected words, not the whole block", () => {
    const { quote, at } = quoteAt(doc, "brown fox")
    const r = resolveAnchor(sourceTextSpace(doc), { quote })
    expect(r).toMatchObject({ status: "anchored", start: at, end: at + "brown fox".length })
  })

  test("a partly edited long quote is recovered from its surviving head and flagged moved", () => {
    const long = "The quick brown fox jumps over the lazy dog and keeps running through the whole meadow until sunset."
    const { quote } = quoteAt(long, long)
    const edited = long.replace("keeps running", "stops to rest")
    const r = resolveAnchor(sourceTextSpace(edited), { quote })
    expect(r.status).toBe("moved")
    expect(r.method).toBe("quote-partial")
    expect(r.start).toBe(0)
  })
})

describe("remapLineRange", () => {
  test("shifts ranges below an insertion and flags edits inside the range", () => {
    const a = "1\n2\n3\n4\n5"
    const b = "0\n1\n2\n3x\n4\n5"
    const changes = lineDiff(a, b)
    expect(remapLineRange(changes, 5, 5)).toMatchObject({ lineStart: 6, lineEnd: 6, touched: false })
    expect(remapLineRange(changes, 2, 4)).toMatchObject({ lineStart: 3, lineEnd: 5, touched: true, deleted: false })
    // Line 3 was rewritten in place: point at the replacement.
    expect(remapLineRange(changes, 3, 3)).toMatchObject({ lineStart: 4, lineEnd: 4, touched: true, deleted: false })
    // Line 3 removed outright.
    expect(remapLineRange(lineDiff(a, "1\n2\n4\n5"), 3, 3)).toMatchObject({ touched: true, deleted: true })
  })

  test("maps lines in the unchanged gaps between hunks (diff op output shape)", () => {
    // 20-line file: two lines inserted after line 2, line 15 removed; only
    // hunks with 4 lines of context are returned, like the `diff` op.
    const ctx = (o: number, n: number): AnchorDiffChange => ({ type: "context", oldLine: o, newLine: n })
    const changes: AnchorDiffChange[] = [
      ctx(1, 1), ctx(2, 2), { type: "add", newLine: 3 }, { type: "add", newLine: 4 }, ctx(3, 5), ctx(4, 6), ctx(5, 7), ctx(6, 8),
      ctx(11, 13), ctx(12, 14), ctx(13, 15), ctx(14, 16), { type: "remove", oldLine: 15 }, ctx(16, 17), ctx(17, 18), ctx(18, 19), ctx(19, 20),
    ]
    expect(remapLineRange(changes, 9, 9).lineStart).toBe(11)
    expect(remapLineRange(changes, 20, 20).lineStart).toBe(21)
    expect(remapLineRange(changes, 15, 15)).toMatchObject({ lineStart: 17, deleted: true })
    expect(remapLineRange(changes, 14, 16)).toMatchObject({ lineStart: 16, lineEnd: 17, touched: true, deleted: false })
  })

  test("an empty diff is the identity", () => {
    expect(remapLineRange([], 4, 6)).toMatchObject({ lineStart: 4, lineEnd: 6, touched: false })
  })

  test("content-only changes from an older server are not used for remapping", () => {
    const r = resolveAnchor(sourceTextSpace("a\nb\nc"), {
      lineStart: 2, stale: true, changes: [{ type: "remove" }, { type: "add" }],
    })
    expect(r.status).toBe("moved") // unverified stored lines, flagged
  })
})

describe("commentQuote", () => {
  test("prefers the stored anchor and falls back to legacy quotedContent", () => {
    expect(commentQuote({ quote: { exact: "a", prefix: "p" }, quotedContent: "b" })).toEqual({ exact: "a", prefix: "p" })
    expect(commentQuote({ quotedContent: "b" })).toEqual({ exact: "b" })
    expect(commentQuote({ quotedContent: "  " })).toBeUndefined()
  })

  test("captureQuote trims the selection and records context", () => {
    const text = "alpha beta gamma"
    expect(captureQuote(text, 5, 11)).toEqual({ exact: "beta", prefix: "alpha ", suffix: " gamma" })
    expect(lineOf(text, 0)).toBe(1)
  })
})

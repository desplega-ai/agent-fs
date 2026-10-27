import { describe, expect, test } from "bun:test"
import { htmlSourceTextSpace } from "../html-text-space"
import { captureQuote, resolveAnchor, resolveAnchorInView } from "../comment-anchor"

const page = [
  "<!doctype html>",                                   // 1
  "<html><head><title>Skip me</title>",                // 2
  "<style>p { color: red }</style>",                   // 3
  "</head><body>",                                     // 4
  "<h1>Report &amp; notes</h1>",                       // 5
  "<!-- a comment <p>hidden</p> -->",                  // 6
  "<p class=\"a>b\">Revenue grew &#8212; fast&#x21;</p>", // 7
  "<script>const x = '<p>not text</p>'</script>",      // 8
  "<template><p>later</p></template>",                 // 9
  "<p>Last <b>line</b>&nbsp;here &unknown; ok</p>",    // 10
  "</body></html>",                                    // 11
].join("\n")

describe("htmlSourceTextSpace", () => {
  const space = htmlSourceTextSpace(page)

  test("strips tags, decodes entities and skips non-text elements", () => {
    expect(space.text).toContain("Report & notes")
    expect(space.text).toContain("Revenue grew — fast!")
    expect(space.text).toContain("Last line here &unknown; ok")
    for (const hidden of ["Skip me", "color", "hidden", "not text", "later", "<", "doctype"]) {
      expect(space.text).not.toContain(hidden)
    }
  })

  test("separates blocks with a newline", () => {
    expect(space.text).toMatch(/Report & notes\n[\s\S]*Revenue/)
  })

  test("maps text offsets to source lines and back", () => {
    const at = space.text.indexOf("Revenue")
    expect(space.offsetToLine!(at)).toBe(7)
    expect(space.offsetToLine!(space.text.indexOf("here"))).toBe(10)
    const [s, e] = space.lineRangeToOffsets!(10, 10)!
    expect(space.text.slice(s, e).trim()).toBe("Last line here &unknown; ok")
    // A comment-only line holds no page text, only the line break after it.
    const [cs, ce] = space.lineRangeToOffsets!(6, 6) ?? [0, 0]
    expect(space.text.slice(cs, ce).trim()).toBe("")
    expect(space.lineRangeToOffsets!(99, 99)).toBeNull()
  })

  test("a quote from the rendered page finds its source lines", () => {
    const r = resolveAnchor(space, { quote: { exact: "grew — fast" } })
    expect(r).toMatchObject({ status: "anchored", lineStart: 7, lineEnd: 7 })
  })

  test("a comment whose quote changed is found again from its lines", () => {
    const frame = { text: "Report & notes\nRevenue grew a lot\nLast line here" }
    const edited = htmlSourceTextSpace("<h1>Report &amp; notes</h1>\n<p>Revenue grew a lot</p>\n<p>Last line here</p>")
    const quote = captureQuote("Revenue grew fast", 0, 17)!
    const r = resolveAnchorInView(frame, edited, { quote, lineStart: 2, lineEnd: 2 })
    expect(r.start).toBe(frame.text.indexOf("Revenue"))
    expect(frame.text.slice(r.start, r.end)).toBe("Revenue grew a lot")
  })
})

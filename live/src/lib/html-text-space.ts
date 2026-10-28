import type { TextSpace } from "./comment-anchor"

/**
 * Text spaces for comments on a rendered HTML page. The page's own text comes
 * from the frame's overlay, which has no source lines. The source space reads
 * the raw HTML the way a browser shows it (tags stripped, entities decoded,
 * scripts, styles, templates and comments skipped, a newline between blocks,
 * like the overlay) and maps that text back to source lines, so a comment made
 * on the page also gets lines, and a comment whose quote is gone can still be
 * found from its lines.
 */

const BLOCK = new Set([
  "p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "blockquote", "pre", "tr", "td", "th", "div", "dt", "dd",
  "ul", "ol", "table", "hr", "br", "section", "article", "header", "footer", "main", "nav", "aside",
  "figure", "figcaption", "details", "summary",
])
// Elements whose content is not page text (the overlay skips them too).
const SKIP = new Set(["script", "style", "template", "title", "noscript", "svg", "iframe", "object", "textarea", "select"])
// A character reference as the HTML tokenizer reads one: named (the semicolon
// is optional for legacy names), decimal or hex.
const ENTITY = /&(?:#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[a-zA-Z][a-zA-Z0-9]*;?)/y
// Without a DOM (unit tests): numeric references, the XML names and nbsp only.
const XML_NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: "\u00a0" }
const decoded = new Map<string, string>()
let decoder: HTMLTextAreaElement | null = null

/**
 * Decode one character reference exactly as the browser does: a textarea's
 * content is parsed as text with references decoded and no markup, so every
 * named reference, legacy forms and the numeric fix-ups match the page. The
 * result can carry trailing text the reference did not consume ("&notit;").
 */
function decodeReference(raw: string): string {
  let out = decoded.get(raw)
  if (out != null) return out
  if (typeof document !== "undefined") {
    decoder ??= document.createElement("textarea")
    decoder.innerHTML = raw
    out = decoder.value
  } else {
    const body = raw.slice(1).replace(/;$/, "")
    const code = body[0] !== "#" ? NaN : body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : Number(body.slice(1))
    out = body[0] === "#"
      ? (code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : "\ufffd")
      : raw.endsWith(";") && XML_NAMED[body] ? XML_NAMED[body] : raw
  }
  decoded.set(raw, out)
  return out
}
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)/y

/** The text a frame's overlay reports. Its offsets have no source lines. */
export function frameTextSpace(text: string): TextSpace {
  return { text }
}

/** First index in sorted `arr` whose value is >= `v`. */
function lowerBound(arr: number[], v: number): number {
  let lo = 0
  let hi = arr.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] < v) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function htmlSourceTextSpace(html: string): TextSpace {
  const lower = html.toLowerCase()
  let text = ""
  // Source offset of each char of `text`, non-decreasing.
  const pos: number[] = []
  const add = (s: string, at: number) => {
    text += s
    for (let k = 0; k < s.length; k++) pos.push(at)
  }
  const newline = (at: number) => {
    if (text && !text.endsWith("\n")) add("\n", at)
  }

  let i = 0
  while (i < html.length) {
    const ch = html[i]
    if (ch === "&") {
      ENTITY.lastIndex = i
      const m = ENTITY.exec(html)
      const value = m ? decodeReference(m[0]) : ch
      if (m && value !== m[0]) { add(value, i); i += m[0].length; continue }
      add(ch, i++)
      continue
    }
    if (ch !== "<") { add(ch, i++); continue }
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4)
      i = end === -1 ? html.length : end + 3
      continue
    }
    TAG.lastIndex = i
    const tag = TAG.exec(html)
    if (!tag && html[i + 1] !== "!" && html[i + 1] !== "?") { add(ch, i++); continue }
    // Find the tag's end, skipping quoted attribute values.
    let j = i + 1
    let quote = ""
    for (; j < html.length; j++) {
      const c = html[j]
      if (quote) { if (c === quote) quote = "" }
      else if (c === "\"" || c === "'") quote = c
      else if (c === ">") break
    }
    const name = tag?.[2].toLowerCase() ?? ""
    if (BLOCK.has(name)) newline(i)
    i = j + 1
    if (tag && !tag[1] && SKIP.has(name) && html[j - 1] !== "/") {
      const close = lower.indexOf(`</${name}`, i)
      i = close === -1 ? html.length : close
    }
  }

  const lineStarts = [0]
  for (let k = 0; k < html.length; k++) if (html[k] === "\n") lineStarts.push(k + 1)
  const lineOf = (offset: number) => lowerBound(lineStarts, offset + 1)

  return {
    text,
    lineRangeToOffsets(a, b) {
      if (a < 1 || a > lineStarts.length) return null
      const end = Math.min(Math.max(a, b), lineStarts.length)
      const start = lowerBound(pos, lineStarts[a - 1])
      const stop = lowerBound(pos, end < lineStarts.length ? lineStarts[end] : html.length + 1)
      return start < stop ? [start, stop] : null
    },
    offsetToLine(offset) {
      if (!pos.length) return null
      return lineOf(pos[Math.min(Math.max(0, offset), pos.length - 1)])
    },
  }
}

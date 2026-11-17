// Run from live/: bun test src/components/viewers/__tests__/
import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { extractFrontmatter, FrontmatterBlock } from "../Frontmatter"

const doc = (yaml: string) => `---\n${yaml}\n---\n# Body\n`

function render(yaml: string) {
  const { frontmatter, body } = extractFrontmatter(doc(yaml))
  const markup = frontmatter === null ? "" : renderToStaticMarkup(<FrontmatterBlock data={frontmatter} />)
  return { frontmatter, body, markup, text: markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() }
}

describe("frontmatter properties card", () => {
  test("scalars and flat arrays parse and render as before", () => {
    const { frontmatter, body, markup, text } = render(
      'title: "Q4 plan"\ndraft: false\ncount: 3\nowner: ~\ntags: [a, b]\nlist:\n  - x\n  - y',
    )
    expect(frontmatter).toEqual(new Map<string, unknown>([["title", "Q4 plan"], ["draft", false], ["count", 3], ["owner", null], ["tags", ["a", "b"]], ["list", ["x", "y"]]]))
    expect(body).toBe("# Body\n")
    expect(text).toBe("title Q4 plan draft false count 3 owner null tags a b list x y")
    expect(markup.match(/rounded-md bg-accent/g)).toHaveLength(4)
  })

  test("a nested map renders its keys and values in file order, not 'empty'", () => {
    const { markup, text } = render(
      'platforms:\n  ios:\n    condition: checkout_ios\n    arms: {control: 50, "2": 50}\n  android:\n    condition: checkout_android',
    )
    expect(text).toBe("platforms ios condition checkout_ios arms control 50 · 2 50 android condition checkout_android")
    // The card, platforms and ios get a key/value grid; flat maps stay inline.
    expect(markup.match(/<dl/g)).toHaveLength(3)
  })

  test("a map of plain values sits inline on its key's line", () => {
    const { markup, text } = render('arms: {control: 50, "2": 50}')
    expect(text).toBe("arms control 50 · 2 50")
    expect(markup.match(/<dl/g)).toHaveLength(1)
    expect(markup.match(/<dd/g)).toHaveLength(1)
  })

  test("a list of flow mappings renders one bulleted line per item, not raw YAML", () => {
    const { markup, text } = render(
      'split_changes:\n  - {from: "2026-03-02T10:00Z", arms: {control: 90, "2": 10}}\n  - {from: "2026-04-06T09:00Z", arms: {control: 99, fast: 1}}',
    )
    const items = Array.from(markup.matchAll(/<li>(.*?)<\/li>/g), m => m[1])
    expect(items.map(item => item.replace(/<[^>]+>/g, ""))).toEqual([
      "from 2026-03-02T10:00Z · arms control 90 · 2 10",
      "from 2026-04-06T09:00Z · arms control 99 · fast 1",
    ])
    for (const item of items) expect(item).not.toContain("<dl")
    expect(markup).toContain("list-disc")
    expect(markup).not.toContain("bg-accent")
    expect(text).not.toContain("{")
  })

  test("a list item holding a nested block gets its bullet and the map below", () => {
    const { markup, text } = render("steps:\n  - name: build\n    runs: [{os: linux}, {os: mac}]")
    const items = Array.from(markup.matchAll(/<li>(.*?)<\/li>/g), m => m[1])
    expect(items[0]).toContain("<dl")
    expect(text).toBe("steps name build runs os linux os mac")
  })

  test("invalid YAML shows the raw block instead of throwing", () => {
    const { frontmatter, body, markup } = render("title: [unclosed\nkey: : bad")
    expect(frontmatter).toBe("title: [unclosed\nkey: : bad")
    expect(body).toBe("# Body\n")
    expect(markup).toContain("<pre")
    expect(markup).toContain("title: [unclosed")
  })

  test("empty frontmatter shows no card and no frontmatter keeps the whole body", () => {
    expect(extractFrontmatter(doc("# only a comment")).frontmatter).toBeNull()
    expect(extractFrontmatter("# No frontmatter\n")).toEqual({ frontmatter: null, body: "# No frontmatter\n" })
  })
})
